'use strict';

const assert = require('assert/strict');
const http = require('http');
const test = require('node:test');

// Mock redis client before importing router
const redisModule = require('../redis');

const mockPipelineExecCalls = [];
let mockPipelineSetCalls = [];
let mockPipelineHsetCalls = [];
let mockPipelineHsetnxCalls = [];

const mockRedis = {
  pipeline() {
    return {
      set(key, val) {
        mockPipelineSetCalls.push({ key, val });
        return this;
      },
      hset(key, field, val) {
        mockPipelineHsetCalls.push({ key, field, val });
        return this;
      },
      hsetnx(key, field, val) {
        mockPipelineHsetnxCalls.push({ key, field, val });
        return this;
      },
      async exec() {
        mockPipelineExecCalls.push({
          set: [...mockPipelineSetCalls],
          hset: [...mockPipelineHsetCalls],
          hsetnx: [...mockPipelineHsetnxCalls]
        });
        mockPipelineSetCalls = [];
        mockPipelineHsetCalls = [];
        mockPipelineHsetnxCalls = [];
        return [];
      }
    };
  }
};

redisModule.getRedis = () => mockRedis;

const createVaultSyncRouter = require('../api/vault-sync');

async function startTestServer() {
  const express = require('express');
  const app = express();
  const router = createVaultSyncRouter({});
  app.use(express.json());
  app.use('/api/vault', router);
  
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('POST /api/vault/save stores files to Redis and normalizes non-string contents', async (t) => {
  const server = await startTestServer();
  t.after(server.close);

  const payload = {
    vault: 'my-vault-id',
    files: [
      { path: 'note.md', content: 'Hello note' },
      { path: '.obsidian/app.json', content: '{"theme":"obsidian"}' },
      { path: 'error-note.md', content: { somePromiseResult: true } } // Invalid content structure (e.g. from serialized Promise)
    ]
  };

  const res = await fetch(server.baseUrl + '/api/vault/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.saved, 3);

  // Check what was stored in redis
  assert.equal(mockPipelineExecCalls.length, 1);
  const calls = mockPipelineExecCalls[0];

  // Should have written 3 files
  assert.equal(calls.set.length, 3);
  assert.equal(calls.set[0].key, 'vault:my-vault-id:data:note.md');
  assert.equal(calls.set[0].val, 'Hello note');

  assert.equal(calls.set[1].key, 'vault:my-vault-id:data:.obsidian/app.json');
  assert.equal(calls.set[1].val, '{"theme":"obsidian"}');

  // Third file content should be normalized to an empty string instead of crashing
  assert.equal(calls.set[2].key, 'vault:my-vault-id:data:error-note.md');
  assert.equal(calls.set[2].val, '');

  // Check stats written (hset)
  assert.equal(calls.hset.length, 3);
  assert.equal(calls.hset[0].key, 'vault:my-vault-id:tree');
  assert.equal(calls.hset[0].field, 'note.md');
  const stats0 = JSON.parse(calls.hset[0].val);
  assert.equal(stats0.isFile, true);
  assert.equal(stats0.size, 10); // length of 'Hello note'

  const stats2 = JSON.parse(calls.hset[2].val);
  assert.equal(stats2.isFile, true);
  assert.equal(stats2.size, 0); // length of normalized empty string

  // Check folders created (hsetnx)
  // .obsidian/app.json should result in hsetnx for folder '.obsidian'
  assert.equal(calls.hsetnx.length, 1);
  assert.equal(calls.hsetnx[0].key, 'vault:my-vault-id:tree');
  assert.equal(calls.hsetnx[0].field, '.obsidian');
  const dirStats = JSON.parse(calls.hsetnx[0].val);
  assert.equal(dirStats.isDirectory, true);
});
