/**
 * PayGuard — M6-T5 Phase 3: Focused Reliability & Hardening Regression Suite
 *
 * Covers all 8 Phase 3 verification areas:
 * 1. Atomic hold expiry Step 1 & Step 2 + ledger RELEASE guarantees
 * 2. Transient void failures & recovery (expiry, reconcile Flow D, expired APPROVED, dashboard void)
 * 3. Duplicate unresolved audit suppression & change detection
 * 4. GET /api/requests/:id policy explanation context mapping & malformed/historical fallback
 * 5. Dashboard & API visibility (/api/overview, /api/requests, /api/paypal/activity)
 * 6. MCP request_payment Flow B error reread & terminal/in-flight status messaging
 * 7. MCP get_payment_status lazy hold expiry without authorizationsService & tenant isolation
 * 8. Reconciliation candidate selection & ledger SPEND/RELEASE mutual-exclusion idempotency
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { toMinorUnits } from '../../src/core/money.js';
import {
  verifyDatabaseAuditChain,
  writeAuditLogEntry,
  writeAuditLogEntryIfChanged,
  type PaymentRequestStatus,
} from '../../src/core/stateMachine.js';
import {
  _resetInFlightExecutionsForTest,
} from '../../src/core/executeDecision.js';
import { expirePaymentHold } from '../../src/approvals/expiry.js';
import { ApprovalExecutionService } from '../../src/approvals/service.js';
import { reconcilePaymentRequest } from '../../src/paypal/reconcile.js';
import {
  AuthorizationError,
  type PayPalAuthorizationsService,
  type PayPalAuthorizationDetails,
} from '../../src/paypal/authorizations.js';
import { PayPalHttpError } from '../../src/paypal/http.js';
import type { PayPalOrdersService, PayPalOrderResult } from '../../src/paypal/orders.js';
import { agentContextStorage, generateAgentKey } from '../../src/mcp/auth.js';
import {
  handleRequestPayment,
  handleGetPaymentStatus,
  handleGetBudget,
} from '../../src/mcp/tools.js';
import { createPayGuardMcpServer, type PayGuardMcpServerInstance } from '../../src/mcp/server.js';
import { hashOwnerPassphrase, OWNER_COOKIE_NAME } from '../../src/auth/owner.js';
import { computeSnapshotHash } from '../../src/core/service.js';
import type { AgentRow, PaymentRequestRow, PolicyVersionRow } from '../../src/db/types.js';
import type { PolicyDocument } from '../../src/policy/types.js';

describe('M6-T5 Phase 3: Reliability & Hardening Regression Tests', () => {
  let db: Database;
  let repos: Repositories;
  let agentAlice: AgentRow;
  let agentBob: AgentRow;

  const basePolicy: PolicyDocument = {
    version: 1,
    currency_allowlist: ['USD'],
    auto_limit_minor: toMinorUnits(2000), // $20.00
    hard_cap_minor: toMinorUnits(5000), // $50.00
    agent_daily_budget_minor: toMinorUnits(10000), // $100.00
    global_daily_budget_minor: toMinorUnits(50000), // $500.00
    velocity: { max_requests: 10, window_minutes: 15 },
    duplicate_window_minutes: 60,
    new_vendor_action: 'HOLD',
    hold_ttl_minutes: 15,
  };

  function seedBaseFixtures(): void {
    repos.owners.upsert({
      display_name: 'Primary Owner',
      passphrase_hash: '$argon2id$mock-hash',
      telegram_chat_id: '123456789',
      telegram_linked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    repos.policyVersions.insert({
      id: 'pol-v1',
      version: 1,
      rules: JSON.stringify(basePolicy),
      author: 'owner',
      active: 1,
      created_at: new Date().toISOString(),
    });

    const keyAlice = generateAgentKey();
    agentAlice = {
      id: 'agent-alice',
      name: 'Alice Agent',
      api_key_hash: keyAlice.keyHash,
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(10000),
      created_at: new Date().toISOString(),
    };
    repos.agents.insert(agentAlice);

    const keyBob = generateAgentKey();
    agentBob = {
      id: 'agent-bob',
      name: 'Bob Agent',
      api_key_hash: keyBob.keyHash,
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(10000),
      created_at: new Date().toISOString(),
    };
    repos.agents.insert(agentBob);

    repos.vendors.insert({
      id: 'ven-acme',
      name: 'Acme Cloud',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud', 'saas']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    });

    repos.vendorVaultTokens.insert({
      id: 'vtok-acme',
      vendor_id: 'ven-acme',
      paypal_customer_ref: 'cust-acme',
      vault_token_id: 'vault-acme-1',
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
    });
  }

  function seedRequestWithReserve(
    status: PaymentRequestStatus,
    overrides?: Partial<PaymentRequestRow>
  ): PaymentRequestRow {
    const id = overrides?.id ?? `req-${crypto.randomUUID()}`;
    const amountMinor = overrides?.amount_minor ?? toMinorUnits(2500);
    const currency = overrides?.currency ?? 'USD';
    const agentId = overrides?.agent_id ?? agentAlice.id;
    const vendorId = overrides?.vendor_id ?? 'ven-acme';
    const purpose = overrides?.purpose ?? 'Cloud server compute';
    const category = overrides?.category ?? 'cloud';
    const nowIso = new Date().toISOString();

    const row: PaymentRequestRow = {
      id,
      agent_id: agentId,
      idempotency_key: overrides?.idempotency_key ?? `idem-${crypto.randomUUID()}`,
      vendor_id: vendorId,
      amount_minor: amountMinor,
      currency,
      purpose,
      category,
      source_context_excerpt: overrides?.source_context_excerpt ?? null,
      source_context_hash: overrides?.source_context_hash ?? null,
      status,
      decision: overrides?.decision ?? 'HOLD',
      reasons: overrides?.reasons ?? JSON.stringify(['OVER_AUTO_LIMIT']),
      policy_version_id: overrides?.policy_version_id ?? 'pol-v1',
      snapshot_hash:
        overrides?.snapshot_hash ??
        computeSnapshotHash({
          requestId: id,
          agentId,
          vendorId,
          amountMinor,
          currency,
          purpose,
          category,
        }),
      paypal_order_id: overrides?.paypal_order_id ?? 'ORD-123',
      paypal_authorization_id:
        overrides && 'paypal_authorization_id' in overrides
          ? overrides.paypal_authorization_id!
          : 'AUTH-123',
      paypal_capture_id: overrides?.paypal_capture_id ?? null,
      expires_at: overrides?.expires_at ?? new Date(Date.now() + 15 * 60_000).toISOString(),
      remote_void_status: overrides?.remote_void_status ?? null,
      created_at: overrides?.created_at ?? nowIso,
      updated_at: overrides?.updated_at ?? nowIso,
    };

    repos.paymentRequests.insert(row);
    repos.ledger.insert({
      id: `led-res-${crypto.randomUUID()}`,
      request_id: id,
      kind: 'RESERVE',
      amount_minor: amountMinor,
      currency,
      created_at: nowIso,
    });

    if (overrides?.remote_void_status) {
      repos.paymentRequests.updateRemoteVoidStatus(id, overrides.remote_void_status, nowIso);
    }

    return repos.paymentRequests.getById(id)!;
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);
    _resetInFlightExecutionsForTest();
    seedBaseFixtures();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetInFlightExecutionsForTest();
    db.close();
  });

  // ============================================================================
  // 1. Atomic hold expiry Step 1 & Step 2 + ledger RELEASE guarantees
  // ============================================================================
  describe('1. Atomic Hold Expiry & Ledger RELEASE Guarantees', () => {
    it('commits Step 1 VOIDED + RELEASE + PENDING cleanly even when Step 2 void throws transiently', async () => {
      const expiredReq = seedRequestWithReserve('HELD', {
        paypal_authorization_id: 'AUTH-EXP-TRANSIENT',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const authService = {
        voidAuthorization: vi.fn().mockRejectedValue(
          new PayPalHttpError({
            code: 'UNKNOWN',
            status: 503,
            message: 'Temporary 503',
          })
        ),
      } as unknown as PayPalAuthorizationsService;

      const res = await expirePaymentHold(db, expiredReq.id, {
        repos,
        authorizationsService: authService,
      });

      expect(res.expired).toBe(true);
      expect(res.actionTaken).toBe('EXPIRED');
      expect(res.remoteVoidStatus).toBe('PENDING');

      const stored = repos.paymentRequests.getById(expiredReq.id)!;
      expect(stored.status).toBe('VOIDED');
      expect(stored.remote_void_status).toBe('PENDING');

      const ledger = repos.ledger.listByRequestId(expiredReq.id);
      expect(ledger.filter((l) => l.kind === 'RESERVE')).toHaveLength(1);
      expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(1);

      const audits = repos.auditLog.listByRequestId(expiredReq.id).map((a) => a.event);
      expect(audits).toContain('HOLD_EXPIRED');
      expect(audits).toContain('TRANSITION_TO_VOIDED');
      expect(audits).toContain('PAYPAL_VOID_PENDING_RETRY');

      const outbox = repos.notifications
        .listRecent(50)
        .filter((o) => o.request_id === expiredReq.id);
      expect(outbox.some((o) => o.event_type === 'PAYMENT_EXPIRED')).toBe(true);
      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });

    it('keeps remote_void_status = PENDING when Step 2 void returns { isVoided: false }', async () => {
      const expiredReq = seedRequestWithReserve('HELD', {
        paypal_authorization_id: 'AUTH-EXP-FALSE',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const authService = {
        voidAuthorization: vi.fn().mockResolvedValue({ id: 'AUTH-EXP-FALSE', isVoided: false }),
      } as unknown as PayPalAuthorizationsService;

      const res = await expirePaymentHold(db, expiredReq.id, {
        repos,
        authorizationsService: authService,
      });

      expect(res.expired).toBe(true);
      expect(res.remoteVoidStatus).toBe('PENDING');

      const stored = repos.paymentRequests.getById(expiredReq.id)!;
      expect(stored.status).toBe('VOIDED');
      expect(stored.remote_void_status).toBe('PENDING');

      const audits = repos.auditLog.listByRequestId(expiredReq.id);
      expect(audits.some((a) => a.event === 'PAYPAL_VOID_PENDING_RETRY')).toBe(true);
      expect(audits.some((a) => a.event === 'PAYPAL_VOID_RECONCILED')).toBe(false);
    });

    it('atomically sets remote_void_status = FAILED on definitive AuthorizationError and rolls back cleanly on Step 2 DB failure', async () => {
      const reqDefinitive = seedRequestWithReserve('HELD', {
        paypal_authorization_id: 'AUTH-EXP-DEF-FAIL',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const authService = {
        voidAuthorization: vi
          .fn()
          .mockRejectedValue(new AuthorizationError('INVALID_REQUEST', 'Authorization cannot be voided')),
      } as unknown as PayPalAuthorizationsService;

      const res = await expirePaymentHold(db, reqDefinitive.id, {
        repos,
        authorizationsService: authService,
      });

      expect(res.remoteVoidStatus).toBe('FAILED');
      expect(repos.paymentRequests.getById(reqDefinitive.id)!.remote_void_status).toBe('FAILED');
      expect(
        repos.auditLog.listByRequestId(reqDefinitive.id).some((a) => a.event === 'PAYPAL_VOID_FAILED')
      ).toBe(true);

      // Simulate Step 2 DB write failure after Step 1 committed and voidAuthorization resolved
      const reqDbFail = seedRequestWithReserve('HELD', {
        paypal_authorization_id: 'AUTH-STEP2-DB-FAIL',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const updateSpy = vi
        .spyOn(repos.paymentRequests, 'updateRemoteVoidStatus')
        .mockImplementationOnce((id, status, updatedAt) => {
          // Allow Step 1 call
          return (
            db
              .prepare('UPDATE payment_requests SET remote_void_status = ?, updated_at = ? WHERE id = ?')
              .run(status, updatedAt, id).changes > 0
          );
        })
        .mockImplementationOnce(() => {
          throw new Error('SQLITE_BUSY simulated Step 2 write failure');
        });

      const voidOkService = {
        voidAuthorization: vi.fn().mockResolvedValue({ id: 'AUTH-STEP2-DB-FAIL', isVoided: true }),
      } as unknown as PayPalAuthorizationsService;

      await expect(
        expirePaymentHold(db, reqDbFail.id, { repos, authorizationsService: voidOkService })
      ).rejects.toThrow('SQLITE_BUSY');

      updateSpy.mockRestore();

      // Step 1 VOIDED + single RELEASE + PENDING remain intact, no partial Step 2 audit leaked
      expect(repos.paymentRequests.getById(reqDbFail.id)!.status).toBe('VOIDED');
      expect(repos.paymentRequests.getById(reqDbFail.id)!.remote_void_status).toBe('PENDING');
      expect(repos.ledger.listByRequestId(reqDbFail.id).filter((l) => l.kind === 'RELEASE')).toHaveLength(1);
      expect(
        repos.auditLog.listByRequestId(reqDbFail.id).some((a) => a.event === 'PAYPAL_VOID_RECONCILED')
      ).toBe(false);
    });

    it('refuses to release budget if request already has a SPEND ledger entry', async () => {
      const reqWithSpend = seedRequestWithReserve('HELD', {
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });
      repos.ledger.insert({
        id: `led-spend-${crypto.randomUUID()}`,
        request_id: reqWithSpend.id,
        kind: 'SPEND',
        amount_minor: reqWithSpend.amount_minor,
        currency: reqWithSpend.currency,
        created_at: new Date().toISOString(),
      });

      await expect(expirePaymentHold(db, reqWithSpend.id, { repos })).rejects.toThrow(/Illegal ledger state/);
      expect(repos.paymentRequests.getById(reqWithSpend.id)!.status).toBe('HELD');
      expect(repos.ledger.listByRequestId(reqWithSpend.id).filter((l) => l.kind === 'RELEASE')).toHaveLength(0);
    });
  });

  // ============================================================================
  // 2. Transient void failures & recovery
  // ============================================================================
  describe('2. Transient Void Failures & Recovery Across Expiry, Reconcile Flow D, Approved Expiry, and Service Void', () => {
    it('Flow D retries CREATED authorization on transient errors and confirms CONFIRMED on subsequent success', async () => {
      const reqVoided = seedRequestWithReserve('VOIDED', {
        paypal_authorization_id: 'AUTH-FLOWD-1',
        remote_void_status: 'PENDING',
      });
      repos.ledger.insert({
        id: `led-rel-${crypto.randomUUID()}`,
        request_id: reqVoided.id,
        kind: 'RELEASE',
        amount_minor: reqVoided.amount_minor,
        currency: reqVoided.currency,
        created_at: new Date().toISOString(),
      });

      const authService = {
        getAuthorization: vi.fn().mockResolvedValue({
          id: 'AUTH-FLOWD-1',
          status: 'CREATED',
          amountMinor: reqVoided.amount_minor,
          currency: 'USD',
          isCaptured: false,
          isPartiallyCaptured: false,
          isPending: false,
          isVoided: false,
          isExpired: false,
          isDenied: false,
          isCapturable: true,
        } as PayPalAuthorizationDetails),
        voidAuthorization: vi
          .fn()
          .mockRejectedValueOnce(new Error('ETIMEDOUT transient network glitch'))
          .mockResolvedValueOnce({ id: 'AUTH-FLOWD-1', isVoided: false })
          .mockResolvedValueOnce({ id: 'AUTH-FLOWD-1', isVoided: true }),
      } as unknown as PayPalAuthorizationsService;

      // Attempt 1: transient error keeps PENDING
      const r1 = await reconcilePaymentRequest(db, reqVoided.id, {
        repos,
        authorizationsService: authService,
      });
      expect(r1.isUnresolved).toBe(true);
      expect(repos.paymentRequests.getById(reqVoided.id)!.remote_void_status).toBe('PENDING');

      // Attempt 2: !isVoided keeps PENDING
      const r2 = await reconcilePaymentRequest(db, reqVoided.id, {
        repos,
        authorizationsService: authService,
      });
      expect(r2.isUnresolved).toBe(true);
      expect(repos.paymentRequests.getById(reqVoided.id)!.remote_void_status).toBe('PENDING');

      // Attempt 3: succeeds -> CONFIRMED
      const r3 = await reconcilePaymentRequest(db, reqVoided.id, {
        repos,
        authorizationsService: authService,
      });
      expect(r3.reconciled).toBe(true);
      expect(r3.isUnresolved).toBe(false);
      expect(repos.paymentRequests.getById(reqVoided.id)!.remote_void_status).toBe('CONFIRMED');
      expect(repos.ledger.listByRequestId(reqVoided.id).filter((l) => l.kind === 'RELEASE')).toHaveLength(1);
    });

    it('Flow D fails closed without calling voidAuthorization for PARTIALLY_CAPTURED, PENDING, DENIED, and unknown states', async () => {
      const states: Array<{ status: string; flags: Partial<PayPalAuthorizationDetails> }> = [
        { status: 'PARTIALLY_CAPTURED', flags: { isPartiallyCaptured: true } },
        { status: 'PENDING', flags: { isPending: true } },
        { status: 'DENIED', flags: { isDenied: true } },
        { status: 'MYSTERY_REMOTE_STATE', flags: {} },
      ];

      for (const s of states) {
        const reqRow = seedRequestWithReserve('VOIDED', {
          paypal_authorization_id: `AUTH-${s.status}`,
          remote_void_status: 'PENDING',
        });

        const voidSpy = vi.fn();
        const authService = {
          getAuthorization: vi.fn().mockResolvedValue({
            id: `AUTH-${s.status}`,
            status: s.status,
            amountMinor: reqRow.amount_minor,
            currency: 'USD',
            isCaptured: false,
            isPartiallyCaptured: Boolean(s.flags.isPartiallyCaptured),
            isPending: Boolean(s.flags.isPending),
            isVoided: false,
            isExpired: false,
            isDenied: Boolean(s.flags.isDenied),
            isCapturable: false,
          }),
          voidAuthorization: voidSpy,
        } as unknown as PayPalAuthorizationsService;

        const res = await reconcilePaymentRequest(db, reqRow.id, {
          repos,
          authorizationsService: authService,
        });

        expect(res.status).toBe('UNRESOLVED');
        expect(res.isUnresolved).toBe(true);
        expect(voidSpy).not.toHaveBeenCalled();
        expect(repos.paymentRequests.getById(reqRow.id)!.remote_void_status).toBe('PENDING');
      }
    });

    it('reconcile expired APPROVED transitions to FAILED + RELEASE cleanly when Step 2 remote void transiently fails, then recovers via Flow D', async () => {
      const expiredApproved = seedRequestWithReserve('APPROVED', {
        paypal_authorization_id: 'AUTH-APP-EXP',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const authService = {
        getAuthorization: vi.fn().mockResolvedValue({
          id: 'AUTH-APP-EXP',
          status: 'CREATED',
          amountMinor: expiredApproved.amount_minor,
          currency: 'USD',
          isCaptured: false,
          isPartiallyCaptured: false,
          isPending: false,
          isVoided: false,
          isExpired: false,
          isDenied: false,
          isCapturable: true,
        }),
        voidAuthorization: vi
          .fn()
          .mockRejectedValueOnce(new Error('ECONNRESET while voiding expired approved auth'))
          .mockResolvedValueOnce({ id: 'AUTH-APP-EXP', isVoided: true }),
      } as unknown as PayPalAuthorizationsService;

      // Pass 1: APPROVED expired transitions locally -> FAILED + RELEASE + PENDING retry
      const r1 = await reconcilePaymentRequest(db, expiredApproved.id, {
        repos,
        authorizationsService: authService,
      });
      expect(r1.requestStatus).toBe('FAILED');
      expect(r1.reconciled).toBe(true);
      expect(r1.resolved).toBe(false);
      expect(r1.isUnresolved).toBe(true);
      expect(repos.paymentRequests.getById(expiredApproved.id)!.remote_void_status).toBe('PENDING');
      expect(repos.ledger.listByRequestId(expiredApproved.id).filter((l) => l.kind === 'RELEASE')).toHaveLength(1);

      // Pass 2: Flow D confirms CONFIRMED
      const r2 = await reconcilePaymentRequest(db, expiredApproved.id, {
        repos,
        authorizationsService: authService,
      });
      expect(r2.reconciled).toBe(true);
      expect(r2.resolved).toBe(true);
      expect(r2.isUnresolved).toBe(false);
      expect(repos.paymentRequests.getById(expiredApproved.id)!.remote_void_status).toBe('CONFIRMED');
      expect(repos.ledger.listByRequestId(expiredApproved.id).filter((l) => l.kind === 'RELEASE')).toHaveLength(1);
    });

    it('ApprovalExecutionService dashboard VOID preserves PENDING when voidAuthorization returns { isVoided: false }', async () => {
      const heldReq = seedRequestWithReserve('HELD', {
        paypal_authorization_id: 'AUTH-DASH-FALSE',
      });

      const authService = {
        voidAuthorization: vi.fn().mockResolvedValue({ id: 'AUTH-DASH-FALSE', isVoided: false }),
      } as unknown as PayPalAuthorizationsService;

      const svc = new ApprovalExecutionService({ db, repos, authorizationsService: authService });
      const outcome = await svc.execute({
        action: 'VOID',
        credentials: { channel: 'dashboard', requestId: heldReq.id, reason: 'Owner cancelled' },
      });

      expect(outcome.success).toBe(true);
      if (outcome.action === 'VOID') {
        expect(outcome.remoteVoidStatus).toBe('PENDING');
        expect(outcome.remoteVoidSuccess).toBe(false);
      }

      const stored = repos.paymentRequests.getById(heldReq.id)!;
      expect(stored.status).toBe('VOIDED');
      expect(stored.remote_void_status).toBe('PENDING');
      expect(
        repos.auditLog.listByRequestId(heldReq.id).some((a) => a.event === 'PAYPAL_VOID_PENDING_RETRY')
      ).toBe(true);
    });
  });

  // ============================================================================
  // 3. Duplicate unresolved audit suppression & change detection
  // ============================================================================
  describe('3. Duplicate Unresolved Audit Suppression & Payload Change Detection', () => {
    it('suppresses identical consecutive RECONCILIATION_UNRESOLVED, RECONCILIATION_INTEGRITY_MISMATCH, and PAYPAL_VOID_PENDING_RETRY rows, while emitting when payload changes', async () => {
      // 3a: Repeated CAPTURING -> CREATED emits 1 RECONCILIATION_UNRESOLVED row across 3 ticks
      const capturingReq = seedRequestWithReserve('CAPTURING', {
        paypal_authorization_id: 'AUTH-CAP-DUP',
      });

      const authCreated = {
        getAuthorization: vi.fn().mockResolvedValue({
          id: 'AUTH-CAP-DUP',
          status: 'CREATED',
          amountMinor: capturingReq.amount_minor,
          currency: 'USD',
          isCaptured: false,
          isPartiallyCaptured: false,
          isPending: false,
          isVoided: false,
          isExpired: false,
          isDenied: false,
          isCapturable: true,
        }),
      } as unknown as PayPalAuthorizationsService;

      await reconcilePaymentRequest(db, capturingReq.id, { repos, authorizationsService: authCreated });
      await reconcilePaymentRequest(db, capturingReq.id, { repos, authorizationsService: authCreated });
      await reconcilePaymentRequest(db, capturingReq.id, { repos, authorizationsService: authCreated });

      const unresolvedLogs = repos.auditLog
        .listByRequestId(capturingReq.id)
        .filter((l) => l.event === 'RECONCILIATION_UNRESOLVED');
      expect(unresolvedLogs).toHaveLength(1);

      // 3b: Repeated integrity mismatch emits 1 RECONCILIATION_INTEGRITY_MISMATCH row across 2 ticks
      const mismatchReq = seedRequestWithReserve('AUTO_EXECUTING', {
        paypal_order_id: 'ORD-MISMATCH',
        paypal_authorization_id: null,
      });

      const ordersMismatch = {
        getOrder: vi.fn().mockResolvedValue({
          id: 'ORD-MISMATCH',
          status: 'COMPLETED',
          intent: 'CAPTURE',
          isCaptured: true,
          isAuthorized: false,
          capture: {
            id: 'CAP-MISMATCH',
            status: 'COMPLETED',
            amountMinor: mismatchReq.amount_minor + 100, // differs
            currency: 'USD',
          },
          rawResponse: {},
        }),
      } as unknown as PayPalOrdersService;

      await reconcilePaymentRequest(db, mismatchReq.id, { repos, ordersService: ordersMismatch });
      await reconcilePaymentRequest(db, mismatchReq.id, { repos, ordersService: ordersMismatch });

      expect(
        repos.auditLog
          .listByRequestId(mismatchReq.id)
          .filter((l) => l.event === 'RECONCILIATION_INTEGRITY_MISMATCH')
      ).toHaveLength(1);

      // 3c: PAYPAL_VOID_PENDING_RETRY suppresses identical error & emits new row when error changes
      const voidRetryReq = seedRequestWithReserve('VOIDED', {
        paypal_authorization_id: 'AUTH-RETRY-DEDUP',
        remote_void_status: 'PENDING',
      });

      const retryAuthService = {
        getAuthorization: vi.fn().mockResolvedValue({
          id: 'AUTH-RETRY-DEDUP',
          status: 'CREATED',
          amountMinor: voidRetryReq.amount_minor,
          currency: 'USD',
          isCaptured: false,
          isPartiallyCaptured: false,
          isPending: false,
          isVoided: false,
          isExpired: false,
          isDenied: false,
          isCapturable: true,
        }),
        voidAuthorization: vi
          .fn()
          .mockRejectedValueOnce(new Error('ETIMEDOUT'))
          .mockRejectedValueOnce(new Error('ETIMEDOUT'))
          .mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable')),
      } as unknown as PayPalAuthorizationsService;

      await reconcilePaymentRequest(db, voidRetryReq.id, { repos, authorizationsService: retryAuthService });
      await reconcilePaymentRequest(db, voidRetryReq.id, { repos, authorizationsService: retryAuthService });
      await reconcilePaymentRequest(db, voidRetryReq.id, { repos, authorizationsService: retryAuthService });

      const retryLogs = repos.auditLog
        .listByRequestId(voidRetryReq.id)
        .filter((l) => l.event === 'PAYPAL_VOID_PENDING_RETRY');
      expect(retryLogs).toHaveLength(2);
      expect(JSON.parse(retryLogs[0]!.payload)).toMatchObject({ error: 'ETIMEDOUT' });
      expect(JSON.parse(retryLogs[1]!.payload)).toMatchObject({ error: 'HTTP 503 Service Unavailable' });

      // Direct unit check on writeAuditLogEntryIfChanged key-order invariance
      writeAuditLogEntryIfChanged(db, repos, {
        actor: 'system',
        event: 'RECONCILIATION_UNRESOLVED',
        requestId: capturingReq.id,
        payload: {
          authorizationId: 'AUTH-CAP-DUP',
          authorizationStatus: 'CREATED',
          reason: 'AUTHORIZATION_HOLD_UNCAPTURED_IN_FLIGHT',
        },
      });
      expect(
        repos.auditLog.listByRequestId(capturingReq.id).filter((l) => l.event === 'RECONCILIATION_UNRESOLVED')
      ).toHaveLength(1);

      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });
  });

  // ============================================================================
  // 4 & 5. Owner API: Policy Explanations, Dashboard Visibility, /api/paypal/activity
  // ============================================================================
  describe('4 & 5. Owner API Policy Explanations, Visibility Fields & /api/paypal/activity', () => {
    let mcpServer: PayGuardMcpServerInstance;
    let baseUrl = '';
    let sessionCookie = '';

    beforeEach(async () => {
      const hashedPass = await hashOwnerPassphrase('owner-pass-phase3');
      repos.owners.upsert({
        display_name: 'Primary Owner',
        passphrase_hash: hashedPass,
        telegram_chat_id: null,
        created_at: new Date().toISOString(),
      });

      mcpServer = createPayGuardMcpServer({
        db,
        repos,
        secureCookie: false,
      });
      const started = await mcpServer.start(0);
      baseUrl = `http://localhost:${started.port}`;

      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: 'owner-pass-phase3' }),
      });
      expect(loginRes.status).toBe(200);
      const setCookie = loginRes.headers.get('set-cookie')!;
      sessionCookie = setCookie.match(new RegExp(`${OWNER_COOKIE_NAME}=([^;]+)`))![0];
    });

    afterEach(async () => {
      await mcpServer.close();
    });

    it('maps canonical PolicyDocument fields, honors historical policy_version_id, and degrades gracefully on malformed JSON', async () => {
      // Historical inactive v2 policy with distinct thresholds vs newer active v3
      const historicalPolicy: PolicyDocument = {
        version: 2,
        currency_allowlist: ['USD', 'EUR'],
        auto_limit_minor: toMinorUnits(1500), // $15.00
        hard_cap_minor: toMinorUnits(4200), // $42.00
        agent_daily_budget_minor: toMinorUnits(9000), // $90.00
        global_daily_budget_minor: toMinorUnits(25000), // $250.00
        velocity: { max_requests: 3, window_minutes: 7 },
        duplicate_window_minutes: 45,
        new_vendor_action: 'HOLD',
        hold_ttl_minutes: 15,
      };
      repos.policyVersions.insert({
        id: 'pol-hist-v2',
        version: 2,
        rules: JSON.stringify(historicalPolicy),
        author: 'owner',
        active: 0,
        created_at: new Date().toISOString(),
      });

      // Make newer policy v3 active with completely different limits
      const newerActivePolicy: PolicyDocument = {
        ...historicalPolicy,
        version: 3,
        currency_allowlist: ['GBP'],
        auto_limit_minor: toMinorUnits(9999),
        hard_cap_minor: toMinorUnits(99999),
        global_daily_budget_minor: toMinorUnits(999999),
        duplicate_window_minutes: 120,
      };
      const v3Row: PolicyVersionRow = {
        id: 'pol-active-v3',
        version: 3,
        rules: JSON.stringify(newerActivePolicy),
        author: 'owner',
        active: 0,
        created_at: new Date().toISOString(),
      };
      repos.policyVersions.insert(v3Row);
      repos.policyVersions.setActive('pol-active-v3');

      const reqHistorical = seedRequestWithReserve('DENIED', {
        decision: 'DENY',
        policy_version_id: 'pol-hist-v2',
        amount_minor: toMinorUnits(4500), // $45.00
        currency: 'JPY',
        reasons: JSON.stringify([
          'CURRENCY_NOT_ALLOWED',
          'OVER_HARD_CAP',
          'OVER_AUTO_LIMIT',
          'GLOBAL_BUDGET_EXCEEDED',
          'AGENT_BUDGET_EXCEEDED',
          'DUPLICATE',
        ]),
      });

      const detailRes = await fetch(`${baseUrl}/api/requests/${reqHistorical.id}`, {
        headers: { Cookie: sessionCookie },
      });
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as {
        explanation: {
          items: Array<{ code: string; description: string }>;
        };
      };

      const byCode = new Map(detail.explanation.items.map((i) => [i.code, i.description]));
      expect(byCode.get('CURRENCY_NOT_ALLOWED')).toContain('[USD, EUR]');
      expect(byCode.get('OVER_HARD_CAP')).toContain('$42.00 JPY');
      expect(byCode.get('OVER_AUTO_LIMIT')).toContain('$15.00 JPY');
      expect(byCode.get('GLOBAL_BUDGET_EXCEEDED')).toContain('$250.00 JPY');
      expect(byCode.get('AGENT_BUDGET_EXCEEDED')).toContain('$90.00 JPY');
      expect(byCode.get('DUPLICATE')).toContain('45-minute');

      // Malformed rules JSON and missing policy version degrade cleanly without 500 or undefined/NaN
      repos.policyVersions.insert({
        id: 'pol-malformed',
        version: 4,
        rules: '{ not valid json',
        author: 'owner',
        active: 0,
        created_at: new Date().toISOString(),
      });
      const reqMalformed = seedRequestWithReserve('HELD', {
        decision: 'HOLD',
        policy_version_id: 'pol-malformed',
        reasons: JSON.stringify(['OVER_AUTO_LIMIT', 'DUPLICATE']),
      });

      const malformedRes = await fetch(`${baseUrl}/api/requests/${reqMalformed.id}`, {
        headers: { Cookie: sessionCookie },
      });
      expect(malformedRes.status).toBe(200);
      const malformedData = (await malformedRes.json()) as { explanation: { items: unknown[] } };
      const raw = JSON.stringify(malformedData.explanation);
      expect(raw).not.toContain('NaN');
      expect(raw).not.toContain('undefined');
      expect(malformedData.explanation.items).toHaveLength(2);
    });

    it('surfaces PayPal IDs, remoteVoidStatus, and intermediate/failed/expired statuses in /api/overview and /api/requests, and keeps /api/paypal/activity disabled fallback', async () => {
      const reqCaptured = seedRequestWithReserve('CAPTURED', {
        decision: 'ALLOW',
        paypal_order_id: 'ORD-CAP-1',
        paypal_capture_id: 'CAP-VIS-1',
        paypal_authorization_id: null,
        remote_void_status: null,
      });
      const reqVoidPending = seedRequestWithReserve('VOIDED', {
        paypal_order_id: 'ORD-VOID-1',
        paypal_authorization_id: 'AUTH-VOID-1',
        remote_void_status: 'PENDING',
      });
      const reqCapturing = seedRequestWithReserve('CAPTURING', {
        paypal_order_id: 'ORD-CAPTURING-1',
        paypal_authorization_id: 'AUTH-CAPTURING-1',
      });
      const reqFailed = seedRequestWithReserve('FAILED', {
        decision: 'ALLOW',
        paypal_order_id: 'ORD-FAIL-1',
        paypal_authorization_id: null,
      });

      // Check /api/overview recentActivity
      const overviewRes = await fetch(`${baseUrl}/api/overview`, {
        headers: { Cookie: sessionCookie },
      });
      expect(overviewRes.status).toBe(200);
      const overview = (await overviewRes.json()) as {
        recentActivity: Array<{
          id: string;
          status: string;
          paypalOrderId: string | null;
          paypalAuthorizationId: string | null;
          paypalCaptureId: string | null;
          remoteVoidStatus: string | null;
        }>;
      };

      const actCap = overview.recentActivity.find((i) => i.id === reqCaptured.id)!;
      expect(actCap.paypalCaptureId).toBe('CAP-VIS-1');
      expect(actCap.paypalOrderId).toBe('ORD-CAP-1');
      expect(actCap.remoteVoidStatus).toBeNull();

      const actVoidPending = overview.recentActivity.find((i) => i.id === reqVoidPending.id)!;
      expect(actVoidPending.status).toBe('VOIDED');
      expect(actVoidPending.paypalAuthorizationId).toBe('AUTH-VOID-1');
      expect(actVoidPending.remoteVoidStatus).toBe('PENDING');

      const actFailed = overview.recentActivity.find((i) => i.id === reqFailed.id)!;
      expect(actFailed.status).toBe('FAILED');
      expect(actFailed.paypalOrderId).toBe('ORD-FAIL-1');

      // Check /api/requests list & status filter for intermediate state
      const listCapRes = await fetch(`${baseUrl}/api/requests?status=CAPTURING`, {
        headers: { Cookie: sessionCookie },
      });
      expect(listCapRes.status).toBe(200);
      const listCap = (await listCapRes.json()) as {
        items: Array<{
          id: string;
          status: string;
          paypalOrderId: string | null;
          paypalAuthorizationId: string | null;
          updatedAt: string;
        }>;
      };
      expect(listCap.items).toHaveLength(1);
      expect(listCap.items[0]?.id).toBe(reqCapturing.id);
      expect(listCap.items[0]?.paypalAuthorizationId).toBe('AUTH-CAPTURING-1');
      expect(listCap.items[0]?.updatedAt).toBeDefined();

      // Check /api/paypal/activity disabled fallback contract
      const activityRes = await fetch(`${baseUrl}/api/paypal/activity`, {
        headers: { Cookie: sessionCookie },
      });
      expect(activityRes.status).toBe(200);
      const activityData = (await activityRes.json()) as { enabled: boolean; transactions: unknown[] };
      expect(activityData.enabled).toBe(false);
      expect(activityData.transactions).toEqual([]);
    });
  });

  // ============================================================================
  // 6 & 7. MCP Tools: Flow B Failure Reread & Lazy Hold Expiry Without AuthService
  // ============================================================================
  describe('6 & 7. MCP Tool Edge Cases: Flow B Reread & Synchronous Lazy Hold Expiry', () => {
    it('request_payment returns authoritative FAILED (not HELD) when Flow B fails definitively, and rereads DB status on exceptions', async () => {
      const definitiveFailOrders = {
        createOrder: vi.fn().mockRejectedValue(
          new PayPalHttpError({
            code: 'DECLINED',
            status: 422,
            message: 'PayPal declined instrument',
          })
        ),
        getOrder: vi.fn(),
      } as unknown as PayPalOrdersService;

      await agentContextStorage.run({ agentId: agentAlice.id, agent: agentAlice }, async () => {
        const res = await handleRequestPayment(
          db,
          {
            vendor_id: 'ven-acme',
            amount: '30.00', // Triggers HOLD -> Flow B
            currency: 'USD',
            purpose: 'Flow B definitive failure check',
            category: 'cloud',
            idempotency_key: 'idem-flowb-def-fail-1',
          },
          repos,
          { ordersService: definitiveFailOrders }
        );

        const body = JSON.parse((res.content[0] as { text: string }).text) as {
          request_id: string;
          status: string;
          decision: string;
          message: string;
          next_step: string;
        };

        expect(body.decision).toBe('HOLD');
        expect(body.status).toBe('FAILED');
        expect(body.message).toContain('failed');
        expect(body.next_step).toContain('Do not retry automatically');
        expect(repos.paymentRequests.getById(body.request_id)!.status).toBe('FAILED');

        // Definitive Flow B failure also released budget reservation
        const budgetAfterFail = await handleGetBudget(db, {}, repos);
        expect(
          (JSON.parse((budgetAfterFail.content[0] as { text: string }).text) as { remaining_daily_budget_minor: number })
            .remaining_daily_budget_minor
        ).toBe(10000);
      });

      // Verify ambiguous exception leaves HELD & catch rereads HELD cleanly
      const ambiguousOrders = {
        createOrder: vi.fn().mockRejectedValue(
          new PayPalHttpError({
            code: 'NETWORK',
            status: 504,
            message: 'Gateway timeout',
          })
        ),
        getOrder: vi.fn(),
      } as unknown as PayPalOrdersService;

      await agentContextStorage.run({ agentId: agentAlice.id, agent: agentAlice }, async () => {
        const res = await handleRequestPayment(
          db,
          {
            vendor_id: 'ven-acme',
            amount: '32.00',
            currency: 'USD',
            purpose: 'Flow B ambiguous exception check',
            category: 'cloud',
            idempotency_key: 'idem-flowb-ambig-1',
          },
          repos,
          { ordersService: ambiguousOrders }
        );

        const body = JSON.parse((res.content[0] as { text: string }).text) as {
          request_id: string;
          status: string;
          decision: string;
        };
        expect(body.decision).toBe('HOLD');
        expect(body.status).toBe('HELD');
        expect(repos.paymentRequests.getById(body.request_id)!.status).toBe('HELD');
      });
    });

    it('get_payment_status lazily expires stale HELD requests even without authorizationsService, releasing agent budget, and blocks cross-agent calls', async () => {
      const expiredHold = seedRequestWithReserve('HELD', {
        agent_id: agentAlice.id,
        amount_minor: toMinorUnits(3000), // $30.00
        paypal_authorization_id: 'AUTH-MCP-LAZY',
        expires_at: new Date(Date.now() - 120_000).toISOString(),
      });

      // Verify tenant isolation FIRST: Bob cannot inspect or trigger expiry on Alice's request
      await agentContextStorage.run({ agentId: agentBob.id, agent: agentBob }, async () => {
        const bobRes = await handleGetPaymentStatus(db, { request_id: expiredHold.id }, repos);
        expect(bobRes.isError).toBe(true);
        expect((bobRes.content[0] as { text: string }).text).toContain('not found');
      });
      expect(repos.paymentRequests.getById(expiredHold.id)!.status).toBe('HELD');

      // Alice calls get_payment_status WITHOUT authorizationsService -> lazy expiry commits VOIDED + RELEASE
      await agentContextStorage.run({ agentId: agentAlice.id, agent: agentAlice }, async () => {
        const aliceRes = await handleGetPaymentStatus(db, { request_id: expiredHold.id }, repos);
        expect(aliceRes.isError).toBeFalsy();
        const body = JSON.parse((aliceRes.content[0] as { text: string }).text) as {
          request_id: string;
          status: string;
        };
        expect(body.status).toBe('VOIDED');

        // Agent budget should now be completely freed back to $100.00
        const budgetRes = await handleGetBudget(db, {}, repos);
        const budget = JSON.parse((budgetRes.content[0] as { text: string }).text) as {
          remaining_daily_budget_minor: number;
        };
        expect(budget.remaining_daily_budget_minor).toBe(10000);
      });

      const stored = repos.paymentRequests.getById(expiredHold.id)!;
      expect(stored.status).toBe('VOIDED');
      expect(stored.remote_void_status).toBe('PENDING');
      expect(repos.ledger.listByRequestId(expiredHold.id).filter((l) => l.kind === 'RELEASE')).toHaveLength(1);

      // Verify ApprovalExecutionService-tracked path without authorizationsService also works cleanly
      const expiredHoldTracked = seedRequestWithReserve('HELD', {
        agent_id: agentAlice.id,
        amount_minor: toMinorUnits(2500),
        paypal_authorization_id: null,
        expires_at: new Date(Date.now() - 120_000).toISOString(),
      });
      const svcWithoutAuth = new ApprovalExecutionService({ db, repos });
      await agentContextStorage.run({ agentId: agentAlice.id, agent: agentAlice }, async () => {
        const res = await handleGetPaymentStatus(
          db,
          { request_id: expiredHoldTracked.id },
          repos,
          { approvalExecutionService: svcWithoutAuth }
        );
        expect(res.isError).toBeFalsy();
        const parsed = JSON.parse((res.content[0] as { text: string }).text) as { status: string };
        expect(parsed.status).toBe('VOIDED');
      });
      expect(repos.paymentRequests.getById(expiredHoldTracked.id)!.remote_void_status).toBe('FAILED');
    });
  });

  // ============================================================================
  // 8. Reconciliation Candidate Selection & Ledger Idempotency
  // ============================================================================
  describe('8. Reconciliation Candidate Selection & Ledger Mutual-Exclusion Idempotency', () => {
    it('listNeedingReconciliation excludes healthy active HELD holds while discovering broken/expired holds, in-flight captures, and unresolved voids', () => {
      const futureIso = new Date(Date.now() + 10 * 60_000).toISOString();
      const pastIso = new Date(Date.now() - 60_000).toISOString();

      // Should BE EXCLUDED: healthy active HELD with valid auth ID and future expires_at
      const healthyHeld = seedRequestWithReserve('HELD', {
        paypal_authorization_id: 'AUTH-HEALTHY-1',
        expires_at: futureIso,
      });

      // Should BE INCLUDED:
      const heldMissingAuth = seedRequestWithReserve('HELD', {
        paypal_authorization_id: null,
        expires_at: futureIso,
      });
      const heldBlankAuth = seedRequestWithReserve('HELD', {
        paypal_authorization_id: '   ',
        expires_at: futureIso,
      });
      const heldExpired = seedRequestWithReserve('HELD', {
        paypal_authorization_id: 'AUTH-EXPIRED-1',
        expires_at: pastIso,
      });
      const autoExec = seedRequestWithReserve('AUTO_EXECUTING', {
        paypal_order_id: 'ORD-AUTO-1',
        paypal_authorization_id: null,
      });
      const approved = seedRequestWithReserve('APPROVED', {
        paypal_authorization_id: 'AUTH-APP-1',
      });
      const capturing = seedRequestWithReserve('CAPTURING', {
        paypal_authorization_id: 'AUTH-CAP-1',
      });
      const voidPending = seedRequestWithReserve('VOIDED', {
        paypal_authorization_id: 'AUTH-VOID-PEND',
        remote_void_status: 'PENDING',
      });
      const voidFailed = seedRequestWithReserve('VOIDED', {
        paypal_authorization_id: 'AUTH-VOID-FAIL',
        remote_void_status: 'FAILED',
      });
      const voidConfirmed = seedRequestWithReserve('VOIDED', {
        paypal_authorization_id: 'AUTH-VOID-CONF',
        remote_void_status: 'CONFIRMED',
      });

      const candidateIds = new Set(repos.paymentRequests.listNeedingReconciliation().map((r) => r.id));

      expect(candidateIds.has(healthyHeld.id)).toBe(false);
      expect(candidateIds.has(voidConfirmed.id)).toBe(false);

      expect(candidateIds.has(heldMissingAuth.id)).toBe(true);
      expect(candidateIds.has(heldBlankAuth.id)).toBe(true);
      expect(candidateIds.has(heldExpired.id)).toBe(true);
      expect(candidateIds.has(autoExec.id)).toBe(true);
      expect(candidateIds.has(approved.id)).toBe(true);
      expect(candidateIds.has(capturing.id)).toBe(true);
      expect(candidateIds.has(voidPending.id)).toBe(true);
      expect(candidateIds.has(voidFailed.id)).toBe(true);
    });

    it('enforces SPEND vs RELEASE mutual exclusion and single-entry idempotency across repeated Flow A and Flow C reconciliations', async () => {
      // 8a: Flow C repeated calls insert strictly 1 SPEND
      const reqFlowC = seedRequestWithReserve('CAPTURING', {
        paypal_authorization_id: 'AUTH-IDEM-C',
      });

      const authCaptured = {
        getAuthorization: vi.fn().mockResolvedValue({
          id: 'AUTH-IDEM-C',
          status: 'CAPTURED',
          amountMinor: reqFlowC.amount_minor,
          currency: 'USD',
          isCaptured: true,
          isPartiallyCaptured: false,
          isPending: false,
          isVoided: false,
          isExpired: false,
          isDenied: false,
          isCapturable: false,
        }),
      } as unknown as PayPalAuthorizationsService;

      const [c1, c2] = await Promise.all([
        reconcilePaymentRequest(db, reqFlowC.id, { repos, authorizationsService: authCaptured }),
        reconcilePaymentRequest(db, reqFlowC.id, { repos, authorizationsService: authCaptured }),
      ]);
      expect(c1.reconciled || c2.reconciled).toBe(true);
      expect(repos.paymentRequests.getById(reqFlowC.id)!.status).toBe('CAPTURED');
      expect(repos.ledger.listByRequestId(reqFlowC.id).filter((l) => l.kind === 'SPEND')).toHaveLength(1);
      expect(repos.ledger.listByRequestId(reqFlowC.id).filter((l) => l.kind === 'RELEASE')).toHaveLength(0);

      // 8b: Flow A refuses SPEND if RELEASE already exists on ledger
      const reqConflictA = seedRequestWithReserve('AUTO_EXECUTING', {
        paypal_order_id: 'ORD-CONFLICT-A',
        paypal_authorization_id: null,
      });
      repos.ledger.insert({
        id: `led-rel-conflict-${crypto.randomUUID()}`,
        request_id: reqConflictA.id,
        kind: 'RELEASE',
        amount_minor: reqConflictA.amount_minor,
        currency: reqConflictA.currency,
        created_at: new Date().toISOString(),
      });
      writeAuditLogEntry(db, repos, {
        actor: 'system',
        event: 'PRE_RELEASED',
        requestId: reqConflictA.id,
        payload: {},
      });

      const ordersCaptured = {
        getOrder: vi.fn().mockResolvedValue({
          id: 'ORD-CONFLICT-A',
          status: 'COMPLETED',
          intent: 'CAPTURE',
          isCaptured: true,
          isAuthorized: false,
          capture: {
            id: 'CAP-CONFLICT-A',
            status: 'COMPLETED',
            amountMinor: reqConflictA.amount_minor,
            currency: 'USD',
          },
          rawResponse: {},
        } as unknown as PayPalOrderResult),
      } as unknown as PayPalOrdersService;

      const conflictRes = await reconcilePaymentRequest(db, reqConflictA.id, {
        repos,
        ordersService: ordersCaptured,
      });
      expect(conflictRes.isUnresolved).toBe(true);
      expect(repos.ledger.listByRequestId(reqConflictA.id).filter((l) => l.kind === 'SPEND')).toHaveLength(0);
      expect(repos.paymentRequests.getById(reqConflictA.id)!.status).toBe('AUTO_EXECUTING');
    });
  });
});
