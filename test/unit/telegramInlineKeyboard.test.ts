/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3.3 Unit Tests: Telegram Inline Keyboard Generation & Notification Outbox Integration
 *
 * Verifies all M6-T3.3 architecture and security policies:
 * 1. Cryptographically secure APPROVE and VOID token generation (32 bytes base64url).
 * 2. Hash-only persistence in telegram_approval_callbacks (zero raw tokens in DB).
 * 3. Exact metadata binding: owner_id, request_id, action, chat_id, user_id, snapshot_hash, linked_at, expires_at.
 * 4. AES-256-GCM encryption with canonical PGA1 AAD (magic header + length-prefixed NFC UTF-8 fields).
 * 5. Tamper detection: altered IV, ciphertext, tag, or AAD fields strictly fail closed.
 * 6. Key rotation: successful decryption with previous key when primary key fails.
 * 7. Selective attachment: inline keyboards attached ONLY to PAYMENT_HELD (never on alerts, warnings, denials, voids, expiry).
 * 8. Missing encryption key safety: notification sent with dashboard link only, never plaintext buttons.
 * 9. Link epoch invalidation at creation, delivery, and callback execution.
 * 10. Outbox worker decryption, Telegram sendMessage reply_markup delivery, and CAS update.
 * 11. End-to-end compatibility: generated buttons dispatched through T3.2 webhook execute cleanly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { createRepositories, type Repositories } from '../../src/db/repositories.js';
import {
  generateRawTelegramApprovalToken,
  hashTelegramApprovalToken,
  mintTelegramApprovalCallbacks,
} from '../../src/telegram/tokens.js';
import {
  buildTelegramMarkupAad,
  encryptReplyMarkup,
  decryptReplyMarkup,
  TelegramCryptoError,
  PGA1_MAGIC_HEADER,
} from '../../src/telegram/crypto.js';
import {
  enqueuePaymentNotification,
  formatPaymentHeldMessage,
  formatPaymentDeniedMessage,
  formatPaymentExpiredMessage,
  formatPaymentVoidedMessage,
} from '../../src/telegram/notifications.js';
import { NotificationOutboxWorker } from '../../src/telegram/outboxWorker.js';
import type { TelegramClient } from '../../src/telegram/client.js';
import type {
  SendMessageParams,
  TelegramMessage,
  TelegramInlineKeyboardMarkup,
} from '../../src/telegram/types.js';
import { evaluateAndReserve } from '../../src/core/service.js';
import { computeSnapshotHash } from '../../src/core/service.js';
import { toMinorUnits } from '../../src/core/money.js';
import { ApprovalExecutionService, ApprovalValidationError } from '../../src/approvals/service.js';
import type { PayPalAuthorizationsService } from '../../src/paypal/authorizations.js';

describe('M6-T3.3: Telegram Inline Keyboard Generation & Outbox Integration', () => {
  let db: Database;
  let repos: Repositories;

  const primaryKeyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex chars
  const secondaryKeyHex = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210'; // 64 hex chars

  const defaultOwnerId = 'default';
  const defaultChatId = '123456789';
  const defaultUserId = '987654321';
  const initialLinkedAt = '2026-11-04T12:00:00.000Z';

  const defaultAgentId = 'agent-1';
  const defaultVendorId = 'vendor-1';

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    const nowIso = new Date().toISOString();

    // 1. Seed Owner with Telegram linkage and numeric user ID
    repos.owners.upsert({
      id: defaultOwnerId,
      display_name: 'Security Lead',
      passphrase_hash: 'hash-pass',
      telegram_chat_id: defaultChatId,
      telegram_user_id: defaultUserId,
      telegram_username: 'sec_lead',
      telegram_linked_at: initialLinkedAt,
      created_at: nowIso,
    });

    // 2. Seed Agent
    repos.agents.insert({
      id: defaultAgentId,
      name: 'Test Agent',
      api_key_hash: 'hash-agent',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(10000),
      created_at: nowIso,
    });

    // 3. Seed Vendor
    repos.vendors.insert({
      id: defaultVendorId,
      name: 'Acme Cloud Hosting',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: nowIso,
    });

    // 4. Seed Active Policy Version
    repos.policyVersions.insert({
      id: 'pol-test-1',
      version: 1,
      author: 'owner',
      rules: JSON.stringify({
        version: 1,
        currency_allowlist: ['USD'],
        auto_limit_minor: 1500, // $15.00
        hard_cap_minor: 50000,  // $500.00
        agent_daily_budget_minor: 50000,
        global_daily_budget_minor: 100000,
        velocity: { max_requests: 10, window_minutes: 60 },
        duplicate_window_minutes: 60,
        new_vendor_action: 'HOLD',
        hold_ttl_minutes: 15,
      }),
      active: 1,
      created_at: nowIso,
    });
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
  });

  // Helper to seed a valid HELD payment request
  function seedHeldRequest(options?: { id?: string; amountMinor?: number; expiresAt?: string }) {
    const requestId = options?.id ?? `req-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const amountMinor = toMinorUnits(options?.amountMinor ?? 5000);
    const nowIso = new Date().toISOString();
    const expiresAt = options?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const snapshotHash = computeSnapshotHash({
      requestId,
      agentId: defaultAgentId,
      vendorId: defaultVendorId,
      amountMinor,
      currency: 'USD',
      purpose: 'Infrastructure hosting',
      category: 'cloud',
    });

    repos.paymentRequests.insert({
      id: requestId,
      agent_id: defaultAgentId,
      vendor_id: defaultVendorId,
      amount_minor: amountMinor,
      currency: 'USD',
      purpose: 'Infrastructure hosting',
      category: 'cloud',
      source_context_excerpt: null,
      source_context_hash: null,
      idempotency_key: `idem-${requestId}`,
      status: 'HELD',
      decision: 'HOLD',
      reasons: JSON.stringify(['AMOUNT_THRESHOLD_EXCEEDED']),
      policy_version_id: repos.policyVersions.getActive()!.id,
      snapshot_hash: snapshotHash,
      paypal_order_id: null,
      paypal_authorization_id: 'AUTH-12345',
      paypal_capture_id: null,
      expires_at: expiresAt,
      created_at: nowIso,
      updated_at: nowIso,
    });

    return { requestId, amountMinor, snapshotHash, expiresAt };
  }

  // ==========================================================================
  // 1. Callback Token Generation & Hash-Only Persistence
  // ==========================================================================
  describe('1. Token Generation & Hash-Only Storage', () => {
    it('generates 32-byte base64url random tokens (43 URL-safe characters)', () => {
      const token1 = generateRawTelegramApprovalToken();
      const token2 = generateRawTelegramApprovalToken();

      expect(typeof token1).toBe('string');
      expect(token1.length).toBe(43);
      expect(/^[A-Za-z0-9_-]+$/.test(token1)).toBe(true);
      expect(token1).not.toBe(token2);
    });

    it('computes deterministic 64-character SHA-256 hex digest', () => {
      const rawToken = generateRawTelegramApprovalToken();
      const hash1 = hashTelegramApprovalToken(rawToken);
      const hash2 = hashTelegramApprovalToken(rawToken);

      expect(hash1.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
      expect(hash1).toBe(hash2);
    });

    it('mints separate APPROVE and VOID tokens and persists ONLY hashes with full metadata', () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();

      const result = mintTelegramApprovalCallbacks({
        repos,
        requestId,
        ownerId: defaultOwnerId,
        telegramChatId: defaultChatId,
        telegramUserId: defaultUserId,
        linkedAt: initialLinkedAt,
        snapshotHash,
        expiresAt,
      });

      expect(result.rawApproveToken).toBeDefined();
      expect(result.rawVoidToken).toBeDefined();
      expect(result.rawApproveToken).not.toBe(result.rawVoidToken);

      // Verify APPROVE row in database
      const approveRow = repos.telegramApprovalCallbacks.getByTokenHash(result.approveTokenHash);
      expect(approveRow).toBeDefined();
      expect(approveRow?.action).toBe('APPROVE');
      expect(approveRow?.request_id).toBe(requestId);
      expect(approveRow?.owner_id).toBe(defaultOwnerId);
      expect(approveRow?.telegram_chat_id).toBe(defaultChatId);
      expect(approveRow?.telegram_user_id).toBe(defaultUserId);
      expect(approveRow?.snapshot_hash).toBe(snapshotHash);
      expect(approveRow?.linked_at).toBe(initialLinkedAt);
      expect(approveRow?.used_at).toBeNull();

      // Verify VOID row in database
      const voidRow = repos.telegramApprovalCallbacks.getByTokenHash(result.voidTokenHash);
      expect(voidRow).toBeDefined();
      expect(voidRow?.action).toBe('VOID');
      expect(voidRow?.request_id).toBe(requestId);
      expect(voidRow?.linked_at).toBe(initialLinkedAt);

      // Verify raw tokens NEVER appear anywhere in the database tables
      const allRows = repos.telegramApprovalCallbacks.listByRequestId(requestId);
      for (const row of allRows) {
        expect(row.token_hash).not.toBe(result.rawApproveToken);
        expect(row.token_hash).not.toBe(result.rawVoidToken);
      }
    });

    it('keeps Telegram callback_data within 64-byte Telegram limit', () => {
      const rawToken = generateRawTelegramApprovalToken(); // 43 chars
      const approveData = `pg:app:${rawToken}`;
      const voidData = `pg:void:${rawToken}`;

      expect(Buffer.byteLength(approveData, 'utf8')).toBe(50); // <= 64
      expect(Buffer.byteLength(voidData, 'utf8')).toBe(51); // <= 64
      expect(Buffer.byteLength(approveData, 'utf8')).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(voidData, 'utf8')).toBeLessThanOrEqual(64);
    });

    it('rejects missing, empty, or whitespace-only link epoch at runtime without creating callback records', () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();
      const initialCount = (db.prepare('SELECT COUNT(*) as c FROM telegram_approval_callbacks').get() as { c: number }).c;

      // 1. Empty string
      expect(() => {
        mintTelegramApprovalCallbacks({
          repos,
          requestId,
          ownerId: defaultOwnerId,
          telegramChatId: defaultChatId,
          telegramUserId: defaultUserId,
          linkedAt: '',
          snapshotHash,
          expiresAt,
        });
      }).toThrow(/Valid non-empty linkedAt link epoch string is required/);

      // 2. Whitespace-only string
      expect(() => {
        mintTelegramApprovalCallbacks({
          repos,
          requestId,
          ownerId: defaultOwnerId,
          telegramChatId: defaultChatId,
          telegramUserId: defaultUserId,
          linkedAt: '   \t\n  ',
          snapshotHash,
          expiresAt,
        });
      }).toThrow(/Valid non-empty linkedAt link epoch string is required/);

      // 3. Non-string (cast)
      expect(() => {
        mintTelegramApprovalCallbacks({
          repos,
          requestId,
          ownerId: defaultOwnerId,
          telegramChatId: defaultChatId,
          telegramUserId: defaultUserId,
          linkedAt: null as unknown as string,
          snapshotHash,
          expiresAt,
        });
      }).toThrow(/Valid non-empty linkedAt link epoch string is required/);

      // Verify zero rows were inserted on failed validation
      const finalCount = (db.prepare('SELECT COUNT(*) as c FROM telegram_approval_callbacks').get() as { c: number }).c;
      expect(finalCount).toBe(initialCount);
    });

    it('preserves read compatibility for legacy database rows with NULL linked_at', () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();
      const rawToken = generateRawTelegramApprovalToken();
      const tokenHash = hashTelegramApprovalToken(rawToken);
      const legacyId = 'cb-legacy-null-epoch';

      // Insert directly via SQL to simulate a pre-migration 011 row
      db.prepare(`
        INSERT INTO telegram_approval_callbacks (
          id, token_hash, request_id, owner_id, action,
          telegram_chat_id, telegram_user_id, snapshot_hash,
          expires_at, used_at, linked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        legacyId,
        tokenHash,
        requestId,
        defaultOwnerId,
        'APPROVE',
        defaultChatId,
        defaultUserId,
        snapshotHash,
        expiresAt,
        new Date().toISOString()
      );

      // Row is cleanly readable via getByTokenHash
      const rowByHash = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
      expect(rowByHash).toBeDefined();
      expect(rowByHash?.id).toBe(legacyId);
      expect(rowByHash?.linked_at).toBeNull();

      // Row is cleanly readable via listByRequestId
      const rowsByReq = repos.telegramApprovalCallbacks.listByRequestId(requestId);
      const found = rowsByReq.find((r) => r.id === legacyId);
      expect(found).toBeDefined();
      expect(found?.linked_at).toBeNull();
    });
  });

  // ==========================================================================
  // 2. AES-256-GCM Encryption with Canonical PGA1 AAD Contract
  // ==========================================================================
  describe('2. AES-256-GCM Encryption & Canonical PGA1 AAD', () => {
    const sampleMarkup: TelegramInlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: 'pg:app:mock-token-approve' },
          { text: '🚫 Void', callback_data: 'pg:void:mock-token-void' },
        ],
      ],
    };

    const sampleAad = {
      outboxId: 'outbox-12345',
      ownerId: 'default',
      requestId: 'req-67890',
      recipientChatId: '123456789',
      linkedAt: '2026-11-04T12:00:00.000Z',
    };

    it('builds canonical PGA1 binary AAD buffer with 2-byte big-endian length prefixing', () => {
      const aadBuf = buildTelegramMarkupAad(sampleAad);

      // 1. Starts with PGA1 magic header (4 bytes)
      expect(aadBuf.subarray(0, 4)).toEqual(PGA1_MAGIC_HEADER);

      // 2. First field: outboxId (length 12)
      const outboxLen = aadBuf.readUInt16BE(4);
      expect(outboxLen).toBe(sampleAad.outboxId.length);
      const outboxStr = aadBuf.subarray(6, 6 + outboxLen).toString('utf8');
      expect(outboxStr).toBe(sampleAad.outboxId);
    });

    it('encrypts markup into version 1 JSON envelope and decrypts cleanly', () => {
      const encryptedJson = encryptReplyMarkup(sampleMarkup, sampleAad, primaryKeyHex);
      expect(typeof encryptedJson).toBe('string');

      const parsedEnvelope = JSON.parse(encryptedJson) as {
        v: number;
        iv: string;
        ct: string;
        tag: string;
      };
      expect(parsedEnvelope.v).toBe(1);
      expect(parsedEnvelope.iv.length).toBe(24); // 12 bytes hex
      expect(parsedEnvelope.tag.length).toBe(32); // 16 bytes hex
      expect(parsedEnvelope.ct.length).toBeGreaterThan(0);

      const decrypted = decryptReplyMarkup(encryptedJson, sampleAad, primaryKeyHex);
      expect(decrypted).toEqual(sampleMarkup);
    });

    it('fails closed when Additional Authenticated Data (AAD) is altered (context binding)', () => {
      const encryptedJson = encryptReplyMarkup(sampleMarkup, sampleAad, primaryKeyHex);

      // Tampered recipient chat ID
      expect(() => {
        decryptReplyMarkup(
          encryptedJson,
          { ...sampleAad, recipientChatId: '999999999' },
          primaryKeyHex
        );
      }).toThrow(TelegramCryptoError);

      // Tampered owner ID
      expect(() => {
        decryptReplyMarkup(encryptedJson, { ...sampleAad, ownerId: 'other-owner' }, primaryKeyHex);
      }).toThrow(TelegramCryptoError);

      // Tampered request ID
      expect(() => {
        decryptReplyMarkup(encryptedJson, { ...sampleAad, requestId: 'req-tampered' }, primaryKeyHex);
      }).toThrow(TelegramCryptoError);

      // Tampered linked_at (link epoch)
      expect(() => {
        decryptReplyMarkup(
          encryptedJson,
          { ...sampleAad, linkedAt: '2026-11-04T13:00:00.000Z' },
          primaryKeyHex
        );
      }).toThrow(TelegramCryptoError);

      // Tampered outbox ID
      expect(() => {
        decryptReplyMarkup(
          encryptedJson,
          { ...sampleAad, outboxId: 'outbox-different' },
          primaryKeyHex
        );
      }).toThrow(TelegramCryptoError);
    });

    it('fails closed when ciphertext or authentication tag is tampered', () => {
      const encryptedJson = encryptReplyMarkup(sampleMarkup, sampleAad, primaryKeyHex);
      const envelope = JSON.parse(encryptedJson) as {
        v: number;
        iv: string;
        ct: string;
        tag: string;
      };

      // Tampered ciphertext (guaranteed to differ)
      const tamperedCt = (envelope.ct[0] === 'a' ? 'b' : 'a') + envelope.ct.slice(1);
      expect(() => {
        decryptReplyMarkup(
          JSON.stringify({ ...envelope, ct: tamperedCt }),
          sampleAad,
          primaryKeyHex
        );
      }).toThrow(TelegramCryptoError);

      // Tampered tag (guaranteed to differ)
      const tamperedTag = (envelope.tag[0] === '0' ? '1' : '0') + envelope.tag.slice(1);
      expect(() => {
        decryptReplyMarkup(
          JSON.stringify({ ...envelope, tag: tamperedTag }),
          sampleAad,
          primaryKeyHex
        );
      }).toThrow(TelegramCryptoError);

      // Tampered IV (guaranteed to differ)
      const tamperedIv = (envelope.iv[0] === '0' ? '1' : '0') + envelope.iv.slice(1);
      expect(() => {
        decryptReplyMarkup(
          JSON.stringify({ ...envelope, iv: tamperedIv }),
          sampleAad,
          primaryKeyHex
        );
      }).toThrow(TelegramCryptoError);
    });

    it('supports key rotation: decrypts using previous key when primary key fails', () => {
      // Encrypt with secondary key (simulating old key before rotation)
      const encryptedWithSecondary = encryptReplyMarkup(sampleMarkup, sampleAad, secondaryKeyHex);

      // Decrypt where primaryKey is new key, but previousKey is secondary key
      const decrypted = decryptReplyMarkup(
        encryptedWithSecondary,
        sampleAad,
        primaryKeyHex,
        secondaryKeyHex
      );

      expect(decrypted).toEqual(sampleMarkup);
    });
  });

  // ==========================================================================
  // 3. Selective Button Attachment & Notification Types
  // ==========================================================================
  describe('3. Selective Button Attachment & Safe Enqueue', () => {
    it('attaches encrypted reply markup ONLY to PAYMENT_HELD notifications', () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();
      const messageText = formatPaymentHeldMessage({
        requestId,
        amountDecimal: '50.00',
        currency: 'USD',
        vendorName: 'Acme Cloud Hosting',
        purpose: 'Cloud server hosting',
        expiresAt,
        publicBaseUrl: 'http://localhost:3000',
      });

      const res = enqueuePaymentNotification(repos, {
        eventType: 'PAYMENT_HELD',
        requestId,
        dedupKey: `payment_held:${requestId}`,
        messageText,
        snapshotHash,
        expiresAt,
        encryptionKey: primaryKeyHex,
      });

      expect(res.enqueued).toBe(true);
      const row = repos.notifications.getById(res.id!);
      expect(row).toBeDefined();
      expect(row?.event_type).toBe('PAYMENT_HELD');
      expect(row?.reply_markup_enc).toBeDefined();
      expect(row?.reply_markup_enc).not.toBeNull();

      // Verify the encrypted markup can be decrypted and matches expected structure
      const decrypted = decryptReplyMarkup(
        row!.reply_markup_enc!,
        {
          outboxId: row!.id,
          ownerId: defaultOwnerId,
          requestId,
          recipientChatId: defaultChatId,
          linkedAt: initialLinkedAt,
        },
        primaryKeyHex
      );
      expect(decrypted.inline_keyboard.length).toBe(1);
      expect(decrypted.inline_keyboard[0]?.[0]?.text).toContain('Approve');
      expect(decrypted.inline_keyboard[0]?.[1]?.text).toContain('Void');
    });

    it('NEVER attaches buttons to PAYMENT_DENIED, PAYMENT_VOIDED, or PAYMENT_EXPIRED', () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();

      // 1. PAYMENT_DENIED
      const deniedText = formatPaymentDeniedMessage({
        requestId,
        amountDecimal: '50.00',
        currency: 'USD',
        vendorName: 'Acme Cloud Hosting',
        reasons: ['Policy violation'],
      });
      const resDenied = enqueuePaymentNotification(repos, {
        eventType: 'PAYMENT_DENIED',
        requestId,
        dedupKey: `denied:${requestId}`,
        messageText: deniedText,
        snapshotHash,
        expiresAt,
        encryptionKey: primaryKeyHex,
      });
      const deniedRow = repos.notifications.getById(resDenied.id!);
      expect(deniedRow?.reply_markup_enc).toBeNull();

      // 2. PAYMENT_VOIDED
      const voidedText = formatPaymentVoidedMessage({
        requestId,
        amountDecimal: '50.00',
        currency: 'USD',
        vendorName: 'Acme Cloud Hosting',
        remoteVoidStatus: 'CONFIRMED',
      });
      const resVoided = enqueuePaymentNotification(repos, {
        eventType: 'PAYMENT_VOIDED',
        requestId,
        dedupKey: `voided:${requestId}`,
        messageText: voidedText,
        snapshotHash,
        expiresAt,
        encryptionKey: primaryKeyHex,
      });
      const voidedRow = repos.notifications.getById(resVoided.id!);
      expect(voidedRow?.reply_markup_enc).toBeNull();

      // 3. PAYMENT_EXPIRED
      const expiredText = formatPaymentExpiredMessage({
        requestId,
        amountDecimal: '50.00',
        currency: 'USD',
        vendorName: 'Acme Cloud Hosting',
      });
      const resExpired = enqueuePaymentNotification(repos, {
        eventType: 'PAYMENT_EXPIRED',
        requestId,
        dedupKey: `expired:${requestId}`,
        messageText: expiredText,
        snapshotHash,
        expiresAt,
        encryptionKey: primaryKeyHex,
      });
      const expiredRow = repos.notifications.getById(resExpired.id!);
      expect(expiredRow?.reply_markup_enc).toBeNull();
    });

    it('safely omits buttons when encryption key is missing (never emits plaintext buttons)', () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();
      const messageText = formatPaymentHeldMessage({
        requestId,
        amountDecimal: '50.00',
        currency: 'USD',
        vendorName: 'Acme Cloud Hosting',
        purpose: 'Cloud server hosting',
        expiresAt,
        publicBaseUrl: 'http://localhost:3000',
      });

      // Enqueue without encryptionKey
      const res = enqueuePaymentNotification(repos, {
        eventType: 'PAYMENT_HELD',
        requestId,
        dedupKey: `payment_held_no_key:${requestId}`,
        messageText,
        snapshotHash,
        expiresAt,
        encryptionKey: undefined,
      });

      expect(res.enqueued).toBe(true);
      const row = repos.notifications.getById(res.id!);
      // Crucial: reply_markup_enc is null, and zero plaintext buttons or tokens exist
      expect(row?.reply_markup_enc).toBeNull();
      const callbacks = repos.telegramApprovalCallbacks.listByRequestId(requestId);
      expect(callbacks.length).toBe(0);
    });

    it('safely skips button generation if owner lacks numeric telegram_user_id', () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();

      // Remove numeric telegram_user_id from owner
      db.prepare('UPDATE owners SET telegram_user_id = NULL WHERE id = ?').run(defaultOwnerId);

      const messageText = formatPaymentHeldMessage({
        requestId,
        amountDecimal: '50.00',
        currency: 'USD',
        vendorName: 'Acme Cloud Hosting',
        purpose: 'Cloud server hosting',
        expiresAt,
        publicBaseUrl: 'http://localhost:3000',
      });

      const res = enqueuePaymentNotification(repos, {
        eventType: 'PAYMENT_HELD',
        requestId,
        dedupKey: `payment_held_no_user_id:${requestId}`,
        messageText,
        snapshotHash,
        expiresAt,
        encryptionKey: primaryKeyHex,
      });

      expect(res.enqueued).toBe(true);
      const row = repos.notifications.getById(res.id!);
      expect(row?.reply_markup_enc).toBeNull();
    });
  });

  // ==========================================================================
  // 4. Link Epoch Validation, Unlinking & Invalidation
  // ==========================================================================
  describe('4. Link Epoch Binding & Unlink Invalidation', () => {
    it('cancels outbox dispatch and invalidates callbacks if owner unlinked before delivery', async () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();
      const messageText = 'Payment held for review';

      const res = enqueuePaymentNotification(repos, {
        eventType: 'PAYMENT_HELD',
        requestId,
        dedupKey: `held_unlink_test:${requestId}`,
        messageText,
        snapshotHash,
        expiresAt,
        encryptionKey: primaryKeyHex,
      });

      // Simulate owner unlinking before outbox worker runs
      const nowIso = new Date().toISOString();
      repos.owners.unlinkTelegram(defaultOwnerId);
      repos.telegramApprovalCallbacks.invalidateForOwner(defaultOwnerId, nowIso);

      const sentMessages: SendMessageParams[] = [];
      const mockClient = {
        sendMessage: vi.fn(async (params: SendMessageParams): Promise<TelegramMessage> => {
          sentMessages.push(params);
          return { message_id: 100, date: Math.floor(Date.now() / 1000), chat: { id: 123456789, type: 'private' }, text: params.text };
        }),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({
        repos,
        telegramClient: mockClient,
        encryptionKey: primaryKeyHex,
      });

      await worker.tick();

      // Outbox row is marked CANCELLED with OWNER_UNLINKED
      const row = repos.notifications.getById(res.id!);
      expect(row?.status).toBe('CANCELLED');
      expect(row?.last_error).toBe('OWNER_UNLINKED');

      // Telegram client was NOT called
      expect(mockClient.sendMessage).not.toHaveBeenCalled();

      // Callbacks for request were invalidated
      const callbacks = repos.telegramApprovalCallbacks.listByRequestId(requestId);
      expect(callbacks.length).toBe(2);
      expect(callbacks[0]?.used_at).not.toBeNull();
      expect(callbacks[1]?.used_at).not.toBeNull();
    });

    it('cancels outbox dispatch if owner relinked with a different link epoch (STALE_LINK_EPOCH)', async () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();
      const messageText = 'Payment held for review';

      const res = enqueuePaymentNotification(repos, {
        eventType: 'PAYMENT_HELD',
        requestId,
        dedupKey: `held_epoch_test:${requestId}`,
        messageText,
        snapshotHash,
        expiresAt,
        encryptionKey: primaryKeyHex,
      });

      // Simulate owner relinking (new link epoch)
      const newLinkedAt = '2026-11-04T15:30:00.000Z';
      repos.owners.linkTelegram({
        ownerId: defaultOwnerId,
        chatId: defaultChatId,
        username: 'new_username',
        linkedAtIso: newLinkedAt,
      });

      const mockClient = {
        sendMessage: vi.fn(),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({
        repos,
        telegramClient: mockClient,
        encryptionKey: primaryKeyHex,
      });

      await worker.tick();

      const row = repos.notifications.getById(res.id!);
      expect(row?.status).toBe('CANCELLED');
      expect(row?.last_error).toBe('STALE_LINK_EPOCH');
      expect(mockClient.sendMessage).not.toHaveBeenCalled();
    });

    it('rejects callback execution if link epoch does not match current owner epoch', async () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();

      const mintRes = mintTelegramApprovalCallbacks({
        repos,
        requestId,
        ownerId: defaultOwnerId,
        telegramChatId: defaultChatId,
        telegramUserId: defaultUserId,
        linkedAt: initialLinkedAt,
        snapshotHash,
        expiresAt,
      });

      // Change owner's linked_at epoch in database
      const newLinkedAt = '2026-11-04T18:00:00.000Z';
      repos.owners.linkTelegram({
        ownerId: defaultOwnerId,
        chatId: defaultChatId,
        username: 'relinked_owner',
        linkedAtIso: newLinkedAt,
      });

      const service = new ApprovalExecutionService({ db, repos });

      // Attempt to execute callback query minted under the old epoch
      await expect(
        service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken: mintRes.rawApproveToken,
            telegramUserId: defaultUserId,
            telegramChatId: defaultChatId,
          },
        })
      ).rejects.toThrow(/previous Telegram link epoch/);
    });

    it('fails closed: legacy callback with NULL linked_at cannot APPROVE via ApprovalExecutionService', async () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();
      const rawToken = generateRawTelegramApprovalToken();
      const tokenHash = hashTelegramApprovalToken(rawToken);

      // Insert legacy callback record with linked_at = NULL (pre-migration 011 state)
      db.prepare(`
        INSERT INTO telegram_approval_callbacks (
          id, token_hash, request_id, owner_id, action,
          telegram_chat_id, telegram_user_id, snapshot_hash,
          expires_at, used_at, linked_at, created_at
        ) VALUES (?, ?, ?, ?, 'APPROVE', ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        'cb-legacy-app-reject',
        tokenHash,
        requestId,
        defaultOwnerId,
        defaultChatId,
        defaultUserId,
        snapshotHash,
        expiresAt,
        new Date().toISOString()
      );

      const service = new ApprovalExecutionService({ db, repos });

      let caughtErr: unknown;
      try {
        await service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken: rawToken,
            telegramUserId: defaultUserId,
            telegramChatId: defaultChatId,
          },
        });
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(ApprovalValidationError);
      const valErr = caughtErr as ApprovalValidationError;
      expect(valErr.code).toBe('STALE_LINK_EPOCH');
      expect(valErr.statusCode).toBe(403);

      // Verify request state remains HELD and callback is unconsumed
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('HELD');
      const cb = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
      expect(cb?.used_at).toBeNull();
    });

    it('fails closed: legacy callback with NULL linked_at cannot VOID via ApprovalExecutionService', async () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();
      const rawToken = generateRawTelegramApprovalToken();
      const tokenHash = hashTelegramApprovalToken(rawToken);

      // Insert legacy callback record with linked_at = NULL (pre-migration 011 state)
      db.prepare(`
        INSERT INTO telegram_approval_callbacks (
          id, token_hash, request_id, owner_id, action,
          telegram_chat_id, telegram_user_id, snapshot_hash,
          expires_at, used_at, linked_at, created_at
        ) VALUES (?, ?, ?, ?, 'VOID', ?, ?, ?, ?, NULL, NULL, ?)
      `).run(
        'cb-legacy-void-reject',
        tokenHash,
        requestId,
        defaultOwnerId,
        defaultChatId,
        defaultUserId,
        snapshotHash,
        expiresAt,
        new Date().toISOString()
      );

      const service = new ApprovalExecutionService({ db, repos });

      let caughtErr: unknown;
      try {
        await service.execute({
          action: 'VOID',
          credentials: {
            channel: 'telegram',
            rawCallbackToken: rawToken,
            telegramUserId: defaultUserId,
            telegramChatId: defaultChatId,
          },
        });
      } catch (err) {
        caughtErr = err;
      }

      expect(caughtErr).toBeInstanceOf(ApprovalValidationError);
      const valErr = caughtErr as ApprovalValidationError;
      expect(valErr.code).toBe('STALE_LINK_EPOCH');
      expect(valErr.statusCode).toBe(403);

      // Verify request state remains HELD and callback is unconsumed
      const req = repos.paymentRequests.getById(requestId);
      expect(req?.status).toBe('HELD');
      const cb = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
      expect(cb?.used_at).toBeNull();
    });

    it('fails closed: callback with empty or whitespace-only link epoch cannot execute', async () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();
      const rawToken = generateRawTelegramApprovalToken();
      const tokenHash = hashTelegramApprovalToken(rawToken);

      // Insert record with whitespace-only linked_at directly via SQL
      db.prepare(`
        INSERT INTO telegram_approval_callbacks (
          id, token_hash, request_id, owner_id, action,
          telegram_chat_id, telegram_user_id, snapshot_hash,
          expires_at, used_at, linked_at, created_at
        ) VALUES (?, ?, ?, ?, 'APPROVE', ?, ?, ?, ?, NULL, '   ', ?)
      `).run(
        'cb-ws-epoch',
        tokenHash,
        requestId,
        defaultOwnerId,
        defaultChatId,
        defaultUserId,
        snapshotHash,
        expiresAt,
        new Date().toISOString()
      );

      const service = new ApprovalExecutionService({ db, repos });

      await expect(
        service.execute({
          action: 'APPROVE',
          credentials: {
            channel: 'telegram',
            rawCallbackToken: rawToken,
            telegramUserId: defaultUserId,
            telegramChatId: defaultChatId,
          },
        })
      ).rejects.toThrow(/previous Telegram link epoch/);
    });

    it('succeeds: callback matching current link epoch executes successfully for both APPROVE and VOID', async () => {
      // 1. APPROVE with matching epoch
      const held1 = seedHeldRequest();
      const mint1 = mintTelegramApprovalCallbacks({
        repos,
        requestId: held1.requestId,
        ownerId: defaultOwnerId,
        telegramChatId: defaultChatId,
        telegramUserId: defaultUserId,
        linkedAt: initialLinkedAt,
        snapshotHash: held1.snapshotHash,
        expiresAt: held1.expiresAt,
      });

      const mockAuthService = {
        captureAuthorization: vi.fn().mockResolvedValue({
          id: 'CAP-MATCH-1',
          status: 'COMPLETED',
          isCaptured: true,
        }),
        voidAuthorization: vi.fn().mockResolvedValue({
          id: 'AUTH-12345',
          status: 'VOIDED',
          isVoided: true,
        }),
      } as unknown as PayPalAuthorizationsService;

      const service = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthService,
      });

      const approveOutcome = await service.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'telegram',
          rawCallbackToken: mint1.rawApproveToken,
          telegramUserId: defaultUserId,
          telegramChatId: defaultChatId,
        },
      });
      expect(approveOutcome.success).toBe(true);
      expect(approveOutcome.status).toBe('CAPTURED');

      // 2. VOID with matching epoch
      const held2 = seedHeldRequest();
      const mint2 = mintTelegramApprovalCallbacks({
        repos,
        requestId: held2.requestId,
        ownerId: defaultOwnerId,
        telegramChatId: defaultChatId,
        telegramUserId: defaultUserId,
        linkedAt: initialLinkedAt,
        snapshotHash: held2.snapshotHash,
        expiresAt: held2.expiresAt,
      });

      const voidOutcome = await service.execute({
        action: 'VOID',
        credentials: {
          channel: 'telegram',
          rawCallbackToken: mint2.rawVoidToken,
          telegramUserId: defaultUserId,
          telegramChatId: defaultChatId,
        },
      });
      expect(voidOutcome.success).toBe(true);
      expect(voidOutcome.status).toBe('VOIDED');
    });
  });

  // ==========================================================================
  // 5. Outbox Worker Decryption, Dispatch & Error Handling
  // ==========================================================================
  describe('5. Outbox Worker Decryption & Dispatch', () => {
    it('successfully claims outbox row, decrypts markup, and delivers with reply_markup', async () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();
      const messageText = 'Payment held for review';

      const res = enqueuePaymentNotification(repos, {
        eventType: 'PAYMENT_HELD',
        requestId,
        dedupKey: `outbox_dispatch_test:${requestId}`,
        messageText,
        snapshotHash,
        expiresAt,
        encryptionKey: primaryKeyHex,
      });

      let deliveredParams: SendMessageParams | undefined;
      const mockClient = {
        sendMessage: vi.fn(async (params: SendMessageParams): Promise<TelegramMessage> => {
          deliveredParams = params;
          return {
            message_id: 888,
            date: Math.floor(Date.now() / 1000),
            chat: { id: parseInt(defaultChatId, 10), type: 'private' },
            text: params.text,
            reply_markup: params.reply_markup,
          };
        }),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({
        repos,
        telegramClient: mockClient,
        encryptionKey: primaryKeyHex,
      });

      const processed = await worker.tick();
      expect(processed).toBe(1);

      // Verify delivered payload to Telegram client
      expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(deliveredParams).toBeDefined();
      expect(deliveredParams?.chat_id).toBe(defaultChatId);
      expect(deliveredParams?.reply_markup).toBeDefined();
      expect(deliveredParams?.reply_markup?.inline_keyboard[0]?.[0]?.text).toContain('Approve');
      expect(deliveredParams?.reply_markup?.inline_keyboard[0]?.[1]?.text).toContain('Void');

      // Verify database outbox row updated to SENT
      const updatedRow = repos.notifications.getById(res.id!);
      expect(updatedRow?.status).toBe('SENT');
      expect(updatedRow?.telegram_message_id).toBe(888);
      expect(updatedRow?.sent_at).not.toBeNull();
    });

    it('fails closed when outbox row markup is corrupted (does not dispatch stripped message)', async () => {
      const { requestId, snapshotHash, expiresAt } = seedHeldRequest();

      const res = enqueuePaymentNotification(repos, {
        eventType: 'PAYMENT_HELD',
        requestId,
        dedupKey: `corrupted_markup_test:${requestId}`,
        messageText: 'Payment held for review',
        snapshotHash,
        expiresAt,
        encryptionKey: primaryKeyHex,
      });

      // Corrupt the ciphertext in the database
      db.prepare("UPDATE notification_outbox SET reply_markup_enc = '{\"v\":1,\"iv\":\"00\",\"ct\":\"bad\",\"tag\":\"00\"}' WHERE id = ?").run(res.id!);

      const mockClient = {
        sendMessage: vi.fn(),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({
        repos,
        telegramClient: mockClient,
        encryptionKey: primaryKeyHex,
      });

      await worker.tick();

      // Telegram client was NOT called
      expect(mockClient.sendMessage).not.toHaveBeenCalled();

      // Notification is marked for retry (status remains PENDING with incremented attempt_count and recorded last_error)
      const failedRow = repos.notifications.getById(res.id!);
      expect(failedRow?.status).toBe('PENDING');
      expect(failedRow?.attempt_count).toBe(1);
      expect(failedRow?.last_error).toContain('TelegramCryptoError');
    });
  });

  // ==========================================================================
  // 6. End-to-End Core Integration & Callback Execution Compatibility
  // ==========================================================================
  describe('6. End-to-End evaluateAndReserve & Approval Execution Flow', () => {
    it('evaluates payment as HOLD, enqueues encrypted buttons, decrypts, and executes APPROVE', async () => {
      // 1. Trigger evaluateAndReserve in HOLD condition (amount > $100)
      const evalResult = evaluateAndReserve(
        db,
        {
          agentId: defaultAgentId,
          vendorId: defaultVendorId,
          amountMinor: toMinorUnits(15000), // $150.00
          currency: 'USD',
          purpose: 'High memory GPU cluster',
          idempotencyKey: 'idem-gpu-cluster-1',
          autoExecute: false,
          telegramEncryptionKey: primaryKeyHex,
        },
        repos
      );

      expect(evalResult.decision).toBe('HOLD');
      const requestId = evalResult.request.id;

      // Simulate PayPal authorization hold established on PayPal sandbox
      repos.paymentRequests.updatePayPalIds(requestId, {
        authorizationId: 'AUTH-GPU-CLUSTER-1',
        updatedAt: new Date().toISOString(),
      });

      // 2. Outbox row was atomically inserted in the same transaction
      const outboxRows = db
        .prepare('SELECT * FROM notification_outbox WHERE request_id = ?')
        .all(requestId) as Array<{ id: string; reply_markup_enc: string }>;
      expect(outboxRows.length).toBe(1);
      expect(outboxRows[0]?.reply_markup_enc).toBeDefined();

      // 3. Outbox worker processes row and extracts callback buttons
      let capturedMarkup: TelegramInlineKeyboardMarkup | undefined;
      const mockClient = {
        sendMessage: vi.fn(async (params: SendMessageParams): Promise<TelegramMessage> => {
          capturedMarkup = params.reply_markup;
          return { message_id: 999, date: Math.floor(Date.now() / 1000), chat: { id: 123456789, type: 'private' }, text: params.text };
        }),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({
        repos,
        telegramClient: mockClient,
        encryptionKey: primaryKeyHex,
      });
      await worker.tick();

      expect(capturedMarkup).toBeDefined();
      const firstRow = capturedMarkup?.inline_keyboard[0];
      const approveBtn = firstRow?.[0];
      expect(approveBtn).toBeDefined();
      const approveCallbackData = approveBtn?.callback_data ?? '';
      expect(approveCallbackData.startsWith('pg:app:')).toBe(true);
      const rawApproveToken = approveCallbackData.slice(7);

      // 4. Dispatch the extracted token to ApprovalExecutionService
      const mockAuthService = {
        captureAuthorization: vi.fn().mockResolvedValue({
          id: 'CAP-999',
          status: 'COMPLETED',
          isCaptured: true,
        }),
      } as unknown as PayPalAuthorizationsService;

      const approvalService = new ApprovalExecutionService({
        db,
        repos,
        authorizationsService: mockAuthService,
      });

      const outcome = await approvalService.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'telegram',
          rawCallbackToken: rawApproveToken,
          telegramUserId: defaultUserId,
          telegramChatId: defaultChatId,
        },
      });

      expect(outcome.success).toBe(true);
      expect(outcome.action).toBe('APPROVE');
      expect(outcome.status).toBe('CAPTURED');

      // Verify request transitioned to CAPTURED
      const finalReq = repos.paymentRequests.getById(requestId);
      expect(finalReq?.status).toBe('CAPTURED');
    });
  });
});
