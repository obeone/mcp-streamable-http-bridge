import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StdioJsonRpcTransport } from './StdioJsonRpcTransport.js';

const execFileAsync = promisify(execFile);

/**
 * @typedef {import('./ServerDefinition.js').ServerDefinition} ServerDefinition
 * @typedef {import('../types.js').Logger} Logger
 * @typedef {import('../types.js').ChildProcessWithoutNullStreams} ChildProcessWithoutNullStreams
 */

export class McpServerInstance {
  /**
   * @param {ServerDefinition} server
   * @param {Record<string, string>} tenantEnv
   * @param {string} instanceKeyPrefix
   * @param {Logger} logger
   */
  constructor(server, tenantEnv, instanceKeyPrefix, logger) {
    this.server = server;
    this.tenantEnv = tenantEnv;
    this.instanceKeyPrefix = instanceKeyPrefix;
    this.logger = logger.child({ component: 'McpServerInstance', server: server.name });
    this.lastUsedAt = Date.now();
    /** @type {ChildProcessWithoutNullStreams | null} */
    this.child = null;
    /** @type {StdioJsonRpcTransport | null} */
    this.transport = null;
    /** @type {Promise<void> | null} */
    this.startPromise = null;
    /** @type {object | null} */
    this.initializeResult = null;
    this.dead = false;
    /** @type {Set<(msg: object) => void>} */
    this.notificationListeners = new Set();
  }

  touch() {
    this.lastUsedAt = Date.now();
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async start() {
    if (this.dead) {
      throw new Error('Instance is dead');
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.#doStart().catch((err) => {
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  /** @param {Buffer | string} chunk */
  #logChildStderr(chunk) {
    const text = chunk.toString('utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      const childRaw = line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
      let level = 'info';
      let childMessage = childRaw;

      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.level === 'string') {
          const normalized = parsed.level.toLowerCase();
          if (normalized === 'warning') {
            level = 'warn';
          } else if (['error', 'warn', 'info', 'debug'].includes(normalized)) {
            level = normalized;
          }
        }
        if (typeof parsed.message === 'string' && parsed.message.trim()) {
          childMessage = parsed.message;
        }
      } catch {
        // Plain-text stderr from the child (not JSON).
      }

      const log =
        level === 'error'
          ? this.logger.error.bind(this.logger)
          : level === 'warn'
            ? this.logger.warn.bind(this.logger)
            : level === 'debug'
              ? this.logger.debug.bind(this.logger)
              : this.logger.info.bind(this.logger);

      log(childMessage, { pid: this.child?.pid, stream: 'stderr' });
    }
  }

  async #doStart() {
    const mergedEnv = { ...process.env, ...this.tenantEnv };
    const useShell = process.platform === 'win32';
    this.child = spawn(this.server.command, this.server.args, {
      env: mergedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: useShell,
      windowsHide: true,
    });

    await new Promise((resolve, reject) => {
      const child = this.child;
      if (!child) {
        reject(new Error('Failed to spawn MCP server process'));
        return;
      }
      child.once('spawn', resolve);
      child.once('error', reject);
    });

    this.transport = new StdioJsonRpcTransport(this.child);
    this.transport.on('notification', (msg) => {
      for (const listener of this.notificationListeners) {
        listener(msg);
      }
    });

    this.child.stderr.on('data', (chunk) => this.#logChildStderr(chunk));

    this.child.on('error', (err) => {
      if (this.dead) return;
      this.dead = true;
      this.logger.error('child process error', {
        pid: this.child?.pid,
        message: err.message,
        instanceKeyPrefix: this.instanceKeyPrefix,
      });
      this.transport?.dispose();
    });

    this.child.on('exit', (code, signal) => {
      this.dead = true;
      this.logger.info('child exited', {
        pid: this.child?.pid,
        code,
        signal,
        instanceKeyPrefix: this.instanceKeyPrefix,
      });
      this.transport?.dispose();
    });

    const protocolVersion = process.env.MCP_PROTOCOL_VERSION ?? '2024-11-05';
    const initResponse = await this.transport.request({
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'mcp-streamable-http-bridge', version: '1.0.0' },
      },
    });

    this.initializeResult = initResponse.result ?? initResponse;
    this.transport.notify({ method: 'notifications/initialized' });
    this.touch();
    this.logger.info('instance started', {
      pid: this.child.pid,
      instanceKeyPrefix: this.instanceKeyPrefix,
    });
  }

  /**
   * @param {object} message JSON-RPC request from HTTP client
   */
  async handleClientRequest(message) {
    await this.start();
    if (this.dead || !this.transport) {
      throw new Error('MCP server process is not running');
    }
    this.touch();

    if (message.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: this.initializeResult,
      };
    }

    if (this.#isClientNotification(message)) {
      this.transport.notify({
        method: message.method,
        params: message.params,
      });
      return { notification: true };
    }

    const response = await this.transport.request({
      method: message.method,
      params: message.params,
      id: message.id,
    });
    return response;
  }

  /** @param {object} message */
  #isClientNotification(message) {
    if (!message.method || message.method === 'initialize') {
      return false;
    }
    if (message.method.startsWith('notifications/')) {
      return true;
    }
    return message.id === undefined || message.id === null;
  }

  async close() {
    this.transport?.dispose();
    const child = this.child;
    this.child = null;
    this.transport = null;
    this.startPromise = null;
    this.notificationListeners.clear();

    if (!child || child.killed) return;

    const pid = child.pid;
    if (process.platform === 'win32' && pid) {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      } catch {
        child.kill('SIGTERM');
      }
    } else {
      child.kill('SIGTERM');
    }
  }
}
