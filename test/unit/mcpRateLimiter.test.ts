/**
 * PayGuard — Milestone M3: MCP Integration
 * Unit Tests: Per-Agent Rate Limiter & Middleware
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { AgentRateLimiter, createRateLimitMiddleware } from '../../src/mcp/rateLimiter.js';
import { agentContextStorage } from '../../src/mcp/auth.js';
import type { AgentRow } from '../../src/db/types.js';
import { toMinorUnits } from '../../src/core/money.js';

describe('M3-T2: Per-Agent Rate Limiter & Middleware', () => {
  let rateLimiter: AgentRateLimiter;

  beforeEach(() => {
    rateLimiter = new AgentRateLimiter({
      maxRequests: 5,     // 5 requests per window for easy testing
      windowMs: 10_000,   // 10 second window
    });
  });

  it('1. Allows requests within the configured threshold', () => {
    const agentId = 'agent-1';
    const now = 1000000;

    for (let i = 1; i <= 5; i++) {
      const res = rateLimiter.check(agentId, now + i * 100);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(5 - i);
    }
  });

  it('2. Blocks requests exceeding the limit with accurate remaining time', () => {
    const agentId = 'agent-1';
    const now = 1000000;

    // First 5 allowed
    for (let i = 0; i < 5; i++) {
      rateLimiter.check(agentId, now + i * 100);
    }

    // 6th request rejected
    const blockedRes = rateLimiter.check(agentId, now + 600);
    expect(blockedRes.allowed).toBe(false);
    expect(blockedRes.remaining).toBe(0);
    expect(blockedRes.limit).toBe(5);
    expect(blockedRes.resetMs).toBeGreaterThan(0);
  });

  it('3. Enforces rate limits per-agent independently (Agent A does not block Agent B)', () => {
    const now = 1000000;

    // Exhaust Agent A
    for (let i = 0; i < 5; i++) {
      rateLimiter.check('agent-A', now + i * 100);
    }
    expect(rateLimiter.check('agent-A', now + 600).allowed).toBe(false);

    // Agent B still has full quota
    const resB = rateLimiter.check('agent-B', now + 650);
    expect(resB.allowed).toBe(true);
    expect(resB.remaining).toBe(4);
  });

  it('4. Sliding window resets after windowMs has elapsed', () => {
    const agentId = 'agent-1';
    const now = 1000000;

    // Use 5 requests at t=0..400
    for (let i = 0; i < 5; i++) {
      rateLimiter.check(agentId, now + i * 100);
    }
    expect(rateLimiter.check(agentId, now + 500).allowed).toBe(false);

    // Advance beyond 10s window (windowMs = 10,000)
    const afterWindow = now + 11_000;
    const freshRes = rateLimiter.check(agentId, afterWindow);
    expect(freshRes.allowed).toBe(true);
    expect(freshRes.remaining).toBe(4);
  });

  it('5. Middleware rejects with 429 and Retry-After header when limit exceeded', () => {
    const middleware = createRateLimitMiddleware(rateLimiter);

    const mockAgent: AgentRow = {
      id: 'agent-rate-test',
      name: 'Rate Test Agent',
      api_key_hash: 'hash',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(5000),
      created_at: new Date().toISOString(),
    };

    const runWithContext = (fn: () => void) => {
      agentContextStorage.run({ agentId: mockAgent.id, agent: mockAgent }, fn);
    };

    // First 5 pass
    for (let i = 0; i < 5; i++) {
      runWithContext(() => {
        let calledNext = false;
        const req = {} as Request;
        const resHeaders = new Map<string, string>();
        const res = {
          setHeader: (k: string, v: string) => resHeaders.set(k, v),
        } as unknown as Response;
        middleware(req, res, () => {
          calledNext = true;
        });
        expect(calledNext).toBe(true);
      });
    }

    // 6th request must receive 429
    runWithContext(() => {
      let calledNext = false;
      let status = 0;
      let jsonBody: unknown;
      const resHeaders = new Map<string, string>();
      const req = {} as Request;
      const res = {
        setHeader: (k: string, v: string) => resHeaders.set(k, v),
        status: (code: number) => {
          status = code;
          return res;
        },
        json: (b: unknown) => {
          jsonBody = b;
          return res;
        },
      } as unknown as Response;

      middleware(req, res, () => {
        calledNext = true;
      });

      expect(calledNext).toBe(false);
      expect(status).toBe(429);
      expect(resHeaders.has('Retry-After')).toBe(true);
      expect(resHeaders.get('X-RateLimit-Remaining')).toBe('0');
      expect((jsonBody as { error: { message: string } }).error.message).toContain('Too Many Requests');
    });
  });

  it('6. Middleware fails closed with 401 if invoked without authenticated context', () => {
    const middleware = createRateLimitMiddleware(rateLimiter);
    let status = 0;
    let jsonBody: unknown;
    const req = {} as Request;
    const res = {
      setHeader: () => {},
      status: (code: number) => {
        status = code;
        return res;
      },
      json: (b: unknown) => {
        jsonBody = b;
        return res;
      },
    } as unknown as Response;

    let calledNext = false;
    middleware(req, res, () => {
      calledNext = true;
    });

    expect(calledNext).toBe(false);
    expect(status).toBe(401);
    expect((jsonBody as { error: { message: string } }).error.message).toContain('Authentication required');
  });
});
