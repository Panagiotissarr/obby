/**
 * Vault sync API — Save / Refresh for Redis-backed vaults.
 *
 * POST /api/vault/save   — bulk-save all vault files from client to Redis
 * POST /api/vault/refresh — invalidate bootstrap cache, return fresh state
 *
 * Used by the "Save to Redis" and "Refresh from Redis" context menu items
 * (boot.js) to enable multi-device sync.
 */

const express = require('express');
const { getRedis, treeKey, dataKey } = require('../redis');

function createVaultSyncRouter(vaultRegistry) {
  const router = express.Router();

  // ── POST /api/vault/save ───────────────────────────────────────────────
  // Body: { vault, files: [{ path, content, stats? }] }
  // Writes every file to Redis in a single pipeline batch.
  router.post('/save', express.json({ limit: '256mb' }), async (req, res) => {
    const { vault: vaultId, files } = req.body;
    const tid = vaultId || 'default';
    const redis = getRedis();

    if (!Array.isArray(files)) {
      return res.status(400).json({ error: 'files array required' });
    }

    try {
      const now = Date.now();
      const pipe = redis.pipeline();

      for (const file of files) {
        if (!file.path) continue;
        const relPath = file.path;
        const content = typeof file.content === 'string' ? file.content : '';

        // Write content
        pipe.set(dataKey(tid, relPath), content);

        // Write stats (use provided or generate)
        const stats = file.stats || {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          size: Buffer.byteLength(content, 'utf8'),
          mtime: now,
          ctime: now,
          atime: now,
          birthtime: now,
          mode: 0o100644,
        };
        pipe.hset(treeKey(tid), relPath, JSON.stringify(stats));

        // Ensure parent directories exist
        const parts = relPath.split('/');
        parts.pop();
        let dir = '';
        for (const part of parts) {
          dir = dir ? dir + '/' + part : part;
          pipe.hsetnx(treeKey(tid), dir, JSON.stringify({
            isFile: false,
            isDirectory: true,
            isSymbolicLink: false,
            size: 4096,
            mtime: now,
            ctime: now,
            atime: now,
            birthtime: now,
            mode: 0o040755,
          }));
        }
      }

      await pipe.exec();

      // Invalidate bootstrap cache so next read picks up fresh data
      try {
        const { serverCache } = require('./bootstrap');
        if (serverCache) serverCache.delete(tid);
      } catch (_) {}

      res.json({ ok: true, saved: files.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/vault/refresh ────────────────────────────────────────────
  // Body: { vault }
  // Invalidates the bootstrap cache and returns the current file count
  // from Redis so the client knows the vault state.
  router.post('/refresh', express.json(), async (req, res) => {
    const tid = (req.body && req.body.vault) || 'default';
    const redis = getRedis();

    try {
      // Invalidate bootstrap cache
      try {
        const { serverCache } = require('./bootstrap');
        if (serverCache) serverCache.delete(tid);
      } catch (_) {}

      // Return fresh file count from Redis
      const keys = await redis.hkeys(treeKey(tid));
      res.json({ ok: true, fileCount: keys.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createVaultSyncRouter;
