import { ConfigLoader } from './managers/ConfigLoader.js';
import { ServerRegistry } from './managers/ServerRegistry.js';
import { TenantEnvResolver } from './utils/TenantEnvResolver.js';
import { InstancePool } from './managers/InstancePool.js';
import { SessionStore } from './managers/SessionStore.js';
import { StreamableHttpHandler } from './routers/StreamableHttpHandler.js';
import { McpHttpServer } from './routers/McpHttpServer.js';
import { LoggerFactory } from './LoggerFactory.js';
import { MetricsRegistry } from './utils/MetricsRegistry.js';
import { resolveRuntimePaths } from './paths.js';
import { readRuntimeOptions } from './utils/RuntimeOptions.js';

/**
 * @typedef {import('./types.js').Logger} Logger
 * @typedef {import('./routers/StreamableHttpHandler.js').StreamableHttpHandler} StreamableHttpHandler
 *
 * @typedef {Object} McpWrapperApplicationOptions
 * @property {string} [configDir]
 * @property {string} [logFilePath]
 * @property {number} [port]
 */

export class McpWrapperApplication {
  /**
   * @param {McpWrapperApplicationOptions} [options]
   */
  constructor(options = {}) {
    const runtime = resolveRuntimePaths();
    this.configDir = options.configDir ?? runtime.configDir;
    this.logFilePath = options.logFilePath ?? runtime.logFilePath;
    this.port = options.port ?? Number(process.env.PORT ?? 8080);
    this.runtimeOptions = readRuntimeOptions(options.limits);
    /** @type {Logger | null} */
    this.logger = null;
    /** @type {InstancePool | null} */
    this.pool = null;
    /** @type {McpHttpServer | null} */
    this.httpServer = null;
    /** @type {NodeJS.Timeout | null} */
    this.evictionTimer = null;
  }

  async start() {
    this.logger = LoggerFactory.create({ logFilePath: this.logFilePath }).child({
      component: 'Gateway',
    });
    const metrics = new MetricsRegistry();

    const loader = new ConfigLoader();
    const definitions = await loader.load(this.configDir);
    const registry = new ServerRegistry(definitions);
    metrics.setServersConfigured(registry.size());
    metrics.setInstancesActive({});

    const serverNames = registry.names();
    this.logger.info(
      `Loaded MCP config from ${this.configDir}; ${serverNames.length} server(s): ${serverNames.join(', ') || '(none)'}`
    );

    const sessionStore = new SessionStore();
    const tenantResolver = new TenantEnvResolver();

    /** @type {StreamableHttpHandler | undefined} */
    let streamableHandler;
    this.pool = new InstancePool({
      logger: this.logger,
      metrics,
      maxInstances: this.runtimeOptions.maxInstances,
      onInstanceEvicted: (instanceKey) => {
        streamableHandler?.onInstanceEvicted(instanceKey);
      },
    });

    streamableHandler = new StreamableHttpHandler({
      registry,
      tenantResolver,
      pool: this.pool,
      sessionStore,
      metrics,
      logger: this.logger,
    });

    this.httpServer = new McpHttpServer({
      streamableHandler,
      registry,
      metrics,
    });

    await this.httpServer.listen(this.port);
    this.logger.info(`Listening for Streamable HTTP on port ${this.port}`);

    const intervalMs = 60_000;
    this.evictionTimer = setInterval(() => {
      this.pool
        ?.evictIdle()
        .catch((err) => this.logger.error(`Idle eviction run failed: ${err.message}`));
    }, intervalMs);
  }

  async stop() {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    this.httpServer?.streamableHandler.close();
    const httpStopped = this.httpServer?.stop();
    await this.pool?.closeAll();
    await httpStopped;
    this.logger?.info('Gateway stopped');
  }
}
