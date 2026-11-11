/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3-C: Telegram Notification Outbox Repository & Worker Unit Tests
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createDatabase, runMigrations, runInTransaction } from '../../src/db/connection.js';
import { createRepositories } from '../../src/db/repositories.js';
import type { Database } from '../../src/db/connection.js';
import type { Repositories } from '../../src/db/repositories.js';
import { TelegramClient } from '../../src/telegram/client.js';
import { NotificationOutboxWorker } from '../../src/telegram/outboxWorker.js';
import { toMinorUnits } from '../../src/core/money.js';

describe('M6-T3-C: repos.notifications Repository Methods', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    repos.owners.upsert({
      id: 'default',
      display_name: 'Primary Owner',
      passphrase_hash: 'hash',
      telegram_chat_id: '123456789',
      created_at: new Date().toISOString(),
    });
    repos.owners.linkTelegram({
      ownerId: 'default',
      chatId: '123456789',
      username: 'owner1',
      linkedAtIso: '2026-11-04T00:00:00.000Z',
    });
  });

  it('enqueues and retrieves notification rows by id and dedup_key', () => {
    const enqueueRes = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'held:req-1',
      message_text: 'Hold notification',
    });

    expect(enqueueRes.inserted).toBe(true);
    expect(enqueueRes.id).toBeDefined();

    const byId = repos.notifications.getById(enqueueRes.id);
    expect(byId).toBeDefined();
    expect(byId?.dedup_key).toBe('held:req-1');
    expect(byId?.status).toBe('PENDING');

    const byKey = repos.notifications.getByDedupKey('held:req-1');
    expect(byKey?.id).toBe(enqueueRes.id);
  });

  it('claimPending transitions pending rows to PROCESSING with unique claim_id and claimed_at', () => {
    repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'k1',
      message_text: 'msg1',
      next_attempt_at: '2026-11-04T00:00:00.000Z',
    });
    repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'k2',
      message_text: 'msg2',
      next_attempt_at: '2026-11-04T00:00:00.000Z',
    });

    const claimed = repos.notifications.claimPending('claim-abc', '2026-11-04T00:05:00.000Z', 10);
    expect(claimed).toHaveLength(2);
    expect(claimed[0]?.status).toBe('PROCESSING');
    expect(claimed[0]?.claim_id).toBe('claim-abc');
    expect(claimed[0]?.claimed_at).toBe('2026-11-04T00:05:00.000Z');

    // Second claim should see zero available
    const emptyClaim = repos.notifications.claimPending('claim-def', '2026-11-04T00:05:00.000Z', 10);
    expect(emptyClaim).toHaveLength(0);
  });

  it('reclaimAbandoned resets PROCESSING rows past lease duration back to PENDING', () => {
    const enqueueRes = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'abandon-test',
      message_text: 'abandoned',
      next_attempt_at: '2026-11-04T00:00:00.000Z',
    });

    // Claim row at T = 0
    repos.notifications.claimPending('claim-old', '2026-11-04T00:00:00.000Z', 10);
    let row = repos.notifications.getById(enqueueRes.id);
    expect(row?.status).toBe('PROCESSING');

    // T = +40s, lease cutoff is +30s
    const reclaimedCount = repos.notifications.reclaimAbandoned('2026-11-04T00:00:30.000Z');
    expect(reclaimedCount).toBe(1);

    row = repos.notifications.getById(enqueueRes.id);
    expect(row?.status).toBe('PENDING');
    expect(row?.claim_id).toBeNull();
    expect(row?.claimed_at).toBeNull();
    expect(row?.last_error).toContain('LEASE_EXPIRED_RECLAIMED');
  });

  it('markSent requires matching claim_id and transitions row to SENT', () => {
    const { id } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'sent-test',
      message_text: 'sent test',
      next_attempt_at: '2026-11-04T00:00:00.000Z',
    });

    repos.notifications.claimPending('claim-valid', '2026-11-04T00:00:00.000Z', 10);

    // Mismatched claim_id fails CAS
    const wrongCas = repos.notifications.markSent(id, 'claim-wrong', 99999);
    expect(wrongCas).toBe(false);

    // Correct claim_id succeeds
    const correctCas = repos.notifications.markSent(id, 'claim-valid', 99999, '2026-11-04T00:00:05.000Z');
    expect(correctCas).toBe(true);

    const sentRow = repos.notifications.getById(id);
    expect(sentRow?.status).toBe('SENT');
    expect(sentRow?.telegram_message_id).toBe(99999);
    expect(sentRow?.sent_at).toBe('2026-11-04T00:00:05.000Z');
  });

  it('markFailed increments attempt_count and transitions to DEAD when max_attempts reached or isTerminal=true', () => {
    const { id } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'fail-test',
      message_text: 'fail test',
      max_attempts: 2,
      next_attempt_at: '2026-11-04T00:00:00.000Z',
    });

    // Attempt 1: transient failure -> stays PENDING with next_attempt_at in future
    repos.notifications.claimPending('claim-1', '2026-11-04T00:00:00.000Z', 10);
    const failed1 = repos.notifications.markFailed(
      id,
      'claim-1',
      '2026-11-04T00:00:10.000Z',
      'Network timeout',
      false
    );
    expect(failed1).toBe(true);

    let row = repos.notifications.getById(id);
    expect(row?.status).toBe('PENDING');
    expect(row?.attempt_count).toBe(1);
    expect(row?.next_attempt_at).toBe('2026-11-04T00:00:10.000Z');

    // Attempt 2: reaches max_attempts (2) -> transitions to DEAD
    repos.notifications.claimPending('claim-2', '2026-11-04T00:00:15.000Z', 10);
    const failed2 = repos.notifications.markFailed(
      id,
      'claim-2',
      '2026-11-04T00:00:20.000Z',
      'Network timeout 2',
      false
    );
    expect(failed2).toBe(true);

    row = repos.notifications.getById(id);
    expect(row?.status).toBe('DEAD');
    expect(row?.attempt_count).toBe(2);

    // Terminal error marks DEAD immediately even on attempt 0
    const { id: termId } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'term-test',
      message_text: 'term test',
      max_attempts: 5,
      next_attempt_at: '2026-11-04T00:00:00.000Z',
    });
    repos.notifications.claimPending('claim-term', '2026-11-04T00:00:00.000Z', 10);
    repos.notifications.markFailed(termId, 'claim-term', '2026-11-04T00:00:00.000Z', 'Chat not found (400)', true);

    const termRow = repos.notifications.getById(termId);
    expect(termRow?.status).toBe('DEAD');
  });

  it('cancelPendingByOwnerId cancels only the target owner rows and leaves other owners unaffected', () => {
    const { id: row1 } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'owner1-msg',
      message_text: 'Owner 1 notification',
    });

    // Attempting to cancel non-existent or other owner ID cancels 0 rows
    const nonExistentCancelled = repos.notifications.cancelPendingByOwnerId('other-owner', 'OWNER_UNLINKED');
    expect(nonExistentCancelled).toBe(0);
    expect(repos.notifications.getById(row1)?.status).toBe('PENDING');

    // Cancelling target owner cancels their pending rows
    const cancelled = repos.notifications.cancelPendingByOwnerId('default', 'OWNER_UNLINKED');
    expect(cancelled).toBe(1);
    expect(repos.notifications.getById(row1)?.status).toBe('CANCELLED');
    expect(repos.notifications.getById(row1)?.last_error).toBe('OWNER_UNLINKED');
  });
});

describe('M6-T3-C: NotificationOutboxWorker', () => {
  let db: Database;
  let repos: Repositories;
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: TelegramClient;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    repos.owners.upsert({
      id: 'default',
      display_name: 'Primary Owner',
      passphrase_hash: 'hash',
      telegram_chat_id: '123456789',
      created_at: new Date().toISOString(),
    });
    repos.owners.linkTelegram({
      ownerId: 'default',
      chatId: '123456789',
      username: 'owner1',
      linkedAtIso: '2026-11-04T00:00:00.000Z',
    });

    fetchMock = vi.fn();
    client = new TelegramClient({
      botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      fetchFn: fetchMock as unknown as typeof globalThis.fetch,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('processes pending notifications successfully, dispatches via TelegramClient, and marks SENT', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          message_id: 8888,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456789, type: 'private' },
          text: 'Hold notification',
        },
      }),
    });

    const { id } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'worker-ok-1',
      message_text: 'Hold notification',
    });

    const worker = new NotificationOutboxWorker({
      repos,
      telegramClient: client,
    });

    const count = await worker.tick();
    expect(count).toBe(1);

    const updated = repos.notifications.getById(id);
    expect(updated?.status).toBe('SENT');
    expect(updated?.telegram_message_id).toBe(8888);
    expect(updated?.sent_at).toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    const requestBody = JSON.parse(callArgs![1].body);
    expect(requestBody.chat_id).toBe('123456789');
    expect(requestBody.text).toBe('Hold notification');
    expect(requestBody.parse_mode).toBe('HTML');
  });

  it('cancels pending notification with OWNER_UNLINKED if owner unlinked before dispatch', async () => {
    const { id } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'unlink-before-dispatch',
      message_text: 'Should be cancelled',
    });

    // Owner unlinks
    repos.owners.unlinkTelegram('default');

    const worker = new NotificationOutboxWorker({
      repos,
      telegramClient: client,
    });

    const count = await worker.tick();
    expect(count).toBe(1);

    const updated = repos.notifications.getById(id);
    expect(updated?.status).toBe('CANCELLED');
    expect(updated?.last_error).toBe('OWNER_UNLINKED');
    // Must NOT attempt to call Telegram
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels pending notification with STALE_LINK_EPOCH if owner unlinked and relinked with new epoch', async () => {
    const { id } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'epoch-mismatch',
      message_text: 'Old epoch message',
    });

    // Owner unlinks and relinks with a new linked_at epoch
    repos.owners.linkTelegram({
      ownerId: 'default',
      chatId: '123456789',
      linkedAtIso: '2026-11-04T02:00:00.000Z', // Different epoch!
    });

    const worker = new NotificationOutboxWorker({
      repos,
      telegramClient: client,
    });

    await worker.tick();

    const updated = repos.notifications.getById(id);
    expect(updated?.status).toBe('CANCELLED');
    expect(updated?.last_error).toBe('STALE_LINK_EPOCH');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles Telegram HTTP 429 rate limit by rescheduling according to retry_after parameter', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 8',
        parameters: { retry_after: 8 },
      }),
    });

    const clientNoRetry = new TelegramClient({
      botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      maxRetries: 0,
      fetchFn: fetchMock as unknown as typeof globalThis.fetch,
    });

    const { id } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'rate-limit-test',
      message_text: 'Rate limited message',
    });

    const worker = new NotificationOutboxWorker({
      repos,
      telegramClient: clientNoRetry,
    });

    await worker.tick();

    const updated = repos.notifications.getById(id);
    expect(updated?.status).toBe('PENDING');
    expect(updated?.attempt_count).toBe(1);
    const nextAttemptMs = new Date(updated!.next_attempt_at).getTime();
    expect(nextAttemptMs).toBeGreaterThan(Date.now() + 6000);
  });

  it('handles terminal HTTP 400 or 403 errors by marking notification DEAD immediately', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was blocked by the user',
      }),
    });

    const { id } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'terminal-test',
      message_text: 'Blocked message',
    });

    const worker = new NotificationOutboxWorker({
      repos,
      telegramClient: client,
    });

    await worker.tick();

    const updated = repos.notifications.getById(id);
    expect(updated?.status).toBe('DEAD');
    expect(updated?.last_error).toContain('Forbidden');
  });

  it('handles Telegram HTTP 500 server error by rescheduling with backoff, clearing claim, and delivering on later retry', async () => {
    // Attempt 1: Telegram responds with HTTP 500
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({
        ok: false,
        error_code: 500,
        description: 'Internal Server Error',
      }),
    });

    const clientNoRetry = new TelegramClient({
      botToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      maxRetries: 0,
      fetchFn: fetchMock as unknown as typeof globalThis.fetch,
    });

    const { id } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: '500-retry-test',
      message_text: 'Retryable 500 message',
      max_attempts: 3,
    });

    const worker = new NotificationOutboxWorker({
      repos,
      telegramClient: clientNoRetry,
    });

    const beforeTick = Date.now();
    await worker.tick();

    // Verify row state after HTTP 500 failure
    const failedRow = repos.notifications.getById(id);
    expect(failedRow?.status).toBe('PENDING');
    expect(failedRow?.attempt_count).toBe(1);
    expect(failedRow?.claim_id).toBeNull();
    expect(failedRow?.claimed_at).toBeNull();
    expect(failedRow?.last_error).toContain('Internal Server Error');

    const nextAttemptMs = new Date(failedRow!.next_attempt_at).getTime();
    expect(nextAttemptMs).toBeGreaterThanOrEqual(beforeTick + 900); // 1000ms delay

    // Attempt 2: Telegram recovers and responds with HTTP 200 OK
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          message_id: 7777,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456789, type: 'private' },
          text: 'Delivered after retry',
        },
      }),
    });

    // Advance next_attempt_at into the past so row is eligible for second tick
    db.prepare("UPDATE notification_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?").run(id);

    const processedSecondTick = await worker.tick();
    expect(processedSecondTick).toBe(1);

    const deliveredRow = repos.notifications.getById(id);
    expect(deliveredRow?.status).toBe('SENT');
    expect(deliveredRow?.telegram_message_id).toBe(7777);
    expect(deliveredRow?.sent_at).toBeDefined();
    expect(deliveredRow?.claim_id).toBeDefined();
  });

  it('reclaims abandoned processing rows before claiming next pending batch', async () => {
    const { id } = repos.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'abandon-worker',
      message_text: 'Abandoned job recovered',
      next_attempt_at: new Date(Date.now() - 70000).toISOString(),
    });

    // Manually mark as PROCESSING from 60 seconds ago (lease is 30s)
    repos.notifications.claimPending('old-dead-worker', new Date(Date.now() - 60000).toISOString(), 10);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          message_id: 9999,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456789, type: 'private' },
          text: 'Recovered',
        },
      }),
    });

    const worker = new NotificationOutboxWorker({
      repos,
      telegramClient: client,
      leaseDurationMs: 30000,
    });

    // Worker tick should first reclaim the abandoned row, then claim and dispatch it
    const processed = await worker.tick();
    expect(processed).toBe(1);

    const updated = repos.notifications.getById(id);
    expect(updated?.status).toBe('SENT');
    expect(updated?.telegram_message_id).toBe(9999);
  });

  it('supports start and stop lifecycle methods cleanly', async () => {
    const worker = new NotificationOutboxWorker({
      repos,
      telegramClient: client,
      intervalMs: 100,
    });

    worker.start();
    // Repeated start is a no-op
    worker.start();

    await worker.stop();
    // Repeated stop is a no-op
    await worker.stop();
  });
});

describe('M6-T3-D: Multi-Connection Concurrency & Atomicity Tests', () => {
  let tempDbDir: string;
  let dbPath: string;
  let conn1: Database;
  let conn2: Database;
  let repos1: Repositories;
  let repos2: Repositories;

  function seedPaymentRequest(id: string): void {
    repos1.paymentRequests.insert({
      id,
      agent_id: 'test-agent',
      idempotency_key: `key-${id}`,
      vendor_id: 'test-vendor',
      amount_minor: toMinorUnits(1000),
      currency: 'USD',
      purpose: 'test payment',
      category: 'cloud',
      source_context_excerpt: null,
      source_context_hash: null,
      status: 'HELD',
      decision: 'HOLD',
      reasons: JSON.stringify([]),
      policy_version_id: null,
      snapshot_hash: 'snap-hash',
      paypal_order_id: null,
      paypal_authorization_id: null,
      paypal_capture_id: null,
      expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  beforeEach(() => {
    tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-outbox-concurrency-'));
    dbPath = path.join(tempDbDir, 'test.db');
    conn1 = createDatabase(dbPath);
    runMigrations(conn1);
    conn2 = createDatabase(dbPath);
    repos1 = createRepositories(conn1);
    repos2 = createRepositories(conn2);

    repos1.owners.upsert({
      id: 'default',
      display_name: 'Primary Owner',
      passphrase_hash: 'hash',
      telegram_chat_id: '123456789',
      created_at: new Date().toISOString(),
    });
    repos1.owners.linkTelegram({
      ownerId: 'default',
      chatId: '123456789',
      username: 'owner1',
      linkedAtIso: '2026-11-04T00:00:00.000Z',
    });

    repos1.agents.insert({
      id: 'test-agent',
      name: 'Test Agent',
      api_key_hash: 'hash',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(100000),
      created_at: new Date().toISOString(),
    });
    repos1.vendors.insert({
      id: 'test-vendor',
      name: 'Test Vendor',
      status: 'ACTIVE',
      categories: JSON.stringify(['api']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'paypal',
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    try {
      conn1.close();
    } catch {
      // ignore
    }
    try {
      conn2.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tempDbDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('competing claim attempts: verify the same notification cannot be returned to both workers', () => {
    // Seed 10 distinct pending notifications across independent requests
    for (let i = 1; i <= 10; i++) {
      const reqId = `req-compete-${i}`;
      seedPaymentRequest(reqId);
      repos1.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `compete-row-${i}`,
        message_text: `Notification ${i}`,
        request_id: reqId,
      });
    }

    // Connection 1 and Connection 2 compete to claim batches of 6
    const batch1 = repos1.notifications.claimPending('worker-conn-1', undefined, 6);
    const batch2 = repos2.notifications.claimPending('worker-conn-2', undefined, 6);

    expect(batch1.length).toBe(6);
    expect(batch2.length).toBe(4);

    // Verify completely disjoint ID sets - no duplicate delivery across connections
    const ids1 = new Set(batch1.map(r => r.id));
    const ids2 = new Set(batch2.map(r => r.id));
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }

    // Verify claim ownership recorded in SQLite
    for (const row of batch1) {
      expect(row.claim_id).toBe('worker-conn-1');
      expect(row.status).toBe('PROCESSING');
    }
    for (const row of batch2) {
      expect(row.claim_id).toBe('worker-conn-2');
      expect(row.status).toBe('PROCESSING');
    }

    // Further claims by either connection yield 0 rows
    expect(repos1.notifications.claimPending('worker-conn-1-again').length).toBe(0);
    expect(repos2.notifications.claimPending('worker-conn-2-again').length).toBe(0);
  });

  it('single row race: when two connections race for 1 pending row, exactly one claims it', () => {
    seedPaymentRequest('req-single');
    repos1.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'single-row-race',
      message_text: 'Single row competition',
      request_id: 'req-single',
    });

    const res1 = repos1.notifications.claimPending('worker-a', undefined, 10);
    const res2 = repos2.notifications.claimPending('worker-b', undefined, 10);

    expect(res1.length).toBe(1);
    expect(res2.length).toBe(0);
    expect(res1[0]?.claim_id).toBe('worker-a');
    expect(res1[0]?.status).toBe('PROCESSING');
  });

  it('predecessor ordering across connections: terminal notification cannot be claimed before predecessor', () => {
    const reqId = 'req-order-cross-conn';
    seedPaymentRequest(reqId);
    const initialTime = new Date(Date.now() - 10000).toISOString();
    const terminalTime = new Date().toISOString();

    // 1. Initial pending void notification
    const orig = repos1.notifications.enqueue({
      event_type: 'PAYMENT_VOIDED',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: `payment_voided:${reqId}`,
      message_text: 'Void pending remote confirmation',
      request_id: reqId,
      created_at: initialTime,
    });

    // 2. Terminal update notification enqueued later
    repos1.notifications.enqueue({
      event_type: 'PAYMENT_VOIDED',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: `payment_voided:${reqId}:confirmed`,
      message_text: 'Void confirmed by PayPal',
      request_id: reqId,
      created_at: terminalTime,
    });

    // Worker 1 on Connection 1 claims predecessor -> transitions to PROCESSING
    const claim1 = repos1.notifications.claimPending('worker-conn-1', undefined, 10);
    expect(claim1.length).toBe(1);
    expect(claim1[0]?.id).toBe(orig.id);
    expect(claim1[0]?.status).toBe('PROCESSING');

    // Worker 2 on Connection 2 attempts to claim: MUST NOT claim terminal update
    const claim2Blocked = repos2.notifications.claimPending('worker-conn-2', undefined, 10);
    expect(claim2Blocked.length).toBe(0);

    // Worker 1 finishes and marks predecessor as SENT
    repos1.notifications.markSent(claim1[0]!.id, 'worker-conn-1', 999123);

    // Now Worker 2 on Connection 2 is unblocked and claims the terminal update
    const claim2Unblocked = repos2.notifications.claimPending('worker-conn-2', undefined, 10);
    expect(claim2Unblocked.length).toBe(1);
    expect(claim2Unblocked[0]?.dedup_key).toBe(`payment_voided:${reqId}:confirmed`);
    expect(claim2Unblocked[0]?.claim_id).toBe('worker-conn-2');
    expect(claim2Unblocked[0]?.status).toBe('PROCESSING');
  });

  it('unrelated requests can still be claimed while predecessor blocks terminal notification', () => {
    const blockedReqId = 'req-blocked-1';
    const unrelatedReqId = 'req-unrelated-2';
    seedPaymentRequest(blockedReqId);
    seedPaymentRequest(unrelatedReqId);
    const initialTime = new Date(Date.now() - 10000).toISOString();
    const nowTime = new Date().toISOString();

    // Blocked flow: Initial + Terminal
    repos1.notifications.enqueue({
      event_type: 'PAYMENT_VOIDED',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: `payment_voided:${blockedReqId}`,
      message_text: 'Blocked initial',
      request_id: blockedReqId,
      created_at: initialTime,
    });
    repos1.notifications.enqueue({
      event_type: 'PAYMENT_VOIDED',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: `payment_voided:${blockedReqId}:confirmed`,
      message_text: 'Blocked terminal',
      request_id: blockedReqId,
      created_at: nowTime,
    });

    // Unrelated flow: payment held notification
    repos1.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: `payment_held:${unrelatedReqId}`,
      message_text: 'Unrelated request payment held',
      request_id: unrelatedReqId,
      created_at: nowTime,
    });

    // System alert with no request_id
    repos1.notifications.enqueue({
      event_type: 'SECURITY_ALERT',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'system-alert-1',
      message_text: 'System alert without request_id',
      request_id: null as unknown as string,
      created_at: nowTime,
    });

    // Worker 1 claims initial blocked notification
    const w1Batch = repos1.notifications.claimPending('worker-1', undefined, 1);
    expect(w1Batch.length).toBe(1);
    expect(w1Batch[0]?.dedup_key).toBe(`payment_voided:${blockedReqId}`);

    // Worker 2 on Connection 2 claims: should claim the unrelated notification and system alert, NOT the blocked terminal update
    const w2Batch = repos2.notifications.claimPending('worker-2', undefined, 10);
    expect(w2Batch.length).toBe(2);
    const dedupKeys = w2Batch.map(r => r.dedup_key);
    expect(dedupKeys).toContain(`payment_held:${unrelatedReqId}`);
    expect(dedupKeys).toContain('system-alert-1');
    expect(dedupKeys).not.toContain(`payment_voided:${blockedReqId}:confirmed`);

    // The blocked terminal notification is still PENDING in the DB
    const terminalRow = repos1.notifications.getByDedupKey(`payment_voided:${blockedReqId}:confirmed`);
    expect(terminalRow?.status).toBe('PENDING');
    expect(terminalRow?.claim_id).toBeNull();
  });

  it('transaction rollback leaves no partially claimed rows when an error occurs during claim', () => {
    // Seed 3 pending notifications
    for (let i = 1; i <= 3; i++) {
      const reqId = `req-rollback-${i}`;
      seedPaymentRequest(reqId);
      repos1.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `rollback-test-${i}`,
        message_text: `Rollback notification ${i}`,
        request_id: reqId,
      });
    }

    // Install an SQLite trigger that aborts the transaction when 'failing-worker' attempts to claim
    conn1.exec(`
      CREATE TRIGGER test_claim_failure_trigger
      BEFORE UPDATE ON notification_outbox
      FOR EACH ROW
      WHEN NEW.status = 'PROCESSING' AND NEW.claim_id = 'failing-worker'
      BEGIN
        SELECT RAISE(ABORT, 'Simulated SQLite failure during claim transaction');
      END;
    `);

    // Attempt claim by 'failing-worker': should throw and roll back completely
    expect(() => {
      repos1.notifications.claimPending('failing-worker', undefined, 10);
    }).toThrow('Simulated SQLite failure during claim transaction');

    // Verify via Connection 2 that NO rows were left partially claimed
    const rows = conn2.prepare("SELECT * FROM notification_outbox WHERE dedup_key LIKE 'rollback-test-%'").all() as {
      status: string;
      claim_id: string | null;
      claimed_at: string | null;
    }[];

    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.status).toBe('PENDING');
      expect(r.claim_id).toBeNull();
      expect(r.claimed_at).toBeNull();
    }

    // Clean up trigger
    conn1.exec('DROP TRIGGER test_claim_failure_trigger');

    // Connection 2 can now claim all 3 rows normally
    const recoveredBatch = repos2.notifications.claimPending('healthy-worker', undefined, 10);
    expect(recoveredBatch.length).toBe(3);
    for (const r of recoveredBatch) {
      expect(r.status).toBe('PROCESSING');
      expect(r.claim_id).toBe('healthy-worker');
    }
  });

  it('nested transaction support: claimPending executes cleanly inside an existing outer transaction', () => {
    seedPaymentRequest('req-nested-tx');
    repos1.notifications.enqueue({
      event_type: 'PAYMENT_HELD',
      recipient_chat_id: '123456789',
      owner_id: 'default',
      linked_at: '2026-11-04T00:00:00.000Z',
      dedup_key: 'nested-tx-row',
      message_text: 'Nested transaction test',
      request_id: 'req-nested-tx',
    });

    // Run claimPending inside an outer runInTransaction
    const claimed = runInTransaction(conn1, () => {
      return repos1.notifications.claimPending('worker-nested', undefined, 10);
    });

    expect(claimed.length).toBe(1);
    expect(claimed[0]?.claim_id).toBe('worker-nested');
    expect(claimed[0]?.status).toBe('PROCESSING');
  });

  // ==========================================================================
  // F-05, F-07, and F-09 Regression Test Suite
  // ==========================================================================
  describe('F-05, F-07, and F-09: Partitioning, Supersession & Whitelist Protection', () => {
    it('F-05: claimPending selects at most ONE notification per request_id within a single batch', () => {
      const reqId = 'req-f05-batch-dedup';
      seedPaymentRequest(reqId);
      const initialTime = new Date(Date.now() - 5000).toISOString();
      const secondTime = new Date().toISOString();

      repos1.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `held:${reqId}`,
        message_text: 'Held message',
        request_id: reqId,
        created_at: initialTime,
      });

      repos1.notifications.enqueue({
        event_type: 'PAYMENT_CAPTURED',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `captured:${reqId}`,
        message_text: 'Captured message',
        request_id: reqId,
        created_at: secondTime,
      });

      // Claim with batchSize = 10
      const claimed = repos1.notifications.claimPending('worker-f05', undefined, 10);

      // Must claim exactly 1 row for this payment
      expect(claimed.length).toBe(1);
      expect(claimed[0]?.dedup_key).toBe(`held:${reqId}`);
      expect(claimed[0]?.status).toBe('PROCESSING');

      // The second row must remain PENDING
      const remaining = repos1.notifications.getByDedupKey(`captured:${reqId}`);
      expect(remaining?.status).toBe('PENDING');
    });

    it('F-07: FAILED intermediate row is superseded and unblocks newer terminal outcome', () => {
      const reqId = 'req-f07-failed-unblock';
      seedPaymentRequest(reqId);
      const t1 = new Date(Date.now() - 10000).toISOString();
      const t2 = new Date().toISOString();

      const heldRes = repos1.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `held:${reqId}`,
        message_text: 'Held notification',
        request_id: reqId,
        created_at: t1,
      });

      // Simulate a prior failure on the held notification
      conn1.prepare(`
        UPDATE notification_outbox
        SET status = 'FAILED',
            attempt_count = 1,
            last_error = 'TelegramApiError 502: Bad Gateway'
        WHERE id = ?
      `).run(heldRes.id);

      // Enqueue newer terminal notification
      const capRes = repos1.notifications.enqueue({
        event_type: 'PAYMENT_CAPTURED',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_captured:${reqId}`,
        message_text: 'Captured notification',
        request_id: reqId,
        created_at: t2,
      });

      // Execute intermediate supersession
      const supersession = repos1.notifications.supersedeIntermediateForRequest(reqId);
      expect(supersession.cancelled).toBe(1);

      // Verify the intermediate row is CANCELLED and preserved original error
      const heldRow = repos1.notifications.getById(heldRes.id!);
      expect(heldRow?.status).toBe('CANCELLED');
      expect(heldRow?.last_error).toBe('TelegramApiError 502: Bad Gateway | SUPERSEDED');
      expect(heldRow?.attempt_count).toBe(1);

      // Now claimPending can immediately claim the terminal row!
      const claimed = repos1.notifications.claimPending('worker-f07', undefined, 10);
      expect(claimed.length).toBe(1);
      expect(claimed[0]?.id).toBe(capRes.id);
      expect(claimed[0]?.dedup_key).toBe(`payment_captured:${reqId}`);
      expect(claimed[0]?.status).toBe('PROCESSING');
    });

    it('F-07: in-flight PROCESSING intermediate row retains active lease and completes gracefully without orphan state', () => {
      const reqId = 'req-f07-lease-protect';
      seedPaymentRequest(reqId);
      const t1 = new Date(Date.now() - 10000).toISOString();
      const t2 = new Date().toISOString();

      repos1.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `held:${reqId}`,
        message_text: 'Held notification',
        request_id: reqId,
        created_at: t1,
      });

      // Worker 1 claims intermediate row
      const batch1 = repos1.notifications.claimPending('worker-active-lease', undefined, 10);
      expect(batch1.length).toBe(1);
      expect(batch1[0]?.status).toBe('PROCESSING');
      expect(batch1[0]?.claim_id).toBe('worker-active-lease');

      // Terminal event arrives concurrently
      repos1.notifications.enqueue({
        event_type: 'PAYMENT_CAPTURED',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_captured:${reqId}`,
        message_text: 'Captured notification',
        request_id: reqId,
        created_at: t2,
      });

      // Terminal supersession runs
      const supersession = repos1.notifications.supersedeIntermediateForRequest(reqId);
      expect(supersession.cancelled).toBe(0); // 0 cancelled because it is in PROCESSING
      expect(supersession.cooperative).toBe(1); // 1 marked cooperatively

      // Active lease was NOT yanked: claim_id remains intact
      const inFlightRow = repos1.notifications.getById(batch1[0]!.id);
      expect(inFlightRow?.status).toBe('PROCESSING');
      expect(inFlightRow?.claim_id).toBe('worker-active-lease');
      expect(inFlightRow?.last_error).toBe('SUPERSEDED_PENDING');

      // Terminal notification is NOT claimed while predecessor is still PROCESSING
      const blockedClaim = repos2.notifications.claimPending('worker-2', undefined, 10);
      expect(blockedClaim.length).toBe(0);

      // In-flight worker finishes with failure -> markFailed handles SUPERSEDED_PENDING
      const marked = repos1.notifications.markFailed(
        batch1[0]!.id,
        'worker-active-lease',
        new Date().toISOString(),
        'Network drop'
      );
      expect(marked).toBe(true);

      // The in-flight row transitions cleanly to CANCELLED instead of FAILED
      const finishedRow = repos1.notifications.getById(batch1[0]!.id);
      expect(finishedRow?.status).toBe('CANCELLED');
      expect(finishedRow?.last_error).toBe('Network drop | SUPERSEDED');

      // Now terminal notification is unblocked and claimed
      const unblockedBatch = repos2.notifications.claimPending('worker-2', undefined, 10);
      expect(unblockedBatch.length).toBe(1);
      expect(unblockedBatch[0]?.dedup_key).toBe(`payment_captured:${reqId}`);
      expect(unblockedBatch[0]?.status).toBe('PROCESSING');
    });

    it('F-09: whitelist supersession cancels only intermediate events and preserves unrelated terminal events', () => {
      const reqId = 'req-f09-whitelist';
      seedPaymentRequest(reqId);
      const nowIso = new Date().toISOString();

      // 1. Intermediate event: PAYMENT_HELD
      const held = repos1.notifications.enqueue({
        event_type: 'PAYMENT_HELD',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `held:${reqId}`,
        message_text: 'Hold review',
        request_id: reqId,
        created_at: nowIso,
      });

      // 2. Intermediate event: PAYMENT_VOID_PENDING
      const voidPending = repos1.notifications.enqueue({
        event_type: 'PAYMENT_VOID_PENDING',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_void_pending:${reqId}`,
        message_text: 'Void pending',
        request_id: reqId,
        created_at: nowIso,
      });

      // 3. Unrelated event: SECURITY_HIGH_RISK
      const securityAlert = repos1.notifications.enqueue({
        event_type: 'SECURITY_HIGH_RISK',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `security:${reqId}`,
        message_text: 'Security alert',
        request_id: reqId,
        created_at: nowIso,
      });

      // 4. Protected terminal event: PAYMENT_EXPIRED
      const expired = repos1.notifications.enqueue({
        event_type: 'PAYMENT_EXPIRED',
        recipient_chat_id: '123456789',
        owner_id: 'default',
        linked_at: '2026-11-04T00:00:00.000Z',
        dedup_key: `payment_expired:${reqId}`,
        message_text: 'Expired',
        request_id: reqId,
        created_at: nowIso,
      });

      // Execute intermediate supersession
      const res = repos1.notifications.supersedeIntermediateForRequest(reqId);
      expect(res.cancelled).toBe(2); // Only PAYMENT_HELD and PAYMENT_VOID_PENDING

      // Intermediate rows cancelled
      expect(repos1.notifications.getById(held.id!)?.status).toBe('CANCELLED');
      expect(repos1.notifications.getById(voidPending.id!)?.status).toBe('CANCELLED');

      // Security and Expired rows MUST remain PENDING untouched!
      const secRow = repos1.notifications.getById(securityAlert.id!);
      expect(secRow?.status).toBe('PENDING');
      expect(secRow?.last_error).toBeNull();

      const expRow = repos1.notifications.getById(expired.id!);
      expect(expRow?.status).toBe('PENDING');
      expect(expRow?.last_error).toBeNull();
    });
  });
});
