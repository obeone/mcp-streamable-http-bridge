import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, post, initialize } from '../helpers/bridge.js';

/** @param {object} bridge Test bridge. @param {string} session Session ID. @param {object} [args] Tool arguments. @returns {Promise<object>} State reported by the session's child. */
async function inspect(bridge, session, args = {}) {
  const response = await post(bridge.url, {
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: args },
  }, { 'mcp-session-id': session });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, 7);
  assert.ok(body.result, JSON.stringify(body));
  return body.result;
}

describe('Dedicated subprocess per HTTP session', () => {
  it('isolates equal credentials and keeps each session on its original PID and state', async () => {
    const bridge = await startBridge();
    try {
      const [a, b] = await Promise.all([initialize(bridge), initialize(bridge)]);
      assert.notEqual(a, b);
      const stateA = await inspect(bridge, a, { increment: true });
      const stateB = await inspect(bridge, b);
      assert.notEqual(stateA.pid, stateB.pid);
      assert.equal(stateA.token, stateB.token);
      assert.equal(stateA.counter, 1);
      assert.equal(stateB.counter, 0);
      for (let i = 0; i < 3; i++) {
        const nextA = await inspect(bridge, a);
        const nextB = await inspect(bridge, b);
        assert.equal(nextA.pid, stateA.pid);
        assert.equal(nextA.counter, 1);
        assert.equal(nextB.pid, stateB.pid);
        assert.equal(nextB.counter, 0);
      }
      assert.equal(bridge.pool.instances.size, 2);
    } finally { await bridge.stop(); }
  });

  it('uses each client handshake and sends initialized to the backend only once', async () => {
    const bridge = await startBridge();
    try {
      const a = await initialize(bridge, {}, { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'client-a', version: '1' } });
      const b = await initialize(bridge, {}, { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'client-b', version: '1' } });
      const response = await post(bridge.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': a });
      assert.equal(response.status, 202);
      const stateA = await inspect(bridge, a);
      const stateB = await inspect(bridge, b);
      assert.equal(stateA.clientName, 'client-a');
      assert.deepEqual(stateA.capabilities, {});
      assert.equal(stateB.clientName, 'client-b');
      assert.equal(stateA.initializedNotifications, 1);
      assert.equal(stateB.initializedNotifications, 1);
    } finally { await bridge.stop(); }
  });

  it('never broadcasts one session notifications to another with the same credentials', async () => {
    const bridge = await startBridge();
    const controllers = [new AbortController(), new AbortController()];
    try {
      const a = await initialize(bridge);
      const b = await initialize(bridge);
      const readers = await Promise.all([a, b].map(async (session, index) => {
        const response = await fetch(bridge.url, {
          headers: { 'mcp-session-id': session, Accept: 'text/event-stream' }, signal: controllers[index].signal,
        });
        const reader = response.body.getReader();
        await reader.read();
        return reader;
      }));
      await inspect(bridge, a, { notify: 'only-a' });
      await inspect(bridge, b, { notify: 'only-b' });
      const [eventA, eventB] = await Promise.all(readers.map((reader) => reader.read()));
      const textA = new TextDecoder().decode(eventA.value);
      const textB = new TextDecoder().decode(eventB.value);
      assert.ok(textA.includes('only-a'));
      assert.ok(!textA.includes('only-b'));
      assert.ok(textB.includes('only-b'));
      assert.ok(!textB.includes('only-a'));
    } finally {
      controllers.forEach((controller) => controller.abort());
      await bridge.stop();
    }
  });

  it('terminates only the deleted session and rejects every later use of its ID', async () => {
    const bridge = await startBridge();
    try {
      const a = await initialize(bridge);
      const b = await initialize(bridge);
      const stateA = await inspect(bridge, a);
      const stateB = await inspect(bridge, b);
      const response = await fetch(bridge.url, { method: 'DELETE', headers: { 'mcp-session-id': a } });
      assert.equal(response.status, 204);
      assert.throws(() => process.kill(stateA.pid, 0), { code: 'ESRCH' });
      assert.equal((await inspect(bridge, b)).pid, stateB.pid);
      assert.equal(bridge.pool.instances.size, 1);
      for (const method of ['tools/call', 'initialize']) {
        assert.equal((await post(bridge.url, { jsonrpc: '2.0', id: 1, method }, { 'mcp-session-id': a })).status, 404);
      }
    } finally { await bridge.stop(); }
  });

  it('applies owner and credential checks to DELETE as well as POST', async () => {
    const bridge = await startBridge({ trustedUserHeader: 'x-authenticated-user' });
    try {
      const session = await initialize(bridge, { 'x-authenticated-user': 'alice' });
      const response = await fetch(bridge.url, {
        method: 'DELETE', headers: { 'mcp-session-id': session, 'x-authenticated-user': 'bob' },
      });
      assert.equal(response.status, 403);
      assert.equal(bridge.pool.instances.size, 1);
      const conflicting = await fetch(bridge.url, {
        method: 'DELETE', headers: { 'mcp-session-id': session, 'x-authenticated-user': 'alice', 'x-mock_token': 'wrong' },
      });
      assert.equal(conflicting.status, 403);
    } finally { await bridge.stop(); }
  });

  it('returns 404 after child death instead of replacing the process under an existing session', async () => {
    const bridge = await startBridge();
    try {
      const session = await initialize(bridge);
      const record = bridge.sessionStore.get(session);
      const instance = bridge.pool.get(record.instanceKey);
      await instance.close();
      const response = await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': session });
      assert.equal(response.status, 404);
      assert.equal(bridge.pool.instances.size, 0);
      assert.equal(bridge.sessionStore.get(session), undefined);
    } finally { await bridge.stop(); }
  });
});

it('retains process state after a disconnected SSE transport until the session expires', async () => {
  const bridge = await startBridge();
  const controller = new AbortController();
  try {
    const session = await initialize(bridge);
    const initial = await inspect(bridge, session, { increment: true });
    const stream = await fetch(bridge.url, {
      headers: { 'mcp-session-id': session, Accept: 'text/event-stream' }, signal: controller.signal,
    });
    await stream.body.getReader().read();
    controller.abort();
    const resumed = await inspect(bridge, session);
    assert.equal(resumed.pid, initial.pid);
    assert.equal(resumed.counter, 1);
  } finally {
    controller.abort();
    await bridge.stop();
  }
});

it('counts sessions with identical credentials separately against process capacity', async () => {
  const bridge = await startBridge({ maxInstances: 1, maxSessions: 2 });
  try {
    const session = await initialize(bridge);
    const initial = await inspect(bridge, session);
    const rejected = await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'initialize' }, { 'x-mock_token': 'test-token' });
    assert.equal(rejected.status, 503);
    assert.equal(bridge.sessionStore.sessions.size, 1);
    assert.equal((await inspect(bridge, session)).pid, initial.pid);
  } finally { await bridge.stop(); }
});

it('cleans a failed initialization and makes its capacity available to the next session', async () => {
  const bridge = await startBridge({ maxInstances: 1, maxSessions: 1 });
  try {
    const failed = await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'initialize' }, { 'x-mock_token': 'fail-initialize' });
    assert.equal(failed.status, 500);
    assert.ok(!(await failed.text()).includes('private initialization detail'));
    assert.equal(bridge.pool.instances.size, 0);
    assert.equal(bridge.pool.pending.size, 0);
    assert.equal(bridge.sessionStore.sessions.size, 0);
    const session = await initialize(bridge);
    assert.ok((await inspect(bridge, session)).pid);
  } finally { await bridge.stop(); }
});

it('evicts only the idle session and never recreates it implicitly', async () => {
  const bridge = await startBridge();
  try {
    const a = await initialize(bridge);
    const b = await initialize(bridge);
    const stateA = await inspect(bridge, a);
    const stateB = await inspect(bridge, b);
    bridge.pool.get(bridge.sessionStore.get(a).instanceKey).lastUsedAt = 0;
    await bridge.pool.evictIdle();
    assert.throws(() => process.kill(stateA.pid, 0), { code: 'ESRCH' });
    assert.equal((await inspect(bridge, b)).pid, stateB.pid);
    assert.equal((await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': a })).status, 404);
    assert.equal(bridge.pool.instances.size, 1);
  } finally { await bridge.stop(); }
});
