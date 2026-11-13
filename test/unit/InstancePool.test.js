import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InstancePool } from '../../src/managers/InstancePool.js';
import { SessionStore } from '../../src/managers/SessionStore.js';
import { StreamableHttpHandler } from '../../src/routers/StreamableHttpHandler.js';

const logger = { child() { return this; }, debug() {}, info() {} };

/** @param {object} [overrides] Lifecycle hooks. @returns {object} Controllable instance. */
function fakeInstance(overrides = {}) {
  return { dead: false, activeRequests: 0, lastUsedAt: 0, touch() {}, async start() {}, async close() {}, ...overrides };
}

describe('Instance lifecycle', () => {
  it('cleans failed starts and permits a fresh retry', async () => {
    const pool = new InstancePool({ logger });
    let closed = false;
    await assert.rejects(pool.acquire('key', 'test', () => fakeInstance({
      async start() { throw new Error('startup failed'); },
      async close() { closed = true; },
    })), /startup failed/);
    assert.equal(closed, true);
    assert.equal(pool.pending.size, 0);
    const instance = await pool.acquire('key', 'test', () => fakeInstance());
    assert.equal(pool.get('key'), instance);
    await pool.closeAll();
  });

  it('counts pending starts against the global limit', async () => {
    const pool = new InstancePool({ logger, maxInstances: 1 });
    let ready;
    const gate = new Promise((resolve) => { ready = resolve; });
    const first = pool.acquire('a', 'test', () => fakeInstance({ async start() { await gate; } }));
    await assert.rejects(pool.acquire('b', 'test', () => fakeInstance()), /limit/);
    ready();
    await first;
    await pool.closeAll();
  });

  it('never evicts an instance while a request is active', async () => {
    const pool = new InstancePool({ logger, evictionPolicy: { idleMs: () => 1 } });
    const instance = await pool.acquire('a', 'test', () => fakeInstance({ activeRequests: 1 }));
    await pool.evictIdle();
    assert.equal(pool.get('a'), instance);
    instance.activeRequests = 0;
    await pool.evictIdle();
    assert.equal(pool.get('a'), undefined);
    await pool.closeAll();
  });

  it('waits for pending starts and closes their children during shutdown', async () => {
    const pool = new InstancePool({ logger });
    let ready;
    let closed = false;
    const gate = new Promise((resolve) => { ready = resolve; });
    const start = pool.acquire('a', 'test', () => fakeInstance({
      async start() { await gate; }, async close() { closed = true; },
    }));
    const rejected = assert.rejects(start, /shutting down/);
    const stopped = pool.closeAll();
    ready();
    await rejected;
    await stopped;
    assert.equal(closed, true);
    assert.equal(pool.instances.size, 0);
  });

  it('closes SSE streams before invalidating the corresponding sessions', () => {
    const sessionStore = new SessionStore();
    const session = sessionStore.create('test', 'key');
    const handler = new StreamableHttpHandler({ sessionStore, logger });
    let ended = false;
    handler.sseBySession.set(session, new Set([{ end() { ended = true; } }]));
    handler.onInstanceEvicted('key');
    assert.equal(ended, true);
    assert.equal(sessionStore.get(session), undefined);
    assert.equal(handler.sseBySession.size, 0);
  });
});
