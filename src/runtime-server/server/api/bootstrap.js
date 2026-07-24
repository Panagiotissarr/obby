/**
 * Bootstrap endpoint — backed by Upstash Redis.
 *
 * Returns everything the client needs for a cold start in a single HTTP
 * response, so the shims can serve subsequent reads from an in-memory
 * cache instead of making individual round-trips.
 *
 * Redis data model (same as api/fs.js):
 *   vault:{vaultId}:tree       → Hash  — relPath → JSON stats
 *   vault:{vaultId}:data:{path} → String — file content
 *
 * GET /api/bootstrap?vault=<id>
 *   Returns electron IPC values + full .obsidian/ tree + dirs cache.
 *
 * GET /api/bootstrap?vault=<id>&full=1
 *   Returns the above PLUS content+stat for all text vault files.
 */

const express = require('express');
const path = require('path');
const zlib = require('zlib');
const config = require('../config');
const { getRedis, treeKey, dataKey } = require('../redis');

// ── Server-side bootstrap cache ───────────────────────────────────────────
const serverCache = new Map();
const pendingBuilds = new Map();
const buildProgress = new Map();

function setProgress(vaultId, update) {
  const current = buildProgress.get(vaultId) || {};
  buildProgress.set(vaultId, { ...current, ...update });
}

function preCompress(buf) {
  return Promise.all([
    new Promise((resolve, reject) =>
      zlib.brotliCompress(
        buf,
        { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
        (err, result) => (err ? reject(err) : resolve(result)),
      ),
    ),
    new Promise((resolve, reject) =>
      zlib.gzip(buf, { level: 6 }, (err, result) => (err ? reject(err) : resolve(result))),
    ),
  ]).then(([br, gz]) => ({ br, gz }));
}

const APP_VERSION = config.appVersion;
const VAULT_BASE = config.vaultBase;

const TEXT_EXTENSIONS = new Set([
  '.md', '.json', '.txt', '.csv',
  '.css', '.js', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf',
  '.sh', '.bash', '.zsh', '.fish',
  '.lua', '.py', '.rb', '.rs', '.go',
  '.tex', '.bib', '.sty',
  '.svg',
]);

let currentLimits = {
  maxContentBytes: (config.bootstrap && config.bootstrap.maxFileKB || 500) * 1024,
  maxTotalBytes:   (config.bootstrap && config.bootstrap.maxTotalMB || 50) * 1024 * 1024,
};

function applyLimits(bootCfg) {
  currentLimits = {
    maxContentBytes: (bootCfg.maxFileKB || 500) * 1024,
    maxTotalBytes:   (bootCfg.maxTotalMB || 50) * 1024 * 1024,
  };
}

function isTextFile(relPath, size) {
  const ext = path.extname(relPath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) return false;
  if (size !== undefined && size > currentLimits.maxContentBytes) return false;
  return true;
}

function parseStats(json) {
  if (!json) return null;
  try { return typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return null; }
}

// ── Redis-based vault walk ───────────────────────────────────────────────

async function walkRedisTree(vaultId, full, progress, budget) {
  const redis = getRedis();
  const fsCache = {};
  const dirsCache = {};

  const allEntries = await redis.hgetall(treeKey(vaultId));
  if (!allEntries) return { fsCache, dirsCache };

  // Group entries by parent directory
  const dirChildren = new Map();
  dirChildren.set('', []);

  for (const [relPath, statsJson] of Object.entries(allEntries)) {
    // Skip hidden files unless full walk
    if (!full) {
      const segments = relPath.split('/');
      if (segments.some(s => s.startsWith('.'))) continue;
    }

    const s = parseStats(statsJson);
    if (!s) continue;

    const parent = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '';
    const name = relPath.includes('/') ? relPath.substring(relPath.lastIndexOf('/') + 1) : relPath;

    if (!dirChildren.has(parent)) dirChildren.set(parent, []);
    dirChildren.get(parent).push({ name, stats: s, relPath });
  }

  // Build dirsCache: each dir maps to its children with stat info
  for (const [dirPath, children] of dirChildren) {
    dirsCache[dirPath] = children.map(e => ({
      name: e.name,
      isFile: e.stats.isFile,
      isDirectory: e.stats.isDirectory,
      isSymbolicLink: e.stats.isSymbolicLink || false,
      mtime: e.stats.mtime,
      size: e.stats.size,
    }));
  }

  // Build fsCache: stat + content for text files, stat-only for dirs
  const READ_BATCH = 30;
  const textFiles = [];

  for (const [relPath, statsJson] of Object.entries(allEntries)) {
    if (!full) {
      const segments = relPath.split('/');
      if (segments.some(s => s.startsWith('.'))) continue;
    }

    const s = parseStats(statsJson);
    if (!s) continue;

    if (s.isDirectory) {
      fsCache[relPath] = { mtime: s.mtime, size: s.size, isFile: false, isDirectory: true };
    } else if (isTextFile(relPath, s.size)) {
      if (budget && budget.remaining < s.size) {
        budget.capped = true;
      } else {
        if (budget) budget.remaining -= s.size;
        fsCache[relPath] = { mtime: s.mtime, size: s.size, isFile: true };
        textFiles.push(relPath);
      }
    }
  }

  // Read text file contents in batches
  for (let i = 0; i < textFiles.length; i += READ_BATCH) {
    const batch = textFiles.slice(i, i + READ_BATCH);
    const keys = batch.map(p => dataKey(vaultId, p));
    const values = await redis.mget(...keys);
    for (let j = 0; j < batch.length; j++) {
      const content = values[j];
      if (content !== null && content !== undefined) {
        fsCache[batch[j]] = { ...fsCache[batch[j]], content };
      }
    }
    if (progress) {
      progress.filesRead = (progress.filesRead || 0) + batch.length;
      progress.cb();
    }
  }

  if (progress) {
    progress.dirs = dirChildren.size;
    const files = Object.keys(fsCache).filter(k => fsCache[k].isFile !== false).length;
    progress.files = files;
    progress.cb();
  }

  return { fsCache, dirsCache };
}

// ── core build ────────────────────────────────────────────────────────────

function buildElectronValues(vaultId, vaultRegistry) {
  const vault = vaultId ? vaultRegistry.get(vaultId) : null;
  return {
    'vault':          vault ? { id: vaultId, path: VAULT_BASE } : {},
    'vault-list':     vaultRegistry.list(),
    'is-dev':         false,
    'version':        APP_VERSION,
    'frame':          'hidden',
    'resources':      '',
    'file-url':       '',
    'disable-update': true,
    'update':         '',
    'check-update':   false,
    'insider-build':  false,
    'cli':            false,
    'disable-gpu':    false,
    'is-quitting':    false,
  };
}

async function buildCacheEntry(vaultId, vaultRoot, vaultRegistry, full = false) {
  const buildKey = (vaultId || '') + ':' + (full ? 'full' : 'partial');
  if (pendingBuilds.has(buildKey)) {
    return pendingBuilds.get(buildKey);
  }
  const promise = _buildCacheEntry(vaultId, vaultRoot, vaultRegistry, full)
    .finally(() => pendingBuilds.delete(buildKey));
  pendingBuilds.set(buildKey, promise);
  return promise;
}

async function _buildCacheEntry(vaultId, vaultRoot, vaultRegistry, full = false) {
  const t0 = Date.now();
  const electronValues = buildElectronValues(vaultId, vaultRegistry);

  // Cache validation: compare with existing entry
  const cached = serverCache.get(vaultId);
  if (cached && !full) {
    const hitMs = Date.now() - t0;
    console.log(`[bootstrap] vault=${(vaultId || '').slice(0, 8)}… cache HIT (${hitMs}ms)`);
    return cached;
  }

  const progress = {
    dirs: 0, filesRead: 0,
    cb() {
      setProgress(vaultId, {
        state: 'scanning',
        label: 'Scanning vault...',
        dirs: this.dirs,
        files: this.files || 0,
        filesRead: this.filesRead,
      });
    },
  };
  setProgress(vaultId, { state: 'scanning', label: 'Scanning vault...', dirs: 0, files: 0, filesRead: 0, pct: 0 });

  const budget = full ? {
    remaining: currentLimits.maxTotalBytes,
    capped: false,
  } : null;

  const { fsCache, dirsCache } = await walkRedisTree(vaultId, full, progress, budget);

  setProgress(vaultId, { state: 'reading', label: 'Reading files...', pct: 80 });
  const fileCount = Object.keys(fsCache).length;
  const dirCount = Object.keys(dirsCache).length;
  const withContent = Object.values(fsCache).filter(v => v.content !== undefined).length;
  const byteCount = Object.values(fsCache)
    .filter(v => v.content)
    .reduce((s, v) => s + (v.size || 0), 0);

  const response = { electron: electronValues, fs: fsCache, dirs: dirsCache };
  if (budget && budget.capped) {
    response.capped = true;
    response.cappedReason =
      `total size limit reached (${currentLimits.maxTotalBytes / (1024 * 1024)} MB)`;
  }

  setProgress(vaultId, { state: 'compressing', label: 'Compressing...', pct: 90 });
  const jsonBuf = Buffer.from(JSON.stringify(response));
  let compressed = {};
  try { compressed = await preCompress(jsonBuf); } catch (_) {}

  const entry = { response, dirMtimes: {}, compressed, isFull: full };
  if (vaultId) serverCache.set(vaultId, entry);
  setProgress(vaultId, { state: 'ready', label: 'Ready', pct: 100 });
  setTimeout(() => buildProgress.delete(vaultId), 5000);

  const ms = Date.now() - t0;
  console.log(
    `[bootstrap] vault=${(vaultId || '').slice(0, 8)}… full=${full} ` +
    `files=${fileCount}(content:${withContent}) dirs=${dirCount} ` +
    `size=${(byteCount / 1024).toFixed(0)}KB time=${ms}ms`,
  );

  return entry;
}

// ── router ────────────────────────────────────────────────────────────────

function createBootstrapRouter(vaultRegistry, fallbackVaultRoot, bootstrapConfig) {
  const bootCfg = bootstrapConfig || config.bootstrap;

  if (!bootCfg.enabled) {
    console.log('[bootstrap] DISABLED via BOOTSTRAP_DISABLED env or override');
    serverCache.clear();
    buildProgress.clear();
    pendingBuilds.clear();
  }

  applyLimits(bootCfg);

  const router = express.Router();

  router.get('/status', (req, res) => {
    const vaultId = req.query.vault || '';
    const progress = buildProgress.get(vaultId);
    if (!progress) return res.json({ state: 'idle', label: '' });
    res.json(progress);
  });

  router.get('/', async (req, res) => {
    const vaultId = req.query.vault || '';
    const full = req.query.full === '1';

    if (!bootCfg.enabled) {
      return res.json({
        disabled: true,
        electron: buildElectronValues(vaultId, vaultRegistry),
        fs: {},
        dirs: {},
      });
    }

    const vault = vaultId ? vaultRegistry.get(vaultId) : null;
    const vaultRoot = vault ? vault.path : fallbackVaultRoot;

    const existing = serverCache.get(vaultId);
    let entry;
    if (full && existing && !existing.isFull) {
      console.log(`[bootstrap] vault=${vaultId.slice(0, 8)}… serving partial while full build runs in background`);
      buildCacheEntry(vaultId, vaultRoot, vaultRegistry, true)
        .catch((err) => console.warn('[bootstrap] background full build error:', err.message));
      entry = existing;
    } else {
      entry = await buildCacheEntry(vaultId, vaultRoot, vaultRegistry, full);
    }

    const { compressed } = entry;
    const ae = req.headers['accept-encoding'] || '';
    let buf, encoding;
    if (ae.includes('br') && compressed.br) {
      buf = compressed.br;
      encoding = 'br';
    } else if ((ae.includes('gzip') || ae.includes('deflate')) && compressed.gz) {
      buf = compressed.gz;
      encoding = 'gzip';
    }

    if (buf) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', buf.length);
      return res.status(200).end(buf);
    }
    res.json(entry.response);
  });

  return router;
}

async function warmUpBootstrapCache(vaultRegistry, fallbackVaultRoot, bootstrapConfig) {
  const bootCfg = bootstrapConfig || config.bootstrap;
  if (!bootCfg.enabled) return;
  applyLimits(bootCfg);

  const vaults = vaultRegistry.list();
  const ids = Object.keys(vaults);
  if (ids.length === 0 && fallbackVaultRoot) {
    try {
      await buildCacheEntry('', fallbackVaultRoot, vaultRegistry, false);
    } catch (err) {
      console.warn('[bootstrap] warm-up failed for fallback vault:', err.message);
    }
    return;
  }
  for (const id of ids) {
    const { path: vaultPath } = vaults[id];
    try {
      await buildCacheEntry(id, vaultPath, vaultRegistry, false);
      buildCacheEntry(id, vaultPath, vaultRegistry, true)
        .catch((err) => console.warn(`[bootstrap] full warm-up failed for vault ${id}:`, err.message));
    } catch (err) {
      console.warn(`[bootstrap] warm-up failed for vault ${id}:`, err.message);
    }
  }
}

module.exports = createBootstrapRouter;
module.exports.serverCache = serverCache;
module.exports.pendingBuilds = pendingBuilds;
module.exports.warmUpBootstrapCache = warmUpBootstrapCache;
