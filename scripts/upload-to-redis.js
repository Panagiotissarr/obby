#!/usr/bin/env node
'use strict';
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');

const VAULT_ID = '9e5a814a277ce6c4';
const VAULT_ROOT = path.resolve(__dirname, '..', 'myvault');
const OBSIDIAN_ROOT = path.resolve(__dirname, '..', '.obsidian');

const TEXT_EXTS = new Set([
  '.md', '.json', '.txt', '.csv',
  '.css', '.js', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf',
  '.sh', '.bash', '.zsh', '.fish',
  '.lua', '.py', '.rb', '.rs', '.go',
  '.tex', '.bib', '.sty',
  '.svg',
]);

function upstash(url, token, cmd, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(cmd, url);
    const opts = {
      method: body !== undefined ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    const req = https.request(u, opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks))); }
        catch { resolve(Buffer.concat(chunks).toString()); }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function getRelPath(absPath) {
  const sep = path.sep;
  if (absPath.startsWith(VAULT_ROOT + sep)) {
    return path.relative(VAULT_ROOT, absPath).replace(/\\/g, '/');
  }
  if (absPath.startsWith(OBSIDIAN_ROOT + sep)) {
    return '.obsidian/' + path.relative(OBSIDIAN_ROOT, absPath).replace(/\\/g, '/');
  }
  throw new Error('File outside expected roots: ' + absPath);
}

function shouldSkip(name) {
  return name === '.DS_Store' || name === 'Thumbs.db';
}

async function getAllFiles(dir) {
  const files = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (shouldSkip(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await getAllFiles(abs));
    else files.push(abs);
  }
  return files;
}

async function main() {
  const url = process.argv[2];
  const token = process.argv[3];
  if (!url || !token) {
    console.error('Usage: node scripts/upload-to-redis.js <KV_REST_API_URL> <KV_REST_API_TOKEN>');
    process.exit(1);
  }

  console.log('Scanning ' + VAULT_ROOT + '...');
  const vaultFiles = await getAllFiles(VAULT_ROOT);
  const obsidianFiles = await getAllFiles(path.resolve(__dirname, '..', '.obsidian'));
  const allFiles = [...vaultFiles, ...obsidianFiles];
  console.log('Found ' + allFiles.length + ' files (' + vaultFiles.length + ' from vault, ' + obsidianFiles.length + ' from .obsidian)');

  console.log('Cleaning stale entries...');
  {
    const raw = await upstash(url, token, '/hkeys/vault:' + VAULT_ID + ':tree');
    const allKeys = (raw && raw.result && Array.isArray(raw.result)) ? raw.result.filter(k => typeof k === 'string') : [];
    const stale = allKeys.filter(k => {
      if (k === '..' || k.startsWith('../')) return true;
      if (k === 'plugins' || k === 'themes' || k === 'snippets') return true;
      if (k.startsWith('plugins/') || k.startsWith('themes/') || k.startsWith('snippets/')) return true;
      if (shouldSkip(k)) return true;
      if (/^\d+$/.test(k)) return true;
      return false;
    });
    if (stale.length > 0) {
      console.log('  found ' + stale.length + ' stale entries (e.g. ' + stale.slice(0, 2).join(', ') + ')');
      const delPipe = stale.map(k => ['HDEL', 'vault:' + VAULT_ID + ':tree', k]);
      await upstash(url, token, '/pipeline', delPipe);
      for (let i = 0; i < stale.length; i += 20) {
        const batch = stale.slice(i, i + 20);
        const dataPipe = batch.map(k => ['DEL', 'vault:' + VAULT_ID + ':data:' + k]);
        await upstash(url, token, '/pipeline', dataPipe);
      }
      console.log('  removed ' + stale.length + ' stale entries');
    } else {
      console.log('  nothing to clean');
    }
  }

  let treeCount = 0;
  let dataCount = 0;
  let failed = [];

  // We process all tree entries (HSET) first — these are small
  {
    console.log('\n  --- tree entries ---');
    const BATCH = 20;
    for (let i = 0; i < allFiles.length; i += BATCH) {
      const batch = allFiles.slice(i, i + BATCH);
      const pipe = [];
      for (const absPath of batch) {
        const relPath = getRelPath(absPath);
        const stat = await fsp.stat(absPath);
        const ext = path.extname(relPath).toLowerCase();

        pipe.push(['HSET', 'vault:' + VAULT_ID + ':tree', relPath, JSON.stringify({
          isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymbolicLink: false,
          size: stat.size, mtime: stat.mtimeMs,
          ...(TEXT_EXTS.has(ext) ? {} : { encoding: 'base64' }),
        })]);

        const parts = relPath.split('/');
        parts.pop();
        let dir = '';
        for (const part of parts) {
          dir = dir ? dir + '/' + part : part;
          pipe.push(['HSET', 'vault:' + VAULT_ID + ':tree', dir, JSON.stringify({
            isFile: false, isDirectory: true, isSymbolicLink: false,
            size: 0, mtime: stat.mtimeMs,
          })]);
        }
      }

      const result = await upstash(url, token, '/pipeline', pipe);
      if (!Array.isArray(result)) {
        console.error('    tree pipeline failed (non-array response)');
      } else {
        const errors = result.filter(r => r && typeof r === 'object' && r.error);
        if (errors.length > 0) {
          console.error('    tree pipeline errors:', errors.slice(0, 3));
        }
      }
      treeCount += batch.length;
      console.log('    ' + treeCount + '/' + allFiles.length);
    }
  }

  // Then data entries (SET) — large files get individual requests
  {
    console.log('\n  --- file contents ---');
    const MAX_PIPELINE_BYTES = 4 * 1024 * 1024; // 4MB

    let i = 0;
    while (i < allFiles.length) {
      const pipe = [];
      let pipeSize = 0;

      while (i < allFiles.length) {
        const absPath = allFiles[i];
        const relPath = getRelPath(absPath);
        const stat = await fsp.stat(absPath);
        const ext = path.extname(relPath).toLowerCase();

        // Estimate SET command size
        let estSize;
        if (TEXT_EXTS.has(ext)) {
          estSize = stat.size;
        } else {
          estSize = Math.ceil(stat.size * 4 / 3); // base64 expansion
        }
        const cmdOverhead = 100; // JSON key/command overhead
        const totalEst = estSize + cmdOverhead;

        if (totalEst > MAX_PIPELINE_BYTES) {
          // File too large for pipeline — send individually
          if (pipe.length > 0) {
            // flush current pipeline first
            const result = await upstash(url, token, '/pipeline', pipe);
            if (!Array.isArray(result)) {
              console.error('    data pipeline failed (non-array) for files before ' + relPath);
              for (const p of pipe) { failed.push({ relPath: p[2], reason: 'pipeline rejected' }); }
            } else {
              for (let j = 0; j < pipe.length; j++) {
                const r = result[j];
                if (r && typeof r === 'object' && r.error) {
                  failed.push({ relPath: pipe[j][2] || '(unknown)', reason: r.error });
                }
              }
            }
            pipe.length = 0;
            pipeSize = 0;
          }
          // Send big file individually
          console.log('    big file: ' + relPath + ' (' + stat.size + ' bytes)');
          let content;
          if (TEXT_EXTS.has(ext)) {
            content = await fsp.readFile(absPath, 'utf8');
          } else {
            const buf = await fsp.readFile(absPath);
            content = buf.toString('base64');
          }
          const setResult = await upstash(url, token, '/pipeline', [['SET', 'vault:' + VAULT_ID + ':data:' + relPath, content]]);
          if (!Array.isArray(setResult) || (setResult[0] && typeof setResult[0] === 'object' && setResult[0].error)) {
            const errMsg = Array.isArray(setResult) && setResult[0] ? setResult[0].error : 'pipeline rejected';
            console.error('    FAILED: ' + relPath + ' — ' + errMsg);
            failed.push({ relPath, reason: errMsg });
          }
          dataCount++;
          console.log('    ' + dataCount + '/' + allFiles.length + (failed.length ? ' (' + failed.length + ' failed)' : ''));
          i++;
          continue;
        }

        if (pipeSize + totalEst > MAX_PIPELINE_BYTES && pipe.length > 0) {
          break; // flush current pipeline
        }

        let content;
        if (TEXT_EXTS.has(ext)) {
          content = await fsp.readFile(absPath, 'utf8');
        } else {
          const buf = await fsp.readFile(absPath);
          content = buf.toString('base64');
        }
        pipe.push(['SET', 'vault:' + VAULT_ID + ':data:' + relPath, content]);
        pipeSize += totalEst;
        i++;
      }

      if (pipe.length === 0) continue;

      const result = await upstash(url, token, '/pipeline', pipe);
      if (!Array.isArray(result)) {
        console.error('    data pipeline failed (non-array), retrying individually');
        for (const p of pipe) {
          const relPath = p[1].slice(('vault:' + VAULT_ID + ':data:').length);
          const retryResult = await upstash(url, token, '/pipeline', [[p[0], p[1], p[2]]]);
          if (!Array.isArray(retryResult) || (retryResult[0] && typeof retryResult[0] === 'object' && retryResult[0].error)) {
            const errMsg = Array.isArray(retryResult) && retryResult[0] ? retryResult[0].error : 'pipeline rejected';
            console.error('    FAILED: ' + relPath + ' — ' + errMsg);
            failed.push({ relPath, reason: errMsg });
          }
        }
      } else {
        for (let j = 0; j < pipe.length; j++) {
          const r = result[j];
          if (r && typeof r === 'object' && r.error) {
            const relPath = pipe[j][1].slice(('vault:' + VAULT_ID + ':data:').length);
            console.error('    FAILED: ' + relPath + ' — ' + r.error);
            failed.push({ relPath, reason: r.error });
          }
        }
      }

      dataCount += pipe.length;
      console.log('    ' + dataCount + '/' + allFiles.length + (failed.length ? ' (' + failed.length + ' failed)' : ''));
    }
  }

  // Re-try failed files individually
  if (failed.length > 0) {
    console.log('\n  --- retrying ' + failed.length + ' failed files ---');
    let retried = 0;
    for (const f of failed) {
      let absPath2 = null;
      const vaultPath = path.join(VAULT_ROOT, f.relPath);
      const obsidianPath = path.join(OBSIDIAN_ROOT, f.relPath);
      try { await fsp.stat(vaultPath); absPath2 = vaultPath; } catch (_) {}
      if (!absPath2) { try { await fsp.stat(obsidianPath); absPath2 = obsidianPath; } catch (_) {} }
      if (!absPath2) {
        console.error('    cannot find file: ' + f.relPath);
        continue;
      }
      const stat = await fsp.stat(absPath2);
      const ext = path.extname(f.relPath).toLowerCase();
      let content;
      if (TEXT_EXTS.has(ext)) {
        content = await fsp.readFile(absPath2, 'utf8');
      } else {
        const buf = await fsp.readFile(absPath2);
        content = buf.toString('base64');
      }
      const retryResult = await upstash(url, token, '/pipeline', [['SET', 'vault:' + VAULT_ID + ':data:' + f.relPath, content]]);
      if (!Array.isArray(retryResult) || (retryResult[0] && typeof retryResult[0] === 'object' && retryResult[0].error)) {
        const errMsg = Array.isArray(retryResult) && retryResult[0] ? retryResult[0].error : 'pipeline rejected';
        console.error('    RETRY FAILED: ' + f.relPath + ' — ' + errMsg);
      } else {
        retried++;
      }
    }
    console.log('    retried ' + retried + '/' + failed.length + ' successfully');
  }

  console.log('\nDone! ' + treeCount + ' tree entries, ' + dataCount + ' data entries' + (failed.length ? ', ' + failed.reduce((a, f) => a + (f.retried ? 0 : 1), 0) + ' remaining failures' : ''));
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
