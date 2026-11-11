import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createDatabase,
  runMigrations,
  runInTransaction,
  createRepositories,
  type Database,
} from '../../src/db/index.js';
import type { Repositories } from '../../src/db/repositories.js';
import { toMinorUnits } from '../../src/core/money.js';

describe('Telegram Approval Callbacks Repository & Migration 10 (M6-T3-D Subtask 1)', () => {
  let db: Database;
  let repos: Repositories;

  const nowIso = new Date().toISOString();
  const futureIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const pastIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    // Setup base owner
    repos.owners.upsert({
      id: 'default',
      display_name: 'Test Owner',
      passphrase_hash: 'hash-abc',
      telegram_chat_id: '123456789',
      telegram_user_id: '987654321',
      created_at: nowIso,
    });

    // Setup base agent
    repos.agents.insert({
      id: 'agent-1',
      name: 'Test Agent',
      api_key_hash: 'key-hash-1',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(1000),
      created_at: nowIso,
    });

    // Setup base vendor
    repos.vendors.insert({
      id: 'vendor-1',
      name: 'Acme Corp',
      status: 'ACTIVE',
      categories: JSON.stringify(['saas']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'paypal_connector',
      created_at: nowIso,
    });

    // Setup base payment request
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
      snapshot_hash: 'snap-hash-001',
      paypal_order_id: null,
      paypal_authorization_id: 'auth-001',
      paypal_capture_id: null,
      expires_at: futureIso,
      created_at: nowIso,
      updated_at: nowIso,
    });
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
  });

  describe('1. Hash-Only Callback Token Persistence', () => {
    it('persists callback tokens by SHA-256 hash without requiring raw tokens', () => {
      const rawToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

      const created = repos.telegramApprovalCallbacks.insert({
        token_hash: tokenHash,
        request_id: 'req-001',
        owner_id: 'default',
        action: 'APPROVE',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        linked_at: nowIso,
      });

      expect(created.id).toBeDefined();
      expect(created.token_hash).toBe(tokenHash);
      expect(created.action).toBe('APPROVE');
      expect(created.telegram_chat_id).toBe('123456789');
      expect(created.telegram_user_id).toBe('987654321');
      expect(created.snapshot_hash).toBe('snap-hash-001');
      expect(created.expires_at).toBe(futureIso);
      expect(created.used_at).toBeNull();
      expect(created.linked_at).toBe(nowIso);

      // Retrieve by hash
      const foundByHash = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
      expect(foundByHash).toBeDefined();
      expect(foundByHash?.id).toBe(created.id);
      expect(foundByHash?.token_hash).toBe(tokenHash);
      expect(foundByHash?.linked_at).toBe(nowIso);

      // Retrieve by ID
      const foundById = repos.telegramApprovalCallbacks.getById(created.id);
      expect(foundById).toEqual(foundByHash);
    });

    it('enforces UNIQUE constraint on token_hash', () => {
      const tokenHash = 'duplicate-hash-123';

      repos.telegramApprovalCallbacks.insert({
        token_hash: tokenHash,
        request_id: 'req-001',
        owner_id: 'default',
        action: 'APPROVE',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        linked_at: nowIso,
      });

      expect(() => {
        repos.telegramApprovalCallbacks.insert({
          token_hash: tokenHash,
          request_id: 'req-001',
          owner_id: 'default',
          action: 'VOID',
          telegram_chat_id: '123456789',
          telegram_user_id: '987654321',
          snapshot_hash: 'snap-hash-001',
          expires_at: futureIso,
          linked_at: nowIso,
        });
      }).toThrowError(/UNIQUE constraint failed/);
    });
  });

  describe('2. Foreign Keys & Integrity Constraints', () => {
    it('fails closed when request_id does not exist', () => {
      expect(() => {
        repos.telegramApprovalCallbacks.insert({
          token_hash: 'hash-nonexistent-req',
          request_id: 'req-nonexistent',
          owner_id: 'default',
          action: 'APPROVE',
          telegram_chat_id: '123456789',
          telegram_user_id: '987654321',
          snapshot_hash: 'snap-hash-001',
          expires_at: futureIso,
          linked_at: nowIso,
        });
      }).toThrowError(/FOREIGN KEY constraint failed/);
    });

    it('fails closed when owner_id does not exist', () => {
      expect(() => {
        repos.telegramApprovalCallbacks.insert({
          token_hash: 'hash-nonexistent-owner',
          request_id: 'req-001',
          owner_id: 'nonexistent-owner',
          action: 'APPROVE',
          telegram_chat_id: '123456789',
          telegram_user_id: '987654321',
          snapshot_hash: 'snap-hash-001',
          expires_at: futureIso,
          linked_at: nowIso,
        });
      }).toThrowError(/FOREIGN KEY constraint failed/);
    });

    it('enforces action CHECK constraint (APPROVE or VOID)', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO telegram_approval_callbacks (
            id, token_hash, request_id, owner_id, action,
            telegram_chat_id, telegram_user_id, snapshot_hash,
            expires_at, used_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'id-invalid-action',
          'hash-invalid-action',
          'req-001',
          'default',
          'CANCEL_PAYMENT', // Invalid action
          '123456789',
          '987654321',
          'snap-hash-001',
          futureIso,
          null,
          nowIso
        );
      }).toThrowError(/CHECK constraint failed/);
    });

    it('cascades deletion when payment_request is deleted', () => {
      const tokenHash = 'hash-cascade-req';
      repos.telegramApprovalCallbacks.insert({
        token_hash: tokenHash,
        request_id: 'req-001',
        owner_id: 'default',
        action: 'APPROVE',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        linked_at: nowIso,
      });

      expect(repos.telegramApprovalCallbacks.getByTokenHash(tokenHash)).toBeDefined();

      // Delete payment request
      db.prepare('DELETE FROM payment_requests WHERE id = ?').run('req-001');

      // Callback should be cascaded
      expect(repos.telegramApprovalCallbacks.getByTokenHash(tokenHash)).toBeUndefined();
    });
  });

  describe('3. Atomic Single-Use Consumption (CAS)', () => {
    it('marks callback used on first attempt and prevents replay on second attempt', () => {
      const tokenHash = 'hash-single-use-cas';
      repos.telegramApprovalCallbacks.insert({
        token_hash: tokenHash,
        request_id: 'req-001',
        owner_id: 'default',
        action: 'APPROVE',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        linked_at: nowIso,
      });

      const consumeTime = new Date().toISOString();

      // First attempt: succeeds (CAS changes 1 row)
      const firstMark = repos.telegramApprovalCallbacks.markUsed(tokenHash, consumeTime);
      expect(firstMark).toBe(true);

      const consumedRow = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
      expect(consumedRow?.used_at).toBe(consumeTime);

      // Second attempt (replay attack / rapid double click): fails (CAS changes 0 rows)
      const secondMark = repos.telegramApprovalCallbacks.markUsed(tokenHash, new Date().toISOString());
      expect(secondMark).toBe(false);

      // used_at timestamp remains unchanged
      const rowAfterReplay = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
      expect(rowAfterReplay?.used_at).toBe(consumeTime);
    });
  });

  describe('4. Sibling & Cross-Channel Invalidation', () => {
    it('invalidates sibling Telegram callback tokens for the same request', () => {
      const approveHash = 'hash-sibling-app';
      const voidHash = 'hash-sibling-void';

      repos.telegramApprovalCallbacks.insert({
        token_hash: approveHash,
        request_id: 'req-001',
        owner_id: 'default',
        action: 'APPROVE',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        linked_at: nowIso,
      });

      repos.telegramApprovalCallbacks.insert({
        token_hash: voidHash,
        request_id: 'req-001',
        owner_id: 'default',
        action: 'VOID',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        linked_at: nowIso,
      });

      // Owner approves using approveHash
      const consumed = repos.telegramApprovalCallbacks.markUsed(approveHash);
      expect(consumed).toBe(true);

      // Invalidate all sibling callbacks for req-001
      const invalidatedCount = repos.telegramApprovalCallbacks.invalidateForRequest('req-001');
      expect(invalidatedCount).toBe(1); // voidHash was unconsumed, so it gets invalidated

      // voidHash is now marked used and cannot be consumed
      const voidRow = repos.telegramApprovalCallbacks.getByTokenHash(voidHash);
      expect(voidRow?.used_at).toBeDefined();

      const voidConsumeAttempt = repos.telegramApprovalCallbacks.markUsed(voidHash);
      expect(voidConsumeAttempt).toBe(false);
    });

    it('invalidates both Web approval tokens and Telegram callback tokens across channels', () => {
      // 1. Insert Web approval token in approvals table
      const webTokenHash = 'hash-web-token-123';
      repos.approvals.insert({
        id: 'app-web-1',
        request_id: 'req-001',
        token_hash: webTokenHash,
        action: 'APPROVE',
        expires_at: futureIso,
        used_at: null,
        channel: 'web',
        created_at: nowIso,
      });

      // 2. Insert Telegram callback token in telegram_approval_callbacks table
      const telegramTokenHash = 'hash-telegram-callback-123';
      repos.telegramApprovalCallbacks.insert({
        token_hash: telegramTokenHash,
        request_id: 'req-001',
        owner_id: 'default',
        action: 'APPROVE',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        linked_at: nowIso,
      });

      // 3. Perform cross-channel invalidation
      const result = repos.invalidateAllApprovalsForRequest('req-001');
      expect(result.webInvalidated).toBe(1);
      expect(result.telegramInvalidated).toBe(1);

      // 4. Verify both are consumed and cannot be reused
      expect(repos.approvals.getByTokenHash(webTokenHash)?.used_at).toBeDefined();
      expect(repos.approvals.markUsed(webTokenHash)).toBe(false);

      expect(repos.telegramApprovalCallbacks.getByTokenHash(telegramTokenHash)?.used_at).toBeDefined();
      expect(repos.telegramApprovalCallbacks.markUsed(telegramTokenHash)).toBe(false);
    });

    it('invalidates active callbacks scoped to a specific owner on unlink', () => {
      repos.telegramApprovalCallbacks.insert({
        token_hash: 'hash-owner-unlink-1',
        request_id: 'req-001',
        owner_id: 'default',
        action: 'APPROVE',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        linked_at: nowIso,
      });

      const invalidated = repos.telegramApprovalCallbacks.invalidateForOwner('default');
      expect(invalidated).toBe(1);

      const row = repos.telegramApprovalCallbacks.getByTokenHash('hash-owner-unlink-1');
      expect(row?.used_at).toBeDefined();
    });
  });

  describe('5. Active & Expiry Listing', () => {
    it('returns only active, unexpired, and unconsumed callbacks for a request', () => {
      // Active callback
      repos.telegramApprovalCallbacks.insert({
        id: 'cb-active',
        token_hash: 'hash-active',
        request_id: 'req-001',
        owner_id: 'default',
        action: 'APPROVE',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        linked_at: nowIso,
      });

      // Expired callback
      repos.telegramApprovalCallbacks.insert({
        id: 'cb-expired',
        token_hash: 'hash-expired',
        request_id: 'req-001',
        owner_id: 'default',
        action: 'VOID',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: pastIso,
        linked_at: nowIso,
      });

      // Consumed callback
      repos.telegramApprovalCallbacks.insert({
        id: 'cb-consumed',
        token_hash: 'hash-consumed',
        request_id: 'req-001',
        owner_id: 'default',
        action: 'APPROVE',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        used_at: nowIso,
        linked_at: nowIso,
      });

      const allCallbacks = repos.telegramApprovalCallbacks.listByRequestId('req-001');
      expect(allCallbacks.length).toBe(3);

      const activeCallbacks = repos.telegramApprovalCallbacks.listActiveByRequestId('req-001', nowIso);
      expect(activeCallbacks.length).toBe(1);
      expect(activeCallbacks[0]?.id).toBe('cb-active');
    });
  });

  describe('6. Transaction Atomicity & Rollback', () => {
    it('rolls back callback state changes if an error occurs within transaction', () => {
      const tokenHash = 'hash-tx-rollback';
      repos.telegramApprovalCallbacks.insert({
        token_hash: tokenHash,
        request_id: 'req-001',
        owner_id: 'default',
        action: 'APPROVE',
        telegram_chat_id: '123456789',
        telegram_user_id: '987654321',
        snapshot_hash: 'snap-hash-001',
        expires_at: futureIso,
        linked_at: nowIso,
      });

      expect(() => {
        runInTransaction(db, () => {
          repos.telegramApprovalCallbacks.markUsed(tokenHash);
          // Simulate failure before transaction commits
          throw new Error('Simulated atomic failure');
        });
      }).toThrow('Simulated atomic failure');

      // Callback must remain unconsumed after rollback
      const row = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
      expect(row?.used_at).toBeNull();
    });
  });

  describe('7. Owners Telegram User ID Persistence', () => {
    it('persists telegram_user_id via linkTelegram and clears it on unlinkTelegram', () => {
      repos.owners.linkTelegram({
        ownerId: 'default',
        chatId: '777888999',
        userId: '111222333',
        username: 'alice_telegram',
      });

      const linkedOwner = repos.owners.get('default');
      expect(linkedOwner?.telegram_chat_id).toBe('777888999');
      expect(linkedOwner?.telegram_user_id).toBe('111222333');
      expect(linkedOwner?.telegram_username).toBe('alice_telegram');

      // Query by numeric Telegram user ID
      const foundByUser = repos.owners.getByTelegramUserId('111222333');
      expect(foundByUser?.id).toBe('default');

      // Unlink
      repos.owners.unlinkTelegram('default');
      const unlinkedOwner = repos.owners.get('default');
      expect(unlinkedOwner?.telegram_chat_id).toBeNull();
      expect(unlinkedOwner?.telegram_user_id).toBeNull();
      expect(unlinkedOwner?.telegram_username).toBeNull();
    });
  });

  describe('8. Notification Outbox reply_markup_enc Persistence', () => {
    it('enqueues and retrieves encrypted reply markup envelope', () => {
      const encryptedEnvelope = JSON.stringify({
        v: 1,
        iv: '0123456789abcdef01234567',
        ct: 'abcdef0123456789',
        tag: '9876543210fedcba9876543210fedcba',
      });

      const { id } = repos.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: nowIso,
        request_id: 'req-001',
        dedup_key: 'dedup-markup-test-1',
        message_text: 'Payment requires approval',
        reply_markup_enc: encryptedEnvelope,
      });

      const retrieved = repos.notifications.getById(id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.reply_markup_enc).toBe(encryptedEnvelope);
    });
  });
});
