import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Paths used inside the container (Compose volume mounts). */
export const CONTAINER_MCP_CONFIG_DIR = '/config';
export const CONTAINER_LOG_FILE_PATH = '/app/logs/mcp-wrapper.log';
export const METRICS_PATH = '/metrics';
export const CATALOG_MARKDOWN_PATH = '/catalog.md';

/** @deprecated Use resolveRuntimePaths(); kept for tests referencing container paths. */
export const MCP_CONFIG_DIR = CONTAINER_MCP_CONFIG_DIR;
/** @deprecated Use resolveRuntimePaths(); kept for tests referencing container paths. */
export const LOG_FILE_PATH = CONTAINER_LOG_FILE_PATH;

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function isRunningInContainer() {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} RuntimePaths
 * @property {string} configDir
 * @property {string} logFilePath
 */

/** @returns {RuntimePaths} */
export function resolveRuntimePaths() {
  if (isRunningInContainer()) {
    return {
      configDir: CONTAINER_MCP_CONFIG_DIR,
      logFilePath: CONTAINER_LOG_FILE_PATH,
    };
  }
  return {
    configDir: path.join(projectRoot, 'config'),
    logFilePath: path.join(projectRoot, 'logs', 'mcp-wrapper.log'),
  };
}
