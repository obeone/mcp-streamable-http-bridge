import { TenantEnvError } from './TenantEnvError.js';

/**
 * @typedef {import('../managers/ServerDefinition.js').ServerDefinition} ServerDefinition
 */

/** @param {string} envKey */
function headerNameForEnvKey(envKey) {
  return `x-${envKey}`;
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} canonicalHeaderName
 */
function getHeaderValue(headers, canonicalHeaderName) {
  const target = canonicalHeaderName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

export class TenantEnvResolver {
  /**
   * @param {ServerDefinition} server
   * @param {Record<string, string | string[] | undefined>} headers
   */
  resolve(server, headers) {
    /** @type {Record<string, string>} */
    const env = Object.create(null);

    for (const key of server.envKeys) {
      const headerName = headerNameForEnvKey(key);
      const fromHeader = getHeaderValue(headers, headerName);
      const fromConfig = server.staticEnv[key];
      if (fromHeader !== undefined && !server.headerEnv.includes(key) && fromHeader !== fromConfig) {
        throw new TenantEnvError(`Header ${headerName} cannot override a fixed environment value`);
      }
      const value = fromHeader !== undefined && server.headerEnv.includes(key) ? fromHeader : fromConfig;

      if (value === undefined || value === '') {
        throw new TenantEnvError(
          `Missing value for env "${key}" (provide header ${headerName} or config default)`
        );
      }
      if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) {
        throw new TenantEnvError(`Invalid value for env ${key}`);
      }
      env[key] = value;
    }

    return { env };
  }

  /**
   * @param {ServerDefinition} server Server definition.
   * @param {object} headers Headers on a subsequent session request.
   * @param {Record<string, string>} expected Environment fixed at initialization.
   * @returns {void}
   * @throws {TenantEnvError} If a supplied header changes this session's environment.
   */
  assertSessionHeaders(server, headers, expected) {
    for (const key of server.envKeys) {
      const supplied = getHeaderValue(headers, headerNameForEnvKey(key));
      if (supplied !== undefined && supplied !== expected[key]) {
        throw new TenantEnvError('Session credential mismatch');
      }
    }
  }
}
