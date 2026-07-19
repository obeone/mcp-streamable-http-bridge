import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTAINER_LOG_FILE_PATH,
  CONTAINER_MCP_CONFIG_DIR,
  resolveRuntimePaths,
} from '../../src/paths.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('resolveRuntimePaths', () => {
  it('uses repo config and logs when not in a container', () => {
    const paths = resolveRuntimePaths();
    assert.equal(paths.configDir, path.join(projectRoot, 'config'));
    assert.equal(paths.logFilePath, path.join(projectRoot, 'logs', 'mcp-wrapper.log'));
  });

  it('exports fixed container paths as constants', () => {
    assert.equal(CONTAINER_MCP_CONFIG_DIR, '/config');
    assert.equal(CONTAINER_LOG_FILE_PATH, '/app/logs/mcp-wrapper.log');
  });
});
