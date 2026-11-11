/**
 * PayGuard — Milestone M2: PayPal Gateway
 * Unit Tests: M2-T7 PayPal Reconciliation Subsystem & Reconciler Job
 *
 * Comprehensive deterministic test suite verifying:
 * 1. Flow A: AUTO_EXECUTING crash recovery (repaired to CAPTURED, single SPEND row).
 * 2. Flow A: AUTO_EXECUTING remote order voided (repaired to FAILED, single RELEASE row).
 * 3. Flow A: AUTO_EXECUTING missing order ID fails closed without guessing or replacement order.
 * 4. Flow A: AUTO_EXECUTING provisional order ID recovered from EXECUTION_AMBIGUOUS audit log.
 * 5. Flow A: Integrity mismatch (amount/currency differs from DB request) fails closed.
 * 6. Flow C: CAPTURING crash recovery (repaired to CAPTURED, single SPEND row).
 * 7. Flow C: CAPTURING remote auth CREATED (retains CAPTURING & reservation, returns UNRESOLVED).
 * 8. Flow C: CAPTURING remote auth EXPIRED/VOIDED/DENIED (repaired to FAILED, single RELEASE row).
 * 9. Flow C: Authorization integrity mismatch fails closed.
 * 10. Flow B: HELD with healthy active CREATED hold returns NO_OP, reservation preserved.
 * 11. Flow B: HELD with existing auth ID remote VOIDED transitioned to VOIDED with RELEASE row.
 * 12. Flow B: Missing auth ID + missing order ID fails closed (no order lookup attempted).
 * 13. Flow B: Missing auth ID + remote order integrity mismatch fails closed.
 * 14. Flow B: Missing auth ID + remote auth CREATED links authorization ID and remains HELD.
 * 15. Flow B: Missing auth ID + dual-attestation safe void transitions to VOIDED with RELEASE row.
 * 16. Flow B: Missing auth ID + terminal auth with missing capture evidence fails closed.
 * 17. Flow B: Missing auth ID + terminal auth with contradictory capture evidence fails closed.
 * 18. Flow B: Missing auth ID + already captured remote auth fails closed (no illegal transition).
 * 19. Flow B: Missing auth ID + unexpected remote auth status fails closed.
 * 20. Inconclusive remote state (HTTP 5xx / timeout) fails closed without ledger changes.
 * 21. Remote status PENDING fails closed without ledger changes.
 * 22. Reconciliation idempotency & duplicate ledger protection (exactly 1 SPEND or RELEASE row).
 * 23. Duplicate money movement prevention (executeDecision on reconciled request returns NO_OP).
 * 24. Batch candidate reconciliation (reconcilePendingRequests).
 * 25. ReconcilerWorker lifecycle and 60-second periodic tick execution.
 * 26. Complete audit hash chain cryptographic verification across all repair operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import type { PaymentRequestRow, LedgerRow } from '../../src/db/types.js';
import {
  reconcilePaymentRequest,
  reconcilePendingRequests,
  ReconcilerWorker,
  type ReconcileRequestOptions,
} from '../../src/paypal/reconcile.js';
import {
  executeDecision,
  _resetInFlightExecutionsForTest,
  type ExecuteDecisionOptions,
} from '../../src/core/executeDecision.js';
import {
  verifyDatabaseAuditChain,
  writeAuditLogEntry,
  type PaymentRequestStatus,
} from '../../src/core/stateMachine.js';
import { PayPalOrdersService, type PayPalOrderResult } from '../../src/paypal/orders.js';
import {
  PayPalHttpClient,
} from '../../src/paypal/http.js';
import { TokenManager, type FetchFunction } from '../../src/paypal/tokenManager.js';
import {
  AuthorizationError,
  type PayPalAuthorizationsService,
  type PayPalAuthorizationDetails,
  type PayPalCaptureResult,
} from '../../src/paypal/authorizations.js';
import { transitionPaymentRequest } from '../../src/core/stateMachine.js';
import { toMinorUnits } from '../../src/core/money.js';

describe('M2-T7: PayPal Reconciliation Subsystem & Reconciler Job', () => {
  let db: Database;
  let repos: Repositories;
  let mockOrdersService: PayPalOrdersService;
  let mockAuthorizationsService: PayPalAuthorizationsService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);
    _resetInFlightExecutionsForTest();

    // Seed Owner
    repos.owners.upsert({
      display_name: 'Test Owner',
      passphrase_hash: '$argon2id$mock-hash',
      telegram_chat_id: null,
      created_at: new Date().toISOString(),
    });

    // Seed Agent
    repos.agents.insert({
      id: 'agent-1',
      name: 'Test Agent',
      api_key_hash: 'hash-agent-1',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(100000),
      created_at: new Date().toISOString(),
    });

    // Seed Vendor
    repos.vendors.insert({
      id: 'ven-acme',
      name: 'Acme Cloud',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud', 'saas']),
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

  // Helper to seed payment request and reservation
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
      expires_at: null,
      created_at: nowIso,
      updated_at: nowIso,
      ...overrides,
    };

    repos.paymentRequests.insert(request);

    if (overrides?.remote_void_status) {
      repos.paymentRequests.updateRemoteVoidStatus(id, overrides.remote_void_status, nowIso);
    }

    // Initial budget reservation row for in-flight requests
    const ledgerEntry: LedgerRow = {
      id: `led-${crypto.randomUUID()}`,
      request_id: id,
      kind: 'RESERVE',
      amount_minor: amountMinor,
      currency,
      created_at: nowIso,
    };
    repos.ledger.insert(ledgerEntry);

    // Seed initial audit log entry
    writeAuditLogEntry(db, repos, {
      actor: 'agent',
      event: `REQUEST_${status}`,
      requestId: id,
      payload: { status },
      timestamp: nowIso,
    });

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

  // ==========================================================================
  // Flow A: AUTO_EXECUTING Tests
  // ==========================================================================

  it('1. Flow A Crash Recovery: AUTO_EXECUTING with completed remote capture repairs to CAPTURED and inserts SPEND row', async () => {
    const req = seedRequest('AUTO_EXECUTING', { paypal_order_id: 'ORD-AUTO-1' });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-AUTO-1',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: true,
      isAuthorized: false,
      capture: {
        id: 'CAP-REMOTE-1',
        status: 'COMPLETED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    } as PayPalOrderResult);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('CAPTURED');
    expect(result.actionTaken).toBe('CAPTURED');
    expect(result.reconciled).toBe(true);
    expect(result.captureId).toBe('CAP-REMOTE-1');

    // Database verification
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('CAPTURED');
    expect(updated.paypal_capture_id).toBe('CAP-REMOTE-1');

    // Exactly one SPEND row and one RESERVE row
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RESERVE').length).toBe(1);
    expect(ledger.filter((l) => l.kind === 'SPEND').length).toBe(1);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(0);

    // Audit log written
    const audit = repos.auditLog.listByRequestId(req.id);
    expect(audit.some((a) => a.event === 'TRANSITION_TO_CAPTURED')).toBe(true);
  });

  it('2. Flow A Remote Order Voided: repairs to FAILED and inserts RELEASE row', async () => {
    const req = seedRequest('AUTO_EXECUTING', { paypal_order_id: 'ORD-AUTO-VOID' });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-AUTO-VOID',
      status: 'VOIDED',
      intent: 'CAPTURE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: false,
      isAuthorized: false,
    } as PayPalOrderResult);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('FAILED');
    expect(result.actionTaken).toBe('FAILED');
    expect(result.reconciled).toBe(true);

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('FAILED');

    // Ledger has RELEASE row
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(1);
    expect(ledger.filter((l) => l.kind === 'SPEND').length).toBe(0);
  });

  it('3. Flow A Missing Order ID: fails closed without guessing or creating replacement order', async () => {
    const req = seedRequest('AUTO_EXECUTING', { paypal_order_id: null });

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');
    expect(result.reconciled).toBe(false);
    expect(result.isUnresolved).toBe(true);

    // Crucial check: Order service was NEVER called
    expect(mockOrdersService.getOrder).not.toHaveBeenCalled();

    // State and reservation preserved
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('AUTO_EXECUTING');
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(0);
    expect(ledger.filter((l) => l.kind === 'SPEND').length).toBe(0);

    // Audit entry logged
    const audit = repos.auditLog.listByRequestId(req.id);
    expect(audit.some((a) => a.event === 'RECONCILIATION_UNRESOLVED')).toBe(true);
  });

  it('4. Flow A Provisional Order ID in Audit Log: successfully recovers and repairs to CAPTURED', async () => {
    const req = seedRequest('AUTO_EXECUTING', { paypal_order_id: null });

    // Simulate an EXECUTION_AMBIGUOUS audit log that recorded the order ID before SQLite transaction failed
    writeAuditLogEntry(db, repos, {
      actor: 'system',
      event: 'EXECUTION_AMBIGUOUS',
      requestId: req.id,
      payload: {
        paypal_order_id: 'ORD-PROVISIONAL-99',
        reason: 'Network dropped during capture response',
      },
    });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-PROVISIONAL-99',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: true,
      isAuthorized: false,
      capture: {
        id: 'CAP-PROV-1',
        status: 'COMPLETED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    } as PayPalOrderResult);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('CAPTURED');
    expect(result.orderId).toBe('ORD-PROVISIONAL-99');
    expect(result.captureId).toBe('CAP-PROV-1');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('CAPTURED');
    expect(updated.paypal_order_id).toBe('ORD-PROVISIONAL-99');
  });

  it('5. Flow A Amount/Currency Mismatch: fails closed on integrity mismatch', async () => {
    const req = seedRequest('AUTO_EXECUTING', {
      paypal_order_id: 'ORD-MISMATCH-1',
      amount_minor: toMinorUnits(2500),
      currency: 'USD',
    });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-MISMATCH-1',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      customId: req.id,
      amountMinor: toMinorUnits(5000), // Mismatched: $50.00 instead of $25.00
      currency: 'USD',
      isCaptured: true,
      isAuthorized: false,
      capture: {
        id: 'CAP-MISMATCH',
        status: 'COMPLETED',
        amountMinor: toMinorUnits(5000),
        currency: 'USD',
      },
    } as PayPalOrderResult);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');

    // Request remains AUTO_EXECUTING, reservation preserved
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('AUTO_EXECUTING');
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'SPEND').length).toBe(0);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(0);

    const audit = repos.auditLog.listByRequestId(req.id);
    expect(audit.some((a) => a.event === 'RECONCILIATION_INTEGRITY_MISMATCH')).toBe(true);
  });

  // ==========================================================================
  // Flow C: CAPTURING Tests
  // ==========================================================================

  it('6. Flow C Crash Recovery: CAPTURING with remote authorization status CAPTURED repairs to CAPTURED and inserts SPEND row', async () => {
    const req = seedRequest('CAPTURING', { paypal_authorization_id: 'AUTH-CAP-1' });

    vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
      id: 'AUTH-CAP-1',
      status: 'CAPTURED',
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCapturable: false,
      isVoidable: false,
      isCaptured: true,
      isPartiallyCaptured: false,
      isVoided: false,
      isExpired: false,
      isDenied: false,
      isPending: false,
    } as PayPalAuthorizationDetails);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('CAPTURED');
    expect(result.actionTaken).toBe('CAPTURED');
    expect(result.reconciled).toBe(true);

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('CAPTURED');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'SPEND').length).toBe(1);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(0);
  });

  it('7. Flow C Remote Auth CREATED: retains CAPTURING and reservation, returns UNRESOLVED (does not assume CREATED makes capture safe)', async () => {
    const req = seedRequest('CAPTURING', { paypal_authorization_id: 'AUTH-IN-FLIGHT-1' });

    vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
      id: 'AUTH-IN-FLIGHT-1',
      status: 'CREATED',
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCapturable: true,
      isVoidable: true,
      isCaptured: false,
      isPartiallyCaptured: false,
      isVoided: false,
      isExpired: false,
      isDenied: false,
      isPending: false,
    } as PayPalAuthorizationDetails);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');
    expect(result.reconciled).toBe(false);

    // CRITICAL SAFETY INVARIANT: Status remains CAPTURING, reservation intact, no SPEND, no RELEASE
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('CAPTURING');
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'SPEND').length).toBe(0);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(0);

    const audit = repos.auditLog.listByRequestId(req.id);
    expect(audit.some((a) => a.event === 'RECONCILIATION_UNRESOLVED')).toBe(true);
  });

  it('8. Flow C Remote Auth EXPIRED/VOIDED/DENIED: repairs to FAILED and inserts RELEASE row', async () => {
    const req = seedRequest('CAPTURING', { paypal_authorization_id: 'AUTH-EXPIRED-1' });

    vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
      id: 'AUTH-EXPIRED-1',
      status: 'EXPIRED',
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCapturable: false,
      isVoidable: false,
      isCaptured: false,
      isPartiallyCaptured: false,
      isVoided: false,
      isExpired: true,
      isDenied: false,
      isPending: false,
    } as PayPalAuthorizationDetails);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('FAILED');
    expect(result.actionTaken).toBe('FAILED');
    expect(result.reconciled).toBe(true);

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('FAILED');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(1);
    expect(ledger.filter((l) => l.kind === 'SPEND').length).toBe(0);
  });

  it('9. Flow C Authorization Integrity Mismatch: fails closed when amount differs', async () => {
    const req = seedRequest('CAPTURING', {
      paypal_authorization_id: 'AUTH-AMT-MISMATCH',
      amount_minor: toMinorUnits(1500),
      currency: 'USD',
    });

    vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
      id: 'AUTH-AMT-MISMATCH',
      status: 'CAPTURED',
      amountMinor: toMinorUnits(3000), // Mismatch
      currency: 'USD',
      isCapturable: false,
      isVoidable: false,
      isCaptured: true,
      isPartiallyCaptured: false,
      isVoided: false,
      isExpired: false,
      isDenied: false,
      isPending: false,
    } as PayPalAuthorizationDetails);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('CAPTURING');
    const audit = repos.auditLog.listByRequestId(req.id);
    expect(audit.some((a) => a.event === 'RECONCILIATION_INTEGRITY_MISMATCH')).toBe(true);
  });

  // ==========================================================================
  // Flow B: HELD Tests
  // ==========================================================================

  it('10. Flow B HELD with healthy active CREATED hold returns NO_OP with reservation preserved', async () => {
    const req = seedRequest('HELD', { paypal_authorization_id: 'AUTH-HEALTHY-1' });

    vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
      id: 'AUTH-HEALTHY-1',
      status: 'CREATED',
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCapturable: true,
      isVoidable: true,
      isCaptured: false,
      isPartiallyCaptured: false,
      isVoided: false,
      isExpired: false,
      isDenied: false,
      isPending: false,
    } as PayPalAuthorizationDetails);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('HELD');
    expect(result.actionTaken).toBe('NO_OP');
    expect(result.reconciled).toBe(true);

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('HELD');
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(0);
  });

  it('11. Flow B HELD with remote VOIDED authorization transitions to VOIDED with RELEASE row', async () => {
    const req = seedRequest('HELD', { paypal_authorization_id: 'AUTH-HELD-VOID' });

    vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
      id: 'AUTH-HELD-VOID',
      status: 'VOIDED',
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCapturable: false,
      isVoidable: false,
      isCaptured: false,
      isPartiallyCaptured: false,
      isVoided: true,
      isExpired: false,
      isDenied: false,
      isPending: false,
    } as PayPalAuthorizationDetails);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('VOIDED');
    expect(result.actionTaken).toBe('VOIDED');
    expect(result.reconciled).toBe(true);

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('VOIDED');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(1);
  });

  it('12. Flow B Missing Auth ID + Missing Order ID fails closed without calling getOrder', async () => {
    const req = seedRequest('HELD', { paypal_authorization_id: null, paypal_order_id: null });

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');
    expect(mockOrdersService.getOrder).not.toHaveBeenCalled();

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('HELD');
    expect(updated.paypal_authorization_id).toBeNull();
  });

  it('13. Flow B Missing Auth ID + Remote Order Mismatch fails closed', async () => {
    const req = seedRequest('HELD', {
      paypal_authorization_id: null,
      paypal_order_id: 'ORD-HELD-MISMATCH',
      amount_minor: toMinorUnits(1000),
      currency: 'USD',
    });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-HELD-MISMATCH',
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      customId: req.id,
      amountMinor: toMinorUnits(9999), // Mismatch
      currency: 'USD',
      isCaptured: false,
      isAuthorized: true,
      authorization: {
        id: 'AUTH-DISCOVERED-1',
        status: 'CREATED',
        amountMinor: toMinorUnits(9999),
        currency: 'USD',
      },
    } as PayPalOrderResult);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.paypal_authorization_id).toBeNull();
    const audit = repos.auditLog.listByRequestId(req.id);
    expect(audit.some((a) => a.event === 'RECONCILIATION_INTEGRITY_MISMATCH')).toBe(true);
  });

  it('14. Flow B Missing Auth ID + Remote Auth CREATED links authorization ID and remains HELD', async () => {
    const req = seedRequest('HELD', {
      paypal_authorization_id: null,
      paypal_order_id: 'ORD-HELD-VALID',
      amount_minor: toMinorUnits(2000),
      currency: 'USD',
    });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-HELD-VALID',
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      customId: req.id,
      amountMinor: toMinorUnits(2000),
      currency: 'USD',
      isCaptured: false,
      isAuthorized: true,
      authorization: {
        id: 'AUTH-DISCOVERED-VALID',
        status: 'CREATED',
        amountMinor: toMinorUnits(2000),
        currency: 'USD',
      },
    } as PayPalOrderResult);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('HELD');
    expect(result.actionTaken).toBe('REPAIRED_HOLD_ID');
    expect(result.authorizationId).toBe('AUTH-DISCOVERED-VALID');
    expect(result.reconciled).toBe(true);

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('HELD');
    expect(updated.paypal_authorization_id).toBe('AUTH-DISCOVERED-VALID');

    const audit = repos.auditLog.listByRequestId(req.id);
    expect(audit.some((a) => a.event === 'RECONCILE_LINKED_AUTHORIZATION')).toBe(true);
  });

  it('15. Flow B Missing Auth ID Dual-Attestation Safe Void transitions to VOIDED with single RELEASE row', async () => {
    const req = seedRequest('HELD', {
      paypal_authorization_id: null,
      paypal_order_id: 'ORD-DUAL-VOID',
      amount_minor: toMinorUnits(3000),
      currency: 'USD',
    });

    // 1. Order Attestation: intent AUTHORIZE, no capture, authorization VOIDED
    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-DUAL-VOID',
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: false,
      isAuthorized: false,
      authorization: {
        id: 'AUTH-TO-CHECK-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
      capture: undefined,
    } as PayPalOrderResult);

    // 2. Direct Authorization Attestation: confirms VOIDED and isCaptured: false
    vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
      id: 'AUTH-TO-CHECK-1',
      status: 'VOIDED',
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCapturable: false,
      isVoidable: false,
      isCaptured: false,
      isPartiallyCaptured: false,
      isVoided: true,
      isExpired: false,
      isDenied: false,
      isPending: false,
    } as PayPalAuthorizationDetails);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('VOIDED');
    expect(result.actionTaken).toBe('VOIDED');
    expect(result.reconciled).toBe(true);

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('VOIDED');
    expect(updated.paypal_authorization_id).toBe('AUTH-TO-CHECK-1');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(1);
    expect(ledger.filter((l) => l.kind === 'SPEND').length).toBe(0);
  });

  it('16. Flow B Missing Auth ID Terminal Auth with Missing Capture Evidence fails closed without releasing reservation', async () => {
    const req = seedRequest('HELD', {
      paypal_authorization_id: null,
      paypal_order_id: 'ORD-MISSING-CAP-EV',
      amount_minor: toMinorUnits(3000),
      currency: 'USD',
    });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-MISSING-CAP-EV',
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: false,
      isAuthorized: false,
      authorization: {
        id: 'AUTH-UNVERIFIABLE',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    } as PayPalOrderResult);

    // Direct authorization call fails with 500 server error
    vi.mocked(mockAuthorizationsService.getAuthorization).mockRejectedValue(
      new Error('PayPal 500 Internal Server Error')
    );

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');

    // CRITICAL: Reservation must NOT be released!
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('HELD');
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(0);

    const audit = repos.auditLog.listByRequestId(req.id);
    expect(audit.some((a) => a.event === 'RECONCILIATION_UNRESOLVED')).toBe(true);
  });

  it('17. Flow B Missing Auth ID Terminal Auth with Contradictory Capture Evidence fails closed without releasing reservation', async () => {
    const req = seedRequest('HELD', {
      paypal_authorization_id: null,
      paypal_order_id: 'ORD-CONTRADICTORY',
      amount_minor: toMinorUnits(4000),
      currency: 'USD',
    });

    // Contradictory: Order reports voided authorization BUT also reports a completed capture!
    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-CONTRADICTORY',
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: true,
      isAuthorized: false,
      authorization: {
        id: 'AUTH-CONTRADICTED',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
      capture: {
        id: 'CAP-CONTRADICTED',
        status: 'COMPLETED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    } as PayPalOrderResult);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');

    // Reservation MUST NOT be released when contradictory evidence exists!
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('HELD');
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(0);

    const audit = repos.auditLog.listByRequestId(req.id);
    expect(audit.some((a) => a.event === 'RECONCILIATION_UNRESOLVED')).toBe(true);
  });

  it('18. Flow B Missing Auth ID Already Captured Remote Auth fails closed (no illegal state transition)', async () => {
    const req = seedRequest('HELD', {
      paypal_authorization_id: null,
      paypal_order_id: 'ORD-ALREADY-CAPTURED',
      amount_minor: toMinorUnits(2500),
      currency: 'USD',
    });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-ALREADY-CAPTURED',
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: false,
      isAuthorized: false,
      authorization: {
        id: 'AUTH-ALREADY-CAPTURED',
        status: 'CAPTURED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    } as PayPalOrderResult);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');

    // Request does not transition illegally to CAPTURED from HELD
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('HELD');
  });

  it('19. Flow B Missing Auth ID Unexpected Remote Auth Status fails closed', async () => {
    const req = seedRequest('HELD', {
      paypal_authorization_id: null,
      paypal_order_id: 'ORD-UNEXPECTED-STATUS',
      amount_minor: toMinorUnits(2500),
      currency: 'USD',
    });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-UNEXPECTED-STATUS',
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: false,
      isAuthorized: false,
      authorization: {
        id: 'AUTH-WEIRD',
        status: 'UNKNOWN_CUSTOM_STATUS',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    } as PayPalOrderResult);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('HELD');
    expect(updated.paypal_authorization_id).toBeNull();
  });

  // ==========================================================================
  // Inconclusive & Resilience Tests
  // ==========================================================================

  it('20. Inconclusive remote state (HTTP 5xx / timeout) fails closed without ledger changes', async () => {
    const req = seedRequest('AUTO_EXECUTING', { paypal_order_id: 'ORD-TIMEOUT' });

    vi.mocked(mockOrdersService.getOrder).mockRejectedValue(
      new Error('Network connection timeout: ETIMEDOUT')
    );

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('AUTO_EXECUTING');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'SPEND').length).toBe(0);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(0);
  });

  it('21. Remote status PENDING fails closed without ledger changes', async () => {
    const req = seedRequest('CAPTURING', { paypal_authorization_id: 'AUTH-PENDING-RISK' });

    vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
      id: 'AUTH-PENDING-RISK',
      status: 'PENDING',
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCapturable: false,
      isVoidable: true,
      isCaptured: false,
      isPartiallyCaptured: false,
      isVoided: false,
      isExpired: false,
      isDenied: false,
      isPending: true,
    } as PayPalAuthorizationDetails);

    const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    expect(result.status).toBe('UNRESOLVED');
    expect(result.actionTaken).toBe('NO_OP');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('CAPTURING');
  });

  // ==========================================================================
  // Idempotency, Safety Invariants, & Worker Lifecycle
  // ==========================================================================

  it('22. Reconciliation Idempotency: Repeated reconciliation produces exactly one SPEND row', async () => {
    const req = seedRequest('AUTO_EXECUTING', { paypal_order_id: 'ORD-IDEMP-1' });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-IDEMP-1',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: true,
      isAuthorized: false,
      capture: {
        id: 'CAP-IDEMP-1',
        status: 'COMPLETED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    } as PayPalOrderResult);

    // First reconciliation run: repairs to CAPTURED
    const res1 = await reconcilePaymentRequest(db, req.id, getReconcileOptions());
    expect(res1.status).toBe('CAPTURED');
    expect(res1.actionTaken).toBe('CAPTURED');

    // Second reconciliation run: detects terminal state, returns NO_OP
    const res2 = await reconcilePaymentRequest(db, req.id, getReconcileOptions());
    expect(res2.status).toBe('CAPTURED');
    expect(res2.actionTaken).toBe('NO_OP');

    // Strict Invariant: Exactly one SPEND row total in ledger
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.filter((l) => l.kind === 'SPEND').length).toBe(1);
    expect(ledger.filter((l) => l.kind === 'RELEASE').length).toBe(0);
  });

  it('23. Duplicate Money Movement Guard: executeDecision on reconciled CAPTURED request returns NO_OP with zero PayPal calls', async () => {
    const req = seedRequest('AUTO_EXECUTING', { paypal_order_id: 'ORD-NO-RETRY' });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-NO-RETRY',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: true,
      isAuthorized: false,
      capture: {
        id: 'CAP-REPAIRED',
        status: 'COMPLETED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    } as PayPalOrderResult);

    // Reconcile
    await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    // Now call executeDecision on the same request
    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
      authorizationsService: mockAuthorizationsService,
    };

    const execResult = await executeDecision({ requestId: req.id }, execOptions);

    expect(execResult.status).toBe('CAPTURED');
    expect(execResult.actionTaken).toBe('NO_OP');
    expect(execResult.executed).toBe(false);

    // createOrder was NEVER called!
    expect(mockOrdersService.createOrder).not.toHaveBeenCalled();
    expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
  });

  it('24. Batch candidate reconciliation: processes all pending candidates correctly', async () => {
    const req1 = seedRequest('AUTO_EXECUTING', { paypal_order_id: 'ORD-BATCH-1' });
    const req2 = seedRequest('CAPTURING', { paypal_authorization_id: 'AUTH-BATCH-2' });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-BATCH-1',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      customId: req1.id,
      amountMinor: req1.amount_minor,
      currency: 'USD',
      isCaptured: true,
      isAuthorized: false,
      capture: {
        id: 'CAP-B1',
        status: 'COMPLETED',
        amountMinor: req1.amount_minor,
        currency: 'USD',
      },
    } as PayPalOrderResult);

    vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
      id: 'AUTH-BATCH-2',
      status: 'CAPTURED',
      amountMinor: req2.amount_minor,
      currency: 'USD',
      isCapturable: false,
      isVoidable: false,
      isCaptured: true,
      isPartiallyCaptured: false,
      isVoided: false,
      isExpired: false,
      isDenied: false,
      isPending: false,
    } as PayPalAuthorizationDetails);

    const batchResult = await reconcilePendingRequests(db, getReconcileOptions());

    expect(batchResult.totalProcessed).toBe(2);
    expect(batchResult.resolved).toBe(2);
    expect(batchResult.unresolved).toBe(0);
  });

  it('25. ReconcilerWorker: start, stop, and tick execution on 60-second interval', async () => {
    const worker = new ReconcilerWorker({
      db,
      repos,
      ordersService: mockOrdersService,
      authorizationsService: mockAuthorizationsService,
      intervalMs: 60_000,
    });

    expect(worker.isRunning()).toBe(false);

    worker.start();
    expect(worker.isRunning()).toBe(true);

    // Run tick manually
    const tickResult = await worker.tick();
    expect(tickResult.totalProcessed).toBe(0);

    worker.stop();
    expect(worker.isRunning()).toBe(false);
  });

  it('26. Audit Hash Chain Integrity: complete audit chain verified across all reconciliation repairs', async () => {
    const req = seedRequest('AUTO_EXECUTING', { paypal_order_id: 'ORD-AUDIT-CHECK' });

    vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
      id: 'ORD-AUDIT-CHECK',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      customId: req.id,
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: true,
      isAuthorized: false,
      capture: {
        id: 'CAP-AUDIT',
        status: 'COMPLETED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    } as PayPalOrderResult);

    await reconcilePaymentRequest(db, req.id, getReconcileOptions());

    // Cryptographic audit chain verification across SQLite
    const chainVerification = verifyDatabaseAuditChain(db);
    expect(chainVerification.valid).toBe(true);
    expect(chainVerification.totalEntries).toBeGreaterThan(0);
    expect(chainVerification.brokenIndex).toBeUndefined();
  });

  // ==========================================================================
  // Flow D: Remote Void Notification Recovery Tests
  // ==========================================================================

  describe('27. Flow D: Notification Recovery for Remote Void Reconciliation', () => {
    beforeEach(() => {
      repos.owners.linkTelegram({
        ownerId: 'default',
        chatId: '12345678',
        userId: '999888777',
        linkedAtIso: new Date().toISOString(),
      });
    });

    it('27.1 Crash recovery: missing notification after local VOID is created on reconciliation', async () => {
      // Scenario: Local VOID transaction committed HELD -> VOIDED, remote_void_status = PENDING.
      // Process crashed before Phase 2 outbox enqueue.
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-RECON-CRASH-1',
        remote_void_status: 'PENDING',
      });

      // Ensure no outbox row exists yet
      expect(repos.notifications.getByDedupKey(`payment_voided:${req.id}`)).toBeUndefined();

      // Remote PayPal confirms authorization is VOIDED
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-RECON-CRASH-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());
      expect(result.actionTaken).toBe('VOIDED');
      expect(result.reconciled).toBe(true);

      // Verify request remote_void_status updated to CONFIRMED
      const updatedReq = repos.paymentRequests.getById(req.id);
      expect(updatedReq?.remote_void_status).toBe('CONFIRMED');

      // Verify notification was recovered and enqueued
      const notif = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(notif).toBeDefined();
      expect(notif?.status).toBe('PENDING');
      expect(notif?.message_text).toContain('Payment voided locally. PayPal authorization cancellation confirmed.');
    });

    it('27.2 Idempotency: repeated reconciliation does not duplicate notifications', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-RECON-IDEMP-1',
        remote_void_status: 'PENDING',
      });

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-RECON-IDEMP-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      // First reconciliation
      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // Second reconciliation
      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // Verify exactly 1 notification row in outbox for this request
      const countRow = db.prepare(
        "SELECT COUNT(*) as count FROM notification_outbox WHERE dedup_key = ?"
      ).get(`payment_voided:${req.id}`) as { count: number };
      expect(countRow.count).toBe(1);
    });

    it('27.3 In-place update: existing PENDING notification updated when remote void confirms', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-RECON-UPDATE-1',
        remote_void_status: 'PENDING',
      });

      // Existing initial PENDING notification enqueued by Phase 2 before crash
      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Payment voided locally and budget reservation released. PayPal cancellation is pending reconciliation.',
        parse_mode: 'HTML',
      });

      const initialNotif = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(initialNotif?.status).toBe('PENDING');
      expect(initialNotif?.message_text).toContain('pending reconciliation');

      // Reconciler discovers remote void is confirmed
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-RECON-UPDATE-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // Verify row was updated in place with CONFIRMED text without inserting a duplicate
      const updatedNotif = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(updatedNotif?.id).toBe(initialNotif?.id);
      expect(updatedNotif?.status).toBe('PENDING');
      expect(updatedNotif?.message_text).toContain('Payment voided locally. PayPal authorization cancellation confirmed.');

      const countRow = db.prepare(
        "SELECT COUNT(*) as count FROM notification_outbox WHERE dedup_key = ?"
      ).get(`payment_voided:${req.id}`) as { count: number };
      expect(countRow.count).toBe(1);
    });

    it('27.4 Concurrency: worker claiming PROCESSING prevents unsafe notification overwrite', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-RECON-RACE-1',
        remote_void_status: 'PENDING',
      });

      // Enqueue initial notification
      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Original pending message currently in dispatch',
        parse_mode: 'HTML',
      });

      // Worker claims the row: status transitions to PROCESSING
      const claimed = repos.notifications.claimPending('worker-claim-test-1', undefined, 10);
      expect(claimed.some((c) => c.dedup_key === `payment_voided:${req.id}`)).toBe(true);

      const processingNotif = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(processingNotif?.status).toBe('PROCESSING');

      // Reconciler runs while message is in PROCESSING
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-RECON-RACE-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // Verify PROCESSING message was NOT mutated during flight
      const afterReconcile = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(afterReconcile?.status).toBe('PROCESSING');
      expect(afterReconcile?.message_text).toBe('Original pending message currently in dispatch');

      // No second row created with initial dedup_key
      const countRow = db.prepare(
        "SELECT COUNT(*) as count FROM notification_outbox WHERE dedup_key = ?"
      ).get(`payment_voided:${req.id}`) as { count: number };
      expect(countRow.count).toBe(1);

      // Terminal update is enqueued for post-dispatch delivery
      const terminalNotif = repos.notifications.getByDedupKey(`payment_voided:${req.id}:confirmed`);
      expect(terminalNotif).toBeDefined();
      expect(terminalNotif?.status).toBe('PENDING');
      expect(terminalNotif?.message_text).toContain('PayPal authorization cancellation confirmed');
    });

    it('27.5 Non-resend: already SENT notification is never modified or resent', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-RECON-SENT-1',
        remote_void_status: 'PENDING',
      });

      // Enqueue, claim, and mark SENT
      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Payment voided locally and budget reservation released. PayPal cancellation is pending reconciliation.',
        parse_mode: 'HTML',
      });

      const claimed = repos.notifications.claimPending('worker-claim-sent-1', undefined, 10);
      const row = claimed.find((c) => c.dedup_key === `payment_voided:${req.id}`)!;
      repos.notifications.markSent(row.id, 'worker-claim-sent-1', 998877);

      const sentNotif = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(sentNotif?.status).toBe('SENT');
      expect(sentNotif?.telegram_message_id).toBe(998877);

      // Reconciler runs later
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-RECON-SENT-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // Verify original row remains SENT with original text, message ID, and was not resent
      const finalNotif = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(finalNotif?.status).toBe('SENT');
      expect(finalNotif?.telegram_message_id).toBe(998877);
      expect(finalNotif?.message_text).toContain('pending reconciliation');

      const countRow = db.prepare(
        "SELECT COUNT(*) as count FROM notification_outbox WHERE dedup_key = ?"
      ).get(`payment_voided:${req.id}`) as { count: number };
      expect(countRow.count).toBe(1);

      // Verify separate terminal update was enqueued
      const terminalNotif = repos.notifications.getByDedupKey(`payment_voided:${req.id}:confirmed`);
      expect(terminalNotif).toBeDefined();
      expect(terminalNotif?.status).toBe('PENDING');
      expect(terminalNotif?.message_text).toContain('PayPal authorization cancellation confirmed');
    });

    it('27.6 Failure recovery: definitive remote void failure produces a FAILED notification', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-RECON-FAIL-1',
        remote_void_status: 'PENDING',
      });

      // Remote auth is CREATED
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-RECON-FAIL-1',
        status: 'CREATED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      // Void retry definitively rejected with 400 INVALID_REQUEST
      vi.mocked(mockAuthorizationsService.voidAuthorization).mockRejectedValue(
        new AuthorizationError('INVALID_REQUEST', 'Authorization cannot be voided', { debugId: 'dbg-400' })
      );

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      const updatedReq = repos.paymentRequests.getById(req.id);
      expect(updatedReq?.remote_void_status).toBe('FAILED');

      const notif = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(notif).toBeDefined();
      expect(notif?.status).toBe('PENDING');
      expect(notif?.message_text).toContain('Payment voided locally and budget reservation released. PayPal cancellation failed and requires attention.');
    });

    it('27.7 Missing authorization ID produces an appropriate FAILED notification', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: null,
        remote_void_status: 'PENDING',
      });

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      const updatedReq = repos.paymentRequests.getById(req.id);
      expect(updatedReq?.remote_void_status).toBe('FAILED');

      const notif = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(notif).toBeDefined();
      expect(notif?.status).toBe('PENDING');
      expect(notif?.message_text).toContain('Payment voided locally and budget reservation released. PayPal cancellation failed and requires attention.');
    });

    it('27.8 SENT PENDING -> CONFIRMED creates exactly one terminal update', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-SENT-CONFIRM-1',
        remote_void_status: 'PENDING',
      });

      // Seed initial SENT notification with PENDING wording
      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Payment voided locally and budget reservation released. PayPal cancellation is pending reconciliation.',
        parse_mode: 'HTML',
      });
      const claimed = repos.notifications.claimPending('claim-sent-c', undefined, 10);
      const row = claimed.find((c) => c.dedup_key === `payment_voided:${req.id}`)!;
      repos.notifications.markSent(row.id, 'claim-sent-c', 555001);

      // Remote authorization is confirmed VOIDED
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-SENT-CONFIRM-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // Original remains SENT
      const orig = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(orig?.status).toBe('SENT');
      expect(orig?.message_text).toContain('pending reconciliation');

      // Exactly one terminal update exists
      const terminal = repos.notifications.getByDedupKey(`payment_voided:${req.id}:confirmed`);
      expect(terminal).toBeDefined();
      expect(terminal?.status).toBe('PENDING');
      expect(terminal?.message_text).toBe(
        '🛑 <b>Payment Request Voided</b>\n\n' +
        `<b>Request ID:</b> <code>${req.id}</code>\n` +
        '<b>Amount:</b> 25.00 USD\n' +
        '<b>Vendor:</b> Acme Cloud\n' +
        '<b>Reason:</b> Owner rejected and voided payment hold\n' +
        '<b>Status:</b> Payment voided locally. PayPal authorization cancellation confirmed.'
      );

      const allRows = db.prepare(
        "SELECT * FROM notification_outbox WHERE request_id = ? ORDER BY created_at ASC"
      ).all(req.id) as { dedup_key: string; status: string }[];
      expect(allRows.length).toBe(2);
      expect(allRows[0]?.dedup_key).toBe(`payment_voided:${req.id}`);
      expect(allRows[0]?.status).toBe('SENT');
      expect(allRows[1]?.dedup_key).toBe(`payment_voided:${req.id}:confirmed`);
      expect(allRows[1]?.status).toBe('PENDING');
    });

    it('27.9 SENT PENDING -> FAILED creates exactly one terminal update', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-SENT-FAIL-1',
        remote_void_status: 'PENDING',
      });

      // Seed initial SENT notification with PENDING wording
      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Payment voided locally and budget reservation released. PayPal cancellation is pending reconciliation.',
        parse_mode: 'HTML',
      });
      const claimed = repos.notifications.claimPending('claim-sent-f', undefined, 10);
      const row = claimed.find((c) => c.dedup_key === `payment_voided:${req.id}`)!;
      repos.notifications.markSent(row.id, 'claim-sent-f', 555002);

      // Remote authorization void definitively fails
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-SENT-FAIL-1',
        status: 'CREATED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);
      vi.mocked(mockAuthorizationsService.voidAuthorization).mockRejectedValue(
        new AuthorizationError('DECLINED', 'Authorization void declined', { debugId: 'dbg-declined' })
      );

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // Original remains SENT
      const orig = repos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(orig?.status).toBe('SENT');
      expect(orig?.message_text).toContain('pending reconciliation');

      // Exactly one terminal update exists with FAILED wording
      const terminal = repos.notifications.getByDedupKey(`payment_voided:${req.id}:failed`);
      expect(terminal).toBeDefined();
      expect(terminal?.status).toBe('PENDING');
      expect(terminal?.message_text).toContain(
        'Payment voided locally and budget reservation released. PayPal cancellation failed and requires attention.'
      );

      const allRows = db.prepare(
        "SELECT * FROM notification_outbox WHERE request_id = ? ORDER BY created_at ASC"
      ).all(req.id) as { dedup_key: string }[];
      expect(allRows.length).toBe(2);
      expect(allRows[1]?.dedup_key).toBe(`payment_voided:${req.id}:failed`);
    });

    it('27.10 Idempotency: repeated reconciliation creates no duplicate terminal updates', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-SENT-IDEMP-1',
        remote_void_status: 'PENDING',
      });

      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Payment voided locally and budget reservation released. PayPal cancellation is pending reconciliation.',
        parse_mode: 'HTML',
      });
      const claimed = repos.notifications.claimPending('claim-idemp', undefined, 10);
      const row = claimed.find((c) => c.dedup_key === `payment_voided:${req.id}`)!;
      repos.notifications.markSent(row.id, 'claim-idemp', 555003);

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-SENT-IDEMP-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      // 1st reconciliation tick
      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // 2nd reconciliation tick
      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // 3rd reconciliation tick
      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // Verify exactly 1 terminal update row exists in the outbox
      const terminalRows = db.prepare(
        "SELECT * FROM notification_outbox WHERE dedup_key = ?"
      ).all(`payment_voided:${req.id}:confirmed`) as { id: string }[];
      expect(terminalRows.length).toBe(1);

      // Total rows for this request is exactly 2 (initial SENT + terminal PENDING)
      const totalRows = db.prepare(
        "SELECT COUNT(*) as count FROM notification_outbox WHERE request_id = ?"
      ).get(req.id) as { count: number };
      expect(totalRows.count).toBe(2);
    });

    it('27.11 Concurrency: Multiple workers cannot deliver terminal update before original PROCESSING notification completes', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-WORKER-ORDER-1',
        remote_void_status: 'PENDING',
      });

      // Seed initial notification
      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Pending void notification',
        parse_mode: 'HTML',
      });

      // Worker 1 claims original notification -> status is PROCESSING
      const worker1ClaimId = 'worker-1-claim';
      const worker1Batch = repos.notifications.claimPending(worker1ClaimId, undefined, 10);
      expect(worker1Batch.length).toBe(1);
      expect(worker1Batch[0]?.dedup_key).toBe(`payment_voided:${req.id}`);
      expect(worker1Batch[0]?.status).toBe('PROCESSING');

      // Reconciler runs concurrently while Worker 1 is in-flight
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-WORKER-ORDER-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // Terminal update is enqueued in DB
      const terminalNotif = repos.notifications.getByDedupKey(`payment_voided:${req.id}:confirmed`);
      expect(terminalNotif).toBeDefined();
      expect(terminalNotif?.status).toBe('PENDING');

      // Worker 2 attempts to claim next pending batch while Worker 1 is still in flight
      const worker2ClaimId = 'worker-2-claim';
      const worker2Batch = repos.notifications.claimPending(worker2ClaimId, undefined, 10);

      // GUARANTEE: Worker 2 cannot claim the terminal update while Worker 1 is still PROCESSING
      expect(worker2Batch.length).toBe(0);

      // Now Worker 1 finishes and marks original SENT
      repos.notifications.markSent(worker1Batch[0]!.id, worker1ClaimId, 777001);

      // Now Worker 2 is allowed to claim the terminal update
      const worker2BatchAfter = repos.notifications.claimPending(worker2ClaimId, undefined, 10);
      expect(worker2BatchAfter.length).toBe(1);
      expect(worker2BatchAfter[0]?.dedup_key).toBe(`payment_voided:${req.id}:confirmed`);
    });

    it('27.12 Concurrency: Original PROCESSING notification becoming SENT allows terminal update delivery', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-SENT-ALLOW-1',
        remote_void_status: 'PENDING',
      });

      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Initial message',
        parse_mode: 'HTML',
      });

      const claimId = 'worker-claim-allow';
      const claimed = repos.notifications.claimPending(claimId, undefined, 10);
      expect(claimed.length).toBe(1);

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-SENT-ALLOW-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // While in PROCESSING, terminal update is not claimable
      expect(repos.notifications.claimPending('worker-claim-blocked').length).toBe(0);

      // Transition original to SENT
      repos.notifications.markSent(claimed[0]!.id, claimId, 777002);

      // Terminal update is now claimable
      const nextBatch = repos.notifications.claimPending('worker-claim-unblocked');
      expect(nextBatch.length).toBe(1);
      expect(nextBatch[0]?.dedup_key).toBe(`payment_voided:${req.id}:confirmed`);
    });

    it('27.13 Concurrency: Original PROCESSING notification becoming DEAD does not lose terminal outcome', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-DEAD-ALLOW-1',
        remote_void_status: 'PENDING',
      });

      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Initial message',
        parse_mode: 'HTML',
      });

      const claimId = 'worker-claim-dead';
      const claimed = repos.notifications.claimPending(claimId, undefined, 10);
      expect(claimed.length).toBe(1);

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-DEAD-ALLOW-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // Blocked while PROCESSING
      expect(repos.notifications.claimPending('worker-claim-blocked-2').length).toBe(0);

      // Original permanently fails in delivery (e.g. 400 Bad Request) -> marked DEAD
      repos.notifications.markFailed(
        claimed[0]!.id,
        claimId,
        new Date().toISOString(),
        'Telegram 400 Bad Request: chat not found',
        true
      );
      expect(repos.notifications.getById(claimed[0]!.id)?.status).toBe('DEAD');

      // Terminal update is immediately unblocked and claimable
      const nextBatch = repos.notifications.claimPending('worker-claim-after-dead');
      expect(nextBatch.length).toBe(1);
      expect(nextBatch[0]?.dedup_key).toBe(`payment_voided:${req.id}:confirmed`);
    });

    it('27.14 Crash Recovery: Process restart preserves ordering and eventual terminal update delivery', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-RESTART-ORDER-1',
        remote_void_status: 'PENDING',
      });

      const initialTime = new Date(Date.now() - 60000).toISOString(); // 60s ago
      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: initialTime,
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Initial pending void notification',
        parse_mode: 'HTML',
        created_at: initialTime,
      });

      // Claim original notification with lease 50 seconds ago
      const crashedClaimId = 'worker-crashed-claim';
      const claimedAt = new Date(Date.now() - 50000).toISOString();
      const claimed = repos.notifications.claimPending(crashedClaimId, initialTime, 10);
      expect(claimed.length).toBe(1);

      // Force claimed_at to 50s ago to simulate crash during flight
      db.prepare("UPDATE notification_outbox SET claimed_at = ? WHERE id = ?").run(claimedAt, claimed[0]!.id);

      // Reconciler enqueues terminal update before crash
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-RESTART-ORDER-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // SIMULATE PROCESS RESTART:
      // A new Repositories instance starts over the existing SQLite database
      const restartedRepos = new Repositories(db);

      // Before lease reclamation: terminal update MUST NOT be claimed
      const prematureBatch = restartedRepos.notifications.claimPending('restarted-worker-claim-1');
      expect(prematureBatch.length).toBe(0);

      // Background lease reaper runs (lease older than 30s)
      const olderThanIso = new Date(Date.now() - 30000).toISOString();
      const reclaimedCount = restartedRepos.notifications.reclaimAbandoned(olderThanIso);
      expect(reclaimedCount).toBe(1);

      // Verify original notification is back to PENDING
      const reclaimedOrig = restartedRepos.notifications.getByDedupKey(`payment_voided:${req.id}`);
      expect(reclaimedOrig?.status).toBe('PENDING');

      // Now worker claims: MUST claim original notification first (due to FIFO dependency), NOT terminal update!
      const firstBatchAfterRestart = restartedRepos.notifications.claimPending('restarted-worker-claim-2');
      expect(firstBatchAfterRestart.length).toBe(1);
      expect(firstBatchAfterRestart[0]?.dedup_key).toBe(`payment_voided:${req.id}`);

      // While original is in flight again, terminal update is still blocked
      const secondBatchPremature = restartedRepos.notifications.claimPending('restarted-worker-claim-3');
      expect(secondBatchPremature.length).toBe(0);

      // Original completes delivery
      restartedRepos.notifications.markSent(firstBatchAfterRestart[0]!.id, 'restarted-worker-claim-2', 777003);

      // Now terminal update is claimed and delivered
      const finalBatch = restartedRepos.notifications.claimPending('restarted-worker-claim-4');
      expect(finalBatch.length).toBe(1);
      expect(finalBatch[0]?.dedup_key).toBe(`payment_voided:${req.id}:confirmed`);
    });

    it('27.15 Dead-letter handling: Original DEAD/FAILED notification remains unchanged while terminal update is independently enqueued', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-DEAD-INDEP-1',
        remote_void_status: 'PENDING',
      });

      // Seed original notification
      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Initial message',
        parse_mode: 'HTML',
      });

      // Simulate 3 failed attempts leading to DEAD
      const claimId = 'worker-dead-indep-claim';
      const claimed = repos.notifications.claimPending(claimId, undefined, 10);
      const row = claimed[0]!;

      repos.notifications.markFailed(
        row.id,
        claimId,
        new Date().toISOString(),
        'Telegram 403 Forbidden: bot was blocked by the user',
        true // terminal failure
      );

      const deadBefore = repos.notifications.getById(row.id);
      expect(deadBefore?.status).toBe('DEAD');
      expect(deadBefore?.attempt_count).toBe(1);
      expect(deadBefore?.last_error).toContain('bot was blocked');

      // Reconciler runs and confirms remote void
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-DEAD-INDEP-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      // GUARANTEE: Original DEAD row is completely untouched
      const deadAfter = repos.notifications.getById(row.id);
      expect(deadAfter?.status).toBe('DEAD');
      expect(deadAfter?.attempt_count).toBe(1);
      expect(deadAfter?.last_error).toBe(deadBefore?.last_error);
      expect(deadAfter?.sent_at).toBeNull();
      expect(deadAfter?.telegram_message_id).toBeNull();

      // GUARANTEE: Terminal update was independently enqueued with its own outbox lifecycle
      const terminalNotif = repos.notifications.getByDedupKey(`payment_voided:${req.id}:confirmed`);
      expect(terminalNotif).toBeDefined();
      expect(terminalNotif?.status).toBe('PENDING');
      expect(terminalNotif?.attempt_count).toBe(0);
      expect(terminalNotif?.max_attempts).toBe(3);
      expect(terminalNotif?.last_error).toBeNull();

      // Because original is DEAD (terminal), terminal update is immediately claimable
      const claimedTerminal = repos.notifications.claimPending('worker-claim-terminal');
      expect(claimedTerminal.length).toBe(1);
      expect(claimedTerminal[0]?.dedup_key).toBe(`payment_voided:${req.id}:confirmed`);
    });

    it('27.16 Idempotency: Repeated reconciliation on DEAD/FAILED notification does not create duplicate updates', async () => {
      const req = seedRequest('VOIDED', {
        paypal_authorization_id: 'AUTH-DEAD-IDEMP-1',
        remote_void_status: 'PENDING',
      });

      repos.notifications.enqueue({
        event_type: 'PAYMENT_VOIDED',
        recipient_chat_id: '12345678',
        owner_id: 'default',
        linked_at: new Date().toISOString(),
        request_id: req.id,
        dedup_key: `payment_voided:${req.id}`,
        message_text: 'Initial message',
        parse_mode: 'HTML',
      });

      const claimId = 'worker-dead-idemp';
      const claimed = repos.notifications.claimPending(claimId, undefined, 10);
      repos.notifications.markFailed(
        claimed[0]!.id,
        claimId,
        new Date().toISOString(),
        'Terminal error',
        true
      );

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-DEAD-IDEMP-1',
        status: 'VOIDED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: false,
      } as PayPalAuthorizationDetails);

      // Reconcile 3 times
      await reconcilePaymentRequest(db, req.id, getReconcileOptions());
      await reconcilePaymentRequest(db, req.id, getReconcileOptions());
      await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      const allTerminal = db.prepare(
        "SELECT * FROM notification_outbox WHERE dedup_key = ?"
      ).all(`payment_voided:${req.id}:confirmed`) as { id: string }[];
      expect(allTerminal.length).toBe(1);

      const totalRows = db.prepare(
        "SELECT COUNT(*) as count FROM notification_outbox WHERE request_id = ?"
      ).get(req.id) as { count: number };
      expect(totalRows.count).toBe(2);
    });
  });

  // ==========================================================================
  // M6-T5 WS3 & WS2: Reconciliation State Fallthrough & Graceful Shutdown
  // ==========================================================================
  describe('M6-T5: Authorization State Fallthrough & ReconcilerWorker Graceful Stop', () => {
    it('Flow C CAPTURING with PARTIALLY_CAPTURED fails closed with AUTHORIZATION_PARTIALLY_CAPTURED (never UNCAPTURED_IN_FLIGHT)', async () => {
      const req = seedRequest('CAPTURING', { paypal_authorization_id: 'AUTH-PARTIAL-C1' });

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-PARTIAL-C1',
        status: 'PARTIALLY_CAPTURED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCapturable: true,
        isVoidable: false,
        isCaptured: false,
        isPartiallyCaptured: true,
        isVoided: false,
        isExpired: false,
        isDenied: false,
        isPending: false,
      } as unknown as PayPalAuthorizationDetails);

      const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      expect(result.status).toBe('UNRESOLVED');
      expect(result.actionTaken).toBe('NO_OP');
      expect(result.reconciled).toBe(false);

      const updated = repos.paymentRequests.getById(req.id)!;
      expect(updated.status).toBe('CAPTURING');
      const ledger = repos.ledger.listByRequestId(req.id);
      expect(ledger.filter((l) => l.kind === 'SPEND')).toHaveLength(0);
      expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(0);

      const audit = repos.auditLog.listByRequestId(req.id);
      const unresolvedAudit = audit.find((a) => a.event === 'RECONCILIATION_UNRESOLVED');
      expect(unresolvedAudit).toBeDefined();
      const payload = JSON.parse(unresolvedAudit!.payload) as { reason?: string; authorizationStatus?: string };
      expect(payload.reason).toBe('AUTHORIZATION_PARTIALLY_CAPTURED');
      expect(payload.authorizationStatus).toBe('PARTIALLY_CAPTURED');
    });

    it('Flow C CAPTURING with PENDING fails closed with AUTHORIZATION_CAPTURE_PENDING', async () => {
      const req = seedRequest('CAPTURING', { paypal_authorization_id: 'AUTH-PENDING-C1' });

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-PENDING-C1',
        status: 'PENDING',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCapturable: false,
        isVoidable: false,
        isCaptured: false,
        isPartiallyCaptured: false,
        isVoided: false,
        isExpired: false,
        isDenied: false,
        isPending: true,
      } as PayPalAuthorizationDetails);

      const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      expect(result.status).toBe('UNRESOLVED');
      expect(result.actionTaken).toBe('NO_OP');
      expect(repos.paymentRequests.getById(req.id)?.status).toBe('CAPTURING');

      const unresolvedAudit = repos.auditLog
        .listByRequestId(req.id)
        .find((a) => a.event === 'RECONCILIATION_UNRESOLVED');
      expect(unresolvedAudit).toBeDefined();
      expect(JSON.parse(unresolvedAudit!.payload).reason).toBe('AUTHORIZATION_CAPTURE_PENDING');
    });

    it('Flow C CAPTURING with unexpected remote status fails closed with UNEXPECTED_REMOTE_AUTHORIZATION_STATUS', async () => {
      const req = seedRequest('CAPTURING', { paypal_authorization_id: 'AUTH-WEIRD-C1' });

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-WEIRD-C1',
        status: 'SOMETHING_NEW_AT_PAYPAL',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCapturable: false,
        isVoidable: false,
        isCaptured: false,
        isPartiallyCaptured: false,
        isVoided: false,
        isExpired: false,
        isDenied: false,
        isPending: false,
      } as unknown as PayPalAuthorizationDetails);

      const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      expect(result.status).toBe('UNRESOLVED');
      expect(result.actionTaken).toBe('NO_OP');
      expect(repos.paymentRequests.getById(req.id)?.status).toBe('CAPTURING');

      const unresolvedAudit = repos.auditLog
        .listByRequestId(req.id)
        .find((a) => a.event === 'RECONCILIATION_UNRESOLVED');
      expect(unresolvedAudit).toBeDefined();
      expect(JSON.parse(unresolvedAudit!.payload).reason).toBe('UNEXPECTED_REMOTE_AUTHORIZATION_STATUS');
    });

    it('Flow B HELD with remote PENDING review fails closed with AUTHORIZATION_PENDING_REVIEW_WHILE_HELD (never falsifying CAPTURED)', async () => {
      const req = seedRequest('HELD', { paypal_authorization_id: 'AUTH-HELD-PEND-1' });

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-HELD-PEND-1',
        status: 'PENDING',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCapturable: false,
        isVoidable: false,
        isCaptured: false,
        isPartiallyCaptured: false,
        isVoided: false,
        isExpired: false,
        isDenied: false,
        isPending: true,
      } as PayPalAuthorizationDetails);

      const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      expect(result.status).toBe('UNRESOLVED');
      expect(result.actionTaken).toBe('NO_OP');
      expect(repos.paymentRequests.getById(req.id)?.status).toBe('HELD');
      expect(repos.ledger.listByRequestId(req.id).filter((l) => l.kind === 'RELEASE')).toHaveLength(0);

      const unresolvedAudit = repos.auditLog
        .listByRequestId(req.id)
        .find((a) => a.event === 'RECONCILIATION_UNRESOLVED');
      expect(unresolvedAudit).toBeDefined();
      expect(JSON.parse(unresolvedAudit!.payload).reason).toBe('AUTHORIZATION_PENDING_REVIEW_WHILE_HELD');
    });

    it('Flow B HELD with remote PARTIALLY_CAPTURED fails closed with AUTHORIZATION_PARTIALLY_CAPTURED_WHILE_HELD', async () => {
      const req = seedRequest('HELD', { paypal_authorization_id: 'AUTH-HELD-PARTIAL-1' });

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-HELD-PARTIAL-1',
        status: 'PARTIALLY_CAPTURED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCapturable: false,
        isVoidable: false,
        isCaptured: false,
        isPartiallyCaptured: true,
        isVoided: false,
        isExpired: false,
        isDenied: false,
        isPending: false,
      } as unknown as PayPalAuthorizationDetails);

      const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      expect(result.status).toBe('UNRESOLVED');
      expect(result.actionTaken).toBe('NO_OP');
      expect(repos.paymentRequests.getById(req.id)?.status).toBe('HELD');

      const unresolvedAudit = repos.auditLog
        .listByRequestId(req.id)
        .find((a) => a.event === 'RECONCILIATION_UNRESOLVED');
      expect(unresolvedAudit).toBeDefined();
      expect(JSON.parse(unresolvedAudit!.payload).reason).toBe('AUTHORIZATION_PARTIALLY_CAPTURED_WHILE_HELD');
    });

    it('Flow B HELD with remote CAPTURED fails closed with AUTHORIZATION_ALREADY_CAPTURED_WHILE_HELD', async () => {
      const req = seedRequest('HELD', { paypal_authorization_id: 'AUTH-HELD-CAP-1' });

      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValue({
        id: 'AUTH-HELD-CAP-1',
        status: 'CAPTURED',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCapturable: false,
        isVoidable: false,
        isCaptured: true,
        isPartiallyCaptured: false,
        isVoided: false,
        isExpired: false,
        isDenied: false,
        isPending: false,
      } as unknown as PayPalAuthorizationDetails);

      const result = await reconcilePaymentRequest(db, req.id, getReconcileOptions());

      expect(result.status).toBe('UNRESOLVED');
      expect(result.actionTaken).toBe('NO_OP');
      expect(repos.paymentRequests.getById(req.id)?.status).toBe('HELD');

      const unresolvedAudit = repos.auditLog
        .listByRequestId(req.id)
        .find((a) => a.event === 'RECONCILIATION_UNRESOLVED');
      expect(unresolvedAudit).toBeDefined();
      expect(JSON.parse(unresolvedAudit!.payload).reason).toBe('AUTHORIZATION_ALREADY_CAPTURED_WHILE_HELD');
    });

    it('Flow B HELD with non-capturable CREATED or unexpected status fails closed with UNEXPECTED_REMOTE_AUTHORIZATION_STATUS', async () => {
      const req1 = seedRequest('HELD', { paypal_authorization_id: 'AUTH-HELD-NONCAP-1' });
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValueOnce({
        id: 'AUTH-HELD-NONCAP-1',
        status: 'CREATED',
        amountMinor: req1.amount_minor,
        currency: 'USD',
        isCapturable: false,
        isVoidable: true,
        isCaptured: false,
        isPartiallyCaptured: false,
        isVoided: false,
        isExpired: false,
        isDenied: false,
        isPending: false,
      } as unknown as PayPalAuthorizationDetails);

      const res1 = await reconcilePaymentRequest(db, req1.id, getReconcileOptions());
      expect(res1.status).toBe('UNRESOLVED');
      expect(res1.actionTaken).toBe('NO_OP');
      expect(repos.paymentRequests.getById(req1.id)?.status).toBe('HELD');
      const audit1 = repos.auditLog.listByRequestId(req1.id).find((a) => a.event === 'RECONCILIATION_UNRESOLVED');
      expect(JSON.parse(audit1!.payload).reason).toBe('UNEXPECTED_REMOTE_AUTHORIZATION_STATUS');

      const req2 = seedRequest('HELD', { paypal_authorization_id: 'AUTH-HELD-WEIRD-2' });
      vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValueOnce({
        id: 'AUTH-HELD-WEIRD-2',
        status: 'UNKNOWN_REMOTE_STATE',
        amountMinor: req2.amount_minor,
        currency: 'USD',
        isCapturable: false,
        isVoidable: false,
        isCaptured: false,
        isPartiallyCaptured: false,
        isVoided: false,
        isExpired: false,
        isDenied: false,
        isPending: false,
      } as unknown as PayPalAuthorizationDetails);

      const res2 = await reconcilePaymentRequest(db, req2.id, getReconcileOptions());
      expect(res2.status).toBe('UNRESOLVED');
      expect(res2.actionTaken).toBe('NO_OP');
      expect(repos.paymentRequests.getById(req2.id)?.status).toBe('HELD');
    });

    it('Flow B HELD with remote DENIED or EXPIRED releases reservation and transitions to FAILED', async () => {
      for (const remoteStatus of ['DENIED', 'EXPIRED'] as const) {
        const req = seedRequest('HELD', { paypal_authorization_id: `AUTH-HELD-${remoteStatus}` });
        vi.mocked(mockAuthorizationsService.getAuthorization).mockResolvedValueOnce({
          id: `AUTH-HELD-${remoteStatus}`,
          status: remoteStatus,
          amountMinor: req.amount_minor,
          currency: 'USD',
          isCapturable: false,
          isVoidable: false,
          isCaptured: false,
          isPartiallyCaptured: false,
          isVoided: false,
          isExpired: remoteStatus === 'EXPIRED',
          isDenied: remoteStatus === 'DENIED',
          isPending: false,
        } as PayPalAuthorizationDetails);

        const res = await reconcilePaymentRequest(db, req.id, getReconcileOptions());
        expect(res.status).toBe('FAILED');
        expect(res.actionTaken).toBe('FAILED');
        expect(repos.paymentRequests.getById(req.id)?.status).toBe('FAILED');
        expect(repos.ledger.listByRequestId(req.id).filter((l) => l.kind === 'RELEASE')).toHaveLength(1);
      }
    });

    it('ReconcilerWorker.stop() awaits in-flight PayPal HTTP call and prevents subsequent ticks', async () => {
      let releaseGetAuth!: () => void;
      const getAuthStarted = new Promise<void>((resolve) => {
        vi.mocked(mockAuthorizationsService.getAuthorization).mockImplementation(async (authId) => {
          resolve();
          await new Promise<void>((r) => {
            releaseGetAuth = r;
          });
          return {
            id: authId,
            status: 'CAPTURED',
            amountMinor: toMinorUnits(2500),
            currency: 'USD',
            isCapturable: false,
            isVoidable: false,
            isCaptured: true,
            isPartiallyCaptured: false,
            isVoided: false,
            isExpired: false,
            isDenied: false,
            isPending: false,
          } as PayPalAuthorizationDetails;
        });
      });

      const worker = new ReconcilerWorker({
        db,
        repos,
        ordersService: mockOrdersService,
        authorizationsService: mockAuthorizationsService,
        intervalMs: 100,
      });

      const req1 = seedRequest('CAPTURING', { paypal_authorization_id: 'AUTH-STOP-1' });
      const req2 = seedRequest('CAPTURING', { paypal_authorization_id: 'AUTH-STOP-2' });

      worker.start();
      const inFlightTick = worker.tick();
      await getAuthStarted;

      let stopResolved = false;
      const stopPromise = worker.stop().then(() => {
        stopResolved = true;
      });

      await new Promise((r) => setTimeout(r, 30));
      expect(stopResolved).toBe(false);
      expect(worker.isRunning()).toBe(false);

      // Additional tick invocation after stop() begins must no-op immediately
      const skippedTick = await worker.tick();
      expect(skippedTick.totalProcessed).toBe(0);

      releaseGetAuth();
      const [tickRes] = await Promise.all([inFlightTick, stopPromise]);
      expect(stopResolved).toBe(true);

      // One candidate completed CAPTURED + SPEND before shutdown halted the remaining candidate
      expect(tickRes.totalProcessed).toBe(1);
      const statuses = [
        repos.paymentRequests.getById(req1.id)?.status,
        repos.paymentRequests.getById(req2.id)?.status,
      ].sort();
      expect(statuses).toEqual(['CAPTURED', 'CAPTURING']);
    });
  });

  // ==========================================================================
  // Task C2: End-to-End Ambiguous 2xx Validation -> Order ID Preservation -> Reconcile
  // ==========================================================================
  describe('Task C2: Ambiguous 2xx Order Parsing Recovery & Reconciliation', () => {
    function buildRealOrdersService(fetchFn: FetchFunction): PayPalOrdersService {
      const tm = new TokenManager({
        baseUrl: 'https://api-m.sandbox.paypal.com',
        credentialResolver: () => ({ clientId: 'cid', clientSecret: 'csec' }),
        fetchFn: async () =>
          new Response(JSON.stringify({ access_token: 'tok-c2', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      });
      const httpClient = new PayPalHttpClient({
        baseUrl: 'https://api-m.sandbox.paypal.com',
        tokenManager: tm,
        fetchFn,
        defaultConnectorKey: 'acme_cloud',
        getRetryDelayMs: () => 0,
      });
      return new PayPalOrdersService({ client: httpClient, defaultConnectorKey: 'acme_cloud' });
    }

    it('Flow A: 2xx validation failure preserves orderId on row & audit without marking CAPTURED, then reconciles to CAPTURED + SPEND', async () => {
      const req = seedRequest('AUTO_EXECUTING', { amount_minor: toMinorUnits(1200) });

      const fetchMock = vi.fn<FetchFunction>()
        // 1. POST /v2/checkout/orders returns 201 with valid id but missing intent & payments
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'ORD-C2-FLOW-A',
              status: 'COMPLETED',
              purchase_units: [{ reference_id: 'default' }],
            }),
            {
              status: 201,
              headers: { 'Content-Type': 'application/json', 'paypal-debug-id': 'dbg-c2-a1' },
            }
          )
        )
        // 2. GET /v2/checkout/orders/ORD-C2-FLOW-A returns full authoritative order
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'ORD-C2-FLOW-A',
              status: 'COMPLETED',
              intent: 'CAPTURE',
              purchase_units: [
                {
                  custom_id: req.id,
                  amount: { currency_code: 'USD', value: '12.00' },
                  payments: {
                    captures: [
                      {
                        id: 'CAP-C2-FLOW-A',
                        status: 'COMPLETED',
                        amount: { currency_code: 'USD', value: '12.00' },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'paypal-debug-id': 'dbg-c2-a2' },
            }
          )
        );

      const realOrders = buildRealOrdersService(fetchMock);

      await expect(
        executeDecision({ requestId: req.id }, { db, repos, ordersService: realOrders })
      ).rejects.toThrow();

      // Must NOT mark CAPTURED; preserves orderId for reconciler
      const afterAmbig = repos.paymentRequests.getById(req.id)!;
      expect(afterAmbig.status).toBe('AUTO_EXECUTING');
      expect(afterAmbig.paypal_order_id).toBe('ORD-C2-FLOW-A');
      expect(repos.ledger.listByRequestId(req.id).map((l) => l.kind)).toEqual(['RESERVE']);

      // Reconcile recovers orderId and settles to CAPTURED + single SPEND
      const recRes = await reconcilePaymentRequest(db, req.id, {
        repos,
        ordersService: realOrders,
        authorizationsService: mockAuthorizationsService,
      });

      expect(recRes.status).toBe('CAPTURED');
      expect(recRes.actionTaken).toBe('CAPTURED');
      expect(recRes.reconciled).toBe(true);
      expect(repos.paymentRequests.getById(req.id)?.paypal_capture_id).toBe('CAP-C2-FLOW-A');
      expect(repos.ledger.listByRequestId(req.id).map((l) => l.kind)).toEqual(['RESERVE', 'SPEND']);
      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });

    it('Flow B: 2xx validation failure preserves orderId while HELD, reconciles via REPAIRED_HOLD_ID, and succeeds later on Flow C capture', async () => {
      const req = seedRequest('HELD', { amount_minor: toMinorUnits(2500) });

      const fetchMock = vi.fn<FetchFunction>()
        // 1. POST /v2/checkout/orders returns 201 with valid id but missing custom_id
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'ORD-C2-FLOW-B',
              status: 'COMPLETED',
              purchase_units: [
                {
                  payments: {
                    authorizations: [
                      {
                        id: 'AUTH-C2-FLOW-B',
                        status: 'CREATED',
                        amount: { currency_code: 'USD', value: '25.00' },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 201,
              headers: { 'Content-Type': 'application/json', 'paypal-debug-id': 'dbg-c2-b1' },
            }
          )
        )
        // 2. GET /v2/checkout/orders/ORD-C2-FLOW-B returns full authoritative order
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'ORD-C2-FLOW-B',
              status: 'COMPLETED',
              intent: 'AUTHORIZE',
              purchase_units: [
                {
                  custom_id: req.id,
                  amount: { currency_code: 'USD', value: '25.00' },
                  payments: {
                    authorizations: [
                      {
                        id: 'AUTH-C2-FLOW-B',
                        status: 'CREATED',
                        amount: { currency_code: 'USD', value: '25.00' },
                      },
                    ],
                  },
                },
              ],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json', 'paypal-debug-id': 'dbg-c2-b2' },
            }
          )
        );

      const realOrders = buildRealOrdersService(fetchMock);

      await expect(
        executeDecision({ requestId: req.id }, { db, repos, ordersService: realOrders })
      ).rejects.toThrow();

      // Must keep HELD + RESERVE and preserve paypal_order_id without authorization_id
      const afterAmbig = repos.paymentRequests.getById(req.id)!;
      expect(afterAmbig.status).toBe('HELD');
      expect(afterAmbig.paypal_order_id).toBe('ORD-C2-FLOW-B');
      expect(afterAmbig.paypal_authorization_id).toBeNull();

      // Reconcile links authorization ID cleanly
      const recRes = await reconcilePaymentRequest(db, req.id, {
        repos,
        ordersService: realOrders,
        authorizationsService: mockAuthorizationsService,
      });
      expect(recRes.status).toBe('HELD');
      expect(recRes.actionTaken).toBe('REPAIRED_HOLD_ID');
      expect(recRes.authorizationId).toBe('AUTH-C2-FLOW-B');
      expect(repos.paymentRequests.getById(req.id)?.paypal_authorization_id).toBe('AUTH-C2-FLOW-B');

      // Subsequent owner approval + Flow C capture must succeed cleanly after Flow B reconciliation
      transitionPaymentRequest(db, repos, {
        requestId: req.id,
        to: 'APPROVED',
        actor: 'owner',
        event: 'OWNER_APPROVED',
      });
      vi.mocked(mockAuthorizationsService.captureAuthorization).mockResolvedValueOnce({
        id: 'CAP-C2-FLOW-C',
        status: 'COMPLETED',
        isCaptured: true,
        amountMinor: req.amount_minor,
        currency: 'USD',
        finalCapture: true,
      } as PayPalCaptureResult);

      const capRes = await executeDecision(
        { requestId: req.id },
        { db, repos, ordersService: realOrders, authorizationsService: mockAuthorizationsService }
      );
      expect(capRes.status).toBe('CAPTURED');
      expect(capRes.executedAction).toBe('CAPTURED_APPROVED');
      expect(capRes.captureId).toBe('CAP-C2-FLOW-C');
      expect(repos.ledger.listByRequestId(req.id).map((l) => l.kind)).toEqual(['RESERVE', 'SPEND']);
      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });

    it('Flow A: rejects capture.amountMinor mismatch against persisted request and never accepts CAPTURED', async () => {
      const req = seedRequest('AUTO_EXECUTING', {
        paypal_order_id: 'ORD-C2-CAP-MISMATCH',
        amount_minor: toMinorUnits(2500),
      });

      vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
        id: 'ORD-C2-CAP-MISMATCH',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        customId: req.id,
        amountMinor: toMinorUnits(2500),
        currency: 'USD',
        isCaptured: true,
        isAuthorized: false,
        capture: {
          id: 'CAP-MISMATCH-AMT',
          status: 'COMPLETED',
          amountMinor: toMinorUnits(1200),
          currency: 'USD',
        },
      } as PayPalOrderResult);

      const res = await reconcilePaymentRequest(db, req.id, getReconcileOptions());
      expect(res.status).toBe('UNRESOLVED');
      expect(res.actionTaken).toBe('NO_OP');

      const updated = repos.paymentRequests.getById(req.id)!;
      expect(updated.status).toBe('AUTO_EXECUTING');
      expect(repos.ledger.listByRequestId(req.id).map((l) => l.kind)).toEqual(['RESERVE']);
      expect(
        repos.auditLog.listByRequestId(req.id).some((a) => a.event === 'RECONCILIATION_INTEGRITY_MISMATCH')
      ).toBe(true);
      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });

    it('Flow A: persists provisional orderId recovered from EXECUTION_AMBIGUOUS even if remote lookup fails', async () => {
      const req = seedRequest('AUTO_EXECUTING', { paypal_order_id: null });

      writeAuditLogEntry(db, repos, {
        actor: 'system',
        event: 'EXECUTION_AMBIGUOUS',
        requestId: req.id,
        payload: { paypal_order_id: 'ORD-PROV-PERSIST-A', reason: 'Parser failure' },
      });

      vi.mocked(mockOrdersService.getOrder).mockRejectedValueOnce(new Error('PayPal 503 Unavailable'));

      const res = await reconcilePaymentRequest(db, req.id, getReconcileOptions());
      expect(res.status).toBe('UNRESOLVED');
      expect(res.orderId).toBe('ORD-PROV-PERSIST-A');

      const updated = repos.paymentRequests.getById(req.id)!;
      expect(updated.status).toBe('AUTO_EXECUTING');
      expect(updated.paypal_order_id).toBe('ORD-PROV-PERSIST-A');
      expect(repos.ledger.listByRequestId(req.id).map((l) => l.kind)).toEqual(['RESERVE']);
      expect(
        repos.auditLog.listByRequestId(req.id).some((a) => a.event === 'RECONCILE_RECOVERED_ORDER_ID')
      ).toBe(true);
      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });

    it('Flow B: rejects authorization.amountMinor mismatch against persisted request without linking auth ID', async () => {
      const req = seedRequest('HELD', {
        paypal_order_id: 'ORD-C2-AUTH-MISMATCH',
        paypal_authorization_id: null,
        amount_minor: toMinorUnits(2500),
      });

      vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
        id: 'ORD-C2-AUTH-MISMATCH',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        customId: req.id,
        amountMinor: toMinorUnits(2500),
        currency: 'USD',
        isCaptured: false,
        isAuthorized: true,
        authorization: {
          id: 'AUTH-MISMATCH-AMT',
          status: 'CREATED',
          amountMinor: toMinorUnits(1000),
          currency: 'USD',
        },
      } as PayPalOrderResult);

      const res = await reconcilePaymentRequest(db, req.id, getReconcileOptions());
      expect(res.status).toBe('UNRESOLVED');
      expect(res.actionTaken).toBe('NO_OP');

      const updated = repos.paymentRequests.getById(req.id)!;
      expect(updated.status).toBe('HELD');
      expect(updated.paypal_authorization_id).toBeNull();
      expect(
        repos.auditLog.listByRequestId(req.id).some((a) => a.event === 'RECONCILIATION_INTEGRITY_MISMATCH')
      ).toBe(true);
      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });

    it('Flow B: recovers provisional orderId from EXECUTION_AMBIGUOUS audit log, persists it, and links authorization', async () => {
      const req = seedRequest('HELD', {
        paypal_order_id: null,
        paypal_authorization_id: null,
        amount_minor: toMinorUnits(2500),
      });

      writeAuditLogEntry(db, repos, {
        actor: 'system',
        event: 'EXECUTION_AMBIGUOUS',
        requestId: req.id,
        payload: { paypal_order_id: 'ORD-PROV-FLOWB', reason: 'Reduced response failure' },
      });

      vi.mocked(mockOrdersService.getOrder).mockResolvedValue({
        id: 'ORD-PROV-FLOWB',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        customId: req.id,
        amountMinor: toMinorUnits(2500),
        currency: 'USD',
        isCaptured: false,
        isAuthorized: true,
        authorization: {
          id: 'AUTH-PROV-FLOWB',
          status: 'CREATED',
          amountMinor: toMinorUnits(2500),
          currency: 'USD',
        },
      } as PayPalOrderResult);

      const res = await reconcilePaymentRequest(db, req.id, getReconcileOptions());
      expect(res.status).toBe('HELD');
      expect(res.actionTaken).toBe('REPAIRED_HOLD_ID');
      expect(res.orderId).toBe('ORD-PROV-FLOWB');
      expect(res.authorizationId).toBe('AUTH-PROV-FLOWB');

      const updated = repos.paymentRequests.getById(req.id)!;
      expect(updated.status).toBe('HELD');
      expect(updated.paypal_order_id).toBe('ORD-PROV-FLOWB');
      expect(updated.paypal_authorization_id).toBe('AUTH-PROV-FLOWB');

      const auditEvents = repos.auditLog.listByRequestId(req.id).map((a) => a.event);
      expect(auditEvents).toContain('RECONCILE_RECOVERED_ORDER_ID');
      expect(auditEvents).toContain('RECONCILE_LINKED_AUTHORIZATION');
      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });
  });
});
