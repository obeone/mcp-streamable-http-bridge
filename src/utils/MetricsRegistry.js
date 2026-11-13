import client from 'prom-client';

const RPC_METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'resources/subscribe', 'resources/unsubscribe', 'prompts/list', 'prompts/get', 'completion/complete', 'logging/setLevel', 'notifications/initialized', 'notifications/cancelled']);

export class MetricsRegistry {
  constructor({ maxToolLabels = 256 } = {}) {
    this.toolLabels = new Set();
    this.maxToolLabels = maxToolLabels;
    this.registry = new client.Registry();
    client.collectDefaultMetrics({ register: this.registry });

    this.serversConfigured = new client.Gauge({
      name: 'mcp_servers_configured',
      help: 'Number of MCP servers loaded from config',
      registers: [this.registry],
    });

    this.instancesActive = new client.Gauge({
      name: 'mcp_instances_active',
      help: 'Active stdio MCP subprocess instances',
      labelNames: ['server'],
      registers: [this.registry],
    });

    this.httpRequests = new client.Counter({
      name: 'mcp_http_requests_total',
      help: 'HTTP requests to the wrapper',
      labelNames: ['route', 'status_class'],
      registers: [this.registry],
    });

    this.rpcRequests = new client.Counter({
      name: 'mcp_rpc_requests_total',
      help: 'MCP JSON-RPC requests forwarded to stdio servers',
      labelNames: ['server', 'mcp_method'],
      registers: [this.registry],
    });

    this.rpcDuration = new client.Histogram({
      name: 'mcp_rpc_duration_seconds',
      help: 'Duration of MCP JSON-RPC calls',
      labelNames: ['server', 'mcp_method'],
      registers: [this.registry],
    });

    this.toolCalls = new client.Counter({
      name: 'mcp_tool_calls_total',
      help: 'MCP tools/call invocations',
      labelNames: ['server', 'tool'],
      registers: [this.registry],
    });
  }

  setServersConfigured(count) {
    this.serversConfigured.set(count);
  }

  /** @param {Record<string, number>} countsByServer */
  setInstancesActive(countsByServer) {
    this.instancesActive.reset();
    for (const [server, count] of Object.entries(countsByServer)) {
      this.instancesActive.set({ server }, count);
    }
  }

  /** @param {string} route */
  /** @param {number} statusCode */
  recordHttpRequest(route, statusCode) {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    this.httpRequests.inc({ route, status_class: statusClass });
  }

  /**
   * @param {string} server
   * @param {string} mcpMethod
   * @param {number} durationSeconds
   * @param {string} [toolName]
   */
  recordRpc(server, mcpMethod, durationSeconds, toolName) {
    mcpMethod = RPC_METHODS.has(mcpMethod) ? mcpMethod : 'other';
    this.rpcRequests.inc({ server, mcp_method: mcpMethod });
    this.rpcDuration.observe({ server, mcp_method: mcpMethod }, durationSeconds);
    if (mcpMethod === 'tools/call') {
      let tool = typeof toolName === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(toolName) ? toolName : 'unknown';
      const key = `${server}:${tool}`;
      if (!this.toolLabels.has(key) && this.toolLabels.size >= this.maxToolLabels) tool = 'other';
      else this.toolLabels.add(key);
      this.toolCalls.inc({ server, tool });
    }
  }

  async metricsText() {
    return this.registry.metrics();
  }
}
