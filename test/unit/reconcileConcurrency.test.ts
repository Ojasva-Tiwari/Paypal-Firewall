/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T4.2: Reconciler Concurrency & Batch Resilience Unit Tests
 *
 * Verifies:
 * 1. Safe handling of concurrent reconciliation races without unhandled rejections.
 * 2. Deduplication of SPEND/RELEASE ledger mutations and outbox notifications under concurrency.
 * 3. Batch candidate isolation: failure of one candidate never aborts subsequent candidates.
 * 4. Authoritative conflict detection: conflicting terminal states remain UNRESOLVED.
 */

import * as crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, runMigrations } from '../../src/db/connection.js';
import type { Database } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/repositories.js';
import type { Repositories } from '../../src/db/repositories.js';
import type { PaymentRequestRow, LedgerRow, NotificationOutboxRow } from '../../src/db/types.js';
import type { PaymentRequestStatus } from '../../src/core/stateMachine.js';
import { toMinorUnits } from '../../src/core/money.js';
import {
  reconcilePaymentRequest,
  reconcilePendingRequests,
  ReconcilerWorker,
  type ReconcileRequestOptions,
} from '../../src/paypal/reconcile.js';
import type { PayPalOrdersService, PayPalOrderResult } from '../../src/paypal/orders.js';
import type {
  PayPalAuthorizationsService,
  PayPalAuthorizationDetails,
} from '../../src/paypal/authorizations.js';
import { _resetInFlightExecutionsForTest } from '../../src/core/executeDecision.js';

describe('M6-T4.2: Reconciler Concurrency & Batch Resilience', () => {
  let db: Database;
  let repos: Repositories;
  let mockOrdersService: PayPalOrdersService;
  let mockAuthorizationsService: PayPalAuthorizationsService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    // Seed Owner
    repos.owners.upsert({
      id: 'default',
      display_name: 'Primary Owner',
      passphrase_hash: 'hash',
      telegram_chat_id: '123456789',
      created_at: new Date().toISOString(),
    });
    repos.owners.linkTelegram({
      ownerId: 'default',
      chatId: '123456789',
      username: 'owner1',
      linkedAtIso: '2026-11-04T00:00:00.000Z',
    });

    // Seed Agent
    repos.agents.insert({
      id: 'agent-1',
      name: 'Test Agent',
      api_key_hash: 'hash-1',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(100000), // $1,000.00
      created_at: new Date().toISOString(),
    });

    // Seed Vendor
    repos.vendors.insert({
      id: 'ven-acme',
      name: 'Acme Cloud',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud', 'infrastructure']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    });

    // Seed Vault Token
    repos.vendorVaultTokens.insert({
      id: 'vtok-1',
      vendor_id: 'ven-acme',
      paypal_customer_ref: 'cust-1',
      vault_token_id: 'vault-tok-12345',
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
    });

    // Mock PayPal Orders Service
    mockOrdersService = {
      createOrder: vi.fn(),
      getOrder: vi.fn(),
    } as unknown as PayPalOrdersService;

    // Mock PayPal Authorizations Service
    mockAuthorizationsService = {
      captureAuthorization: vi.fn(),
      voidAuthorization: vi.fn(),
      getAuthorization: vi.fn(),
    } as unknown as PayPalAuthorizationsService;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetInFlightExecutionsForTest();
    db.close();
  });

  function seedRequest(
    status: PaymentRequestStatus,
    overrides?: Partial<PaymentRequestRow>
  ): PaymentRequestRow {
    const id = overrides?.id ?? `req-${crypto.randomUUID()}`;
    const amountMinor = overrides?.amount_minor ?? toMinorUnits(2500); // $25.00
    const currency = overrides?.currency ?? 'USD';
    const nowIso = new Date().toISOString();

    const request: PaymentRequestRow = {
      id,
      agent_id: 'agent-1',
      idempotency_key: `idemp-${crypto.randomUUID()}`,
      vendor_id: 'ven-acme',
      amount_minor: amountMinor,
      currency,
      purpose: 'Server Hosting',
      category: 'cloud',
      source_context_excerpt: null,
      source_context_hash: null,
      status,
      decision: status === 'AUTO_EXECUTING' || status === 'CAPTURED' ? 'ALLOW' : 'HOLD',
      reasons: JSON.stringify([]),
      policy_version_id: null,
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
    const ledgerRow: LedgerRow = {
      id: `led-${crypto.randomUUID()}`,
      request_id: id,
      kind: 'RESERVE',
      amount_minor: amountMinor,
      currency,
      created_at: nowIso,
    };
    repos.ledger.insert(ledgerRow);

    return request;
  }

  function getReconcileOptions(overrides?: Partial<ReconcileRequestOptions>): ReconcileRequestOptions {
    return {
      db,
      repos,
      ordersService: mockOrdersService,
      authorizationsService: mockAuthorizationsService,
      ...overrides,
    };
  }

  function getOutboxRowsByRequestId(requestId: string): NotificationOutboxRow[] {
    return db
      .prepare('SELECT * FROM notification_outbox WHERE request_id = ?')
      .all(requestId) as NotificationOutboxRow[];
  }

  // ==========================================================================
  // 1. Concurrent Workers on Same Candidate (Capture Outcome)
  // ==========================================================================
  it('handles two workers reconciling the same captured candidate with exactly one SPEND row and notification', async () => {
    const req = seedRequest('AUTO_EXECUTING', {
      id: 'req-conc-capture',
      paypal_order_id: 'ord-conc-100',
    });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ord-conc-100',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      amountMinor: req.amount_minor,
      currency: req.currency,
      isCaptured: true,
      capture: {
        id: 'cap-conc-100',
        status: 'COMPLETED',
        amountMinor: req.amount_minor,
        currency: req.currency,
      },
    } as PayPalOrderResult);

    // Launch two reconciliation attempts concurrently on the same candidate
    const [res1, res2] = await Promise.all([
      reconcilePaymentRequest(db, req.id, getReconcileOptions()),
      reconcilePaymentRequest(db, req.id, getReconcileOptions()),
    ]);

    // Neither worker throws an unhandled rejection
    expect(res1).toBeDefined();
    expect(res2).toBeDefined();

    // Both observe successful resolution to CAPTURED
    expect(res1.status).toBe('CAPTURED');
    expect(res2.status).toBe('CAPTURED');
    expect(res1.reconciled).toBe(true);
    expect(res2.reconciled).toBe(true);

    // Exactly one worker executed the transition; the other cleanly took NO_OP
    const actions = [res1.actionTaken, res2.actionTaken];
    expect(actions).toContain('CAPTURED');
    expect(actions).toContain('NO_OP');

    // Financial invariant: Exactly ONE SPEND entry
    const ledger = repos.ledger.listByRequestId(req.id);
    const spendEntries = ledger.filter((l) => l.kind === 'SPEND');
    const releaseEntries = ledger.filter((l) => l.kind === 'RELEASE');
    expect(spendEntries).toHaveLength(1);
    expect(releaseEntries).toHaveLength(0);

    // Notification invariant: Exactly ONE terminal notification enqueued
    const notifs = getOutboxRowsByRequestId(req.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.event_type).toBe('PAYMENT_CAPTURED');
    expect(notifs[0]?.dedup_key).toBe(`payment_captured:${req.id}`);
  });

  // ==========================================================================
  // 2. Sequential / Stale Observation Race
  // ==========================================================================
  it('one worker completes capture before the other commits: second worker re-reads and safely no-ops', async () => {
    const req = seedRequest('AUTO_EXECUTING', {
      id: 'req-stale-race',
      paypal_order_id: 'ord-stale-200',
    });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ord-stale-200',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      amountMinor: req.amount_minor,
      currency: req.currency,
      isCaptured: true,
      capture: {
        id: 'cap-stale-200',
        status: 'COMPLETED',
        amountMinor: req.amount_minor,
        currency: req.currency,
      },
    } as PayPalOrderResult);

    // Worker 1 runs and commits CAPTURED
    const res1 = await reconcilePaymentRequest(db, req.id, getReconcileOptions());
    expect(res1.actionTaken).toBe('CAPTURED');
    expect(res1.status).toBe('CAPTURED');

    // Worker 2 now runs for the same candidate
    const res2 = await reconcilePaymentRequest(db, req.id, getReconcileOptions());
    expect(res2.actionTaken).toBe('NO_OP');
    expect(res2.status).toBe('CAPTURED');
    expect(res2.reconciled).toBe(true);
    expect(res2.resolved).toBe(true);

    // No duplicate SPEND or notification
    const spendEntries = repos.ledger.listByRequestId(req.id).filter((l) => l.kind === 'SPEND');
    expect(spendEntries).toHaveLength(1);
    const notifs = getOutboxRowsByRequestId(req.id);
    expect(notifs).toHaveLength(1);
  });

  // ==========================================================================
  // 3. Concurrent Workers on Voided Order Outcome
  // ==========================================================================
  it('handles two workers reconciling the same voided candidate with exactly one RELEASE row and notification', async () => {
    const req = seedRequest('AUTO_EXECUTING', {
      id: 'req-conc-void',
      paypal_order_id: 'ord-conc-void-300',
    });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ord-conc-void-300',
      status: 'VOIDED',
      intent: 'CAPTURE',
      amountMinor: req.amount_minor,
      currency: req.currency,
      isCaptured: false,
    } as PayPalOrderResult);

    const [res1, res2] = await Promise.all([
      reconcilePaymentRequest(db, req.id, getReconcileOptions()),
      reconcilePaymentRequest(db, req.id, getReconcileOptions()),
    ]);

    expect(res1.status).toBe('FAILED');
    expect(res2.status).toBe('FAILED');
    expect(res1.reconciled).toBe(true);
    expect(res2.reconciled).toBe(true);

    const actions = [res1.actionTaken, res2.actionTaken];
    expect(actions).toContain('FAILED');
    expect(actions).toContain('NO_OP');

    // Financial invariant: Exactly ONE RELEASE row, ZERO SPEND rows
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(1);
    expect(ledger.filter((l) => l.kind === 'SPEND')).toHaveLength(0);

    // Exactly one PAYMENT_FAILED notification
    const notifs = getOutboxRowsByRequestId(req.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.event_type).toBe('PAYMENT_FAILED');
  });

  // ==========================================================================
  // 4. Batch Resilience: Candidate Isolation on Remote Lookup Error
  // ==========================================================================
  it('isolates candidate failure: an unexpected error on one payment does not abort reconciliation of subsequent candidates', async () => {
    const req1 = seedRequest('AUTO_EXECUTING', { id: 'req-batch-good-1', paypal_order_id: 'ord-good-1' });
    const req2 = seedRequest('AUTO_EXECUTING', { id: 'req-batch-faulty-2', paypal_order_id: 'ord-faulty-2' });
    const req3 = seedRequest('AUTO_EXECUTING', { id: 'req-batch-good-3', paypal_order_id: 'ord-good-3' });

    vi.mocked(mockOrdersService.getOrder).mockImplementation(async (orderId: string) => {
      if (orderId === 'ord-faulty-2') {
        throw new Error('Simulated transient internal network socket explosion');
      }
      return {
        id: orderId,
        status: 'COMPLETED',
        intent: 'CAPTURE',
        amountMinor: toMinorUnits(2500),
        currency: 'USD',
        isCaptured: true,
        capture: {
          id: `cap-${orderId}`,
          status: 'COMPLETED',
          amountMinor: toMinorUnits(2500),
          currency: 'USD',
        },
      } as PayPalOrderResult;
    });

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const batchResult = await reconcilePendingRequests(db, getReconcileOptions({ logger: mockLogger }));

    // Total candidates processed = 3
    expect(batchResult.totalProcessed).toBe(3);
    expect(batchResult.resolved).toBe(2);
    expect(batchResult.unresolved).toBe(1);

    // req1 and req3 were captured cleanly despite req2 failing
    const result1 = batchResult.results.find((r) => r.requestId === req1.id);
    const result2 = batchResult.results.find((r) => r.requestId === req2.id);
    const result3 = batchResult.results.find((r) => r.requestId === req3.id);

    expect(result1?.status).toBe('CAPTURED');
    expect(result1?.reconciled).toBe(true);

    expect(result2?.status).toBe('UNRESOLVED');
    expect(result2?.reconciled).toBe(false);
    expect(result2?.isUnresolved).toBe(true);
    expect(result2?.reason).toContain('Simulated transient internal network socket explosion');

    expect(result3?.status).toBe('CAPTURED');
    expect(result3?.reconciled).toBe(true);

    // Database states match
    expect(repos.paymentRequests.getById(req1.id)?.status).toBe('CAPTURED');
    expect(repos.paymentRequests.getById(req2.id)?.status).toBe('AUTO_EXECUTING'); // Retained safely in-flight
    expect(repos.paymentRequests.getById(req3.id)?.status).toBe('CAPTURED');
  });

  // ==========================================================================
  // 5. Conflicting Terminal States: In-Flight Remote CAPTURED vs Local VOIDED
  // ==========================================================================
  it('conflicting terminal state: observed remote CAPTURED when local request was VOIDED remains UNRESOLVED and does not silently succeed', async () => {
    const req = seedRequest('AUTO_EXECUTING', {
      id: 'req-conflict-void-vs-cap',
      paypal_order_id: 'ord-conflict-void',
    });

    // Simulate an in-flight race: while getOrder is running, an out-of-band transaction voids the request in SQLite!
    vi.mocked(mockOrdersService.getOrder).mockImplementation(async () => {
      repos.paymentRequests.updateStatusAndDecision(req.id, {
        status: 'VOIDED',
        decision: 'HOLD',
        updatedAt: new Date().toISOString(),
      });
      repos.ledger.insert({
        id: `led-release-${req.id}`,
        request_id: req.id,
        kind: 'RELEASE',
        amount_minor: req.amount_minor,
        currency: req.currency,
        created_at: new Date().toISOString(),
      });

      return {
        id: 'ord-conflict-void',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        amountMinor: req.amount_minor,
        currency: req.currency,
        isCaptured: true,
        capture: {
          id: 'cap-conflict-void',
          status: 'COMPLETED',
          amountMinor: req.amount_minor,
          currency: req.currency,
        },
      } as PayPalOrderResult;
    });

    // Reconciler runs, observes remote CAPTURED, but local transitioned to VOIDED mid-flight
    const res = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    // Must NEVER treat conflicting terminal state as successful reconciliation
    expect(res.status).toBe('UNRESOLVED');
    expect(res.reconciled).toBe(false);
    expect(res.resolved).toBe(false);
    expect(res.isUnresolved).toBe(true);
    expect(res.reason).toContain('CONCURRENCY_CONFLICT');

    // Audit log records RECONCILIATION_INTEGRITY_MISMATCH
    const auditLogs = repos.auditLog.listByRequestId(req.id);
    const mismatchEntry = auditLogs.find((a) => a.event === 'RECONCILIATION_INTEGRITY_MISMATCH');
    expect(mismatchEntry).toBeDefined();

    // Ledger has NOT created a conflicting SPEND entry
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'SPEND')).toHaveLength(0);
  });

  // ==========================================================================
  // 6. Conflicting Terminal States: In-Flight Remote VOIDED vs Local CAPTURED
  // ==========================================================================
  it('conflicting terminal state: observed remote VOIDED when local request was CAPTURED remains UNRESOLVED', async () => {
    const req = seedRequest('AUTO_EXECUTING', {
      id: 'req-conflict-cap-vs-void',
      paypal_order_id: 'ord-conflict-cap',
    });

    // Simulate an in-flight race: while getOrder is running, local fast-path captures in SQLite!
    vi.mocked(mockOrdersService.getOrder).mockImplementation(async () => {
      repos.paymentRequests.updateStatusAndDecision(req.id, {
        status: 'CAPTURED',
        decision: 'ALLOW',
        updatedAt: new Date().toISOString(),
      });
      repos.ledger.insert({
        id: `led-spend-${req.id}`,
        request_id: req.id,
        kind: 'SPEND',
        amount_minor: req.amount_minor,
        currency: req.currency,
        created_at: new Date().toISOString(),
      });

      return {
        id: 'ord-conflict-cap',
        status: 'VOIDED',
        intent: 'CAPTURE',
        amountMinor: req.amount_minor,
        currency: req.currency,
        isCaptured: false,
      } as PayPalOrderResult;
    });

    const res = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    // Must NEVER treat conflicting terminal state as successful reconciliation
    expect(res.status).toBe('UNRESOLVED');
    expect(res.reconciled).toBe(false);
    expect(res.resolved).toBe(false);
    expect(res.isUnresolved).toBe(true);
    expect(res.reason).toContain('CONCURRENCY_CONFLICT');

    // Audit log records RECONCILIATION_INTEGRITY_MISMATCH
    const auditLogs = repos.auditLog.listByRequestId(req.id);
    const mismatchEntry = auditLogs.find((a) => a.event === 'RECONCILIATION_INTEGRITY_MISMATCH');
    expect(mismatchEntry).toBeDefined();

    // Zero RELEASE rows added
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(0);
  });

  // ==========================================================================
  // 7. Background Worker Lifecycle with Thrown Candidate Error
  // ==========================================================================
  it('ReconcilerWorker background tick isolates thrown candidate error and logs diagnostic information without throwing', async () => {
    const reqGood = seedRequest('AUTO_EXECUTING', { id: 'req-worker-good', paypal_order_id: 'ord-w-good' });
    const reqBad = seedRequest('AUTO_EXECUTING', { id: 'req-worker-bad', paypal_order_id: 'ord-w-bad' });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ord-w-good',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      amountMinor: toMinorUnits(2500),
      currency: 'USD',
      isCaptured: true,
      capture: {
        id: 'cap-ord-w-good',
        status: 'COMPLETED',
        amountMinor: toMinorUnits(2500),
        currency: 'USD',
      },
    } as PayPalOrderResult);

    // Spy on repos.paymentRequests.getById to force reqBad to throw an uncaught exception
    const originalGetById = repos.paymentRequests.getById.bind(repos.paymentRequests);
    const getByIdSpy = vi.spyOn(repos.paymentRequests, 'getById').mockImplementation((id: string) => {
      if (id === 'req-worker-bad') {
        throw new Error('Fatal unhandled driver error on req-worker-bad');
      }
      return originalGetById(id);
    });

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const worker = new ReconcilerWorker({
      db,
      repos,
      ordersService: mockOrdersService,
      authorizationsService: mockAuthorizationsService,
      logger: mockLogger,
      intervalMs: 1000,
    });

    // Worker tick must not reject even when candidate reconciliation throws!
    const tickResult = await worker.tick();

    // Restore spy before reading status of reqBad
    getByIdSpy.mockRestore();

    expect(tickResult.totalProcessed).toBe(2);
    expect(tickResult.resolved).toBe(1);
    expect(tickResult.unresolved).toBe(1);

    expect(repos.paymentRequests.getById(reqGood.id)?.status).toBe('CAPTURED');
    expect(repos.paymentRequests.getById(reqBad.id)?.status).toBe('AUTO_EXECUTING');

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('[reconcilePendingRequests] Unexpected error reconciling candidate req-worker-bad: Fatal unhandled driver error on req-worker-bad')
    );
  });

  // ==========================================================================
  // 8. Flow C: Concurrent Workers on CAPTURING Request
  // ==========================================================================
  it('handles two workers reconciling the same CAPTURING authorization hold concurrently', async () => {
    const req = seedRequest('CAPTURING', {
      id: 'req-flowc-conc',
      paypal_authorization_id: 'auth-flowc-conc-1',
    });

    vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
      id: 'auth-flowc-conc-1',
      status: 'CAPTURED',
      amountMinor: req.amount_minor,
      currency: req.currency,
      isCaptured: true,
      isCapturable: false,
    } as PayPalAuthorizationDetails);

    const [res1, res2] = await Promise.all([
      reconcilePaymentRequest(db, req.id, getReconcileOptions()),
      reconcilePaymentRequest(db, req.id, getReconcileOptions()),
    ]);

    expect(res1.status).toBe('CAPTURED');
    expect(res2.status).toBe('CAPTURED');
    expect(res1.reconciled).toBe(true);
    expect(res2.reconciled).toBe(true);

    const actions = [res1.actionTaken, res2.actionTaken];
    expect(actions).toContain('CAPTURED');
    expect(actions).toContain('NO_OP');

    // Exactly one SPEND row, zero RELEASE rows
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'SPEND')).toHaveLength(1);
    expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(0);

    // Exactly one notification
    const notifs = getOutboxRowsByRequestId(req.id);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.event_type).toBe('PAYMENT_CAPTURED');
  });
});
