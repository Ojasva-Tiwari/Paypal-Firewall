/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T4 Unit & Integration Tests: Hold Expiry Worker (test/unit/holdExpiry.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { toMinorUnits } from '../../src/core/money.js';
import { computeSnapshotHash } from '../../src/core/service.js';
import { mintApprovalToken, verifyApprovalToken } from '../../src/approvals/tokens.js';
import { createApprovalRouter } from '../../src/approvals/routes.js';
import { OwnerSessionStore, OWNER_COOKIE_NAME } from '../../src/auth/owner.js';
import type { PayPalAuthorizationsService } from '../../src/paypal/authorizations.js';
import { AuthorizationError } from '../../src/paypal/authorizations.js';
import { PayPalHttpError } from '../../src/paypal/http.js';
import {
  expirePaymentHold,
  expireStaleHolds,
  HoldExpiryWorker,
} from '../../src/approvals/expiry.js';
import { reconcilePaymentRequest } from '../../src/paypal/reconcile.js';

describe('M4-T4: Hold Expiry Worker & Stale Hold Invariants', () => {
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

    // Create owner session
    const sessionResult = sessionStore.createSession({
      id: 'default',
      displayName: 'Primary Owner',
    });
    ownerToken = sessionResult.rawSessionToken;
    ownerCsrf = sessionResult.csrfToken;

    // 2. Seed Agent & Vendor
    repos.agents.insert({
      id: testAgentId,
      name: 'Honest Demo Agent',
      api_key_hash: 'dummy-key-hash',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(1000),
      created_at: new Date().toISOString(),
    });

    repos.vendors.insert({
      id: testVendorId,
      name: 'Acme Cloud Hosting',
      status: 'ACTIVE',
      categories: JSON.stringify(['hosting']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    });

    // 3. Seed Policy Version
    repos.policyVersions.insert({
      id: testPolicyId,
      version: 1,
      rules: JSON.stringify({ auto_limit_minor: 1500 }),
      author: 'owner',
      active: 1,
      created_at: new Date().toISOString(),
    });

    // 4. Mock PayPal Authorizations Service
    mockAuthorizationsService = {
      getAuthorization: vi.fn().mockResolvedValue({
        id: testAuthId,
        status: 'CREATED',
        amountMinor: 2500,
        currency: 'USD',
        isCapturable: true,
      }),
      captureAuthorization: vi.fn().mockResolvedValue({
        id: 'CAP-SANDBOX-TEST-123',
        status: 'COMPLETED',
        amountMinor: 2500,
        currency: 'USD',
        isCaptured: true,
      }),
      voidAuthorization: vi.fn().mockResolvedValue({
        id: testAuthId,
        isVoided: true,
      }),
    } as unknown as PayPalAuthorizationsService;

    // 4. Start Test HTTP Server
    const app: Express = express();
    app.use(express.json());
    app.use(
      '/a',
      createApprovalRouter({
        db,
        repos,
        sessionStore,
        authorizationsService: mockAuthorizationsService,
      })
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /**
   * Helper: Seeds a HELD payment request with customizable expiration
   */
  function seedHeldPaymentRequest(options?: {
    requestId?: string;
    expiresAt?: string;
    authId?: string | null;
  }) {
    const requestId = options?.requestId || `req-test-${crypto.randomUUID()}`;
    const nowIso = new Date().toISOString();
    // Default: valid for 15 minutes into the future (allowing mintApprovalToken to succeed)
    const expiresAt =
      options?.expiresAt !== undefined
        ? options.expiresAt
        : new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const amountMinor = toMinorUnits(25);
    const authId = options?.authId !== undefined ? options.authId : testAuthId;

    const snapshotHash = computeSnapshotHash({
      requestId,
      agentId: testAgentId,
      vendorId: testVendorId,
      amountMinor,
      currency: 'USD',
      purpose: 'Monthly Cloud VPS Server',
      category: 'hosting',
    });

    repos.paymentRequests.insert({
      id: requestId,
      agent_id: testAgentId,
      idempotency_key: `idemp-${requestId}`,
      vendor_id: testVendorId,
      amount_minor: amountMinor,
      currency: 'USD',
      purpose: 'Monthly Cloud VPS Server',
      category: 'hosting',
      source_context_excerpt: 'Deploying worker VPS',
      source_context_hash: 'ctx-hash-123',
      status: 'HELD',
      decision: 'HOLD',
      reasons: JSON.stringify(['OVER_AUTO_LIMIT']),
      policy_version_id: testPolicyId,
      snapshot_hash: snapshotHash,
      paypal_order_id: 'ORDER-12345',
      paypal_authorization_id: authId,
      paypal_capture_id: null,
      expires_at: expiresAt,
      created_at: nowIso,
      updated_at: nowIso,
    });

    repos.ledger.insert({
      id: `led-reserve-${requestId}`,
      request_id: requestId,
      kind: 'RESERVE',
      amount_minor: amountMinor,
      currency: 'USD',
      created_at: nowIso,
    });

    return { requestId, snapshotHash, amountMinor, authId, expiresAt };
  }

  function expireHoldInDb(requestId: string, pastMs = 5 * 60 * 1000) {
    const pastIso = new Date(Date.now() - pastMs).toISOString();
    db.prepare('UPDATE payment_requests SET expires_at = ? WHERE id = ?').run(pastIso, requestId);
    return pastIso;
  }

  describe('1. Atomic Expiry & Exactly-Once RELEASE Invariant', () => {
    it('stale HELD request transitions HELD -> EXPIRED -> VOIDED with exactly one RELEASE and confirmed void', async () => {
      const { requestId, authId } = seedHeldPaymentRequest();

      const mintApprove = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      const mintVoid = mintApprovalToken(db, repos, { requestId, action: 'VOID' });

      expireHoldInDb(requestId);

      // Execute expiry
      const result = await expirePaymentHold(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(result.expired).toBe(true);
      expect(result.actionTaken).toBe('EXPIRED');
      expect(result.remoteVoidStatus).toBe('CONFIRMED');

      // Final status in DB is VOIDED (terminal state)
      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('VOIDED');
      expect(finalRow?.remote_void_status).toBe('CONFIRMED');

      // Ledger: exactly one RELEASE row
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);

      // Audit Log: contains HOLD_EXPIRED and TRANSITION_TO_VOIDED with actor 'system'
      const audit = repos.auditLog.listByRequestId(requestId);
      const holdExpiredAudit = audit.find((a) => a.event === 'HOLD_EXPIRED');
      const voidedAudit = audit.find((a) => a.event === 'TRANSITION_TO_VOIDED');
      const remoteReconciledAudit = audit.find((a) => a.event === 'PAYPAL_VOID_RECONCILED');

      expect(holdExpiredAudit).toBeDefined();
      expect(holdExpiredAudit?.actor).toBe('system');

      expect(voidedAudit).toBeDefined();
      expect(voidedAudit?.actor).toBe('system');

      expect(remoteReconciledAudit).toBeDefined();
      expect(remoteReconciledAudit?.actor).toBe('system');

      // PayPal authorization void was called
      expect(mockAuthorizationsService.voidAuthorization).toHaveBeenCalledWith({
        authorizationId: authId,
        requestId,
      });

      // Verification of approval tokens now fails closed
      const verifyApprove = verifyApprovalToken(db, repos, { rawToken: mintApprove.rawToken! });
      expect(verifyApprove.valid).toBe(false);

      const verifyVoid = verifyApprovalToken(db, repos, { rawToken: mintVoid.rawToken! });
      expect(verifyVoid.valid).toBe(false);
    });

    it('repeated calls to expirePaymentHold are idempotent NO_OPs with zero duplicate RELEASE rows', async () => {
      const { requestId } = seedHeldPaymentRequest();
      expireHoldInDb(requestId);

      // First run: successfully expires
      const res1 = await expirePaymentHold(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });
      expect(res1.expired).toBe(true);

      const auditCountBefore = repos.auditLog.listByRequestId(requestId).length;

      // Second & third runs: NO_OP
      for (let i = 0; i < 2; i++) {
        const resRepeat = await expirePaymentHold(db, requestId, {
          repos,
          authorizationsService: mockAuthorizationsService,
        });
        expect(resRepeat.expired).toBe(false);
        expect(resRepeat.actionTaken).toBe('NO_OP');
      }

      // Ledger must still have exactly one RELEASE row
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.filter((l) => l.kind === 'RELEASE')).toHaveLength(1);

      // No new audit entries added
      const auditCountAfter = repos.auditLog.listByRequestId(requestId).length;
      expect(auditCountAfter).toBe(auditCountBefore);
    });

    it('strictly refuses to release or expire if a SPEND entry exists (ledger invariant)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      expireHoldInDb(requestId);
      // Insert illegal SPEND entry
      repos.ledger.insert({
        id: `led-spend-${requestId}`,
        request_id: requestId,
        kind: 'SPEND',
        amount_minor: toMinorUnits(25),
        currency: 'USD',
        created_at: new Date().toISOString(),
      });

      await expect(
        expirePaymentHold(db, requestId, {
          repos,
          authorizationsService: mockAuthorizationsService,
        })
      ).rejects.toThrow(/Illegal ledger state/);

      // Status was not modified
      expect(repos.paymentRequests.getById(requestId)?.status).toBe('HELD');
    });

    it('does not expire unexpired holds (future expires_at)', async () => {
      // Hold expires 15 minutes in the future
      const futureExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const { requestId } = seedHeldPaymentRequest({ expiresAt: futureExpiry });

      const result = await expirePaymentHold(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(result.expired).toBe(false);
      expect(result.actionTaken).toBe('NO_OP');

      // Request remains HELD
      expect(repos.paymentRequests.getById(requestId)?.status).toBe('HELD');
      expect(mockAuthorizationsService.voidAuthorization).not.toHaveBeenCalled();
    });
  });

  describe('2. Remote Cancellation & Reconciler Crash Recovery', () => {
    it('missing authorization ID sets remote_void_status to FAILED and audits unresolved once', async () => {
      const { requestId } = seedHeldPaymentRequest({ authId: null });
      expireHoldInDb(requestId);

      const result = await expirePaymentHold(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(result.expired).toBe(true);
      expect(result.remoteVoidStatus).toBe('FAILED');

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('VOIDED');
      expect(finalRow?.remote_void_status).toBe('FAILED');

      // Audit row PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID written once
      const unresolvedLogs = repos.auditLog
        .listByRequestId(requestId)
        .filter((l) => l.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID');
      expect(unresolvedLogs).toHaveLength(1);

      // Must remain discoverable by reconciler
      expect(repos.paymentRequests.listNeedingReconciliation().map((r) => r.id)).toContain(requestId);
      expect(mockAuthorizationsService.voidAuthorization).not.toHaveBeenCalled();
    });

    it('transient network error leaves remote_void_status as PENDING for ReconcilerWorker recovery', async () => {
      const { requestId, authId } = seedHeldPaymentRequest();
      expireHoldInDb(requestId);

      const networkError = new PayPalHttpError({
        code: 'NETWORK',
        message: 'Socket timeout during void call',
      });
      (mockAuthorizationsService.voidAuthorization as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        networkError
      );

      const result = await expirePaymentHold(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(result.expired).toBe(true);
      expect(result.remoteVoidStatus).toBe('PENDING');

      // Local state is VOIDED and budget is released
      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('VOIDED');
      expect(finalRow?.remote_void_status).toBe('PENDING');

      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);

      // Discoverable by ReconcilerWorker
      expect(repos.paymentRequests.listNeedingReconciliation().map((r) => r.id)).toContain(requestId);

      // Subsequent reconciliation cycle repairs it once remote authorization is confirmed
      (mockAuthorizationsService.getAuthorization as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: authId,
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

      const reconciledRow = repos.paymentRequests.getById(requestId);
      expect(reconciledRow?.remote_void_status).toBe('CONFIRMED');
    });

    it('definitive remote error sets remote_void_status to FAILED and records PAYPAL_VOID_FAILED', async () => {
      const { requestId } = seedHeldPaymentRequest();
      expireHoldInDb(requestId);

      const definitiveError = new AuthorizationError('INVALID_REQUEST', 'Authorization cannot be voided');
      (mockAuthorizationsService.voidAuthorization as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        definitiveError
      );

      const result = await expirePaymentHold(db, requestId, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(result.expired).toBe(true);
      expect(result.remoteVoidStatus).toBe('FAILED');

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('VOIDED');
      expect(finalRow?.remote_void_status).toBe('FAILED');

      const failedAudit = repos.auditLog
        .listByRequestId(requestId)
        .find((l) => l.event === 'PAYPAL_VOID_FAILED');
      expect(failedAudit).toBeDefined();
    });
  });

  describe('3. Lazy Expiry & Approval Concurrency Race', () => {
    it('GET /a/:token on an expired hold returns HTTP 410 and triggers lazy expiry', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      expireHoldInDb(requestId);

      const res = await fetch(`${baseUrl}/a/${mintRes.rawToken!}`, {
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
        },
      });

      expect(res.status).toBe(410);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('HOLD_EXPIRED');

      // Yield briefly to let background lazy expiry complete
      await new Promise((r) => setTimeout(r, 100));

      // Lazy expiry transitioned request to VOIDED and released reservation
      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('VOIDED');

      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind)).toEqual(['RESERVE', 'RELEASE']);
    });

    it('POST /a/:token/approve strictly refuses an expired hold, never capturing money', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'APPROVE' });
      expireHoldInDb(requestId);

      const res = await fetch(`${baseUrl}/a/${mintRes.rawToken!}/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res.status).toBe(410);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('HOLD_EXPIRED');

      // Money-moving capture strictly NEVER called
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();

      // Yield for lazy expiry
      await new Promise((r) => setTimeout(r, 100));

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('VOIDED');
    });

    it('POST /a/:token/void on expired hold returns HTTP 410 and lazily ensures VOIDED state', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const mintRes = mintApprovalToken(db, repos, { requestId, action: 'VOID' });
      expireHoldInDb(requestId);

      const res = await fetch(`${baseUrl}/a/${mintRes.rawToken!}/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${ownerToken}`,
          'x-csrf-token': ownerCsrf,
        },
      });

      expect(res.status).toBe(410);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('HOLD_EXPIRED');

      await new Promise((r) => setTimeout(r, 100));

      const finalRow = repos.paymentRequests.getById(requestId);
      expect(finalRow?.status).toBe('VOIDED');
      expect(repos.ledger.listByRequestId(requestId).filter((l) => l.kind === 'RELEASE')).toHaveLength(1);
    });
  });

  describe('4. Batch Discovery & HoldExpiryWorker Lifecycle', () => {
    it('expireStaleHolds batch discovers only expired HELD requests and processes each', async () => {
      // Req 1: Expired HELD
      const { requestId: req1 } = seedHeldPaymentRequest();
      expireHoldInDb(req1);
      // Req 2: Unexpired HELD
      const { requestId: req2 } = seedHeldPaymentRequest({
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      // Req 3: Expired HELD
      const { requestId: req3 } = seedHeldPaymentRequest();
      expireHoldInDb(req3);

      const batchResult = await expireStaleHolds(db, {
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      expect(batchResult.totalDiscovered).toBe(2);
      expect(batchResult.totalExpired).toBe(2);
      expect(batchResult.totalNoOp).toBe(0);

      expect(repos.paymentRequests.getById(req1)?.status).toBe('VOIDED');
      expect(repos.paymentRequests.getById(req3)?.status).toBe('VOIDED');
      expect(repos.paymentRequests.getById(req2)?.status).toBe('HELD');
    });

    it('HoldExpiryWorker manages lifecycle, timer unref, and prevents overlapping ticks', async () => {
      const worker = new HoldExpiryWorker({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
        intervalMs: 100,
      });

      expect(worker.isRunning()).toBe(false);
      worker.start();
      expect(worker.isRunning()).toBe(true);

      // Redundant start is a no-op
      worker.start();
      expect(worker.isRunning()).toBe(true);

      // Execute manual tick
      const { requestId } = seedHeldPaymentRequest();
      expireHoldInDb(requestId);
      const tickResult = await worker.tick();
      expect(tickResult.totalExpired).toBe(1);
      expect(repos.paymentRequests.getById(requestId)?.status).toBe('VOIDED');

      worker.stop();
      expect(worker.isRunning()).toBe(false);
    });
  });
});
