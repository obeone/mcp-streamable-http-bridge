import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigLoader } from '../../src/managers/ConfigLoader.js';

describe('ConfigLoader', () => {
  it('loads servers only from mcp.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cfg-'));
    await fs.writeFile(
      path.join(dir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          one: { command: 'node', args: [] },
          two: { command: 'python3', args: ['-m', 'x'] },
        },
      })
    );
    await fs.writeFile(
      path.join(dir, 'ssh-config.json'),
      JSON.stringify({ prod: { host: 'example.com', port: 22, username: 'u' } })
    );

    const defs = await new ConfigLoader().load(dir);
    assert.equal(defs.length, 2);
    const names = defs.map((d) => d.name).sort();
    assert.deepEqual(names, ['one', 'two']);
  });

  it('throws when mcp.json is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cfg-miss-'));
    await fs.writeFile(path.join(dir, 'ssh-config.json'), '{}');

    await assert.rejects(() => new ConfigLoader().load(dir), /Gateway config not found/);
  });
});
