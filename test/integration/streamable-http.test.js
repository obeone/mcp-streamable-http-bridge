import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpWrapperApplication } from '../../src/McpWrapperApplication.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '../..');

describe('Streamable HTTP integration', () => {
  /** @type {McpWrapperApplication} */
  let app;
  let baseUrl;
  let configDir;

  before(async () => {
    configDir = path.join(projectRoot, 'test/fixtures/config');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          mock: {
            command: 'node',
            args: [path.join(projectRoot, 'test/fixtures/mock-stdio-server.js')],
            env: { MOCK_TOKEN: 'default-token' },
          },
        },
      })
    );

    const port = 18080 + Math.floor(Math.random() * 1000);
    app = new McpWrapperApplication({
      configDir,
      port,
      logFilePath: path.join(projectRoot, 'logs/test.log'),
    });
    await app.start();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await app.stop();
  });

  it('GET / returns HTML catalog for browsers', async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /html/i);
    const body = await res.text();
    assert.match(body, /markdown-body/);
    assert.match(body, /mock/);
  });

  it('GET /catalog.md returns raw markdown', async () => {
    const res = await fetch(`${baseUrl}/catalog.md`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /markdown/i);
    const body = await res.text();
    assert.match(body, /mock/);
    assert.match(body, /Streamable HTTP/);
  });

  it('health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.ok(body.servers >= 1);
  });

  it('initialize creates session and tools/list works', async () => {
    const initRes = await fetch(`${baseUrl}/mcp/mock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-MOCK_TOKEN': 'test-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      }),
    });

    assert.equal(initRes.status, 200);
    const sessionId = initRes.headers.get('mcp-session-id');
    assert.ok(sessionId);

    const initBody = await initRes.json();
    assert.ok(initBody.result?.serverInfo?.name === 'mock-mcp');

    const listRes = await fetch(`${baseUrl}/mcp/mock`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    });

    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.result.tools[0].name, 'echo');
  });
});
