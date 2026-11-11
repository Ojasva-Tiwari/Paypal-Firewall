/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T4.4: Terminal Telegram Re-Attestation Scheduling, Scoped Message Lookup,
 * Cooperative Supersession Fencing & Crash Recovery Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDatabase, runMigrations } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/repositories.js';
import type { Database } from '../../src/db/connection.js';
import type { Repositories } from '../../src/db/repositories.js';
import { NotificationOutboxWorker } from '../../src/telegram/outboxWorker.js';
import { TelegramClient, TelegramApiError } from '../../src/telegram/client.js';
import { enqueuePaymentTerminalOutcome } from '../../src/telegram/notifications.js';
import { toMinorUnits } from '../../src/core/money.js';
import type { PaymentRequestRow } from '../../src/db/types.js';

describe('M6-T4.4: Terminal Telegram Re-Attestation & Resilience', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    // Seed Owner with linked Telegram
    repos.owners.upsert({
      id: 'default',
      display_name: 'Primary Owner',
      passphrase_hash: 'hash',
      telegram_chat_id: 'chat-111',
      created_at: '2026-11-04T00:00:00.000Z',
    });
    repos.owners.linkTelegram({
      ownerId: 'default',
      chatId: 'chat-111',
      username: 'testowner',
      linkedAtIso: '2026-11-04T00:00:00.000Z',
    });

    // Seed Agent
    repos.agents.insert({
      id: 'agent-1',
      name: 'Purchasing Agent',
      api_key_hash: 'hash',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(10000),
      created_at: '2026-11-04T00:00:00.000Z',
    });

    // Seed Vendor
    repos.vendors.insert({
      id: 'ven-1',
      name: 'Vendor One',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: '2026-11-04T00:00:00.000Z',
    });
  });

  function seedPayment(id: string, overrides: Partial<PaymentRequestRow> = {}): PaymentRequestRow {
    const row: PaymentRequestRow = {
      id,
      agent_id: 'agent-1',
      idempotency_key: `idem-${id}`,
      vendor_id: 'ven-1',
      amount_minor: toMinorUnits(50),
      currency: 'USD',
      purpose: 'Testing re-attestation',
      category: 'cloud',
      source_context_excerpt: null,
      source_context_hash: null,
      status: 'APPROVED',
      decision: 'APPROVE',
      reasons: JSON.stringify([]),
      policy_version_id: null,
      snapshot_hash: null,
      paypal_order_id: null,
      paypal_authorization_id: null,
      paypal_capture_id: null,
      expires_at: null,
      remote_void_status: null,
      created_at: '2026-11-04T00:00:00.000Z',
      updated_at: '2026-11-04T00:00:00.000Z',
      ...overrides,
    };
    repos.paymentRequests.insert(row);
    return row;
  }

  // ==========================================================================
  // 1. Mandatory Schedule: Three Durable Passes at T+15s, T+45s, T+105s
  // ==========================================================================
  describe('Mandatory Schedule: Three Durable Passes at T+15s, T+45s, T+105s', () => {
    it('automatically schedules exactly three re-attestation passes in SQLite upon primary terminal delivery', async () => {
      const reqId = 'req-sched-1';
      seedPayment(reqId);

      const mockTelegram = {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1001, ok: true }),
        editMessageText: vi.fn().mockResolvedValue({ message_id: 1001, ok: true }),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({ repos, telegramClient: mockTelegram, db });

      // Enqueue primary terminal notification
      enqueuePaymentTerminalOutcome(repos, {
        eventType: 'PAYMENT_CAPTURED',
        requestId: reqId,
        dedupKey: `payment_captured:${reqId}`,
        messageText: 'Authoritative Terminal Text',
        ownerId: 'default',
      });

      // Deliver primary notification
      const processed = await worker.tick();
      expect(processed).toBe(1);

      // Verify primary notification is SENT with telegram_message_id
      const primary = repos.notifications.getByDedupKey(`payment_captured:${reqId}`);
      expect(primary?.status).toBe('SENT');
      expect(primary?.telegram_message_id).toBe(1001);
      expect(primary?.sent_at).toBeDefined();

      const sentAtMs = new Date(primary!.sent_at!).getTime();

      // Verify Pass 1 (T+15s)
      const pass1 = repos.notifications.getByDedupKey(`terminal_reattest:${reqId}:1`);
      expect(pass1).toBeDefined();
      expect(pass1?.status).toBe('PENDING');
      expect(pass1?.max_attempts).toBe(1);
      expect(pass1?.telegram_message_id).toBe(1001);
      expect(new Date(pass1!.next_attempt_at).getTime()).toBe(sentAtMs + 15_000);

      // Verify Pass 2 (T+45s)
      const pass2 = repos.notifications.getByDedupKey(`terminal_reattest:${reqId}:2`);
      expect(pass2).toBeDefined();
      expect(pass2?.status).toBe('PENDING');
      expect(pass2?.max_attempts).toBe(1);
      expect(pass2?.telegram_message_id).toBe(1001);
      expect(new Date(pass2!.next_attempt_at).getTime()).toBe(sentAtMs + 45_000);

      // Verify Pass 3 (T+105s)
      const pass3 = repos.notifications.getByDedupKey(`terminal_reattest:${reqId}:3`);
      expect(pass3).toBeDefined();
      expect(pass3?.status).toBe('PENDING');
      expect(pass3?.max_attempts).toBe(1);
      expect(pass3?.telegram_message_id).toBe(1001);
      expect(new Date(pass3!.next_attempt_at).getTime()).toBe(sentAtMs + 105_000);
    });

    it('does NOT schedule re-attestations for intermediate or non-terminal notifications', async () => {
      const reqId = 'req-sched-intermediate';
      seedPayment(reqId);

      const mockTelegram = {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 2002, ok: true }),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({ repos, telegramClient: mockTelegram, db });

      // Enqueue intermediate PAYMENT_HELD notification
      repos.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: 'chat-111',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_held:${reqId}`,
        message_text: 'Hold Text',
        request_id: reqId,
      });

      await worker.tick();

      const held = repos.notifications.getByDedupKey(`payment_held:${reqId}`);
      expect(held?.status).toBe('SENT');

      // Verify zero re-attestation passes were created
      const pass1 = repos.notifications.getByDedupKey(`terminal_reattest:${reqId}:1`);
      expect(pass1).toBeUndefined();
    });
  });

  // ==========================================================================
  // 2. Scoped Message ID Lookup: Owner, Chat ID, and Link Epoch Isolation
  // ==========================================================================
  describe('Scoped Message ID Lookup Isolation', () => {
    it('reuses existing message ID when owner, chat ID and link epoch all match', () => {
      const reqId = 'req-scope-match';
      seedPayment(reqId);

      // Existing held notification marked SENT with message_id 555
      repos.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: 'chat-111',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_held:${reqId}`,
        message_text: 'Hold',
        request_id: reqId,
      });
      db.prepare(`UPDATE notification_outbox SET status = 'SENT', telegram_message_id = 555 WHERE dedup_key = ?`).run(`payment_held:${reqId}`);

      const foundId = repos.notifications.findActiveMessageIdForRequest({
        requestId: reqId,
        ownerId: 'default',
        recipientChatId: 'chat-111',
        linkedAt: '2026-11-04T00:00:00.000Z',
      });
      expect(foundId).toBe(555);

      // Terminal outcome enqueues with scoped message ID
      enqueuePaymentTerminalOutcome(repos, {
        eventType: 'PAYMENT_CAPTURED',
        requestId: reqId,
        dedupKey: `payment_captured:${reqId}`,
        messageText: 'Captured',
        ownerId: 'default',
      });

      const term = repos.notifications.getByDedupKey(`payment_captured:${reqId}`);
      expect(term?.telegram_message_id).toBe(555);
    });

    it('rejects message ID lookup when owner relinked with a new epoch (stale link session)', () => {
      const reqId = 'req-scope-epoch';
      seedPayment(reqId);

      repos.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: 'chat-111',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z', // Old epoch
        dedup_key: `payment_held:${reqId}`,
        message_text: 'Hold',
        request_id: reqId,
      });
      db.prepare(`UPDATE notification_outbox SET status = 'SENT', telegram_message_id = 666 WHERE dedup_key = ?`).run(`payment_held:${reqId}`);

      // Owner relinked: new epoch 2026-11-05
      const foundId = repos.notifications.findActiveMessageIdForRequest({
        requestId: reqId,
        ownerId: 'default',
        recipientChatId: 'chat-111',
        linkedAt: '2026-11-05T00:00:00.000Z', // Fresh epoch
      });
      expect(foundId).toBeNull();
    });

    it('rejects message ID lookup when chat ID differs (different Telegram account)', () => {
      const reqId = 'req-scope-chat';
      seedPayment(reqId);

      repos.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: 'chat-111',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_held:${reqId}`,
        message_text: 'Hold',
        request_id: reqId,
      });
      db.prepare(`UPDATE notification_outbox SET status = 'SENT', telegram_message_id = 777 WHERE dedup_key = ?`).run(`payment_held:${reqId}`);

      const foundId = repos.notifications.findActiveMessageIdForRequest({
        requestId: reqId,
        ownerId: 'default',
        recipientChatId: 'chat-different',
        linkedAt: '2026-11-04T00:00:00.000Z',
      });
      expect(foundId).toBeNull();
    });
  });

  // ==========================================================================
  // 3. Concurrent Intermediate Race: Pre-Dispatch & CAS Commit Fencing
  // ==========================================================================
  describe('Concurrent Intermediate Notification Supersession Fencing', () => {
    it('aborts intermediate dispatch pre-dispatch when SUPERSEDED_PENDING flag is detected', async () => {
      const reqId = 'req-race-predispatch';
      seedPayment(reqId);

      const telegramCalls: string[] = [];
      const mockTelegram = {
        editMessageText: vi.fn().mockImplementation(async () => {
          telegramCalls.push('editMessageText');
          return { message_id: 888, ok: true };
        }),
        sendMessage: vi.fn().mockImplementation(async () => {
          telegramCalls.push('sendMessage');
          return { message_id: 888, ok: true };
        }),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({ repos, telegramClient: mockTelegram, db });

      // Enqueue intermediate row
      repos.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: 'chat-111',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_held:${reqId}`,
        message_text: 'Held',
        request_id: reqId,
      });

      // Claim row into PROCESSING (simulating worker picking it up)
      const claimed = repos.notifications.claimPending('worker-claim-1', new Date().toISOString(), 1);
      expect(claimed.length).toBe(1);
      expect(claimed[0]?.status).toBe('PROCESSING');

      // Now terminal outcome arrives concurrently and supersedes intermediate rows
      repos.notifications.supersedeIntermediateForRequest(reqId);

      // Verify the in-flight row now has SUPERSEDED_PENDING in database
      const live = repos.notifications.getByDedupKey(`payment_held:${reqId}`);
      expect(live?.last_error).toContain('SUPERSEDED_PENDING');

      // Worker processes the claimed in-memory batch item
      // We trigger processRow indirectly by running tick on this claim or invoking worker
      // If we call tick again, the worker checks abandoned leases or claims pending;
      // To test the exact in-flight processRow pre-dispatch check:
      const workerInternal = worker as unknown as {
        processRow: (row: NonNullable<typeof claimed[0]>, claimId: string) => Promise<void>;
      };
      await workerInternal.processRow(claimed[0]!, 'worker-claim-1');

      // Zero Telegram API calls were made!
      expect(telegramCalls.length).toBe(0);

      // Row transitioned to CANCELLED
      const after = repos.notifications.getByDedupKey(`payment_held:${reqId}`);
      expect(after?.status).toBe('CANCELLED');
    });

    it('CAS commit fence: markSent refuses to commit SENT if row was marked SUPERSEDED_PENDING', () => {
      const reqId = 'req-race-cas';
      seedPayment(reqId);

      repos.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: 'chat-111',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_held:${reqId}`,
        message_text: 'Held',
        request_id: reqId,
      });

      const claimed = repos.notifications.claimPending('claim-cas-test', new Date().toISOString(), 1);
      expect(claimed.length).toBe(1);

      // Concurrently tagged as superseded
      repos.notifications.supersedeIntermediateForRequest(reqId);

      // Attempt markSent with valid claim ID
      const sent = repos.notifications.markSent(claimed[0]!.id, 'claim-cas-test', 9999);

      // CAS refused to mark SENT!
      expect(sent).toBe(false);

      const row = repos.notifications.getById(claimed[0]!.id);
      expect(row?.status).not.toBe('SENT');
    });
  });

  // ==========================================================================
  // 4. Strictly Edit-Only Re-Attestation Guardrails
  // ==========================================================================
  describe('Strictly Edit-Only Re-Attestation Guardrails', () => {
    it('re-attestation pass missing valid telegram_message_id fails closed to DEAD without sendMessage', async () => {
      const reqId = 'req-editonly-missing-id';
      seedPayment(reqId);

      let sendCalled = false;
      let editCalled = false;
      const mockTelegram = {
        sendMessage: vi.fn().mockImplementation(async () => {
          sendCalled = true;
          return { message_id: 111, ok: true };
        }),
        editMessageText: vi.fn().mockImplementation(async () => {
          editCalled = true;
          return { message_id: 111, ok: true };
        }),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({ repos, telegramClient: mockTelegram, db });

      // Enqueue corrupted re-attestation pass with null telegram_message_id
      repos.notifications.enqueue({
        event_type: 'PAYMENT_CAPTURED',
        recipient_chat_id: 'chat-111',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `terminal_reattest:${reqId}:1`,
        message_text: 'Reattest Text',
        request_id: reqId,
      });

      // Advance next_attempt_at so worker can claim it
      db.prepare(`UPDATE notification_outbox SET next_attempt_at = '2020-01-01T00:00:00.000Z' WHERE dedup_key = ?`).run(`terminal_reattest:${reqId}:1`);

      await worker.tick();

      // Zero Telegram calls
      expect(sendCalled).toBe(false);
      expect(editCalled).toBe(false);

      // Marked DEAD immediately
      const row = repos.notifications.getByDedupKey(`terminal_reattest:${reqId}:1`);
      expect(row?.status).toBe('DEAD');
      expect(row?.last_error).toContain('RE_ATTESTATION_FAILED');

      // Audit log entry recorded
      const logs = repos.auditLog.listByRequestId(reqId);
      expect(logs.some((l) => l.event === 'TELEGRAM_TERMINAL_RE_ATTESTATION_EXHAUSTED')).toBe(true);
    });

    it('re-attestation pass with valid telegram_message_id calls editMessageText, never sendMessage', async () => {
      const reqId = 'req-editonly-valid';
      seedPayment(reqId);

      let sendCalled = false;
      let editedId = 0;
      const mockTelegram = {
        sendMessage: vi.fn().mockImplementation(async () => {
          sendCalled = true;
          return { message_id: 999, ok: true };
        }),
        editMessageText: vi.fn().mockImplementation(async (params: { message_id: number }) => {
          editedId = params.message_id;
          return { message_id: params.message_id, ok: true };
        }),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({ repos, telegramClient: mockTelegram, db });

      repos.notifications.enqueue({
        event_type: 'PAYMENT_CAPTURED',
        recipient_chat_id: 'chat-111',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `terminal_reattest:${reqId}:1`,
        message_text: 'Reattest Text',
        request_id: reqId,
        telegram_message_id: 8888,
      });

      db.prepare(`UPDATE notification_outbox SET next_attempt_at = '2020-01-01T00:00:00.000Z' WHERE dedup_key = ?`).run(`terminal_reattest:${reqId}:1`);

      await worker.tick();

      expect(sendCalled).toBe(false);
      expect(editedId).toBe(8888);

      const row = repos.notifications.getByDedupKey(`terminal_reattest:${reqId}:1`);
      expect(row?.status).toBe('SENT');
    });
  });

  // ==========================================================================
  // 5. Ambiguous Initial Send vs Idempotent Edit Recovery
  // ==========================================================================
  describe('Ambiguous Initial Send vs Idempotent Edit Recovery', () => {
    it('initial sendMessage timeout on null message ID fails closed to DEAD without retry', async () => {
      const reqId = 'req-ambig-send';
      seedPayment(reqId);

      const mockTelegram = {
        sendMessage: vi.fn().mockRejectedValue(new Error('ETIMEDOUT: Connection dropped to Telegram')),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({ repos, telegramClient: mockTelegram, db });

      enqueuePaymentTerminalOutcome(repos, {
        eventType: 'PAYMENT_CAPTURED',
        requestId: reqId,
        dedupKey: `payment_captured:${reqId}`,
        messageText: 'Captured Text',
        ownerId: 'default',
      });

      await worker.tick();

      const row = repos.notifications.getByDedupKey(`payment_captured:${reqId}`);
      expect(row?.status).toBe('DEAD');
      expect(row?.last_error).toContain('AMBIGUOUS_SEND_MESSAGE');

      // Zero re-attestation passes scheduled on ambiguous send failure!
      const pass1 = repos.notifications.getByDedupKey(`terminal_reattest:${reqId}:1`);
      expect(pass1).toBeUndefined();
    });

    it('existing-message edit returning 400 not modified recovers as idempotent SENT and schedules passes', async () => {
      const reqId = 'req-edit-400-recovery';
      seedPayment(reqId);

      // Existing message was 7777
      const mockTelegram = {
        editMessageText: vi.fn().mockRejectedValue(
          new TelegramApiError({
            code: 400,
            message: 'Bad Request: message is not modified: content identical',
            description: 'Bad Request: message is not modified: content identical',
          })
        ),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({ repos, telegramClient: mockTelegram, db });

      // Pre-seed prior held notification to simulate known message ID 7777
      repos.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: 'chat-111',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_held:${reqId}`,
        message_text: 'Held Text',
        request_id: reqId,
        telegram_message_id: 7777,
      });
      db.prepare(`UPDATE notification_outbox SET status = 'SENT', telegram_message_id = 7777 WHERE dedup_key = ?`).run(`payment_held:${reqId}`);

      // Enqueue terminal outcome (will inherit message ID 7777 via scoped lookup)
      enqueuePaymentTerminalOutcome(repos, {
        eventType: 'PAYMENT_CAPTURED',
        requestId: reqId,
        dedupKey: `payment_captured:${reqId}`,
        messageText: 'Captured Text',
        ownerId: 'default',
      });

      await worker.tick();

      const row = repos.notifications.getByDedupKey(`payment_captured:${reqId}`);
      expect(row?.status).toBe('SENT');
      expect(row?.telegram_message_id).toBe(7777);

      // All three re-attestations scheduled with message ID 7777
      const pass1 = repos.notifications.getByDedupKey(`terminal_reattest:${reqId}:1`);
      expect(pass1).toBeDefined();
      expect(pass1?.telegram_message_id).toBe(7777);
      expect(pass1?.status).toBe('PENDING');
    });
  });

  // ==========================================================================
  // 6. Restart Recovery Across Process / Worker Restarts
  // ==========================================================================
  describe('Restart Recovery Across Process / Worker Restarts', () => {
    it('fresh worker instance created after process exit recovers and delivers passes sequentially', async () => {
      const reqId = 'req-restart-recovery';
      seedPayment(reqId);

      let editsDelivered = 0;
      const mockTelegram = {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 4444, ok: true }),
        editMessageText: vi.fn().mockImplementation(async () => {
          editsDelivered++;
          return { message_id: 4444, ok: true };
        }),
      } as unknown as TelegramClient;

      // Worker 1 delivers primary notification
      const worker1 = new NotificationOutboxWorker({ repos, telegramClient: mockTelegram, db });
      enqueuePaymentTerminalOutcome(repos, {
        eventType: 'PAYMENT_CAPTURED',
        requestId: reqId,
        dedupKey: `payment_captured:${reqId}`,
        messageText: 'Primary Terminal',
        ownerId: 'default',
      });

      await worker1.tick();
      expect(repos.notifications.getByDedupKey(`payment_captured:${reqId}`)?.status).toBe('SENT');

      // Simulate process crash and restart: create fresh worker2 and fresh repos over same DB
      const freshRepos = createRepositories(db);
      const worker2 = new NotificationOutboxWorker({ repos: freshRepos, telegramClient: mockTelegram, db });

      // Before T+15s: 0 passes eligible
      await worker2.tick();
      expect(editsDelivered).toBe(0);

      // Simulate T+15s arriving for Pass 1
      db.prepare(`UPDATE notification_outbox SET next_attempt_at = '2020-01-01T00:00:00.000Z' WHERE dedup_key = ?`).run(`terminal_reattest:${reqId}:1`);
      await worker2.tick();
      expect(editsDelivered).toBe(1);
      expect(freshRepos.notifications.getByDedupKey(`terminal_reattest:${reqId}:1`)?.status).toBe('SENT');

      // Simulate T+45s arriving for Pass 2
      db.prepare(`UPDATE notification_outbox SET next_attempt_at = '2020-01-01T00:00:00.000Z' WHERE dedup_key = ?`).run(`terminal_reattest:${reqId}:2`);
      await worker2.tick();
      expect(editsDelivered).toBe(2);
      expect(freshRepos.notifications.getByDedupKey(`terminal_reattest:${reqId}:2`)?.status).toBe('SENT');

      // Simulate T+105s arriving for Pass 3
      db.prepare(`UPDATE notification_outbox SET next_attempt_at = '2020-01-01T00:00:00.000Z' WHERE dedup_key = ?`).run(`terminal_reattest:${reqId}:3`);
      await worker2.tick();
      expect(editsDelivered).toBe(3);
      expect(freshRepos.notifications.getByDedupKey(`terminal_reattest:${reqId}:3`)?.status).toBe('SENT');
    });
  });

  // ==========================================================================
  // 7. Owner Unlink and Stale Epoch Mid-Schedule
  // ==========================================================================
  describe('Owner Unlink and Stale Epoch Mid-Schedule', () => {
    it('cancels scheduled re-attestation passes without calling Telegram if owner unlinks', async () => {
      const reqId = 'req-unlink-midschedule';
      seedPayment(reqId);

      let edits = 0;
      const mockTelegram = {
        sendMessage: vi.fn().mockResolvedValue({ message_id: 5555, ok: true }),
        editMessageText: vi.fn().mockImplementation(async () => {
          edits++;
          return { message_id: 5555, ok: true };
        }),
      } as unknown as TelegramClient;

      const worker = new NotificationOutboxWorker({ repos, telegramClient: mockTelegram, db });
      enqueuePaymentTerminalOutcome(repos, {
        eventType: 'PAYMENT_CAPTURED',
        requestId: reqId,
        dedupKey: `payment_captured:${reqId}`,
        messageText: 'Terminal Text',
        ownerId: 'default',
      });

      await worker.tick();
      expect(repos.notifications.getByDedupKey(`payment_captured:${reqId}`)?.status).toBe('SENT');

      // Owner unlinks Telegram
      repos.owners.unlinkTelegram('default');

      // Simulate time advancing for Pass 1 and Pass 2
      db.prepare(`UPDATE notification_outbox SET next_attempt_at = '2020-01-01T00:00:00.000Z' WHERE dedup_key IN (?, ?)`).run(
        `terminal_reattest:${reqId}:1`,
        `terminal_reattest:${reqId}:2`
      );

      // F-05 guarantees at most 1 claim per request_id per tick; tick twice to cancel both passes
      await worker.tick();
      await worker.tick();

      // Zero edits made
      expect(edits).toBe(0);

      // Passes cancelled with OWNER_UNLINKED
      const p1 = repos.notifications.getByDedupKey(`terminal_reattest:${reqId}:1`);
      const p2 = repos.notifications.getByDedupKey(`terminal_reattest:${reqId}:2`);
      expect(p1?.status).toBe('CANCELLED');
      expect(p1?.last_error).toContain('OWNER_UNLINKED');
      expect(p2?.status).toBe('CANCELLED');
      expect(p2?.last_error).toContain('OWNER_UNLINKED');
    });
  });

  // ==========================================================================
  // 8. Deduplication & Idempotent Multi-Scheduling
  // ==========================================================================
  describe('Deduplication & Idempotent Multi-Scheduling', () => {
    it('repeated or concurrent schedule attempts never create duplicate outbox passes', () => {
      const reqId = 'req-dedup-multi';
      seedPayment(reqId);

      repos.notifications.enqueue({
        event_type: 'PAYMENT_CAPTURED',
        recipient_chat_id: 'chat-111',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_captured:${reqId}`,
        message_text: 'Text',
        request_id: reqId,
      });

      const claimed = repos.notifications.claimPending('worker-A', new Date().toISOString(), 1);
      expect(claimed.length).toBe(1);

      // First schedule call
      const res1 = repos.notifications.markTerminalSentAndScheduleReattestation({
        id: claimed[0]!.id,
        claimId: 'worker-A',
        telegramMessageId: 3333,
        row: claimed[0]!,
      });
      expect(res1).toBe(true);

      // Duplicate schedule call (e.g. concurrent worker or replay)
      const res2 = repos.notifications.markTerminalSentAndScheduleReattestation({
        id: claimed[0]!.id,
        claimId: 'worker-A',
        telegramMessageId: 3333,
        row: claimed[0]!,
      });
      // Second CAS update returns false because status is already SENT
      expect(res2).toBe(false);

      // Verify exactly three re-attestation passes exist in SQLite
      const count = (
        db.prepare(`SELECT count(*) as cnt FROM notification_outbox WHERE request_id = ? AND dedup_key LIKE 'terminal_reattest:%'`).get(reqId) as { cnt: number }
      ).cnt;
      expect(count).toBe(3);
    });
  });
});
