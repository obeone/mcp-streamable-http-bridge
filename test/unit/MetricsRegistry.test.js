import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry } from '../../src/utils/MetricsRegistry.js';

it('bounds client-controlled method and tool metric labels', async () => {
  const metrics = new MetricsRegistry({ maxToolLabels: 2 });
  for (let i = 0; i < 10; i++) {
    metrics.recordRpc('mock', `custom-${i}`, 0.01);
    metrics.recordRpc('mock', 'tools/call', 0.01, `tool-${i}`);
  }
  const body = await metrics.metricsText();
  assert.ok(!body.includes('custom-'));
  assert.ok(body.includes('mcp_method="other"'));
  const tools = await metrics.toolCalls.get();
  assert.equal(tools.values.length, 3);
});
