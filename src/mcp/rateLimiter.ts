/**
 * PayGuard — Milestone M3: MCP Integration
 * M3-T2/M3-T3: Per-Agent Rate Limiter
 *
 * Implements:
 * - In-memory rolling sliding-window rate limiter per authenticated agent.
 * - Default: 30 requests per 60 seconds (PLAN.md Section 11).
 * - Thread-safe, pure in-memory tracking with automatic timestamp pruning.
 * - Rejects excess requests with HTTP 429 Too Many Requests.
 * - Standard rate limit response headers (Retry-After, X-RateLimit-Limit, etc.).
 *
 * Security Invariants:
 * - Rate limits are scoped strictly by authenticated agent identity (AsyncLocalStorage).
 * - Client-supplied identity cannot bypass or spoof rate limits.
 * - Prevents rapid-fire brute-force, denial-of-service, or policy bypass attempts.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getAuthenticatedAgent } from './auth.js';

export interface RateLimiterOptions {
  readonly maxRequests?: number; // default: 30
  readonly windowMs?: number;    // default: 60,000 (1 minute)
}

export interface RateLimitCheckResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetMs: number;
}

export class AgentRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  // Maps agentId -> Array of epoch timestamps (ms)
  private readonly requestHistories = new Map<string, number[]>();

  constructor(options?: RateLimiterOptions) {
    this.maxRequests = options?.maxRequests ?? 30;
    this.windowMs = options?.windowMs ?? 60_000;
  }

  /**
   * Evaluates the rate limit for an agent and records the request if permitted.
   */
  public check(agentId: string, now = Date.now()): RateLimitCheckResult {
    let history = this.requestHistories.get(agentId);
    if (!history) {
      history = [];
      this.requestHistories.set(agentId, history);
    }

    const cutoff = now - this.windowMs;
    // Prune entries outside the sliding window
    history = history.filter((ts) => ts > cutoff);
    this.requestHistories.set(agentId, history);

    if (history.length >= this.maxRequests) {
      // Oldest request in the current window determines cooldown
      const oldestInWindow = history[0] ?? now;
      const resetMs = Math.max(1000, oldestInWindow + this.windowMs - now);
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetMs,
      };
    }

    // Permitted: record current request timestamp
    history.push(now);
    const remaining = this.maxRequests - history.length;
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining,
      resetMs: this.windowMs,
    };
  }

  /**
   * Resets recorded history for a specific agent or all agents (useful in tests).
   */
  public reset(agentId?: string): void {
    if (agentId) {
      this.requestHistories.delete(agentId);
    } else {
      this.requestHistories.clear();
    }
  }

  /**
   * Returns current active tracked count for an agent.
   */
  public getCount(agentId: string, now = Date.now()): number {
    const history = this.requestHistories.get(agentId);
    if (!history) return 0;
    const cutoff = now - this.windowMs;
    return history.filter((ts) => ts > cutoff).length;
  }
}

/**
 * Express middleware that enforces per-agent rate limits on authenticated routes.
 */
export function createRateLimitMiddleware(rateLimiter: AgentRateLimiter): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    let agentId: string;
    try {
      const ctx = getAuthenticatedAgent();
      agentId = ctx.agentId;
    } catch {
      // If accessed before authentication, fail closed
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized: Authentication required before rate limit evaluation',
        },
        id: null,
      });
      return;
    }

    const result = rateLimiter.check(agentId);
    const resetSeconds = Math.ceil(result.resetMs / 1000);

    res.setHeader('X-RateLimit-Limit', result.limit.toString());
    res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + result.resetMs) / 1000).toString());

    if (!result.allowed) {
      res.setHeader('Retry-After', resetSeconds.toString());
      res.status(429).json({
        jsonrpc: '2.0',
        error: {
          code: -32005,
          message: `Too Many Requests: Rate limit exceeded (${result.limit} requests/minute). Please retry in ${resetSeconds} seconds.`,
        },
        id: null,
      });
      return;
    }

    next();
  };
}

