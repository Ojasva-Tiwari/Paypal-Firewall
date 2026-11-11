/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3-B Unit & Integration Tests: Telegram Account Linking Router
 *
 * Verifies all M6-T3-B endpoints and security policies:
 * - GET  /api/telegram/status (authentication, status reporting)
 * - POST /api/telegram/link-token (authentication, CSRF, single-use deep link minting)
 * - POST /api/telegram/unlink (authentication, CSRF, unlinking, audit logging, fail-soft notice)
 * - POST /api/telegram/webhook (secret header pre-auth before JSON parsing, 3-state deduplication,
 *   atomic SQLite linking transaction, conflict handling, decoupled confirmation delivery)
 *
 * Security & Reliability Invariants Tested:
 * - Dynamic owner identity derived strictly from session
 * - Secret token comparison via constant-time crypto.timingSafeEqual before body parsing
 * - Three-state deduplication (200 for COMPLETED, 503 with Retry-After for IN_PROGRESS)
 * - Fail-soft decoupled confirmation: post-commit notification failure returns 200 OK
 * - Zero raw tokens in audit log or database
 * - Strict rollback and audit logging on conflicting ownership or chat reuse
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { createPayGuardMcpServer, type PayGuardMcpServerInstance } from '../../src/mcp/server.js';
import { hashOwnerPassphrase, OWNER_COOKIE_NAME } from '../../src/auth/owner.js';
import { loadConfig, type PayGuardConfig } from '../../src/config/index.js';
import { TELEGRAM_SECRET_HEADER, UpdateDeduplicator } from '../../src/telegram/middleware.js';
import { mintTelegramLinkToken } from '../../src/telegram/tokens.js';
import { agentContextStorage, generateAgentKey } from '../../src/mcp/auth.js';
import { handleRequestPayment } from '../../src/mcp/tools.js';
import { toMinorUnits } from '../../src/core/money.js';
import { decryptReplyMarkup } from '../../src/telegram/crypto.js';
import type { TelegramClient } from '../../src/telegram/client.js';
import type { SendMessageParams, TelegramMessage } from '../../src/telegram/types.js';

describe('M6-T3-B: Telegram Account Linking Router & Webhook Tests', () => {
  let db: Database;
  let repos: Repositories;
  let serverInstance: PayGuardMcpServerInstance;
  let serverPort = 0;
  let serverClose: () => Promise<void>;

  const ownerPassphrase = 'owner-secure-passphrase-2026';
  let sessionCookie = '';
  let csrfToken = '';

  const testBotToken = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789';
  const testBotUsername = 'PayGuardTestBot';
  const testWebhookSecret = 'pg_test_webhook_secret_998877665544332211';

  let sentMessages: SendMessageParams[] = [];
  let shouldSendMessageFail = false;
  let deduplicator: UpdateDeduplicator;

  let mockTelegramClient: TelegramClient;

  async function startServerWithConfig(customEnv: Record<string, string> = {}): Promise<void> {
    const config: PayGuardConfig = loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret-at-least-32-chars-long-12345',
      TELEGRAM_MODE: customEnv.TELEGRAM_MODE ?? 'webhook',
      TELEGRAM_BOT_TOKEN: customEnv.TELEGRAM_BOT_TOKEN ?? testBotToken,
      TELEGRAM_BOT_USERNAME: customEnv.TELEGRAM_BOT_USERNAME ?? testBotUsername,
      TELEGRAM_WEBHOOK_SECRET: customEnv.TELEGRAM_WEBHOOK_SECRET ?? testWebhookSecret,
      ...customEnv,
    });

    sentMessages = [];
    shouldSendMessageFail = false;
    deduplicator = new UpdateDeduplicator({ ttlMs: 60_000 });

    mockTelegramClient = {
      sendMessage: vi.fn(async (params: SendMessageParams): Promise<TelegramMessage> => {
        sentMessages.push(params);
        if (shouldSendMessageFail) {
          throw new Error('Simulated Telegram Bot API connection timeout');
        }
        return {
          message_id: 999,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: typeof params.chat_id === 'number' ? params.chat_id : parseInt(params.chat_id, 10),
            type: 'private',
          },
          text: params.text,
        };
      }),
    } as unknown as TelegramClient;

    serverInstance = createPayGuardMcpServer({
      db,
      repos,
      config,
      telegramClient: mockTelegramClient,
      telegramDeduplicator: deduplicator,
      secureCookie: false,
    });

    const started = await serverInstance.start(0);
    serverPort = started.port;
    serverClose = started.close;

    // Log in as Owner to obtain Cookie and CSRF token
    const loginRes = await fetch(`http://localhost:${serverPort}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: ownerPassphrase }),
    });

    expect(loginRes.status).toBe(200);
    const setCookieHeader = loginRes.headers.get('set-cookie');
    expect(setCookieHeader).toBeDefined();

    const match = setCookieHeader!.match(new RegExp(`${OWNER_COOKIE_NAME}=([^;]+)`));
    expect(match).toBeDefined();
    sessionCookie = match![0];

    const loginData = (await loginRes.json()) as { csrfToken: string };
    csrfToken = loginData.csrfToken;
    expect(csrfToken).toBeDefined();
  }

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);

    // Seed Owner
    const hashedPass = await hashOwnerPassphrase(ownerPassphrase);
    repos.owners.upsert({
      id: 'default',
      display_name: 'Primary Owner',
      passphrase_hash: hashedPass,
      telegram_chat_id: null,
      created_at: new Date().toISOString(),
    });

    await startServerWithConfig();
  });

  afterEach(async () => {
    if (serverClose) {
      await serverClose();
    }
    db.close();
  });

  // ==========================================================================
  // 1. Authentication & CSRF Controls on Owner Endpoints
  // ==========================================================================
  describe('Owner Endpoints Authentication & CSRF Protection', () => {
    it('GET /api/telegram/status returns 401 when unauthenticated', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/status`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Authentication required');
    });

    it('POST /api/telegram/link-token returns 401 when unauthenticated', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/link-token`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('POST /api/telegram/unlink returns 401 when unauthenticated', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/unlink`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });

    it('POST /api/telegram/link-token returns 403 when CSRF token is missing', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/link-token`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
        },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('CSRF token missing or invalid');
    });

    it('POST /api/telegram/link-token returns 403 when CSRF token is invalid', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/link-token`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': 'wrong-csrf-token-12345',
        },
      });
      expect(res.status).toBe(403);
    });

    it('POST /api/telegram/unlink returns 403 when CSRF token is missing', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/unlink`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
        },
      });
      expect(res.status).toBe(403);
    });

    it('POST /api/telegram/unlink returns 403 when CSRF token is invalid', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/unlink`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': 'invalid-csrf',
        },
      });
      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  // 2. GET /api/telegram/status
  // ==========================================================================
  describe('GET /api/telegram/status', () => {
    it('returns unlinked state when owner has not linked Telegram', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/status`, {
        headers: {
          Cookie: sessionCookie,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        configured: true,
        mode: 'webhook',
        botUsername: testBotUsername,
        linked: false,
        chatId: null,
        username: null,
        linkedAt: null,
      });
    });

    it('returns linked state when owner is linked in database', async () => {
      const linkedAt = new Date().toISOString();
      repos.owners.linkTelegram({
        ownerId: 'default',
        chatId: '555666777',
        username: 'alice_owner',
        linkedAtIso: linkedAt,
      });

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/status`, {
        headers: {
          Cookie: sessionCookie,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        configured: true,
        mode: 'webhook',
        botUsername: testBotUsername,
        linked: true,
        chatId: '555666777',
        username: 'alice_owner',
        linkedAt,
      });
    });

    it('returns configured: false when Telegram is disabled in config', async () => {
      await serverClose();
      await startServerWithConfig({ TELEGRAM_MODE: 'disabled' });

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/status`, {
        headers: {
          Cookie: sessionCookie,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.configured).toBe(false);
      expect(body.mode).toBe('disabled');
    });
  });

  // ==========================================================================
  // 3. POST /api/telegram/link-token
  // ==========================================================================
  describe('POST /api/telegram/link-token', () => {
    it('returns 400 TELEGRAM_DISABLED when Telegram mode is disabled', async () => {
      await serverClose();
      await startServerWithConfig({ TELEGRAM_MODE: 'disabled' });

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/link-token`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('TELEGRAM_DISABLED');
    });

    it('mints a single-use deep link, returns 200, and writes audit event without raw token', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/link-token`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        deepLink: string;
        expiresAt: string;
        ttlSeconds: number;
      };

      expect(body.success).toBe(true);
      expect(body.ttlSeconds).toBe(600);
      expect(body.deepLink).toMatch(new RegExp(`^https://t\\.me/${testBotUsername}\\?start=[A-Za-z0-9_-]{43}$`));

      const rawToken = body.deepLink.split('start=')[1]!;
      expect(rawToken).toBeDefined();

      // Verify DB stores only hash, never raw token
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const tokenRow = repos.telegramLinkTokens.getByTokenHash(tokenHash);
      expect(tokenRow).toBeDefined();
      expect(tokenRow?.owner_id).toBe('default');
      expect(tokenRow?.used_at).toBeNull();

      // Verify audit log
      const auditEntries = repos.auditLog.list();
      const mintEntry = auditEntries.find((e) => e.event === 'TELEGRAM_LINK_TOKEN_MINTED');
      expect(mintEntry).toBeDefined();
      const payload = JSON.parse(mintEntry!.payload);
      expect(payload.owner_id).toBe('default');
      expect(payload.link_token_id).toBe(tokenRow?.id);
      expect(mintEntry!.payload).not.toContain(rawToken);
    });
  });

  // ==========================================================================
  // 4. POST /api/telegram/unlink
  // ==========================================================================
  describe('POST /api/telegram/unlink', () => {
    it('returns 200 with no-op message when account is not linked', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/unlink`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toBe('Account is not linked to any Telegram chat');
      expect(sentMessages).toHaveLength(0);
    });

    it('unlinks linked account, writes audit log, and delivers best-effort Telegram notification', async () => {
      // Setup linked owner
      repos.owners.linkTelegram({
        ownerId: 'default',
        chatId: '99887766',
        userId: '99887766',
        username: 'alice_owner',
        linkedAtIso: new Date().toISOString(),
      });

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/unlink`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toBe('Telegram account unlinked successfully');

      // Verify DB owner record
      const owner = repos.owners.get('default');
      expect(owner?.telegram_chat_id).toBeNull();
      expect(owner?.telegram_user_id).toBeNull();
      expect(owner?.telegram_username).toBeNull();
      expect(owner?.telegram_linked_at).toBeNull();

      // Verify audit entry
      const auditEntries = repos.auditLog.list();
      const unlinkEntry = auditEntries.find((e) => e.event === 'TELEGRAM_ACCOUNT_UNLINKED');
      expect(unlinkEntry).toBeDefined();
      const payload = JSON.parse(unlinkEntry!.payload);
      expect(payload.owner_id).toBe('default');
      expect(payload.previous_chat_id).toBe('99887766');
      expect(payload.previous_user_id).toBe('99887766');
      expect(payload.previous_username).toBe('alice_owner');

      // Verify notification sent to previous chat
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.chat_id).toBe('99887766');
      expect(sentMessages[0]?.text).toContain('unlinked from PayGuard');
    });

    it('preserves successful database unlinking even if Telegram notification fails (fail-soft)', async () => {
      repos.owners.linkTelegram({
        ownerId: 'default',
        chatId: '99887766',
        username: 'alice_owner',
        linkedAtIso: new Date().toISOString(),
      });
      shouldSendMessageFail = true;

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/unlink`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);

      const owner = repos.owners.get('default');
      expect(owner?.telegram_chat_id).toBeNull();
    });
  });

  // ==========================================================================
  // 5. POST /api/telegram/webhook — Authentication & Pre-Parser Ordering
  // ==========================================================================
  describe('Webhook Authentication & Middleware Ordering', () => {
    it('returns 403 Forbidden when secret header is missing', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 100 }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('Unauthorized');
    });

    it('returns 403 Forbidden when secret header does not match', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: 'wrong-secret-token',
        },
        body: JSON.stringify({ update_id: 100 }),
      });

      expect(res.status).toBe(403);
    });

    it('enforces webhook auth BEFORE JSON body parsing (rejects malformed body with 403, not 400)', async () => {
      // Without valid secret, malformed JSON body should return 403, NOT 400 parse error
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: 'wrong-secret',
        },
        body: '{"invalid_json: true, broken',
      });

      expect(res.status).toBe(403);
    });

    it('returns 403 if server has no webhook secret configured', async () => {
      await serverClose();
      await startServerWithConfig({ TELEGRAM_WEBHOOK_SECRET: '' });

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({ update_id: 100 }),
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('secret not configured');
    });
  });

  // ==========================================================================
  // 6. POST /api/telegram/webhook — Deduplication & Concurrency Semantics
  // ==========================================================================
  describe('Webhook Three-State Deduplication & Concurrency', () => {
    it('returns 200 duplicate: true for already COMPLETED update_id', async () => {
      deduplicator.markCompleted(12345);

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 12345,
          message: {
            message_id: 1,
            chat: { id: 111, type: 'private' },
            text: '/start some-token',
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; duplicate: boolean };
      expect(body.ok).toBe(true);
      expect(body.duplicate).toBe(true);
      expect(sentMessages).toHaveLength(0);
    });

    it('returns 503 with Retry-After: 2 for IN_PROGRESS concurrent duplicate update', async () => {
      deduplicator.markInProgress(54321);

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 54321,
          message: {
            message_id: 1,
            chat: { id: 111, type: 'private' },
            text: '/start some-token',
          },
        }),
      });

      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('2');
      const body = (await res.json()) as { error: string; retryAfter: number };
      expect(body.error).toContain('in progress');
      expect(body.retryAfter).toBe(2);
    });

    it('clears in-progress state and returns 500 when an internal error occurs', async () => {
      const updateId = 88888;

      // Force an internal error in repository call
      const spy = vi.spyOn(repos.telegramLinkTokens, 'getByTokenHash').mockImplementationOnce(() => {
        throw new Error('Simulated SQLite disk error');
      });

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: updateId,
          message: {
            message_id: 1,
            chat: { id: 111, type: 'private' },
            from: { id: 111, is_bot: false, first_name: 'Alice' },
            text: '/start validtoken43characterslong12345678901234567',
          },
        }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Internal Server Error');

      // Deduplicator state must be cleared so Telegram retry can succeed
      expect(deduplicator.get(updateId)).toBeNull();

      spy.mockRestore();
    });
  });

  // ==========================================================================
  // 7. POST /api/telegram/webhook — Unsupported Updates & Message Validation
  // ==========================================================================
  describe('Webhook Non-Linking Updates & Validation', () => {
    it('acknowledges non-text update with 200 ignored: true', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 201,
          message: {
            message_id: 1,
            chat: { id: 111, type: 'private' },
            // text missing
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; ignored: boolean };
      expect(body.ok).toBe(true);
      expect(body.ignored).toBe(true);
      expect(deduplicator.get(201)).toBe('COMPLETED');
    });

    it('rejects non-private chats (group/channel) with warning message and 200', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 202,
          message: {
            message_id: 1,
            chat: { id: -100123456789, type: 'group' },
            text: '/start some-token',
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; ignored: string };
      expect(body.ok).toBe(true);
      expect(body.ignored).toBe('non_private_chat');
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.text).toContain('private chat');
      expect(deduplicator.get(202)).toBe('COMPLETED');
    });

    it('replies with welcome instructions when command is not /start', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 203,
          message: {
            message_id: 1,
            chat: { id: 333444, type: 'private' },
            text: '/help',
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; ignored: string };
      expect(body.ok).toBe(true);
      expect(body.ignored).toBe('not_start_command');
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.text).toContain('Welcome to PayGuard');
    });

    it('replies with setup guidance when /start is called without token', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 204,
          message: {
            message_id: 1,
            chat: { id: 333444, type: 'private' },
            text: '/start',
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; action: string };
      expect(body.ok).toBe(true);
      expect(body.action).toBe('start_without_token');
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.text).toContain('Link Telegram');
    });
  });

  // ==========================================================================
  // 8. POST /api/telegram/webhook — Atomic Account Linking & Conflict Scenarios
  // ==========================================================================
  describe('Webhook Account Linking & Atomic Conflict Handling', () => {
    it('successfully links account via /start <validToken>, logs audit event, and delivers confirmation', async () => {
      // 1. Mint token via endpoint
      const mintRes = await fetch(`http://localhost:${serverPort}/api/telegram/link-token`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
      });
      const mintData = (await mintRes.json()) as { deepLink: string };
      const rawToken = mintData.deepLink.split('start=')[1]!;

      // 2. Deliver Telegram webhook with /start <rawToken>
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 301,
          message: {
            message_id: 1,
            chat: { id: 777111, type: 'private' },
            from: { id: 777111, is_bot: false, first_name: 'Alice', username: 'alice_tg' },
            text: `/start ${rawToken}`,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; linked: boolean; ownerId: string };
      expect(body.ok).toBe(true);
      expect(body.linked).toBe(true);
      expect(body.ownerId).toBe('default');

      // Verify owner record in DB
      const owner = repos.owners.get('default');
      expect(owner?.telegram_chat_id).toBe('777111');
      expect(owner?.telegram_user_id).toBe('777111');
      expect(owner?.telegram_username).toBe('alice_tg');
      expect(owner?.telegram_linked_at).toBeDefined();

      // Verify token in DB is marked used
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const tokenRow = repos.telegramLinkTokens.getByTokenHash(tokenHash);
      expect(tokenRow?.used_at).toBeDefined();

      // Verify audit entry
      const auditEntries = repos.auditLog.list();
      const linkedEntry = auditEntries.find((e) => e.event === 'TELEGRAM_ACCOUNT_LINKED');
      expect(linkedEntry).toBeDefined();
      const auditPayload = JSON.parse(linkedEntry!.payload);
      expect(auditPayload.owner_id).toBe('default');
      expect(auditPayload.chat_id).toBe('777111');
      expect(auditPayload.telegram_user_id).toBe('777111');
      expect(auditPayload.username).toBe('alice_tg');
      expect(linkedEntry!.payload).not.toContain(rawToken);

      // Verify confirmation message was sent
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.chat_id).toBe(777111);
      expect(sentMessages[0]?.text).toContain('PayGuard account linked successfully');
      expect(deduplicator.get(301)).toBe('COMPLETED');
    });

    it('rejects replay with already used token, sends notice, and returns 200', async () => {
      // 1. Mint token
      const mintResult = mintTelegramLinkToken(db, repos, { ownerId: 'default' });
      // Mark consumed
      repos.telegramLinkTokens.consume(mintResult.tokenHash!, new Date().toISOString());

      // 2. Submit webhook with already used token
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 302,
          message: {
            message_id: 2,
            chat: { id: 777222, type: 'private' },
            from: { id: 777222, is_bot: false, first_name: 'Alice' },
            text: `/start ${mintResult.rawToken}`,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(true);
      expect(body.error).toBe('TOKEN_ALREADY_USED');

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.text).toContain('already been used');
    });

    it('rejects expired token, sends notice, and returns 200', async () => {
      const past = new Date(Date.now() - 3600 * 1000);
      const mintResult = mintTelegramLinkToken(db, repos, { ownerId: 'default', ttlSeconds: 60, now: past });

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 303,
          message: {
            message_id: 3,
            chat: { id: 777333, type: 'private' },
            from: { id: 777333, is_bot: false, first_name: 'Alice' },
            text: `/start ${mintResult.rawToken}`,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(true);
      expect(body.error).toBe('TOKEN_EXPIRED');

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.text).toContain('expired');
    });

    it('rejects malformed token format, sends notice, and returns 200', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 304,
          message: {
            message_id: 4,
            chat: { id: 777444, type: 'private' },
            from: { id: 777444, is_bot: false, first_name: 'Alice' },
            text: '/start too-short-token',
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(true);
      expect(body.error).toBe('INVALID_TOKEN_FORMAT');

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.text).toContain('Invalid linking token format');
    });

    it('rejects CONFLICTING_OWNERSHIP when owner is already linked to a different chat ID', async () => {
      // 1. Link owner to chat 111111
      repos.owners.linkTelegram({
        ownerId: 'default',
        chatId: '111111',
        username: 'alice',
        linkedAtIso: new Date().toISOString(),
      });

      // 2. Mint fresh token for owner
      const mintResult = mintTelegramLinkToken(db, repos, { ownerId: 'default' });

      // 3. User attempts to link from a different chat ID 222222
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 305,
          message: {
            message_id: 5,
            chat: { id: 222222, type: 'private' },
            from: { id: 222222, is_bot: false, first_name: 'Bob' },
            text: `/start ${mintResult.rawToken}`,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(true);
      expect(body.error).toBe('CONFLICTING_OWNERSHIP');

      // Verify owner was NOT overwritten
      const owner = repos.owners.get('default');
      expect(owner?.telegram_chat_id).toBe('111111');

      // Verify conflict audit row
      const auditEntries = repos.auditLog.list();
      const conflictEntry = auditEntries.find((e) => e.event === 'TELEGRAM_LINK_CONFLICT');
      expect(conflictEntry).toBeDefined();
      const auditPayload = JSON.parse(conflictEntry!.payload);
      expect(auditPayload.reason).toBe('OWNER_ALREADY_LINKED_TO_DIFFERENT_CHAT');

      // Verify rejection notification sent
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.text).toContain('already linked to another Telegram account');
    });

    it('rejects CHAT_ALREADY_BOUND when chat ID is bound to another owner in database', async () => {
      // 1. Ensure default owner is unlinked
      repos.owners.unlinkTelegram('default');

      // 2. Mint token for default owner
      const mintResult = mintTelegramLinkToken(db, repos, { ownerId: 'default' });

      // 3. Spy on repos.owners.getByTelegramChatId to simulate another owner holding chat 555555
      const getByChatSpy = vi.spyOn(repos.owners, 'getByTelegramChatId').mockReturnValueOnce({
        id: 'owner-other',
        display_name: 'Other Owner',
        passphrase_hash: 'hash',
        telegram_chat_id: '555555',
        telegram_username: 'other_user',
        telegram_linked_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });

      // Attempt to link with chat 555555
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 306,
          message: {
            message_id: 6,
            chat: { id: 555555, type: 'private' },
            from: { id: 555555, is_bot: false, first_name: 'Bob' },
            text: `/start ${mintResult.rawToken}`,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(true);
      expect(body.error).toBe('CHAT_ALREADY_BOUND');

      // Verify conflict audit log
      const auditEntries = repos.auditLog.list();
      const conflictEntry = auditEntries.find(
        (e) => e.event === 'TELEGRAM_LINK_CONFLICT' && JSON.parse(e.payload).reason === 'CHAT_ALREADY_BOUND_TO_ANOTHER_OWNER'
      );
      expect(conflictEntry).toBeDefined();

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.text).toContain('already linked to another PayGuard instance');

      getByChatSpy.mockRestore();
    });

    it('supports idempotent re-link from the exact same chat ID', async () => {
      // 1. Link default owner to chat 888999
      repos.owners.linkTelegram({
        ownerId: 'default',
        chatId: '888999',
        username: 'alice',
        linkedAtIso: new Date().toISOString(),
      });

      // 2. Mint fresh token
      const mintResult = mintTelegramLinkToken(db, repos, { ownerId: 'default' });

      // 3. User sends /start <token> from the same chat 888999
      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 307,
          message: {
            message_id: 7,
            chat: { id: 888999, type: 'private' },
            from: { id: 888999, is_bot: false, first_name: 'Alice', username: 'alice_updated' },
            text: `/start ${mintResult.rawToken}`,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; linked: boolean; ownerId: string };
      expect(body.ok).toBe(true);
      expect(body.linked).toBe(true);

      const owner = repos.owners.get('default');
      expect(owner?.telegram_chat_id).toBe('888999');
      expect(owner?.telegram_username).toBe('alice_updated');
    });

    it('preserves committed database link and returns 200 OK when confirmation message delivery fails (decoupled notification)', async () => {
      // Configure confirmation message to throw
      shouldSendMessageFail = true;

      const mintResult = mintTelegramLinkToken(db, repos, { ownerId: 'default' });

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 308,
          message: {
            message_id: 8,
            chat: { id: 777999, type: 'private' },
            from: { id: 777999, is_bot: false, first_name: 'Alice', username: 'alice_decoupled' },
            text: `/start ${mintResult.rawToken}`,
          },
        }),
      });

      // Must return HTTP 200 (NOT 500) because database state committed successfully!
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; linked: boolean; ownerId: string };
      expect(body.ok).toBe(true);
      expect(body.linked).toBe(true);
      expect(body.ownerId).toBe('default');

      // Database link IS committed and valid
      const owner = repos.owners.get('default');
      expect(owner?.telegram_chat_id).toBe('777999');
      expect(owner?.telegram_username).toBe('alice_decoupled');

      // Update deduplicator is COMPLETED
      expect(deduplicator.get(308)).toBe('COMPLETED');
    });

    it('rejects /start <token> fail-closed when message.from is missing without consuming token', async () => {
      const mintResult = mintTelegramLinkToken(db, repos, { ownerId: 'default' });

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 309,
          message: {
            message_id: 9,
            chat: { id: 777100, type: 'private' },
            text: `/start ${mintResult.rawToken}`,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(true);
      expect(body.error).toBe('INVALID_CALLER_IDENTITY');

      const owner = repos.owners.get('default');
      expect(owner?.telegram_chat_id).toBeNull();
      expect(owner?.telegram_user_id).toBeNull();

      const tokenRow = repos.telegramLinkTokens.getByTokenHash(mintResult.tokenHash!);
      expect(tokenRow?.used_at).toBeNull();
    });

    it('rejects /start <token> when caller is a bot (from.is_bot: true) without consuming token', async () => {
      const mintResult = mintTelegramLinkToken(db, repos, { ownerId: 'default' });

      const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 310,
          message: {
            message_id: 10,
            chat: { id: 777101, type: 'private' },
            from: { id: 777101, is_bot: true, first_name: 'FakeBot' },
            text: `/start ${mintResult.rawToken}`,
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(true);
      expect(body.error).toBe('BOT_NOT_ALLOWED');

      const tokenRow = repos.telegramLinkTokens.getByTokenHash(mintResult.tokenHash!);
      expect(tokenRow?.used_at).toBeNull();
      expect(repos.owners.get('default')?.telegram_chat_id).toBeNull();
    });

    it('rejects /start <token> when from.id is non-positive or invalid without consuming token', async () => {
      const mintResult = mintTelegramLinkToken(db, repos, { ownerId: 'default' });

      for (const [idx, badId] of [0, -42, 12.5].entries()) {
        const res = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
          },
          body: JSON.stringify({
            update_id: 311 + idx,
            message: {
              message_id: 11 + idx,
              chat: { id: 777102 + idx, type: 'private' },
              from: { id: badId, is_bot: false, first_name: 'Invalid' },
              text: `/start ${mintResult.rawToken}`,
            },
          }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; error: string };
        expect(body.error).toBe('INVALID_CALLER_IDENTITY');
      }

      const tokenRow = repos.telegramLinkTokens.getByTokenHash(mintResult.tokenHash!);
      expect(tokenRow?.used_at).toBeNull();
      expect(repos.owners.get('default')?.telegram_chat_id).toBeNull();
    });
  });

  // ==========================================================================
  // 8b. End-to-End Flow: Link -> HELD Inline Approve/Void Keyboard -> Unlink
  // ==========================================================================
  describe('End-to-End Telegram Linking & Held Payment Keyboard Integration', () => {
    it('links user via /start, generates encrypted inline Approve/Void callbacks on HELD request, and clears on unlink', async () => {
      const encKey = crypto.randomBytes(32).toString('hex');
      await serverClose();
      await startServerWithConfig({
        TELEGRAM_ENCRYPTION_KEY: encKey,
        PUBLIC_BASE_URL: 'https://payguard.example.com/',
      });

      // Seed active policy, agent, and unverified vendor (triggers HOLD without needing remote auth)
      repos.policyVersions.insert({
        id: 'pol-tg-e2e',
        version: 1,
        rules: JSON.stringify({
          version: 1,
          currency_allowlist: ['USD'],
          auto_limit_minor: toMinorUnits(2500),
          hard_cap_minor: toMinorUnits(10000),
          agent_daily_budget_minor: toMinorUnits(20000),
          global_daily_budget_minor: toMinorUnits(50000),
          velocity: { max_requests: 10, window_minutes: 10 },
          duplicate_window_minutes: 60,
          new_vendor_action: 'HOLD',
          hold_ttl_minutes: 15,
        }),
        author: 'owner',
        active: 1,
        created_at: new Date().toISOString(),
      });

      const { keyHash } = generateAgentKey();
      const agent = {
        id: 'agent-tg-e2e',
        name: 'Telegram E2E Agent',
        api_key_hash: keyHash,
        status: 'ACTIVE' as const,
        daily_budget_minor: toMinorUnits(20000),
        created_at: new Date().toISOString(),
      };
      repos.agents.insert(agent);

      repos.vendors.insert({
        id: 'ven-tg-e2e',
        name: 'New Vendor Co',
        status: 'UNVERIFIED',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'new_vendor_e2e',
        created_at: new Date().toISOString(),
      });

      // 1. Mint link token as logged-in owner
      const mintRes = await fetch(`http://localhost:${serverPort}/api/telegram/link-token`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
      });
      expect(mintRes.status).toBe(200);
      const mintBody = (await mintRes.json()) as { deepLink: string };
      const rawToken = mintBody.deepLink.split('start=')[1]!;

      // 2. Link Telegram account via webhook /start <token>
      const webhookRes = await fetch(`http://localhost:${serverPort}/api/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [TELEGRAM_SECRET_HEADER]: testWebhookSecret,
        },
        body: JSON.stringify({
          update_id: 9001,
          message: {
            message_id: 50,
            chat: { id: 888777666, type: 'private' },
            from: { id: 888777666, is_bot: false, first_name: 'Alice', username: 'alice_tg' },
            text: `/start ${rawToken}`,
          },
        }),
      });
      expect(webhookRes.status).toBe(200);

      const linkedOwner = repos.owners.get('default');
      expect(linkedOwner?.telegram_chat_id).toBe('888777666');
      expect(linkedOwner?.telegram_user_id).toBe('888777666');
      expect(linkedOwner?.telegram_linked_at).toBeTruthy();

      // 3. Submit HELD payment request using server encryption & URL settings
      const toolRes = await agentContextStorage.run({ agentId: agent.id, agent }, async () =>
        handleRequestPayment(
          db,
          {
            vendor_id: 'ven-tg-e2e',
            amount: '30.00',
            currency: 'USD',
            purpose: 'Telegram inline keyboard test',
            category: 'cloud',
            idempotency_key: 'idem-tg-e2e-1',
          },
          repos,
          {
            publicBaseUrl: 'https://payguard.example.com/',
            isProduction: true,
            telegramEncryptionKey: encKey,
          }
        )
      );
      const parsedTool = JSON.parse(
        (toolRes.content[0] as { text: string }).text
      ) as { request_id: string; status: string };
      expect(parsedTool.status).toBe('HELD');

      // 4. Verify encrypted inline Approve/Void keyboard and callbacks bound to telegram_user_id
      const callbacks = repos.telegramApprovalCallbacks.listByRequestId(parsedTool.request_id);
      expect(callbacks).toHaveLength(2);
      const approveCb = callbacks.find((c) => c.action === 'APPROVE')!;
      const voidCb = callbacks.find((c) => c.action === 'VOID')!;
      expect(approveCb.telegram_user_id).toBe('888777666');
      expect(approveCb.telegram_chat_id).toBe('888777666');
      expect(voidCb.telegram_user_id).toBe('888777666');
      expect(voidCb.used_at).toBeNull();

      const outboxRow = repos.notifications.getByDedupKey(`payment_held:${parsedTool.request_id}`)!;
      expect(outboxRow).toBeDefined();
      expect(outboxRow.recipient_chat_id).toBe('888777666');
      expect(outboxRow.message_text).toContain(
        `href="https://payguard.example.com/#/requests/${parsedTool.request_id}"`
      );
      expect(outboxRow.reply_markup_enc).toBeTruthy();

      const decryptedMarkup = decryptReplyMarkup(
        outboxRow.reply_markup_enc!,
        {
          outboxId: outboxRow.id,
          ownerId: outboxRow.owner_id,
          requestId: outboxRow.request_id!,
          recipientChatId: outboxRow.recipient_chat_id,
          linkedAt: outboxRow.linked_at,
        },
        encKey
      );
      expect(decryptedMarkup.inline_keyboard[0]).toHaveLength(2);
      expect(decryptedMarkup.inline_keyboard[0]?.[0]?.callback_data).toMatch(/^pg:app:/);
      expect(decryptedMarkup.inline_keyboard[0]?.[1]?.callback_data).toMatch(/^pg:void:/);

      // 5. Unlink via owner API invalidates pending notifications & callback tokens
      const unlinkRes = await fetch(`http://localhost:${serverPort}/api/telegram/unlink`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
      });
      expect(unlinkRes.status).toBe(200);

      const postUnlinkOwner = repos.owners.get('default');
      expect(postUnlinkOwner?.telegram_chat_id).toBeNull();
      expect(postUnlinkOwner?.telegram_user_id).toBeNull();

      const invalidatedCallbacks = repos.telegramApprovalCallbacks.listByRequestId(parsedTool.request_id);
      for (const cb of invalidatedCallbacks) {
        expect(cb.used_at).toBeTruthy();
      }
      const cancelledOutbox = repos.notifications.getById(outboxRow.id)!;
      expect(cancelledOutbox.status).toBe('CANCELLED');
    });
  });

  // ==========================================================================
  // 9. UpdateDeduplicator Unit Verification
  // ==========================================================================
  describe('UpdateDeduplicator Unit Logic', () => {
    it('prunes expired records beyond TTL', () => {
      const dedup = new UpdateDeduplicator({ ttlMs: 50 });
      dedup.markCompleted(1);
      expect(dedup.get(1)).toBe('COMPLETED');

      // Advance time beyond TTL by altering timestamp
      const records = (dedup as unknown as { records: Map<number, { timestamp: number }> }).records;
      const rec = records.get(1);
      if (rec) rec.timestamp = Date.now() - 100;

      expect(dedup.get(1)).toBeNull();
      expect(dedup.size()).toBe(0);
    });

    it('evicts oldest record when capacity is exceeded', () => {
      const dedup = new UpdateDeduplicator({ maxCapacity: 2 });
      dedup.markCompleted(1);
      dedup.markCompleted(2);
      expect(dedup.size()).toBe(2);

      dedup.markCompleted(3);
      expect(dedup.size()).toBe(2);
      expect(dedup.get(1)).toBeNull(); // oldest evicted
      expect(dedup.get(2)).toBe('COMPLETED');
      expect(dedup.get(3)).toBe('COMPLETED');
    });
  });
});
