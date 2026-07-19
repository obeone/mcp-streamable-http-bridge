import { McpServerInstance } from '../managers/McpServerInstance.js';
import { TenantEnvError } from '../utils/TenantEnvError.js';
import { initSseResponse, writeSseJson } from './SseWriter.js';
import { runWithRequestLogContext } from '../utils/RequestLogContext.js';

/**
 * @typedef {import('../managers/ServerRegistry.js').ServerRegistry} ServerRegistry
 * @typedef {import('../utils/TenantEnvResolver.js').TenantEnvResolver} TenantEnvResolver
 * @typedef {import('../managers/InstancePool.js').InstancePool} InstancePool
 * @typedef {import('../managers/SessionStore.js').SessionStore} SessionStore
 * @typedef {import('../utils/MetricsRegistry.js').MetricsRegistry} MetricsRegistry
 * @typedef {import('../types.js').Logger} Logger
 * @typedef {import('../types.js').IncomingMessage} IncomingMessage
 * @typedef {import('../types.js').ServerResponse} ServerResponse
 *
 * @typedef {Object} StreamableHttpHandlerDeps
 * @property {ServerRegistry} registry
 * @property {TenantEnvResolver} tenantResolver
 * @property {InstancePool} pool
 * @property {SessionStore} sessionStore
 * @property {MetricsRegistry} metrics
 * @property {Logger} logger
 */

const SESSION_HEADER = 'mcp-session-id';

export class StreamableHttpHandler {
  /** @param {StreamableHttpHandlerDeps} deps */
  constructor({ registry, tenantResolver, pool, sessionStore, metrics, logger }) {
    this.registry = registry;
    this.tenantResolver = tenantResolver;
    this.pool = pool;
    this.sessionStore = sessionStore;
    this.metrics = metrics;
    this.logger = logger.child({ component: 'StreamableHttpHandler' });

    /** @type {Map<string, Set<ServerResponse>>} */
    this.sseBySession = new Map();
    /** @type {Map<string, () => void>} */
    this.notificationUnsubs = new Map();
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {string} serverName
   */
  async handle(req, res, serverName) {
    const server = this.registry.get(serverName);
    if (!server) {
      this.#json(res, 404, { error: 'Unknown MCP server' });
      this.metrics.recordHttpRequest('/mcp', 404);
      return;
    }

    if (req.method === 'GET') {
      await this.#handleGet(req, res, serverName);
      return;
    }

    if (req.method === 'POST') {
      await this.#handlePost(req, res, serverName, server);
      return;
    }

    this.#json(res, 405, { error: 'Method not allowed' });
    this.metrics.recordHttpRequest('/mcp', 405);
  }

  /** @param {string} instanceKey */
  onInstanceEvicted(instanceKey) {
    this.sessionStore.invalidateByInstanceKey(instanceKey);
    const unsub = this.notificationUnsubs.get(instanceKey);
    if (unsub) {
      unsub();
      this.notificationUnsubs.delete(instanceKey);
    }
    for (const [sessionId, session] of this.sessionStore.sessions) {
      if (session.instanceKey === instanceKey) {
        this.#closeSseForSession(sessionId);
      }
    }
  }

  async #handleGet(req, res, serverName) {
    const accept = String(req.headers.accept ?? '');
    if (!accept.includes('text/event-stream')) {
      this.#json(res, 406, { error: 'Accept text/event-stream required for GET' });
      this.metrics.recordHttpRequest('/mcp', 406);
      return;
    }

    const sessionId = this.#getSessionId(req);
    if (!sessionId) {
      this.#json(res, 400, { error: 'Missing Mcp-Session-Id header' });
      this.metrics.recordHttpRequest('/mcp', 400);
      return;
    }

    const session = this.sessionStore.get(sessionId);
    if (!session || session.serverName !== serverName) {
      this.#json(res, 404, { error: 'Invalid or expired session' });
      this.metrics.recordHttpRequest('/mcp', 404);
      return;
    }

    const instance = this.pool.get(session.instanceKey);
    if (!instance) {
      this.sessionStore.delete(sessionId);
      this.#json(res, 404, { error: 'Session instance no longer active' });
      this.metrics.recordHttpRequest('/mcp', 404);
      return;
    }

    this.sessionStore.touch(sessionId);
    instance.touch();

    initSseResponse(res);
    if (!this.sseBySession.has(sessionId)) {
      this.sseBySession.set(sessionId, new Set());
    }
    this.sseBySession.get(sessionId).add(res);

    this.#ensureNotificationBridge(session.instanceKey, instance);

    req.on('close', () => {
      const set = this.sseBySession.get(sessionId);
      set?.delete(res);
      if (set && set.size === 0) {
        this.sseBySession.delete(sessionId);
      }
    });

    this.metrics.recordHttpRequest('/mcp', 200);
  }

  async #handlePost(req, res, serverName, server) {
    let body;
    try {
      body = await this.#readBody(req);
    } catch {
      this.#json(res, 400, { error: 'Invalid body' });
      this.metrics.recordHttpRequest('/mcp', 400);
      return;
    }

    let message;
    try {
      message = JSON.parse(body);
    } catch {
      this.#json(res, 400, { error: 'Invalid JSON' });
      this.metrics.recordHttpRequest('/mcp', 400);
      return;
    }

    const messages = Array.isArray(message) ? message : [message];
    if (messages.length !== 1) {
      this.#json(res, 400, { error: 'Exactly one JSON-RPC message per POST is supported' });
      this.metrics.recordHttpRequest('/mcp', 400);
      return;
    }

    const rpc = messages[0];
    let sessionId = this.#getSessionId(req);
    let session = sessionId ? this.sessionStore.get(sessionId) : null;

    /** @type {McpServerInstance | undefined} */
    let instance;

    if (session) {
      if (session.serverName !== serverName) {
        this.#json(res, 404, { error: 'Session does not match server' });
        this.metrics.recordHttpRequest('/mcp', 404);
        return;
      }
      instance = this.pool.get(session.instanceKey);
      if (!instance) {
        this.sessionStore.delete(sessionId);
        this.#json(res, 404, { error: 'Session instance no longer active' });
        this.metrics.recordHttpRequest('/mcp', 404);
        return;
      }
      this.sessionStore.touch(sessionId);
    } else {
      if (rpc.method !== 'initialize') {
        this.#json(res, 400, {
          error: 'First request must be initialize or include Mcp-Session-Id',
        });
        this.metrics.recordHttpRequest('/mcp', 400);
        return;
      }

      let resolved;
      try {
        resolved = this.tenantResolver.resolve(server, req.headers);
      } catch (err) {
        const status = err instanceof TenantEnvError ? 401 : 400;
        this.#json(res, status, { error: err.message });
        this.metrics.recordHttpRequest('/mcp', status);
        return;
      }

      const { env, instanceKey, instanceKeyPrefix } = resolved;
      instance = await this.pool.acquire(instanceKey, serverName, () => {
        return new McpServerInstance(server, env, instanceKeyPrefix, this.logger);
      });

      sessionId = this.sessionStore.create(serverName, instanceKey);
      session = this.sessionStore.get(sessionId);
      this.logger.info(`New HTTP session for server ${serverName}`, {
        server: serverName,
        instanceKeyPrefix,
        sessionId: sessionId.slice(0, 8),
      });
    }

    if (!instance || !session || !sessionId) {
      this.#json(res, 500, { error: 'Internal session error' });
      this.metrics.recordHttpRequest('/mcp', 500);
      return;
    }

    const mcpMethod = rpc.method || 'unknown';
    const start = process.hrtime.bigint();
    let toolName;
    if (mcpMethod === 'tools/call' && rpc.params?.name) {
      toolName = String(rpc.params.name);
    }

    try {
      const response = await runWithRequestLogContext(
        { sessionId: sessionId.slice(0, 8) },
        () => instance.handleClientRequest(rpc)
      );
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      this.metrics.recordRpc(serverName, mcpMethod, durationSec, toolName);
      this.#logRpcComplete({
        serverName,
        mcpMethod,
        toolName,
        durationSec,
        instance,
        sessionId,
      });

      if (response?.notification) {
        res.writeHead(202, { [SESSION_HEADER]: sessionId });
        res.end();
        this.metrics.recordHttpRequest('/mcp', 202);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        [SESSION_HEADER]: sessionId,
      });
      res.end(JSON.stringify(response));
      this.metrics.recordHttpRequest('/mcp', 200);
    } catch (err) {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const rpcLabel = this.#describeRpc(mcpMethod, toolName);
      this.logger.error(`${rpcLabel} failed: ${err.message}`, {
        server: serverName,
        instanceKeyPrefix: instance.instanceKeyPrefix,
        sessionId: sessionId.slice(0, 8),
        pid: instance.child?.pid,
      });
      this.metrics.recordRpc(serverName, mcpMethod, durationSec, toolName);

      if (rpc.id !== undefined) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          [SESSION_HEADER]: sessionId,
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: -32603, message: err.message || 'Internal error' },
          })
        );
        this.metrics.recordHttpRequest('/mcp', 200);
      } else {
        this.#json(res, 500, { error: err.message });
        this.metrics.recordHttpRequest('/mcp', 500);
      }
    }
  }

  #describeRpc(mcpMethod, toolName) {
    if (mcpMethod === 'tools/call' && toolName) {
      return `RPC tools/call ${toolName}`;
    }
    return `RPC ${mcpMethod}`;
  }

  #logRpcComplete({ serverName, mcpMethod, toolName, durationSec, instance, sessionId }) {
    const durationMs = Math.round(durationSec * 1000);
    const label = this.#describeRpc(mcpMethod, toolName);
    const message = `${label} completed in ${durationMs}ms`;
    const meta = {
      server: serverName,
      instanceKeyPrefix: instance.instanceKeyPrefix,
      sessionId: sessionId.slice(0, 8),
      pid: instance.child?.pid,
    };

    if (mcpMethod === 'tools/list' || mcpMethod === 'ping') {
      this.logger.debug(message, meta);
      return;
    }
    if (mcpMethod === 'notifications/initialized') {
      this.logger.debug(message, meta);
      return;
    }
    this.logger.info(message, meta);
  }

  #ensureNotificationBridge(instanceKey, instance) {
    if (this.notificationUnsubs.has(instanceKey)) return;

    const unsub = instance.onNotification((msg) => {
      for (const [sessionId, session] of this.sessionStore.sessions) {
        if (session.instanceKey !== instanceKey) continue;
        const streams = this.sseBySession.get(sessionId);
        if (!streams) continue;
        for (const stream of streams) {
          writeSseJson(stream, msg);
        }
      }
    });
    this.notificationUnsubs.set(instanceKey, unsub);
  }

  #closeSseForSession(sessionId) {
    const streams = this.sseBySession.get(sessionId);
    if (!streams) return;
    for (const stream of streams) {
      stream.end();
    }
    this.sseBySession.delete(sessionId);
  }

  /** @param {IncomingMessage} req */
  #getSessionId(req) {
    const raw = req.headers[SESSION_HEADER] ?? req.headers['mcp-session-id'];
    if (!raw) return undefined;
    return Array.isArray(raw) ? raw[0] : raw;
  }

  /** @param {IncomingMessage} req */
  #readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  #json(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}
