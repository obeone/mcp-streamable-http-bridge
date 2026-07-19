import fs from 'node:fs/promises';
import path from 'node:path';
import { GATEWAY_MCP_CONFIG_FILENAME } from '../paths.js';
import { ServerDefinition } from './ServerDefinition.js';

export class ConfigLoader {
  /**
   * @param {string} configDir
   * @returns {Promise<ServerDefinition[]>}
   */
  async load(configDir) {
    const file = path.join(configDir, GATEWAY_MCP_CONFIG_FILENAME);
    let parsed;
    try {
      const text = await fs.readFile(file, 'utf8');
      parsed = JSON.parse(text);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        throw new Error(
          `Gateway config not found: "${file}" (expected ${GATEWAY_MCP_CONFIG_FILENAME} in config directory)`
        );
      }
      throw new Error(`Failed to parse "${file}": ${err.message}`);
    }

    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') {
      throw new Error(`File "${file}" must contain "mcpServers" object`);
    }

    /** @type {ServerDefinition[]} */
    const defs = [];
    for (const [name, raw] of Object.entries(servers)) {
      defs.push(ServerDefinition.fromConfigEntry(name, raw));
    }
    return defs;
  }
}
