/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3-C: Telegram Notification Outbox Worker
 *
 * Implements:
 * - Periodic background worker polling notification_outbox table
 * - Atomic row claiming via random claim_id and CAS state transition
 * - Automatic recovery of abandoned jobs (lease expiration)
 * - Pre-dispatch recipient chat ID and link-epoch validation
 * - Bounded retry handling for Telegram rate limits (429), server errors (5xx),
 *   and terminal marking for permanent client errors (400, 403)
 */

import { randomUUID } from 'node:crypto';
import type { Database } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import type { NotificationOutboxRow } from '../db/types.js';
import { TelegramClient, TelegramApiError } from './client.js';
import type { TelegramClientLogger, TelegramInlineKeyboardMarkup } from './types.js';
import { decryptReplyMarkup } from './crypto.js';
import { writeAuditLogEntry } from '../core/stateMachine.js';

export interface NotificationOutboxWorkerOptions {
  readonly repos: Repositories;
  readonly telegramClient: TelegramClient;
  readonly db?: Database;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly leaseDurationMs?: number;
  readonly encryptionKey?: string;
  readonly previousEncryptionKey?: string;
  readonly logger?: TelegramClientLogger;
}

export class NotificationOutboxWorker {
  private readonly repos: Repositories;
  private readonly telegramClient: TelegramClient;
  private readonly db?: Database;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly leaseDurationMs: number;
  private readonly encryptionKey?: string;
  private readonly previousEncryptionKey?: string;
  private readonly logger?: TelegramClientLogger;

  private isRunning = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private currentTickPromise?: Promise<number>;

  constructor(options: NotificationOutboxWorkerOptions) {
    this.repos = options.repos;
    this.telegramClient = options.telegramClient;
    this.db = options.db;
    this.intervalMs = options.intervalMs ?? 2000;
    this.batchSize = options.batchSize ?? 10;
    this.leaseDurationMs = options.leaseDurationMs ?? 30000;
    this.encryptionKey = options.encryptionKey;
    this.previousEncryptionKey = options.previousEncryptionKey;
    this.logger = options.logger;
  }

  public start(): void {
    if (this.isRunning) return;
    this.stopped = false;
    this.isRunning = true;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger?.error?.('NotificationOutboxWorker tick failed', err);
      });
    }, this.intervalMs);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.currentTickPromise) {
      await this.currentTickPromise;
    }
  }

  public async tick(): Promise<number> {
    if (this.stopped) {
      return 0;
    }
    if (this.currentTickPromise) {
      return this.currentTickPromise;
    }
    this.currentTickPromise = this.doTick();
    try {
      return await this.currentTickPromise;
    } finally {
      this.currentTickPromise = undefined;
    }
  }

  private async doTick(): Promise<number> {
    // 1. Reclaim abandoned jobs whose lease has expired
    const olderThanIso = new Date(Date.now() - this.leaseDurationMs).toISOString();
    const reclaimed = this.repos.notifications.reclaimAbandoned(olderThanIso);
    if (reclaimed > 0) {
      this.logger?.warn?.(`Reclaimed ${reclaimed} abandoned notification(s)`);
    }

    // 2. Claim next pending batch
    const claimId = randomUUID();
    const nowIso = new Date().toISOString();
    const batch = this.repos.notifications.claimPending(claimId, nowIso, this.batchSize);

    if (batch.length === 0) {
      return 0;
    }

    let processedCount = 0;
    for (const row of batch) {
      await this.processRow(row, claimId);
      processedCount++;
    }

    return processedCount;
  }

  private async processRow(row: NotificationOutboxRow, claimId: string): Promise<void> {
    const nowIso = new Date().toISOString();

    // 3. Pre-dispatch check: verify owner exists and Telegram link binding is valid and current
    const owner = this.repos.owners.get(row.owner_id);
    if (!owner || !owner.telegram_chat_id || owner.telegram_chat_id !== row.recipient_chat_id) {
      this.repos.notifications.markCancelled(row.id, 'OWNER_UNLINKED');
      if (row.request_id) {
        this.repos.telegramApprovalCallbacks.invalidateForRequest(row.request_id, nowIso);
      }
      this.logger?.info?.(
        `Cancelled notification ${row.id}: recipient ${row.recipient_chat_id} is no longer linked to owner ${row.owner_id}`
      );
      return;
    }

    // Verify link epoch: if owner relinked after this notification was queued, do not dispatch
    if (owner.telegram_linked_at !== row.linked_at) {
      this.repos.notifications.markCancelled(row.id, 'STALE_LINK_EPOCH');
      if (row.request_id) {
        this.repos.telegramApprovalCallbacks.invalidateForRequest(row.request_id, nowIso);
      }
      this.logger?.info?.(
        `Cancelled notification ${row.id}: link epoch ${row.linked_at} does not match current owner epoch ${owner.telegram_linked_at}`
      );
      return;
    }

    // 4. Decrypt reply markup if present (fail closed on decryption or authentication failure)
    let replyMarkup: TelegramInlineKeyboardMarkup | undefined;

    if (row.reply_markup_enc) {
      const encryptionKey =
        this.encryptionKey || process.env.TELEGRAM_ENCRYPTION_KEY;
      const previousEncryptionKey =
        this.previousEncryptionKey || process.env.TELEGRAM_PREVIOUS_ENCRYPTION_KEY;

      if (!encryptionKey) {
        // Missing encryption key: fail closed, do not send without encryption or plaintext buttons
        this.handleDeliveryError(
          row,
          claimId,
          new Error('TELEGRAM_ENCRYPTION_KEY is required to decrypt notification reply markup')
        );
        return;
      }

      try {
        replyMarkup = decryptReplyMarkup(
          row.reply_markup_enc,
          {
            outboxId: row.id,
            ownerId: row.owner_id,
            requestId: row.request_id ?? '',
            recipientChatId: row.recipient_chat_id,
            linkedAt: row.linked_at,
          },
          encryptionKey,
          previousEncryptionKey
        );
      } catch (decryptErr: unknown) {
        // Tampering detected, corrupted tag, or invalid key: fail closed!
        this.handleDeliveryError(row, claimId, decryptErr);
        return;
      }
    }

    // 4b. Re-attestation strictly edit-only constraint: never fall through to sendMessage
    const isReattest = row.dedup_key.startsWith('terminal_reattest:');
    if (isReattest) {
      if (!row.telegram_message_id || row.telegram_message_id <= 0) {
        this.repos.notifications.markFailed(
          row.id,
          claimId,
          nowIso,
          'RE_ATTESTATION_FAILED: Missing or invalid telegram_message_id for edit-only pass',
          true
        );
        if (this.db && row.request_id) {
          writeAuditLogEntry(this.db, this.repos, {
            actor: 'system',
            event: 'TELEGRAM_TERMINAL_RE_ATTESTATION_EXHAUSTED',
            requestId: row.request_id,
            payload: {
              dedup_key: row.dedup_key,
              error: 'Missing or invalid telegram_message_id for edit-only pass',
            },
          });
        }
        this.logger?.error?.(
          `Re-attestation ${row.id} missing valid telegram_message_id. Marked DEAD to prevent sendMessage fallthrough.`
        );
        return;
      }
    }

    // 4c. Cooperative pre-dispatch fence: abort if an intermediate row was superseded while in-flight
    if (row.event_type === 'PAYMENT_HELD' || row.event_type === 'PAYMENT_VOID_PENDING') {
      const live = this.repos.notifications.getById(row.id);
      if (
        !live ||
        live.status !== 'PROCESSING' ||
        live.claim_id !== claimId ||
        live.last_error?.includes('SUPERSEDED_PENDING')
      ) {
        this.repos.notifications.markCancelled(row.id, 'SUPERSEDED');
        this.logger?.info?.(
          `Cancelled notification ${row.id}: cooperatively superseded before dispatch`
        );
        return;
      }
    }

    const isTerminalPayment =
      row.request_id !== null &&
      !isReattest &&
      (row.event_type === 'PAYMENT_CAPTURED' ||
        row.event_type === 'PAYMENT_DENIED' ||
        row.event_type === 'PAYMENT_VOIDED' ||
        row.event_type === 'PAYMENT_FAILED' ||
        row.event_type === 'PAYMENT_EXPIRED');

    // 5. Dispatch notification to Telegram (editMessageText if telegram_message_id is known, else sendMessage)
    try {
      if (row.telegram_message_id && row.telegram_message_id > 0) {
        try {
          await this.telegramClient.editMessageText({
            chat_id: row.recipient_chat_id,
            message_id: row.telegram_message_id,
            text: row.message_text,
            parse_mode: row.parse_mode === 'HTML' ? 'HTML' : undefined,
            reply_markup: replyMarkup ?? { inline_keyboard: [] },
          });
        } catch (editErr: unknown) {
          // Idempotent success: Telegram confirms message already displays requested text
          if (
            editErr instanceof TelegramApiError &&
            editErr.code === 400 &&
            editErr.message.includes('message is not modified')
          ) {
            this.logger?.info?.(
              `Notification ${row.id} editMessageText confirmed message is already up-to-date (idempotent success)`
            );
          } else {
            throw editErr;
          }
        }

        const sent = isTerminalPayment
          ? this.repos.notifications.markTerminalSentAndScheduleReattestation({
              id: row.id,
              claimId,
              telegramMessageId: row.telegram_message_id,
              row,
            })
          : this.repos.notifications.markSent(row.id, claimId, row.telegram_message_id);

        if (!sent) {
          this.logger?.warn?.(
            `Notification ${row.id} CAS markSent failed (lease expired, cancelled, or superseded during dispatch)`
          );
        }
      } else {
        const res = await this.telegramClient.sendMessage({
          chat_id: row.recipient_chat_id,
          text: row.message_text,
          parse_mode: row.parse_mode === 'HTML' ? 'HTML' : undefined,
          reply_markup: replyMarkup,
        });

        const messageId = res.message_id ?? 0;
        const sent =
          isTerminalPayment && messageId > 0
            ? this.repos.notifications.markTerminalSentAndScheduleReattestation({
                id: row.id,
                claimId,
                telegramMessageId: messageId,
                row,
              })
            : this.repos.notifications.markSent(row.id, claimId, messageId);

        if (!sent) {
          this.logger?.warn?.(
            `Notification ${row.id} CAS markSent failed (lease expired, cancelled, or superseded during dispatch)`
          );
        }
      }
    } catch (err: unknown) {
      this.handleDeliveryError(row, claimId, err);
    }
  }

  private handleDeliveryError(
    row: NotificationOutboxRow,
    claimId: string,
    err: unknown
  ): void {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // 1. Telegram API errors
    if (err instanceof TelegramApiError) {
      // 429: Rate limit — respect Telegram retry_after parameter (bounded up to 30s)
      if (err.code === 429) {
        const retryAfterSec = Math.min(err.retryAfter ?? 5, 30);
        const nextAttempt = new Date(Date.now() + retryAfterSec * 1000).toISOString();
        this.repos.notifications.markFailed(row.id, claimId, nextAttempt, errorMsg, false);
        this.logger?.warn?.(
          `Notification ${row.id} rate-limited by Telegram (429), retrying in ${retryAfterSec}s`
        );
        return;
      }

      // 400 or 403: Permanent client error (chat not found, bot blocked, user deactivated, message can't be edited)
      if (err.code === 400 || err.code === 403) {
        this.repos.notifications.markFailed(
          row.id,
          claimId,
          new Date().toISOString(),
          errorMsg,
          true
        );
        this.logger?.warn?.(
          `Notification ${row.id} permanently failed with code ${err.code}: ${errorMsg}`
        );
        return;
      }
    }

    // 2. Ambiguous non-idempotent sendMessage handling
    const isTimeoutOrNetwork =
      err instanceof Error &&
      (err.name === 'AbortError' ||
        err.message.includes('timeout') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('aborted'));

    if (!row.telegram_message_id && isTimeoutOrNetwork) {
      // Ambiguous sendMessage: we do not know if Telegram accepted it.
      // Never automatically retry a new message to prevent duplicate delivery!
      this.repos.notifications.markFailed(
        row.id,
        claimId,
        new Date().toISOString(),
        `AMBIGUOUS_SEND_MESSAGE: ${errorMsg}`,
        true
      );
      this.logger?.warn?.(
        `Notification ${row.id} sendMessage dropped or timed out ambiguously. Marked DEAD to prevent duplicate message.`
      );
      return;
    }

    // 3. Transient server errors (5xx) or edit timeouts — bounded exponential backoff
    const isReattest = row.dedup_key.startsWith('terminal_reattest:');
    const isTerminal = row.attempt_count + 1 >= row.max_attempts;

    if (isReattest && isTerminal) {
      const exhaustedError = `RE_ATTESTATION_EXHAUSTED: ${errorMsg}`;
      this.repos.notifications.markFailed(
        row.id,
        claimId,
        new Date().toISOString(),
        exhaustedError,
        true
      );
      if (this.db && row.request_id) {
        writeAuditLogEntry(this.db, this.repos, {
          actor: 'system',
          event: 'TELEGRAM_TERMINAL_RE_ATTESTATION_EXHAUSTED',
          requestId: row.request_id,
          payload: {
            dedup_key: row.dedup_key,
            attempt_count: row.attempt_count + 1,
            error: errorMsg,
          },
        });
      }
      this.logger?.warn?.(
        `Re-attestation ${row.id} exhausted all attempts for request ${row.request_id}. Marked DEAD.`
      );
      return;
    }

    const delayMs = Math.min(1000 * Math.pow(2, row.attempt_count), 30000);
    const nextAttempt = new Date(Date.now() + delayMs).toISOString();

    this.repos.notifications.markFailed(row.id, claimId, nextAttempt, errorMsg, isTerminal);
    this.logger?.warn?.(
      `Notification ${row.id} delivery attempt ${row.attempt_count + 1}/${row.max_attempts} failed: ${errorMsg}`
    );
  }
}
