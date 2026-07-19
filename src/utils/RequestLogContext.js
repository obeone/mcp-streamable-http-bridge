import { AsyncLocalStorage } from 'node:async_hooks';

/** @typedef {{ sessionId?: string }} RequestLogContextStore */

const storage = new AsyncLocalStorage();

/**
 * @param {RequestLogContextStore} context
 * @param {() => T | Promise<T>} fn
 * @template T
 * @returns {Promise<T>}
 */
export function runWithRequestLogContext(context, fn) {
  return storage.run(context, fn);
}

/** @returns {RequestLogContextStore | undefined} */
export function getRequestLogContext() {
  return storage.getStore();
}
