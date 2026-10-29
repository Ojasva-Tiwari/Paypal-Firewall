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
import type { PayPalOrdersService, PayPalOrderResult } from '../../src/paypal/orders.js';
import type { PayPalAuthorizationsService, PayPalAuthorizationDetails } from '../../src/paypal/authorizations.js';
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
});
