/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T4.4: Crash Recovery & Resilience Testing
 *
 * Verifies system recovery across:
 * A. SQLite transaction crash recovery (uncommitted rollback, no orphans, committed preserved)
 * B. Payment execution interruption (interruption at capture boundary, safe reconciliation, no blind retry)
 * C. Reconciler worker restart (pending recovery, candidate isolation, no duplicate terminal transitions)
 * D. Telegram outbox restart (lease expiration recovery, at-least-once delivery, durable outbox vs in-memory timer survival)
 * E. Ambiguous remote outcomes (timeout/connection reset recovery, fail-closed handling, no duplicate SPEND/RELEASE)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createDatabase,
  runMigrations,
  type Database,
} from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import { toMinorUnits } from '../../src/core/money.js';
import {
  executeDecision,
  _resetInFlightExecutionsForTest,
} from '../../src/core/executeDecision.js';
import {
  reconcilePaymentRequest,
  reconcilePendingRequests,
  ReconcilerWorker,
} from '../../src/paypal/reconcile.js';
import { NotificationOutboxWorker } from '../../src/telegram/outboxWorker.js';
import { TelegramClient } from '../../src/telegram/client.js';
import { verifyDatabaseAuditChain } from '../../src/core/stateMachine.js';
import type {
  PayPalAuthorizationsService,
  PayPalAuthorizationDetails,
} from '../../src/paypal/authorizations.js';
import type { PayPalOrdersService, PayPalOrderResult } from '../../src/paypal/orders.js';
import type {
  PaymentRequestRow,
  NotificationOutboxRow,
  AgentRow,
} from '../../src/db/types.js';
import type { PolicyDocument } from '../../src/policy/types.js';

describe('M6-T4.4: Crash Recovery & Resilience Testing', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database;
  let repos: Repositories;

  let mockAuthorizationsService: PayPalAuthorizationsService;
  let mockOrdersService: PayPalOrdersService;
  let mockTelegramClient: TelegramClient;

  const testAgent: AgentRow = {
    id: 'agent-crash-1',
    name: 'Crash Recovery Agent',
    api_key_hash: 'crash-key-hash-1',
    status: 'ACTIVE',
    daily_budget_minor: toMinorUnits(100000), // $1,000.00
    created_at: new Date().toISOString(),
  };

  const standardPolicy: PolicyDocument = {
    version: 1,
    currency_allowlist: ['USD'],
    auto_limit_minor: toMinorUnits(5000), // $50.00
    hard_cap_minor: toMinorUnits(10000), // $100.00
    agent_daily_budget_minor: toMinorUnits(100000),
    global_daily_budget_minor: toMinorUnits(100000),
    velocity: { max_requests: 100, window_minutes: 60 },
    duplicate_window_minutes: 0,
    new_vendor_action: 'HOLD',
    hold_ttl_minutes: 15,
  };

  beforeEach(() => {
    // Disk-backed SQLite database in a temporary directory for true crash and reopen testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-crash-test-'));
    dbPath = path.join(tempDir, 'recovery.db');

    db = createDatabase({ path: dbPath });
    runMigrations(db);
    repos = createRepositories(db);

    // Seed baseline entities
    repos.owners.upsert({
      id: 'default',
      display_name: 'Primary Owner',
      passphrase_hash: 'hash-abc',
      telegram_chat_id: '123456789',
      telegram_user_id: '987654321',
      created_at: new Date().toISOString(),
    });
    repos.owners.linkTelegram({
      ownerId: 'default',
      chatId: '123456789',
      userId: '987654321',
      username: 'alice',
      linkedAtIso: '2026-11-04T00:00:00.000Z',
    });

    repos.policyVersions.insert({
      id: 'pol-crash-v1',
      version: 1,
      rules: JSON.stringify(standardPolicy),
      author: 'owner',
      active: 1,
      created_at: new Date().toISOString(),
    });

    repos.agents.insert(testAgent);

    repos.vendors.insert({
      id: 'vendor-crash-1',
      name: 'Acme Cloud Infrastructure',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud', 'hosting']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    });

    repos.vendorVaultTokens.insert({
      id: 'vtok-crash-1',
      vendor_id: 'vendor-crash-1',
      paypal_customer_ref: 'cust-crash-1',
      vault_token_id: 'vault-tok-crash-12345',
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
    });

    // Mocks
    mockAuthorizationsService = {
      captureAuthorization: vi.fn(),
      voidAuthorization: vi.fn(),
      getAuthorization: vi.fn(),
    } as unknown as PayPalAuthorizationsService;

    mockOrdersService = {
      createOrder: vi.fn(),
      getOrder: vi.fn(),
    } as unknown as PayPalOrdersService;

    mockTelegramClient = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 101, ok: true }),
      editMessageText: vi.fn().mockResolvedValue({ message_id: 101, ok: true }),
    } as unknown as TelegramClient;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetInFlightExecutionsForTest();
    if (db?.open) {
      db.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignored on file handle lock teardown
    }
  });

  function seedRequest(
    status: PaymentRequestRow['status'],
    overrides?: Partial<PaymentRequestRow>
  ): PaymentRequestRow {
    const id = overrides?.id ?? `req-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const amountMinor = overrides?.amount_minor ?? toMinorUnits(2500); // $25.00
    const nowIso = new Date().toISOString();

    const request: PaymentRequestRow = {
      id,
      agent_id: testAgent.id,
      idempotency_key: overrides?.idempotency_key ?? `idemp-${id}`,
      vendor_id: 'vendor-crash-1',
      amount_minor: amountMinor,
      currency: 'USD',
      purpose: 'Crash recovery payment',
      category: 'cloud',
      source_context_excerpt: null,
      source_context_hash: null,
      status,
      decision: status === 'AUTO_EXECUTING' || status === 'CAPTURED' ? 'ALLOW' : 'HOLD',
      reasons: JSON.stringify([]),
      policy_version_id: 'pol-crash-v1',
      snapshot_hash: 'snap-hash-123',
      paypal_order_id: overrides?.paypal_order_id ?? null,
      paypal_authorization_id: overrides?.paypal_authorization_id ?? null,
      paypal_capture_id: overrides?.paypal_capture_id ?? null,
      expires_at: overrides?.expires_at ?? null,
      remote_void_status: overrides?.remote_void_status ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    repos.paymentRequests.insert(request);

    // Initial budget reservation
    repos.ledger.insert({
      id: `led-reserve-${id}`,
      request_id: id,
      kind: 'RESERVE',
      amount_minor: amountMinor,
      currency: 'USD',
      created_at: nowIso,
    });

    return request;
  }

  // ==========================================================================
  // A. SQLite Transaction Crash Recovery
  // ==========================================================================
  describe('A. SQLite Transaction Crash Recovery', () => {
    it('rolls back interrupted uncommitted transaction upon crash & reopen: no orphaned payment, ledger, audit, or outbox records exist', () => {
      // 1. Commit a valid baseline payment
      const committedReq = seedRequest('AUTO_EXECUTING', { id: 'req-committed-baseline' });

      // 2. Open an uncommitted transaction simulating a crash before commit
      db.exec('BEGIN IMMEDIATE');

      // Write multi-table mutation
      repos.paymentRequests.insert({
        id: 'req-interrupted-crash-1',
        agent_id: testAgent.id,
        idempotency_key: 'idemp-interrupted-1',
        vendor_id: 'vendor-crash-1',
        amount_minor: toMinorUnits(4000),
        currency: 'USD',
        purpose: 'Interrupted payment during crash',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'RECEIVED',
        decision: null,
        reasons: null,
        policy_version_id: 'pol-crash-v1',
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      repos.ledger.insert({
        id: 'led-interrupted-1',
        request_id: 'req-interrupted-crash-1',
        kind: 'RESERVE',
        amount_minor: toMinorUnits(4000),
        currency: 'USD',
        created_at: new Date().toISOString(),
      });

      repos.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: 'notif-interrupted-1',
        message_text: 'Interrupted message',
        request_id: 'req-interrupted-crash-1',
      });

      // 3. Simulate process crash by closing connection without COMMIT
      db.close();

      // 4. Reopen database from disk simulating process restart
      const reopenedDb = createDatabase({ path: dbPath });
      const reopenedRepos = createRepositories(reopenedDb);

      try {
        // Interrupted transaction must be completely rolled back
        const crashedReq = reopenedRepos.paymentRequests.getById('req-interrupted-crash-1');
        expect(crashedReq).toBeUndefined();

        const crashedLedger = reopenedRepos.ledger.listByRequestId('req-interrupted-crash-1');
        expect(crashedLedger).toHaveLength(0);

        const crashedNotifs = reopenedDb
          .prepare('SELECT * FROM notification_outbox WHERE request_id = ?')
          .all('req-interrupted-crash-1');
        expect(crashedNotifs).toHaveLength(0);

        // Committed baseline payment remains 100% intact
        const baselineReq = reopenedRepos.paymentRequests.getById(committedReq.id);
        expect(baselineReq).toBeDefined();
        expect(baselineReq?.status).toBe('AUTO_EXECUTING');

        const baselineLedger = reopenedRepos.ledger.listByRequestId(committedReq.id);
        expect(baselineLedger).toHaveLength(1);
        expect(baselineLedger[0]!.kind).toBe('RESERVE');

        // Audit chain on reopened database verifies cleanly
        const auditChain = verifyDatabaseAuditChain(reopenedDb);
        expect(auditChain.valid).toBe(true);
      } finally {
        reopenedDb.close();
      }
    });
  });

  // ==========================================================================
  // B. Payment Execution Interruption
  // ==========================================================================
  describe('B. Payment Execution Interruption', () => {
    it('B.1 Interruption when PayPal did NOT capture: fails closed on direct retry, Reconciler recovers to FAILED with RELEASE', async () => {
      const req = seedRequest('AUTO_EXECUTING', {
        id: 'req-interrupted-not-captured',
        paypal_order_id: 'ord-not-captured-1',
      });

      // Simulate process restart: reset in-flight state and recreate workers
      _resetInFlightExecutionsForTest();

      // 1. Direct retry via executeDecision must FAIL CLOSED and not blindly retry money movement
      await expect(
        executeDecision(db, { requestId: req.id }, {
          repos,
          ordersService: mockOrdersService,
          authorizationsService: mockAuthorizationsService,
        })
      ).rejects.toThrowError('Reconciliation required before retrying');

      // Verify no money moved on direct attempt
      expect(mockOrdersService.createOrder).not.toHaveBeenCalled();

      // 2. Reconciler worker queries authoritative PayPal order status
      vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
        id: 'ord-not-captured-1',
        status: 'VOIDED',
        intent: 'CAPTURE',
        amountMinor: req.amount_minor,
        currency: req.currency,
        isCaptured: false,
      } as PayPalOrderResult);

      const reconcileResult = await reconcilePaymentRequest(db, req.id, {
        repos,
        ordersService: mockOrdersService,
      });

      // Reconciler recovers safely
      expect(reconcileResult.status).toBe('FAILED');
      expect(reconcileResult.reconciled).toBe(true);
      expect(reconcileResult.resolved).toBe(true);

      // Verify database updated to terminal FAILED
      const updatedReq = repos.paymentRequests.getById(req.id)!;
      expect(updatedReq.status).toBe('FAILED');

      // Financial Invariant: Exactly one RELEASE row, zero SPEND rows
      const ledger = repos.ledger.listByRequestId(req.id);
      expect(ledger.filter((l) => l.kind === 'RESERVE')).toHaveLength(1);
      expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(1);
      expect(ledger.filter((l) => l.kind === 'SPEND')).toHaveLength(0);

      // Exactly one terminal notification enqueued
      const notifs = db
        .prepare('SELECT * FROM notification_outbox WHERE request_id = ?')
        .all(req.id) as NotificationOutboxRow[];
      expect(notifs).toHaveLength(1);
      expect(notifs[0]!.event_type).toBe('PAYMENT_FAILED');
    });

    it('B.2 Interruption when PayPal DID capture successfully but PayGuard crashed before persisting: Reconciler recovers to CAPTURED with SPEND', async () => {
      const req = seedRequest('AUTO_EXECUTING', {
        id: 'req-interrupted-captured-remotely',
        paypal_order_id: 'ord-captured-remotely-1',
      });

      // Remote capture succeeded on PayPal
      vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
        id: 'ord-captured-remotely-1',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        amountMinor: req.amount_minor,
        currency: req.currency,
        isCaptured: true,
        capture: {
          id: 'cap-crash-repaired-999',
          status: 'COMPLETED',
          amountMinor: req.amount_minor,
          currency: req.currency,
        },
      } as PayPalOrderResult);

      // Simulate crash and process restart: reopen DB and recreate repos
      db.close();
      const restartedDb = createDatabase({ path: dbPath });
      const restartedRepos = createRepositories(restartedDb);
      _resetInFlightExecutionsForTest();

      try {
        const batchResult = await reconcilePendingRequests(restartedDb, {
          repos: restartedRepos,
          ordersService: mockOrdersService,
        });

        expect(batchResult.totalProcessed).toBe(1);
        expect(batchResult.resolved).toBe(1);

        const recoveredReq = restartedRepos.paymentRequests.getById(req.id)!;
        expect(recoveredReq.status).toBe('CAPTURED');
        expect(recoveredReq.paypal_capture_id).toBe('cap-crash-repaired-999');

        // Financial Invariant: Exactly one SPEND row, zero RELEASE rows
        const ledger = restartedRepos.ledger.listByRequestId(req.id);
        expect(ledger.filter((l) => l.kind === 'RESERVE')).toHaveLength(1);
        expect(ledger.filter((l) => l.kind === 'SPEND')).toHaveLength(1);
        expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(0);

        // Terminal notification enqueued
        const notifs = restartedDb
          .prepare('SELECT * FROM notification_outbox WHERE request_id = ?')
          .all(req.id) as NotificationOutboxRow[];
        expect(notifs).toHaveLength(1);
        expect(notifs[0]!.event_type).toBe('PAYMENT_CAPTURED');

        // Subsequent reconciliation is idempotent NO-OP without duplicate SPEND
        const secondReconcile = await reconcilePaymentRequest(restartedDb, req.id, {
          repos: restartedRepos,
          ordersService: mockOrdersService,
        });
        expect(secondReconcile.actionTaken).toBe('NO_OP');
        expect(restartedRepos.ledger.listByRequestId(req.id).filter((l) => l.kind === 'SPEND')).toHaveLength(1);
      } finally {
        restartedDb.close();
        // Restore connection for afterEach
        db = createDatabase({ path: dbPath });
        repos = createRepositories(db);
      }
    });
  });

  // ==========================================================================
  // C. Reconciler Worker Restart
  // ==========================================================================
  describe('C. Reconciler Worker Restart', () => {
    it('stopped and recreated ReconcilerWorker recovers pending work, isolates failed candidates, and does not duplicate terminal records', async () => {
      // 1. Seed candidate 1: AUTO_EXECUTING, remote COMPLETED
      const req1 = seedRequest('AUTO_EXECUTING', { id: 'req-worker-c1', paypal_order_id: 'ord-w-c1' });

      // 2. Seed candidate 2: AUTO_EXECUTING, remote throws socket error
      const req2 = seedRequest('AUTO_EXECUTING', { id: 'req-worker-c2', paypal_order_id: 'ord-w-c2' });

      // 3. Seed candidate 3: AUTO_EXECUTING, remote VOIDED
      const req3 = seedRequest('AUTO_EXECUTING', { id: 'req-worker-c3', paypal_order_id: 'ord-w-c3' });

      // 4. Seed candidate 4: already CAPTURED (terminal)
      const req4 = seedRequest('CAPTURED', { id: 'req-worker-c4', paypal_order_id: 'ord-w-c4' });
      repos.ledger.insert({
        id: 'led-spend-req-worker-c4',
        request_id: req4.id,
        kind: 'SPEND',
        amount_minor: req4.amount_minor,
        currency: 'USD',
        created_at: new Date().toISOString(),
      });

      // Mock getOrder behavior
      vi.mocked(mockOrdersService.getOrder).mockImplementation(async (orderId: string) => {
        if (orderId === 'ord-w-c1') {
          return {
            id: 'ord-w-c1',
            status: 'COMPLETED',
            intent: 'CAPTURE',
            amountMinor: toMinorUnits(2500),
            currency: 'USD',
            isCaptured: true,
            capture: { id: 'cap-w-c1', status: 'COMPLETED', amountMinor: toMinorUnits(2500), currency: 'USD' },
          } as PayPalOrderResult;
        }
        if (orderId === 'ord-w-c2') {
          throw new Error('ECONNRESET: PayPal socket reset during candidate 2 reconciliation');
        }
        if (orderId === 'ord-w-c3') {
          return {
            id: 'ord-w-c3',
            status: 'VOIDED',
            intent: 'CAPTURE',
            amountMinor: toMinorUnits(2500),
            currency: 'USD',
            isCaptured: false,
          } as PayPalOrderResult;
        }
        throw new Error(`Unexpected orderId: ${orderId}`);
      });

      // Worker 1 runs and is stopped
      const worker1 = new ReconcilerWorker({
        db,
        repos,
        ordersService: mockOrdersService,
        intervalMs: 1000,
      });
      worker1.start();
      expect(worker1.isRunning()).toBe(true);
      worker1.stop();
      expect(worker1.isRunning()).toBe(false);

      // Simulate Worker 2 recreation (process restart)
      const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const worker2 = new ReconcilerWorker({
        db,
        repos,
        ordersService: mockOrdersService,
        logger: mockLogger,
        intervalMs: 1000,
      });

      // Worker 2 executes tick
      const tickResult = await worker2.tick();

      // Only 3 candidates needed reconciliation (req1, req2, req3); req4 was already terminal
      expect(tickResult.totalProcessed).toBe(3);
      expect(tickResult.resolved).toBe(2);
      expect(tickResult.unresolved).toBe(1);

      // Invariants:
      // req1 -> CAPTURED with SPEND
      expect(repos.paymentRequests.getById(req1.id)?.status).toBe('CAPTURED');
      expect(repos.ledger.listByRequestId(req1.id).filter((l) => l.kind === 'SPEND')).toHaveLength(1);

      // req2 -> isolated, remains AUTO_EXECUTING, written to audit log as RECONCILIATION_UNRESOLVED
      expect(repos.paymentRequests.getById(req2.id)?.status).toBe('AUTO_EXECUTING');
      const req2Audits = repos.auditLog.listByRequestId(req2.id);
      const unresolvedAudit = req2Audits.find((a) => a.event === 'RECONCILIATION_UNRESOLVED');
      expect(unresolvedAudit).toBeDefined();
      expect(JSON.stringify(unresolvedAudit?.payload)).toContain('ECONNRESET');

      // req3 -> FAILED with RELEASE
      expect(repos.paymentRequests.getById(req3.id)?.status).toBe('FAILED');
      expect(repos.ledger.listByRequestId(req3.id).filter((l) => l.kind === 'RELEASE')).toHaveLength(1);

      // req4 -> untouched terminal state, no duplicate SPEND
      expect(repos.paymentRequests.getById(req4.id)?.status).toBe('CAPTURED');
      expect(repos.ledger.listByRequestId(req4.id).filter((l) => l.kind === 'SPEND')).toHaveLength(1);
    });
  });

  // ==========================================================================
  // D. Telegram Outbox Restart & Re-Attestation Lifecycle
  // ==========================================================================
  describe('D. Telegram Outbox Restart & Re-Attestation Lifecycle', () => {
    it('recovers abandoned in-flight notification after lease expiration upon worker restart with at-least-once delivery', async () => {
      const req = seedRequest('AUTO_EXECUTING', { id: 'req-outbox-restart-1' });

      // Enqueue notification in SQLite
      repos.notifications.enqueue({
        event_type: 'PAYMENT_CAPTURED',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `notif-abandoned:${req.id}`,
        message_text: 'Payment Captured Message',
        request_id: req.id,
      });

      // Worker 1 claims the job into PROCESSING state
      const crashedClaimId = 'crashed-worker-claim-1';
      const batch = repos.notifications.claimPending(crashedClaimId);
      expect(batch).toHaveLength(1);
      expect(batch[0]!.status).toBe('PROCESSING');

      // Simulate crash 40s ago (exceeding 30s lease) by updating claimed_at in database
      const claimedAt = new Date(Date.now() - 40 * 1000).toISOString();
      db.prepare('UPDATE notification_outbox SET claimed_at = ? WHERE id = ?').run(
        claimedAt,
        batch[0]!.id
      );

      // Simulate process crash: Worker 1 dies while message is in-flight
      // Reopen database and initialize Worker 2
      db.close();
      const restartedDb = createDatabase({ path: dbPath });
      const restartedRepos = createRepositories(restartedDb);

      try {
        const worker2 = new NotificationOutboxWorker({
          db: restartedDb,
          repos: restartedRepos,
          telegramClient: mockTelegramClient,
          leaseDurationMs: 30000,
        });

        // Worker 2 ticks: reclaims abandoned job and delivers
        const processed = await worker2.tick();
        expect(processed).toBe(1);

        // Verification: row delivered and marked SENT
        const row = restartedRepos.notifications.getByDedupKey(`notif-abandoned:${req.id}`);
        expect(row?.status).toBe('SENT');
        expect(mockTelegramClient.sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            chat_id: '123456789',
            text: 'Payment Captured Message',
          })
        );
      } finally {
        restartedDb.close();
        db = createDatabase({ path: dbPath });
        repos = createRepositories(db);
      }
    });

    it('durable terminal notification outbox rows survive process restart; unpersisted in-memory timers do not survive', async () => {
      const req = seedRequest('CAPTURED', { id: 'req-reattest-restart-1' });

      // 1. Persistent Outbox Row: Durable terminal notification enqueued into SQLite
      repos.notifications.enqueue({
        event_type: 'PAYMENT_CAPTURED',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_captured:${req.id}`,
        message_text: 'Authoritative Captured Text',
        request_id: req.id,
      });

      // 2. Simulated In-Memory Re-Attestation Schedule:
      // An in-memory callback / timer (e.g. Node setTimeout) that was scheduled in memory
      let inMemoryReattestExecuted = false;
      const inMemoryTimer = setTimeout(() => {
        inMemoryReattestExecuted = true;
      }, 10000);

      // 3. Simulate abrupt process termination:
      // In-memory timer is lost upon process crash / teardown
      clearTimeout(inMemoryTimer);

      // 4. Reopen DB simulating process restart
      db.close();
      const restartedDb = createDatabase({ path: dbPath });
      const restartedRepos = createRepositories(restartedDb);

      try {
        // Concrete Verification:
        // A) The in-memory timer DID NOT survive the restart
        expect(inMemoryReattestExecuted).toBe(false);

        // B) The durable SQLite outbox row DID survive the restart
        const persistentRow = restartedRepos.notifications.getByDedupKey(`payment_captured:${req.id}`);
        expect(persistentRow).toBeDefined();
        expect(persistentRow?.status).toBe('PENDING');

        // C) The restarted outbox worker processes the persistent notification cleanly
        const worker = new NotificationOutboxWorker({
          db: restartedDb,
          repos: restartedRepos,
          telegramClient: mockTelegramClient,
        });

        await worker.tick();
        const deliveredRow = restartedRepos.notifications.getByDedupKey(`payment_captured:${req.id}`);
        expect(deliveredRow?.status).toBe('SENT');
      } finally {
        restartedDb.close();
        db = createDatabase({ path: dbPath });
        repos = createRepositories(db);
      }
    });
  });

  // ==========================================================================
  // E. Ambiguous Remote Outcomes
  // ==========================================================================
  describe('E. Ambiguous Remote Outcomes', () => {
    it('E.1 Ambiguous capture timeout/connection reset leaves CAPTURING: prevents blind retry, reconciles to CAPTURED without duplicate SPEND', async () => {
      const req = seedRequest('CAPTURING', {
        id: 'req-ambiguous-timeout-1',
        paypal_authorization_id: 'auth-ambig-timeout-1',
      });

      // 1. Direct retry of in-flight CAPTURING request fails closed
      await expect(
        executeDecision(db, { requestId: req.id }, {
          repos,
          authorizationsService: mockAuthorizationsService,
          ordersService: mockOrdersService,
        })
      ).rejects.toThrowError('Reconciliation required before retrying');

      // 2. Remote PayPal inquiry reveals authorization WAS captured
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'auth-ambig-timeout-1',
        status: 'CAPTURED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: true,
        isCapturable: false,
      } as PayPalAuthorizationDetails);

      // 3. Reconciler resolves remote state safely
      const result = await reconcilePaymentRequest(db, req.id, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(result.status).toBe('CAPTURED');
      expect(result.reconciled).toBe(true);

      const finalReq = repos.paymentRequests.getById(req.id)!;
      expect(finalReq.status).toBe('CAPTURED');

      // Financial Invariants: Exactly 1 RESERVE, exactly 1 SPEND, 0 RELEASE
      const ledger = repos.ledger.listByRequestId(req.id);
      expect(ledger.filter((l) => l.kind === 'RESERVE')).toHaveLength(1);
      expect(ledger.filter((l) => l.kind === 'SPEND')).toHaveLength(1);
      expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(0);

      // Audit chain verified intact
      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });

    it('E.2 Unresolved ambiguity (remote authorization remains CREATED/pending) fails closed: remains UNRESOLVED with zero SPEND or RELEASE', async () => {
      const req = seedRequest('CAPTURING', {
        id: 'req-ambiguous-unresolved-1',
        paypal_authorization_id: 'auth-ambig-unresolved-1',
      });

      // Remote authorization is still in CREATED state (inconclusive / pending review)
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'auth-ambig-unresolved-1',
        status: 'CREATED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
        isCapturable: true,
      } as PayPalAuthorizationDetails);

      const result = await reconcilePaymentRequest(db, req.id, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      // Must remain UNRESOLVED (fail closed, never assume capture or void)
      expect(result.status).toBe('UNRESOLVED');
      expect(result.reconciled).toBe(false);
      expect(result.isUnresolved).toBe(true);

      // Request remains in CAPTURING status
      const currentReq = repos.paymentRequests.getById(req.id)!;
      expect(currentReq.status).toBe('CAPTURING');

      // Financial Invariant: ZERO SPEND, ZERO RELEASE rows created during ambiguous state
      const ledger = repos.ledger.listByRequestId(req.id);
      expect(ledger.filter((l) => l.kind === 'RESERVE')).toHaveLength(1);
      expect(ledger.filter((l) => l.kind === 'SPEND')).toHaveLength(0);
      expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(0);
    });
  });
});
