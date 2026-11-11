/**
 * PayGuard — Milestone M6: Full-System QA and Reliability
 * M6-T2: Production Server Entrypoint & Process Lifecycle
 *
 * Implements:
 * - Standalone application entrypoint (src/server.ts)
 * - Strict environment and configuration validation prior to service initialization
 * - Single-instance database, migration runner, and HTTP/MCP service initialization
 * - Background workers (HoldExpiryWorker & ReconcilerWorker) started exactly once
 * - Partial startup failure handling with complete resource cleanup (no leaked DB/sockets)
 * - Idempotent graceful shutdown on SIGINT, SIGTERM, or stop() invocation
 * - Safe SQLite WAL checkpointing on shutdown
 * - Configurable Express trust proxy support (defaults to false)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type PayGuardConfig } from './config/index.js';
import { createDatabase, runMigrations, type Database } from './db/connection.js';
import { createRepositories, type Repositories } from './db/repositories.js';
import { TokenManager } from './paypal/tokenManager.js';
import { PayPalHttpClient } from './paypal/http.js';
import { PayPalOrdersService } from './paypal/orders.js';
import { PayPalAuthorizationsService } from './paypal/authorizations.js';
import {
  createPayGuardMcpServer,
  type PayGuardMcpServerInstance,
} from './mcp/server.js';
import { seedDemoDatabase } from '../demo/seed.js';

export interface StandaloneServerLogger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
  log?: (msg: string, ...args: unknown[]) => void;
}

export interface StandaloneServerOptions {
  readonly env?: Record<string, string | undefined>;
  readonly port?: number;
  readonly registerSignalHandlers?: boolean;
  readonly logger?: Partial<StandaloneServerLogger>;
}

export interface RunningServer {
  readonly config: PayGuardConfig;
  readonly db: Database;
  readonly repos: Repositories;
  readonly mcpServer: PayGuardMcpServerInstance;
  readonly port: number;
  readonly stop: () => Promise<void>;
}

/**
 * Initializes and starts the complete PayGuard standalone server.
 * Handles validation, single-instance initialization, worker lifecycle, and cleanup.
 */
export async function startServer(options: StandaloneServerOptions = {}): Promise<RunningServer> {
  const logger = {
    info: options.logger?.info ?? ((msg: string, ...args: unknown[]) => console.log(msg, ...args)),
    warn: options.logger?.warn ?? ((msg: string, ...args: unknown[]) => console.warn(msg, ...args)),
    error: options.logger?.error ?? ((msg: string, ...args: unknown[]) => console.error(msg, ...args)),
    log:
      options.logger?.log ??
      options.logger?.info ??
      ((msg: string, ...args: unknown[]) => console.log(msg, ...args)),
  };

  // 1. Validate configuration before initializing services (Requirement 3)
  const config = loadConfig(options.env ?? process.env);
  const targetPort = options.port ?? config.port;

  let db: Database | null = null;
  let mcpServer: PayGuardMcpServerInstance | null = null;
  let shutdownPromise: Promise<void> | null = null;

  try {
    logger.info(`[PayGuard] Starting server in ${config.nodeEnv} mode...`);

    // 2. Initialize database connection (Requirement 4)
    db = createDatabase({ path: config.databasePath });

    // 3. Run migrations exactly once (Requirement 4)
    const appliedCount = runMigrations(db);
    if (appliedCount > 0) {
      logger.info(`[PayGuard] Applied ${appliedCount} database migration(s).`);
    }

    // 4. Repositories
    const repos = createRepositories(db);

    // 5. Optional demo reseed on boot if configured
    if (config.reseedOnBoot) {
      logger.info('[PayGuard] RESEED_ON_BOOT=true: seeding demo records...');
      seedDemoDatabase(db, {
        repos,
        apiKey: config.demoAgentApiKey,
        vaultTokenId: config.vaultTokenId,
        logger,
      });
    }

    // 6. PayPal services initialization (conditional on credentials)
    let ordersService: PayPalOrdersService | undefined;
    let authorizationsService: PayPalAuthorizationsService | undefined;

    if (config.connectorAcmeClientId && config.connectorAcmeClientSecret) {
      logger.info('[PayGuard] Initializing PayPal Sandbox client with connector credentials.');
      const tokenManager = new TokenManager({
        baseUrl: config.paypalBaseUrl,
        credentialResolver: () => ({
          clientId: config.connectorAcmeClientId!,
          clientSecret: config.connectorAcmeClientSecret!,
        }),
      });

      const httpClient = new PayPalHttpClient({
        baseUrl: config.paypalBaseUrl,
        tokenManager,
        defaultConnectorKey: 'acme_cloud',
      });

      ordersService = new PayPalOrdersService({ client: httpClient });
      authorizationsService = new PayPalAuthorizationsService({ client: httpClient });
    } else {
      logger.warn(
        '[PayGuard] PayPal credentials not provided in environment. Remote capture execution disabled (local evaluation mode).'
      );
    }

    // 7. MCP Server instance creation (reusing existing factory & dependency injection) (Requirement 5)
    mcpServer = createPayGuardMcpServer({
      db,
      repos,
      ordersService,
      authorizationsService,
      defaultVaultTokenId: config.vaultTokenId,
      config,
      trustProxy: config.trustProxy,
      logger,
    });

    if (config.trustProxy === true && config.nodeEnv === 'production') {
      logger.warn(
        '[Security] Warning: TRUST_PROXY is set to true in production. This trusts all proxy headers and is vulnerable to IP spoofing. Prefer an explicit hop count (e.g. 1) or trusted CIDR matching your topology.'
      );
    }

    // 8. Start HTTP listener & background workers (HoldExpiryWorker & ReconcilerWorker) exactly once (Requirement 4 & 5)
    const serverResult = await mcpServer.start(targetPort);
    const resolvedPort = serverResult.port;

    logger.info(`[PayGuard] HTTP server listening on port ${resolvedPort}`);
    if (config.publicBaseUrl) {
      logger.info(`[PayGuard] Public base URL: ${config.publicBaseUrl}`);
    } else {
      logger.warn(
        '[PayGuard] PUBLIC_BASE_URL is not configured in production; dashboard links in notifications are disabled.'
      );
    }

    // 9. Idempotent graceful shutdown function (Requirement 7, 8, 9)
    const activeDb = db;
    const activeMcpServer = mcpServer;

    const stop = async (): Promise<void> => {
      if (shutdownPromise) {
        return shutdownPromise;
      }
      shutdownPromise = (async () => {
        logger.info('[PayGuard] Graceful shutdown initiated...');

        // Stop accepting new HTTP requests, drain connections, stop background workers, close MCP sessions
        try {
          await activeMcpServer.close();
        } catch (err) {
          logger.error('[PayGuard] Error during MCP server shutdown:', err);
        }

        // Safe SQLite WAL checkpoint and database closure (Requirement 8 & 9)
        try {
          if (activeDb.open) {
            const isMemory =
              config.databasePath === ':memory:' || config.databasePath.startsWith('file::memory:');
            if (!isMemory) {
              try {
                activeDb.pragma('wal_checkpoint(TRUNCATE)');
              } catch (walErr) {
                logger.warn('[PayGuard] WAL checkpoint warning:', walErr);
              }
            }
            activeDb.close();
          }
        } catch (err) {
          logger.error('[PayGuard] Error closing database connection:', err);
        }

        logger.info('[PayGuard] Graceful shutdown complete.');
      })();

      return shutdownPromise;
    };

    // 10. Signal handling (Requirement 7)
    let sigintHandler: (() => void) | undefined;
    let sigtermHandler: (() => void) | undefined;

    if (options.registerSignalHandlers !== false) {
      sigintHandler = () => {
        logger.info('[PayGuard] Caught SIGINT, initiating shutdown...');
        void stop()
          .then(() => {
            process.exit(0);
          })
          .catch((err) => {
            logger.error('[PayGuard] Fatal error during SIGINT shutdown:', err);
            process.exit(1);
          });
      };

      sigtermHandler = () => {
        logger.info('[PayGuard] Caught SIGTERM, initiating shutdown...');
        void stop()
          .then(() => {
            process.exit(0);
          })
          .catch((err) => {
            logger.error('[PayGuard] Fatal error during SIGTERM shutdown:', err);
            process.exit(1);
          });
      };

      process.on('SIGINT', sigintHandler);
      process.on('SIGTERM', sigtermHandler);
    }

    const wrappedStop = async (): Promise<void> => {
      if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
      if (sigtermHandler) process.removeListener('SIGTERM', sigtermHandler);
      await stop();
    };

    return {
      config,
      db: activeDb,
      repos,
      mcpServer: activeMcpServer,
      port: resolvedPort,
      stop: wrappedStop,
    };
  } catch (startupErr) {
    // 11. Partial startup failure handling with complete resource cleanup (Requirement 6)
    logger.error('[PayGuard] Startup failure detected, cleaning up resources:', startupErr);

    if (mcpServer) {
      try {
        await mcpServer.close();
      } catch (cleanupErr) {
        logger.error('[PayGuard] Error closing MCP server during startup failure cleanup:', cleanupErr);
      }
    }

    if (db && db.open) {
      try {
        const isMemory =
          config.databasePath === ':memory:' || config.databasePath.startsWith('file::memory:');
        if (!isMemory) {
          try {
            db.pragma('wal_checkpoint(TRUNCATE)');
          } catch {
            // Ignore checkpoint error during failure cleanup
          }
        }
        db.close();
      } catch (cleanupErr) {
        logger.error('[PayGuard] Error closing database during startup failure cleanup:', cleanupErr);
      }
    }

    throw startupErr;
  }
}

// ============================================================================
// Direct Execution Check
// ============================================================================

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    const invokedPath = path.resolve(process.argv[1]);
    return (
      currentFilePath === invokedPath ||
      invokedPath.endsWith('server.js') ||
      invokedPath.endsWith('server.ts')
    );
  } catch {
    return false;
  }
}

// Only auto-start when invoked directly via node CLI
if (isMain()) {
  startServer({ registerSignalHandlers: true }).catch((err) => {
    console.error('[PayGuard] Fatal startup error:', err);
    process.exit(1);
  });
}
