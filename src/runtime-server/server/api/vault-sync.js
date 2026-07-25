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

// Upstash REST pipelines have a max of ~1024 commands per request.
// We stay well under the limit to avoid silent truncation.
const PIPELINE_BATCH_SIZE = 200;

function createVaultSyncRouter(vaultRegistry) {
  const router = express.Router();

  // ── POST /api/vault/save ───────────────────────────────────────────────
  // Body: { vault, files: [{ path, content, stats? }] }
  // Writes every file to Redis in batched pipeline calls.
  router.post('/save', express.json({ limit: '256mb' }), async (req, res) => {
    const { vault: vaultId, files } = req.body;
    const tid = vaultId || 'default';
    const redis = getRedis();

    console.log('[vault-sync] save request: vault=' + tid + ', files=' + (Array.isArray(files) ? files.length : 'N/A'));

    if (!Array.isArray(files)) {
      return res.status(400).json({ error: 'files array required' });
    }

    try {
      const now = Date.now();

      // Collect all commands as [method, ...args] tuples first
      const commands = [];

      for (const file of files) {
        if (!file.path) continue;
        const relPath = file.path;
        const content = typeof file.content === 'string' ? file.content : '';

        // Write content
        commands.push({ op: 'set', args: [dataKey(tid, relPath), content] });

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
        commands.push({ op: 'hset', args: [treeKey(tid), relPath, JSON.stringify(stats)] });

        // Ensure parent directories exist
        const parts = relPath.split('/');
        parts.pop();
        let dir = '';
        for (const part of parts) {
          dir = dir ? dir + '/' + part : part;
          commands.push({ op: 'hsetnx', args: [treeKey(tid), dir, JSON.stringify({
            isFile: false,
            isDirectory: true,
            isSymbolicLink: false,
            size: 4096,
            mtime: now,
            ctime: now,
            atime: now,
            birthtime: now,
            mode: 0o040755,
          })] });
        }
      }

      console.log('[vault-sync] total pipeline commands: ' + commands.length);

      // Execute in batches to respect Upstash pipeline limits
      let errors = 0;
      for (let i = 0; i < commands.length; i += PIPELINE_BATCH_SIZE) {
        const batch = commands.slice(i, i + PIPELINE_BATCH_SIZE);
        const pipe = redis.pipeline();
        for (const cmd of batch) {
          pipe[cmd.op](...cmd.args);
        }
        const results = await pipe.exec();

        // Check results for errors
        if (Array.isArray(results)) {
          for (const r of results) {
            if (r && r.error) {
              errors++;
              if (errors <= 3) {
                console.warn('[vault-sync] pipeline command error:', r.error);
              }
            }
          }
        }
      }

      if (errors > 0) {
        console.warn('[vault-sync] ' + errors + ' pipeline command(s) failed');
      }

      // Invalidate bootstrap cache so next read picks up fresh data
      try {
        const { serverCache } = require('./bootstrap');
        if (serverCache) serverCache.delete(tid);
      } catch (_) {}

      console.log('[vault-sync] save complete: vault=' + tid + ', saved=' + files.length + ', errors=' + errors);
      res.json({ ok: true, saved: files.length, errors });
    } catch (err) {
      console.error('[vault-sync] save failed:', err.message);
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

    console.log('[vault-sync] refresh request: vault=' + tid);

    try {
      // Invalidate bootstrap cache
      try {
        const { serverCache } = require('./bootstrap');
        if (serverCache) serverCache.delete(tid);
      } catch (_) {}

      // Return fresh file count from Redis
      const keys = await redis.hkeys(treeKey(tid));
      console.log('[vault-sync] refresh result: vault=' + tid + ', fileCount=' + keys.length);
      res.json({ ok: true, fileCount: keys.length });
    } catch (err) {
      console.error('[vault-sync] refresh failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createVaultSyncRouter;

