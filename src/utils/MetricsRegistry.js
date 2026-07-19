import client from 'prom-client';

export class MetricsRegistry {
  constructor() {
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
    this.rpcRequests.inc({ server, mcp_method: mcpMethod });
    this.rpcDuration.observe({ server, mcp_method: mcpMethod }, durationSeconds);
    if (mcpMethod === 'tools/call') {
      this.toolCalls.inc({ server, tool: toolName || 'unknown' });
    }
  }

  async metricsText() {
    return this.registry.metrics();
  }
}
