/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T3 Unit & Integration Tests: Approval & Void HTTP Flow (test/unit/approvalFlow.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { toMinorUnits } from '../../src/core/money.js';
import { computeSnapshotHash } from '../../src/core/service.js';
import {
  mintApprovalToken,
} from '../../src/approvals/tokens.js';
import { createApprovalRouter } from '../../src/approvals/routes.js';
import { OwnerSessionStore, OWNER_COOKIE_NAME } from '../../src/auth/owner.js';
import type { PayPalAuthorizationsService, PayPalCaptureResult } from '../../src/paypal/authorizations.js';
import { AuthorizationError } from '../../src/paypal/authorizations.js';
import { PayPalHttpError } from '../../src/paypal/http.js';
import { _resetInFlightExecutionsForTest, executeDecision } from '../../src/core/executeDecision.js';
import { reconcilePaymentRequest, reconcilePendingRequests } from '../../src/paypal/reconcile.js';

describe('M4-T3: Approval & Void HTTP Flow (GET /a/:token, POST /approve, POST /void)', () => {
  let db: Database;
  let repos: Repositories;
  let sessionStore: OwnerSessionStore;
  let server: Server;
  let baseUrl = '';

  let mockAuthorizationsService: PayPalAuthorizationsService;

  const testAgentId = 'agent-demo-honest';
  const testVendorId = 'ven-acme';
  const testPolicyId = 'pol-v1';
  const testAuthId = 'AUTH-SANDBOX-TEST-12345';

  let ownerToken = '';
  let ownerCsrf = '';

  beforeEach(async () => {
    _resetInFlightExecutionsForTest();
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);
    sessionStore = new OwnerSessionStore();

    // 1. Seed Owner
    repos.owners.upsert({
      display_name: 'Primary Owner',
      passphrase_hash: 'dummy-hash',
      telegram_chat_id: null,
      created_at: new Date().toISOString(),
    });

    // 2. Seed Agent
    repos.agents.insert({
      id: testAgentId,
      name: 'Honest Agent',
      api_key_hash: 'hash-honest',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(5000),
      created_at: new Date().toISOString(),
    });

    // 3. Seed Vendor
    repos.vendors.insert({
      id: testVendorId,
      name: 'Acme Cloud Hosting',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud', 'hosting']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    });

    // 4. Seed Policy
    repos.policyVersions.insert({
      id: testPolicyId,
      version: 1,
      rules: JSON.stringify({ auto_limit_minor: 1500 }),
      author: 'owner',
      active: 1,
      created_at: new Date().toISOString(),
    });

    // 5. Create authenticated owner session
    const sessionRes = sessionStore.createSession({
      id: 'default',
      displayName: 'Primary Owner',
    });
    ownerToken = sessionRes.rawSessionToken;
    ownerCsrf = sessionRes.csrfToken;

    // 6. Setup Mock PayPal Authorizations Service
    mockAuthorizationsService = {
      captureAuthorization: vi.fn().mockResolvedValue({
        id: 'CAPTURE-SUCCESS-999',
        status: 'COMPLETED',
        isCaptured: true,
      } as PayPalCaptureResult),
      voidAuthorization: vi.fn().mockResolvedValue({
        id: testAuthId,
        status: 'VOIDED',
        isVoided: true,
      }),
      getAuthorization: vi.fn(),
    } as unknown as PayPalAuthorizationsService;

    // 7. Initialize Express app and mount approval router
    const app: Express = express();
    app.use(express.json());

    const approvalRouter = createApprovalRouter({
      db,
      repos,
      sessionStore,
      authorizationsService: mockAuthorizationsService,
    });
    app.use('/a', approvalRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    _resetInFlightExecutionsForTest();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    db.close();
  });

  /**
   * Helper to seed a valid HELD payment request with a RESERVE ledger row.
   */
  function seedHeldPaymentRequest(options?: {
    id?: string;
    amountMinor?: number;
    expiresAt?: string;
    status?: string;
  }) {
    const requestId = options?.id ?? `req-held-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const amountMinor = toMinorUnits(options?.amountMinor ?? 2500); // $25.00
    const currency = 'USD';
    const purpose = 'Database infrastructure credits';
    const category = 'cloud';
    const nowIso = new Date().toISOString();
    const expiresAt = options?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const snapshotHash = computeSnapshotHash({
      requestId,
      agentId: testAgentId,
      vendorId: testVendorId,
      amountMinor,
      currency,
      purpose,
      category,
    });

    repos.paymentRequests.insert({
      id: requestId,
      agent_id: testAgentId,
      idempotency_key: `idem-${requestId}`,
      vendor_id: testVendorId,
      amount_minor: amountMinor,
      currency,
      purpose,
      category,
      source_context_excerpt: 'Invoice #1042: Database servers',
      source_context_hash: null,
      status: options?.status ?? 'HELD',
      decision: 'HOLD',
      reasons: JSON.stringify(['AMOUNT_EXCEEDS_AUTO_LIMIT', 'NEW_VENDOR_HOLD']),
      policy_version_id: testPolicyId,
      snapshot_hash: snapshotHash,
      paypal_order_id: null,
      paypal_authorization_id: testAuthId,
      paypal_capture_id: null,
      expires_at: expiresAt,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // Seed reserve row in ledger
    repos.ledger.insert({
      id: `led-reserve-${requestId}`,
      request_id: requestId,
      kind: 'RESERVE',
      amount_minor: amountMinor,
      currency,
      created_at: nowIso,
    });

    return { requestId, amountMinor, snapshotHash, expiresAt };
  }

  // ============================================================================
  // 1. GET /a/:token Review Tests
  // ============================================================================

  describe('1. GET /a/:token (Approval Review)', () => {
    it('requires owner authentication (401 without cookie or invalid session)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      // 1. No cookie
      const resNoAuth = await fetch(`${baseUrl}/a/${rawToken}`);
      expect(resNoAuth.status).toBe(401);
      const dataNoAuth = await resNoAuth.json() as { error: string };
      expect(dataNoAuth.error).toContain('Authentication required');

      // 2. Invalid cookie
      const resBadCookie = await fetch(`${baseUrl}/a/${rawToken}`, {
        headers: { Cookie: `${OWNER_COOKIE_NAME}=invalid-session-token-123` },
      });
      expect(resBadCookie.status).toBe(401);
    });

    it('GET is strictly read-only: does not consume the token and does not execute payment', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      // Perform multiple GETs
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${baseUrl}/a/${rawToken}`, {
          headers: { Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}` },
        });
        expect(res.status).toBe(200);
      }

      // 1. Token must remain unused
      const approvalRow = repos.approvals.getByTokenHash(mintRes.tokenHash!);
      expect(approvalRow?.used_at).toBeNull();

      // 2. Request status must remain HELD
      const requestRow = repos.paymentRequests.getById(requestId);
      expect(requestRow?.status).toBe('HELD');

      // 3. Zero SPEND rows in ledger
      const ledgerRows = repos.ledger.listByRequestId(requestId);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]?.kind).toBe('RESERVE');

      // 4. Zero PayPal calls
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
      expect(mockAuthorizationsService.voidAuthorization).not.toHaveBeenCalled();
    });

    it('returns sanitized review details without leaking credentials or vault tokens', async () => {
      const { requestId } = seedHeldPaymentRequest({ amountMinor: 4250 });
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      const res = await fetch(`${baseUrl}/a/${rawToken}`, {
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          Accept: 'application/json',
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as {
        success: boolean;
        review: {
          requestId: string;
          action: string;
          status: string;
          vendor: { id: string; name: string };
          amount: { amountMinor: number; amountDecimal: string; currency: string };
          purpose: string;
          policyReasons: string[];
          sourceContextExcerpt: string;
        };
      };

      expect(data.success).toBe(true);
      expect(data.review.requestId).toBe(requestId);
      expect(data.review.action).toBe('APPROVE');
      expect(data.review.status).toBe('HELD');
      expect(data.review.vendor.name).toBe('Acme Cloud Hosting');
      expect(data.review.amount.amountDecimal).toBe('42.50');
      expect(data.review.amount.currency).toBe('USD');
      expect(data.review.policyReasons).toEqual(['AMOUNT_EXCEEDS_AUTO_LIMIT', 'NEW_VENDOR_HOLD']);

      // Ensure no raw token or sensitive internal data leaked in payload
      const jsonString = JSON.stringify(data);
      expect(jsonString).not.toContain(rawToken);
      expect(jsonString).not.toContain('hash-honest');
      expect(jsonString).not.toContain('dummy-hash');
    });

    it('returns mobile-friendly HTML with strict CSP when Accept header prefers HTML', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      const res = await fetch(`${baseUrl}/a/${rawToken}`, {
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          Accept: 'text/html,application/xhtml+xml',
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');

      // Security headers check
      const csp = res.headers.get('content-security-policy');
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');

      const html = await res.text();
      expect(html).toContain('PayGuard — Payment Authorization');
      expect(html).toContain('Acme Cloud Hosting');
      expect(html).toContain('Approve Payment');
      expect(html).toContain(ownerCsrf); // Injects CSRF token into form
    });

    it('rejects invalid, expired, and consumed tokens', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      // 1. Invalid / malformed token
      const resBad = await fetch(`${baseUrl}/a/not-a-valid-token`, {
        headers: { Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}` },
      });
      expect(resBad.status).toBe(404);

      // 2. Non-existent token
      const fakeToken = '1234567890123456789012345678901234567890123';
      const resNotFound = await fetch(`${baseUrl}/a/${fakeToken}`, {
        headers: { Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}` },
      });
      expect(resNotFound.status).toBe(404);

      // 3. Consumed token
      repos.approvals.markUsed(mintRes.tokenHash!, new Date().toISOString());
      const resConsumed = await fetch(`${baseUrl}/a/${rawToken}`, {
        headers: { Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}` },
      });
      expect(resConsumed.status).toBe(410);
      const dataConsumed = await resConsumed.json() as { error: string };
      expect(dataConsumed.error).toBe('TOKEN_ALREADY_USED');
    });

    it('rejects GET review when snapshot hash integrity check fails (tamper detection)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      // Tamper with amount in database
      db.prepare('UPDATE payment_requests SET amount_minor = 99999 WHERE id = ?').run(requestId);

      const res = await fetch(`${baseUrl}/a/${rawToken}`, {
        headers: { Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}` },
      });
      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('SNAPSHOT_MISMATCH');
    });
  });

  // ============================================================================
  // 2. POST /a/:token/approve Tests
  // ============================================================================

  describe('2. POST /a/:token/approve (Approval Execution)', () => {
    it('requires owner session (401) and valid CSRF token (403)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      // 1. Missing cookie -> 401
      const resNoAuth = await fetch(`${baseUrl}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: { 'x-csrf-token': ownerCsrf },
      });
      expect(resNoAuth.status).toBe(401);

      // 2. Missing CSRF header -> 403
      const resNoCsrf = await fetch(`${baseUrl}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: { Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}` },
      });
      expect(resNoCsrf.status).toBe(403);
      const dataNoCsrf = await resNoCsrf.json() as { error: string };
      expect(dataNoCsrf.error).toContain('CSRF');

      // 3. Invalid CSRF header -> 403
      const resBadCsrf = await fetch(`${baseUrl}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': 'wrong-csrf-token-12345',
        },
      });
      expect(resBadCsrf.status).toBe(403);
    });

    it('rejects approval when token is bound to VOID action', async () => {
      const { requestId } = seedHeldPaymentRequest();
      // Mint a VOID token
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'VOID' });
      const rawToken = mintRes.rawToken!;

      // Attempt to submit to /approve
      const res = await fetch(`${baseUrl}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('ACTION_MISMATCH');

      // Verify token was NOT consumed
      const approvalRow = repos.approvals.getByTokenHash(mintRes.tokenHash!);
      expect(approvalRow?.used_at).toBeNull();
    });

    it('approval succeeds for a valid HELD request and executes Flow C capture via executeDecision', async () => {
      const { requestId } = seedHeldPaymentRequest({ amountMinor: 3000 });
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      const res = await fetch(`${baseUrl}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as {
        success: boolean;
        requestId: string;
        status: string;
        executedAction: string;
        captureId: string;
      };

      expect(data.success).toBe(true);
      expect(data.requestId).toBe(requestId);
      expect(data.status).toBe('CAPTURED');
      expect(data.executedAction).toBe('CAPTURED_APPROVED');
      expect(data.captureId).toBe('CAPTURE-SUCCESS-999');

      // 1. Verify token was atomically consumed
      const approvalRow = repos.approvals.getByTokenHash(mintRes.tokenHash!);
      expect(approvalRow?.used_at).not.toBeNull();

      // 2. Verify payment request state in DB
      const requestRow = repos.paymentRequests.getById(requestId);
      expect(requestRow?.status).toBe('CAPTURED');
      expect(requestRow?.paypal_capture_id).toBe('CAPTURE-SUCCESS-999');

      // 3. Verify ledger has SPEND row (and earlier RESERVE row)
      const ledgerRows = repos.ledger.listByRequestId(requestId);
      expect(ledgerRows.map((l) => l.kind)).toEqual(['RESERVE', 'SPEND']);

      // 4. Verify PayPal captureAuthorization was called exactly once with snapshot amount
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorizationId: testAuthId,
          requestId,
          amountMinor: toMinorUnits(3000),
          currency: 'USD',
          finalCapture: true,
        })
      );
    });

    it('duplicate / replay submission is rejected with TOKEN_ALREADY_USED', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      // First submission succeeds
      const res1 = await fetch(`${baseUrl}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });
      expect(res1.status).toBe(200);

      // Second submission fails closed
      const res2 = await fetch(`${baseUrl}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res2.status).toBe(409);
      const data2 = await res2.json() as { error: string };
      expect(data2.error).toBe('TOKEN_ALREADY_USED');

      // Ensure capture was NOT invoked a second time
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);
    });

    it('concurrent approval submissions cannot execute twice', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      // Send 5 concurrent approval requests
      const promises = Array.from({ length: 5 }, () =>
        fetch(`${baseUrl}/a/${rawToken}/approve`, {
          method: 'POST',
          headers: {
            Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
            'x-csrf-token': ownerCsrf,
          },
        })
      );

      const responses = await Promise.all(promises);
      const statuses = responses.map((r) => r.status);

      // Exactly ONE must succeed (200), and all others fail (409)
      const successCount = statuses.filter((s) => s === 200).length;
      const conflictCount = statuses.filter((s) => s === 409).length;

      expect(successCount).toBe(1);
      expect(conflictCount).toBe(4);

      // PayPal capture was called only once
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);
    });

    it('handles ambiguous PayPal execution outcomes safely with handoff to reconciliation', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      // Simulate network timeout from PayPal
      const timeoutHttpError = new PayPalHttpError({
        code: 'NETWORK',
        message: 'Request timeout connecting to PayPal (ETIMEDOUT)',
      });
      (mockAuthorizationsService.captureAuthorization as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        timeoutHttpError
      );

      const res = await fetch(`${baseUrl}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      // Ambiguous outcome returns 202 with reconciliation notice
      expect(res.status).toBe(202);
      const data = await res.json() as {
        success: boolean;
        status: string;
        error: string;
        reconciliationRequired: boolean;
      };

      expect(data.success).toBe(false);
      expect(data.status).toBe('CAPTURING');
      expect(data.error).toBe('AMBIGUOUS_EXECUTION');
      expect(data.reconciliationRequired).toBe(true);

      // Token was burned
      const approvalRow = repos.approvals.getByTokenHash(mintRes.tokenHash!);
      expect(approvalRow?.used_at).not.toBeNull();

      // Request remains in CAPTURING with reservation preserved
      const requestRow = repos.paymentRequests.getById(requestId);
      expect(requestRow?.status).toBe('CAPTURING');

      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.kind).toBe('RESERVE'); // Reservation NOT released
    });

    it('handles definitive PayPal failure by transitioning to FAILED and releasing reservation', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      // Simulate definitive 422 INSTRUMENT_DECLINED from PayPal
      const declinedError = new AuthorizationError(
        'DECLINED',
        'Payer instrument was declined',
        {
          causeError: {
            status: 422,
            issue: 'INSTRUMENT_DECLINED',
          },
        }
      );
      (mockAuthorizationsService.captureAuthorization as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        declinedError
      );

      const res = await fetch(`${baseUrl}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res.status).toBe(500);
      const data = await res.json() as { status: string };
      expect(data.status).toBe('FAILED');

      // Request transitioned to FAILED and reservation released
      const requestRow = repos.paymentRequests.getById(requestId);
      expect(requestRow?.status).toBe('FAILED');

      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);
    });
  });

  // ============================================================================
  // 3. POST /a/:token/void Tests
  // ============================================================================

  describe('3. POST /a/:token/void (Void Execution)', () => {
    it('requires owner session (401) and valid CSRF token (403)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'VOID' });
      const rawToken = mintRes.rawToken!;

      // 1. Missing cookie -> 401
      const resNoAuth = await fetch(`${baseUrl}/a/${rawToken}/void`, {
        method: 'POST',
        headers: { 'x-csrf-token': ownerCsrf },
      });
      expect(resNoAuth.status).toBe(401);

      // 2. Missing CSRF -> 403
      const resNoCsrf = await fetch(`${baseUrl}/a/${rawToken}/void`, {
        method: 'POST',
        headers: { Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}` },
      });
      expect(resNoCsrf.status).toBe(403);
    });

    it('rejects void when token is bound to APPROVE action', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const rawToken = mintRes.rawToken!;

      const res = await fetch(`${baseUrl}/a/${rawToken}/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('ACTION_MISMATCH');
    });

    it('void succeeds for a valid HELD request, releases reservation, and calls voidAuthorization', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'VOID' });
      const rawToken = mintRes.rawToken!;

      const res = await fetch(`${baseUrl}/a/${rawToken}/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as {
        success: boolean;
        requestId: string;
        status: string;
        remoteVoidSuccess: boolean;
      };

      expect(data.success).toBe(true);
      expect(data.requestId).toBe(requestId);
      expect(data.status).toBe('VOIDED');
      expect(data.remoteVoidSuccess).toBe(true);

      // 1. Token marked used
      const approvalRow = repos.approvals.getByTokenHash(mintRes.tokenHash!);
      expect(approvalRow?.used_at).not.toBeNull();

      // 2. Request status transitioned to VOIDED
      const requestRow = repos.paymentRequests.getById(requestId);
      expect(requestRow?.status).toBe('VOIDED');

      // 3. Ledger reservation released
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);

      // 4. Remote PayPal void called outside DB transaction
      expect(mockAuthorizationsService.voidAuthorization).toHaveBeenCalledTimes(1);
      expect(mockAuthorizationsService.voidAuthorization).toHaveBeenCalledWith({
        authorizationId: testAuthId,
        requestId,
      });

      // 5. Zero money-moving capture calls
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
    });

    it('rejects replay void submission with TOKEN_ALREADY_USED', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'VOID' });
      const rawToken = mintRes.rawToken!;

      const res1 = await fetch(`${baseUrl}/a/${rawToken}/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });
      expect(res1.status).toBe(200);

      const res2 = await fetch(`${baseUrl}/a/${rawToken}/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });
      expect(res2.status).toBe(409);
      const data2 = await res2.json() as { error: string };
      expect(data2.error).toBe('TOKEN_ALREADY_USED');
    });

    it('concurrent approve and void submissions for the same request cannot both succeed', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintApprove = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const mintVoid = mintApprovalToken(db, repos, { requestId, action: 'VOID' });

      // Run APPROVE and VOID in parallel
      const [resApprove, resVoid] = await Promise.all([
        fetch(`${baseUrl}/a/${mintApprove.rawToken!}/approve`, {
          method: 'POST',
          headers: {
            Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
            'x-csrf-token': ownerCsrf,
          },
        }),
        fetch(`${baseUrl}/a/${mintVoid.rawToken!}/void`, {
          method: 'POST',
          headers: {
            Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
            'x-csrf-token': ownerCsrf,
          },
        }),
      ]);

      // Exactly ONE succeeds (200), and the other fails (400 INVALID_REQUEST_STATUS)
      const statuses = [resApprove.status, resVoid.status];
      expect(statuses).toContain(200);

      const non200Status = statuses.find((s) => s !== 200);
      expect(non200Status).toBe(400);

      // Verify the final request status in DB is consistent
      const finalRequest = repos.paymentRequests.getById(requestId);
      expect(['CAPTURED', 'VOIDED']).toContain(finalRequest?.status);
    });
  });

  // ============================================================================
  // 4. FIX 1: APPROVED Crash Recovery Tests
  // ============================================================================

  describe('4. FIX 1: APPROVED Crash Recovery (executeDecision Flow C Resumption)', () => {
    it('discovers orphaned APPROVED request after simulated crash and captures via executeDecision', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });

      // Simulate crash between Step 1 (commit HELD -> APPROVED) and Step 2 (executeDecision):
      // Mark token used and set status APPROVED directly
      const nowIso = new Date().toISOString();
      repos.approvals.markUsed(mintRes.tokenHash!, nowIso);
      repos.paymentRequests.updateStatusAndDecision(requestId, {
        status: 'APPROVED',
        updatedAt: nowIso,
      });

      // 1. Verify reconciliation discovery finds this APPROVED request
      const pendingList = repos.paymentRequests.listNeedingReconciliation();
      expect(pendingList.map((r) => r.id)).toContain(requestId);

      // 2. Run reconciliation worker
      const reconResult = await reconcilePaymentRequest(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(reconResult.reconciled).toBe(true);
      expect(reconResult.status).toBe('CAPTURED');
      expect(reconResult.actionTaken).toBe('CAPTURED_APPROVED');

      // 3. Verify DB state has transitioned to CAPTURED
      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('CAPTURED');
      expect(finalRow?.paypal_capture_id).toBe('CAPTURE-SUCCESS-999');

      // 4. Verify SPEND row in ledger
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'SPEND']);

      // 5. Verify PayPal capture was called with canonical idempotency key
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorizationId: testAuthId,
          requestId,
        })
      );
    });

    it('concurrent recovery attempts join single in-flight promise and execute capture exactly once', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const nowIso = new Date().toISOString();
      repos.paymentRequests.updateStatusAndDecision(requestId, {
        status: 'APPROVED',
        updatedAt: nowIso,
      });

      (mockAuthorizationsService.getAuthorization as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: testAuthId,
        status: 'CREATED',
        amountMinor: 2500,
        currency: 'USD',
        isCapturable: true,
      });

      // Trigger 3 concurrent recovery attempts for the same APPROVED request
      const results = await Promise.all([
        reconcilePaymentRequest(db, requestId, { repos, authorizationsService: mockAuthorizationsService }),
        reconcilePaymentRequest(db, requestId, { repos, authorizationsService: mockAuthorizationsService }),
        reconcilePaymentRequest(db, requestId, { repos, authorizationsService: mockAuthorizationsService }),
      ]);

      // At least one resolves to CAPTURED, and all return valid statuses without throwing
      const statuses = results.map((r) => r.status);
      expect(statuses).toContain('CAPTURED');

      // Exactly ONE capture call made (idempotent single-flight protection)
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);

      // Exactly ONE SPEND entry in ledger
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'SPEND']);
    });

    it('ambiguous capture outcome during recovery sets CAPTURING and preserves reservation', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const nowIso = new Date().toISOString();
      repos.paymentRequests.updateStatusAndDecision(requestId, {
        status: 'APPROVED',
        updatedAt: nowIso,
      });

      const timeoutError = new PayPalHttpError({
        code: 'NETWORK',
        message: 'Request timeout to PayPal during recovery capture',
      });
      (mockAuthorizationsService.captureAuthorization as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        timeoutError
      );

      const reconResult = await reconcilePaymentRequest(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(reconResult.reconciled).toBe(false);
      expect(reconResult.status).toBe('CAPTURING');
      expect(reconResult.isUnresolved).toBe(true);

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('CAPTURING');

      // Reservation preserved
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE']);
    });

    it('expired orphaned APPROVED request transitions to FAILED, releases reservation once, and voids authorization', async () => {
      const pastExpiry = new Date(Date.now() - 60_000).toISOString();
      const { requestId } = seedHeldPaymentRequest({ expiresAt: pastExpiry });
      repos.paymentRequests.updateStatusAndDecision(requestId, {
        status: 'APPROVED',
        expiresAt: pastExpiry,
      });

      const reconResult = await reconcilePaymentRequest(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(reconResult.status).toBe('FAILED');
      expect(reconResult.actionTaken).toBe('FAILED');

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('FAILED');
      expect(finalRow?.remote_void_status).toBe('CONFIRMED');

      // Reservation released once
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);

      // Never captured!
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();

      // Authorization voided remotely
      expect(mockAuthorizationsService.voidAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorizationId: testAuthId,
          requestId,
        })
      );
    });
  });

  // ============================================================================
  // 5. FIX 2: Durable Remote Void Recovery Tests
  // ============================================================================

  describe('5. FIX 2: Durable Remote Void Recovery (PENDING/CONFIRMED/FAILED tracking)', () => {
    it('successful remote void immediately returns HTTP 200 and marks CONFIRMED', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'VOID' });

      const res = await fetch(`${baseUrl}/a/${mintRes.rawToken!}/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res.status).toBe(200);
      const data = await res.json() as { status: string; remoteVoidStatus: string };
      expect(data.status).toBe('VOIDED');
      expect(data.remoteVoidStatus).toBe('CONFIRMED');

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('VOIDED');
      expect(finalRow?.remote_void_status).toBe('CONFIRMED');

      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);
    });

    it('network timeout on remote void returns HTTP 202 and sets remote_void_status to PENDING', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'VOID' });

      const timeoutError = new PayPalHttpError({
        code: 'NETWORK',
        message: 'Network connection lost during void call',
      });
      (mockAuthorizationsService.voidAuthorization as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        timeoutError
      );

      const res = await fetch(`${baseUrl}/a/${mintRes.rawToken!}/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res.status).toBe(202);
      const data = await res.json() as { status: string; remoteVoidStatus: string; reconciliationRequired: boolean };
      expect(data.status).toBe('VOIDED');
      expect(data.remoteVoidStatus).toBe('PENDING');
      expect(data.reconciliationRequired).toBe(true);

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('VOIDED');
      expect(finalRow?.remote_void_status).toBe('PENDING');

      // Local budget was released immediately
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);
    });

    it('discovers PENDING void and reconciles to CONFIRMED when remote auth is already VOIDED', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const nowIso = new Date().toISOString();
      repos.paymentRequests.updateStatusAndDecision(requestId, {
        status: 'VOIDED',
        updatedAt: nowIso,
      });
      repos.paymentRequests.updateRemoteVoidStatus(requestId, 'PENDING', nowIso);
      repos.ledger.insert({
        id: `led-release-${requestId}`,
        request_id: requestId,
        kind: 'RELEASE',
        amount_minor: toMinorUnits(2500),
        currency: 'USD',
        created_at: nowIso,
      });

      // Discovery query includes this request
      const list = repos.paymentRequests.listNeedingReconciliation();
      expect(list.map((r) => r.id)).toContain(requestId);

      // Remote auth lookup reports VOIDED
      (mockAuthorizationsService.getAuthorization as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: testAuthId,
        status: 'VOIDED',
        amountMinor: 2500,
        currency: 'USD',
        isVoided: true,
      });

      const reconResult = await reconcilePaymentRequest(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(reconResult.reconciled).toBe(true);
      expect(reconResult.actionTaken).toBe('VOIDED');

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.remote_void_status).toBe('CONFIRMED');

      // Ledger has exactly 1 RELEASE (no duplicate releases)
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(1);
    });

    it('discovers PENDING void and successfully retries void when remote auth is CREATED', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const nowIso = new Date().toISOString();
      repos.paymentRequests.updateStatusAndDecision(requestId, {
        status: 'VOIDED',
        updatedAt: nowIso,
      });
      repos.paymentRequests.updateRemoteVoidStatus(requestId, 'PENDING', nowIso);
      repos.ledger.insert({
        id: `led-release-${requestId}`,
        request_id: requestId,
        kind: 'RELEASE',
        amount_minor: toMinorUnits(2500),
        currency: 'USD',
        created_at: nowIso,
      });

      (mockAuthorizationsService.getAuthorization as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: testAuthId,
        status: 'CREATED',
        amountMinor: 2500,
        currency: 'USD',
        isCapturable: true,
      });

      const reconResult = await reconcilePaymentRequest(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(reconResult.reconciled).toBe(true);
      expect(reconResult.actionTaken).toBe('VOIDED');

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.remote_void_status).toBe('CONFIRMED');

      expect(mockAuthorizationsService.voidAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorizationId: testAuthId,
          requestId,
        })
      );
    });

    it('missing authorization ID sets remote_void_status to FAILED and returns HTTP 202', async () => {
      const { requestId } = seedHeldPaymentRequest();
      // Clear authorization ID directly in SQLite
      db.prepare('UPDATE payment_requests SET paypal_authorization_id = NULL WHERE id = ?').run(requestId);
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'VOID' });

      const res = await fetch(`${baseUrl}/a/${mintRes.rawToken!}/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res.status).toBe(202);
      const data = await res.json() as { remoteVoidStatus: string; reconciliationRequired: boolean };
      expect(data.remoteVoidStatus).toBe('FAILED');
      expect(data.reconciliationRequired).toBe(true);

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.remote_void_status).toBe('FAILED');

      // Reconciler discovers FAILED status for operator visibility but never marks CONFIRMED
      const list = repos.paymentRequests.listNeedingReconciliation();
      expect(list.map((r) => r.id)).toContain(requestId);

      const reconResult = await reconcilePaymentRequest(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });
      expect(reconResult.isUnresolved).toBe(true);
      expect(reconResult.resolved).toBe(false);
    });

    it('executeDecision strictly refuses to capture a locally VOIDED request (NO_OP)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      repos.paymentRequests.updateStatusAndDecision(requestId, {
        status: 'VOIDED',
      });

      const execution = await executeDecision(
        { requestId },
        {
          db,
          repos,
          authorizationsService: mockAuthorizationsService,
        }
      );

      expect(execution.executedAction).toBe('NO_OP');
      expect(execution.executed).toBe(false);
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
    });

    it('repeated reconciliation cycles on FAILED void missing authId do not create duplicate audit entries while remaining discoverable', async () => {
      const { requestId } = seedHeldPaymentRequest();
      db.prepare('UPDATE payment_requests SET paypal_authorization_id = NULL WHERE id = ?').run(requestId);
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'VOID' });

      // Owner executes void via HTTP endpoint
      const res = await fetch(`${baseUrl}/a/${mintRes.rawToken!}/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });
      expect(res.status).toBe(202);

      // Verify initial transition to FAILED logged exactly one PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID
      const initialLogs = repos.auditLog.listByRequestId(requestId);
      const initialUnresolved = initialLogs.filter((l) => l.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID');
      expect(initialUnresolved).toHaveLength(1);

      // Verify request is discoverable by reconciliation
      const initialDiscovery = repos.paymentRequests.listNeedingReconciliation();
      expect(initialDiscovery.map((r) => r.id)).toContain(requestId);

      // Simulate 3 consecutive reconciliation cycles (e.g. periodic ReconcilerWorker ticks)
      for (let tick = 1; tick <= 3; tick++) {
        const batchResult = await reconcilePendingRequests(db, {
          repos,
          authorizationsService: mockAuthorizationsService,
        });

        const targetResult = batchResult.results.find((r) => r.requestId === requestId);
        expect(targetResult).toBeDefined();
        expect(targetResult?.isUnresolved).toBe(true);
        expect(targetResult?.reconciled).toBe(false);
        expect(targetResult?.actionTaken).toBe('NO_OP');

        // Request MUST remain discoverable on every subsequent cycle
        const ongoingDiscovery = repos.paymentRequests.listNeedingReconciliation();
        expect(ongoingDiscovery.map((r) => r.id)).toContain(requestId);

        // Ensure audit log has NOT grown with duplicate entries
        const currentLogs = repos.auditLog.listByRequestId(requestId);
        const currentUnresolved = currentLogs.filter((l) => l.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID');
        expect(currentUnresolved).toHaveLength(1);
      }

      // Durable status preserved
      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('VOIDED');
      expect(finalRow?.remote_void_status).toBe('FAILED');
    });

    it('reconciliation transitions PENDING void missing authId to FAILED with exactly one audit entry across repeated ticks', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const nowIso = new Date().toISOString();
      db.prepare('UPDATE payment_requests SET paypal_authorization_id = NULL WHERE id = ?').run(requestId);
      repos.paymentRequests.updateStatusAndDecision(requestId, {
        status: 'VOIDED',
        updatedAt: nowIso,
      });
      repos.paymentRequests.updateRemoteVoidStatus(requestId, 'PENDING', nowIso);

      // Zero audit entries for PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID prior to reconciler
      expect(
        repos.auditLog.listByRequestId(requestId).filter((l) => l.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID')
      ).toHaveLength(0);

      // Tick 1: Reconciler discovers PENDING and transitions to FAILED, creating first audit entry
      const tick1Result = await reconcilePaymentRequest(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });
      expect(tick1Result.isUnresolved).toBe(true);

      const afterTick1Row = repos.paymentRequests.getById(requestId);
      expect(afterTick1Row?.remote_void_status).toBe('FAILED');

      const tick1Logs = repos.auditLog.listByRequestId(requestId).filter((l) => l.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID');
      expect(tick1Logs).toHaveLength(1);

      // Tick 2 & 3: Repeated ticks must not create duplicate audit entries
      for (let i = 2; i <= 3; i++) {
        const tickResult = await reconcilePaymentRequest(db, requestId, {
          repos,
          authorizationsService: mockAuthorizationsService,
        });
        expect(tickResult.isUnresolved).toBe(true);

        const subsequentLogs = repos.auditLog.listByRequestId(requestId).filter((l) => l.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID');
        expect(subsequentLogs).toHaveLength(1);

        // Still discoverable
        expect(repos.paymentRequests.listNeedingReconciliation().map((r) => r.id)).toContain(requestId);
      }
    });

    it('subsequent new condition on FAILED void produces new distinct audit event', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const nowIso = new Date().toISOString();
      db.prepare('UPDATE payment_requests SET paypal_authorization_id = NULL WHERE id = ?').run(requestId);
      repos.paymentRequests.updateStatusAndDecision(requestId, {
        status: 'VOIDED',
        updatedAt: nowIso,
      });
      repos.paymentRequests.updateRemoteVoidStatus(requestId, 'FAILED', nowIso);

      // Tick 1: Reconciler runs on missing authId, creates exactly one unresolved audit entry
      await reconcilePaymentRequest(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });
      expect(
        repos.auditLog.listByRequestId(requestId).filter((l) => l.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID')
      ).toHaveLength(1);

      // Genuinely new condition: Operator attaches authorization ID and remote PayPal state is found to be VOIDED
      db.prepare('UPDATE payment_requests SET paypal_authorization_id = ? WHERE id = ?').run(testAuthId, requestId);
      (mockAuthorizationsService.getAuthorization as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: testAuthId,
        status: 'VOIDED',
        amountMinor: 2500,
        currency: 'USD',
        isVoided: true,
      });

      // Next reconciliation tick should detect new condition and write PAYPAL_VOID_RECONCILED
      const newResult = await reconcilePaymentRequest(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });
      expect(newResult.reconciled).toBe(true);
      expect(newResult.actionTaken).toBe('VOIDED');

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.remote_void_status).toBe('CONFIRMED');

      const allLogs = repos.auditLog.listByRequestId(requestId);
      expect(allLogs.filter((l) => l.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID')).toHaveLength(1);
      expect(allLogs.filter((l) => l.event === 'PAYPAL_VOID_RECONCILED')).toHaveLength(1);

      // Once CONFIRMED, request is no longer returned in listNeedingReconciliation
      expect(repos.paymentRequests.listNeedingReconciliation().map((r) => r.id)).not.toContain(requestId);
    });
  });
});
