/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3 Subtask 3.1: Shared ApprovalExecutionService Integration Tests
 *
 * Verifies:
 * 1. Single instantiation in application composition root (createPayGuardMcpServer).
 * 2. Injection of the shared service into createApprovalsRouter and createTelegramRouter.
 * 3. Delegation of POST /a/:token/approve to approvalExecutionService.execute().
 * 4. Delegation of POST /a/:token/void to approvalExecutionService.execute().
 * 5. Preservation of authentication (401), CSRF (403), and input validation (400).
 * 6. Preservation of HTTP response status codes: 200, 202, 400, 409, 410, 500.
 * 7. Verification of createApprovalsRouter export alias in src/approvals/routes.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { OwnerSessionStore, OWNER_COOKIE_NAME } from '../../src/auth/owner.js';
import {
  ApprovalExecutionService,
  ApprovalValidationError,
  type ExecuteApprovalRequest,
  type ApprovalExecutionOutcome,
} from '../../src/approvals/service.js';
import {
  createApprovalRouter,
  createApprovalsRouter,
} from '../../src/approvals/routes.js';
import { createTelegramRouter } from '../../src/telegram/routes.js';
import { createPayGuardMcpServer } from '../../src/mcp/server.js';
import { loadConfig, type PayGuardConfig } from '../../src/config/index.js';

describe('M6-T3 Subtask 3.1: Shared ApprovalExecutionService Integration', () => {
  let db: Database;
  let repos: Repositories;
  let sessionStore: OwnerSessionStore;
  let server: Server;
  let baseUrl = '';

  let validOwnerToken = '';
  let validCsrfToken = '';
  const testOwnerId = 'default';
  const testDisplayName = 'Security Admin';

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);

    repos.owners.upsert({
      id: testOwnerId,
      display_name: testDisplayName,
      passphrase_hash: 'test-hash',
      telegram_chat_id: null,
      created_at: new Date().toISOString(),
    });

    sessionStore = new OwnerSessionStore({ db, repos });

    // Create active owner session
    const session = sessionStore.createSession({ id: testOwnerId, displayName: testDisplayName });
    validOwnerToken = session.rawSessionToken;
    validCsrfToken = session.csrfToken;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    db.close();
  });

  // ============================================================================
  // 1. Composition Root Wiring & Service Sharing
  // ============================================================================

  describe('Composition Root Wiring (src/mcp/server.ts)', () => {
    it('instantiates ApprovalExecutionService exactly once by default and exposes it', () => {
      const config: PayGuardConfig = loadConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'test-session-secret-at-least-32-chars-long-12345',
        TELEGRAM_MODE: 'disabled',
      });

      const serverInstance = createPayGuardMcpServer({
        db,
        repos,
        config,
        ownerSessionStore: sessionStore,
        secureCookie: false,
      });

      expect(serverInstance.approvalExecutionService).toBeDefined();
      expect(serverInstance.approvalExecutionService).toBeInstanceOf(ApprovalExecutionService);
    });

    it('uses injected ApprovalExecutionService when provided in McpServerOptions', () => {
      const config: PayGuardConfig = loadConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'test-session-secret-at-least-32-chars-long-12345',
        TELEGRAM_MODE: 'disabled',
      });

      const customService = new ApprovalExecutionService({ db, repos });

      const serverInstance = createPayGuardMcpServer({
        db,
        repos,
        config,
        ownerSessionStore: sessionStore,
        approvalExecutionService: customService,
        secureCookie: false,
      });

      expect(serverInstance.approvalExecutionService).toBe(customService);
    });

    it('exports createApprovalsRouter as an alias for createApprovalRouter', () => {
      expect(createApprovalsRouter).toBeDefined();
      expect(createApprovalsRouter).toBe(createApprovalRouter);
    });

    it('allows createTelegramRouter to receive injected approvalExecutionService', () => {
      const customService = new ApprovalExecutionService({ db, repos });
      const router = createTelegramRouter({
        db,
        repos,
        sessionStore,
        approvalExecutionService: customService,
      });

      expect(router).toBeDefined();
    });
  });

  // ============================================================================
  // 2. Dashboard POST /a/:token/approve Delegation
  // ============================================================================

  describe('POST /a/:token/approve Delegation & Contracts', () => {
    let mockExecutionService: ApprovalExecutionService;
    let executeSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      mockExecutionService = new ApprovalExecutionService({ db, repos });
      executeSpy = vi.fn();
      mockExecutionService.execute = executeSpy;

      const app: Express = express();
      app.use(express.json());

      const approvalRouter = createApprovalRouter({
        db,
        repos,
        sessionStore,
        approvalExecutionService: mockExecutionService,
      });
      app.use('/a', approvalRouter);

      server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await fetch(`${baseUrl}/a/tok-test-123/approve`, {
        method: 'POST',
        headers: {
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('Authentication required');
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('rejects missing or invalid CSRF token with 403', async () => {
      const res = await fetch(`${baseUrl}/a/tok-test-123/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': 'wrong-csrf-token',
        },
      });

      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('CSRF token missing or invalid');
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('delegates to approvalExecutionService.execute with APPROVE action and credentials', async () => {
      const rawToken = 'tok-approve-web-sample';
      const outcome: ApprovalExecutionOutcome = {
        success: true,
        action: 'APPROVE',
        requestId: 'req-001',
        status: 'CAPTURED',
        captureId: 'CAP-PAYPAL-999',
        executedAction: 'CAPTURED_APPROVED',
      };
      executeSpy.mockResolvedValueOnce(outcome);

      const res = await fetch(`${baseUrl}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        requestId: string;
        status: string;
        executedAction: string;
        captureId: string;
      };
      expect(data).toEqual({
        success: true,
        requestId: 'req-001',
        status: 'CAPTURED',
        executedAction: 'CAPTURED_APPROVED',
        captureId: 'CAP-PAYPAL-999',
      });

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const callArg = executeSpy.mock.calls[0]![0] as ExecuteApprovalRequest;
      expect(callArg.action).toBe('APPROVE');
      expect(callArg.credentials).toEqual({
        channel: 'web',
        rawToken,
        ownerId: testOwnerId,
        ownerDisplayName: testDisplayName,
      });
    });

    it('handles ambiguous capture outcome with HTTP 202', async () => {
      const outcome: ApprovalExecutionOutcome = {
        success: false,
        action: 'APPROVE',
        requestId: 'req-ambig',
        status: 'CAPTURING',
        error: 'AMBIGUOUS_EXECUTION',
        reconciliationRequired: true,
        message: 'PayPal network timeout during capture',
      };
      executeSpy.mockResolvedValueOnce(outcome);

      const res = await fetch(`${baseUrl}/a/tok-ambig/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(202);
      const data = (await res.json()) as {
        success: boolean;
        status: string;
        error: string;
        message: string;
        requestId: string;
        reconciliationRequired: boolean;
      };
      expect(data).toEqual({
        success: false,
        status: 'CAPTURING',
        error: 'AMBIGUOUS_EXECUTION',
        message: 'PayPal network timeout during capture',
        requestId: 'req-ambig',
        reconciliationRequired: true,
      });
    });

    it('handles definitive execution failure with HTTP 500', async () => {
      const outcome: ApprovalExecutionOutcome = {
        success: false,
        action: 'APPROVE',
        requestId: 'req-failed',
        status: 'FAILED',
        error: 'PAYMENT_DENIED',
        message: 'Authorization expired at PayPal',
      };
      executeSpy.mockResolvedValueOnce(outcome);

      const res = await fetch(`${baseUrl}/a/tok-fail/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(500);
      const data = (await res.json()) as {
        success: boolean;
        status: string;
        error: string;
        message: string;
      };
      expect(data).toEqual({
        success: false,
        status: 'FAILED',
        error: 'PAYMENT_DENIED',
        message: 'Authorization expired at PayPal',
      });
    });

    it('maps ApprovalValidationError TOKEN_ALREADY_USED to HTTP 409', async () => {
      executeSpy.mockRejectedValueOnce(
        new ApprovalValidationError('TOKEN_ALREADY_USED', 'Token has already been consumed', 409)
      );

      const res = await fetch(`${baseUrl}/a/tok-used/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(409);
      const data = (await res.json()) as { success: boolean; error: string; message: string };
      expect(data).toEqual({
        success: false,
        error: 'TOKEN_ALREADY_USED',
        message: 'Token has already been consumed',
      });
    });

    it('maps ApprovalValidationError TOKEN_EXPIRED to HTTP 410', async () => {
      executeSpy.mockRejectedValueOnce(
        new ApprovalValidationError('TOKEN_EXPIRED', 'Approval token has expired', 410)
      );

      const res = await fetch(`${baseUrl}/a/tok-exp/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(410);
      const data = (await res.json()) as { success: boolean; error: string; message: string };
      expect(data).toEqual({
        success: false,
        error: 'TOKEN_EXPIRED',
        message: 'Approval token has expired',
      });
    });

    it('maps ApprovalValidationError ACTION_MISMATCH to HTTP 400', async () => {
      executeSpy.mockRejectedValueOnce(
        new ApprovalValidationError('ACTION_MISMATCH', 'Token is bound to VOID', 400)
      );

      const res = await fetch(`${baseUrl}/a/tok-mismatch/approve`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { success: boolean; error: string; message: string };
      expect(data).toEqual({
        success: false,
        error: 'ACTION_MISMATCH',
        message: 'Token is bound to VOID',
      });
    });
  });

  // ============================================================================
  // 3. Dashboard POST /a/:token/void Delegation
  // ============================================================================

  describe('POST /a/:token/void Delegation & Contracts', () => {
    let mockExecutionService: ApprovalExecutionService;
    let executeSpy: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      mockExecutionService = new ApprovalExecutionService({ db, repos });
      executeSpy = vi.fn();
      mockExecutionService.execute = executeSpy;

      const app: Express = express();
      app.use(express.json());

      const approvalRouter = createApprovalRouter({
        db,
        repos,
        sessionStore,
        approvalExecutionService: mockExecutionService,
      });
      app.use('/a', approvalRouter);

      server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    it('delegates to approvalExecutionService.execute with VOID action and credentials', async () => {
      const rawToken = 'tok-void-web-sample';
      const outcome: ApprovalExecutionOutcome = {
        success: true,
        action: 'VOID',
        requestId: 'req-void-001',
        status: 'VOIDED',
        remoteVoidStatus: 'CONFIRMED',
        remoteVoidSuccess: true,
      };
      executeSpy.mockResolvedValueOnce(outcome);

      const res = await fetch(`${baseUrl}/a/${rawToken}/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        requestId: string;
        status: string;
        remoteVoidStatus: string;
        remoteVoidSuccess: boolean;
      };
      expect(data).toEqual({
        success: true,
        requestId: 'req-void-001',
        status: 'VOIDED',
        remoteVoidStatus: 'CONFIRMED',
        remoteVoidSuccess: true,
      });

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const callArg = executeSpy.mock.calls[0]![0] as ExecuteApprovalRequest;
      expect(callArg.action).toBe('VOID');
      expect(callArg.credentials).toEqual({
        channel: 'web',
        rawToken,
        ownerId: testOwnerId,
        ownerDisplayName: testDisplayName,
      });
    });

    it('handles remote void pending retry with HTTP 202', async () => {
      const outcome: ApprovalExecutionOutcome = {
        success: true,
        action: 'VOID',
        requestId: 'req-void-pending',
        status: 'VOIDED',
        remoteVoidStatus: 'PENDING',
        remoteVoidSuccess: false,
        reconciliationRequired: true,
        message: 'Local void committed; remote PayPal cancellation is pending retry',
      };
      executeSpy.mockResolvedValueOnce(outcome);

      const res = await fetch(`${baseUrl}/a/tok-void-p/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(202);
      const data = (await res.json()) as {
        success: boolean;
        requestId: string;
        status: string;
        remoteVoidStatus: string;
        remoteVoidSuccess: boolean;
        reconciliationRequired: boolean;
        message: string;
      };
      expect(data).toEqual({
        success: true,
        requestId: 'req-void-pending',
        status: 'VOIDED',
        remoteVoidStatus: 'PENDING',
        remoteVoidSuccess: false,
        reconciliationRequired: true,
        message: 'Local void committed; remote PayPal cancellation is pending retry',
      });
    });

    it('handles remote void failed (missing authId) with HTTP 202', async () => {
      const outcome: ApprovalExecutionOutcome = {
        success: true,
        action: 'VOID',
        requestId: 'req-void-no-auth',
        status: 'VOIDED',
        remoteVoidStatus: 'FAILED',
        remoteVoidSuccess: false,
        reconciliationRequired: true,
        message: 'Local void committed, but remote cancellation failed: missing paypal_authorization_id',
      };
      executeSpy.mockResolvedValueOnce(outcome);

      const res = await fetch(`${baseUrl}/a/tok-void-no-auth/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(202);
      const data = (await res.json()) as {
        success: boolean;
        requestId: string;
        status: string;
        remoteVoidStatus: string;
        remoteVoidSuccess: boolean;
        reconciliationRequired: boolean;
        message: string;
      };
      expect(data).toEqual({
        success: true,
        requestId: 'req-void-no-auth',
        status: 'VOIDED',
        remoteVoidStatus: 'FAILED',
        remoteVoidSuccess: false,
        reconciliationRequired: true,
        message: 'Local void committed, but remote cancellation failed: missing paypal_authorization_id',
      });
    });

    it('maps ApprovalValidationError HOLD_EXPIRED to HTTP 410', async () => {
      executeSpy.mockRejectedValueOnce(
        new ApprovalValidationError('HOLD_EXPIRED', 'Payment hold has expired', 410)
      );

      const res = await fetch(`${baseUrl}/a/tok-hold-exp/void`, {
        method: 'POST',
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
          'x-csrf-token': validCsrfToken,
        },
      });

      expect(res.status).toBe(410);
      const data = (await res.json()) as { success: boolean; error: string; message: string };
      expect(data).toEqual({
        success: false,
        error: 'HOLD_EXPIRED',
        message: 'Payment hold has expired',
      });
    });
  });

  // ============================================================================
  // 4. Dashboard API (/api/requests/:id/approve & /void) Shared Wiring (M6-T5)
  // ============================================================================

  describe('Dashboard Owner API Delegation via Composition Root (src/mcp/server.ts)', () => {
    it('routes POST /api/requests/:id/approve and POST /api/requests/:id/void through shared ApprovalExecutionService', async () => {
      const config: PayGuardConfig = loadConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'test-session-secret-at-least-32-chars-long-12345',
        TELEGRAM_MODE: 'disabled',
      });

      const sharedService = new ApprovalExecutionService({ db, repos });
      const executeSpy = vi.fn();
      sharedService.execute = executeSpy;

      const serverInstance = createPayGuardMcpServer({
        db,
        repos,
        config,
        ownerSessionStore: sessionStore,
        approvalExecutionService: sharedService,
        secureCookie: false,
      });

      const started = await serverInstance.start(0);
      try {
        executeSpy.mockResolvedValueOnce({
          success: true,
          action: 'APPROVE',
          requestId: 'req-dash-wired-1',
          status: 'CAPTURED',
          captureId: 'CAP-WIRED-1',
          executedAction: 'CAPTURED_APPROVED',
        } satisfies ApprovalExecutionOutcome);

        const approveRes = await fetch(
          `http://127.0.0.1:${started.port}/api/requests/req-dash-wired-1/approve`,
          {
            method: 'POST',
            headers: {
              Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
              'x-csrf-token': validCsrfToken,
            },
          }
        );

        expect(approveRes.status).toBe(200);
        expect(executeSpy).toHaveBeenCalledWith({
          action: 'APPROVE',
          credentials: {
            channel: 'dashboard',
            requestId: 'req-dash-wired-1',
            ownerId: testOwnerId,
            ownerDisplayName: testDisplayName,
          },
        });

        executeSpy.mockResolvedValueOnce({
          success: true,
          action: 'VOID',
          requestId: 'req-dash-wired-2',
          status: 'VOIDED',
          remoteVoidStatus: 'PENDING',
          remoteVoidSuccess: false,
          reconciliationRequired: true,
          message: 'Local void committed; remote cancellation pending reconciliation',
        } satisfies ApprovalExecutionOutcome);

        const voidRes = await fetch(
          `http://127.0.0.1:${started.port}/api/requests/req-dash-wired-2/void`,
          {
            method: 'POST',
            headers: {
              Cookie: `${OWNER_COOKIE_NAME}=${validOwnerToken}`,
              'x-csrf-token': validCsrfToken,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ reason: 'Dashboard wiring test reason' }),
          }
        );

        expect(voidRes.status).toBe(202);
        expect(executeSpy).toHaveBeenCalledWith({
          action: 'VOID',
          credentials: {
            channel: 'dashboard',
            requestId: 'req-dash-wired-2',
            ownerId: testOwnerId,
            ownerDisplayName: testDisplayName,
            reason: 'Dashboard wiring test reason',
          },
        });
      } finally {
        await started.close();
      }
    });
  });
});
