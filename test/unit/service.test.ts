/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T8: Unit Tests for Transactional Evaluation and Reservation Service
 *
 * Verifies:
 * - Deterministic snapshot hash construction and fixed expected-hash outputs
 * - Transactional request ingestion, policy evaluation, and state transitions (ALLOW, HOLD, DENY)
 * - Atomic ledger reservation entries (RESERVE on ALLOW/HOLD; zero on DENY)
 * - Suspended-agent handling and fail-closed behavior on missing policy
 * - Idempotency replay (identical payload) vs. conflict error (differing payload)
 * - Concurrency protection for daily budget limits
 * - Atomic rollback of request, ledger, and audit changes on transaction failure
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import { toMinorUnits } from '../../src/core/money.js';
import {
  evaluateAndReserve,
  computeSnapshotHash,
  IdempotencyConflictError,
  NoActivePolicyError,
  AgentNotFoundError,
  VendorNotFoundError,
  type SnapshotHashFields,
} from '../../src/core/service.js';
import { verifyDatabaseAuditChain } from '../../src/core/stateMachine.js';
import type { PolicyDocument } from '../../src/policy/types.js';

describe('M1-T8: Core Service — evaluateAndReserve', () => {
  let db: Database;
  let repos: Repositories;

  const validPolicyDoc: PolicyDocument = {
    version: 1,
    currency_allowlist: ['USD', 'EUR'],
    auto_limit_minor: toMinorUnits(2500), // $25.00
    hard_cap_minor: toMinorUnits(10000), // $100.00
    agent_daily_budget_minor: toMinorUnits(10000), // $100.00
    global_daily_budget_minor: toMinorUnits(50000), // $500.00
    velocity: { max_requests: 5, window_minutes: 10 },
    duplicate_window_minutes: 60,
    new_vendor_action: 'HOLD',
    hold_ttl_minutes: 15,
  };

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    // Seed owner
    repos.owners.upsert({
      display_name: 'Primary Owner',
      passphrase_hash: 'hash-pass',
      telegram_chat_id: 'chat-1',
      created_at: new Date().toISOString(),
    });

    // Seed active policy version
    repos.policyVersions.insert({
      id: 'pol-v1',
      version: 1,
      rules: JSON.stringify(validPolicyDoc),
      author: 'owner',
      active: 1,
      created_at: new Date().toISOString(),
    });

    // Seed active agent
    repos.agents.insert({
      id: 'agent-1',
      name: 'Test Autonomous Agent',
      api_key_hash: 'hash-agent-1',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(10000),
      created_at: new Date().toISOString(),
    });

    // Seed active vendor
    repos.vendors.insert({
      id: 'vendor-1',
      name: 'Acme Cloud Hosting',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud', 'hosting']),
      currencies: JSON.stringify(['USD', 'EUR']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
  });

  // ==========================================================================
  // 1. Snapshot Hash Tests
  // ==========================================================================
  describe('computeSnapshotHash', () => {
    it('should produce the exact pre-computed SHA-256 hash for fixed canonical inputs (with category)', () => {
      const fields: SnapshotHashFields = {
        requestId: 'req-1',
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(1000),
        currency: 'USD',
        purpose: 'Hosting',
        category: 'cloud',
      };

      const hash = computeSnapshotHash(fields);
      // Expected canonical JSON:
      // {"agentId":"agent-1","amountMinor":"1000","category":"cloud","currency":"USD","purpose":"Hosting","requestId":"req-1","vendorId":"vendor-1"}
      expect(hash).toBe('3d4c8626270cce101a502c8b73b48d23732162bc68f3a62e6daa4364c0dc1fb6');
    });

    it('should produce the exact pre-computed SHA-256 hash when category is null', () => {
      const fields: SnapshotHashFields = {
        requestId: 'req-1',
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(1000),
        currency: 'USD',
        purpose: 'Hosting',
        category: null,
      };

      const hash = computeSnapshotHash(fields);
      // Expected canonical JSON:
      // {"agentId":"agent-1","amountMinor":"1000","category":null,"currency":"USD","purpose":"Hosting","requestId":"req-1","vendorId":"vendor-1"}
      expect(hash).toBe('096fbe59d15e06135f5d1c546c46275a36f7c7498bde68eb09a28293e4859fd6');
    });

    it('should treat undefined category identically to null', () => {
      const fieldsWithNull: SnapshotHashFields = {
        requestId: 'req-2',
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(2500),
        currency: 'USD',
        purpose: 'Subscription',
        category: null,
      };

      const fieldsWithUndefined: SnapshotHashFields = {
        requestId: 'req-2',
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(2500),
        currency: 'USD',
        purpose: 'Subscription',
        category: undefined,
      };

      expect(computeSnapshotHash(fieldsWithUndefined)).toBe(computeSnapshotHash(fieldsWithNull));
    });

    it('should change the hash if any canonical field is modified', () => {
      const base: SnapshotHashFields = {
        requestId: 'req-1',
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(1000),
        currency: 'USD',
        purpose: 'Hosting',
        category: 'cloud',
      };
      const baseHash = computeSnapshotHash(base);

      expect(computeSnapshotHash({ ...base, amountMinor: toMinorUnits(1001) })).not.toBe(baseHash);
      expect(computeSnapshotHash({ ...base, currency: 'EUR' })).not.toBe(baseHash);
      expect(computeSnapshotHash({ ...base, purpose: 'Other' })).not.toBe(baseHash);
      expect(computeSnapshotHash({ ...base, vendorId: 'vendor-2' })).not.toBe(baseHash);
      expect(computeSnapshotHash({ ...base, agentId: 'agent-2' })).not.toBe(baseHash);
      expect(computeSnapshotHash({ ...base, requestId: 'req-2' })).not.toBe(baseHash);
      expect(computeSnapshotHash({ ...base, category: 'other' })).not.toBe(baseHash);
    });
  });

  // ==========================================================================
  // 2. Transactional Policy Evaluation & State Transitions
  // ==========================================================================
  describe('Transactional Evaluation & Transitions', () => {
    it('Flow A (ALLOW): should reserve budget, transition RECEIVED -> AUTO_EXECUTING, and write audit entry', () => {
      const fixedNow = new Date('2026-10-29T12:00:00.000Z');

      const result = evaluateAndReserve(db, {
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(1200), // $12.00 <= $25 auto limit
        currency: 'USD',
        purpose: 'Server maintenance',
        category: 'cloud',
        idempotencyKey: 'idem-allow-1',
        now: fixedNow,
        requestId: 'req-allow-1',
      });

      // 1. Result verification
      expect(result.decision).toBe('ALLOW');
      expect(result.reasons).toEqual([]);
      expect(result.isIdempotentReplay).toBe(false);
      expect(result.request.status).toBe('AUTO_EXECUTING');
      expect(result.request.decision).toBe('ALLOW');

      // 2. Database state verification
      const dbRequest = repos.paymentRequests.getById('req-allow-1');
      expect(dbRequest).toBeDefined();
      expect(dbRequest?.status).toBe('AUTO_EXECUTING');
      expect(dbRequest?.decision).toBe('ALLOW');
      expect(dbRequest?.snapshot_hash).toBeNull(); // Only HELD requests have snapshot_hash

      // 3. Ledger verification (exactly one RESERVE entry)
      const ledgerRows = db.prepare('SELECT * FROM ledger WHERE request_id = ?').all('req-allow-1') as Array<{
        kind: string;
        amount_minor: bigint;
        currency: string;
      }>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.kind).toBe('RESERVE');
      expect(ledgerRows[0]?.amount_minor).toBe(toMinorUnits(1200));
      expect(ledgerRows[0]?.currency).toBe('USD');

      // 4. Audit log verification
      const auditRows = db.prepare('SELECT * FROM audit_log WHERE request_id = ?').all('req-allow-1') as Array<{
        event: string;
        actor: string;
      }>;
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.event).toBe('TRANSITION_TO_AUTO_EXECUTING');
      expect(auditRows[0]?.actor).toBe('agent');

      // 5. Audit hash chain integrity
      const chainVerification = verifyDatabaseAuditChain(db);
      expect(chainVerification.valid).toBe(true);
    });

    it('Flow B (HOLD): should reserve budget, persist snapshot hash and expires_at, transition RECEIVED -> HELD, and write audit entry', () => {
      const fixedNow = new Date('2026-10-29T12:00:00.000Z');

      const result = evaluateAndReserve(db, {
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(4000), // $40.00 > $25 auto limit, <= $100 hard cap
        currency: 'USD',
        purpose: 'Quarterly upgrade',
        category: 'cloud',
        idempotencyKey: 'idem-hold-1',
        now: fixedNow,
        requestId: 'req-hold-1',
      });

      // 1. Result verification
      expect(result.decision).toBe('HOLD');
      expect(result.reasons).toContain('OVER_AUTO_LIMIT');
      expect(result.isIdempotentReplay).toBe(false);
      expect(result.request.status).toBe('HELD');

      // 2. Snapshot hash verification
      const expectedSnapshotHash = computeSnapshotHash({
        requestId: 'req-hold-1',
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(4000),
        currency: 'USD',
        purpose: 'Quarterly upgrade',
        category: 'cloud',
      });
      expect(result.request.snapshot_hash).toBe(expectedSnapshotHash);

      // 3. Expiry verification (15 minutes TTL)
      const expectedExpiry = new Date('2026-10-29T12:15:00.000Z').toISOString();
      expect(result.request.expires_at).toBe(expectedExpiry);

      // 4. Ledger verification (must reserve budget while held)
      const ledgerRows = db.prepare('SELECT * FROM ledger WHERE request_id = ?').all('req-hold-1') as Array<{
        kind: string;
        amount_minor: bigint;
      }>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.kind).toBe('RESERVE');
      expect(ledgerRows[0]?.amount_minor).toBe(toMinorUnits(4000));

      // 5. Audit log verification
      const auditRows = db.prepare('SELECT * FROM audit_log WHERE request_id = ?').all('req-hold-1') as Array<{
        event: string;
        actor: string;
      }>;
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.event).toBe('TRANSITION_TO_HELD');
      expect(auditRows[0]?.actor).toBe('agent');

      // 6. Audit hash chain integrity
      const chainVerification = verifyDatabaseAuditChain(db);
      expect(chainVerification.valid).toBe(true);
    });

    it('Flow E (DENY): should create request, reserve zero budget, transition RECEIVED -> DENIED, and write audit entry', () => {
      const fixedNow = new Date('2026-10-29T12:00:00.000Z');

      const result = evaluateAndReserve(db, {
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(15000), // $150.00 > $100 hard cap
        currency: 'USD',
        purpose: 'Excessive server purchase',
        category: 'cloud',
        idempotencyKey: 'idem-deny-1',
        now: fixedNow,
        requestId: 'req-deny-1',
      });

      // 1. Result verification
      expect(result.decision).toBe('DENY');
      expect(result.reasons).toContain('OVER_HARD_CAP');
      expect(result.isIdempotentReplay).toBe(false);
      expect(result.request.status).toBe('DENIED');

      // 2. Ledger verification (NO ledger rows on DENY)
      const ledgerRows = db.prepare('SELECT * FROM ledger WHERE request_id = ?').all('req-deny-1');
      expect(ledgerRows).toHaveLength(0);
      expect(result.ledgerEntry).toBeUndefined();

      // 3. Database request check
      const dbRequest = repos.paymentRequests.getById('req-deny-1');
      expect(dbRequest).toBeDefined();
      expect(dbRequest?.status).toBe('DENIED');
      expect(dbRequest?.snapshot_hash).toBeNull();

      // 4. Audit log verification
      const auditRows = db.prepare('SELECT * FROM audit_log WHERE request_id = ?').all('req-deny-1') as Array<{
        event: string;
      }>;
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.event).toBe('TRANSITION_TO_DENIED');

      // 5. Audit hash chain integrity
      const chainVerification = verifyDatabaseAuditChain(db);
      expect(chainVerification.valid).toBe(true);
    });
  });

  // ==========================================================================
  // 3. Edge Cases & Safety Constraints
  // ==========================================================================
  describe('Safety, Suspended Agents & Fail-Closed', () => {
    it('should deny request and reserve zero budget when agent is SUSPENDED', () => {
      repos.agents.insert({
        id: 'agent-suspended',
        name: 'Compromised Agent',
        api_key_hash: 'hash-agent-susp',
        status: 'SUSPENDED',
        daily_budget_minor: toMinorUnits(10000),
        created_at: new Date().toISOString(),
      });

      const result = evaluateAndReserve(db, {
        agentId: 'agent-suspended',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        purpose: 'Attempted spend by suspended agent',
        idempotencyKey: 'idem-susp-1',
        requestId: 'req-susp-1',
      });

      expect(result.decision).toBe('DENY');
      expect(result.reasons).toContain('AGENT_SUSPENDED');
      expect(result.request.status).toBe('DENIED');

      // No ledger entry
      const ledgerRows = db.prepare('SELECT * FROM ledger WHERE request_id = ?').all('req-susp-1');
      expect(ledgerRows).toHaveLength(0);

      // Audit row exists
      const auditRows = db.prepare('SELECT * FROM audit_log WHERE request_id = ?').all('req-susp-1');
      expect(auditRows).toHaveLength(1);
    });

    it('should fail closed with NoActivePolicyError when active policy is missing', () => {
      // Deactivate all policies
      db.prepare('UPDATE policy_versions SET active = 0').run();

      expect(() => {
        evaluateAndReserve(db, {
          agentId: 'agent-1',
          vendorId: 'vendor-1',
          amountMinor: toMinorUnits(1000),
          currency: 'USD',
          purpose: 'Spend without policy',
          idempotencyKey: 'idem-no-pol',
          requestId: 'req-no-pol',
        });
      }).toThrowError(NoActivePolicyError);

      // No records created
      expect(repos.paymentRequests.getById('req-no-pol')).toBeUndefined();
      expect(db.prepare('SELECT COUNT(*) as count FROM ledger').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) as count FROM audit_log').get()).toEqual({ count: 0 });
    });

    it('should throw AgentNotFoundError when agent does not exist', () => {
      expect(() => {
        evaluateAndReserve(db, {
          agentId: 'nonexistent-agent',
          vendorId: 'vendor-1',
          amountMinor: toMinorUnits(1000),
          currency: 'USD',
          purpose: 'Ghost agent spend',
          idempotencyKey: 'idem-ghost',
        });
      }).toThrowError(AgentNotFoundError);
    });

    it('should throw VendorNotFoundError when vendor does not exist', () => {
      expect(() => {
        evaluateAndReserve(db, {
          agentId: 'agent-1',
          vendorId: 'nonexistent-vendor',
          amountMinor: toMinorUnits(1000),
          currency: 'USD',
          purpose: 'Ghost vendor spend',
          idempotencyKey: 'idem-ghost-v',
        });
      }).toThrowError(VendorNotFoundError);
    });

    it('should reject non-positive amounts before entering the transaction', () => {
      expect(() => {
        evaluateAndReserve(db, {
          agentId: 'agent-1',
          vendorId: 'vendor-1',
          amountMinor: toMinorUnits(0),
          currency: 'USD',
          purpose: 'Zero spend',
          idempotencyKey: 'idem-zero',
        });
      }).toThrowError(/Amount in minor units must be positive/);
    });
  });

  // ==========================================================================
  // 4. Idempotency Guarantees
  // ==========================================================================
  describe('Idempotency Semantics', () => {
    it('should replay existing request on identical payload without duplicate ledger or audit rows', () => {
      const params = {
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(1500),
        currency: 'USD',
        purpose: 'Backup subscription',
        category: 'cloud',
        idempotencyKey: 'idem-replay-1',
        requestId: 'req-first-1',
      };

      // First call
      const firstResult = evaluateAndReserve(db, params);
      expect(firstResult.isIdempotentReplay).toBe(false);
      expect(firstResult.request.id).toBe('req-first-1');

      const initialLedgerCount = db.prepare('SELECT COUNT(*) as count FROM ledger').get() as { count: number };
      const initialAuditCount = db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as { count: number };

      // Second call: exact same payload and key, different requestId override should be ignored
      const secondResult = evaluateAndReserve(db, {
        ...params,
        requestId: 'req-second-attempt',
      });

      expect(secondResult.isIdempotentReplay).toBe(true);
      expect(secondResult.request.id).toBe('req-first-1');
      expect(secondResult.decision).toBe(firstResult.decision);

      // Verify no duplicate rows
      const postLedgerCount = db.prepare('SELECT COUNT(*) as count FROM ledger').get() as { count: number };
      const postAuditCount = db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as { count: number };
      expect(postLedgerCount.count).toBe(initialLedgerCount.count);
      expect(postAuditCount.count).toBe(initialAuditCount.count);
    });

    it('should throw IdempotencyConflictError when reusing key with different amount', () => {
      const baseParams = {
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(1500),
        currency: 'USD',
        purpose: 'Backup subscription',
        category: 'cloud',
        idempotencyKey: 'idem-conflict-1',
      };

      evaluateAndReserve(db, baseParams);

      // Reusing idempotency key with different amount
      expect(() => {
        evaluateAndReserve(db, {
          ...baseParams,
          amountMinor: toMinorUnits(2000),
        });
      }).toThrowError(IdempotencyConflictError);
    });

    it('should throw IdempotencyConflictError when reusing key with different vendor or purpose', () => {
      repos.vendors.insert({
        id: 'vendor-2',
        name: 'Another Vendor',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'vendor_2',
        created_at: new Date().toISOString(),
      });

      const baseParams = {
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(1500),
        currency: 'USD',
        purpose: 'Backup subscription',
        category: 'cloud',
        idempotencyKey: 'idem-conflict-2',
      };

      evaluateAndReserve(db, baseParams);

      // Reusing key with different vendor
      expect(() => {
        evaluateAndReserve(db, {
          ...baseParams,
          vendorId: 'vendor-2',
        });
      }).toThrowError(IdempotencyConflictError);

      // Reusing key with different purpose
      expect(() => {
        evaluateAndReserve(db, {
          ...baseParams,
          purpose: 'Altered purpose',
        });
      }).toThrowError(IdempotencyConflictError);
    });
  });

  // ==========================================================================
  // 5. Concurrency & Contention Guarantees
  // ==========================================================================
  describe('Concurrency & Budget Protection', () => {
    it('should enforce remaining daily budget across sequential requests', () => {
      // Agent has $100 daily budget.
      // Request 1: $20 -> ALLOW ($20 spent/reserved, $80 remaining).
      const res1 = evaluateAndReserve(db, {
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(2000), // $20.00
        currency: 'USD',
        purpose: 'Service 1',
        category: 'cloud',
        idempotencyKey: 'idem-seq-1',
      });
      expect(res1.decision).toBe('ALLOW');

      // Request 2: $20 -> ALLOW ($40 spent/reserved, $60 remaining).
      const res2 = evaluateAndReserve(db, {
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(2000), // $20.00
        currency: 'USD',
        purpose: 'Service 2',
        category: 'cloud',
        idempotencyKey: 'idem-seq-2',
      });
      expect(res2.decision).toBe('ALLOW');

      // Request 3: $70 -> Total would be $40 + $70 = $110 > $100 daily budget.
      // Triggers AGENT_BUDGET_EXCEEDED -> Soft HOLD.
      const res3 = evaluateAndReserve(db, {
        agentId: 'agent-1',
        vendorId: 'vendor-1',
        amountMinor: toMinorUnits(7000), // $70.00
        currency: 'USD',
        purpose: 'Service 3',
        category: 'cloud',
        idempotencyKey: 'idem-seq-3',
      });
      expect(res3.decision).toBe('HOLD');
      expect(res3.reasons).toContain('AGENT_BUDGET_EXCEEDED');

      // Verify that all 3 reservations are tracked in the ledger
      const ledgerTotal = db.prepare('SELECT SUM(amount_minor) as total FROM ledger').get() as { total: bigint };
      expect(ledgerTotal.total).toBe(toMinorUnits(11000));
    });
  });

  // ==========================================================================
  // 6. Atomic Transaction Rollback
  // ==========================================================================
  describe('Transaction Rollback on Failure', () => {
    it('should cleanly roll back request, ledger, and audit changes if an error occurs mid-transaction', () => {
      // Create a corrupted repository wrapper that throws when transitionPaymentRequest updates status
      const failingRepos = createRepositories(db);
      failingRepos.paymentRequests.updateStatusAndDecision = () => {
        throw new Error('Simulated disk/database failure during status update');
      };

      expect(() => {
        evaluateAndReserve(
          db,
          {
            agentId: 'agent-1',
            vendorId: 'vendor-1',
            amountMinor: toMinorUnits(1000),
            currency: 'USD',
            purpose: 'Doomed payment',
            idempotencyKey: 'idem-fail-1',
            requestId: 'req-doomed-1',
          },
          failingRepos
        );
      }).toThrowError(/Simulated disk\/database failure/);

      // Verify complete rollback: zero rows persisted
      expect(repos.paymentRequests.getById('req-doomed-1')).toBeUndefined();
      const ledgerCount = db.prepare('SELECT COUNT(*) as count FROM ledger WHERE request_id = ?').get('req-doomed-1') as { count: number };
      expect(ledgerCount.count).toBe(0);
      const auditCount = db.prepare('SELECT COUNT(*) as count FROM audit_log WHERE request_id = ?').get('req-doomed-1') as { count: number };
      expect(auditCount.count).toBe(0);
    });
  });
});
