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

// Index key — stores a JSON array of known vault IDs so we can discover
// vaults without scanning all keys (Upstash REST doesn't support KEYS).
function indexKey() {
  return 'vault:index';
}

async function listVaultIds() {
  const redis = getRedis();
  const raw = await redis.get(indexKey());
  if (raw) {
    try { return JSON.parse(raw); } catch (_) {}
  }
  return [];
}

async function addVaultToIndex(vaultId) {
  if (!vaultId) return;
  const redis = getRedis();
  const raw = await redis.get(indexKey());
  let ids = [];
  if (raw) {
    try { ids = JSON.parse(raw); } catch (_) {}
  }
  if (ids.indexOf(vaultId) === -1) {
    ids.push(vaultId);
    await redis.set(indexKey(), JSON.stringify(ids));
  }
}

async function getTreeEntries(vaultId) {
  const redis = getRedis();
  const key = treeKey(vaultId);
  const raw = await redis.hgetall(key);
  if (!raw) return {};

  const allKeys = Object.keys(raw);
  if (allKeys.length === 0) return {};

  // Detect flattened indexed format {0: path, 1: statsJSON, 2: path, 3: statsJSON, ...}
  // which happens when Object.entries(hgetall).flat() is written back to the hash.
  // If most keys are numeric, reconstruct from pairs.
  // Non-numeric keys (from recent saves on a corrupted tree) are merged as-is.
  const numericKeys = allKeys.filter(k => /^\d+$/.test(k));
  const nonNumericKeys = allKeys.filter(k => !/^\d+$/.test(k));
  if (numericKeys.length > 0 && numericKeys.length > nonNumericKeys.length) {
    const corrected = {};
    const sorted = numericKeys.map(Number).sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i += 2) {
      const path = raw[String(sorted[i])];
      const stats = raw[String(sorted[i + 1])];
      if (typeof path === 'string' && typeof stats === 'string') {
        corrected[path] = stats;
      }
    }
    for (const k of nonNumericKeys) {
      corrected[k] = raw[k];
    }
    if (Object.keys(corrected).length > 0) {
      console.log(`[redis] tree ${key} was in flattened format — reconstructed ${Object.keys(corrected).length} entries (${Object.keys(corrected).length - nonNumericKeys.length} from pairs, ${nonNumericKeys.length} direct)`);
      return corrected;
    }
  }

  return raw;
}

module.exports = { getRedis, treeKey, dataKey, listVaultIds, addVaultToIndex, getTreeEntries };
