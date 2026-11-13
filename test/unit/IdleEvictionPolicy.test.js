import { it } from 'node:test';
import assert from 'node:assert/strict';
import { IdleEvictionPolicy } from '../../src/managers/IdleEvictionPolicy.js';

it('can disable idle expiry explicitly while retaining a finite default', () => {
  const previous = process.env.MCP_WRAPPER_IDLE_MINUTES;
  try {
    const policy = new IdleEvictionPolicy();
    process.env.MCP_WRAPPER_IDLE_MINUTES = '0';
    assert.equal(policy.idleMs(), Infinity);
    process.env.MCP_WRAPPER_IDLE_MINUTES = '30';
    assert.equal(policy.idleMs(), 30 * 60 * 1000);
    delete process.env.MCP_WRAPPER_IDLE_MINUTES;
    assert.equal(policy.idleMs(), 15 * 60 * 1000);
  } finally {
    if (previous === undefined) delete process.env.MCP_WRAPPER_IDLE_MINUTES;
    else process.env.MCP_WRAPPER_IDLE_MINUTES = previous;
  }
});
