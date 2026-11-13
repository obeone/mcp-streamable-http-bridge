import { createHash } from 'node:crypto';
import { BridgeError } from '../utils/BridgeError.js';
import { readRuntimeOptions } from '../utils/RuntimeOptions.js';
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
  constructor({ registry, tenantResolver, pool, sessionStore, metrics, logger, options = {} }) {
    this.options = readRuntimeOptions(options);
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

    try {
      this.#requestOwner(req);
      if (req.method === 'GET') return await this.#handleGet(req, res, serverName, server);
      if (req.method === 'POST') return await this.#handlePost(req, res, serverName, server);
      if (req.method === 'DELETE') return await this.#handleDelete(req, res, serverName, server);
      this.#json(res, 405, { error: 'Method not allowed' });
      this.metrics.recordHttpRequest('/mcp', 405);
    } catch (error) {
      const status = error instanceof BridgeError ? error.statusCode : 500;
      if (!res.headersSent) this.#json(res, status, {
        error: error instanceof BridgeError ? error.message : 'MCP operation failed',
      });
      this.metrics.recordHttpRequest('/mcp', status);
    }
  }

  /** @param {string} instanceKey */
  onInstanceEvicted(instanceKey) {
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
    this.sessionStore.invalidateByInstanceKey(instanceKey);
  }

  /** @returns {void} Close all streams before HTTP shutdown. */
  close() {
    for (const sessionId of this.sseBySession.keys()) this.#closeSseForSession(sessionId);
    for (const unsubscribe of this.notificationUnsubs.values()) unsubscribe();
    this.notificationUnsubs.clear();
  }

  /**
   * @param {IncomingMessage} req Session termination request.
   * @param {ServerResponse} res HTTP response.
   * @param {string} serverName Target server.
   * @param {object} server Server definition.
   * @returns {Promise<void>} Termination of this session's process and streams.
   * @throws {BridgeError} If the session is missing, expired, or owned by another caller.
   */
  async #handleDelete(req, res, serverName, server) {
    const sessionId = this.#getSessionId(req);
    const session = sessionId && this.sessionStore.get(sessionId);
    if (!session || session.serverName !== serverName) throw new BridgeError(404, 'Invalid or expired session');
    if (session.owner !== this.#requestOwner(req)) throw new BridgeError(403, 'Session owner mismatch');
    const instance = this.pool.get(session.instanceKey);
    if (instance) this.#authorizeSession(req, session, server, instance);
    await this.pool.remove(session.instanceKey);
    this.#closeSseForSession(sessionId);
    this.sessionStore.delete(sessionId);
    res.writeHead(204);
    res.end();
    this.metrics.recordHttpRequest('/mcp', 204);
  }

  async #handleGet(req, res, serverName, server) {
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

    if (session.owner !== this.#requestOwner(req)) throw new BridgeError(403, 'Session owner mismatch');
    const instance = this.pool.get(session.instanceKey);
    if (!instance) {
      await this.pool.remove(session.instanceKey);
      this.#closeSseForSession(sessionId);
      this.sessionStore.delete(sessionId);
      this.#json(res, 404, { error: 'Session instance no longer active' });
      this.metrics.recordHttpRequest('/mcp', 404);
      return;
    }

    this.#authorizeSession(req, session, server, instance);
    this.sessionStore.touch(sessionId);
    instance.touch();
    if ((this.sseBySession.get(sessionId)?.size ?? 0) >= this.options.maxSseStreamsPerSession) {
      throw new BridgeError(429, 'SSE stream limit reached');
    }

    initSseResponse(res);
    if (!this.sseBySession.has(sessionId)) {
      this.sseBySession.set(sessionId, new Set());
    }
    this.sseBySession.get(sessionId).add(res);

    this.#ensureNotificationBridge(session.instanceKey, instance);

    res.on('close', () => {
      const set = this.sseBySession.get(sessionId);
      set?.delete(res);
      if (set && set.size === 0) {
        this.sseBySession.delete(sessionId);
      }
    });

    this.metrics.recordHttpRequest('/mcp', 200);
  }

  async #handlePost(req, res, serverName, server) {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      throw new BridgeError(415, 'Content-Type application/json required');
    }
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      throw new BridgeError(415, 'Compressed request bodies are not supported');
    }
    let body;
    try {
      body = await this.#readBody(req);
    } catch (error) {
      if (error instanceof BridgeError) {
        res.setHeader('Connection', 'close');
        throw error;
      }
      throw new BridgeError(400, 'Invalid body');
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
    if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' ||
      typeof rpc.method !== 'string' || !rpc.method || rpc.method.length > 128 ||
      /[\x00-\x1f\x7f]/.test(rpc.method) ||
      (rpc.id != null && !(typeof rpc.id === 'string' && rpc.id.length <= 256) && !Number.isSafeInteger(rpc.id)) ||
      (rpc.method === 'initialize' && rpc.id == null)) {
      throw new BridgeError(400, 'Invalid JSON-RPC request');
    }
    let sessionId = this.#getSessionId(req);
    let session = sessionId ? this.sessionStore.get(sessionId) : null;
    if (sessionId && !session) throw new BridgeError(404, 'Invalid or expired session');

    /** @type {McpServerInstance | undefined} */
    let instance;

    if (session) {
      if (session.serverName !== serverName) {
        this.#json(res, 404, { error: 'Session does not match server' });
        this.metrics.recordHttpRequest('/mcp', 404);
        return;
      }
      if (session.owner !== this.#requestOwner(req)) throw new BridgeError(403, 'Session owner mismatch');
      instance = this.pool.get(session.instanceKey);
      if (!instance) {
        await this.pool.remove(session.instanceKey);
        this.#closeSseForSession(sessionId);
        this.sessionStore.delete(sessionId);
        this.#json(res, 404, { error: 'Session instance no longer active' });
        this.metrics.recordHttpRequest('/mcp', 404);
        return;
      }
      this.#authorizeSession(req, session, server, instance);
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

      const { env } = resolved;
      sessionId = this.sessionStore.create(serverName, this.#requestOwner(req));
      const { instanceKey } = this.sessionStore.get(sessionId);
      const instanceKeyPrefix = instanceKey.slice(0, 8);
      try {
        instance = await this.pool.acquire(instanceKey, serverName, () => {
          return new McpServerInstance(server, env, instanceKeyPrefix, this.logger, { ...this.options, initializeParams: rpc.params });
        });
      } catch (error) {
        this.sessionStore.delete(sessionId);
        throw error;
      }
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
        () => instance.handleClientRequest(rpc, sessionId)
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
      this.logger.error(`${rpcLabel} failed`, {
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
            error: { code: -32603, message: 'Upstream MCP request failed' },
          })
        );
        this.metrics.recordHttpRequest('/mcp', 200);
      } else {
        this.#json(res, 500, { error: 'Upstream MCP request failed' });
        this.metrics.recordHttpRequest('/mcp', 500);
      }
    }
  }

  #describeRpc(mcpMethod, toolName) {
    if (mcpMethod === 'tools/call' && toolName) {
      return 'RPC tools/call';
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

    const unsub = instance.onNotification((msg, scope) => {
      for (const [sessionId, session] of this.sessionStore.sessions) {
        if (session.instanceKey !== instanceKey || (scope && scope !== sessionId)) continue;
        const streams = this.sseBySession.get(sessionId);
        if (!streams) continue;
        for (const stream of streams) {
          if (stream.destroyed || stream.writableEnded) continue;
          if (!writeSseJson(stream, msg)) stream.destroy();
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

  /**
   * @param {IncomingMessage} req HTTP request.
   * @returns {string} One-way binding to the verified proxy identity or bearer header.
   * @throws {BridgeError} If a configured identity header is absent or invalid.
   */
  #requestOwner(req) {
    const name = this.options.trustedUserHeader;
    const identity = name ? req.headers[name] : req.headers.authorization;
    if (name && (typeof identity !== 'string' || !identity.trim() || identity.length > 1024)) {
      throw new BridgeError(401, 'Trusted user identity required');
    }
    return identity ? createHash('sha256').update(String(identity)).digest('hex') : '';
  }

  /**
   * @param {IncomingMessage} req Session request.
   * @param {object} session Stored ownership binding.
   * @param {object} server Server definition.
   * @param {McpServerInstance} instance Process created with the session credentials.
   * @returns {void}
   * @throws {BridgeError} If identity or supplied credentials differ.
   */
  #authorizeSession(req, session, server, instance) {
    if (session.owner !== this.#requestOwner(req)) throw new BridgeError(403, 'Session owner mismatch');
    try {
      this.tenantResolver.assertSessionHeaders(server, req.headers, instance.tenantEnv);
    } catch {
      throw new BridgeError(403, 'Session credential mismatch');
    }
  }

  /**
   * @param {IncomingMessage} req Request body stream.
   * @returns {Promise<string>} Bounded UTF-8 JSON body.
   * @throws {BridgeError} If oversized, aborted, or too slow.
   */
  #readBody(req) {
    if (Number(req.headers['content-length'] ?? 0) > this.options.maxBodyBytes) {
      req.resume();
      return Promise.reject(new BridgeError(413, 'Request body too large'));
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      const cleanup = () => {
        clearTimeout(timer);
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
        req.removeListener('aborted', onAborted);
      };
      const fail = (error) => { cleanup(); req.resume(); reject(error); };
      const onData = (chunk) => {
        size += chunk.length;
        if (size > this.options.maxBodyBytes) fail(new BridgeError(413, 'Request body too large'));
        else chunks.push(chunk);
      };
      const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
      const onError = () => fail(new BridgeError(400, 'Invalid request body'));
      const onAborted = () => fail(new BridgeError(400, 'Request aborted'));
      const timer = setTimeout(() => fail(new BridgeError(408, 'Request body timed out')), this.options.requestTimeoutMs);
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
      req.once('aborted', onAborted);
    });
  }

  #json(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}
