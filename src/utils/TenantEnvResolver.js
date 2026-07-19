import crypto from 'node:crypto';
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
    const env = {};

    for (const key of server.envKeys) {
      const headerName = headerNameForEnvKey(key);
      const fromHeader = getHeaderValue(headers, headerName);
      const fromConfig = server.staticEnv[key];
      const value = fromHeader !== undefined ? fromHeader : fromConfig;

      if (value === undefined || value === '') {
        throw new TenantEnvError(
          `Missing value for env "${key}" (provide header ${headerName} or config default)`
        );
      }
      env[key] = value;
    }

    const instanceKey = this.#hashInstanceKey(server.name, env);
    return {
      env,
      instanceKey,
      instanceKeyPrefix: instanceKey.slice(0, 8),
    };
  }

  /**
   * @param {string} serverName
   * @param {Record<string, string>} env
   */
  #hashInstanceKey(serverName, env) {
    const canonical = Object.keys(env)
      .sort()
      .map((k) => `${k}=${env[k]}`)
      .join('\0');
    return crypto
      .createHash('sha256')
      .update(`${serverName}\0${canonical}`)
      .digest('hex');
  }
}
