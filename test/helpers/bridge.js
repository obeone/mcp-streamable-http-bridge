import path from 'node:path';
import { ServerDefinition } from '../../src/managers/ServerDefinition.js';
import { ServerRegistry } from '../../src/managers/ServerRegistry.js';
import { InstancePool } from '../../src/managers/InstancePool.js';
import { SessionStore } from '../../src/managers/SessionStore.js';
import { TenantEnvResolver } from '../../src/utils/TenantEnvResolver.js';
import { readRuntimeOptions } from '../../src/utils/RuntimeOptions.js';
import { StreamableHttpHandler } from '../../src/routers/StreamableHttpHandler.js';
import { McpHttpServer } from '../../src/routers/McpHttpServer.js';

/**
 * @param {object} [limits] Runtime limits for the test bridge.
 * @returns {Promise<object>} Live bridge, state and cleanup callback.
 */
export async function startBridge(limits = {}) {
  const logger = { child() { return this; }, debug() {}, info() {}, warn() {}, error() {} };
  const metrics = { setInstancesActive() {}, recordHttpRequest() {}, recordRpc() {}, registry: { contentType: 'text/plain' }, async metricsText() { return ''; } };
  const options = readRuntimeOptions(limits);
  const definition = ServerDefinition.fromConfigEntry('mock', {
    command: process.execPath, args: [path.resolve('test/fixtures/mock-stdio-server.js')], env: { MOCK_TOKEN: '' },
  });
  const registry = new ServerRegistry([definition]);
  const sessionStore = new SessionStore({ maxSessions: options.maxSessions });
  let handler;
  const pool = new InstancePool({ logger, maxInstances: options.maxInstances, onInstanceEvicted: (key) => handler.onInstanceEvicted(key) });
  handler = new StreamableHttpHandler({ registry, tenantResolver: new TenantEnvResolver(), pool, sessionStore, metrics, logger, options });
  const httpServer = new McpHttpServer({ streamableHandler: handler, registry, metrics });
  await httpServer.listen(0);
  const url = `http://127.0.0.1:${httpServer.server.address().port}/mcp/mock`;
  return {
    url, pool, sessionStore, handler,
    async stop() {
      handler.close();
      const stopped = httpServer.stop();
      await pool.closeAll();
      await stopped;
    },
  };
}

/** @param {string} url MCP endpoint. @param {object | string} message Payload. @param {object} [headers] Extra headers. @returns {Promise<Response>} HTTP response. */
export function post(url, message, headers = {}) {
  return fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof message === 'string' ? message : JSON.stringify(message),
  });
}

/** @param {object} bridge Live fixture. @param {object} [headers] Credentials and identity. @param {object} [params] Client handshake. @returns {Promise<string>} Generated session ID. */
export async function initialize(bridge, headers = {}, params) {
  const response = await post(bridge.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params }, { 'x-mock_token': 'test-token', ...headers });
  if (response.status !== 200) throw new Error(`Initialization failed: ${response.status}`);
  await response.json();
  return response.headers.get('mcp-session-id');
}
