import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigLoader } from '../../src/managers/ConfigLoader.js';

describe('ConfigLoader', () => {
  it('merges servers from multiple files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cfg-'));
    await fs.writeFile(
      path.join(dir, 'a.json'),
      JSON.stringify({ mcpServers: { one: { command: 'node', args: [] } } })
    );
    await fs.writeFile(
      path.join(dir, 'b.json'),
      JSON.stringify({ mcpServers: { two: { command: 'python3', args: ['-m', 'x'] } } })
    );

    const defs = await new ConfigLoader().load(dir);
    assert.equal(defs.length, 2);
    const names = defs.map((d) => d.name).sort();
    assert.deepEqual(names, ['one', 'two']);
  });

  it('throws on duplicate server names', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cfg-dup-'));
    await fs.writeFile(
      path.join(dir, 'a.json'),
      JSON.stringify({ mcpServers: { dup: { command: 'node', args: [] } } })
    );
    await fs.writeFile(
      path.join(dir, 'b.json'),
      JSON.stringify({ mcpServers: { dup: { command: 'node', args: ['x'] } } })
    );

    await assert.rejects(() => new ConfigLoader().load(dir), /Duplicate MCP server name/);
  });
});
