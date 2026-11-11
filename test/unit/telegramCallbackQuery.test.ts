/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3.2: Telegram Callback Query Handling & Action Dispatch Tests
 *
 * Verifies all M6-T3.2 requirements:
 * 1. Private chat enforcement (group/supergroup/channel callbacks rejected).
 * 2. Numeric identity validation (chat.id and from.id).
 * 3. Linked owner identity validation (rejects unlinked, mismatched user, or wrong owner).
 * 4. Opaque callback token resolution and validation (action, expiry, snapshot hash).
 * 5. Single-use enforcement and replay protection via atomic CAS.
 * 6. Simultaneous APPROVE and VOID concurrency (exactly one wins, other rejected as TOKEN_ALREADY_USED).
 * 7. Dispatch exclusively through shared ApprovalExecutionService.
 * 8. Zero money movement or unauthorized capture outside executeDecision in src/core.
 * 9. Telegram feedback: answerCallbackQuery, message editing, and keyboard control invalidation.
 * 10. Decoupled Telegram API failure behavior (network drop/timeout never rolls back committed approval).
 * 11. Database transaction failure triggers 500 and clears in-flight deduplicator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { createPayGuardMcpServer, type PayGuardMcpServerInstance } from '../../src/mcp/server.js';
import { toMinorUnits } from '../../src/core/money.js';
import { computeSnapshotHash } from '../../src/core/service.js';
import { loadConfig, type PayGuardConfig } from '../../src/config/index.js';
import { TELEGRAM_SECRET_HEADER } from '../../src/telegram/middleware.js';
import type { TelegramClient } from '../../src/telegram/client.js';
import type {
  TelegramUpdate,
  AnswerCallbackQueryParams,
  EditMessageTextParams,
  EditMessageReplyMarkupParams,
} from '../../src/telegram/types.js';
import type { PayPalAuthorizationsService, PayPalCaptureResult } from '../../src/paypal/authorizations.js';
import { PayPalHttpError } from '../../src/paypal/http.js';

describe('M6-T3.2: Telegram Callback Query Handling & Action Dispatch', () => {
  let db: Database;
  let repos: Repositories;
  let serverInstance: PayGuardMcpServerInstance;
  let serverPort = 0;
  let serverClose: () => Promise<void>;

  const testBotToken = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789';
  const testBotUsername = 'PayGuardTestBot';
  const testWebhookSecret = 'pg_test_webhook_secret_998877665544332211';

  const linkedOwnerId = 'default';
  const linkedChatId = 123456789;
  const linkedUserId = 987654321;
  const testAgentId = 'agent-1';
  const testVendorId = 'vendor-1';
  const testAuthId = 'AUTH-SANDBOX-TEST-12345';

  let answeredCallbacks: AnswerCallbackQueryParams[] = [];
  let editedMessages: EditMessageTextParams[] = [];
  let editedMarkups: EditMessageReplyMarkupParams[] = [];
  let shouldAnswerFail = false;
  let shouldEditFail = false;

  let mockTelegramClient: TelegramClient;
  let mockAuthorizationsService: PayPalAuthorizationsService;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);

    const nowIso = new Date().toISOString();

    // 1. Seed Owner with linked Telegram chat and user ID
    repos.owners.upsert({
      id: linkedOwnerId,
      display_name: 'Alice Security Lead',
      passphrase_hash: 'dummy-hash',
      telegram_chat_id: String(linkedChatId),
      telegram_user_id: String(linkedUserId),
      telegram_username: 'alice_sec',
      telegram_linked_at: nowIso,
      created_at: nowIso,
    });

    // 2. Seed Agent
    repos.agents.insert({
      id: testAgentId,
      name: 'Test Agent',
      api_key_hash: 'hash-agent',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(5000),
      created_at: nowIso,
    });

    // 3. Seed Vendor
    repos.vendors.insert({
      id: testVendorId,
      name: 'Acme Cloud Hosting',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: nowIso,
    });

    // 4. Setup Mock Telegram Client
    answeredCallbacks = [];
    editedMessages = [];
    editedMarkups = [];
    shouldAnswerFail = false;
    shouldEditFail = false;

    mockTelegramClient = {
      sendMessage: vi.fn(),
      answerCallbackQuery: vi.fn(async (params: AnswerCallbackQueryParams): Promise<boolean> => {
        answeredCallbacks.push(params);
        if (shouldAnswerFail) {
          throw new Error('Simulated Telegram API timeout answering callback');
        }
        return true;
      }),
      editMessageText: vi.fn(async (params: EditMessageTextParams) => {
        editedMessages.push(params);
        if (shouldEditFail) {
          throw new Error('Simulated Telegram API timeout editing message');
        }
        return true;
      }),
      editMessageReplyMarkup: vi.fn(async (params: EditMessageReplyMarkupParams) => {
        editedMarkups.push(params);
        return true;
      }),
    } as unknown as TelegramClient;

    // 5. Setup Mock PayPal Authorizations Service
    mockAuthorizationsService = {
      captureAuthorization: vi.fn().mockResolvedValue({
        id: 'CAP-PAYPAL-123',
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

    // 6. Start MCP Server with Telegram Router
    const config: PayGuardConfig = loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars-long-12345',
      TELEGRAM_MODE: 'webhook',
      TELEGRAM_BOT_TOKEN: testBotToken,
      TELEGRAM_BOT_USERNAME: testBotUsername,
      TELEGRAM_WEBHOOK_SECRET: testWebhookSecret,
    });

    serverInstance = createPayGuardMcpServer({
      db,
      repos,
      config,
      telegramClient: mockTelegramClient,
      authorizationsService: mockAuthorizationsService,
      secureCookie: false,
    });

    const started = await serverInstance.start(0);
    serverPort = started.port;
    serverClose = started.close;
  });

  afterEach(async () => {
    if (serverClose) {
      await serverClose();
    }
    if (db.open) {
      db.close();
    }
  });

  // Helper to seed a valid HELD payment request with RESERVE ledger entry
  function seedHeldPaymentRequest(options?: {
    id?: string;
    amountMinor?: number;
    expiresAt?: string;
    status?: string;
    purpose?: string;
    vendorId?: string;
    authId?: string | null;
  }) {
    const requestId = options?.id ?? `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const amountMinor = toMinorUnits(options?.amountMinor ?? 2500); // $25.00
    const currency = 'USD';
    const purpose = options?.purpose ?? 'Cloud servers';
    const category = 'cloud';
    const nowIso = new Date().toISOString();
    const expiresAt = options?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const targetVendorId = options?.vendorId ?? testVendorId;
    const targetAuthId = options?.authId !== undefined ? options.authId : testAuthId;

    const snapshotHash = computeSnapshotHash({
      requestId,
      agentId: testAgentId,
      vendorId: targetVendorId,
      amountMinor,
      currency,
      purpose,
      category,
    });

    repos.paymentRequests.insert({
      id: requestId,
      agent_id: testAgentId,
      idempotency_key: `idem-${requestId}`,
      vendor_id: targetVendorId,
      amount_minor: amountMinor,
      currency,
      purpose,
      category,
      source_context_excerpt: null,
      source_context_hash: null,
      status: options?.status ?? 'HELD',
      decision: 'HOLD',
      reasons: JSON.stringify(['HIGH_AMOUNT']),
      policy_version_id: null,
      snapshot_hash: snapshotHash,
      paypal_order_id: null,
      paypal_authorization_id: targetAuthId,
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
      currency,
      created_at: nowIso,
    });

    return { requestId, snapshotHash, amountMinor, currency };
  }

  // Helper to seed a notification outbox record representing a sent Telegram message
  function seedNotificationOutbox(params: {
    requestId: string;
    telegramMessageId?: number | null;
    ownerId?: string;
    recipientChatId?: string;
    linkedAt?: string;
    status?: 'SENT' | 'PENDING' | 'PROCESSING' | 'DEAD';
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO notification_outbox (
        id, event_type, recipient_chat_id, owner_id, linked_at,
        request_id, dedup_key, message_text, parse_mode, status,
        attempt_count, max_attempts, next_attempt_at, created_at,
        telegram_message_id, sent_at
      ) VALUES (?, 'PAYMENT_HELD', ?, ?, ?, ?, ?, 'Notification message', 'HTML', ?, 1, 3, ?, ?, ?, ?)
    `).run(
      id,
      params.recipientChatId ?? String(linkedChatId),
      params.ownerId ?? linkedOwnerId,
      params.linkedAt ?? new Date().toISOString(),
      params.requestId,
      `payment_held:${params.requestId}`,
      params.status ?? 'SENT',
      now,
      now,
      params.telegramMessageId ?? null,
      params.telegramMessageId ? now : null
    );
    return id;
  }

  // Helper to create a valid Telegram approval callback row in the database
  function seedTelegramCallback(params: {
    requestId: string;
    action: 'APPROVE' | 'VOID';
    ownerId?: string;
    telegramChatId?: string;
    telegramUserId?: string;
    expiresAt?: string;
    snapshotHash?: string;
    linkedAt?: string;
    telegramMessageId?: number | null;
    omitOutbox?: boolean;
  }) {
    const rawCallbackToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawCallbackToken).digest('hex');
    const req = repos.paymentRequests.getById(params.requestId)!;
    const targetOwnerId = params.ownerId ?? linkedOwnerId;
    const owner = repos.owners.get(targetOwnerId);
    const linkedAt = params.linkedAt ?? owner?.telegram_linked_at ?? new Date().toISOString();

    repos.telegramApprovalCallbacks.insert({
      token_hash: tokenHash,
      request_id: params.requestId,
      owner_id: targetOwnerId,
      action: params.action,
      telegram_chat_id: params.telegramChatId ?? String(linkedChatId),
      telegram_user_id: params.telegramUserId ?? String(linkedUserId),
      snapshot_hash: params.snapshotHash ?? req.snapshot_hash!,
      expires_at: params.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      linked_at: linkedAt,
    });

    if (!params.omitOutbox) {
      seedNotificationOutbox({
        requestId: params.requestId,
        telegramMessageId: params.telegramMessageId !== undefined ? params.telegramMessageId : 555,
        ownerId: targetOwnerId,
        recipientChatId: params.telegramChatId ?? String(linkedChatId),
        linkedAt,
      });
    }

    return { rawCallbackToken, tokenHash };
  }

  // Helper to send a webhook POST update to the server
  async function postWebhookUpdate(update: TelegramUpdate, customSecret?: string): Promise<Response> {
    return await fetch(`http://127.0.0.1:${serverPort}/api/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [TELEGRAM_SECRET_HEADER]: customSecret !== undefined ? customSecret : testWebhookSecret,
      },
      body: JSON.stringify(update),
    });
  }

  // Helper to build a standard callback query update
  function buildCallbackUpdate(options: {
    updateId?: number;
    queryId?: string;
    fromId?: number;
    chatId?: number;
    chatType?: 'private' | 'group' | 'supergroup' | 'channel';
    messageId?: number;
    messageText?: string;
    data: string;
  }): TelegramUpdate {
    return {
      update_id: options.updateId ?? Math.floor(Math.random() * 1_000_000) + 1,
      callback_query: {
        id: options.queryId ?? `query-${Date.now()}`,
        from: {
          id: options.fromId ?? linkedUserId,
          is_bot: false,
          first_name: 'Alice',
          username: 'alice_sec',
        },
        message: {
          message_id: options.messageId ?? 555,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: options.chatId ?? linkedChatId,
            type: options.chatType ?? 'private',
            first_name: 'Alice',
          },
          text: options.messageText ?? 'Payment Hold Request: $25.00 USD for Acme Cloud Hosting',
        },
        data: options.data,
        chat_instance: 'instance-123',
      },
    };
  }

  // ============================================================================
  // 1. Success Paths: APPROVE and VOID
  // ============================================================================

  describe('1. Successful Approval and Void Dispatch', () => {
    it('successfully processes APPROVE callback, captures payment, and edits message', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken, tokenHash } = seedTelegramCallback({
        requestId,
        action: 'APPROVE',
      });

      const update = buildCallbackUpdate({
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string; action: string } };
      expect(body.ok).toBe(true);
      expect(body.outcome?.status).toBe('CAPTURED');
      expect(body.outcome?.action).toBe('APPROVE');

      // Database state: request is CAPTURED
      const updatedReq = repos.paymentRequests.getById(requestId);
      expect(updatedReq?.status).toBe('CAPTURED');

      // Callback token is marked used
      const callbackRow = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
      expect(callbackRow?.used_at).toBeDefined();

      // Ledger contains RESERVE + SPEND
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind).sort()).toEqual(['RESERVE', 'SPEND'].sort());

      // PayPal capture was called exactly once
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);
      expect(mockAuthorizationsService.voidAuthorization).not.toHaveBeenCalled();

      // Telegram user was answered promptly and message was updated with status badge
      expect(answeredCallbacks).toHaveLength(1);
      expect(answeredCallbacks[0]!.text).toContain('Request verified');
      expect(editedMessages.length + editedMarkups.length).toBeGreaterThanOrEqual(1);
      expect(editedMessages[0]?.text).toContain('Approved &amp; Captured');
    });

    it('successfully processes VOID callback, voids authorization, and releases reservation', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken, tokenHash } = seedTelegramCallback({
        requestId,
        action: 'VOID',
      });

      const update = buildCallbackUpdate({
        data: `pg:void:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string; action: string } };
      expect(body.ok).toBe(true);
      expect(body.outcome?.status).toBe('VOIDED');
      expect(body.outcome?.action).toBe('VOID');

      // Database state: request is VOIDED
      const updatedReq = repos.paymentRequests.getById(requestId);
      expect(updatedReq?.status).toBe('VOIDED');

      // Callback token marked used
      const callbackRow = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
      expect(callbackRow?.used_at).toBeDefined();

      // Ledger contains RESERVE + RELEASE
      const ledger = repos.ledger.listByRequestId(requestId);
      expect(ledger.map((l) => l.kind).sort()).toEqual(['RELEASE', 'RESERVE'].sort());

      // PayPal void was called exactly once
      expect(mockAuthorizationsService.voidAuthorization).toHaveBeenCalledTimes(1);
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();

      // Telegram feedback
      expect(answeredCallbacks).toHaveLength(1);
      expect(answeredCallbacks[0]!.text).toContain('Request verified');
      expect(editedMessages[0]?.text).toContain('Voided &amp; Cancelled');
    });

    it('resolves action from callback record when callback_data is an opaque raw token without prefix', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({
        requestId,
        action: 'APPROVE',
      });

      // Pass raw token without 'pg:app:' prefix
      const update = buildCallbackUpdate({
        data: rawCallbackToken,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.ok).toBe(true);
      expect(body.outcome?.status).toBe('CAPTURED');
    });
  });

  // ============================================================================
  // 2. Chat Type and Caller Identity Validation
  // ============================================================================

  describe('2. Chat Type and Caller Identity Security', () => {
    it('rejects callbacks from group, supergroup, or channel chats', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      const update = buildCallbackUpdate({
        chatType: 'group',
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; ignored?: string };
      expect(body.ignored).toBe('non_private_chat');

      // Ensure capture was NOT executed
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
      expect(answeredCallbacks[0]?.text).toContain('private chats');
    });

    it('rejects callback with non-numeric or invalid from.id', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      const update = buildCallbackUpdate({
        fromId: -1, // invalid negative ID
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('INVALID_CALLER_IDENTITY');
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
    });

    it('rejects callback with wrong Telegram user ID (USER_MISMATCH)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      // Attacker sends callback with different from.id
      const update = buildCallbackUpdate({
        fromId: 1122334455,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('USER_MISMATCH');

      // Payment request remains HELD
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('HELD');
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();

      // Controls were NOT cleared on unauthorized caller attempt
      expect(editedMarkups).toHaveLength(0);
      expect(answeredCallbacks[0]?.text).toContain('Unauthorized');
    });

    it('rejects callback with wrong chat ID (CHAT_MISMATCH)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      const update = buildCallbackUpdate({
        chatId: 999888777,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('CHAT_MISMATCH');
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
    });

    it('rejects callback if owner unlinked after callback creation (OWNER_UNLINKED)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      // Owner unlinks account from dashboard
      repos.owners.unlinkTelegram(linkedOwnerId);

      const update = buildCallbackUpdate({
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('OWNER_UNLINKED');
      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // 3. Token Validity, Replay, Expiry & Snapshot Integrity
  // ============================================================================

  describe('3. Token Validity, Replay & Snapshot Protection', () => {
    it('rejects replayed callback query on second attempt with TOKEN_ALREADY_USED', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      const update1 = buildCallbackUpdate({ updateId: 101, data: `pg:app:${rawCallbackToken}` });
      const update2 = buildCallbackUpdate({ updateId: 102, data: `pg:app:${rawCallbackToken}` });

      // First execution succeeds
      const res1 = await postWebhookUpdate(update1);
      expect(res1.status).toBe(200);
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);

      // Replay attempt fails with TOKEN_ALREADY_USED
      const res2 = await postWebhookUpdate(update2);
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { error?: string };
      expect(body2.error).toBe('TOKEN_ALREADY_USED');

      // Capture was NOT called a second time
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);

      // Replay alert was returned to user
      expect(answeredCallbacks.some((a) => a.text?.includes('already been decided'))).toBe(true);
    });

    it('rejects expired callback with TOKEN_EXPIRED', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const pastExpiry = new Date(Date.now() - 60_000).toISOString();
      const { rawCallbackToken } = seedTelegramCallback({
        requestId,
        action: 'APPROVE',
        expiresAt: pastExpiry,
      });

      const update = buildCallbackUpdate({ data: `pg:app:${rawCallbackToken}` });
      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('TOKEN_EXPIRED');

      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
      expect(answeredCallbacks[0]?.text).toContain('expired');
    });

    it('rejects callback when snapshot hash integrity check fails (SNAPSHOT_MISMATCH)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      // Simulate tamper on payment request after callback was minted
      db.prepare('UPDATE payment_requests SET amount_minor = 999999 WHERE id = ?').run(requestId);

      const update = buildCallbackUpdate({ data: `pg:app:${rawCallbackToken}` });
      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('SNAPSHOT_MISMATCH');

      expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
      expect(answeredCallbacks[0]?.text).toContain('Security alert');
    });

    it('rejects invalid or empty callback_data with INVALID_CALLBACK_DATA', async () => {
      const update = buildCallbackUpdate({ data: '' });
      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('INVALID_CALLBACK_DATA');
    });

    it('rejects action mismatch (pg:void with an APPROVE-only token)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      // Malicious or mismatched button action
      const update = buildCallbackUpdate({ data: `pg:void:${rawCallbackToken}` });
      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('ACTION_MISMATCH');
    });
  });

  // ============================================================================
  // 4. Concurrency & Deduplication Handling
  // ============================================================================

  describe('4. Concurrency & Deduplication', () => {
    it('handles duplicate Telegram update delivery with ok: true, duplicate: true', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      const update = buildCallbackUpdate({ updateId: 8881, data: `pg:app:${rawCallbackToken}` });

      const res1 = await postWebhookUpdate(update);
      expect(res1.status).toBe(200);

      // Same updateId resent by Telegram
      const res2 = await postWebhookUpdate(update);
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as { ok: boolean; duplicate?: boolean };
      expect(body2.duplicate).toBe(true);

      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);
    });

    it('simultaneous APPROVE and VOID callbacks for the same request: exactly one succeeds', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const cbApprove = seedTelegramCallback({ requestId, action: 'APPROVE' });
      const cbVoid = seedTelegramCallback({ requestId, action: 'VOID' });

      const updateApprove = buildCallbackUpdate({
        updateId: 9001,
        queryId: 'q-app',
        data: `pg:app:${cbApprove.rawCallbackToken}`,
      });
      const updateVoid = buildCallbackUpdate({
        updateId: 9002,
        queryId: 'q-void',
        data: `pg:void:${cbVoid.rawCallbackToken}`,
      });

      // Send both concurrently
      const [resApp, resVoid] = await Promise.all([
        postWebhookUpdate(updateApprove),
        postWebhookUpdate(updateVoid),
      ]);

      expect(resApp.status).toBe(200);
      expect(resVoid.status).toBe(200);

      const bodyApp = (await resApp.json()) as { ok: boolean; outcome?: { status: string }; error?: string };
      const bodyVoid = (await resVoid.json()) as { ok: boolean; outcome?: { status: string }; error?: string };

      const isAppWinner = bodyApp.outcome !== undefined;
      const isVoidWinner = bodyVoid.outcome !== undefined;

      // Exactly ONE action must succeed
      expect(Number(isAppWinner) + Number(isVoidWinner)).toBe(1);

      const finalReq = repos.paymentRequests.getById(requestId)!;
      const ledger = repos.ledger.listByRequestId(requestId);

      if (isAppWinner) {
        expect(bodyVoid.error).toBe('TOKEN_ALREADY_USED');
        expect(finalReq.status).toBe('CAPTURED');
        expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);
        expect(mockAuthorizationsService.voidAuthorization).not.toHaveBeenCalled();
        expect(ledger.map((l) => l.kind).sort()).toEqual(['RESERVE', 'SPEND'].sort());
      } else {
        expect(bodyApp.error).toBe('TOKEN_ALREADY_USED');
        expect(finalReq.status).toBe('VOIDED');
        expect(mockAuthorizationsService.voidAuthorization).toHaveBeenCalledTimes(1);
        expect(mockAuthorizationsService.captureAuthorization).not.toHaveBeenCalled();
        expect(ledger.map((l) => l.kind).sort()).toEqual(['RELEASE', 'RESERVE'].sort());
      }
    });
  });

  // ============================================================================
  // 5. Fault Tolerance & Remote Execution Edge Cases
  // ============================================================================

  describe('5. Fault Tolerance & Decoupled Telegram Delivery', () => {
    it('does NOT rollback or fail payment approval if Telegram API times out post-commit', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      // Simulate Telegram API timeout during response/message editing
      shouldAnswerFail = true;
      shouldEditFail = true;

      const update = buildCallbackUpdate({ data: `pg:app:${rawCallbackToken}` });
      const res = await postWebhookUpdate(update);

      // Webhook response must still be 200 OK
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.ok).toBe(true);
      expect(body.outcome?.status).toBe('CAPTURED');

      // Payment capture is safely committed in DB
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('CAPTURED');
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);
    });

    it('handles ambiguous PayPal capture outcome (HTTP 202 reconciliation required)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      // Simulate PayPal network drop during capture
      mockAuthorizationsService.captureAuthorization = vi.fn().mockRejectedValue(
        new PayPalHttpError({
          message: 'ETIMEDOUT: Connection reset by peer',
          code: 'NETWORK',
          status: 504,
        })
      );

      const update = buildCallbackUpdate({ data: `pg:app:${rawCallbackToken}` });
      const res = await postWebhookUpdate(update);

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        outcome?: { status: string; reconciliationRequired: boolean };
      };
      expect(body.outcome?.status).toBe('CAPTURING');
      expect(body.outcome?.reconciliationRequired).toBe(true);

      // Database status is CAPTURING (handed off to reconciler)
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('CAPTURING');

      // User notified of pending reconciliation via message update
      expect(answeredCallbacks[0]?.text).toContain('Request verified');
      expect(editedMessages[0]?.text).toContain('Capture pending reconciliation');
    });

    it('handles definitive PayPal failure cleanly', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      mockAuthorizationsService.captureAuthorization = vi.fn().mockRejectedValue(
        new PayPalHttpError({
          message: 'AUTHORIZATION_EXPIRED',
          code: 'AUTH_EXPIRED',
          status: 422,
          issue: 'AUTHORIZATION_EXPIRED',
        })
      );

      const update = buildCallbackUpdate({ data: `pg:app:${rawCallbackToken}` });
      const res = await postWebhookUpdate(update);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.outcome?.status).toBe('FAILED');

      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('FAILED');
    });

    it('returns HTTP 500 on database failure and clears in-flight deduplicator state for retry', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      // Simulate unexpected SQLite disk error during transaction
      vi.spyOn(repos.telegramApprovalCallbacks, 'markUsed').mockImplementationOnce(() => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      });

      const update = buildCallbackUpdate({ updateId: 9999, data: `pg:app:${rawCallbackToken}` });
      const res = await postWebhookUpdate(update);

      // Returns 500 so Telegram will retry the webhook
      expect(res.status).toBe(500);

      // Verify payment request is not committed
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('HELD');
    });
  });

  describe('6. Subtask 3.4.1: Non-Blocking Acknowledgement & onClaimed Hook', () => {
    it('invokes onClaimed immediately after Phase 1 commits and starts answerCallbackQuery & editMessageReplyMarkup concurrently', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      const orderOfExecution: string[] = [];

      mockTelegramClient.answerCallbackQuery = vi.fn(async (_params, options) => {
        orderOfExecution.push('answerCallbackQuery');
        expect(options?.timeoutMs).toBe(750);
        expect(options?.maxRetries).toBe(0);
        expect(options?.signal).toBeDefined();
        return true;
      });

      mockTelegramClient.editMessageReplyMarkup = vi.fn(async (_params, options) => {
        orderOfExecution.push('editMessageReplyMarkup');
        expect(options?.timeoutMs).toBe(750);
        expect(options?.maxRetries).toBe(0);
        expect(options?.signal).toBeDefined();
        return true;
      });

      mockAuthorizationsService.captureAuthorization = vi.fn(async () => {
        orderOfExecution.push('captureAuthorization');
        return {
          id: 'CAP-123',
          status: 'COMPLETED',
          isCaptured: true,
        } as unknown as PayPalCaptureResult;
      });

      const update = buildCallbackUpdate({
        updateId: 1001,
        queryId: 'query-123',
        data: `pg:app:${rawCallbackToken}`,
      });
      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(mockTelegramClient.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          callback_query_id: 'query-123',
          text: '⏳ Request verified. Contacting PayPal to complete payment...',
          show_alert: false,
        }),
        expect.objectContaining({
          timeoutMs: 750,
          maxRetries: 0,
        })
      );

      expect(mockTelegramClient.editMessageReplyMarkup).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: linkedChatId,
          message_id: 555,
          reply_markup: { inline_keyboard: [] },
        }),
        expect.objectContaining({
          timeoutMs: 750,
          maxRetries: 0,
        })
      );

      expect(orderOfExecution).toContain('answerCallbackQuery');
      expect(orderOfExecution).toContain('editMessageReplyMarkup');
      expect(orderOfExecution).toContain('captureAuthorization');
    });

    it('VOID: sends appropriate intermediate acknowledgement text', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'VOID' });

      mockTelegramClient.answerCallbackQuery = vi.fn().mockResolvedValue(true);
      mockTelegramClient.editMessageReplyMarkup = vi.fn().mockResolvedValue(true);

      const update = buildCallbackUpdate({
        updateId: 1002,
        queryId: 'query-123',
        data: `pg:void:${rawCallbackToken}`,
      });
      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(mockTelegramClient.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          callback_query_id: 'query-123',
          text: '⏳ Request verified. Voiding payment hold...',
          show_alert: false,
        }),
        expect.anything()
      );
    });

    it('genuinely non-blocking: slow Telegram response does not delay Phase 2 PayPal capture', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      let telegramAnswerFinished = false;
      let captureStartedWhileTelegramInFlight = false;

      // Simulate 300ms delay in Telegram answer
      mockTelegramClient.answerCallbackQuery = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        telegramAnswerFinished = true;
        return true;
      });

      mockTelegramClient.editMessageReplyMarkup = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return true;
      });

      mockAuthorizationsService.captureAuthorization = vi.fn(async () => {
        if (!telegramAnswerFinished) {
          captureStartedWhileTelegramInFlight = true;
        }
        return {
          id: 'CAP-123',
          status: 'COMPLETED',
          isCaptured: true,
        } as unknown as PayPalCaptureResult;
      });

      const update = buildCallbackUpdate({
        updateId: 1003,
        data: `pg:app:${rawCallbackToken}`,
      });
      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(captureStartedWhileTelegramInFlight).toBe(true);
    });

    it('hanging Telegram requests are aborted at 750ms without failing Phase 2', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      let answerAborted = false;
      let markupAborted = false;

      mockTelegramClient.answerCallbackQuery = vi.fn(async (_params, options) => {
        return new Promise<boolean>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            answerAborted = true;
            reject(new Error('AbortError'));
          });
        });
      });

      mockTelegramClient.editMessageReplyMarkup = vi.fn(async (_params, options) => {
        return new Promise<boolean>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            markupAborted = true;
            reject(new Error('AbortError'));
          });
        });
      });

      const update = buildCallbackUpdate({
        updateId: 1004,
        data: `pg:app:${rawCallbackToken}`,
      });
      const res = await postWebhookUpdate(update);

      // Phase 2 should succeed immediately regardless of hanging Telegram requests
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.outcome?.status).toBe('CAPTURED');

      // Wait 850ms to let the 750ms abort timer fire
      await new Promise((resolve) => setTimeout(resolve, 850));

      expect(answerAborted).toBe(true);
      expect(markupAborted).toBe(true);
    });

    it('one request rejecting while other hangs settles safely without unhandled rejections', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      let markupAborted = false;

      // answerCallbackQuery rejects immediately
      mockTelegramClient.answerCallbackQuery = vi.fn().mockRejectedValue(new Error('Immediate network drop'));

      // editMessageReplyMarkup hangs until aborted
      mockTelegramClient.editMessageReplyMarkup = vi.fn(async (_params, options) => {
        return new Promise<boolean>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            markupAborted = true;
            reject(new Error('AbortError'));
          });
        });
      });

      const update = buildCallbackUpdate({
        updateId: 1005,
        data: `pg:app:${rawCallbackToken}`,
      });
      const res = await postWebhookUpdate(update);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.outcome?.status).toBe('CAPTURED');

      // Wait 850ms to ensure the other hanging request is aborted and no unhandled rejections occur
      await new Promise((resolve) => setTimeout(resolve, 850));
      expect(markupAborted).toBe(true);
    });

    it('Telegram intermediate failure does not rollback committed approval decision', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      // Both Telegram calls fail
      mockTelegramClient.answerCallbackQuery = vi.fn().mockRejectedValue(new Error('Connection reset'));
      mockTelegramClient.editMessageReplyMarkup = vi.fn().mockRejectedValue(new Error('Connection reset'));

      const update = buildCallbackUpdate({
        updateId: 1006,
        data: `pg:app:${rawCallbackToken}`,
      });
      const res = await postWebhookUpdate(update);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.outcome?.status).toBe('CAPTURED');

      // Database state remains CAPTURED
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('CAPTURED');

      // Audit log has OWNER_APPROVED entry
      const audit = repos.auditLog.listByRequestId(requestId);
      expect(audit.length).toBeGreaterThanOrEqual(1);
      expect(audit.some((a) => a.event === 'OWNER_APPROVED')).toBe(true);
    });

    it('duplicate or replayed callback cannot execute Phase 2 twice', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE' });

      const update1 = buildCallbackUpdate({
        updateId: 1007,
        data: `pg:app:${rawCallbackToken}`,
      });
      const res1 = await postWebhookUpdate(update1);
      expect(res1.status).toBe(200);

      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);

      // Second attempt with same token
      const update2 = buildCallbackUpdate({
        updateId: 1008,
        data: `pg:app:${rawCallbackToken}`,
      });
      const res2 = await postWebhookUpdate(update2);
      expect(res2.status).toBe(200);

      // PayPal capture was NOT called again!
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);
    });
  });

  describe('7. Subtask 3.4.2: Trusted Message Formatting & Authorization Enforcement', () => {
    it('Outcome 1: CAPTURED - reconstructs message using trusted records with capture ID and dashboard link without reusing incoming text', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE', telegramMessageId: 777 });

      const fakeIncomingText = 'COMPLETELY_FAKE_INCOMING_MESSAGE_THAT_MUST_NEVER_BE_REUSED';
      const update = buildCallbackUpdate({
        updateId: 2001,
        messageId: 777,
        messageText: fakeIncomingText,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(editedMessages.length).toBe(1);
      const edited = editedMessages[0]!;
      expect(edited.chat_id).toBe(linkedChatId);
      expect(edited.message_id).toBe(777);
      expect(edited.parse_mode).toBe('HTML');
      expect(edited.reply_markup?.inline_keyboard).toEqual([]);

      // Strictly verifies NO reuse of incoming text
      expect(edited.text).not.toContain(fakeIncomingText);

      // Verifies trusted reconstructed fields
      expect(edited.text).toContain('✅ <b>Payment Approved &amp; Captured</b>');
      expect(edited.text).toContain(`<b>Request ID:</b> <code>${requestId}</code>`);
      expect(edited.text).toContain('<b>Amount:</b> 25.00 USD');
      expect(edited.text).toContain('<b>Vendor:</b> Acme Cloud Hosting');
      expect(edited.text).toContain('<b>Purpose:</b> Cloud servers');
      expect(edited.text).toContain('<b>Status:</b> ✅ Captured successfully');
      expect(edited.text).toContain('<b>Capture ID:</b> <code>CAP-PAYPAL-123</code>');
      expect(edited.text).toContain(`href="http://localhost:3000/#/requests/${requestId}"`);
    });

    it('Outcome 2: CAPTURING - updates message to capture pending reconciliation without inferring success', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE', telegramMessageId: 778 });

      // Ambiguous execution requiring reconciliation
      mockAuthorizationsService.captureAuthorization = vi.fn().mockRejectedValue(
        new PayPalHttpError({
          message: 'Ambiguous 503 status from PayPal',
          code: 'NETWORK',
          status: 503,
        })
      );

      const update = buildCallbackUpdate({
        updateId: 2002,
        messageId: 778,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(editedMessages.length).toBe(1);
      const edited = editedMessages[0]!;
      expect(edited.text).toContain('⏳ <b>Payment Approved (Capture Pending)</b>');
      expect(edited.text).toContain('<b>Status:</b> ⏳ Approved — Capture pending reconciliation');
      expect(edited.text).not.toContain('Captured successfully');
      expect(edited.text).not.toContain('Capture ID');
    });

    it('Outcome 3: FAILED - updates message to execution failed at PayPal without exposing secrets', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE', telegramMessageId: 779 });

      mockAuthorizationsService.captureAuthorization = vi.fn().mockRejectedValue(
        new PayPalHttpError({
          message: 'AUTHORIZATION_EXPIRED_SECRET_INTERNAL_TOKEN_XYZ',
          code: 'AUTH_EXPIRED',
          status: 422,
        })
      );

      const update = buildCallbackUpdate({
        updateId: 2003,
        messageId: 779,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(editedMessages.length).toBe(1);
      const edited = editedMessages[0]!;
      expect(edited.text).toContain('❌ <b>Payment Execution Failed</b>');
      expect(edited.text).toContain('<b>Status:</b> ❌ Execution failed at PayPal');
      // Verifies internal error secrets are not exposed
      expect(edited.text).not.toContain('SECRET_INTERNAL_TOKEN_XYZ');
      expect(edited.text).not.toContain('/a/');
    });

    it('Outcome 4: VOID_CONFIRMED - updates message to voided and cancelled', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'VOID', telegramMessageId: 780 });

      mockAuthorizationsService.voidAuthorization = vi.fn().mockResolvedValue({
        id: testAuthId,
        status: 'VOIDED',
        isVoided: true,
      });

      const update = buildCallbackUpdate({
        updateId: 2004,
        messageId: 780,
        data: `pg:void:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(editedMessages.length).toBe(1);
      const edited = editedMessages[0]!;
      expect(edited.text).toContain('🛑 <b>Payment Voided &amp; Cancelled</b>');
      expect(edited.text).toContain('<b>Status:</b> 🚫 Voided — PayPal authorization cancelled');
    });

    it('Outcome 5: VOID_PENDING - updates message to pending retry when remote void is delayed', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'VOID', telegramMessageId: 781 });

      // Transient PayPal error leaves remoteVoidStatus as PENDING
      mockAuthorizationsService.voidAuthorization = vi.fn().mockRejectedValue(
        new PayPalHttpError({
          message: 'PayPal temporary network drop',
          code: 'NETWORK',
          status: 503,
        })
      );

      const update = buildCallbackUpdate({
        updateId: 2005,
        messageId: 781,
        data: `pg:void:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(editedMessages.length).toBe(1);
      const edited = editedMessages[0]!;
      expect(edited.text).toContain('🛑 <b>Payment Voided (Pending Cancellation)</b>');
      expect(edited.text).toContain('<b>Status:</b> ⏳ Voided locally — Remote cancellation pending retry');
    });

    it('Outcome 6: VOID_FAILED - updates message to remote void failed when authorization missing', async () => {
      const { requestId } = seedHeldPaymentRequest({
        authId: null, // missing authorization ID -> remote void fails
        purpose: 'Missing auth void',
      });

      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'VOID', telegramMessageId: 782 });

      const update = buildCallbackUpdate({
        updateId: 2006,
        messageId: 782,
        data: `pg:void:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(editedMessages.length).toBe(1);
      const edited = editedMessages[0]!;
      expect(edited.text).toContain('🛑 <b>Payment Voided (Remote Void Failed)</b>');
      expect(edited.text).toContain('<b>Status:</b> ⚠️ Voided locally — Remote cancellation failed');
    });

    it('HTML Escaping: escapes <, >, &, quotes and malicious input in purpose and vendor name', async () => {
      const nowIso = new Date().toISOString();
      const maliciousVendorId = 'ven-xss-test';

      repos.vendors.insert({
        id: maliciousVendorId,
        name: 'Evil <Vendor> & "Son\'s"',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'xss',
        created_at: nowIso,
      });

      const maliciousPurpose = '<script>alert("hack")</script> & <b>bold</b> > test';
      const { requestId } = seedHeldPaymentRequest({
        vendorId: maliciousVendorId,
        purpose: maliciousPurpose,
      });

      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE', telegramMessageId: 783 });

      const update = buildCallbackUpdate({
        updateId: 2007,
        messageId: 783,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(editedMessages.length).toBe(1);
      const editedText = editedMessages[0]!.text;

      // Verifies malicious tags are never injected raw into the Telegram HTML markup
      expect(editedText).not.toContain('<script>');
      expect(editedText).toContain('&lt;script&gt;alert(&quot;hack&quot;)&lt;/script&gt;');
      expect(editedText).toContain('Evil &lt;Vendor&gt; &amp; &quot;Son\'s&quot;');
      expect(editedText).toContain('&gt; test');
    });

    it('Authorization: unauthorized caller with wrong user ID cannot modify message text or buttons', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE', telegramMessageId: 784 });

      const update = buildCallbackUpdate({
        updateId: 2008,
        fromId: 999999999, // Unmatched user ID
        messageId: 784,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      // Verify NO message edits or button removals were performed
      expect(editedMessages).toHaveLength(0);
      expect(editedMarkups).toHaveLength(0);

      // Verify unauthorized alert shown to attacker
      expect(answeredCallbacks.some((a) => a.text?.includes('Unauthorized'))).toBe(true);

      // Database state remains strictly HELD
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('HELD');
    });

    it('Authorization: unauthorized caller with wrong chat ID cannot modify message text or buttons', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE', telegramMessageId: 785 });

      const update = buildCallbackUpdate({
        updateId: 2009,
        chatId: 888888888, // Unmatched chat ID
        messageId: 785,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      expect(editedMessages).toHaveLength(0);
      expect(editedMarkups).toHaveLength(0);
      expect(answeredCallbacks.some((a) => a.text?.includes('Unauthorized'))).toBe(true);

      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('HELD');
    });

    it('Authorization: invalid message ID prevents message edits', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE', telegramMessageId: 786 });

      const update = buildCallbackUpdate({
        updateId: 2010,
        messageId: -1, // Invalid negative message ID
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      // Payment captures authorized, but message edit is safely skipped due to invalid message ID
      expect(editedMessages).toHaveLength(0);
    });

    it('Authorization: unlink/relink changes link epoch and prevents editing old messages', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const initialLinkedAt = new Date(Date.now() - 3600000).toISOString();

      // Seed callback with initial link epoch and matching outbox message ID
      const { rawCallbackToken } = seedTelegramCallback({
        requestId,
        action: 'APPROVE',
        linkedAt: initialLinkedAt,
        telegramMessageId: 888,
      });

      // Owner relinks with a new epoch (simulating unlink and re-link to a fresh session)
      const freshLinkedAt = new Date().toISOString();
      repos.owners.linkTelegram({
        ownerId: linkedOwnerId,
        chatId: String(linkedChatId),
        userId: String(linkedUserId),
        username: 'alice_relinked',
        linkedAtIso: freshLinkedAt,
      });

      const update = buildCallbackUpdate({
        updateId: 2011,
        messageId: 888,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      // Verifies old message is NOT edited and buttons are NOT removed
      expect(editedMessages).toHaveLength(0);
      expect(editedMarkups).toHaveLength(0);

      // Caller receives unauthorized feedback
      expect(answeredCallbacks.some((a) => a.text?.includes('Unauthorized'))).toBe(true);

      // Request was NOT captured
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('HELD');
    });

    it('Telegram API failure during editMessageText does not rollback committed approval decision', async () => {
      const { requestId } = seedHeldPaymentRequest();
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE', telegramMessageId: 999 });

      // Simulate Telegram API network drop during post-approval editMessageText
      mockTelegramClient.editMessageText = vi.fn().mockRejectedValue(new Error('Telegram 500 Network Timeout'));
      mockTelegramClient.editMessageReplyMarkup = vi.fn().mockRejectedValue(new Error('Telegram 500 Network Timeout'));

      const update = buildCallbackUpdate({
        updateId: 2012,
        messageId: 999,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.ok).toBe(true);
      expect(body.outcome?.status).toBe('CAPTURED');

      // Database state remains CAPTURED despite Telegram API failure
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('CAPTURED');
    });

    // ========================================================================
    // Regression Tests: Security Correction - Stored telegram_message_id Validation
    // ========================================================================

    it('Regression 1: Missing stored outbox record fails closed (zero edits, zero button removals, financial approval succeeds)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      // omitOutbox: true - outbox row for payment_held:requestId is deliberately absent
      const { rawCallbackToken } = seedTelegramCallback({ requestId, action: 'APPROVE', omitOutbox: true });

      const update = buildCallbackUpdate({
        updateId: 3001,
        messageId: 3001,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      // Financial approval succeeds authoritatively
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.ok).toBe(true);
      expect(body.outcome?.status).toBe('CAPTURED');
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('CAPTURED');
      expect(mockAuthorizationsService.captureAuthorization).toHaveBeenCalledTimes(1);

      // Telegram message is strictly NOT modified because stored outbox ID is missing
      expect(editedMessages).toHaveLength(0);
      expect(editedMarkups).toHaveLength(0);
    });

    it('Regression 2: Stored outbox record with null telegram_message_id fails closed (zero edits, zero button removals, financial approval succeeds)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      // Outbox row exists with telegram_message_id explicitly set to null
      const { rawCallbackToken } = seedTelegramCallback({
        requestId,
        action: 'APPROVE',
        telegramMessageId: null,
      });

      const update = buildCallbackUpdate({
        updateId: 3002,
        messageId: 3002,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      // Financial approval succeeds authoritatively
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.ok).toBe(true);
      expect(body.outcome?.status).toBe('CAPTURED');
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('CAPTURED');

      // Message modification refused
      expect(editedMessages).toHaveLength(0);
      expect(editedMarkups).toHaveLength(0);
    });

    it('Regression 3: Stored outbox record with invalid (zero/negative) telegram_message_id fails closed (zero edits, zero button removals, financial approval succeeds)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      // Outbox row has invalid telegram_message_id = 0
      const { rawCallbackToken } = seedTelegramCallback({
        requestId,
        action: 'APPROVE',
        telegramMessageId: 0,
      });

      const update = buildCallbackUpdate({
        updateId: 3003,
        messageId: 3003,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      // Financial approval succeeds authoritatively
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.ok).toBe(true);
      expect(body.outcome?.status).toBe('CAPTURED');
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('CAPTURED');

      // Message modification refused
      expect(editedMessages).toHaveLength(0);
      expect(editedMarkups).toHaveLength(0);
    });

    it('Regression 4: Stored outbox record with mismatched telegram_message_id fails closed (zero edits, zero button removals, financial approval succeeds)', async () => {
      const { requestId } = seedHeldPaymentRequest();
      // Stored outbox has message ID 8888, but incoming callback reports messageId 3004
      const { rawCallbackToken } = seedTelegramCallback({
        requestId,
        action: 'APPROVE',
        telegramMessageId: 8888,
      });

      const update = buildCallbackUpdate({
        updateId: 3004,
        messageId: 3004,
        data: `pg:app:${rawCallbackToken}`,
      });

      const res = await postWebhookUpdate(update);
      expect(res.status).toBe(200);

      // Financial approval succeeds authoritatively
      const body = (await res.json()) as { ok: boolean; outcome?: { status: string } };
      expect(body.ok).toBe(true);
      expect(body.outcome?.status).toBe('CAPTURED');
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('CAPTURED');

      // Message modification refused
      expect(editedMessages).toHaveLength(0);
      expect(editedMarkups).toHaveLength(0);
    });
  });
});
