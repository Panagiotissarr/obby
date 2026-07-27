# AGENTS.md — obby (obsidian-web, Vercel + Upstash Redis)

> Obby = the `note.sarris.dev` deployment of obsidian-web. Vault data lives in
> Upstash Redis, served via Vercel serverless functions (`api/index.js`).

## Repo state

- **Single branch** (`main`), regular git checkout (no bare/worktrees in this repo).
- Merged directly to `main` → auto-deploys to Vercel.
- Vercel project `obby` at `note.sarris.dev`.

## Architecture

Obsidian's mobile renderer (`vendor/obsidian-mobile/`, gitignored, extracted from Android APK) runs in the browser with Electron/Capacitor shims (`src/client-mobile/shims/`). Backend is a Node.js Express server deployed on Vercel as a serverless function (`api/index.js`).

```
Browser ──GET /──> Vercel ──> api/index.js (Express app)
                │                 ├── /api/fs/*     ──> Redis
                │                 ├── /api/bootstrap ──> Redis
                │                 ├── /api/watch     ──> WebSocket (fails on Vercel, expected)
                │                 └── static files   ──> vendor/obsidian-mobile/
```

### Redis data model
- `vault:{vaultId}:tree` — Hash: `relPath` → `JSON {mtime, size, isFile, isDirectory}`
- `vault:{vaultId}:data:{relPath}` — String (file content)
- `vault:index` — JSON array of vault IDs

### Bootstrap cache
Server-side (`src/runtime-server/server/api/bootstrap.js`): `/api/bootstrap` returns `{electron, fs, dirs}` — all files, stats, directory listings in one compressed response. Server caches in `serverCache` Map. Invalidated on vault writes.

Client-side (`src/client-mobile/bootstrap-lookup.js`): `window.__owBootstrapCache` set by `boot.js` from the bootstrap response. `lookupDir`, `lookupStat`, `lookupContent` are pure helpers that answer `readdir`/`stat`/`readFile` from cache.

Critical: `readdir` in `capacitor-shim.js` now **bypasses the bootstrap cache** and always hits `/api/fs/readdir`. The bootstrap cache is still used for `stat` and `readFile`.

### Tree corruption
`getTreeEntries()` (`src/runtime-server/server/redis.js:66`) handles numeric-key flattening corruption (`Object.entries(hgetall).flat()` written back as positional pairs). Detects and reconstructs on every read. No write-back.

## Key commands

```bash
# Start local dev server (auto-reloads)
cd src/runtime-server/server && npm run dev

# Run tests (Node built-in test runner)
cd src/runtime-server/server && npm test
cd src/client-mobile && npm test

# Extract Obsidian mobile bundle (creates vendor/obsidian-mobile/)
node scripts/update-obsidian-mobile.js
node scripts/patch-obsidian-mobile.js

# Extract a specific version
node scripts/update-obsidian-mobile.js --version 1.12.7
```

## Vercel deploy

- `vercel.json` routes all requests through `api/index.js`.
- `installCommand` runs the updater + server npm install.
- `vercel-build` (root `package.json`) runs the updater AGAIN — this is redundant but harmless.
- **GitHub rate limiting**: `update-obsidian-mobile.js` fetches from GitHub API unauthenticated. On Vercel, the shared IP hits 60 req/hr limit. Set `GITHUB_TOKEN` (classic, no scopes) in Vercel env vars to get 5000 req/hr.
- Required Vercel env vars: `KV_REST_API_URL`, `KV_REST_API_TOKEN` (Upstash Redis).
- Build function config: max 30s, includes `{vendor,src/client-mobile,src/plugins,src/config}/**`.

## File tree building

`watchAndStatAll()` (`capacitor-shim.js`) produces a FLAT list of `{name: relPath, type, ...}` entries from the bootstrap `dirs` map. Obsidian's `CapacitorAdapter.quickList` processes them into the vault tree. Entry order = `Object.keys(dirs)` order (insertion order from `walkRedisTree`).

The file explorer expands folders by using the tree from `watchAndStatAll`, not `readdir`. If deeply nested subdirectories don't appear even though the bootstrap `dirs` map has them, the issue is likely in `quickList` — not in the data.

## Key source files

| File | Role |
|------|------|
| `src/client-mobile/shims/capacitor-shim.js` | Main Capacitor shim: `readdir`, `stat`, `readFile`, `watchAndStatAll`, `mkdir`, `rename`, etc. |
| `src/client-mobile/boot.js` | Boot sequence: vault resolution, bootstrap fetch, script injection, rescan |
| `src/client-mobile/bootstrap-lookup.js` | Pure helpers: `lookupDir`, `lookupStat`, `lookupContent` over cache |
| `src/client-mobile/cache-invalidation.js` | Cache mutation helpers for writes |
| `src/runtime-server/server/api/bootstrap.js` | Server bootstrap builder + cache (Map) + warm-up |
| `src/runtime-server/server/api/fs.js` | REST file system handlers (readdir, stat, read, write, delete) |
| `src/runtime-server/server/redis.js` | Redis client, key helpers, `getTreeEntries` (corruption heal) |
| `src/runtime-server/server/vault-registry.js` | Vault registry (maps vault IDs to local paths) |
| `src/runtime-server/server/config.js` | Config, cache-bust computation, env var defaults |

## Conventions

- **No PII or secrets in code**.
- `vendor/` is gitignored. Do not edit extracted Obsidian files — update shims instead.
- Patches to the minified `vendor/obsidian-mobile/app.js` use **pattern/symbol matching**, not line numbers (which shift between versions). See `scripts/patch-obsidian-mobile.js`.
- `src/client-mobile/` file changes get an auto cache bust `?v=<hash>` computed from mtimes at server startup. No manual version bump.
- Obsidian's files (`vendor/obsidian-mobile/`) are third-party artifacts. All edits go in `src/client-mobile/` (shims, boot, overrides).

## Bootstrap config (env vars)

| Var | Default | Effect |
|-----|---------|--------|
| `BOOTSTRAP_DISABLED` | — | Skip bootstrap entirely (every FS read is individual HTTP) |
| `BOOTSTRAP_MAX_FILE_KB` | 500 | Skip content for files over this size |
| `BOOTSTRAP_MAX_TOTAL_MB` | 50 | Cap total uncompressed response |

## Known quirks

- WebSocket (`/api/watch`) fails on Vercel (serverless) — expected.
- `/obsidian/static/*` 404s — Obsidian tries to read its own files from `/obsidian/static/` which doesn't exist as a static route. Some fall through to `/api/fs/read`.
- `node_modules/` under `src/runtime-server/server/` is NOT gitignored (tracked in repo for Vercel).
