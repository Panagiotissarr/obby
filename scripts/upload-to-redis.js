#!/usr/bin/env node
'use strict';
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');

const VAULT_ID = '9e5a814a277ce6c4';
const VAULT_ROOT = path.resolve(__dirname, '..', 'myvault');

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

async function getAllFiles(dir) {
  const files = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
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

  const BATCH = 5;
  let count = 0;

  for (let i = 0; i < allFiles.length; i += BATCH) {
    const batch = allFiles.slice(i, i + BATCH);
    const pipe = [];

    for (const absPath of batch) {
      const relPath = path.relative(VAULT_ROOT, absPath).replace(/\\/g, '/');
      const stat = await fsp.stat(absPath);

      // Tree entry
      const ext = path.extname(relPath).toLowerCase();
      pipe.push(['HSET', 'vault:' + VAULT_ID + ':tree', relPath, JSON.stringify({
        isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymbolicLink: false,
        size: stat.size, mtime: stat.mtimeMs,
        ...(TEXT_EXTS.has(ext) ? {} : { encoding: 'base64' }),
      })]);

      // Parent dirs
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

      // Content
      if (TEXT_EXTS.has(ext)) {
        const content = await fsp.readFile(absPath, 'utf8');
        pipe.push(['SET', 'vault:' + VAULT_ID + ':data:' + relPath, content]);
      } else {
        const buf = await fsp.readFile(absPath);
        const b64 = buf.toString('base64');
        pipe.push(['SET', 'vault:' + VAULT_ID + ':data:' + relPath, b64]);
      }
    }

    const result = await upstash(url, token, '/pipeline', pipe);
    if (Array.isArray(result)) {
      const errors = result.filter(r => r && r.error);
      if (errors.length > 0) {
        console.error('Pipeline errors:', errors.slice(0, 3));
      }
    }

    count += batch.length;
    const pct = Math.round(count / allFiles.length * 100);
    console.log('  ' + count + '/' + allFiles.length + ' (' + pct + '%)');
  }

  console.log('Done! ' + count + ' files uploaded to vault ' + VAULT_ID);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
