import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startBridge, post, initialize } from '../helpers/bridge.js';

const call = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: {} } };

describe('HTTP security boundaries', () => {
  it('rejects conflicting tenant headers and a different authenticated owner', async () => {
    const bridge = await startBridge();
    try {
      const session = await initialize(bridge, { Authorization: 'Bearer user-a' });
      const headers = { 'mcp-session-id': session, Authorization: 'Bearer user-a' };
      assert.equal((await post(bridge.url, call, { ...headers, 'x-mock_token': 'different' })).status, 403);
      assert.equal((await post(bridge.url, call, { ...headers, Authorization: 'Bearer user-b' })).status, 403);
      const accepted = await post(bridge.url, call, headers);
      assert.equal(accepted.status, 200);
      assert.equal((await accepted.json()).result.token, 'test-token');
    } finally { await bridge.stop(); }
  });

  it('requires and binds the configured trusted proxy identity on POST and GET', async () => {
    const bridge = await startBridge({ trustedUserHeader: 'x-authenticated-user' });
    try {
      assert.equal((await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'initialize' }, { 'x-mock_token': 'key' })).status, 401);
      const session = await initialize(bridge, { 'x-authenticated-user': 'alice' });
      const wrong = { 'mcp-session-id': session, 'x-authenticated-user': 'bob' };
      assert.equal((await post(bridge.url, call, wrong)).status, 403);
      const stream = await fetch(bridge.url, { headers: { ...wrong, Accept: 'text/event-stream' } });
      assert.equal(stream.status, 403);
    } finally { await bridge.stop(); }
  });

  it('rejects expired session IDs instead of silently creating replacement state', async () => {
    const bridge = await startBridge();
    try {
      const response = await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'initialize' }, {
        'mcp-session-id': 'unknown', 'x-mock_token': 'key',
      });
      assert.equal(response.status, 404);
      assert.equal(bridge.pool.instances.size, 0);
    } finally { await bridge.stop(); }
  });

  it('rejects oversized declared and chunked bodies before acquiring a worker', async () => {
    const bridge = await startBridge({ maxBodyBytes: 512 });
    try {
      const oversized = await post(bridge.url, ' '.repeat(600));
      assert.equal(oversized.status, 413);
      const chunked = await new Promise((resolve, reject) => {
        const request = http.request(bridge.url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', reject);
        request.write(' '.repeat(300));
        request.end(' '.repeat(300));
      });
      assert.equal(chunked, 413);
      assert.equal(bridge.pool.instances.size, 0);
    } finally { await bridge.stop(); }
  });

  it('validates JSON-RPC types without leaking internal error details', async () => {
    const bridge = await startBridge();
    try {
      for (const body of ['null', '[]', '{"jsonrpc":"2.0","method":42}', '{"jsonrpc":"2.0","method":"initialize"}']) {
        const response = await post(bridge.url, body);
        assert.equal(response.status, 400);
      }
      assert.equal(bridge.pool.instances.size, 0);
    } finally { await bridge.stop(); }
  });

  it('caps sessions and rolls back reservations when process capacity is exhausted', async () => {
    const bridge = await startBridge({ maxInstances: 1, maxSessions: 2 });
    try {
      await initialize(bridge);
      const response = await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'initialize' }, { 'x-mock_token': 'other-key' });
      assert.equal(response.status, 503);
      assert.equal(bridge.sessionStore.sessions.size, 1);
      assert.equal(bridge.pool.instances.size, 1);
    } finally { await bridge.stop(); }
    const capped = await startBridge({ maxSessions: 1 });
    try {
      await initialize(capped);
      assert.equal((await post(capped.url, { jsonrpc: '2.0', id: 1, method: 'initialize' }, { 'x-mock_token': 'test-token' })).status, 503);
      assert.equal(capped.sessionStore.sessions.size, 1);
    } finally { await capped.stop(); }
  });

  it('routes concurrent calls with equal client IDs back to their original caller', async () => {
    const bridge = await startBridge();
    try {
      const a = await initialize(bridge);
      const b = await initialize(bridge);
      const responses = await Promise.all([
        post(bridge.url, { ...call, params: { name: 'echo', arguments: { delayMs: 30, echo: 'A' } } }, { 'mcp-session-id': a }),
        post(bridge.url, { ...call, params: { name: 'echo', arguments: { delayMs: 1, echo: 'B' } } }, { 'mcp-session-id': b }),
      ]);
      const bodies = await Promise.all(responses.map((response) => response.json()));
      assert.deepEqual(bodies.map((body) => body.id), [7, 7]);
      assert.deepEqual(bodies.map((body) => body.result.echo), ['A', 'B']);
    } finally { await bridge.stop(); }
  });
});
