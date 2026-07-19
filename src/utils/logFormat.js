const BRACKET_WITH_SERVER = new Set([
  'McpServerInstance',
  'StreamableHttpHandler',
  'InstancePool',
]);

const PRETTY_META_KEYS = new Set([
  'component',
  'server',
  'tenant',
  'instanceKeyPrefix',
  'session',
  'sessionId',
  'pid',
  'level',
  'message',
  'timestamp',
  'splat',
  'stack',
]);

/**
 * @param {string | undefined} component
 * @param {string | undefined} server
 */
export function formatLogBracket(component, server) {
  const base = component ?? 'Gateway';
  if (server && BRACKET_WITH_SERVER.has(base)) {
    return `[${base}:${server}]`;
  }
  return `[${base}]`;
}

/**
 * @param {Record<string, unknown>} meta
 */
export function formatLogSuffix(meta) {
  /** @type {string[]} */
  const parts = [];
  const tenant = meta.tenant ?? meta.instanceKeyPrefix;
  const session = meta.sessionId ?? meta.session;
  const pid = meta.pid;

  if (tenant != null && tenant !== '') {
    parts.push(`tenant=${tenant}`);
  }
  if (session != null && session !== '') {
    parts.push(`session=${session}`);
  }
  if (pid != null && pid !== '') {
    parts.push(`pid=${pid}`);
  }

  return parts.length ? ` (${parts.join(', ')})` : '';
}

/**
 * @param {string} message
 * @param {Record<string, unknown>} meta
 */
export function formatPrettyLogLine({ timestamp, level, message, ...meta }) {
  const component = typeof meta.component === 'string' ? meta.component : undefined;
  const server = typeof meta.server === 'string' ? meta.server : undefined;
  const bracket = formatLogBracket(component, server);
  const suffix = formatLogSuffix(meta);
  return `${timestamp} ${bracket} ${level}: ${message}${suffix}`;
}

/**
 * @param {Record<string, unknown>} meta
 */
export function remainingMetaForDebug(meta) {
  /** @type {Record<string, unknown>} */
  const rest = {};
  for (const [key, value] of Object.entries(meta)) {
    if (PRETTY_META_KEYS.has(key)) continue;
    if (value === undefined) continue;
    rest[key] = value;
  }
  return rest;
}

const DEBUG_LOG_LEVELS = new Set(['debug', 'verbose', 'silly']);

/**
 * @param {string} [logLevel]
 */
function isDebugLogLevel(logLevel = process.env.LOG_LEVEL ?? 'info') {
  return DEBUG_LOG_LEVELS.has(String(logLevel).toLowerCase());
}

/** @param {string} message @param {{ logLevel?: string }} [options] */
export function shouldDemoteChildStderrToDebug(message, options = {}) {
  if (isDebugLogLevel(options.logLevel)) {
    return false;
  }
  const m = message.trim();
  if (/^\[ToolConfig\]/i.test(m)) return true;
  if (/^Enabled tools\b/i.test(m)) return true;
  if (/Analytics disabled/i.test(m)) return true;
  if (/^Version check\b/i.test(m)) return true;
  if (/MCP Server started/i.test(m)) return true;
  return false;
}
