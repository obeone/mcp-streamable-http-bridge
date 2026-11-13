import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TenantEnvResolver } from '../../src/utils/TenantEnvResolver.js';
import { TenantEnvError } from '../../src/utils/TenantEnvError.js';
import { ServerDefinition } from '../../src/managers/ServerDefinition.js';

describe('TenantEnvResolver', () => {
  const server = ServerDefinition.fromConfigEntry('grafana', {
    command: 'npx',
    args: [],
    headerEnv: ['GRAFANA_URL', 'GRAFANA_API_KEY'],
    env: {
      GRAFANA_URL: 'https://default.example.com',
      GRAFANA_API_KEY: '',
    },
  });

  const resolver = new TenantEnvResolver();

  it('uses config default when header absent', () => {
    const { env, instanceKey } = resolver.resolve(server, {
      'x-grafana_api_key': 'secret',
    });
    assert.equal(env.GRAFANA_URL, 'https://default.example.com');
    assert.equal(env.GRAFANA_API_KEY, 'secret');
    assert.ok(instanceKey.length === 64);
  });

  it('header overrides config default', () => {
    const a = resolver.resolve(server, {
      'x-GRAFANA_URL': 'https://a.example.com',
      'x-GRAFANA_API_KEY': 'k1',
    });
    const b = resolver.resolve(server, {
      'x-GRAFANA_URL': 'https://b.example.com',
      'x-GRAFANA_API_KEY': 'k1',
    });
    assert.notEqual(a.instanceKey, b.instanceKey);
  });

  it('hash is stable for same inputs', () => {
    const headers = {
      'x-GRAFANA_URL': 'https://x.example.com',
      'x-GRAFANA_API_KEY': 'k',
    };
    const r1 = resolver.resolve(server, headers);
    const r2 = resolver.resolve(server, headers);
    assert.equal(r1.instanceKey, r2.instanceKey);
  });

  it('throws when required env missing', () => {
    assert.throws(
      () => resolver.resolve(server, { 'x-GRAFANA_URL': 'https://only-url.example.com' }),
      TenantEnvError
    );
  });
});
