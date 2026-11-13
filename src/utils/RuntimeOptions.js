const DEFAULTS = {
  maxInstances: ['MCP_WRAPPER_MAX_INSTANCES', 100],
  maxSessions: ['MCP_WRAPPER_MAX_SESSIONS', 100],
  maxBodyBytes: ['MCP_WRAPPER_MAX_BODY_BYTES', 1024 * 1024],
  maxMessageBytes: ['MCP_WRAPPER_MAX_MESSAGE_BYTES', 1024 * 1024],
  maxPendingRequests: ['MCP_WRAPPER_MAX_PENDING_REQUESTS', 128],
  requestTimeoutMs: ['MCP_WRAPPER_REQUEST_TIMEOUT_MS', 30_000],
  maxSseStreamsPerSession: ['MCP_WRAPPER_MAX_SSE_STREAMS', 4],
};

/**
 * @param {object} [overrides] Explicit constructor settings, primarily for embedding.
 * @returns {object} Validated bounds and optional trusted identity header.
 * @throws {Error} If an option is invalid or disables a resource bound.
 */
export function readRuntimeOptions(overrides = {}) {
  const options = {};
  for (const [key, [envName, fallback]] of Object.entries(DEFAULTS)) {
    const value = Number(overrides[key] ?? process.env[envName] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${envName} must be a positive integer`);
    options[key] = value;
  }
  const header = overrides.trustedUserHeader ?? process.env.MCP_WRAPPER_TRUSTED_USER_HEADER ?? '';
  if (typeof header !== 'string' || (header && !/^[a-zA-Z0-9-]+$/.test(header))) {
    throw new Error('MCP_WRAPPER_TRUSTED_USER_HEADER must be an HTTP header name');
  }
  options.trustedUserHeader = header.toLowerCase();
  return options;
}
