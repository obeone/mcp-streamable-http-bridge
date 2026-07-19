import { McpServerInstance } from './McpServerInstance.js';
import { IdleEvictionPolicy } from './IdleEvictionPolicy.js';

/**
 * @typedef {import('../types.js').Logger} Logger
 * @typedef {import('../utils/MetricsRegistry.js').MetricsRegistry} MetricsRegistry
 *
 * @typedef {Object} InstancePoolDeps
 * @property {IdleEvictionPolicy} [evictionPolicy]
 * @property {Logger} logger
 * @property {MetricsRegistry} [metrics]
 * @property {(instanceKey: string) => void} [onInstanceEvicted]
 */

export class InstancePool {
  /** @param {InstancePoolDeps} deps */
  constructor({ evictionPolicy, logger, metrics, onInstanceEvicted }) {
    this.evictionPolicy = evictionPolicy ?? new IdleEvictionPolicy();
    this.logger = logger.child({ component: 'InstancePool' });
    this.metrics = metrics;
    this.onInstanceEvicted = onInstanceEvicted;

    /** @type {Map<string, McpServerInstance>} */
    this.instances = new Map();
    /** @type {Map<string, Promise<McpServerInstance>>} */
    this.pending = new Map();
    /** @type {Map<string, string>} instanceKey -> serverName */
    this.instanceServer = new Map();
  }

  /**
   * @param {string} instanceKey
   * @param {string} serverName
   * @param {() => McpServerInstance} createInstance
   */
  async acquire(instanceKey, serverName, createInstance) {
    const existing = this.instances.get(instanceKey);
    if (existing && !existing.dead) {
      existing.touch();
      return existing;
    }
    if (existing?.dead) {
      this.instances.delete(instanceKey);
      this.instanceServer.delete(instanceKey);
    }

    if (this.pending.has(instanceKey)) {
      return this.pending.get(instanceKey);
    }

    const promise = (async () => {
      const instance = createInstance();
      await instance.start();
      this.instances.set(instanceKey, instance);
      this.instanceServer.set(instanceKey, serverName);
      this.pending.delete(instanceKey);
      this.#refreshMetrics();
      return instance;
    })();

    this.pending.set(instanceKey, promise);
    return promise;
  }

  get(instanceKey) {
    const inst = this.instances.get(instanceKey);
    if (inst && !inst.dead) return inst;
    return undefined;
  }

  async evictIdle() {
    const cutoff = Date.now() - this.evictionPolicy.idleMs();
    /** @type {string[]} */
    const toEvict = [];

    for (const [key, instance] of this.instances) {
      if (instance.lastUsedAt < cutoff || instance.dead) {
        toEvict.push(key);
      }
    }

    for (const key of toEvict) {
      const instance = this.instances.get(key);
      const serverName = this.instanceServer.get(key);
      if (instance) {
        const reasonLabel = instance.dead ? 'dead' : 'idle';
        const pid = instance.child?.pid;
        await instance.close();
        this.logger.info(`Evicted ${reasonLabel} instance for server ${serverName}`, {
          server: serverName,
          instanceKeyPrefix: instance.instanceKeyPrefix,
          ...(pid != null ? { pid } : {}),
        });
      }
      this.instances.delete(key);
      this.instanceServer.delete(key);
      this.onInstanceEvicted?.(key);
    }

    if (toEvict.length) {
      this.#refreshMetrics();
    }
  }

  async closeAll() {
    for (const instance of this.instances.values()) {
      await instance.close();
    }
    this.instances.clear();
    this.instanceServer.clear();
    this.pending.clear();
    this.#refreshMetrics();
  }

  #refreshMetrics() {
    if (!this.metrics) return;
    /** @type {Record<string, number>} */
    const counts = {};
    for (const serverName of this.instanceServer.values()) {
      counts[serverName] = (counts[serverName] ?? 0) + 1;
    }
    this.metrics.setInstancesActive(counts);
  }
}
