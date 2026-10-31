/**
 * PayGuard — Milestone M3: MCP Integration
 * Unit Tests: M3-T1 Agent Authentication & Context Middleware
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import {
  generateAgentKey,
  hashApiKey,
  verifyAgentApiKey,
  createAuthMiddleware,
  getAuthenticatedAgent,
} from '../../src/mcp/auth.js';
import { runAgentCreation } from '../../src/mcp/cli/createAgent.js';
import { toMinorUnits } from '../../src/core/money.js';
import type { AgentRow } from '../../src/db/types.js';

describe('M3-T1: Agent Authentication & Context Middleware', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedAgent(overrides?: Partial<AgentRow>): { agent: AgentRow; rawKey: string } {
    const { rawKey, keyHash } = generateAgentKey();
    const agent: AgentRow = {
      id: overrides?.id ?? `agent-${crypto.randomUUID()}`,
      name: overrides?.name ?? 'Test Agent',
      api_key_hash: overrides?.api_key_hash ?? keyHash,
      status: overrides?.status ?? 'ACTIVE',
      daily_budget_minor: overrides?.daily_budget_minor ?? toMinorUnits(5000),
      created_at: new Date().toISOString(),
      ...overrides,
    };
    repos.agents.insert(agent);
    return { agent, rawKey };
  }

  // ============================================================================
  // Key Generation & Hashing Tests
  // ============================================================================

  it('1. Generates 32-byte cryptographically secure random key and SHA-256 hash', () => {
    const { rawKey, keyHash } = generateAgentKey();
    expect(rawKey).toBeDefined();
    expect(rawKey.length).toBe(64); // 32 bytes in hex = 64 characters
    expect(/^[0-9a-f]{64}$/.test(rawKey)).toBe(true);

    expect(keyHash).toBeDefined();
    expect(keyHash.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(keyHash)).toBe(true);

    // Hash is deterministic
    expect(hashApiKey(rawKey)).toBe(keyHash);
  });

  it('2. hashApiKey handles trimming and edge cases deterministically', () => {
    const key = 'test-secret-key-12345';
    const hash = hashApiKey(key);
    expect(hashApiKey(`  ${key}  `)).toBe(hash);
    expect(hashApiKey('')).toBe('');
    expect(hashApiKey(null as unknown as string)).toBe('');
  });

  // ============================================================================
  // verifyAgentApiKey Tests
  // ============================================================================

  it('3. verifyAgentApiKey succeeds for valid active agent', () => {
    const { agent, rawKey } = seedAgent({ name: 'Active Agent', status: 'ACTIVE' });
    const result = verifyAgentApiKey(db, rawKey, repos);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agent.id).toBe(agent.id);
      expect(result.agent.name).toBe('Active Agent');
    }
  });

  it('4. verifyAgentApiKey fails closed with FORBIDDEN for suspended agent', () => {
    const { agent, rawKey } = seedAgent({ name: 'Suspended Agent', status: 'SUSPENDED' });
    const result = verifyAgentApiKey(db, rawKey, repos);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('FORBIDDEN');
      expect(result.error).toContain('suspended');
    }

    // Verify agent status remains SUSPENDED in DB
    const stored = repos.agents.getById(agent.id)!;
    expect(stored.status).toBe('SUSPENDED');
  });

  it('5. verifyAgentApiKey fails closed with UNAUTHORIZED for non-existent key', () => {
    seedAgent();
    const result = verifyAgentApiKey(db, 'non-existent-api-key', repos);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('UNAUTHORIZED');
      expect(result.error).toContain('Invalid');
    }
  });

  it('6. verifyAgentApiKey fails closed for empty or whitespace key', () => {
    const result1 = verifyAgentApiKey(db, '', repos);
    expect(result1.ok).toBe(false);
    if (!result1.ok) expect(result1.code).toBe('UNAUTHORIZED');

    const result2 = verifyAgentApiKey(db, '   ', repos);
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.code).toBe('UNAUTHORIZED');
  });

  // ============================================================================
  // Express Auth Middleware Tests
  // ============================================================================

  it('7. Middleware rejects request missing Authorization header with 401', () => {
    const middleware = createAuthMiddleware(db, repos);
    const req = { headers: {} } as Request;
    let statusCode = 0;
    let jsonBody: unknown;

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: unknown) => {
        jsonBody = body;
        return res;
      },
    } as unknown as Response;

    let nextCalled = false;
    const next: NextFunction = () => {
      nextCalled = true;
    };

    middleware(req, res, next);
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(401);
    expect((jsonBody as { error: { message: string } }).error.message).toContain('Missing Authorization header');
  });

  it('8. Middleware rejects malformed auth scheme (e.g. Basic) with 401', () => {
    const middleware = createAuthMiddleware(db, repos);
    const req = { headers: { authorization: 'Basic user:pass' } } as Request;
    let statusCode = 0;

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: () => res,
    } as unknown as Response;

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(401);
  });

  it('9. Middleware rejects suspended agent with 403 Forbidden', () => {
    const { rawKey } = seedAgent({ status: 'SUSPENDED' });
    const middleware = createAuthMiddleware(db, repos);
    const req = { headers: { authorization: `Bearer ${rawKey}` } } as Request;
    let statusCode = 0;
    let jsonBody: unknown;

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: unknown) => {
        jsonBody = body;
        return res;
      },
    } as unknown as Response;

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(403);
    expect((jsonBody as { error: { message: string } }).error.message).toContain('suspended');
  });

  it('10. Middleware accepts valid active agent, calls next, and populates AsyncLocalStorage context', () => {
    const { agent, rawKey } = seedAgent({ status: 'ACTIVE' });
    const middleware = createAuthMiddleware(db, repos);
    const req = { headers: { authorization: `Bearer ${rawKey}` } } as Request;

    const res = {
      status: () => res,
      json: () => res,
    } as unknown as Response;

    let nextCalled = false;
    let contextAgentId = '';

    middleware(req, res, () => {
      nextCalled = true;
      const ctx = getAuthenticatedAgent();
      contextAgentId = ctx.agentId;
    });

    expect(nextCalled).toBe(true);
    expect(contextAgentId).toBe(agent.id);
  });

  it('11. getAuthenticatedAgent fails closed when called outside context', () => {
    expect(() => getAuthenticatedAgent()).toThrowError(/No authenticated agent context/);
  });

  // ============================================================================
  // CLI runAgentCreation Tests
  // ============================================================================

  it('12. runAgentCreation stores only hash and returns raw key', () => {
    const result = runAgentCreation(['CLI Agent', '100.00'], db);

    expect(result.id).toBeDefined();
    expect(result.name).toBe('CLI Agent');
    expect(result.dailyBudgetMinor).toBe(10000); // $100.00 = 10000 minor units
    expect(result.rawKey.length).toBe(64);
    expect(result.keyHash.length).toBe(64);

    // Verify stored row in database has hash and NOT raw key
    const stored = repos.agents.getById(result.id)!;
    expect(stored).toBeDefined();
    expect(stored.name).toBe('CLI Agent');
    expect(stored.api_key_hash).toBe(result.keyHash);
    expect(stored.api_key_hash).not.toBe(result.rawKey);

    // Verify raw key can authenticate
    const verified = verifyAgentApiKey(db, result.rawKey, repos);
    expect(verified.ok).toBe(true);
  });

  it('13. runAgentCreation throws when agent name is omitted', () => {
    expect(() => runAgentCreation([], db)).toThrowError(/Usage/);
  });

  it('14. runAgentCreation throws when daily budget is invalid', () => {
    expect(() => runAgentCreation(['Agent', '-50.00'], db)).toThrow();
    expect(() => runAgentCreation(['Agent', 'not-a-number'], db)).toThrow();
  });
});
