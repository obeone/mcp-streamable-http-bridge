const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'TZ', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
];
const DANGEROUS_HEADER_ENV = /^(?:PATH|HOME|TMPDIR|TMP|TEMP|USER|LOGNAME|SHELL|ENV|BASH_ENV|IFS|COMSPEC|PATHEXT|SYSTEMROOT|WINDIR|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|PYTHON.*|NPM_CONFIG_.*)$/i;

/**
 * @param {string} key Header-controlled environment name.
 * @returns {void}
 * @throws {Error} If the variable controls executable lookup or runtime loading.
 */
export function validateHeaderEnvKey(key) {
  if (DANGEROUS_HEADER_ENV.test(key)) {
    throw new Error(`Environment variable ${key} must not be controlled by an HTTP header`);
  }
}

/**
 * @param {Record<string, string>} configured Explicit administrator and tenant values.
 * @param {Record<string, string | undefined>} [parent] Parent environment.
 * @returns {Record<string, string>} Minimal environment for the child process.
 */
export function createChildEnvironment(configured, parent = process.env) {
  const env = Object.create(null);
  for (const key of SAFE_ENV_KEYS) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  return Object.assign(env, configured);
}
