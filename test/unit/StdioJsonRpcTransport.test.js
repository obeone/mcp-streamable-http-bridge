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
