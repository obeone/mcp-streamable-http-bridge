import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChildEnvironment } from '../../src/utils/ChildEnvironment.js';
import { ServerDefinition } from '../../src/managers/ServerDefinition.js';
import { TenantEnvResolver } from '../../src/utils/TenantEnvResolver.js';

const resolver = new TenantEnvResolver();

describe('Child environment boundaries', () => {
  it('inherits system paths without copying unrelated parent secrets', () => {
    const env = createChildEnvironment({ API_KEY: 'tenant' }, {
      PATH: '/bin', PARENT_SECRET: 'private', NODE_OPTIONS: '--require malicious.js',
    });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.API_KEY, 'tenant');
    assert.equal(env.PARENT_SECRET, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
  });

  it('keeps nonempty configured values fixed unless explicitly overridable', () => {
    const server = ServerDefinition.fromConfigEntry('api', {
      command: 'node', env: { API_URL: 'https://trusted.invalid', API_KEY: '' },
    });
    assert.throws(() => resolver.resolve(server, {
      'x-api_url': 'https://attacker.invalid', 'x-api_key': 'key',
    }), /fixed/);
    const { env } = resolver.resolve(server, { 'x-api_key': 'key' });
    assert.equal(env.API_URL, 'https://trusted.invalid');
  });

  it('rejects header mappings that can load code or replace system paths', () => {
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'PATH', 'LD_PRELOAD', 'PYTHONPATH', 'BASH_ENV']) {
      assert.throws(() => ServerDefinition.fromConfigEntry('unsafe', { command: 'node', env: { [key]: '' } }), /HTTP header/);
    }
  });

  it('rejects control characters without exposing the submitted value', () => {
    const server = ServerDefinition.fromConfigEntry('api', { command: 'node', env: { API_KEY: '' } });
    assert.throws(() => resolver.resolve(server, { 'x-api_key': 'private\0secret' }), /Invalid value/);
  });

  it('rejects conflicting credentials on existing sessions', () => {
    const server = ServerDefinition.fromConfigEntry('api', { command: 'node', env: { API_KEY: '' } });
    resolver.assertSessionHeaders(server, {}, { API_KEY: 'a' });
    assert.throws(() => resolver.assertSessionHeaders(server, { 'x-api_key': 'b' }, { API_KEY: 'a' }), /mismatch/);
  });
});
