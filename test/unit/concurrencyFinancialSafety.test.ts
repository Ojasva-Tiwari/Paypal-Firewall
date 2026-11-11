/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T4.3: Financial Concurrency & Idempotency Stress Testing
 *
 * Verifies:
 * 1. Budget competition: 20 simultaneous payment requests competing for $100 budget ($20 each).
 *    Exactly 5 succeed; remaining 15 fail closed. Zero overspending or duplicate reservations.
 * 2. Concurrent idempotency: 10 simultaneous identical requests with identical idempotency keys.
 *    Exactly 1 payment execution, 9 idempotent replays, 1 database record, 1 financial reservation.
 * 3. Idempotency conflicts: 5 simultaneous requests with identical key but differing amounts.
 *    Exactly 1 wins; remaining 4 receive sanitized IDEMPOTENCY_CONFLICT errors.
 * 4. Capture vs. expiry race: Approval capture racing hold expiration.
 *    Exactly 1 valid terminal financial outcome; never both SPEND and RELEASE.
 * 5. SQLite contention: Lock contention, SQLITE_BUSY handling, and atomic rollback on crash.
 *    Zero partial financial mutations.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createDatabase,
  runMigrations,
  runInTransaction,
  type Database,
} from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import { toMinorUnits } from '../../src/core/money.js';
import {
  evaluateAndReserve,
  computeSnapshotHash,
  IdempotencyConflictError,
  type EvaluateAndReserveResult,
} from '../../src/core/service.js';
import { handleRequestPayment } from '../../src/mcp/tools.js';
import { agentContextStorage } from '../../src/mcp/auth.js';
import { verifyDatabaseAuditChain } from '../../src/core/stateMachine.js';
import { ApprovalExecutionService, ApprovalValidationError } from '../../src/approvals/service.js';
import { mintApprovalToken } from '../../src/approvals/tokens.js';
import { expirePaymentHold } from '../../src/approvals/expiry.js';
import type {
  PayPalAuthorizationsService,
  PayPalCaptureResult,
} from '../../src/paypal/authorizations.js';
import type { PayPalOrdersService } from '../../src/paypal/orders.js';
import { _resetInFlightExecutionsForTest } from '../../src/core/executeDecision.js';
import type { PolicyDocument } from '../../src/policy/types.js';
import type { AgentRow, LedgerRow, PaymentRequestRow, AuditLogRow } from '../../src/db/types.js';

describe('M6-T4.3: Financial Concurrency & Idempotency Stress Testing', () => {
  let db: Database;
  let repos: Repositories;
  let mockAuthorizationsService: PayPalAuthorizationsService;
  let mockOrdersService: PayPalOrdersService;

  const standardPolicy: PolicyDocument = {
    version: 1,
    currency_allowlist: ['USD'],
    auto_limit_minor: toMinorUnits(2500), // $25.00 (auto-executes $20 payments)
    hard_cap_minor: toMinorUnits(10000), // $100.00
    agent_daily_budget_minor: toMinorUnits(10000), // $100.00
    global_daily_budget_minor: toMinorUnits(10000), // $100.00 (exactly 5 x $20)
    velocity: { max_requests: 100, window_minutes: 60 },
    duplicate_window_minutes: 0, // Disabled so duplicate rule does not mask budget competition
    new_vendor_action: 'HOLD',
    hold_ttl_minutes: 15,
  };

  const testAgent: AgentRow = {
    id: 'agent-stress-1',
    name: 'Stress Test Agent',
    api_key_hash: 'stress-hash-1',
    status: 'ACTIVE',
    daily_budget_minor: toMinorUnits(10000), // $100.00
    created_at: new Date().toISOString(),
  };

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    // Seed Owner
    repos.owners.upsert({
      id: 'default',
      display_name: 'Primary Owner',
      passphrase_hash: 'hash-abc',
      telegram_chat_id: '123456789',
      telegram_user_id: '987654321',
      created_at: new Date().toISOString(),
    });

    // Seed Policy Version
    repos.policyVersions.insert({
      id: 'pol-stress-v1',
      version: 1,
      rules: JSON.stringify(standardPolicy),
      author: 'owner',
      active: 1,
      created_at: new Date().toISOString(),
    });

    // Seed Agent
    repos.agents.insert(testAgent);

    // Seed Vendor
    repos.vendors.insert({
      id: 'vendor-stress-1',
      name: 'Acme Cloud Services',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud', 'hosting']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    });

    // Setup PayPal Service Mocks
    mockAuthorizationsService = {
      captureAuthorization: vi.fn().mockResolvedValue({
        id: 'cap-stress-123',
        status: 'COMPLETED',
        isCaptured: true,
        amountMinor: toMinorUnits(5000),
        currency: 'USD',
        finalCapture: true,
      } as PayPalCaptureResult),
      voidAuthorization: vi.fn().mockResolvedValue({
        id: 'auth-stress-123',
        status: 'VOIDED',
        isVoided: true,
      }),
      getAuthorization: vi.fn(),
    } as unknown as PayPalAuthorizationsService;

    mockOrdersService = {
      createOrder: vi.fn(),
      getOrder: vi.fn(),
    } as unknown as PayPalOrdersService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetInFlightExecutionsForTest();
    if (db.open) {
      db.close();
    }
  });

  // ==========================================================================
  // 1. Budget Competition
  // ==========================================================================
  describe('1. Budget Competition', () => {
    it('handles 20 simultaneous payment requests competing for $100 budget ($20 each): exactly 5 succeed, zero overspending', async () => {
      const requestCount = 20;
      const requestAmountMinor = toMinorUnits(2000); // $20.00 each
      const budgetMinor = toMinorUnits(10000); // $100.00 total

      // Prepare 20 distinct requests
      const requests = Array.from({ length: requestCount }, (_, i) => ({
        agentId: testAgent.id,
        vendorId: 'vendor-stress-1',
        amountMinor: requestAmountMinor,
        currency: 'USD',
        purpose: `Cloud compute cluster node ${i + 1}`,
        category: 'cloud',
        idempotencyKey: `idemp-budget-comp-${i + 1}`,
      }));

      // Execute all 20 requests concurrently
      const results = await Promise.all(
        requests.map((params) => evaluateAndReserve(db, params, repos))
      );

      // Verify outcomes
      const allowed = results.filter((r) => r.decision === 'ALLOW');
      const denied = results.filter((r) => r.decision === 'DENY');

      // Exactly 5 payments may consume the $100 budget
      expect(allowed).toHaveLength(5);
      expect(denied).toHaveLength(15);

      // All allowed requests must be AUTO_EXECUTING
      for (const res of allowed) {
        expect(res.request.status).toBe('AUTO_EXECUTING');
        expect(res.isIdempotentReplay).toBe(false);
      }

      // All denied requests must be DENIED due to budget limit
      for (const res of denied) {
        expect(res.request.status).toBe('DENIED');
        expect(res.reasons).toEqual(expect.arrayContaining(['GLOBAL_BUDGET_EXCEEDED']));
      }

      // Verify Ledger Invariants: exactly 5 RESERVE rows
      const ledgerRows = db.prepare('SELECT * FROM ledger').all() as LedgerRow[];

      expect(ledgerRows).toHaveLength(5);
      for (const row of ledgerRows) {
        expect(row.kind).toBe('RESERVE');
        expect(row.amount_minor).toBe(requestAmountMinor);
      }

      // Verify Total Reserved Amount is exactly equal to budget and no more
      const totalReserved = ledgerRows.reduce((acc, row) => acc + row.amount_minor, 0);
      expect(totalReserved).toBe(budgetMinor);

      // Verify audit trail integrity across all 20 evaluations
      const auditChain = verifyDatabaseAuditChain(db);
      expect(auditChain.valid).toBe(true);
    });
  });

  // ==========================================================================
  // 2. Concurrent Idempotency
  // ==========================================================================
  describe('2. Concurrent Idempotency', () => {
    it('handles 10 simultaneous identical requests: exactly 1 execution, 9 replays, 1 DB record, 1 financial reservation', async () => {
      const fixedParams = {
        agentId: testAgent.id,
        vendorId: 'vendor-stress-1',
        amountMinor: toMinorUnits(1500), // $15.00
        currency: 'USD',
        purpose: 'Continuous deployment runner',
        category: 'cloud',
        idempotencyKey: 'idemp-concurrent-identical-key',
      };

      // Fire 10 simultaneous requests with the exact same payload & idempotency key
      const results = await Promise.all(
        Array.from({ length: 10 }, () => evaluateAndReserve(db, fixedParams, repos))
      );

      // All 10 callers receive successful ALLOW responses
      expect(results).toHaveLength(10);
      for (const res of results) {
        expect(res.decision).toBe('ALLOW');
        expect(res.request.amount_minor).toBe(toMinorUnits(1500));
        expect(res.request.idempotency_key).toBe('idemp-concurrent-identical-key');
      }

      // Exactly 1 execution and 9 idempotent replays
      const firstExecutions = results.filter((r) => !r.isIdempotentReplay);
      const replays = results.filter((r) => r.isIdempotentReplay);

      expect(firstExecutions).toHaveLength(1);
      expect(replays).toHaveLength(9);

      // All 10 returned requests must share the EXACT SAME request ID
      const canonicalRequestId = firstExecutions[0]!.request.id;
      for (const res of results) {
        expect(res.request.id).toBe(canonicalRequestId);
      }

      // Database Record Invariant: Exactly one record in payment_requests table
      const storedRequests = db
        .prepare('SELECT * FROM payment_requests WHERE idempotency_key = ?')
        .all('idemp-concurrent-identical-key') as PaymentRequestRow[];
      expect(storedRequests).toHaveLength(1);
      expect(storedRequests[0]!.id).toBe(canonicalRequestId);

      // Financial Execution Invariant: Exactly one RESERVE row in the ledger
      const ledgerRows = db
        .prepare('SELECT * FROM ledger WHERE request_id = ?')
        .all(canonicalRequestId) as LedgerRow[];
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]!.kind).toBe('RESERVE');
      expect(ledgerRows[0]!.amount_minor).toBe(toMinorUnits(1500));

      // Audit Log Invariant: Exactly one initial state transition audit log entry (replays do not append duplicate audits)
      const auditRows = db
        .prepare('SELECT * FROM audit_log WHERE request_id = ?')
        .all(canonicalRequestId) as AuditLogRow[];
      const evalAudits = auditRows.filter((a) => a.event === 'TRANSITION_TO_AUTO_EXECUTING');
      expect(evalAudits).toHaveLength(1);
    });

    it('MCP handleRequestPayment layer: 10 simultaneous calls yield 1 execution and 9 replays with identical sanitized payloads', async () => {
      const input = {
        vendor_id: 'vendor-stress-1',
        amount: '15.00',
        currency: 'USD',
        purpose: 'Continuous deployment runner',
        category: 'cloud',
        idempotency_key: 'idemp-mcp-concurrent-key',
      };

      const results = await agentContextStorage.run(
        { agentId: testAgent.id, agent: testAgent },
        async () => {
          return Promise.all(
            Array.from({ length: 10 }, () => handleRequestPayment(db, input, repos))
          );
        }
      );

      // All 10 must succeed without error
      expect(results).toHaveLength(10);
      const parsedBodies = results.map((res) => {
        expect(res.isError).toBeFalsy();
        const firstContent = res.content[0];
        expect(firstContent?.type).toBe('text');
        const textContent = firstContent && firstContent.type === 'text' ? firstContent.text : '{}';
        return JSON.parse(textContent);
      });

      // All 10 return the identical request_id and status
      const firstId = parsedBodies[0].request_id;
      expect(firstId).toBeDefined();
      for (const body of parsedBodies) {
        expect(body.request_id).toBe(firstId);
        expect(body.decision).toBe('ALLOW');
      }

      // Exactly 1 payment request stored in DB
      const dbRows = db
        .prepare('SELECT COUNT(*) as cnt FROM payment_requests WHERE idempotency_key = ?')
        .get('idemp-mcp-concurrent-key') as { cnt: number };
      expect(dbRows.cnt).toBe(1);
    });
  });

  // ==========================================================================
  // 3. Idempotency Conflicts
  // ==========================================================================
  describe('3. Idempotency Conflicts', () => {
    it('handles 5 simultaneous requests with same key but differing amounts: exactly 1 wins, 4 receive sanitized conflicts', async () => {
      const sharedKey = 'idemp-conflict-differing-amounts';
      const amounts = [
        toMinorUnits(1000),
        toMinorUnits(2000),
        toMinorUnits(3000),
        toMinorUnits(4000),
        toMinorUnits(5000),
      ]; // $10, $20, $30, $40, $50

      const promises = amounts.map(async (amt) =>
        evaluateAndReserve(
          db,
          {
            agentId: testAgent.id,
            vendorId: 'vendor-stress-1',
            amountMinor: amt,
            currency: 'USD',
            purpose: 'Contested compute server',
            category: 'cloud',
            idempotencyKey: sharedKey,
          },
          repos
        )
      );

      const settled = await Promise.allSettled(promises);

      // Exactly one request must be fulfilled (the winner)
      const fulfilled = settled.filter(
        (r): r is PromiseFulfilledResult<EvaluateAndReserveResult> => r.status === 'fulfilled'
      );
      const rejected = settled.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(4);

      // Winner details
      const winner = fulfilled[0]!.value;
      expect(winner.isIdempotentReplay).toBe(false);
      expect(winner.decision).toBe('ALLOW');
      const winningAmount = winner.request.amount_minor;

      // The 4 losers must receive IdempotencyConflictError
      for (const rej of rejected) {
        expect(rej.reason).toBeInstanceOf(IdempotencyConflictError);
        expect(rej.reason.message).toContain('Idempotency conflict: key');
        expect(rej.reason.message).toContain(sharedKey);
        expect(rej.reason.existingRequestId).toBe(winner.request.id);
      }

      // Database integrity: exactly 1 payment request record exists for this key
      const storedRequests = db
        .prepare('SELECT * FROM payment_requests WHERE idempotency_key = ?')
        .all(sharedKey) as PaymentRequestRow[];
      expect(storedRequests).toHaveLength(1);
      expect(storedRequests[0]!.amount_minor).toBe(winningAmount);

      // Ledger integrity: exactly 1 RESERVE row exists corresponding strictly to the winning payload
      const ledgerRows = db
        .prepare('SELECT * FROM ledger WHERE request_id = ?')
        .all(winner.request.id) as LedgerRow[];
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]!.amount_minor).toBe(winningAmount);
    });

    it('MCP handleRequestPayment layer: 5 simultaneous conflicting calls yield 1 success and 4 sanitized IDEMPOTENCY_CONFLICT errors', async () => {
      const sharedKey = 'idemp-conflict-mcp-key';
      const amounts = ['10.00', '20.00', '30.00', '40.00', '50.00'];

      const settled = await agentContextStorage.run(
        { agentId: testAgent.id, agent: testAgent },
        async () => {
          return Promise.all(
            amounts.map((amount) =>
              handleRequestPayment(
                db,
                {
                  vendor_id: 'vendor-stress-1',
                  amount,
                  currency: 'USD',
                  purpose: 'Contested payment via MCP',
                  category: 'cloud',
                  idempotency_key: sharedKey,
                },
                repos
              )
            )
          );
        }
      );

      // Exactly 1 success (isError is false/undefined)
      const successful = settled.filter((res) => !res.isError);
      const conflicts = settled.filter((res) => res.isError);

      expect(successful).toHaveLength(1);
      expect(conflicts).toHaveLength(4);

      // Verify sanitized error text: no internal stack traces, leaked tokens, or SQL
      for (const conflict of conflicts) {
        const firstContent = conflict.content[0];
        const text = firstContent && firstContent.type === 'text' ? firstContent.text : '';
        expect(text).toContain('IDEMPOTENCY_CONFLICT');
        expect(text).toContain(sharedKey);
        expect(text).toContain('differing request parameters');
        expect(text).not.toContain('SqliteError');
        expect(text).not.toContain('stack');
      }
    });
  });

  // ==========================================================================
  // 4. Capture versus Expiry Race
  // ==========================================================================
  describe('4. Capture versus Expiry Race', () => {
    it('simultaneous approval capture and hold expiration produce exactly 1 terminal state; never both SPEND and RELEASE', async () => {
      const requestId = 'req-race-cap-exp-1';
      const amountMinor = toMinorUnits(5000); // $50.00
      const futureIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const pastIso = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago (expired)

      // Seed a HELD payment request with initially valid expiration
      repos.paymentRequests.insert({
        id: requestId,
        agent_id: testAgent.id,
        idempotency_key: 'idemp-race-cap-exp-1',
        vendor_id: 'vendor-stress-1',
        amount_minor: amountMinor,
        currency: 'USD',
        purpose: 'Raced hold payment',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'HELD',
        decision: 'HOLD',
        reasons: JSON.stringify(['HIGH_AMOUNT']),
        policy_version_id: 'pol-stress-v1',
        snapshot_hash: 'placeholder',
        paypal_order_id: null,
        paypal_authorization_id: 'auth-race-1',
        paypal_capture_id: null,
        expires_at: futureIso,
        remote_void_status: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Compute and update deterministic snapshot hash
      const snapshotHash = computeSnapshotHash({
        requestId,
        agentId: testAgent.id,
        vendorId: 'vendor-stress-1',
        amountMinor,
        currency: 'USD',
        purpose: 'Raced hold payment',
        category: 'cloud',
      });
      db.prepare('UPDATE payment_requests SET snapshot_hash = ? WHERE id = ?').run(
        snapshotHash,
        requestId
      );

      // Seed initial RESERVE ledger entry
      repos.ledger.insert({
        id: `led-reserve-${requestId}`,
        request_id: requestId,
        kind: 'RESERVE',
        amount_minor: amountMinor,
        currency: 'USD',
        created_at: new Date().toISOString(),
      });

      // Mint valid web approval token while hold is valid
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
        channel: 'web',
      });
      expect(mintResult.success).toBe(true);
      const rawToken = mintResult.rawToken!;

      // Now set expires_at into the past to simulate the hold expiring concurrently with owner approval
      db.prepare('UPDATE payment_requests SET expires_at = ? WHERE id = ?').run(
        pastIso,
        requestId
      );

      const approvalService = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
        ordersService: mockOrdersService,
      });

      // Execute approval capture and hold expiry concurrently
      const [approveResult, expireResult] = await Promise.allSettled([
        approvalService.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'web',
            rawToken,
            ownerId: 'default',
            ownerDisplayName: 'Primary Owner',
          },
        }),
        expirePaymentHold(db, requestId, {
          repos,
          authorizationsService: mockAuthorizationsService,
          now: new Date(),
        }),
      ]);

      // Both promises must settle cleanly without unhandled rejection crashes
      expect(approveResult).toBeDefined();
      expect(expireResult).toBeDefined();

      // Read final state from database
      const finalReq = repos.paymentRequests.getById(requestId)!;
      expect(['CAPTURED', 'VOIDED']).toContain(finalReq.status);

      // Read all ledger rows for this request
      const ledgerRows = repos.ledger.listByRequestId(requestId);
      const hasReserve = ledgerRows.some((l) => l.kind === 'RESERVE');
      const hasSpend = ledgerRows.some((l) => l.kind === 'SPEND');
      const hasRelease = ledgerRows.some((l) => l.kind === 'RELEASE');

      // CRITICAL FINANCIAL INVARIANT:
      // Must have original RESERVE
      expect(hasReserve).toBe(true);

      // NEVER both SPEND and RELEASE for the same reservation!
      expect(hasSpend && hasRelease).toBe(false);
      expect(Number(hasSpend) + Number(hasRelease)).toBe(1);

      if (finalReq.status === 'CAPTURED') {
        expect(hasSpend).toBe(true);
        expect(hasRelease).toBe(false);
        // Expiry must have yielded NO_OP
        if (expireResult.status === 'fulfilled') {
          expect(expireResult.value.actionTaken).toBe('NO_OP');
        }
      } else {
        expect(finalReq.status).toBe('VOIDED');
        expect(hasRelease).toBe(true);
        expect(hasSpend).toBe(false);
        // Approve must have failed validation or execution
        if (approveResult.status === 'rejected') {
          expect(approveResult.reason).toBeInstanceOf(ApprovalValidationError);
        } else {
          expect(approveResult.value.success).toBe(false);
        }
      }

      // Verify audit chain remains strictly valid
      const auditChain = verifyDatabaseAuditChain(db);
      expect(auditChain.valid).toBe(true);
    });
  });

  // ==========================================================================
  // 5. SQLite Contention
  // ==========================================================================
  describe('5. SQLite Contention', () => {
    let tempDir: string;
    let diskDbPath: string;
    let dbConn1: Database;
    let dbConn2: Database;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-contention-test-'));
      diskDbPath = path.join(tempDir, 'contention.db');

      dbConn1 = createDatabase({ path: diskDbPath });
      runMigrations(dbConn1);

      const repos1 = createRepositories(dbConn1);

      // Seed required entities into disk database for foreign key constraints
      repos1.owners.upsert({
        id: 'default',
        display_name: 'Primary Owner',
        passphrase_hash: 'hash-abc',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        created_at: new Date().toISOString(),
      });

      repos1.policyVersions.insert({
        id: 'pol-stress-v1',
        version: 1,
        rules: JSON.stringify(standardPolicy),
        author: 'owner',
        active: 1,
        created_at: new Date().toISOString(),
      });

      repos1.agents.insert(testAgent);

      repos1.vendors.insert({
        id: 'vendor-stress-1',
        name: 'Acme Cloud Services',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud', 'hosting']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'acme_cloud',
        created_at: new Date().toISOString(),
      });

      // Seed base payment requests for ledger foreign key references
      repos1.paymentRequests.insert({
        id: 'req-contention-bad-1',
        agent_id: testAgent.id,
        idempotency_key: 'idemp-contention-bad-1',
        vendor_id: 'vendor-stress-1',
        amount_minor: toMinorUnits(1000),
        currency: 'USD',
        purpose: 'Contention base request',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'RECEIVED',
        decision: null,
        reasons: null,
        policy_version_id: 'pol-stress-v1',
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      repos1.paymentRequests.insert({
        id: 'req-contention-good-1',
        agent_id: testAgent.id,
        idempotency_key: 'idemp-contention-good-1',
        vendor_id: 'vendor-stress-1',
        amount_minor: toMinorUnits(1000),
        currency: 'USD',
        purpose: 'Contention base request good',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'RECEIVED',
        decision: null,
        reasons: null,
        policy_version_id: 'pol-stress-v1',
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    });

    afterEach(() => {
      if (dbConn1?.open) dbConn1.close();
      if (dbConn2?.open) dbConn2.close();
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignored on file handle lock teardown
      }
    });

    it('handles lock contention / SQLITE_BUSY gracefully: zero partial mutations when transaction fails', () => {
      // dbConn2 opened with a 50ms busy timeout to induce fast SQLITE_BUSY on lock contention
      dbConn2 = createDatabase({ path: diskDbPath, timeout: 50 });
      const repos2 = createRepositories(dbConn2);

      // Connection 1 acquires the exclusive write lock via BEGIN IMMEDIATE
      dbConn1.exec('BEGIN IMMEDIATE');

      let busiedError: Error | undefined;
      try {
        // Connection 2 attempts to write while Connection 1 holds the lock
        runInTransaction(dbConn2, () => {
          repos2.ledger.insert({
            id: 'led-contention-bad-1',
            request_id: 'req-contention-bad-1',
            kind: 'RESERVE',
            amount_minor: toMinorUnits(1000),
            currency: 'USD',
            created_at: new Date().toISOString(),
          });
        });
      } catch (err: unknown) {
        busiedError = err as Error;
      }

      // Release Connection 1's lock
      dbConn1.exec('ROLLBACK');

      // Verify that Connection 2 received SQLITE_BUSY / database is locked
      expect(busiedError).toBeDefined();
      expect(busiedError?.message).toMatch(/database is locked|busy/i);

      // Verify Atomicity: Zero partial rows from Connection 2 were committed
      const rows = dbConn1.prepare('SELECT * FROM ledger WHERE id = ?').all('led-contention-bad-1');
      expect(rows).toHaveLength(0);

      // After release, Connection 2 can execute normally and commit atomically
      expect(() => {
        runInTransaction(dbConn2, () => {
          repos2.ledger.insert({
            id: 'led-contention-good-1',
            request_id: 'req-contention-good-1',
            kind: 'RESERVE',
            amount_minor: toMinorUnits(1000),
            currency: 'USD',
            created_at: new Date().toISOString(),
          });
        });
      }).not.toThrow();

      const committed = dbConn1.prepare('SELECT * FROM ledger WHERE id = ?').all('led-contention-good-1');
      expect(committed).toHaveLength(1);
    });

    it('aborted transaction rolls back all mutations atomically: no partial financial mutations on mid-flight crash', () => {
      const repos1 = createRepositories(dbConn1);

      // Execute a multi-table financial transaction that throws mid-flight
      expect(() => {
        runInTransaction(dbConn1, () => {
          // 1. Insert payment request
          repos1.paymentRequests.insert({
            id: 'req-crash-rollback-1',
            agent_id: testAgent.id,
            idempotency_key: 'idemp-crash-1',
            vendor_id: 'vendor-stress-1',
            amount_minor: toMinorUnits(3000),
            currency: 'USD',
            purpose: 'Simulated crash payment',
            category: 'cloud',
            source_context_excerpt: null,
            source_context_hash: null,
            status: 'RECEIVED',
            decision: null,
            reasons: null,
            policy_version_id: 'pol-stress-v1',
            snapshot_hash: null,
            paypal_order_id: null,
            paypal_authorization_id: null,
            paypal_capture_id: null,
            expires_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });

          // 2. Insert ledger reservation
          repos1.ledger.insert({
            id: 'led-crash-rollback-1',
            request_id: 'req-crash-rollback-1',
            kind: 'RESERVE',
            amount_minor: toMinorUnits(3000),
            currency: 'USD',
            created_at: new Date().toISOString(),
          });

          // 3. Simulated crash / disk error
          throw new Error('SIMULATED_DISK_IO_FAILURE_MID_TRANSACTION');
        });
      }).toThrow('SIMULATED_DISK_IO_FAILURE_MID_TRANSACTION');

      // Verify absolute atomicity: neither the request NOR the ledger entry persisted
      const reqRows = dbConn1.prepare('SELECT * FROM payment_requests WHERE id = ?').all('req-crash-rollback-1');
      const ledgerRows = dbConn1.prepare('SELECT * FROM ledger WHERE id = ?').all('led-crash-rollback-1');

      expect(reqRows).toHaveLength(0);
      expect(ledgerRows).toHaveLength(0);
    });

    it('parallel concurrent transactions across multiple connections complete without deadlock or corruption', async () => {
      dbConn2 = createDatabase({ path: diskDbPath }); // default 5000ms busy timeout
      const repos1 = createRepositories(dbConn1);
      const repos2 = createRepositories(dbConn2);

      const workerCount = 10;

      // Seed payment requests first
      for (let i = 0; i < workerCount; i++) {
        repos1.paymentRequests.insert({
          id: `req-parallel-${i}`,
          agent_id: testAgent.id,
          idempotency_key: `idemp-parallel-${i}`,
          vendor_id: 'vendor-stress-1',
          amount_minor: toMinorUnits(500),
          currency: 'USD',
          purpose: 'Parallel worker payment',
          category: 'cloud',
          source_context_excerpt: null,
          source_context_hash: null,
          status: 'RECEIVED',
          decision: null,
          reasons: null,
          policy_version_id: 'pol-stress-v1',
          snapshot_hash: null,
          paypal_order_id: null,
          paypal_authorization_id: null,
          paypal_capture_id: null,
          expires_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }

      // Run 10 parallel transactions interleaved across both connection instances
      const parallelTasks = Array.from({ length: workerCount }, (_, i) => {
        const connRepos = i % 2 === 0 ? repos1 : repos2;
        const connDb = i % 2 === 0 ? dbConn1 : dbConn2;

        return Promise.resolve().then(() => {
          runInTransaction(connDb, () => {
            connRepos.ledger.insert({
              id: `led-parallel-${i}`,
              request_id: `req-parallel-${i}`,
              kind: 'RESERVE',
              amount_minor: toMinorUnits(500),
              currency: 'USD',
              created_at: new Date().toISOString(),
            });
          });
        });
      });

      await Promise.all(parallelTasks);

      // Verify all 10 rows committed cleanly without lock starvation or corruption
      const totalLedger = dbConn1.prepare("SELECT COUNT(*) as cnt FROM ledger WHERE id LIKE 'led-parallel-%'").get() as { cnt: number };
      expect(totalLedger.cnt).toBe(workerCount);
    });
  });
});
