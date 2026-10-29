/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T6: Unit Tests for Decision Execution Choke Point (executeDecision)
 *
 * Verifies:
 * 1. Flow A (ALLOW) capture success (AUTO_EXECUTING -> CAPTURED, SPEND row).
 * 2. Flow A pre-network vault failure (AUTO_EXECUTING -> FAILED, RELEASE row).
 * 3. Flow A definitive 422 decline (INSTRUMENT_DECLINED -> FAILED, RELEASE row).
 * 4. Flow A ambiguous network timeout (leaves AUTO_EXECUTING, no RELEASE, fails closed).
 * 5. Flow A ambiguous 500 server error (leaves AUTO_EXECUTING, no RELEASE).
 * 6. Flow A pending capture (status: 'PENDING' -> leaves in-flight, no SPEND, no RELEASE).
 * 7. Flow B (HOLD) authorization success (stores PayPal IDs, stays HELD).
 * 8. Flow B (HOLD) authorization 422 decline (HELD -> FAILED via Option B, RELEASE row).
 * 9. Flow B (HOLD) ambiguous network timeout (leaves HELD, no RELEASE).
 * 10. Flow C (APPROVE) capture success (CAPTURING -> CAPTURED, SPEND row).
 * 11. Flow C (APPROVE) capture decline (CAPTURING -> FAILED, RELEASE row).
 * 12. Flow C (APPROVE) ambiguous capture timeout (leaves CAPTURING, no RELEASE).
 * 13. Rejection of AUTHORIZATION_ALREADY_CAPTURED as a failure (does not release reservation).
 * 14. In-process concurrent single-flight deduplication (2 parallel calls -> exactly 1 PayPal request).
 * 15. Crash recovery guard (in-flight request without active promise fails closed; does not blindly retry).
 * 16. Terminal states NO_OP (DENIED, CAPTURED, FAILED, VOIDED).
 * 17. Invariant I3 AST test: Scans src/ to confirm no file outside src/core/executeDecision.ts calls money-moving PayPal functions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import type { PaymentRequestRow } from '../../src/db/types.js';
import { toMinorUnits, type MinorUnits } from '../../src/core/money.js';
import {
  executeDecision,
  _resetInFlightExecutionsForTest,
  AmbiguousExecutionError,
  ExecuteDecisionError,
  type ExecuteDecisionOptions,
} from '../../src/core/executeDecision.js';
import { verifyDatabaseAuditChain, type PaymentRequestStatus } from '../../src/core/stateMachine.js';
import { OrderError, type PayPalOrdersService, type PayPalOrderResult } from '../../src/paypal/orders.js';
import {
  AuthorizationError,
  type PayPalAuthorizationsService,
  type PayPalCaptureResult,
} from '../../src/paypal/authorizations.js';
import { PayPalHttpError } from '../../src/paypal/http.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('M2-T6: Core — executeDecision', () => {
  let db: Database;
  let repos: Repositories;
  let mockOrdersService: PayPalOrdersService;
  let mockAuthorizationsService: PayPalAuthorizationsService;

  beforeEach(() => {
    _resetInFlightExecutionsForTest();
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    // Seed agent
    repos.agents.insert({
      id: 'agent-1',
      name: 'Agent One',
      api_key_hash: 'hash-agent-1',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(100000),
      created_at: new Date().toISOString(),
    });

    // Seed vendor
    repos.vendors.insert({
      id: 'vendor-1',
      name: 'Acme Cloud',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    });

    // Seed vendor vault token
    repos.vendorVaultTokens.insert({
      id: 'vvt-1',
      vendor_id: 'vendor-1',
      paypal_customer_ref: 'cust-1',
      vault_token_id: 'vault-tok-123',
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
    });

    // Create mock services
    mockOrdersService = {
      createOrder: vi.fn(),
      getOrder: vi.fn(),
    } as unknown as PayPalOrdersService;

    mockAuthorizationsService = {
      captureAuthorization: vi.fn(),
      voidAuthorization: vi.fn(),
      getAuthorization: vi.fn(),
    } as unknown as PayPalAuthorizationsService;
  });

  afterEach(() => {
    _resetInFlightExecutionsForTest();
    if (db.open) {
      db.close();
    }
  });

  function seedRequest(
    status: PaymentRequestStatus,
    options?: {
      id?: string;
      vendorId?: string;
      amountMinor?: MinorUnits;
      currency?: string;
      paypalOrderId?: string | null;
      paypalAuthorizationId?: string | null;
      paypalCaptureId?: string | null;
      hasReserve?: boolean;
    }
  ): PaymentRequestRow {
    const id = options?.id ?? `req-${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date().toISOString();
    const req: PaymentRequestRow = {
      id,
      agent_id: 'agent-1',
      vendor_id: options?.vendorId ?? 'vendor-1',
      idempotency_key: `idemp-${id}`,
      amount_minor: options?.amountMinor ?? toMinorUnits(5000),
      currency: options?.currency ?? 'USD',
      purpose: 'Monthly server hosting',
      category: 'cloud',
      source_context_excerpt: null,
      source_context_hash: null,
      status,
      decision: status === 'AUTO_EXECUTING' ? 'ALLOW' : status === 'HELD' ? 'HOLD' : null,
      reasons: null,
      policy_version_id: null,
      snapshot_hash: status === 'HELD' ? 'hash-held-snapshot' : null,
      paypal_order_id: options?.paypalOrderId ?? null,
      paypal_authorization_id: options?.paypalAuthorizationId ?? null,
      paypal_capture_id: options?.paypalCaptureId ?? null,
      expires_at: status === 'HELD' ? new Date(Date.now() + 900000).toISOString() : null,
      created_at: now,
      updated_at: now,
    };

    repos.paymentRequests.insert(req);

    if (options?.hasReserve ?? true) {
      repos.ledger.insert({
        id: `led-res-${id}`,
        request_id: id,
        kind: 'RESERVE',
        amount_minor: req.amount_minor,
        currency: req.currency,
        created_at: now,
      });
    }

    return req;
  }

  // ==========================================================================
  // Test 1: Flow A (ALLOW) Capture Success
  // ==========================================================================
  it('1. Flow A (ALLOW) capture success (AUTO_EXECUTING -> CAPTURED, SPEND row)', async () => {
    const req = seedRequest('AUTO_EXECUTING');

    const expectedOrderResult: PayPalOrderResult = {
      id: 'ORD-SUCCESS-1',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: true,
      isAuthorized: false,
      capture: {
        id: 'CAP-SUCCESS-1',
        status: 'COMPLETED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    };

    vi.mocked(mockOrdersService.createOrder).mockResolvedValue(expectedOrderResult);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
      authorizationsService: mockAuthorizationsService,
    };

    const result = await executeDecision({ requestId: req.id }, execOptions);

    expect(result.status).toBe('CAPTURED');
    expect(result.executedAction).toBe('CAPTURED');
    expect(result.actionTaken).toBe('CAPTURED');
    expect(result.executed).toBe(true);
    expect(result.orderId).toBe('ORD-SUCCESS-1');
    expect(result.captureId).toBe('CAP-SUCCESS-1');
    expect(result.ledgerEntry?.kind).toBe('SPEND');
    expect(result.ledgerEntry?.amount_minor).toBe(req.amount_minor);

    // Verify DB persistence
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('CAPTURED');
    expect(updated.paypal_order_id).toBe('ORD-SUCCESS-1');
    expect(updated.paypal_capture_id).toBe('CAP-SUCCESS-1');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'SPEND']);

    const auditChain = verifyDatabaseAuditChain(db);
    expect(auditChain.valid).toBe(true);
  });

  // ==========================================================================
  // Test 2: Flow A Pre-Network Vault Failure
  // ==========================================================================
  it('2. Flow A pre-network vault failure (AUTO_EXECUTING -> FAILED, RELEASE row)', async () => {
    // Seed vendor with no vault token
    repos.vendors.insert({
      id: 'vendor-no-vault',
      name: 'No Vault Vendor',
      status: 'ACTIVE',
      categories: JSON.stringify(['misc']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'no_vault',
      created_at: new Date().toISOString(),
    });

    const req = seedRequest('AUTO_EXECUTING', { vendorId: 'vendor-no-vault' });

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
    };

    const result = await executeDecision({ requestId: req.id }, execOptions);

    expect(result.status).toBe('FAILED');
    expect(result.executedAction).toBe('FAILED');
    expect(result.executed).toBe(false);
    expect(result.ledgerEntry?.kind).toBe('RELEASE');
    expect(result.ledgerEntry?.amount_minor).toBe(req.amount_minor);

    // Verify network was NEVER called
    expect(mockOrdersService.createOrder).not.toHaveBeenCalled();

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('FAILED');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);
  });

  // ==========================================================================
  // Test 3: Flow A Definitive 422 Decline
  // ==========================================================================
  it('3. Flow A definitive 422 decline (INSTRUMENT_DECLINED -> FAILED, RELEASE row)', async () => {
    const req = seedRequest('AUTO_EXECUTING');

    const httpError = new PayPalHttpError({
      message: 'Card was declined',
      code: 'DECLINED',
      status: 422,
      debugId: 'dbg-declined-123',
      issue: 'INSTRUMENT_DECLINED',
    });
    const orderError = new OrderError('DECLINED', 'Card was declined', {
      debugId: 'dbg-declined-123',
      causeError: httpError,
    });

    vi.mocked(mockOrdersService.createOrder).mockRejectedValue(orderError);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
    };

    const result = await executeDecision({ requestId: req.id }, execOptions);

    expect(result.status).toBe('FAILED');
    expect(result.executedAction).toBe('FAILED');
    expect(result.ledgerEntry?.kind).toBe('RELEASE');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('FAILED');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);
  });

  // ==========================================================================
  // Test 4: Flow A Ambiguous Network Timeout
  // ==========================================================================
  it('4. Flow A ambiguous network timeout (leaves AUTO_EXECUTING, no RELEASE, fails closed)', async () => {
    const req = seedRequest('AUTO_EXECUTING');

    const httpError = new PayPalHttpError({
      message: 'Network connection timeout: ETIMEDOUT',
      code: 'NETWORK',
    });
    const orderError = new OrderError('NETWORK', 'Timeout', { causeError: httpError });

    vi.mocked(mockOrdersService.createOrder).mockRejectedValue(orderError);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
    };

    await expect(executeDecision({ requestId: req.id }, execOptions)).rejects.toThrow(
      AmbiguousExecutionError
    );

    // Crucial check: status unchanged, NO release row!
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('AUTO_EXECUTING');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE']);

    const audit = repos.auditLog.listByRequestId(req.id);
    expect(audit.some((a) => a.event === 'EXECUTION_AMBIGUOUS')).toBe(true);
  });

  // ==========================================================================
  // Test 5: Flow A Ambiguous 500 Server Error
  // ==========================================================================
  it('5. Flow A ambiguous 500 server error (leaves AUTO_EXECUTING, no RELEASE)', async () => {
    const req = seedRequest('AUTO_EXECUTING');

    const httpError = new PayPalHttpError({
      message: 'Internal Server Error',
      code: 'UNKNOWN',
      status: 500,
      debugId: 'dbg-500-err',
    });
    const orderError = new OrderError('UNKNOWN', 'Internal Error', {
      debugId: 'dbg-500-err',
      causeError: httpError,
    });

    vi.mocked(mockOrdersService.createOrder).mockRejectedValue(orderError);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
    };

    await expect(executeDecision({ requestId: req.id }, execOptions)).rejects.toThrow(
      AmbiguousExecutionError
    );

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('AUTO_EXECUTING');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE']);
  });

  // ==========================================================================
  // Test 6: Flow A Pending Capture
  // ==========================================================================
  it("6. Flow A pending capture (status: 'PENDING' -> leaves in-flight, no SPEND, no RELEASE)", async () => {
    const req = seedRequest('AUTO_EXECUTING');

    const pendingOrderResult: PayPalOrderResult = {
      id: 'ORD-PEND-1',
      status: 'COMPLETED',
      intent: 'CAPTURE',
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: false, // PENDING capture is not captured
      isAuthorized: false,
      capture: {
        id: 'CAP-PEND-1',
        status: 'PENDING',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    };

    vi.mocked(mockOrdersService.createOrder).mockResolvedValue(pendingOrderResult);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
    };

    await expect(executeDecision({ requestId: req.id }, execOptions)).rejects.toThrow(
      AmbiguousExecutionError
    );

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('AUTO_EXECUTING');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE']);
  });

  // ==========================================================================
  // Test 7: Flow B (HOLD) Authorization Success
  // ==========================================================================
  it('7. Flow B (HOLD) authorization success (stores PayPal IDs, stays HELD)', async () => {
    const req = seedRequest('HELD');

    const authOrderResult: PayPalOrderResult = {
      id: 'ORD-AUTH-SUCCESS',
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      amountMinor: req.amount_minor,
      currency: 'USD',
      isCaptured: false,
      isAuthorized: true,
      authorization: {
        id: 'AUTH-12345',
        status: 'CREATED',
        amountMinor: req.amount_minor,
        currency: 'USD',
      },
    };

    vi.mocked(mockOrdersService.createOrder).mockResolvedValue(authOrderResult);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
    };

    const result = await executeDecision({ requestId: req.id }, execOptions);

    expect(result.status).toBe('HELD');
    expect(result.executedAction).toBe('HELD_AUTHORIZED');
    expect(result.orderId).toBe('ORD-AUTH-SUCCESS');
    expect(result.authorizationId).toBe('AUTH-12345');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('HELD');
    expect(updated.paypal_order_id).toBe('ORD-AUTH-SUCCESS');
    expect(updated.paypal_authorization_id).toBe('AUTH-12345');

    // Ledger has only RESERVE; funds remain held
    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE']);
  });

  // ==========================================================================
  // Test 8: Flow B (HOLD) Authorization 422 Decline
  // ==========================================================================
  it('8. Flow B (HOLD) authorization 422 decline (HELD -> FAILED via Option B, RELEASE row)', async () => {
    const req = seedRequest('HELD');

    const httpError = new PayPalHttpError({
      message: 'Declined by issuer',
      code: 'DECLINED',
      status: 422,
      issue: 'INSTRUMENT_DECLINED',
    });
    const orderError = new OrderError('DECLINED', 'Declined', { causeError: httpError });

    vi.mocked(mockOrdersService.createOrder).mockRejectedValue(orderError);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
    };

    const result = await executeDecision({ requestId: req.id }, execOptions);

    expect(result.status).toBe('FAILED');
    expect(result.executedAction).toBe('FAILED');
    expect(result.ledgerEntry?.kind).toBe('RELEASE');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('FAILED');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);
  });

  // ==========================================================================
  // Test 9: Flow B (HOLD) Ambiguous Network Timeout
  // ==========================================================================
  it('9. Flow B (HOLD) ambiguous network timeout (leaves HELD, no RELEASE)', async () => {
    const req = seedRequest('HELD');

    const httpError = new PayPalHttpError({
      message: 'Socket timeout',
      code: 'NETWORK',
    });
    const orderError = new OrderError('NETWORK', 'Timeout', { causeError: httpError });

    vi.mocked(mockOrdersService.createOrder).mockRejectedValue(orderError);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
    };

    await expect(executeDecision({ requestId: req.id }, execOptions)).rejects.toThrow(
      AmbiguousExecutionError
    );

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('HELD');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE']);
  });

  // ==========================================================================
  // Test 10: Flow C (APPROVE) Capture Success
  // ==========================================================================
  it('10. Flow C (APPROVE) capture success (CAPTURING -> CAPTURED, SPEND row)', async () => {
    const req = seedRequest('APPROVED', { paypalAuthorizationId: 'AUTH-PREV-1' });

    const captureResult: PayPalCaptureResult = {
      id: 'CAP-FINAL-1',
      status: 'COMPLETED',
      isCaptured: true,
      amountMinor: req.amount_minor,
      currency: 'USD',
      finalCapture: true,
    };

    vi.mocked(mockAuthorizationsService.captureAuthorization).mockResolvedValue(captureResult);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      authorizationsService: mockAuthorizationsService,
    };

    const result = await executeDecision({ requestId: req.id }, execOptions);

    expect(result.status).toBe('CAPTURED');
    expect(result.executedAction).toBe('CAPTURED_APPROVED');
    expect(result.captureId).toBe('CAP-FINAL-1');
    expect(result.ledgerEntry?.kind).toBe('SPEND');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('CAPTURED');
    expect(updated.paypal_capture_id).toBe('CAP-FINAL-1');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'SPEND']);
  });

  // ==========================================================================
  // Test 11: Flow C (APPROVE) Capture Decline
  // ==========================================================================
  it('11. Flow C (APPROVE) capture decline (CAPTURING -> FAILED, RELEASE row)', async () => {
    const req = seedRequest('APPROVED', { paypalAuthorizationId: 'AUTH-PREV-2' });

    const httpError = new PayPalHttpError({
      message: 'Authorization expired or voided',
      code: 'AUTH_EXPIRED',
      status: 422,
      issue: 'AUTHORIZATION_EXPIRED',
    });
    const authError = new AuthorizationError('AUTH_EXPIRED', 'Expired', { causeError: httpError });

    vi.mocked(mockAuthorizationsService.captureAuthorization).mockRejectedValue(authError);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      authorizationsService: mockAuthorizationsService,
    };

    const result = await executeDecision({ requestId: req.id }, execOptions);

    expect(result.status).toBe('FAILED');
    expect(result.executedAction).toBe('FAILED');
    expect(result.ledgerEntry?.kind).toBe('RELEASE');

    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('FAILED');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);
  });

  // ==========================================================================
  // Test 12: Flow C (APPROVE) Ambiguous Capture Timeout
  // ==========================================================================
  it('12. Flow C (APPROVE) ambiguous capture timeout (leaves CAPTURING, no RELEASE)', async () => {
    const req = seedRequest('APPROVED', { paypalAuthorizationId: 'AUTH-PREV-3' });

    const httpError = new PayPalHttpError({
      message: 'Network error during capture',
      code: 'NETWORK',
    });
    const authError = new AuthorizationError('NETWORK', 'Timeout', { causeError: httpError });

    vi.mocked(mockAuthorizationsService.captureAuthorization).mockRejectedValue(authError);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      authorizationsService: mockAuthorizationsService,
    };

    await expect(executeDecision({ requestId: req.id }, execOptions)).rejects.toThrow(
      AmbiguousExecutionError
    );

    const updated = repos.paymentRequests.getById(req.id)!;
    // Remains claimed in CAPTURING
    expect(updated.status).toBe('CAPTURING');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE']);
  });

  // ==========================================================================
  // Test 13: Rejection of AUTHORIZATION_ALREADY_CAPTURED as a Failure
  // ==========================================================================
  it('13. Rejection of AUTHORIZATION_ALREADY_CAPTURED as a failure (does not release reservation)', async () => {
    const req = seedRequest('APPROVED', { paypalAuthorizationId: 'AUTH-PREV-4' });

    const httpError = new PayPalHttpError({
      message: 'This authorization was already captured previously',
      code: 'DECLINED',
      status: 422,
      issue: 'AUTHORIZATION_ALREADY_CAPTURED',
    });
    const authError = new AuthorizationError('DECLINED', 'Already captured', {
      causeError: httpError,
    });

    vi.mocked(mockAuthorizationsService.captureAuthorization).mockRejectedValue(authError);

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      authorizationsService: mockAuthorizationsService,
    };

    await expect(executeDecision({ requestId: req.id }, execOptions)).rejects.toThrow(
      AmbiguousExecutionError
    );

    // CRITICAL SECURITY INVARIANT: Must NOT mark FAILED or RELEASE reservation!
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('CAPTURING');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE']);
  });

  // ==========================================================================
  // Test 14: In-Process Concurrent Single-Flight Deduplication
  // ==========================================================================
  it('14. In-process concurrent single-flight deduplication (2 parallel calls -> exactly 1 PayPal request)', async () => {
    const req = seedRequest('AUTO_EXECUTING');

    let callCount = 0;
    vi.mocked(mockOrdersService.createOrder).mockImplementation(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        id: 'ORD-DEDUP-1',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        amountMinor: req.amount_minor,
        currency: 'USD',
        isCaptured: true,
        isAuthorized: false,
        capture: {
          id: 'CAP-DEDUP-1',
          status: 'COMPLETED',
          amountMinor: req.amount_minor,
          currency: 'USD',
        },
      };
    });

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
    };

    const [res1, res2] = await Promise.all([
      executeDecision({ requestId: req.id }, execOptions),
      executeDecision({ requestId: req.id }, execOptions),
    ]);

    expect(callCount).toBe(1);
    expect(res1.status).toBe('CAPTURED');
    expect(res2.status).toBe('CAPTURED');
    expect(res1.orderId).toBe('ORD-DEDUP-1');
    expect(res2.orderId).toBe('ORD-DEDUP-1');

    const ledger = repos.ledger.listByRequestId(req.id);
    expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'SPEND']);
  });

  // ==========================================================================
  // Test 15: Crash Recovery Guard (In-Flight Request Fails Closed)
  // ==========================================================================
  it('15. Crash recovery guard (in-flight request without active promise fails closed; does not blindly retry)', async () => {
    // Request left in CAPTURING state after a crash or timeout
    const req = seedRequest('CAPTURING', { paypalAuthorizationId: 'AUTH-STALE-1' });

    _resetInFlightExecutionsForTest();

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      authorizationsService: mockAuthorizationsService,
    };

    await expect(executeDecision({ requestId: req.id }, execOptions)).rejects.toThrow(
      AmbiguousExecutionError
    );

    // No network calls made
    expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();

    // Stays in CAPTURING with RESERVE intact
    const updated = repos.paymentRequests.getById(req.id)!;
    expect(updated.status).toBe('CAPTURING');
  });

  // ==========================================================================
  // Test 16: Terminal States NO_OP
  // ==========================================================================
  it('16. Terminal states NO_OP (DENIED, CAPTURED, FAILED, VOIDED)', async () => {
    const terminalStatuses: PaymentRequestStatus[] = ['DENIED', 'CAPTURED', 'FAILED', 'VOIDED'];

    for (const status of terminalStatuses) {
      const req = seedRequest(status, { hasReserve: status !== 'DENIED' });

      const execOptions: ExecuteDecisionOptions = {
        db,
        repos,
        ordersService: mockOrdersService,
        authorizationsService: mockAuthorizationsService,
      };

      const result = await executeDecision({ requestId: req.id }, execOptions);

      expect(result.executedAction).toBe('NO_OP');
      expect(result.executed).toBe(false);
      expect(result.status).toBe(status);

      expect(mockOrdersService.createOrder).not.toHaveBeenCalled();
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
    }
  });

  // ==========================================================================
  // Test 17: Invariant I3 Static Analysis AST Test
  // ==========================================================================
  it('17. Invariant I3: static analysis confirms no file outside src/core/executeDecision.ts invokes money-moving PayPal functions', () => {
    function findTsFiles(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...findTsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const srcDir = path.resolve(__dirname, '../../src');
    const allFiles = findTsFiles(srcDir);
    const violations: string[] = [];

    for (const file of allFiles) {
      const relativePath = path.relative(srcDir, file).replace(/\\/g, '/');

      // Allowed files: executeDecision.ts itself, and the core implementation files in src/paypal/
      if (relativePath === 'core/executeDecision.ts') {
        continue;
      }
      if (relativePath === 'paypal/orders.ts' || relativePath === 'paypal/authorizations.ts') {
        continue;
      }

      const content = fs.readFileSync(file, 'utf8');

      // Money-moving method calls
      if (/\.createOrder\s*\(/.test(content)) {
        violations.push(`${relativePath} calls .createOrder()`);
      }
      if (/\.captureAuthorization\s*\(/.test(content)) {
        violations.push(`${relativePath} calls .captureAuthorization()`);
      }
    }

    expect(violations).toEqual([]);
  });

  // ==========================================================================
  // Extra Test: executeDecision inside open transaction rejected (Hard Rule 3)
  // ==========================================================================
  it('rejects invocation inside an open database transaction (Hard Rule 3)', async () => {
    const req = seedRequest('AUTO_EXECUTING');

    const execOptions: ExecuteDecisionOptions = {
      db,
      repos,
      ordersService: mockOrdersService,
    };

    db.exec('BEGIN IMMEDIATE');
    try {
      await expect(executeDecision({ requestId: req.id }, execOptions)).rejects.toThrow(
        ExecuteDecisionError
      );
    } finally {
      db.exec('ROLLBACK');
    }
  });
});
