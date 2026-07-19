import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpCatalogMarkdown } from '../../src/routers/McpCatalogMarkdown.js';
import { ServerRegistry } from '../../src/managers/ServerRegistry.js';
import { ServerDefinition } from '../../src/managers/ServerDefinition.js';

describe('McpCatalogMarkdown', () => {
  const secretUrl = 'postgresql://user:password@localhost/dbname';
  const registry = new ServerRegistry([
    ServerDefinition.fromConfigEntry('my_postgres_db', {
      command: 'uvx',
      args: ['mcp-alchemy'],
      env: {
        API_TOKEN: '',
        DB_URL: secretUrl,
      },
    }),
  ]);

  const generator = new McpCatalogMarkdown();

  it('lists server, headers, and mcp path without leaking secrets', () => {
    const md = generator.generate(registry, {});
    assert.match(md, /my_postgres_db/);
    assert.match(md, /\/mcp\/my_postgres_db/);
    assert.match(md, /x-API_TOKEN/);
    assert.match(md, /x-DB_URL/);
    assert.doesNotMatch(md, /password@localhost/);
    assert.ok(!md.includes(secretUrl), 'must not leak DB_URL from config');
    assert.match(md, /Client `mcp\.json` \(Streamable HTTP\)/);
    assert.match(md, /"url": "\/mcp\/my_postgres_db"/);
    assert.doesNotMatch(md, /Example: initialize/);
  });

  it('uses PUBLIC_BASE_URL in examples when provided', () => {
    const md = generator.generate(registry, { baseUrl: 'https://example.com' });
    assert.match(md, /https:\/\/example\.com\/mcp\/my_postgres_db/);
    assert.match(md, /https:\/\/example\.com\/health/);
  });

  it('uses host header for absolute URLs when baseUrl unset', () => {
    const md = generator.generate(registry, { hostHeader: 'localhost:8080' });
    assert.match(md, /http:\/\/localhost:8080\/mcp\/my_postgres_db/);
  });
});
