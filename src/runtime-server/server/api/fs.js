/**
 * File system HTTP API — backed by Upstash Redis.
 *
 * Maps Redis-backed virtual filesystem operations to HTTP endpoints.
 * The client-side shim (shims/capacitor-shim.js) translates fs calls
 * into requests here.
 *
 * Redis data model:
 *   vault:{vaultId}:tree       → Hash  — relPath → JSON stats
 *   vault:{vaultId}:data:{path} → String — file content
 *
 * All paths are relative to the vault root for safety.
 */

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { getRedis, treeKey, dataKey } = require('../redis');

const {
  tryGetSystemFilePath,
  getSystemPluginIds,
  getSystemPluginDir,
  mergeCommunityList,
  stripCommunityList,
} = require('../system-plugins');

// Imported lazily to avoid circular require — bootstrap.js exports serverCache.
function invalidateBootstrapCache(vaultId) {
  try {
    const { serverCache } = require('./bootstrap');
    if (serverCache) serverCache.delete(vaultId);
  } catch (_) {}
}

// ── Redis helpers ──────────────────────────────────────────────────────────

function nowMs() { return Date.now(); }

function makeStats(relPath, isDir) {
  const mtime = nowMs();
  return {
    isFile: !isDir,
    isDirectory: isDir,
    isSymbolicLink: false,
    size: isDir ? 4096 : 0,
    mtime,
    ctime: mtime,
    atime: mtime,
    birthtime: mtime,
    mode: isDir ? 0o040755 : 0o100644,
  };
}

function parseStats(json) {
  if (!json) return null;
  try { return typeof json === 'string' ? JSON.parse(json) : json; } catch (_) { return null; }
}

function pathParent(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx > 0 ? relPath.substring(0, idx) : '';
}

function pathName(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx >= 0 ? relPath.substring(idx + 1) : relPath;
}

// Ensure every ancestor directory of relPath exists in the tree hash.
async function ensureParentDirs(redis, tid, relPath) {
  const parts = relPath.split('/');
  parts.pop();
  let dir = '';
  const pipeline = redis.pipeline();
  let dirty = false;
  for (const part of parts) {
    dir = dir ? dir + '/' + part : part;
    pipeline.hexists(treeKey(tid), dir);
    dirty = true;
  }
  if (!dirty) return;
  const results = await pipeline.exec();

  const pipe2 = redis.pipeline();
  let i = 0;
  dir = '';
  for (const part of parts) {
    dir = dir ? dir + '/' + part : part;
    const exists = results[i] && results[i][1];
    if (!exists) {
      pipe2.hset(treeKey(tid), dir, JSON.stringify(makeStats(dir, true)));
    }
    i++;
  }
  await pipe2.exec();
}

// ── Router ─────────────────────────────────────────────────────────────────

function createFsRouter(vaultRegistry, fallbackVaultRoot) {
  const router = express.Router();
  const redis = getRedis();

  function getVaultId(req) {
    return req.query.vault || 'default';
  }

  // Path safety: reject traversal
  function safePath(relPath) {
    if (typeof relPath !== 'string') {
      const err = new Error('path must be a string');
      err.code = 'ENOENT';
      throw err;
    }
    const cleaned = relPath.replace(/^\/+/, '');
    if (cleaned.includes('..')) {
      const err = new Error('path escapes vault root: ' + relPath);
      err.code = 'EACCES';
      throw err;
    }
    return cleaned;
  }

  function handleError(res, err) {
    const status = err.code === 'ENOENT' ? 404
      : err.code === 'EACCES' ? 403
      : err.code === 'EISDIR' ? 404
      : err.code === 'ENOTDIR' ? 404
      : err.code === 'ENOVAULT' ? 404
      : 500;
    res.status(status).json({
      error: err.message,
      code: err.code || null,
    });
  }

  // ── GET /stat ────────────────────────────────────────────────────────────

  router.get('/stat', async (req, res) => {
    const relPath = req.query.path || '';
    const isPluginsDir = relPath === '.obsidian/plugins' || relPath === '.obsidian/plugins/';
    const tid = getVaultId(req);

    try {
      // System plugin overlay: if this is a system plugin file AND the vault
      // doesn't have it, stat the repo copy instead.
      if (relPath) {
        const systemPath = tryGetSystemFilePath(relPath);
        if (systemPath) {
          const inRedis = await redis.hexists(treeKey(tid), relPath);
          if (!inRedis) {
            const stats = await fsp.stat(systemPath);
            return res.json({
              isFile: stats.isFile(),
              isDirectory: stats.isDirectory(),
              isSymbolicLink: false,
              size: stats.size,
              mtime: stats.mtime.getTime(),
              ctime: stats.ctime.getTime(),
              atime: stats.atime.getTime(),
              birthtime: stats.birthtime.getTime(),
              mode: stats.mode,
            });
          }
        }
      }

      // Empty path = vault root directory
      if (!relPath) {
        return res.json(makeStats('', true));
      }

      const raw = await redis.hget(treeKey(tid), relPath);
      if (raw) {
        const s = parseStats(raw);
        if (s) return res.json(s);
      }

      // Maybe it is a virtual directory (has children but no explicit entry)
      const allKeys = await redis.hkeys(treeKey(tid));
      const prefix = relPath + '/';
      const hasChildren = allKeys.some(k => k.startsWith(prefix));
      if (hasChildren) {
        return res.json(makeStats(relPath, true));
      }

      throw Object.assign(new Error('not found: ' + relPath), { code: 'ENOENT' });
    } catch (err) {
      // Synthesize a directory stat for .obsidian/plugins when vault doesn't have it
      if ((err.code === 'ENOENT' || err.code === 'ENOTDIR')
          && isPluginsDir
          && getSystemPluginIds().length > 0) {
        const n = Date.now();
        return res.json({
          isFile: false, isDirectory: true, isSymbolicLink: false, size: 4096,
          mtime: n, ctime: n, atime: n, birthtime: n, mode: 0o040755,
        });
      }
      handleError(res, err);
    }
  });

  // ── GET /readdir ─────────────────────────────────────────────────────────

  router.get('/readdir', async (req, res) => {
    const relPath = req.query.path || '';
    const isPluginsDir = relPath === '.obsidian/plugins' || relPath === '.obsidian/plugins/';
    const inSysDirMatch = relPath.match(/^\.obsidian\/plugins\/([^/]+)\/?$/);
    const inSysDir = inSysDirMatch && getSystemPluginIds().includes(inSysDirMatch[1]);
    const tid = getVaultId(req);

    try {
      // Inside a system plugin dir: if vault has no entries, list from repo
      if (inSysDir) {
        const allKeys = await redis.hkeys(treeKey(tid));
        const sysPrefix = relPath + '/';
        const vaultHasEntries = allKeys.some(k => k.startsWith(sysPrefix));
        if (!vaultHasEntries) {
          const repoDir = getSystemPluginDir(inSysDirMatch[1]);
          const entries = await fsp.readdir(repoDir, { withFileTypes: true });
          const result = await Promise.all(entries.map(async (entry) => {
            const child = path.join(repoDir, entry.name);
            let stats = null;
            try {
              const s = await fsp.stat(child);
              stats = {
                isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: false,
                size: s.size, mtime: s.mtime.getTime(), ctime: s.ctime.getTime(),
                atime: s.atime.getTime(), birthtime: s.birthtime.getTime(), mode: s.mode,
              };
            } catch (_) {}
            return {
              name: entry.name,
              isFile: entry.isFile(),
              isDirectory: entry.isDirectory(),
              isSymbolicLink: entry.isSymbolicLink(),
              stats,
            };
          }));
          return res.json(result);
        }
      }

      // Redis readdir: get all keys, filter to direct children of relPath
      const prefix = relPath ? relPath + '/' : '';
      const allKeys = await redis.hkeys(treeKey(tid));
      const childMap = new Map();

      for (const key of allKeys) {
        if (prefix && !key.startsWith(prefix)) continue;
        if (!prefix && key.indexOf('/') !== -1) continue; // root: skip nested

        const rest = prefix ? key.slice(prefix.length) : key;
        if (!rest) continue;

        const slashIdx = rest.indexOf('/');
        if (slashIdx !== -1) {
          // This is a child directory
          const dirName = rest.substring(0, slashIdx);
          if (!childMap.has(dirName)) {
            childMap.set(dirName, {
              name: dirName,
              isFile: false,
              isDirectory: true,
              isSymbolicLink: false,
              stats: null,
            });
          }
        } else {
          // Direct child — file
          if (!childMap.has(rest)) {
            const raw = await redis.hget(treeKey(tid), key);
            const s = parseStats(raw);
            childMap.set(rest, {
              name: rest,
              isFile: s ? s.isFile : true,
              isDirectory: s ? s.isDirectory : false,
              isSymbolicLink: false,
              stats: s ? {
                isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: false,
                size: s.size, mtime: s.mtime, ctime: s.ctime,
                atime: s.atime, birthtime: s.birthtime, mode: s.mode,
              } : null,
            });
          }
        }
      }

      // Fill in stats for virtual directories
      for (const [name, entry] of childMap) {
        if (entry.isDirectory && !entry.stats) {
          const dirPath = prefix + name;
          const raw = await redis.hget(treeKey(tid), dirPath);
          const s = parseStats(raw);
          if (s) {
            entry.stats = {
              isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: false,
              size: s.size, mtime: s.mtime, ctime: s.ctime,
              atime: s.atime, birthtime: s.birthtime, mode: s.mode,
            };
          }
        }
      }

      const result = Array.from(childMap.values());

      // If listing .obsidian/plugins, merge in system plugin directory entries
      if (isPluginsDir) {
        for (const id of getSystemPluginIds()) {
          if (!result.find(e => e.name === id)) {
            result.push({
              name: id,
              isFile: false,
              isDirectory: true,
              isSymbolicLink: false,
              stats: null,
            });
          }
        }
      }

      res.json(result);
    } catch (err) {
      // Synthesize listing for .obsidian/plugins when vault doesn't have it
      if ((err.code === 'ENOENT' || err.code === 'ENOTDIR')
          && isPluginsDir
          && getSystemPluginIds().length > 0) {
        return res.json(getSystemPluginIds().map(id => ({
          name: id,
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          stats: null,
        })));
      }
      handleError(res, err);
    }
  });

  // ── GET /read ────────────────────────────────────────────────────────────

  router.get('/read', async (req, res) => {
    const tid = getVaultId(req);
    try {
      const relPath = req.query.path || '';
      const encoding = req.query.encoding || null;

      // Special case: community-plugins.json — merge system ids
      if (relPath === '.obsidian/community-plugins.json') {
        let list = [];
        try {
          const raw = await redis.get(dataKey(tid, relPath));
          if (raw) {
            const txt = typeof raw === 'string' ? raw : raw.toString('utf8');
            const parsed = JSON.parse(txt);
            if (Array.isArray(parsed)) list = parsed;
          }
        } catch (_) {}
        const merged = mergeCommunityList(list);
        if (encoding) {
          return res.type('text/plain; charset=utf-8').send(JSON.stringify(merged));
        }
        return res.type('application/json').send(JSON.stringify(merged));
      }

      // System plugin overlay: if this is a system plugin file AND the vault
      // doesn't have it, serve from <repo>/plugins/.
      const systemPath = tryGetSystemFilePath(relPath);
      if (systemPath) {
        const inRedis = await redis.hexists(treeKey(tid), relPath);
        if (!inRedis) {
          if (encoding) {
            const data = await fsp.readFile(systemPath, encoding);
            return res.type('text/plain; charset=utf-8').send(data);
          }
          const data = await fsp.readFile(systemPath);
          return res.type('application/octet-stream').send(data);
        }
      }

      const content = await redis.get(dataKey(tid, relPath));
      if (content === null || content === undefined) {
        throw Object.assign(new Error('ENOENT: ' + relPath), { code: 'ENOENT' });
      }
      if (encoding) {
        res.type('text/plain; charset=utf-8').send(
          typeof content === 'string' ? content : content.toString(encoding),
        );
      } else {
        res.type('application/octet-stream').send(
          typeof content === 'string' ? Buffer.from(content) : content,
        );
      }
    } catch (err) {
      handleError(res, err);
    }
  });

  // ── PUT /write ───────────────────────────────────────────────────────────

  router.put('/write', express.raw({ type: '*/*', limit: '256mb' }), async (req, res) => {
    const tid = getVaultId(req);
    try {
      const relPath = req.query.path || '';
      const safe = safePath(relPath);
      const encoding = req.query.encoding || null;
      let data = encoding ? req.body.toString(encoding) : req.body;

      // For community-plugins.json: strip system plugin ids before writing
      if (safe === '.obsidian/community-plugins.json' && encoding) {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            const cleaned = stripCommunityList(parsed);
            data = JSON.stringify(cleaned, null, 2);
          }
        } catch (_) {}
      }

      const contentStr = encoding
        ? data
        : (Buffer.isBuffer(data) ? data.toString('base64') : String(data));
      const stats = makeStats(safe, false);
      stats.size = encoding
        ? Buffer.byteLength(data, 'utf8')
        : (Buffer.isBuffer(data) ? data.length : 0);

      const pipe = redis.pipeline();
      pipe.set(dataKey(tid, safe), contentStr);
      pipe.hset(treeKey(tid), safe, JSON.stringify(stats));
      await pipe.exec();

      await ensureParentDirs(redis, tid, safe);
      invalidateBootstrapCache(tid);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ── POST /mkdir ──────────────────────────────────────────────────────────

  router.post('/mkdir', express.json(), async (req, res) => {
    const tid = getVaultId(req);
    try {
      const safe = safePath(req.body.path || '');
      const stats = makeStats(safe, true);
      await redis.hset(treeKey(tid), safe, JSON.stringify(stats));
      await ensureParentDirs(redis, tid, safe);
      invalidateBootstrapCache(tid);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ── DELETE /unlink ───────────────────────────────────────────────────────

  router.delete('/unlink', async (req, res) => {
    const tid = getVaultId(req);
    try {
      const safe = safePath(req.query.path || '');
      const pipe = redis.pipeline();
      pipe.del(dataKey(tid, safe));
      pipe.hdel(treeKey(tid), safe);
      await pipe.exec();
      invalidateBootstrapCache(tid);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ── DELETE /rmdir ────────────────────────────────────────────────────────

  router.delete('/rmdir', async (req, res) => {
    const tid = getVaultId(req);
    try {
      const safe = safePath(req.query.path || '');
      const recursive = req.query.recursive === '1';
      const prefix = safe + '/';
      const allKeys = await redis.hkeys(treeKey(tid));
      const toDelete = allKeys.filter(k => k === safe || k.startsWith(prefix));

      if (!recursive && toDelete.length > 1) {
        const err = new Error('directory not empty');
        err.code = 'ENOTEMPTY';
        throw err;
      }

      const pipe = redis.pipeline();
      for (const key of toDelete) {
        pipe.hdel(treeKey(tid), key);
        pipe.del(dataKey(tid, key));
      }
      await pipe.exec();
      invalidateBootstrapCache(tid);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ── POST /rename ─────────────────────────────────────────────────────────

  router.post('/rename', express.json(), async (req, res) => {
    const tid = getVaultId(req);
    try {
      const oldPath = safePath(req.body.oldPath || '');
      const newPath = safePath(req.body.newPath || '');

      const allKeys = await redis.hkeys(treeKey(tid));
      const prefix = oldPath + '/';
      const affected = allKeys.filter(k => k === oldPath || k.startsWith(prefix));

      // Read all affected entries first, then write/delete in one pipeline
      const entries = [];
      for (const key of affected) {
        const newKey = newPath + key.slice(oldPath.length);
        const stats = await redis.hget(treeKey(tid), key);
        const data = await redis.get(dataKey(tid, key));
        entries.push({ key, newKey, stats, data });
      }

      const pipe = redis.pipeline();
      for (const { key, newKey, stats, data } of entries) {
        if (stats) pipe.hset(treeKey(tid), newKey, stats);
        pipe.hdel(treeKey(tid), key);
        if (data !== null && data !== undefined) {
          pipe.set(dataKey(tid, newKey), data);
        }
        pipe.del(dataKey(tid), key);
      }
      await pipe.exec();
      invalidateBootstrapCache(tid);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ── POST /copy ───────────────────────────────────────────────────────────

  router.post('/copy', express.json(), async (req, res) => {
    const tid = getVaultId(req);
    try {
      const src = safePath(req.body.src || '');
      const dest = safePath(req.body.dest || '');

      const allKeys = await redis.hkeys(treeKey(tid));
      const prefix = src + '/';
      const affected = allKeys.filter(k => k === src || k.startsWith(prefix));

      const entries = [];
      for (const key of affected) {
        const newKey = dest + key.slice(src.length);
        const stats = await redis.hget(treeKey(tid), key);
        const data = await redis.get(dataKey(tid, key));
        entries.push({ newKey, stats, data });
      }

      const pipe = redis.pipeline();
      for (const { newKey, stats, data } of entries) {
        if (stats) pipe.hset(treeKey(tid), newKey, stats);
        if (data !== null && data !== undefined) {
          pipe.set(dataKey(tid, newKey), data);
        }
      }
      await pipe.exec();
      invalidateBootstrapCache(tid);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}

module.exports = createFsRouter;
