import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatLogBracket,
  formatLogSuffix,
  formatPrettyLogLine,
  shouldDemoteChildStderrToDebug,
} from '../../src/utils/logFormat.js';

describe('logFormat', () => {
  it('formatLogBracket includes server for instance, HTTP, and pool components', () => {
    assert.equal(formatLogBracket('McpServerInstance', 'weather'), '[McpServerInstance:weather]');
    assert.equal(formatLogBracket('StreamableHttpHandler', 'weather'), '[StreamableHttpHandler:weather]');
    assert.equal(formatLogBracket('InstancePool', 'weather'), '[InstancePool:weather]');
    assert.equal(formatLogBracket('Gateway', undefined), '[Gateway]');
  });

  it('formatLogSuffix orders tenant, session, pid', () => {
    assert.equal(
      formatLogSuffix({ instanceKeyPrefix: 'fb12fca0', sessionId: 'e6bfd9c1', pid: 28780 }),
      ' (tenant=fb12fca0, session=e6bfd9c1, pid=28780)'
    );
    assert.equal(formatLogSuffix({}), '');
  });

  it('formatPrettyLogLine matches contract', () => {
    const line = formatPrettyLogLine({
      timestamp: '2026-07-19T08:43:59.191Z',
      level: 'info',
      message: 'New HTTP session for server weather',
      component: 'StreamableHttpHandler',
      server: 'weather',
      instanceKeyPrefix: 'fb12fca0',
      sessionId: 'e6bfd9c1',
    });
    assert.equal(
      line,
      '2026-07-19T08:43:59.191Z [StreamableHttpHandler:weather] info: New HTTP session for server weather (tenant=fb12fca0, session=e6bfd9c1)'
    );
  });

  it('shouldDemoteChildStderrToDebug demotes known noisy lines at info', () => {
    assert.equal(shouldDemoteChildStderrToDebug('[ToolConfig] Enabled tools (6): a', { logLevel: 'info' }), true);
    assert.equal(
      shouldDemoteChildStderrToDebug('Geocoding successful via Nominatim: 2 result(s)', { logLevel: 'info' }),
      false
    );
  });

  it('shouldDemoteChildStderrToDebug keeps noisy lines when LOG_LEVEL is debug', () => {
    assert.equal(shouldDemoteChildStderrToDebug('[ToolConfig] Enabled tools (6): a', { logLevel: 'debug' }), false);
  });
});
