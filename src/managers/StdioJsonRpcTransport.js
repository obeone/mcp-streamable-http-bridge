import { EventEmitter } from 'node:events';

/** Newline-delimited JSON-RPC with scoped client IDs and bounded resources. */
export class StdioJsonRpcTransport extends EventEmitter {
  /**
   * @param {import('../types.js').ChildProcessWithoutNullStreams} child Child process.
   * @param {object} [options] Request and framing limits.
   * @returns {StdioJsonRpcTransport} Transport for this process.
   */
  constructor(child, { requestTimeoutMs = 30_000, maxMessageBytes = 1024 * 1024, maxPendingRequests = 128 } = {}) {
    super();
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxMessageBytes = maxMessageBytes;
    this.maxPendingRequests = maxPendingRequests;
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.once('exit', () => this.dispose());
    child.stdin.on('error', () => this.dispose());
  }

  /**
   * @param {object} message Client request, with its original ID.
   * @param {string} [scope] Owning HTTP session, used for cancellation and progress.
   * @returns {Promise<object>} Response carrying the original client ID.
   * @throws {Error} If closed, overloaded, duplicated within a session, or timed out.
   */
  request(message, scope = '') {
    if (this.closed) return Promise.reject(new Error('Transport closed'));
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new Error('Too many pending MCP requests'));
    }
    if (message.id !== undefined && [...this.pending.values()].some(
      (entry) => entry.scope === scope && entry.originalId === message.id
    )) {
      return Promise.reject(new Error('Duplicate in-flight JSON-RPC ID'));
    }
    const id = `bridge-${this.nextId++}`;
    const payload = { ...message, jsonrpc: '2.0', id };
    const progressToken = message.params?._meta?.progressToken;
    if (progressToken !== undefined) {
      payload.params = { ...message.params, _meta: { ...message.params._meta, progressToken: id } };
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.#writeMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
        reject(new Error('MCP request timed out'));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, originalId: message.id, scope, progressToken });
      try {
        this.#writeMessage(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * @param {object} message Notification in the client's ID namespace.
   * @param {string} [scope] Owning HTTP session.
   * @returns {void}
   */
  notify(message, scope = '') {
    if (this.closed) return;
    if (message.method === 'notifications/cancelled') {
      const entry = [...this.pending].find(([, pending]) =>
        pending.scope === scope && pending.originalId === message.params?.requestId
      );
      if (!entry) return;
      message = { ...message, params: { ...message.params, requestId: entry[0] } };
    }
    this.#writeMessage({ ...message, jsonrpc: '2.0' });
  }

  /** @param {object} message Wire message. @returns {void} */
  #writeMessage(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  /** @param {Buffer} chunk Child stdout. @returns {void} */
  #onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (!this.closed) {
      const newline = this.buffer.indexOf('\n');
      if (newline > this.maxMessageBytes || (newline === -1 && this.buffer.length > this.maxMessageBytes)) {
        this.dispose(new Error('MCP response exceeds message size limit'));
        return;
      }
      if (newline === -1) return;
      const line = this.buffer.subarray(0, newline).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && !Array.isArray(message) && message.jsonrpc === '2.0') {
        this.#dispatchMessage(message);
      }
    }
  }

  /** @param {object} message Parsed wire message. @returns {void} */
  #dispatchMessage(message) {
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        this.emit('request', message);
      } else if (message.method === 'notifications/progress') {
        const pending = this.pending.get(message.params?.progressToken);
        if (pending?.progressToken !== undefined) {
          this.emit('notification', {
            ...message, params: { ...message.params, progressToken: pending.progressToken },
          }, pending.scope);
        }
      } else {
        this.emit('notification', message);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(Object.assign(new Error('Upstream MCP request failed'), { rpcError: message.error }));
    } else {
      pending.resolve({ ...message, id: pending.originalId ?? message.id });
    }
  }

  /** @param {Error} [error] Failure shared by pending requests. @returns {void} */
  dispose(error = new Error('Transport closed')) {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.emit('close');
  }

  /** @param {object} message Wire message. @returns {string} Serialized frame. */
  static encodeMessage(message) {
    return `${JSON.stringify(message)}\n`;
  }
}
