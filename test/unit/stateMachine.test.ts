/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T7: State Machine and Audit Hash Chain Unit Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import {
  PaymentRequestStatus,
  VALID_TRANSITIONS,
  TERMINAL_STATUSES,
  IllegalStateTransitionError,
  isTerminalStatus,
  isValidTransition,
  assertValidTransition,
  computeAuditHash,
  serializeAuditPayload,
  verifyAuditChain,
  verifyDatabaseAuditChain,
  transitionPaymentRequest,
  writeAuditLogEntry,
} from '../../src/core/stateMachine.js';
import { toMinorUnits } from '../../src/core/money.js';
import type { AuditLogRow } from '../../src/db/types.js';

describe('M1-T7: State Machine & Audit Hash Chain', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    // Seed agent and vendor required by foreign keys
    repos.agents.insert({
      id: 'agent-1',
      name: 'Test Agent',
      api_key_hash: 'hash-1',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(100000),
      created_at: new Date().toISOString(),
    });

    repos.vendors.insert({
      id: 'vendor-1',
      name: 'Acme Cloud',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud', 'saas']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme',
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
  });

  function createTestRequest(id: string, initialStatus: PaymentRequestStatus = 'RECEIVED') {
    const now = new Date().toISOString();
    repos.paymentRequests.insert({
      id,
      agent_id: 'agent-1',
      idempotency_key: `idem-${id}`,
      vendor_id: 'vendor-1',
      amount_minor: toMinorUnits(5000),
      currency: 'USD',
      purpose: 'Compute server',
      category: 'cloud',
      source_context_excerpt: 'deploy server',
      source_context_hash: null,
      status: initialStatus,
      decision: null,
      reasons: null,
      policy_version_id: null,
      snapshot_hash: null,
      paypal_order_id: null,
      paypal_authorization_id: null,
      paypal_capture_id: null,
      expires_at: null,
      created_at: now,
      updated_at: now,
    });
  }

  describe('1. State Transition Rules & Invariant I2', () => {
    it('identifies terminal statuses correctly', () => {
      expect(isTerminalStatus('DENIED')).toBe(true);
      expect(isTerminalStatus('VOIDED')).toBe(true);
      expect(isTerminalStatus('CAPTURED')).toBe(true);
      expect(isTerminalStatus('FAILED')).toBe(true);

      expect(isTerminalStatus('RECEIVED')).toBe(false);
      expect(isTerminalStatus('AUTO_EXECUTING')).toBe(false);
      expect(isTerminalStatus('HELD')).toBe(false);
      expect(isTerminalStatus('APPROVED')).toBe(false);
      expect(isTerminalStatus('CAPTURING')).toBe(false);
      expect(isTerminalStatus('EXPIRED')).toBe(false);
    });

    it('rejects any transition out of terminal statuses', () => {
      const allStatuses: PaymentRequestStatus[] = [
        'RECEIVED', 'AUTO_EXECUTING', 'HELD', 'APPROVED',
        'CAPTURING', 'EXPIRED', 'DENIED', 'VOIDED', 'CAPTURED', 'FAILED',
      ];

      for (const terminal of TERMINAL_STATUSES) {
        expect(VALID_TRANSITIONS[terminal]).toHaveLength(0);
        for (const target of allStatuses) {
          expect(isValidTransition(terminal, target)).toBe(false);
          expect(() => assertValidTransition(terminal, target, 'req-test')).toThrow(IllegalStateTransitionError);
        }
      }
    });

    it('validates Flow A (ALLOW): RECEIVED -> AUTO_EXECUTING -> CAPTURED', () => {
      createTestRequest('req-flow-a', 'RECEIVED');

      const step1 = transitionPaymentRequest(db, repos, {
        requestId: 'req-flow-a',
        to: 'AUTO_EXECUTING',
        actor: 'system',
        decision: 'ALLOW',
      });
      expect(step1.request.status).toBe('AUTO_EXECUTING');
      expect(step1.request.decision).toBe('ALLOW');

      const step2 = transitionPaymentRequest(db, repos, {
        requestId: 'req-flow-a',
        to: 'CAPTURED',
        actor: 'system',
        paypalCaptureId: 'cap-123',
      });
      expect(step2.request.status).toBe('CAPTURED');
      expect(step2.request.paypal_capture_id).toBe('cap-123');
    });

    it('validates Flow B & C (HOLD -> APPROVE -> CAPTURE): RECEIVED -> HELD -> APPROVED -> CAPTURING -> CAPTURED', () => {
      createTestRequest('req-flow-bc', 'RECEIVED');

      // RECEIVED -> HELD
      const step1 = transitionPaymentRequest(db, repos, {
        requestId: 'req-flow-bc',
        to: 'HELD',
        actor: 'system',
        decision: 'HOLD',
        snapshotHash: 'snap-abc',
        expiresAt: '2026-11-01T00:00:00Z',
      });
      expect(step1.request.status).toBe('HELD');
      expect(step1.request.snapshot_hash).toBe('snap-abc');

      // HELD -> APPROVED (owner approves)
      const step2 = transitionPaymentRequest(db, repos, {
        requestId: 'req-flow-bc',
        to: 'APPROVED',
        actor: 'owner',
      });
      expect(step2.request.status).toBe('APPROVED');

      // APPROVED -> CAPTURING
      const step3 = transitionPaymentRequest(db, repos, {
        requestId: 'req-flow-bc',
        to: 'CAPTURING',
        actor: 'system',
      });
      expect(step3.request.status).toBe('CAPTURING');

      // CAPTURING -> CAPTURED
      const step4 = transitionPaymentRequest(db, repos, {
        requestId: 'req-flow-bc',
        to: 'CAPTURED',
        actor: 'system',
        paypalCaptureId: 'cap-999',
      });
      expect(step4.request.status).toBe('CAPTURED');
      expect(step4.request.paypal_capture_id).toBe('cap-999');
    });

    it('validates Flow D (Void / Expire): HELD -> VOIDED and HELD -> EXPIRED -> VOIDED', () => {
      // Direct VOID by owner
      createTestRequest('req-void', 'RECEIVED');
      transitionPaymentRequest(db, repos, {
        requestId: 'req-void',
        to: 'HELD',
        actor: 'system',
      });
      const voidResult = transitionPaymentRequest(db, repos, {
        requestId: 'req-void',
        to: 'VOIDED',
        actor: 'owner',
        reason: 'Owner rejected payment',
      });
      expect(voidResult.request.status).toBe('VOIDED');

      // Expiry path: HELD -> EXPIRED -> VOIDED
      createTestRequest('req-expire', 'RECEIVED');
      transitionPaymentRequest(db, repos, {
        requestId: 'req-expire',
        to: 'HELD',
        actor: 'system',
      });
      const expireResult = transitionPaymentRequest(db, repos, {
        requestId: 'req-expire',
        to: 'EXPIRED',
        actor: 'system',
        reason: 'Hold authorization timed out',
      });
      expect(expireResult.request.status).toBe('EXPIRED');

      const voidExpiredResult = transitionPaymentRequest(db, repos, {
        requestId: 'req-expire',
        to: 'VOIDED',
        actor: 'system',
        reason: 'Expired hold voided on PayPal',
      });
      expect(voidExpiredResult.request.status).toBe('VOIDED');
    });

    it('validates Flow E (DENY): RECEIVED -> DENIED', () => {
      createTestRequest('req-deny', 'RECEIVED');
      const denyResult = transitionPaymentRequest(db, repos, {
        requestId: 'req-deny',
        to: 'DENIED',
        actor: 'system',
        decision: 'DENY',
        reasons: ['BUDGET_EXCEEDED'],
      });
      expect(denyResult.request.status).toBe('DENIED');
      expect(denyResult.request.decision).toBe('DENY');
      expect(JSON.parse(denyResult.request.reasons!)).toEqual(['BUDGET_EXCEEDED']);
    });

    it('validates Flow F (FAILURES): transitions to FAILED from eligible states', () => {
      // From RECEIVED on pre-execution failure
      createTestRequest('req-fail-1', 'RECEIVED');
      const fail1 = transitionPaymentRequest(db, repos, {
        requestId: 'req-fail-1',
        to: 'FAILED',
        actor: 'system',
        reason: 'Pre-flight connection failure',
      });
      expect(fail1.request.status).toBe('FAILED');

      // From AUTO_EXECUTING on PayPal capture decline
      createTestRequest('req-fail-2', 'RECEIVED');
      transitionPaymentRequest(db, repos, {
        requestId: 'req-fail-2',
        to: 'AUTO_EXECUTING',
        actor: 'system',
      });
      const fail2 = transitionPaymentRequest(db, repos, {
        requestId: 'req-fail-2',
        to: 'FAILED',
        actor: 'system',
        reason: 'PayPal capture returned INSTRUMENT_DECLINED',
      });
      expect(fail2.request.status).toBe('FAILED');

      // From CAPTURING on capture failure
      createTestRequest('req-fail-3', 'RECEIVED');
      transitionPaymentRequest(db, repos, { requestId: 'req-fail-3', to: 'HELD', actor: 'system' });
      transitionPaymentRequest(db, repos, { requestId: 'req-fail-3', to: 'APPROVED', actor: 'owner' });
      transitionPaymentRequest(db, repos, { requestId: 'req-fail-3', to: 'CAPTURING', actor: 'system' });
      const fail3 = transitionPaymentRequest(db, repos, {
        requestId: 'req-fail-3',
        to: 'FAILED',
        actor: 'system',
        reason: 'Capture call timed out',
      });
      expect(fail3.request.status).toBe('FAILED');

      // From HELD on authorization failure (Option B)
      createTestRequest('req-fail-held', 'RECEIVED');
      transitionPaymentRequest(db, repos, { requestId: 'req-fail-held', to: 'HELD', actor: 'system' });
      const failHeld = transitionPaymentRequest(db, repos, {
        requestId: 'req-fail-held',
        to: 'FAILED',
        actor: 'system',
        reason: 'PayPal authorization returned INSTRUMENT_DECLINED',
      });
      expect(failHeld.request.status).toBe('FAILED');
    });

    it('strictly throws IllegalStateTransitionError on invalid jumps', () => {
      createTestRequest('req-invalid', 'RECEIVED');

      // Cannot jump from RECEIVED directly to CAPTURED
      expect(() => {
        transitionPaymentRequest(db, repos, {
          requestId: 'req-invalid',
          to: 'CAPTURED',
          actor: 'system',
        });
      }).toThrow(IllegalStateTransitionError);

      // Cannot jump from RECEIVED directly to APPROVED
      expect(() => {
        transitionPaymentRequest(db, repos, {
          requestId: 'req-invalid',
          to: 'APPROVED',
          actor: 'system',
        });
      }).toThrow(IllegalStateTransitionError);

      // Cannot jump from HELD directly to CAPTURED
      transitionPaymentRequest(db, repos, { requestId: 'req-invalid', to: 'HELD', actor: 'system' });
      expect(() => {
        transitionPaymentRequest(db, repos, {
          requestId: 'req-invalid',
          to: 'CAPTURED',
          actor: 'system',
        });
      }).toThrow(IllegalStateTransitionError);
    });

    it('strictly throws IllegalStateTransitionError on backward transitions', () => {
      createTestRequest('req-back', 'RECEIVED');
      transitionPaymentRequest(db, repos, { requestId: 'req-back', to: 'HELD', actor: 'system' });
      transitionPaymentRequest(db, repos, { requestId: 'req-back', to: 'APPROVED', actor: 'owner' });

      // Cannot go back from APPROVED to HELD
      expect(() => {
        transitionPaymentRequest(db, repos, {
          requestId: 'req-back',
          to: 'HELD',
          actor: 'system',
        });
      }).toThrow(IllegalStateTransitionError);
    });
  });

  describe('2. Audit Hash Chain Construction & Integrity', () => {
    it('produces deterministic SHA-256 hashes regardless of payload key order', () => {
      const payload1 = serializeAuditPayload({ b: 2, a: 1, c: { z: 26, y: 25 } });
      const payload2 = serializeAuditPayload({ a: 1, c: { y: 25, z: 26 }, b: 2 });
      expect(payload1).toBe(payload2);

      const hash1 = computeAuditHash({
        id: 'aud-1',
        ts: '2026-10-29T10:00:00.000Z',
        actor: 'system',
        event: 'TEST_EVENT',
        request_id: 'req-1',
        payload: payload1,
        prev_hash: null,
      });

      const hash2 = computeAuditHash({
        id: 'aud-1',
        ts: '2026-10-29T10:00:00.000Z',
        actor: 'system',
        event: 'TEST_EVENT',
        request_id: 'req-1',
        payload: payload2,
        prev_hash: null,
      });

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
    });

    it('builds an unbroken sequential hash chain across multiple transitions', () => {
      createTestRequest('req-chain', 'RECEIVED');

      // Initial manual log entry (genesis)
      writeAuditLogEntry(db, repos, {
        actor: 'agent',
        event: 'PAYMENT_REQUEST_CREATED',
        requestId: 'req-chain',
        payload: { amount_minor: 5000, currency: 'USD' },
      });

      // Transition 1
      transitionPaymentRequest(db, repos, {
        requestId: 'req-chain',
        to: 'HELD',
        actor: 'system',
      });

      // Transition 2
      transitionPaymentRequest(db, repos, {
        requestId: 'req-chain',
        to: 'APPROVED',
        actor: 'owner',
      });

      // Transition 3
      transitionPaymentRequest(db, repos, {
        requestId: 'req-chain',
        to: 'CAPTURING',
        actor: 'system',
      });

      // Transition 4
      transitionPaymentRequest(db, repos, {
        requestId: 'req-chain',
        to: 'CAPTURED',
        actor: 'system',
      });

      const auditRows = repos.auditLog.listByRequestId('req-chain');
      expect(auditRows).toHaveLength(5);

      // Verify chain continuity
      expect(auditRows[0]!.prev_hash).toBeNull();
      expect(auditRows[1]!.prev_hash).toBe(auditRows[0]!.hash);
      expect(auditRows[2]!.prev_hash).toBe(auditRows[1]!.hash);
      expect(auditRows[3]!.prev_hash).toBe(auditRows[2]!.hash);
      expect(auditRows[4]!.prev_hash).toBe(auditRows[3]!.hash);

      // Verify entire chain validity using verifyAuditChain
      const verification = verifyAuditChain(auditRows);
      expect(verification.valid).toBe(true);
      expect(verification.totalEntries).toBe(5);

      // Verify database-level verifier
      const dbVerification = verifyDatabaseAuditChain(db);
      expect(dbVerification.valid).toBe(true);
      expect(dbVerification.totalEntries).toBe(5);
    });

    it('detects tampering with payload in audit chain', () => {
      const entry1: AuditLogRow = {
        id: 'aud-1',
        ts: '2026-10-29T10:00:00Z',
        actor: 'system',
        event: 'GENESIS',
        request_id: 'req-1',
        payload: JSON.stringify({ amount: 100 }),
        prev_hash: null,
        hash: '',
      };
      (entry1 as { hash: string }).hash = computeAuditHash(entry1);

      const entry2: AuditLogRow = {
        id: 'aud-2',
        ts: '2026-10-29T10:01:00Z',
        actor: 'owner',
        event: 'APPROVE',
        request_id: 'req-1',
        payload: JSON.stringify({ action: 'APPROVED' }),
        prev_hash: entry1.hash,
        hash: '',
      };
      (entry2 as { hash: string }).hash = computeAuditHash(entry2);

      expect(verifyAuditChain([entry1, entry2]).valid).toBe(true);

      // Tamper entry 1 payload without updating hash
      const tamperedEntry1: AuditLogRow = {
        ...entry1,
        payload: JSON.stringify({ amount: 999999 }),
      };

      const result = verifyAuditChain([tamperedEntry1, entry2]);
      expect(result.valid).toBe(false);
      expect(result.brokenIndex).toBe(0);
      expect(result.error).toMatch(/Hash mismatch at entry index 0/);
    });

    it('detects broken prev_hash linking', () => {
      const entry1: AuditLogRow = {
        id: 'aud-1',
        ts: '2026-10-29T10:00:00Z',
        actor: 'system',
        event: 'GENESIS',
        request_id: 'req-1',
        payload: JSON.stringify({ step: 1 }),
        prev_hash: null,
        hash: '',
      };
      (entry1 as { hash: string }).hash = computeAuditHash(entry1);

      // Entry 2 forged with invalid prev_hash
      const entry2: AuditLogRow = {
        id: 'aud-2',
        ts: '2026-10-29T10:01:00Z',
        actor: 'system',
        event: 'STEP_2',
        request_id: 'req-1',
        payload: JSON.stringify({ step: 2 }),
        prev_hash: '0000000000000000000000000000000000000000000000000000000000000000',
        hash: '',
      };
      (entry2 as { hash: string }).hash = computeAuditHash(entry2);

      const result = verifyAuditChain([entry1, entry2]);
      expect(result.valid).toBe(false);
      expect(result.brokenIndex).toBe(1);
      expect(result.error).toMatch(/Chain broken at entry index 1/);
    });

    it('detects genesis entry with non-null prev_hash', () => {
      const entry1: AuditLogRow = {
        id: 'aud-1',
        ts: '2026-10-29T10:00:00Z',
        actor: 'system',
        event: 'GENESIS',
        request_id: 'req-1',
        payload: JSON.stringify({ step: 1 }),
        prev_hash: 'some-non-null-hash',
        hash: '',
      };
      (entry1 as { hash: string }).hash = computeAuditHash(entry1);

      const result = verifyAuditChain([entry1]);
      expect(result.valid).toBe(false);
      expect(result.brokenIndex).toBe(0);
      expect(result.error).toMatch(/Genesis entry 'aud-1' must have prev_hash null/);
    });
  });

  describe('3. Transactional Atomicity & Rollback (Rule 7)', () => {
    it('writes request transition and audit row atomically in a single transaction', () => {
      createTestRequest('req-atomic', 'RECEIVED');

      const { request, auditEntry } = transitionPaymentRequest(db, repos, {
        requestId: 'req-atomic',
        to: 'HELD',
        actor: 'system',
        reason: 'Hold for approval',
      });

      expect(request.status).toBe('HELD');
      expect(auditEntry.request_id).toBe('req-atomic');
      expect(auditEntry.actor).toBe('system');
      expect(auditEntry.event).toBe('TRANSITION_TO_HELD');

      const auditRows = repos.auditLog.listByRequestId('req-atomic');
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]!.id).toBe(auditEntry.id);
      expect(auditRows[0]!.hash).toBe(auditEntry.hash);
    });

    it('rolls back status update if transition is illegal, leaving audit untouched', () => {
      createTestRequest('req-rollback', 'RECEIVED');

      expect(() => {
        transitionPaymentRequest(db, repos, {
          requestId: 'req-rollback',
          to: 'CAPTURED', // illegal directly from RECEIVED
          actor: 'system',
        });
      }).toThrow(IllegalStateTransitionError);

      const reqAfter = repos.paymentRequests.getById('req-rollback');
      expect(reqAfter?.status).toBe('RECEIVED');

      const auditRows = repos.auditLog.listByRequestId('req-rollback');
      expect(auditRows).toHaveLength(0);
    });

    it('rolls back status update if an audit write fails inside transaction', () => {
      createTestRequest('req-db-fail', 'RECEIVED');

      // Inject a mock repo whose audit insert intentionally throws
      const failingRepos = {
        ...repos,
        auditLog: {
          ...repos.auditLog,
          insert: () => {
            throw new Error('Simulated disk full / database error on audit insert');
          },
        },
      } as unknown as Repositories;

      expect(() => {
        transitionPaymentRequest(db, failingRepos, {
          requestId: 'req-db-fail',
          to: 'HELD',
          actor: 'system',
        });
      }).toThrow(/Simulated disk full/);

      // Verify the status was NOT updated to HELD
      const reqAfter = repos.paymentRequests.getById('req-db-fail');
      expect(reqAfter?.status).toBe('RECEIVED');
    });

    it('preserves SQLite engine-level append-only triggers against audit modification', () => {
      createTestRequest('req-triggers', 'RECEIVED');

      const { auditEntry } = transitionPaymentRequest(db, repos, {
        requestId: 'req-triggers',
        to: 'HELD',
        actor: 'system',
      });

      // Engine-level trigger must abort UPDATE
      expect(() => {
        db.prepare('UPDATE audit_log SET payload = ? WHERE id = ?').run('{}', auditEntry.id);
      }).toThrowError(/audit_log is append-only: UPDATE operations are strictly prohibited/);

      // Engine-level trigger must abort DELETE
      expect(() => {
        db.prepare('DELETE FROM audit_log WHERE id = ?').run(auditEntry.id);
      }).toThrowError(/audit_log is append-only: DELETE operations are strictly prohibited/);
    });
  });
});
