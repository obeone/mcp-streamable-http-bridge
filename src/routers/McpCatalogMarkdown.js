/**
 * @typedef {import('../managers/ServerRegistry.js').ServerRegistry} ServerRegistry
 * @typedef {import('../managers/ServerDefinition.js').ServerDefinition} ServerDefinition
 *
 * @typedef {Object} McpCatalogMarkdownOptions
 * @property {string} [baseUrl] PUBLIC_BASE_URL or explicit override
 * @property {string} [hostHeader] req Host header when baseUrl unset
 */

export class McpCatalogMarkdown {
  /**
   * @param {ServerRegistry} registry
   * @param {McpCatalogMarkdownOptions} [options]
   * @returns {string}
   */
  generate(registry, options = {}) {
    const base = this.#resolveBaseUrl(options);
    const idleMinutes = process.env.MCP_WRAPPER_IDLE_MINUTES ?? '15';
    const lines = [];

    lines.push('# mcp-streamable-http-bridge — server catalog');
    lines.push('');
    lines.push(
      'HTTP gateway for stdio MCP servers (Streamable HTTP). Tenant values are supplied via `x-<ENV>` headers.'
    );
    lines.push('');
    lines.push('## Endpoints');
    lines.push('');
    lines.push('| Path | Method | Description |');
    lines.push('|------|--------|-------------|');
    lines.push(`| \`${this.#path(base, '/')}\` | GET | HTML catalog (browser); \`Accept: text/markdown\` for raw |`);
    lines.push(`| \`${this.#path(base, '/catalog.md')}\` | GET | Raw Markdown catalog |`);
    lines.push(`| \`${this.#path(base, '/health')}\` | GET | Liveness JSON |`);
    lines.push(`| \`${this.#path(base, '/metrics')}\` | GET | Prometheus metrics |`);
    lines.push(
      `| \`${this.#path(base, '/mcp/{serverName}')}\` | POST | MCP JSON-RPC (Streamable HTTP) |`
    );
    lines.push(
      `| \`${this.#path(base, '/mcp/{serverName}')}\` | GET | SSE (\`Accept: text/event-stream\`, session header) |`
    );
    lines.push('');
    lines.push('## Streamable HTTP');
    lines.push('');
    lines.push(
      '1. **Initialize** — `POST /mcp/{serverName}` with JSON-RPC `initialize`, required `x-*` tenant headers, and `Content-Type: application/json`. Response includes **`mcp-session-id`**.'
    );
    lines.push(
      '2. **Call** — Further `POST` requests with **`mcp-session-id`** and one JSON-RPC message per request.'
    );
    lines.push(
      '3. **Stream** — Optional `GET /mcp/{serverName}` with `Accept: text/event-stream` and **`mcp-session-id`** for server notifications.'
    );
    lines.push('');
    lines.push('## Configured MCP servers');
    lines.push('');

    const names = registry.names().sort();
    if (names.length === 0) {
      lines.push('_No servers loaded._');
    } else {
      for (const name of names) {
        const server = registry.get(name);
        if (!server) continue;
        lines.push(`### ${name}`);
        lines.push('');
        lines.push(`- **MCP URL:** \`${this.#path(base, `/mcp/${encodeURIComponent(name)}`)}\``);
        lines.push('');
        lines.push('| Env variable | HTTP header | How to supply |');
        lines.push('|--------------|-------------|---------------|');
        for (const key of server.envKeys) {
          const header = `x-${key}`;
          const staticVal = server.staticEnv[key] ?? '';
          lines.push(`| \`${key}\` | \`${header}\` | ${this.#envSourceDescription(staticVal, server.headerEnv.includes(key))} |`);
        }
        lines.push('');
        lines.push('**Client `mcp.json` (Streamable HTTP)**');
        lines.push('');
        lines.push(
          'Point your MCP client at the gateway URL. Map each gateway `env` key to an `x-<KEY>` header (tenant values). The client handles MCP `initialize` and session headers.'
        );
        lines.push('');
        lines.push('```json');
        lines.push(this.#mcpClientConfigExample(base, name, server));
        lines.push('```');
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
    lines.push(
      `Idle subprocess eviction: **${idleMinutes}** minutes without MCP activity (\`MCP_WRAPPER_IDLE_MINUTES\`).`
    );
    lines.push('');
    lines.push('See the project README for full configuration and security notes.');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * @param {McpCatalogMarkdownOptions} options
   */
  #resolveBaseUrl(options) {
    const fromEnv = (options.baseUrl ?? process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/$/, '');
    if (fromEnv) return fromEnv;
    const host = options.hostHeader?.split(',')[0]?.trim();
    if (host && /^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::[0-9]+)?$/.test(host)) return `http://${host}`;
    return '';
  }

  /**
   * @param {string} base
   * @param {string} path
   */
  #path(base, path) {
    if (!base) return path;
    return `${base}${path}`;
  }

  /** @param {string} value Configured default. @param {boolean} overridable Header policy. @returns {string} Value-free description. */
  #envSourceDescription(value, overridable) {
    if (!overridable) return 'Fixed administrator value (header override disabled)';
    return value ? 'Header or config default (value hidden)' : 'Header required';
  }

  /**
   * @param {string} base
   * @param {string} serverName
   * @param {ServerDefinition} server
   */
  #mcpClientConfigExample(base, serverName, server) {
    const url = this.#path(base, `/mcp/${encodeURIComponent(serverName)}`);
    /** @type {Record<string, string>} */
    const headers = {};
    for (const key of server.headerEnv) {
      headers[`x-${key}`] = `<your-${key.toLowerCase().replace(/_/g, '-')}>`;
    }
    const entry = { url };
    if (Object.keys(headers).length > 0) {
      entry.headers = headers;
    }
    return JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 2);
  }
}
