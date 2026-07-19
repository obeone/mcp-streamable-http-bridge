import { EventEmitter } from 'node:events';

/**
 * @typedef {import('../types.js').ChildProcessWithoutNullStreams} ChildProcessWithoutNullStreams
 *
 * MCP stdio transport: newline-delimited JSON (matches @modelcontextprotocol/sdk).
 */
export class StdioJsonRpcTransport extends EventEmitter {
  /** @param {ChildProcessWithoutNullStreams} child */
  constructor(child) {
    super();
    this.child = child;
    this.buffer = Buffer.alloc(0);
    /** @type {Map<number | string, { resolve: Function, reject: Function }>} */
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;

    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.on('exit', () => this.#onClose());
  }

  /**
   * @param {object} message
   * @returns {Promise<object>}
   */
  request(message) {
    if (this.closed) {
      return Promise.reject(new Error('Transport closed'));
    }
    return new Promise((resolve, reject) => {
      const id = message.id ?? this.nextId++;
      const payload = { ...message, jsonrpc: '2.0', id };
      this.pending.set(id, { resolve, reject });
      this.#writeMessage(payload);
    });
  }

  /** @param {object} message */
  notify(message) {
    if (this.closed) return;
    this.#writeMessage({ ...message, jsonrpc: '2.0' });
  }

  /** @param {object} obj */
  #writeMessage(obj) {
    this.child.stdin.write(`${JSON.stringify(obj)}\n`, 'utf8');
  }

  /** @param {Buffer} chunk */
  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.#processBuffer();
  }

  #processBuffer() {
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) return;

      let line = this.buffer.subarray(0, newline).toString('utf8');
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (!line.trim()) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      this.#dispatchMessage(msg);
    }
  }

  /** @param {object} msg */
  #dispatchMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(Object.assign(new Error(msg.error.message || 'JSON-RPC error'), { rpcError: msg.error }));
      } else {
        resolve(msg);
      }
    } else if (msg.method && msg.id === undefined) {
      this.emit('notification', msg);
    } else if (msg.method && msg.id !== undefined) {
      this.emit('request', msg);
    }
  }

  #onClose() {
    this.dispose();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error('Transport closed'));
    }
    this.pending.clear();
    this.emit('close');
  }

  /**
   * Encode a message for tests / external use.
   * @param {object} obj
   */
  static encodeMessage(obj) {
    return `${JSON.stringify(obj)}\n`;
  }
}
