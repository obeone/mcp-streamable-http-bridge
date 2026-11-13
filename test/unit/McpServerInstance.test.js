import { it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { McpServerInstance } from '../../src/managers/McpServerInstance.js';
import { ServerDefinition } from '../../src/managers/ServerDefinition.js';

it('does not pass parent secrets to a real child or log credentials from its stderr', async () => {
  const entries = [];
  const logger = {
    child() { return this; },
    info(message) { entries.push(message); },
    debug(message) { entries.push(message); },
    error(message) { entries.push(message); },
  };
  const server = ServerDefinition.fromConfigEntry('mock', {
    command: process.execPath, args: [path.resolve('test/fixtures/mock-stdio-server.js')], env: { MOCK_TOKEN: '' },
  });
  const previous = process.env.BRIDGE_TEST_SECRET;
  process.env.BRIDGE_TEST_SECRET = 'parent-secret-sentinel';
  const instance = new McpServerInstance(server, { MOCK_TOKEN: 'tenant-secret-sentinel' }, 'test', logger);
  try {
    await instance.start();
    const response = await instance.handleClientRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { logSecret: true } },
    });
    assert.equal(response.result.parentSecret, undefined);
    assert.equal(response.result.token, 'tenant-secret-sentinel');
    assert.ok(entries.some((line) => line.includes('content omitted')));
    assert.ok(entries.every((line) => !line.includes('secret-sentinel')));
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_TEST_SECRET;
    else process.env.BRIDGE_TEST_SECRET = previous;
    await instance.close();
  }
});
