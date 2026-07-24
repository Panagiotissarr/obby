/**
 * Upstash Redis client singleton.
 *
 * Initializes once from environment variables and is shared across all
 * API modules. On Vercel the env vars are set via the dashboard or
 * .env.local; locally they can come from a .env file or export.
 */

const { Redis } = require('@upstash/redis');

let _client = null;

function getRedis() {
  if (!_client) {
    const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error(
        'KV_REST_API_URL and KV_REST_API_TOKEN must be set',
      );
    }
    _client = new Redis({ url, token });
  }
  return _client;
}

// ── Key helpers ──────────────────────────────────────────────────────────

function treeKey(vaultId) {
  return `vault:${vaultId || 'default'}:tree`;
}

function dataKey(vaultId, relPath) {
  return `vault:${vaultId || 'default'}:data:${relPath}`;
}

module.exports = { getRedis, treeKey, dataKey };
