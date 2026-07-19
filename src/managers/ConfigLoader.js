import fs from 'node:fs/promises';
import path from 'node:path';
import { ServerDefinition } from './ServerDefinition.js';

export class ConfigLoader {
  /**
   * @param {string} configDir
   * @returns {Promise<ServerDefinition[]>}
   */
  async load(configDir) {
    let entries;
    try {
      entries = await fs.readdir(configDir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`Cannot read config directory "${configDir}": ${err.message}`);
    }

    const jsonFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => path.join(configDir, e.name));

    if (jsonFiles.length === 0) {
      throw new Error(`No .json config files found in "${configDir}"`);
    }

    /** @type {Map<string, { def: ServerDefinition, file: string }>} */
    const byName = new Map();

    for (const file of jsonFiles) {
      let parsed;
      try {
        const text = await fs.readFile(file, 'utf8');
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error(`Failed to parse "${file}": ${err.message}`);
      }

      const servers = parsed?.mcpServers;
      if (!servers || typeof servers !== 'object') {
        throw new Error(`File "${file}" must contain "mcpServers" object`);
      }

      for (const [name, raw] of Object.entries(servers)) {
        if (byName.has(name)) {
          const prev = byName.get(name);
          throw new Error(
            `Duplicate MCP server name "${name}" in "${file}" and "${prev.file}"`
          );
        }
        const def = ServerDefinition.fromConfigEntry(name, raw);
        byName.set(name, { def, file });
      }
    }

    return [...byName.values()].map((x) => x.def);
  }
}
