import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createDatabase,
  runMigrations,
  createRepositories,
  type Database,
} from '../../src/db/index.js';
import type { Repositories } from '../../src/db/repositories.js';
import { toMinorUnits } from '../../src/core/money.js';
import { computeSnapshotHash } from '../../src/core/service.js';
import { mintApprovalToken } from '../../src/approvals/tokens.js';
import {
  ApprovalExecutionService,
  ApprovalValidationError,
} from '../../src/approvals/service.js';
import type {
  PayPalAuthorizationsService,
  PayPalCaptureResult,
} from '../../src/paypal/authorizations.js';
import { AuthorizationError } from '../../src/paypal/authorizations.js';
import type { PayPalOrdersService } from '../../src/paypal/orders.js';

describe('M6-T3-D Subtask 2: Shared ApprovalExecutionService', () => {
  let db: Database;
  let repos: Repositories;

  const nowIso = new Date().toISOString();
  const futureIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const pastIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  // Mock PayPal services
  let mockAuthorizationsService: PayPalAuthorizationsService;
  let mockOrdersService: PayPalOrdersService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    // Setup owner
    repos.owners.upsert({
      id: 'default',
      display_name: 'Primary Owner',
      passphrase_hash: 'hash-abc',
      telegram_chat_id: '123456789',
      telegram_user_id: '987654321',
      created_at: nowIso,
    });
    repos.owners.linkTelegram({
      ownerId: 'default',
      chatId: '123456789',
      userId: '987654321',
      username: 'alice',
      linkedAtIso: nowIso,
    });

    // Setup agent
    repos.agents.insert({
      id: 'agent-1',
      name: 'Test Agent',
      api_key_hash: 'key-hash-1',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(1000),
      created_at: nowIso,
    });

    // Setup vendor
    repos.vendors.insert({
      id: 'vendor-1',
      name: 'Acme Corp',
      status: 'ACTIVE',
      categories: JSON.stringify(['saas']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'paypal_connector',
      created_at: nowIso,
    });

    // Setup base payment request in HELD state
    repos.paymentRequests.insert({
      id: 'req-001',
      agent_id: 'agent-1',
      idempotency_key: 'idem-001',
      vendor_id: 'vendor-1',
      amount_minor: toMinorUnits(50),
      currency: 'USD',
      purpose: 'API subscription',
      category: 'saas',
      source_context_excerpt: null,
      source_context_hash: null,
      status: 'HELD',
      decision: 'HOLD',
      reasons: JSON.stringify(['HIGH_AMOUNT']),
      policy_version_id: null,
      snapshot_hash: 'placeholder',
      paypal_order_id: null,
      paypal_authorization_id: 'auth-001',
      paypal_capture_id: null,
      expires_at: futureIso,
      created_at: nowIso,
      updated_at: nowIso,
    });

    // Set correct snapshot_hash
    const initialReq = repos.paymentRequests.getById('req-001')!;
    const correctSnapshot = computeSnapshotHash({
      requestId: initialReq.id,
      agentId: initialReq.agent_id,
      vendorId: initialReq.vendor_id,
      amountMinor: initialReq.amount_minor,
      currency: initialReq.currency,
      purpose: initialReq.purpose,
      category: initialReq.category,
    });
    db.prepare('UPDATE payment_requests SET snapshot_hash = ? WHERE id = ?').run(correctSnapshot, 'req-001');

    mockAuthorizationsService = {
      captureAuthorization: vi.fn().mockResolvedValue({
        id: 'cap-12345',
        status: 'COMPLETED',
        isCaptured: true,
        amountMinor: toMinorUnits(50),
        currency: 'USD',
        finalCapture: true,
      }),
      voidAuthorization: vi.fn().mockResolvedValue({
        id: 'auth-001',
        status: 'VOIDED',
        isVoided: true,
      }),
      getAuthorization: vi.fn(),
    } as unknown as PayPalAuthorizationsService;

    mockOrdersService = {
      createOrder: vi.fn(),
    } as unknown as PayPalOrdersService;
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
  });

  // Helper to create Telegram callback
  function createTelegramCallback(params: {
    requestId: string;
    action: 'APPROVE' | 'VOID';
    expiresAt?: string;
    telegramChatId?: string;
    telegramUserId?: string;
    linkedAt?: string;
  }) {
    const rawCallbackToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawCallbackToken).digest('hex');
    const req = repos.paymentRequests.getById(params.requestId)!;

    repos.telegramApprovalCallbacks.insert({
      token_hash: tokenHash,
      request_id: params.requestId,
      owner_id: 'default',
      action: params.action,
      telegram_chat_id: params.telegramChatId ?? '123456789',
      telegram_user_id: params.telegramUserId ?? '987654321',
      snapshot_hash: req.snapshot_hash!,
      expires_at: params.expiresAt ?? futureIso,
      linked_at: params.linkedAt ?? nowIso,
    });

    return { rawCallbackToken, tokenHash };
  }

  describe('1. Web & Telegram Channel Parity on APPROVE', () => {
    it('executes APPROVE from Web Dashboard and captures payment via executeDecision', async () => {
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
        ordersService: mockOrdersService,
      });

      // Mint web token
      const mintResult = mintApprovalToken(db, repos, {
        requestId: 'req-001',
        action: 'APPROVE',
        channel: 'web',
      });
      expect(mintResult.success).toBe(true);
      const rawToken = mintResult.rawToken!;

      // Execute via shared service
      const outcome = await service.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'web',
          rawToken,
          ownerId: 'default',
          ownerDisplayName: 'Owner Alice',
        },
      });

      expect(outcome.success).toBe(true);
      expect(outcome.action).toBe('APPROVE');
      expect(outcome.status).toBe('CAPTURED');
      if (outcome.status === 'CAPTURED') {
        expect(outcome.captureId).toBe('cap-12345');
        expect(outcome.executedAction).toBe('CAPTURED_APPROVED');
      }

      // Verify DB state
      const updatedReq = repos.paymentRequests.getById('req-001')!;
      expect(updatedReq.status).toBe('CAPTURED');
      expect(updatedReq.paypal_capture_id).toBe('cap-12345');

      // Verify token is marked used
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      expect(repos.approvals.getByTokenHash(tokenHash)?.used_at).toBeDefined();

      // Verify audit entry
      const auditLogs = repos.auditLog.listByRequestId('req-001');
      expect(auditLogs.some((a) => a.event === 'OWNER_APPROVED')).toBe(true);
      expect(auditLogs.some((a) => a.event === 'TRANSITION_TO_CAPTURED')).toBe(true);

      // Verify ledger has SPEND row
      const ledger = repos.ledger.listByRequestId('req-001');
      expect(ledger.some((l) => l.kind === 'SPEND')).toBe(true);
    });

    it('executes APPROVE from Telegram callback and captures payment via executeDecision', async () => {
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
        ordersService: mockOrdersService,
      });

      const { rawCallbackToken, tokenHash } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      // Execute via shared service
      const outcome = await service.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'telegram',
          rawCallbackToken,
          telegramUserId: '987654321',
          telegramChatId: '123456789',
        },
      });

      expect(outcome.success).toBe(true);
      expect(outcome.action).toBe('APPROVE');
      expect(outcome.status).toBe('CAPTURED');

      // Verify DB state
      const updatedReq = repos.paymentRequests.getById('req-001')!;
      expect(updatedReq.status).toBe('CAPTURED');

      // Verify callback token marked used
      expect(repos.telegramApprovalCallbacks.getByTokenHash(tokenHash)?.used_at).toBeDefined();

      // Verify captureAuthorization was called
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          authorizationId: 'auth-001',
          requestId: 'req-001',
        })
      );
    });
  });

  describe('2. Telegram Identity & Caller Verification', () => {
    it('rejects Telegram callback if telegramUserId does not match callback recipient', async () => {
      const service = new ApprovalExecutionService({ db, repos });
      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      await expect(
        service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken,
            telegramUserId: 'wrong-user-id',
            telegramChatId: '123456789',
          },
        })
      ).rejects.toThrowError(ApprovalValidationError);

      try {
        await service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken,
            telegramUserId: 'wrong-user-id',
            telegramChatId: '123456789',
          },
        });
      } catch (err: unknown) {
        expect((err as ApprovalValidationError).code).toBe('USER_MISMATCH');
        expect((err as ApprovalValidationError).statusCode).toBe(403);
      }
    });

    it('rejects Telegram callback if telegramChatId does not match callback recipient chat', async () => {
      const service = new ApprovalExecutionService({ db, repos });
      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      try {
        await service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken,
            telegramUserId: '987654321',
            telegramChatId: 'wrong-chat-id',
          },
        });
        expect.unreachable('Should have thrown CHAT_MISMATCH');
      } catch (err: unknown) {
        expect((err as ApprovalValidationError).code).toBe('CHAT_MISMATCH');
        expect((err as ApprovalValidationError).statusCode).toBe(403);
      }
    });

    it('rejects Telegram callback if owner unlinked after callback creation', async () => {
      const service = new ApprovalExecutionService({ db, repos });
      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      // Owner unlinks Telegram
      repos.owners.unlinkTelegram('default');

      try {
        await service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken,
            telegramUserId: '987654321',
            telegramChatId: '123456789',
          },
        });
        expect.unreachable('Should have thrown OWNER_UNLINKED');
      } catch (err: unknown) {
        expect((err as ApprovalValidationError).code).toBe('OWNER_UNLINKED');
        expect((err as ApprovalValidationError).statusCode).toBe(403);
      }
    });
  });

  describe('3. Expiry, Replay & Snapshot Validation', () => {
    it('rejects replayed token on second call (atomic CAS prevention)', async () => {
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      // First call succeeds
      const firstOutcome = await service.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'telegram',
          rawCallbackToken,
          telegramUserId: '987654321',
          telegramChatId: '123456789',
        },
      });
      expect(firstOutcome.success).toBe(true);

      // Second call (replay) fails
      try {
        await service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken,
            telegramUserId: '987654321',
            telegramChatId: '123456789',
          },
        });
        expect.unreachable('Should have rejected replay');
      } catch (err: unknown) {
        expect((err as ApprovalValidationError).code).toBe('TOKEN_ALREADY_USED');
        expect((err as ApprovalValidationError).statusCode).toBe(409);
      }
    });

    it('rejects expired callback token', async () => {
      const service = new ApprovalExecutionService({ db, repos });
      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
        expiresAt: pastIso, // Expired
      });

      try {
        await service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken,
            telegramUserId: '987654321',
            telegramChatId: '123456789',
          },
        });
        expect.unreachable('Should have thrown TOKEN_EXPIRED');
      } catch (err: unknown) {
        expect((err as ApprovalValidationError).code).toBe('TOKEN_EXPIRED');
        expect((err as ApprovalValidationError).statusCode).toBe(410);
      }
    });

    it('rejects action if snapshot_hash has been tampered with', async () => {
      const service = new ApprovalExecutionService({ db, repos });
      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      // Tamper with payment request amount
      db.prepare('UPDATE payment_requests SET amount_minor = 99999 WHERE id = ?').run('req-001');

      try {
        await service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken,
            telegramUserId: '987654321',
            telegramChatId: '123456789',
          },
        });
        expect.unreachable('Should have rejected tampered snapshot');
      } catch (err: unknown) {
        expect((err as ApprovalValidationError).code).toBe('SNAPSHOT_MISMATCH');
        expect((err as ApprovalValidationError).statusCode).toBe(400);
      }
    });
  });

  describe('4. Cross-Channel Sibling Invalidation', () => {
    it('invalidates both web token and sibling telegram callback when Telegram APPROVE is executed', async () => {
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      // Web approval token
      const webMint = mintApprovalToken(db, repos, {
        requestId: 'req-001',
        action: 'APPROVE',
        channel: 'web',
      });
      const webToken = webMint.rawToken!;
      const webTokenHash = crypto.createHash('sha256').update(webToken).digest('hex');

      // Telegram APPROVE callback
      const { rawCallbackToken: appToken, tokenHash: appHash } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      // Telegram VOID sibling callback
      const { rawCallbackToken: voidToken, tokenHash: voidHash } = createTelegramCallback({
        requestId: 'req-001',
        action: 'VOID',
      });

      // Approve via Telegram
      const outcome = await service.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'telegram',
          rawCallbackToken: appToken,
          telegramUserId: '987654321',
          telegramChatId: '123456789',
        },
      });
      expect(outcome.success).toBe(true);

      // 1. Telegram approve token is consumed
      expect(repos.telegramApprovalCallbacks.getByTokenHash(appHash)?.used_at).toBeDefined();

      // 2. Telegram void sibling callback is invalidated
      expect(repos.telegramApprovalCallbacks.getByTokenHash(voidHash)?.used_at).toBeDefined();

      // 3. Web approval token is invalidated
      expect(repos.approvals.getByTokenHash(webTokenHash)?.used_at).toBeDefined();

      // 4. Attempting to void via Telegram fails with TOKEN_ALREADY_USED
      try {
        await service.execute({
          action: 'VOID',
          credentials: {
            channel: 'telegram',
            rawCallbackToken: voidToken,
            telegramUserId: '987654321',
            telegramChatId: '123456789',
          },
        });
        expect.unreachable('Should have rejected already consumed callback');
      } catch (err: unknown) {
        expect((err as ApprovalValidationError).code).toBe('TOKEN_ALREADY_USED');
      }

      // 5. Attempting to approve via Web fails with TOKEN_ALREADY_USED
      try {
        await service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'web',
            rawToken: webToken,
          },
        });
        expect.unreachable('Should have rejected already used web token');
      } catch (err: unknown) {
        expect((err as ApprovalValidationError).code).toBe('TOKEN_ALREADY_USED');
      }
    });
  });

  describe('5. VOID Execution & Remote Status Handling', () => {
    it('executes VOID: releases budget reservation locally and marks remote CONFIRMED on PayPal success', async () => {
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'VOID',
      });

      const outcome = await service.execute({
        action: 'VOID',
        credentials: {
          channel: 'telegram',
          rawCallbackToken,
          telegramUserId: '987654321',
          telegramChatId: '123456789',
        },
      });

      expect(outcome.success).toBe(true);
      expect(outcome.action).toBe('VOID');
      expect(outcome.status).toBe('VOIDED');
      if (outcome.action === 'VOID') {
        expect(outcome.remoteVoidStatus).toBe('CONFIRMED');
        expect(outcome.remoteVoidSuccess).toBe(true);
      }

      // Verify DB state
      const updatedReq = repos.paymentRequests.getById('req-001')!;
      expect(updatedReq.status).toBe('VOIDED');
      expect(updatedReq.remote_void_status).toBe('CONFIRMED');

      // Verify RELEASE ledger row
      const ledger = repos.ledger.listByRequestId('req-001');
      expect(ledger.some((l) => l.kind === 'RELEASE')).toBe(true);

      // Verify notification outbox has PAYMENT_VOIDED with confirmed status
      const outbox = repos.notifications.listRecent(10);
      const voidedNotification = outbox.find((n) => n.event_type === 'PAYMENT_VOIDED')!;
      expect(voidedNotification).toBeDefined();
      expect(voidedNotification.message_text).toContain(
        'Payment voided locally. PayPal authorization cancellation confirmed.'
      );

      // Verify audit entries
      const audit = repos.auditLog.listByRequestId('req-001');
      expect(audit.some((a) => a.event === 'TRANSITION_TO_VOIDED')).toBe(true);
      expect(audit.some((a) => a.event === 'PAYPAL_VOID_CONFIRMED')).toBe(true);
    });

    it('handles definitive remote void failure (DECLINED) by updating remote_void_status to FAILED without reverting local void', async () => {
      mockAuthorizationsService.voidAuthorization = vi.fn().mockRejectedValue(
        new AuthorizationError('DECLINED', 'Authorization cannot be voided', { debugId: 'dbg-422' })
      );

      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'VOID',
      });

      const outcome = await service.execute({
        action: 'VOID',
        credentials: {
          channel: 'telegram',
          rawCallbackToken,
          telegramUserId: '987654321',
          telegramChatId: '123456789',
        },
      });

      expect(outcome.success).toBe(true);
      expect(outcome.status).toBe('VOIDED');
      if (outcome.action === 'VOID') {
        expect(outcome.remoteVoidStatus).toBe('FAILED');
        expect(outcome.remoteVoidSuccess).toBe(false);
        expect(outcome.reconciliationRequired).toBe(true);
      }

      // Local void is firmly committed and budget is released
      const req = repos.paymentRequests.getById('req-001')!;
      expect(req.status).toBe('VOIDED');
      expect(req.remote_void_status).toBe('FAILED');
      expect(repos.ledger.listByRequestId('req-001').some((l) => l.kind === 'RELEASE')).toBe(true);

      // Audit logged PAYPAL_VOID_FAILED
      expect(repos.auditLog.listByRequestId('req-001').some((a) => a.event === 'PAYPAL_VOID_FAILED')).toBe(true);

      // Verify notification outbox has PAYMENT_VOIDED with failed status
      const outbox = repos.notifications.listRecent(10);
      const voidedNotification = outbox.find((n) => n.event_type === 'PAYMENT_VOIDED')!;
      expect(voidedNotification).toBeDefined();
      expect(voidedNotification.message_text).toContain(
        'Payment voided locally and budget reservation released. PayPal cancellation failed and requires attention.'
      );
    });

    it('handles transient remote void failure (timeout/500) leaving remote_void_status as PENDING for reconciler', async () => {
      mockAuthorizationsService.voidAuthorization = vi.fn().mockRejectedValue(
        new Error('ETIMEDOUT: Connection timed out to PayPal')
      );

      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'VOID',
      });

      const outcome = await service.execute({
        action: 'VOID',
        credentials: {
          channel: 'telegram',
          rawCallbackToken,
          telegramUserId: '987654321',
          telegramChatId: '123456789',
        },
      });

      expect(outcome.success).toBe(true);
      expect(outcome.status).toBe('VOIDED');
      if (outcome.action === 'VOID') {
        expect(outcome.remoteVoidStatus).toBe('PENDING');
        expect(outcome.remoteVoidSuccess).toBe(false);
        expect(outcome.reconciliationRequired).toBe(true);
      }

      // Local void is firmly committed and budget is released
      const req = repos.paymentRequests.getById('req-001')!;
      expect(req.status).toBe('VOIDED');
      expect(req.remote_void_status).toBe('PENDING');

      // Audit logged PAYPAL_VOID_PENDING_RETRY
      expect(repos.auditLog.listByRequestId('req-001').some((a) => a.event === 'PAYPAL_VOID_PENDING_RETRY')).toBe(true);

      // Verify notification outbox has PAYMENT_VOIDED with pending status
      const outbox = repos.notifications.listRecent(10);
      const voidedNotification = outbox.find((n) => n.event_type === 'PAYMENT_VOIDED')!;
      expect(voidedNotification).toBeDefined();
      expect(voidedNotification.message_text).toContain(
        'Payment voided locally and budget reservation released. PayPal cancellation is pending reconciliation.'
      );
    });
  });

  describe('6. Execution Error & Ambiguous Outcome Handling', () => {
    it('handles ambiguous execution outcome from executeDecision gracefully', async () => {
      // Simulate timeout in executeDecision
      mockAuthorizationsService.captureAuthorization = vi.fn().mockRejectedValue(
        new Error('Socket hang up during capture')
      );

      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      const outcome = await service.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'telegram',
          rawCallbackToken,
          telegramUserId: '987654321',
          telegramChatId: '123456789',
        },
      });

      expect(outcome.success).toBe(false);
      expect(outcome.status).toBe('CAPTURING');
      if (outcome.status === 'CAPTURING') {
        expect(outcome.error).toBe('AMBIGUOUS_EXECUTION');
        expect(outcome.reconciliationRequired).toBe(true);
      }

      // Request remains CAPTURING in database awaiting reconciliation
      const req = repos.paymentRequests.getById('req-001')!;
      expect(req.status).toBe('CAPTURING');
    });

    it('handles definitive execution rejection from executeDecision', async () => {
      mockAuthorizationsService.captureAuthorization = vi.fn().mockRejectedValue(
        new AuthorizationError('DECLINED', 'Payment instrument declined by PayPal', { debugId: 'dbg-422' })
      );

      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      const outcome = await service.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'telegram',
          rawCallbackToken,
          telegramUserId: '987654321',
          telegramChatId: '123456789',
        },
      });

      expect(outcome.success).toBe(false);
      expect(outcome.status).toBe('FAILED');

      const req = repos.paymentRequests.getById('req-001')!;
      expect(req.status).toBe('FAILED');
    });
  });

  describe('7. Service-Level Concurrency', () => {
    it('concurrent APPROVE versus VOID: exactly one decision succeeds and ledger remains consistent', async () => {
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
        ordersService: mockOrdersService,
      });

      const { rawCallbackToken: appToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      const { rawCallbackToken: voidToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'VOID',
      });

      const [appResult, voidResult] = await Promise.allSettled([
        service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken: appToken,
            telegramUserId: '987654321',
            telegramChatId: '123456789',
          },
        }),
        service.execute({
          action: 'VOID',
          credentials: {
            channel: 'telegram',
            rawCallbackToken: voidToken,
            telegramUserId: '987654321',
            telegramChatId: '123456789',
          },
        }),
      ]);

      const isAppFulfilled = appResult.status === 'fulfilled';
      const isVoidFulfilled = voidResult.status === 'fulfilled';

      // Exactly ONE decision must succeed
      expect(Number(isAppFulfilled) + Number(isVoidFulfilled)).toBe(1);

      if (isAppFulfilled) {
        expect(voidResult.status).toBe('rejected');
        const err = (voidResult as PromiseRejectedResult).reason as ApprovalValidationError;
        expect(err).toBeInstanceOf(ApprovalValidationError);
        expect(['TOKEN_ALREADY_USED', 'INVALID_REQUEST_STATUS']).toContain(err.code);

        const req = repos.paymentRequests.getById('req-001')!;
        expect(req.status).toBe('CAPTURED');

        const ledger = repos.ledger.listByRequestId('req-001');
        expect(ledger.some((l) => l.kind === 'SPEND')).toBe(true);
        expect(ledger.some((l) => l.kind === 'RELEASE')).toBe(false);

        expect(mockAuthorizationsService.voidAuthorization).not.toHaveBeenCalled();
      } else {
        expect(appResult.status).toBe('rejected');
        const err = (appResult as PromiseRejectedResult).reason as ApprovalValidationError;
        expect(err).toBeInstanceOf(ApprovalValidationError);
        expect(['TOKEN_ALREADY_USED', 'INVALID_REQUEST_STATUS']).toContain(err.code);

        const req = repos.paymentRequests.getById('req-001')!;
        expect(req.status).toBe('VOIDED');

        const ledger = repos.ledger.listByRequestId('req-001');
        expect(ledger.some((l) => l.kind === 'RELEASE')).toBe(true);
        expect(ledger.some((l) => l.kind === 'SPEND')).toBe(false);

        expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
      }
    });

    it('concurrent duplicate APPROVE: exactly one succeeds and executeDecision is invoked at most once', async () => {
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
        ordersService: mockOrdersService,
      });

      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      const [res1, res2] = await Promise.allSettled([
        service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken,
            telegramUserId: '987654321',
            telegramChatId: '123456789',
          },
        }),
        service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken,
            telegramUserId: '987654321',
            telegramChatId: '123456789',
          },
        }),
      ]);

      const isFirstFulfilled = res1.status === 'fulfilled';
      const isSecondFulfilled = res2.status === 'fulfilled';

      expect(Number(isFirstFulfilled) + Number(isSecondFulfilled)).toBe(1);

      const rejectedResult = isFirstFulfilled
        ? (res2 as PromiseRejectedResult)
        : (res1 as PromiseRejectedResult);

      expect(rejectedResult.reason).toBeInstanceOf(ApprovalValidationError);
      expect(rejectedResult.reason.code).toBe('TOKEN_ALREADY_USED');

      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);
    });
  });

  describe('8. Transaction Rollback Invariants', () => {
    it('rolls back token consumption, payment status, and side effects if audit insertion fails', async () => {
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      const { rawCallbackToken, tokenHash } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      // Install real SQLite trigger to abort audit_log inserts
      db.exec(`
        CREATE TRIGGER test_fail_audit_insert
        BEFORE INSERT ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'Simulated SQLite audit insertion failure');
        END;
      `);

      try {
        await expect(
          service.execute({
            action: 'APPROVE',
            credentials: {
              channel: 'telegram',
              rawCallbackToken,
              telegramUserId: '987654321',
              telegramChatId: '123456789',
            },
          })
        ).rejects.toThrow(/Simulated SQLite audit insertion failure/);

        // 1. Token consumption rolled back: used_at is NULL
        const callbackRow = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
        expect(callbackRow?.used_at).toBeNull();

        // 2. Payment status remains HELD
        const reqRow = repos.paymentRequests.getById('req-001');
        expect(reqRow?.status).toBe('HELD');

        // 3. No ledger or outbox side effects
        const ledger = repos.ledger.listByRequestId('req-001');
        expect(ledger).toHaveLength(0);

        const outbox = repos.notifications.listRecent(10);
        expect(outbox.filter((n) => n.request_id === 'req-001')).toHaveLength(0);

        // 4. Remote PayPal capture was never invoked
        expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
      } finally {
        db.exec('DROP TRIGGER IF EXISTS test_fail_audit_insert');
      }
    });

    it('rolls back token consumption, payment status, and side effects if ledger insertion fails during VOID', async () => {
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      const { rawCallbackToken, tokenHash } = createTelegramCallback({
        requestId: 'req-001',
        action: 'VOID',
      });

      // Install real SQLite trigger to abort ledger inserts
      db.exec(`
        CREATE TRIGGER test_fail_ledger_insert
        BEFORE INSERT ON ledger
        BEGIN
          SELECT RAISE(ABORT, 'Simulated SQLite ledger insertion failure');
        END;
      `);

      try {
        await expect(
          service.execute({
            action: 'VOID',
            credentials: {
              channel: 'telegram',
              rawCallbackToken,
              telegramUserId: '987654321',
              telegramChatId: '123456789',
            },
          })
        ).rejects.toThrow(/Simulated SQLite ledger insertion failure/);

        // 1. Token consumption rolled back: used_at is NULL
        const callbackRow = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
        expect(callbackRow?.used_at).toBeNull();

        // 2. Payment status remains HELD
        const reqRow = repos.paymentRequests.getById('req-001');
        expect(reqRow?.status).toBe('HELD');

        // 3. No audit entry for VOID was written
        const audit = repos.auditLog.listByRequestId('req-001');
        expect(audit.some((a) => a.event === 'TRANSITION_TO_VOIDED')).toBe(false);

        // 4. No outbox notification
        const outbox = repos.notifications.listRecent(10);
        expect(outbox.filter((n) => n.request_id === 'req-001')).toHaveLength(0);

        // 5. Remote PayPal void was never invoked
        expect(mockAuthorizationsService.voidAuthorization).not.toHaveBeenCalled();
      } finally {
        db.exec('DROP TRIGGER IF EXISTS test_fail_ledger_insert');
      }
    });
  });

  describe('9. Stale Payment State Rejection', () => {
    it.each(['CAPTURED', 'VOIDED', 'FAILED'] as const)(
      'rejects execution against request in terminal status %s with INVALID_REQUEST_STATUS',
      async (terminalStatus) => {
        const service = new ApprovalExecutionService({
          db,
          repos,
          authorizationsService: mockAuthorizationsService,
        });

        // Pre-set request status to terminal state
        db.prepare('UPDATE payment_requests SET status = ? WHERE id = ?').run(
          terminalStatus,
          'req-001'
        );

        const { rawCallbackToken, tokenHash } = createTelegramCallback({
          requestId: 'req-001',
          action: 'APPROVE',
        });

        try {
          await service.execute({
            action: 'APPROVE',
            credentials: {
              channel: 'telegram',
              rawCallbackToken,
              telegramUserId: '987654321',
              telegramChatId: '123456789',
            },
          });
          expect.unreachable(`Should have rejected execution on status ${terminalStatus}`);
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(ApprovalValidationError);
          expect((err as ApprovalValidationError).code).toBe('INVALID_REQUEST_STATUS');
          expect((err as ApprovalValidationError).statusCode).toBe(400);
        }

        // 1. Verify token is NOT consumed
        const callbackRow = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
        expect(callbackRow?.used_at).toBeNull();

        // 2. Verify no ledger entries inserted
        const ledger = repos.ledger.listByRequestId('req-001');
        expect(ledger).toHaveLength(0);

        // 3. Verify no PayPal operation invoked
        expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
        expect(mockAuthorizationsService.voidAuthorization).not.toHaveBeenCalled();
      }
    );
  });

  describe('10. onClaimed Lifecycle Hook (Subtask 3.4.1)', () => {
    it('invokes onClaimed after Phase 1 commits, passing committed request, before Phase 2 executes', async () => {
      const order: string[] = [];
      let claimedRequestStatus = '';

      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      // Capture mock records execution
      mockAuthorizationsService.captureAuthorization = vi.fn(async () => {
        order.push('phase2_capture');
        return {
          id: 'CAP-999',
          status: 'COMPLETED',
          isCaptured: true,
        } as unknown as PayPalCaptureResult;
      });

      const outcome = await service.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'telegram',
          rawCallbackToken,
          telegramUserId: '987654321',
          telegramChatId: '123456789',
        },
        onClaimed: (req) => {
          order.push('onClaimed');
          claimedRequestStatus = req.status;
        },
      });

      expect(outcome.success).toBe(true);
      expect(order).toEqual(['onClaimed', 'phase2_capture']);
      // When onClaimed is called, Phase 1 has already transitioned request to APPROVED
      expect(claimedRequestStatus).toBe('APPROVED');
    });

    it('catches and isolates onClaimed hook error without reversing or blocking Phase 2', async () => {
      const warnLogs: string[] = [];
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
        logger: {
          warn: (msg) => warnLogs.push(msg),
        },
      });

      const { rawCallbackToken } = createTelegramCallback({
        requestId: 'req-001',
        action: 'APPROVE',
      });

      mockAuthorizationsService.captureAuthorization = vi.fn(async () => {
        return {
          id: 'CAP-888',
          status: 'COMPLETED',
          isCaptured: true,
        } as unknown as PayPalCaptureResult;
      });

      const outcome = await service.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'telegram',
          rawCallbackToken,
          telegramUserId: '987654321',
          telegramChatId: '123456789',
        },
        onClaimed: () => {
          throw new Error('Explosion inside onClaimed hook');
        },
      });

      expect(outcome.success).toBe(true);
      expect(outcome.status).toBe('CAPTURED');
      expect(warnLogs.length).toBe(1);
      expect(warnLogs[0]).toContain('onClaimed hook error');
      expect(warnLogs[0]).toContain('Explosion inside onClaimed hook');

      // Payment request in DB is CAPTURED
      const req = repos.paymentRequests.getById('req-001');
      expect(req?.status).toBe('CAPTURED');
    });

    it('does not invoke onClaimed if Phase 1 validation fails', async () => {
      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthorizationsService,
      });

      let onClaimedCalled = false;

      // Provide invalid token
      await expect(
        service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken: 'invalid-non-existent-token',
            telegramUserId: '987654321',
            telegramChatId: '123456789',
          },
          onClaimed: () => {
            onClaimedCalled = true;
          },
        })
      ).rejects.toThrow();

      expect(onClaimedCalled).toBe(false);
    });
  });
});
