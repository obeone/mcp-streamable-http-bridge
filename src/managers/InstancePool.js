import { IdleEvictionPolicy } from './IdleEvictionPolicy.js';
import { BridgeError } from '../utils/BridgeError.js';

/** Bounded instance registry; credentials determine reuse until session isolation is enabled. */
export class InstancePool {
  /** @param {object} deps Logger, metrics, eviction policy and lifecycle callback. @returns {InstancePool} */
  constructor({ evictionPolicy, logger, metrics, onInstanceEvicted, maxInstances = 100 }) {
    this.evictionPolicy = evictionPolicy ?? new IdleEvictionPolicy();
    this.logger = logger.child({ component: 'InstancePool' });
    this.metrics = metrics;
    this.onInstanceEvicted = onInstanceEvicted;
    this.maxInstances = maxInstances;
    this.instances = new Map();
    this.pending = new Map();
    this.instanceServer = new Map();
    this.closing = new Set();
    this.closed = false;
  }

  /**
   * @param {string} instanceKey Instance identity.
   * @param {string} serverName Configured server.
   * @param {Function} createInstance Instance factory.
   * @returns {Promise<import('./McpServerInstance.js').McpServerInstance>} Ready instance.
   * @throws {BridgeError} If shutting down or at capacity.
   */
  async acquire(instanceKey, serverName, createInstance) {
    if (this.closed) throw new BridgeError(503, 'Bridge is shutting down');
    const existing = this.get(instanceKey);
    if (existing) {
      existing.touch();
      return existing;
    }
    if (this.instances.has(instanceKey)) await this.remove(instanceKey);
    if (this.pending.has(instanceKey)) return this.pending.get(instanceKey);
    if (this.instances.size + this.pending.size + this.closing.size >= this.maxInstances) {
      throw new BridgeError(503, 'MCP instance limit reached');
    }
    const promise = Promise.resolve().then(async () => {
      const instance = createInstance();
      try {
        await instance.start();
        if (this.closed) throw new BridgeError(503, 'Bridge is shutting down');
        this.instances.set(instanceKey, instance);
        this.instanceServer.set(instanceKey, serverName);
        this.#refreshMetrics();
        return instance;
      } catch (error) {
        await instance.close();
        throw error;
      }
    }).finally(() => this.pending.delete(instanceKey));
    this.pending.set(instanceKey, promise);
    return promise;
  }

  /** @param {string} instanceKey Instance identity. @returns {object | undefined} Live instance. */
  get(instanceKey) {
    const instance = this.instances.get(instanceKey);
    return instance && !instance.dead ? instance : undefined;
  }

  /** @param {string} instanceKey Instance identity. @returns {Promise<void>} Full process cleanup. */
  async remove(instanceKey) {
    const instance = this.instances.get(instanceKey);
    if (!instance) return;
    this.instances.delete(instanceKey);
    this.instanceServer.delete(instanceKey);
    this.onInstanceEvicted?.(instanceKey);
    const closing = Promise.resolve().then(() => instance.close());
    this.closing.add(closing);
    this.#refreshMetrics();
    try {
      await closing;
    } finally {
      this.closing.delete(closing);
    }
  }

  /** @returns {Promise<void>} Eviction of dead or inactive, unoccupied instances. */
  async evictIdle() {
    const cutoff = Date.now() - this.evictionPolicy.idleMs();
    for (const [key, instance] of this.instances) {
      if (instance.dead || (!instance.activeRequests && instance.lastUsedAt < cutoff)) {
        await this.remove(key);
      }
    }
  }

  /** @returns {Promise<void>} Cleanup including starts already in progress. */
  async closeAll() {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
    await Promise.all([...this.instances.keys()].map((key) => this.remove(key)));
    await Promise.allSettled([...this.closing]);
  }

  /** @returns {void} Update aggregate process counts without tenant labels. */
  #refreshMetrics() {
    const counts = Object.create(null);
    for (const name of this.instanceServer.values()) counts[name] = (counts[name] ?? 0) + 1;
    this.metrics?.setInstancesActive(counts);
  }
}
