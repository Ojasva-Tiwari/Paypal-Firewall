/**
 * PayGuard — Milestone M3: MCP Integration
 * M3-T1: Agent Authentication & Context Middleware
 *
 * Implements:
 * - Cryptographic API key generation (32 random bytes, SHA-256 hash)
 * - Raw keys are shown once to the operator and NEVER stored or logged
 * - Bearer authentication middleware for /mcp
 * - Fail-closed status enforcement: suspended agents rejected with 403 Forbidden
 * - Thread-safe request-scoped agent context via Node.js AsyncLocalStorage
 *
 * Security Invariants & Rules:
 * - AGENTS.md Hard Rule 2: Never commit or persist raw secrets.
 * - AGENTS.md Hard Rule 8: Fail closed on missing, invalid, or suspended credentials.
 * - PLAN.md Section 11 & Decision D9: Authorization: Bearer <agent key>.
 */

import * as crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Database } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import { createRepositories } from '../db/repositories.js';
import type { AgentRow } from '../db/types.js';

// ============================================================================
// Context & Types
// ============================================================================

export interface AuthenticatedAgentContext {
  readonly agentId: string;
  readonly agent: AgentRow;
}

export const agentContextStorage = new AsyncLocalStorage<AuthenticatedAgentContext>();

/**
 * Retrieves the currently authenticated agent context from AsyncLocalStorage.
 * Throws a fail-closed error if accessed outside an authenticated request lifecycle.
 */
export function getAuthenticatedAgent(): AuthenticatedAgentContext {
  const ctx = agentContextStorage.getStore();
  if (!ctx) {
    throw new Error('Security Error: No authenticated agent context available in current execution scope');
  }
  return ctx;
}

export interface GeneratedAgentKey {
  readonly rawKey: string;
  readonly keyHash: string;
}

export type AuthVerificationResult =
  | { readonly ok: true; readonly agent: AgentRow }
  | { readonly ok: false; readonly error: string; readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' };

// ============================================================================
// Cryptographic Key Helpers
// ============================================================================

/**
 * Computes the canonical SHA-256 hex digest of an API key string.
 */
export function hashApiKey(apiKey: string): string {
  if (!apiKey || typeof apiKey !== 'string') {
    return '';
  }
  return crypto.createHash('sha256').update(apiKey.trim(), 'utf8').digest('hex');
}

/**
 * Generates a new 32-byte cryptographically secure agent API key and its SHA-256 hash.
 */
export function generateAgentKey(): GeneratedAgentKey {
  const rawKey = crypto.randomBytes(32).toString('hex');
  const keyHash = hashApiKey(rawKey);
  return { rawKey, keyHash };
}

// ============================================================================
// Verification & Middleware
// ============================================================================

/**
 * Authoritatively verifies an API key against the database registry.
 * Fails closed on missing, invalid, or suspended agents.
 */
export function verifyAgentApiKey(
  db: Database,
  rawKey: string,
  repositories?: Repositories
): AuthVerificationResult {
  const trimmed = rawKey ? rawKey.trim() : '';
  if (!trimmed) {
    return { ok: false, error: 'Unauthorized: Missing agent API key', code: 'UNAUTHORIZED' };
  }

  const repos = repositories ?? createRepositories(db);
  const keyHash = hashApiKey(trimmed);
  const agent = repos.agents.getByApiKeyHash(keyHash);

  if (!agent) {
    return { ok: false, error: 'Unauthorized: Invalid agent API key', code: 'UNAUTHORIZED' };
  }

  if (agent.status !== 'ACTIVE') {
    return { ok: false, error: 'Forbidden: Agent account is suspended', code: 'FORBIDDEN' };
  }

  return { ok: true, agent };
}

/**
 * Express middleware that authenticates incoming requests to /mcp using Bearer tokens.
 * Injects the authenticated agent context into AsyncLocalStorage for all downstream handlers.
 */
export function createAuthMiddleware(
  db: Database,
  repositories?: Repositories
): RequestHandler {
  const repos = repositories ?? createRepositories(db);

  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || typeof authHeader !== 'string') {
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized: Missing Authorization header. Expected Bearer <agent_api_key>',
        },
        id: null,
      });
      return;
    }

    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (!match || !match[1]) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized: Malformed Authorization header. Expected Bearer <agent_api_key>',
        },
        id: null,
      });
      return;
    }

    const rawToken = match[1].trim();
    const result = verifyAgentApiKey(db, rawToken, repos);

    if (!result.ok) {
      const statusCode = result.code === 'FORBIDDEN' ? 403 : 401;
      const errorCode = result.code === 'FORBIDDEN' ? -32003 : -32001;
      res.status(statusCode).json({
        jsonrpc: '2.0',
        error: {
          code: errorCode,
          message: result.error,
        },
        id: null,
      });
      return;
    }

    // Bind authenticated agent context into AsyncLocalStorage for downstream tool execution
    const context: AuthenticatedAgentContext = {
      agentId: result.agent.id,
      agent: result.agent,
    };

    agentContextStorage.run(context, () => {
      next();
    });
  };
}

