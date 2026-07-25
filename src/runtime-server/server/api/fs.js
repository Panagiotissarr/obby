/**
 * File system HTTP API — backed by Upstash Redis with filesystem fallback.
 *
 * When Redis is unavailable (KV_REST_API_URL not set), falls back to serving
 * files from the filesystem at vaultRegistry/<vault-id> path or fallbackVaultRoot.
 *
 * Redis data model:
 *   vault:{vaultId}:tree       → Hash  — relPath → JSON stats
 *   vault:{vaultId}:data:{path} → String — file content
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

function invalidateBootstrapCache(vaultId) {
  try {
    const { serverCache } = require('./bootstrap');
    if (serverCache) serverCache.delete(vaultId);
  } catch (_) {}
}

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

function makeFsStats(s) {
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    size: s.size,
    mtime: s.mtimeMs,
    ctime: s.ctimeMs,
    atime: s.atimeMs,
    birthtime: s.birthtimeMs,
    mode: s.mode,
  };
}

function pathParent(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx > 0 ? relPath.substring(0, idx) : '';
}

function pathName(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx >= 0 ? relPath.substring(idx + 1) : relPath;
}

async function ensureParentDirs(client, tid, relPath) {
  const parts = relPath.split('/');
  parts.pop();
  let dir = '';
  const pipeline = client.pipeline();
  let dirty = false;
  for (const part of parts) {
    dir = dir ? dir + '/' + part : part;
    pipeline.hexists(treeKey(tid), dir);
    dirty = true;
  }
  if (!dirty) return;
  const results = await pipeline.exec();

  const pipe2 = client.pipeline();
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

function createFsRouter(vaultRegistry, fallbackVaultRoot) {
  const router = express.Router();
  var _redis = null;
  var _redisErr = null;
  function redis() {
    if (_redisErr) return null;
    if (!_redis) {
      try { _redis = getRedis(); }
      catch (e) { _redisErr = e; return null; }
    }
    return _redis;
  }

  function getVaultId(req) {
    return req.query.vault || 'default';
  }

  function getVaultRoot(tid) {
    var entry = vaultRegistry && vaultRegistry.get(tid);
    if (entry && entry.path) return entry.path;
    return fallbackVaultRoot;
  }

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
    if (status === 500) console.error('fs 500:', err.message, err.code, err.stack?.split('\n').slice(0, 3).join(' '));
    res.status(status).json({
      error: err.message,
      code: err.code || null,
    });
  }

  router.get('/stat', async (req, res) => {
    const relPath = req.query.path || '';
    const isPluginsDir = relPath === '.obsidian/plugins' || relPath === '.obsidian/plugins/';
    const tid = getVaultId(req);
    const r = redis();

    try {
      if (relPath) {
        const systemPath = tryGetSystemFilePath(relPath);
        if (systemPath) {
          var exists = false;
          if (r) {
            exists = await r.hexists(treeKey(tid), relPath);
          } else {
            try { await fsp.stat(path.join(getVaultRoot(tid), relPath)); exists = true; } catch (_) {}
          }
          if (!exists) {
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

      if (!relPath) {
        return res.json(makeStats('', true));
      }

      if (r) {
        const raw = await r.hget(treeKey(tid), relPath);
        if (raw) {
          const s = parseStats(raw);
          if (s) return res.json(s);
        }
        const allKeys = await r.hkeys(treeKey(tid)) || [];
        if (Array.isArray(allKeys)) {
          const prefix = relPath + '/';
          const hasChildren = allKeys.some(k => typeof k === 'string' && k.startsWith(prefix));
          if (hasChildren) {
            return res.json(makeStats(relPath, true));
          }
        }
      } else {
        var root = getVaultRoot(tid);
        var fullPath = path.join(root, relPath);
        var s = await fsp.stat(fullPath);
        return res.json(makeFsStats(s));
      }

      throw Object.assign(new Error('not found: ' + relPath), { code: 'ENOENT' });
    } catch (err) {
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

  router.get('/readdir', async (req, res) => {
    const relPath = req.query.path || '';
    const isPluginsDir = relPath === '.obsidian/plugins' || relPath === '.obsidian/plugins/';
    const inSysDirMatch = relPath.match(/^\.obsidian\/plugins\/([^/]+)\/?$/);
    const inSysDir = inSysDirMatch && getSystemPluginIds().includes(inSysDirMatch[1]);
    const tid = getVaultId(req);
    const r = redis();

    try {
      if (inSysDir) {
        var repoDir = getSystemPluginDir(inSysDirMatch[1]);
        var entries = await fsp.readdir(repoDir, { withFileTypes: true });
        var result = await Promise.all(entries.map(async (entry) => {
          var child = path.join(repoDir, entry.name);
          var st = null;
          try { var ss = await fsp.stat(child); st = { isFile: ss.isFile(), isDirectory: ss.isDirectory(), isSymbolicLink: false, size: ss.size, mtime: ss.mtime.getTime(), ctime: ss.ctime.getTime(), atime: ss.atime.getTime(), birthtime: ss.birthtime.getTime(), mode: ss.mode }; } catch (_) {}
          return { name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory(), isSymbolicLink: entry.isSymbolicLink(), stats: st };
        }));
        return res.json(result);
      }

      if (!r) {
        var root = getVaultRoot(tid);
        var absPath = path.join(root, relPath);
        var dirs = await fsp.readdir(absPath, { withFileTypes: true });
        var list = await Promise.all(dirs.map(async function (d) {
          var child = path.join(absPath, d.name);
          var st = null;
          try { st = makeFsStats(await fsp.stat(child)); } catch (_) {}
          return { name: d.name, isFile: d.isFile(), isDirectory: d.isDirectory(), isSymbolicLink: d.isSymbolicLink(), stats: st };
        }));
        if (isPluginsDir) {
          for (const id of getSystemPluginIds()) {
            if (!list.find(e => e.name === id)) {
              list.push({ name: id, isFile: false, isDirectory: true, isSymbolicLink: false, stats: null });
            }
          }
        }
        return res.json(list);
      }

      const prefix = relPath ? relPath + '/' : '';
      const allKeys = await r.hkeys(treeKey(tid)) || [];
      const childMap = new Map();

      for (const key of allKeys) {
        if (typeof key !== 'string') continue;
        if (prefix && !key.startsWith(prefix)) continue;
        if (!prefix && key.indexOf('/') !== -1) continue;
        const rest = prefix ? key.slice(prefix.length) : key;
        if (!rest) continue;
        const slashIdx = rest.indexOf('/');
        if (slashIdx !== -1) {
          const dirName = rest.substring(0, slashIdx);
          if (!childMap.has(dirName)) {
            childMap.set(dirName, { name: dirName, isFile: false, isDirectory: true, isSymbolicLink: false, stats: null });
          }
        } else {
          if (!childMap.has(rest)) {
            const raw = await r.hget(treeKey(tid), key);
            const s = parseStats(raw);
            childMap.set(rest, {
              name: rest,
              isFile: s ? s.isFile : true,
              isDirectory: s ? s.isDirectory : false,
              isSymbolicLink: false,
              stats: s ? { isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: false, size: s.size, mtime: s.mtime, ctime: s.ctime, atime: s.atime, birthtime: s.birthtime, mode: s.mode } : null,
            });
          }
        }
      }

      for (const [name, entry] of childMap) {
        if (entry.isDirectory && !entry.stats) {
          const dirPath = prefix + name;
          const raw = await r.hget(treeKey(tid), dirPath);
          const s = parseStats(raw);
          if (s) { entry.stats = { isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: false, size: s.size, mtime: s.mtime, ctime: s.ctime, atime: s.atime, birthtime: s.birthtime, mode: s.mode }; }
        }
      }

      var result = Array.from(childMap.values());
      if (isPluginsDir) {
        for (const id of getSystemPluginIds()) {
          if (!result.find(e => e.name === id)) {
            result.push({ name: id, isFile: false, isDirectory: true, isSymbolicLink: false, stats: null });
          }
        }
      }
      res.json(result);
    } catch (err) {
      if ((err.code === 'ENOENT' || err.code === 'ENOTDIR')
          && isPluginsDir
          && getSystemPluginIds().length > 0) {
        return res.json(getSystemPluginIds().map(id => ({ name: id, isFile: false, isDirectory: true, isSymbolicLink: false, stats: null })));
      }
      handleError(res, err);
    }
  });

  router.get('/read', async (req, res) => {
    const tid = getVaultId(req);
    const r = redis();
    try {
      const relPath = req.query.path || '';
      const encoding = req.query.encoding || null;

      if (relPath === '.obsidian/community-plugins.json') {
        let list = [];
        if (r) {
          try {
            const raw = await r.get(dataKey(tid, relPath));
            if (raw !== null && raw !== undefined) {
              const arr = Array.isArray(raw) ? raw : JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
              if (Array.isArray(arr)) list = arr;
            }
          } catch (_) {}
        } else {
          try {
            const raw = await fsp.readFile(path.join(getVaultRoot(tid), relPath), 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) list = parsed;
          } catch (_) {}
        }
        const merged = mergeCommunityList(list);
        if (encoding) return res.type('text/plain; charset=utf-8').send(JSON.stringify(merged));
        return res.type('application/json').send(JSON.stringify(merged));
      }

      const systemPath = tryGetSystemFilePath(relPath);
      if (systemPath) {
        var inVault = false;
        if (r) {
          inVault = await r.hexists(treeKey(tid), relPath);
        } else {
          try { await fsp.stat(path.join(getVaultRoot(tid), relPath)); inVault = true; } catch (_) {}
        }
        if (!inVault) {
          if (encoding) { const data = await fsp.readFile(systemPath, encoding); return res.type('text/plain; charset=utf-8').send(data); }
          const data = await fsp.readFile(systemPath); return res.type('application/octet-stream').send(data);
        }
      }

      if (r) {
        const content = await r.get(dataKey(tid, relPath));
        if (content === null || content === undefined) throw Object.assign(new Error('ENOENT: ' + relPath), { code: 'ENOENT' });
        if (encoding) {
          res.type('text/plain; charset=utf-8').send(typeof content === 'string' ? content : JSON.stringify(content));
        } else {
          const raw = await r.hget(treeKey(tid), relPath);
          const s = parseStats(raw);
          if (s && s.encoding === 'base64') {
            res.type('application/octet-stream').send(Buffer.from(typeof content === 'string' ? content : JSON.stringify(content), 'base64'));
          } else {
            const str = typeof content === 'string' ? content : JSON.stringify(content);
            res.type('application/octet-stream').send(Buffer.from(str));
          }
        }
      } else {
        var root = getVaultRoot(tid);
        var fullPath = path.join(root, relPath);
        if (encoding) {
          const data = await fsp.readFile(fullPath, encoding);
          res.type('text/plain; charset=utf-8').send(data);
        } else {
          const data = await fsp.readFile(fullPath);
          res.type('application/octet-stream').send(data);
        }
      }
    } catch (err) {
      handleError(res, err);
    }
  });

  router.put('/write', express.raw({ type: '*/*', limit: '256mb' }), async (req, res) => {
    const tid = getVaultId(req);
    const r = redis();
    try {
      const relPath = req.query.path || '';
      const safe = safePath(relPath);
      const encoding = req.query.encoding || null;
      let data = encoding ? req.body.toString(encoding) : req.body;

      if (safe === '.obsidian/community-plugins.json' && encoding) {
        try { const parsed = JSON.parse(data); if (Array.isArray(parsed)) { const cleaned = stripCommunityList(parsed); data = JSON.stringify(cleaned, null, 2); } } catch (_) {}
      }

      if (r) {
        const contentStr = encoding ? data : (Buffer.isBuffer(data) ? data.toString('base64') : String(data));
        const stats = makeStats(safe, false);
        stats.size = encoding ? Buffer.byteLength(data, 'utf8') : (Buffer.isBuffer(data) ? data.length : 0);
        const pipe = r.pipeline();
        pipe.set(dataKey(tid, safe), contentStr);
        pipe.hset(treeKey(tid), safe, JSON.stringify(stats));
        await pipe.exec();
        await ensureParentDirs(r, tid, safe);
        invalidateBootstrapCache(tid);
      } else {
        var root = getVaultRoot(tid);
        var fullPath = path.join(root, safe);
        await fsp.mkdir(path.dirname(fullPath), { recursive: true });
        if (encoding) { await fsp.writeFile(fullPath, data, encoding); }
        else { await fsp.writeFile(fullPath, data); }
      }
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/mkdir', express.json(), async (req, res) => {
    const tid = getVaultId(req);
    const r = redis();
    try {
      const safe = safePath(req.body.path || '');
      if (r) {
        const stats = makeStats(safe, true);
        await r.hset(treeKey(tid), safe, JSON.stringify(stats));
        await ensureParentDirs(r, tid, safe);
        invalidateBootstrapCache(tid);
      } else {
        await fsp.mkdir(path.join(getVaultRoot(tid), safe), { recursive: true });
      }
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/unlink', async (req, res) => {
    const tid = getVaultId(req);
    const r = redis();
    try {
      const safe = safePath(req.query.path || '');
      if (r) {
        const pipe = r.pipeline();
        pipe.del(dataKey(tid, safe));
        pipe.hdel(treeKey(tid), safe);
        await pipe.exec();
        invalidateBootstrapCache(tid);
      } else {
        await fsp.unlink(path.join(getVaultRoot(tid), safe));
      }
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/rmdir', async (req, res) => {
    const tid = getVaultId(req);
    const r = redis();
    try {
      const safe = safePath(req.query.path || '');
      const recursive = req.query.recursive === '1';
      if (r) {
        const prefix = safe + '/';
        const allKeys = await r.hkeys(treeKey(tid)) || [];
        const toDelete = allKeys.filter(k => typeof k === 'string' && (k === safe || k.startsWith(prefix)));
        if (!recursive && toDelete.length > 1) { const err = new Error('directory not empty'); err.code = 'ENOTEMPTY'; throw err; }
        const pipe = r.pipeline();
        for (const key of toDelete) { pipe.hdel(treeKey(tid), key); pipe.del(dataKey(tid, key)); }
        await pipe.exec();
        invalidateBootstrapCache(tid);
      } else {
        var root = getVaultRoot(tid);
        if (recursive) { await fsp.rm(path.join(root, safe), { recursive: true, force: true }); }
        else { await fsp.rmdir(path.join(root, safe)); }
      }
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/rename', express.json(), async (req, res) => {
    const tid = getVaultId(req);
    const r = redis();
    try {
      const oldPath = safePath(req.body.oldPath || '');
      const newPath = safePath(req.body.newPath || '');
      if (r) {
        const allKeys = await r.hkeys(treeKey(tid)) || [];
        const prefix = oldPath + '/';
        const affected = allKeys.filter(k => typeof k === 'string' && (k === oldPath || k.startsWith(prefix)));
        const entries = [];
        for (const key of affected) {
          const newKey = newPath + key.slice(oldPath.length);
          const stats = await r.hget(treeKey(tid), key);
          const data = await r.get(dataKey(tid, key));
          entries.push({ key, newKey, stats, data });
        }
        const pipe = r.pipeline();
        for (const { key, newKey, stats, data } of entries) {
          if (stats) pipe.hset(treeKey(tid), newKey, stats);
          pipe.hdel(treeKey(tid), key);
          if (data !== null && data !== undefined) { pipe.set(dataKey(tid, newKey), data); }
          pipe.del(dataKey(tid), key);
        }
        await pipe.exec();
        invalidateBootstrapCache(tid);
      } else {
        var root = getVaultRoot(tid);
        await fsp.rename(path.join(root, oldPath), path.join(root, newPath));
      }
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/copy', express.json(), async (req, res) => {
    const tid = getVaultId(req);
    const r = redis();
    try {
      const src = safePath(req.body.src || '');
      const dest = safePath(req.body.dest || '');
      if (r) {
        const allKeys = await r.hkeys(treeKey(tid)) || [];
        const prefix = src + '/';
        const affected = allKeys.filter(k => typeof k === 'string' && (k === src || k.startsWith(prefix)));
        const entries = [];
        for (const key of affected) {
          const newKey = dest + key.slice(src.length);
          const stats = await r.hget(treeKey(tid), key);
          const data = await r.get(dataKey(tid, key));
          entries.push({ newKey, stats, data });
        }
        const pipe = r.pipeline();
        for (const { newKey, stats, data } of entries) {
          if (stats) pipe.hset(treeKey(tid), newKey, stats);
          if (data !== null && data !== undefined) { pipe.set(dataKey(tid, newKey), data); }
        }
        await pipe.exec();
        invalidateBootstrapCache(tid);
      } else {
        var root = getVaultRoot(tid);
        var srcPath = path.join(root, src);
        var dstPath = path.join(root, dest);
        var s = await fsp.stat(srcPath);
        if (s.isDirectory()) { await fsp.cp(srcPath, dstPath, { recursive: true }); }
        else { await fsp.mkdir(path.dirname(dstPath), { recursive: true }); await fsp.copyFile(srcPath, dstPath); }
      }
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}

module.exports = createFsRouter;
