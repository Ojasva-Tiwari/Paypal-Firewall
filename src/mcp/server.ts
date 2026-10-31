/**
 * PayGuard — Milestone M3: MCP Integration
 * M3-T2: MCP Server Skeleton (Streamable HTTP at /mcp) & Per-Session Isolation
 *
 * Implements:
 * - Express HTTP server exposing /mcp via official @modelcontextprotocol/sdk
 * - Per-session StreamableHTTPServerTransport and Server instance isolation
 * - Strict session ownership verification: binds each session to the authenticated agent
 * - Fail-closed tenant isolation: cross-agent session reuse returns HTTP 403 Forbidden
 * - Unknown or expired session IDs return HTTP 404 Not Found
 * - Suspended agents blocked even with existing active sessions
 * - Automatic session cleanup on close, delete, and idle expiry
 * - Exact canonical tool registry with 4 tools (Invariant I1)
 */

import * as crypto from 'node:crypto';
import http, { type Server as HttpServer } from 'node:http';
import express, { type Express } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { Database } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import { createRepositories } from '../db/repositories.js';
import type { PayPalOrdersService } from '../paypal/orders.js';
import type { PayPalAuthorizationsService } from '../paypal/authorizations.js';
import { createAuthMiddleware, getAuthenticatedAgent } from './auth.js';
import { AgentRateLimiter, createRateLimitMiddleware } from './rateLimiter.js';
import { createAuthRouter } from '../api/auth.js';
import { createOwnerApiRouter } from '../api/owner.js';
import { createApprovalRouter } from '../approvals/routes.js';
import { HoldExpiryWorker } from '../approvals/expiry.js';
import { ReconcilerWorker } from '../paypal/reconcile.js';
import { OwnerSessionStore, LoginRateLimiter } from '../auth/owner.js';
import {
  handleRequestPayment,
  handleGetPaymentStatus,
  handleGetBudget,
  handleListVendors,
} from './tools.js';

// ============================================================================
// Canonical Tool Constants & Metadata
// ============================================================================

export const CANONICAL_TOOL_NAMES = [
  'request_payment',
  'get_payment_status',
  'get_budget',
  'list_vendors',
] as const;

export type CanonicalToolName = (typeof CANONICAL_TOOL_NAMES)[number];

export const FORBIDDEN_TOOL_KEYWORDS = [
  'approve',
  'capture',
  'void',
  'refund',
  'credential',
  'paypal',
  'token',
  'admin',
  'secret',
] as const;

export const TOOL_DEFINITIONS: readonly Tool[] = [
  {
    name: 'request_payment',
    description:
      'Request a commercial payment through the PayGuard policy firewall. Evaluated deterministically against budgets and policies. DENIED decisions are final; do not retry with altered details. HELD payments are placed on hold awaiting human review and approval; check status using get_payment_status rather than resubmitting with altered details.',
    inputSchema: {
      type: 'object',
      properties: {
        vendor_id: {
          type: 'string',
          description: 'Canonical vendor identifier obtained from list_vendors.',
        },
        amount: {
          type: 'string',
          description: 'Payment amount as a decimal string (e.g. "12.00"). Up to 2 decimal places.',
        },
        currency: {
          type: 'string',
          description: 'Three-letter ISO uppercase currency code (e.g. "USD").',
        },
        purpose: {
          type: 'string',
          description: 'Commercial purpose or memo for this payment request (max 200 chars).',
        },
        category: {
          type: 'string',
          description: 'Optional commercial spend category (e.g. "cloud", "saas").',
        },
        idempotency_key: {
          type: 'string',
          description: 'Unique client-supplied idempotency key (8-64 alphanumeric characters).',
        },
        source_context: {
          type: 'string',
          description: 'Optional invoice excerpt or context that prompted this request (max 2000 chars).',
        },
      },
      required: ['vendor_id', 'amount', 'currency', 'purpose', 'idempotency_key'],
    },
  },
  {
    name: 'get_payment_status',
    description:
      'Retrieve the status, policy decision, and timestamp audit trail for a previously submitted payment request.',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: {
          type: 'string',
          description: 'The canonical PayGuard request_id returned by request_payment.',
        },
      },
      required: ['request_id'],
    },
  },
  {
    name: 'get_budget',
    description:
      'Query the remaining rolling 24-hour daily budget commitments and allowed currencies for the authenticated agent.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_vendors',
    description:
      'List commercial vendors registered in the PayGuard firewall. Returns both ACTIVE (verified/approved) and UNVERIFIED (unverified/pending review) vendors. BLOCKED vendors are excluded. Payments to UNVERIFIED vendors trigger a mandatory human approval hold.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ============================================================================
// Session Types & Registry
// ============================================================================

export interface ActiveSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly server: Server;
  readonly transport: StreamableHTTPServerTransport;
  readonly createdAt: number;
  lastAccessedAt: number;
}

export interface McpServerOptions {
  readonly db: Database;
  readonly repos?: Repositories;
  readonly port?: number;
  readonly sessionIdleTimeoutMs?: number; // default: 15 minutes
  readonly ordersService?: PayPalOrdersService;
  readonly authorizationsService?: PayPalAuthorizationsService;
  readonly defaultVaultTokenId?: string;
  readonly maxRequestsPerMinute?: number; // default: 30
  readonly rateLimitWindowMs?: number;    // default: 60,000 (1 minute)
  readonly rateLimiter?: AgentRateLimiter;
  readonly ownerSessionStore?: OwnerSessionStore;
  readonly loginRateLimiter?: LoginRateLimiter;
  readonly secureCookie?: boolean;
  readonly logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
  };
  readonly holdExpiryWorkerIntervalMs?: number; // default: 30,000 (30s)
  readonly reconcilerWorkerIntervalMs?: number; // default: 60,000 (60s)
}

export interface PayGuardMcpServerInstance {
  readonly app: Express;
  readonly start: (port?: number) => Promise<{ port: number; close: () => Promise<void> }>;
  readonly close: () => Promise<void>;
  readonly getRegisteredTools: () => readonly Tool[];
  readonly getActiveSessionCount: () => number;
  readonly getSession: (sessionId: string) => { sessionId: string; agentId: string } | undefined;
  readonly cleanupExpiredSessions: (maxIdleAgeMs?: number) => void;
  readonly rateLimiter: AgentRateLimiter;
  readonly ownerSessionStore: OwnerSessionStore;
  readonly loginRateLimiter: LoginRateLimiter;
  readonly holdExpiryWorker: HoldExpiryWorker;
  readonly reconcilerWorker: ReconcilerWorker;
}

// ============================================================================
// Server Factory with Per-Session Isolation
// ============================================================================

/**
 * Creates and configures the PayGuard MCP Server with strict per-session transport isolation.
 */
export function createPayGuardMcpServer(options: McpServerOptions): PayGuardMcpServerInstance {
  const db = options.db;
  const repos = options.repos ?? createRepositories(db);
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 15 * 60 * 1000;
  const rateLimiter =
    options.rateLimiter ??
    new AgentRateLimiter({
      maxRequests: options.maxRequestsPerMinute ?? 30,
      windowMs: options.rateLimitWindowMs ?? 60_000,
    });

  // Session Registry: maps sessionId -> ActiveSession
  const sessionRegistry = new Map<string, ActiveSession>();

  /**
   * Factory function that provisions a dedicated Server and Transport instance for a new session.
   */
  function createSessionForAgent(sessionId: string, agentId: string): ActiveSession {
    const server = new Server(
      {
        name: 'payguard',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Invariant I1: Registered tools are strictly the canonical 4 tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: TOOL_DEFINITIONS as Tool[],
      };
    });

    // CallTool handler with canonical tool dispatch
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: toolArgs } = request.params;
      if (!CANONICAL_TOOL_NAMES.includes(name as CanonicalToolName)) {
        return {
          content: [{ type: 'text', text: `Unknown or unauthorized tool: ${name}` }],
          isError: true,
        };
      }

      switch (name) {
        case 'request_payment':
          return await handleRequestPayment(db, toolArgs, repos, {
            ordersService: options.ordersService,
            authorizationsService: options.authorizationsService,
            defaultVaultTokenId: options.defaultVaultTokenId,
          });
        case 'get_payment_status':
          return await handleGetPaymentStatus(db, toolArgs, repos);
        case 'get_budget':
          return await handleGetBudget(db, toolArgs, repos);
        case 'list_vendors':
          return await handleListVendors(db, toolArgs, repos);
        default:
          return {
            content: [{ type: 'text', text: `Tool handler not implemented: ${name}` }],
            isError: true,
          };
      }
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
    });

    void server.connect(transport);

    const now = Date.now();
    const session: ActiveSession = {
      sessionId,
      agentId,
      server,
      transport,
      createdAt: now,
      lastAccessedAt: now,
    };

    sessionRegistry.set(sessionId, session);

    // Automatic cleanup when transport closes
    transport.onclose = () => {
      sessionRegistry.delete(sessionId);
      void server.close();
    };

    return session;
  }

  /**
   * Evicts and closes sessions that have exceeded the idle timeout.
   */
  function cleanupExpiredSessions(maxIdleAgeMs = sessionIdleTimeoutMs): void {
    const now = Date.now();
    for (const [sessionId, session] of sessionRegistry.entries()) {
      if (now - session.lastAccessedAt >= maxIdleAgeMs) {
        sessionRegistry.delete(sessionId);
        void session.transport.close();
        void session.server.close();
      }
    }
  }

  // Express HTTP Application
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Handle payload too large or invalid JSON errors without exposing internals
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && typeof err === 'object' && ('type' in err || 'status' in err || 'statusCode' in err)) {
      const errorObj = err as { type?: string; status?: number; statusCode?: number };
      if (errorObj.type === 'entity.too.large' || errorObj.status === 413 || errorObj.statusCode === 413) {
        res.status(413).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Payload Too Large: Request body exceeds maximum allowed size of 64KB',
          },
          id: null,
        });
        return;
      }
      if (errorObj.status === 400 || errorObj.statusCode === 400) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32700,
            message: 'Parse Error: Invalid JSON in request body',
          },
          id: null,
        });
        return;
      }
    }
    next(err);
  });

  // Public Health Endpoint
  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'payguard-mcp',
      tools: CANONICAL_TOOL_NAMES.length,
    });
  });

  // Owner Authentication Router (/api/login, /api/logout, /api/session)
  const ownerSessionStore = options.ownerSessionStore ?? new OwnerSessionStore();
  const loginRateLimiter = options.loginRateLimiter ?? new LoginRateLimiter();
  const authRouter = createAuthRouter({
    db,
    repos,
    sessionStore: ownerSessionStore,
    loginRateLimiter,
    secureCookie: options.secureCookie,
  });
  app.use('/api', authRouter);

  // Owner Dashboard REST API (/api/overview, /api/requests, /api/policies, etc.)
  const ownerApiRouter = createOwnerApiRouter({
    db,
    repos,
    sessionStore: ownerSessionStore,
    authorizationsService: options.authorizationsService,
    ordersService: options.ordersService,
    logger: options.logger,
  });
  app.use('/api', ownerApiRouter);

  // Approval Router (/a/:token, /a/:token/approve, /a/:token/void)
  const approvalRouter = createApprovalRouter({
    db,
    repos,
    sessionStore: ownerSessionStore,
    authorizationsService: options.authorizationsService,
    ordersService: options.ordersService,
    logger: options.logger,
  });
  app.use('/a', approvalRouter);

  // Background Workers: HoldExpiryWorker (30s) & ReconcilerWorker (60s)
  const holdExpiryWorker = new HoldExpiryWorker({
    db,
    repos,
    authorizationsService: options.authorizationsService,
    intervalMs: options.holdExpiryWorkerIntervalMs ?? 30_000,
    logger: options.logger,
  });

  const reconcilerWorker = new ReconcilerWorker({
    db,
    repos,
    ordersService: options.ordersService,
    authorizationsService: options.authorizationsService,
    intervalMs: options.reconcilerWorkerIntervalMs ?? 60_000,
    logger: options.logger,
  });

  // Authenticated MCP Endpoint & Rate Limiting
  const authMiddleware = createAuthMiddleware(db, repos);
  const rateLimitMiddleware = createRateLimitMiddleware(rateLimiter);
  app.use('/mcp', authMiddleware);
  app.use('/mcp', rateLimitMiddleware);

  app.all('/mcp', async (req, res) => {
    try {
      const { agentId } = getAuthenticatedAgent();
      const rawSessionHeader = req.headers['mcp-session-id'];
      const incomingSessionId = typeof rawSessionHeader === 'string' ? rawSessionHeader.trim() : undefined;

      let session: ActiveSession;

      if (incomingSessionId) {
        // Request on an existing session: verify existence and ownership
        const existingSession = sessionRegistry.get(incomingSessionId);

        if (!existingSession) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: 'Not Found: Session not found or expired',
            },
            id: null,
          });
          return;
        }

        // Security check: tenant isolation — verify session belongs to authenticated agent
        if (existingSession.agentId !== agentId) {
          res.status(403).json({
            jsonrpc: '2.0',
            error: {
              code: -32003,
              message: 'Forbidden: Session belongs to another agent',
            },
            id: null,
          });
          return;
        }

        session = existingSession;
        session.lastAccessedAt = Date.now();
      } else {
        // Initialization request: create an independent session and transport pair
        const newSessionId = crypto.randomUUID();
        session = createSessionForAgent(newSessionId, agentId);
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (err: unknown) {
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : 'Internal MCP transport error';
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: msg },
          id: null,
        });
      }
    }
  });

  let activeHttpServer: HttpServer | null = null;

  const start = async (port = options.port ?? 0): Promise<{ port: number; close: () => Promise<void> }> => {
    if (activeHttpServer) {
      const addr = activeHttpServer.address();
      const resolvedPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      return {
        port: resolvedPort,
        close: async () => {
          await close();
        },
      };
    }

    return new Promise((resolve, reject) => {
      let isSettled = false;
      try {
        const httpServer = http.createServer(app);

        httpServer.on('error', (err) => {
          if (isSettled) return;
          isSettled = true;
          holdExpiryWorker.stop();
          reconcilerWorker.stop();
          reject(err);
        });

        httpServer.listen(port, () => {
          if (isSettled) return;
          isSettled = true;
          activeHttpServer = httpServer;
          try {
            holdExpiryWorker.start();
            reconcilerWorker.start();
            const addr = httpServer.address();
            const resolvedPort = typeof addr === 'object' && addr !== null ? addr.port : port;
            resolve({
              port: resolvedPort,
              close: async () => {
                await close();
              },
            });
          } catch (startupErr) {
            holdExpiryWorker.stop();
            reconcilerWorker.stop();
            httpServer.close(() => {
              activeHttpServer = null;
              reject(startupErr);
            });
          }
        });
      } catch (err) {
        if (!isSettled) {
          isSettled = true;
          holdExpiryWorker.stop();
          reconcilerWorker.stop();
          reject(err);
        }
      }
    });
  };

  const close = async (): Promise<void> => {
    holdExpiryWorker.stop();
    reconcilerWorker.stop();

    if (activeHttpServer) {
      const serverToClose = activeHttpServer;
      activeHttpServer = null;
      await new Promise<void>((resolve, reject) => {
        serverToClose.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    // Clean up all active transports and server instances
    for (const session of sessionRegistry.values()) {
      try {
        await session.transport.close();
      } catch {
        // ignore errors during shutdown
      }
      try {
        await session.server.close();
      } catch {
        // ignore errors during shutdown
      }
    }
    sessionRegistry.clear();
  };

  return {
    app,
    start,
    close,
    getRegisteredTools: () => TOOL_DEFINITIONS,
    getActiveSessionCount: () => sessionRegistry.size,
    getSession: (sessionId: string) => {
      const s = sessionRegistry.get(sessionId);
      return s ? { sessionId: s.sessionId, agentId: s.agentId } : undefined;
    },
    cleanupExpiredSessions,
    rateLimiter,
    ownerSessionStore,
    loginRateLimiter,
    holdExpiryWorker,
    reconcilerWorker,
  };
}
