import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { StdioJsonRpcTransport } from '../../src/managers/StdioJsonRpcTransport.js';

describe('StdioJsonRpcTransport', () => {
  it('encodeMessage produces newline-delimited JSON', () => {
    const framed = StdioJsonRpcTransport.encodeMessage({ jsonrpc: '2.0', method: 'ping' });
    assert.match(framed, /\n$/);
    assert.ok(framed.includes('"method":"ping"'));
  });

  it('roundtrips request/response with mock child', async () => {
    const child = spawn(process.execPath, ['test/fixtures/mock-stdio-server.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const transport = new StdioJsonRpcTransport(child);
    const init = await transport.request({
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
    assert.ok(init.result?.serverInfo?.name === 'mock-mcp');

    transport.notify({ method: 'notifications/initialized' });

    const tools = await transport.request({ method: 'tools/list', params: {} });
    assert.equal(tools.result.tools[0].name, 'echo');

    transport.dispose();
    child.kill();
  });
});

// A controllable wire makes response ordering and timeouts deterministic.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

/** @returns {{ child: EventEmitter, frames: object[] }} In-memory child and captured frames. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  const frames = [];
  child.stdin.on('data', (chunk) => frames.push(JSON.parse(chunk.toString())));
  return { child, frames };
}

describe('RPC correlation and limits', () => {
  it('keeps equal client IDs from different sessions separate, including reversed replies', async () => {
    const { child, frames } = fakeChild();
    const transport = new StdioJsonRpcTransport(child);
    const first = transport.request({ id: 7, method: 'tools/call' }, 'session-a');
    const second = transport.request({ id: 7, method: 'tools/call' }, 'session-b');
    assert.notEqual(frames[0].id, frames[1].id);
    child.stdout.write(StdioJsonRpcTransport.encodeMessage({ jsonrpc: '2.0', id: frames[1].id, result: 'B' }));
    child.stdout.write(StdioJsonRpcTransport.encodeMessage({ jsonrpc: '2.0', id: frames[0].id, result: 'A' }));
    assert.deepEqual(await first, { jsonrpc: '2.0', id: 7, result: 'A' });
    assert.deepEqual(await second, { jsonrpc: '2.0', id: 7, result: 'B' });
    transport.dispose();
  });

  it('rejects duplicate IDs within one session without replacing its waiter', async () => {
    const { child, frames } = fakeChild();
    const transport = new StdioJsonRpcTransport(child);
    const first = transport.request({ id: 'same', method: 'ping' }, 'a');
    await assert.rejects(transport.request({ id: 'same', method: 'ping' }, 'a'), /Duplicate/);
    child.stdout.write(StdioJsonRpcTransport.encodeMessage({ jsonrpc: '2.0', id: frames[0].id, result: {} }));
    assert.equal((await first).id, 'same');
    transport.dispose();
  });

  it('does not deliver a timed-out response to a later request with the same client ID', async () => {
    const { child, frames } = fakeChild();
    const transport = new StdioJsonRpcTransport(child, { requestTimeoutMs: 20 });
    await assert.rejects(transport.request({ id: 1, method: 'ping' }), /timed out/);
    const next = transport.request({ id: 1, method: 'ping' });
    const nextFrame = frames.findLast((frame) => frame.method === 'ping');
    child.stdout.write(StdioJsonRpcTransport.encodeMessage({ jsonrpc: '2.0', id: frames[0].id, result: 'stale' }));
    child.stdout.write(StdioJsonRpcTransport.encodeMessage({ jsonrpc: '2.0', id: nextFrame.id, result: 'fresh' }));
    assert.equal((await next).result, 'fresh');
    transport.dispose();
  });

  it('scopes cancellation and restores progress tokens', async () => {
    const { child, frames } = fakeChild();
    const transport = new StdioJsonRpcTransport(child);
    const pending = transport.request({ id: 1, method: 'ping', params: { _meta: { progressToken: 'p' } } }, 'a');
    transport.notify({ method: 'notifications/cancelled', params: { requestId: 1 } }, 'b');
    assert.equal(frames.length, 1);
    transport.notify({ method: 'notifications/cancelled', params: { requestId: 1 } }, 'a');
    assert.equal(frames[1].params.requestId, frames[0].id);
    const notifications = [];
    transport.on('notification', (message, scope) => notifications.push({ message, scope }));
    child.stdout.write(StdioJsonRpcTransport.encodeMessage({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: frames[0].id, progress: 1 } }));
    assert.equal(notifications[0].scope, 'a');
    assert.equal(notifications[0].message.params.progressToken, 'p');
    child.stdout.write(StdioJsonRpcTransport.encodeMessage({ jsonrpc: '2.0', id: frames[0].id, result: {} }));
    await pending;
    transport.dispose();
  });

  it('bounds pending calls and oversized stdout frames', async () => {
    const { child } = fakeChild();
    const transport = new StdioJsonRpcTransport(child, { maxPendingRequests: 1, maxMessageBytes: 32 });
    const pending = transport.request({ id: 1, method: 'ping' });
    await assert.rejects(transport.request({ id: 2, method: 'ping' }), /Too many/);
    const rejected = assert.rejects(pending, /size limit/);
    child.stdout.write('x'.repeat(33));
    await rejected;
    assert.equal(transport.closed, true);
    assert.equal(transport.buffer.length, 0);
  });
});
