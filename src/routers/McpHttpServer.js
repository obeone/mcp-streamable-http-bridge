import http from 'node:http';
import { StreamableHttpHandler } from './StreamableHttpHandler.js';
import { McpCatalogMarkdown } from './McpCatalogMarkdown.js';
import { McpCatalogHtml, wantsMarkdownCatalog } from './McpCatalogHtml.js';
import { METRICS_PATH } from '../paths.js';

/**
 * @typedef {import('../managers/ServerRegistry.js').ServerRegistry} ServerRegistry
 * @typedef {import('../utils/MetricsRegistry.js').MetricsRegistry} MetricsRegistry
 * @typedef {import('../types.js').IncomingMessage} IncomingMessage
 * @typedef {import('../types.js').ServerResponse} ServerResponse
 *
 * @typedef {Object} McpHttpServerDeps
 * @property {StreamableHttpHandler} streamableHandler
 * @property {ServerRegistry} registry
 * @property {MetricsRegistry} metrics
 */

export class McpHttpServer {
  /** @param {McpHttpServerDeps} deps */
  constructor({ streamableHandler, registry, metrics }) {
    this.streamableHandler = streamableHandler;
    this.registry = registry;
    this.metrics = metrics;
    /** @type {http.Server | null} */
    this.server = null;
    this.catalogMarkdown = new McpCatalogMarkdown();
    this.catalogHtml = new McpCatalogHtml();
  }

  /** @param {number} port */
  listen(port) {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /** @returns {Promise<void>} Bounded HTTP shutdown, including lingering sockets. */
  async stop() {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => server.closeAllConnections(), 5000);
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections();
    });
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  async handleRequest(req, res) {
    const url = req.url?.split('?')[0] ?? '';

    if (
      req.method === 'GET' &&
      (url === '/' || url === '' || url === '/catalog.md')
    ) {
      const host = req.headers.host;
      const hostStr = Array.isArray(host) ? host[0] : host;
      const markdown = this.catalogMarkdown.generate(this.registry, { hostHeader: hostStr });
      const route = url === '/catalog.md' ? '/catalog.md' : '/';

      if (wantsMarkdownCatalog(req, url)) {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        res.end(markdown);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.catalogHtml.render(markdown));
      }
      this.metrics.recordHttpRequest(route, 200);
      return;
    }

    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', servers: this.registry.size() }));
      this.metrics.recordHttpRequest('/health', 200);
      return;
    }

    if (req.method === 'GET' && url === METRICS_PATH) {
      const body = await this.metrics.metricsText();
      res.writeHead(200, { 'Content-Type': this.metrics.registry.contentType });
      res.end(body);
      this.metrics.recordHttpRequest('/metrics', 200);
      return;
    }

    const mcpMatch = url.match(/^\/mcp\/([^/]+)\/?$/);
    if (mcpMatch) {
      const serverName = decodeURIComponent(mcpMatch[1]);
      await this.streamableHandler.handle(req, res, serverName);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    this.metrics.recordHttpRequest('/other', 404);
  }
}
