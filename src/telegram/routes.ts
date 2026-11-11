/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3-B: Telegram Account Linking Router (src/telegram/routes.ts)
 *
 * Implements:
 * - GET  /status      — Authenticated owner endpoint for Telegram linking state
 * - POST /link-token  — Authenticated + CSRF-protected endpoint for minting single-use deep link
 * - POST /unlink      — Authenticated + CSRF-protected endpoint for unlinking Telegram account
 * - POST /webhook     — Secret-token authenticated Telegram update processor
 *
 * Invariants & Policies:
 * - Dynamic authenticated owner identity: derived strictly from req.ownerSession.ownerId.
 * - Atomic transaction: Token consumption, ownership checks, binding, and audit logging
 *   occur inside a single SQLite transaction.
 * - HTTP response semantics: 200 on success, domain terminal rejection, duplicate, or ignored;
 *   403 on invalid secret; 503 on IN_PROGRESS concurrent duplicate; 500 on transient database error.
 * - Decoupled notification: Post-commit Telegram confirmation failure logs a warning but returns 200.
 */

import * as crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Database } from '../db/connection.js';
import { runInTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import type { OwnerSessionStore } from '../auth/owner.js';
import { createOwnerAuthMiddleware } from '../auth/owner.js';
import type { PayGuardConfig } from '../config/index.js';
import { getConfig } from '../config/index.js';
import type { TelegramClient } from './client.js';
import type { TelegramUpdate } from './types.js';
import {
  mintTelegramLinkToken,
  consumeTelegramLinkToken,
} from './tokens.js';
import { writeAuditLogEntry } from '../core/stateMachine.js';
import { UpdateDeduplicator } from './middleware.js';
import {
  ApprovalExecutionService,
  ApprovalValidationError,
  type ApprovalAction,
} from '../approvals/service.js';
import { formatMinorUnitsToDecimal } from '../core/money.js';
import {
  formatPaymentOutcomeMessage,
  verifyTelegramMessageAuthorization,
  type PaymentOutcomeStatus,
} from './notifications.js';

export interface TelegramRouterOptions {
  readonly db: Database;
  readonly repos: Repositories;
  readonly sessionStore: OwnerSessionStore;
  readonly isProduction?: boolean;
  readonly secureCookie?: boolean;
  readonly config?: PayGuardConfig;
  readonly telegramClient?: TelegramClient;
  readonly deduplicator?: UpdateDeduplicator;
  readonly approvalExecutionService?: ApprovalExecutionService;
  readonly logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
  };
}

export function createTelegramRouter(options: TelegramRouterOptions): Router {
  const router = Router();
  const db = options.db;
  const repos = options.repos;
  const config = options.config ?? getConfig();
  const telegramClient = options.telegramClient;
  const deduplicator = options.deduplicator ?? new UpdateDeduplicator();
  const logger = options.logger;
  const approvalExecutionService =
    options.approvalExecutionService ??
    new ApprovalExecutionService({
      db,
      repos,
      publicBaseUrl: config.publicBaseUrl,
      isProduction: options.isProduction ?? config.isProduction,
      logger,
    });

  const ownerAuth = createOwnerAuthMiddleware(options.sessionStore, {
    isProduction: options.isProduction ?? config.isProduction,
    secureCookie: options.secureCookie,
  });

  // ==========================================================================
  // 1. GET /status — Owner Telegram Linking Status
  // ==========================================================================
  router.get('/status', ownerAuth, (req: Request, res: Response): void => {
    const ownerId = req.ownerSession?.ownerId || 'default';
    const owner = repos.owners.get(ownerId);

    const isConfigured = config.telegramMode !== 'disabled' && Boolean(config.telegramBotToken);
    const isLinked = Boolean(owner?.telegram_chat_id);

    res.json({
      configured: isConfigured,
      mode: config.telegramMode,
      botUsername: config.telegramBotUsername ?? null,
      linked: isLinked,
      chatId: owner?.telegram_chat_id ?? null,
      username: owner?.telegram_username ?? null,
      linkedAt: owner?.telegram_linked_at ?? null,
    });
  });

  // ==========================================================================
  // 2. POST /link-token — Mint One-Time Cryptographic Deep Link
  // ==========================================================================
  router.post('/link-token', ownerAuth, (req: Request, res: Response): void => {
    if (config.telegramMode === 'disabled') {
      res.status(400).json({
        error: 'TELEGRAM_DISABLED',
        message: 'Telegram integration is disabled in server configuration',
      });
      return;
    }

    const ownerId = req.ownerSession?.ownerId || 'default';
    const mintResult = mintTelegramLinkToken(db, repos, {
      ownerId,
      ttlSeconds: 600, // 10 minutes
    });

    if (!mintResult.success || !mintResult.rawToken) {
      res.status(500).json({
        error: mintResult.error ?? 'MINT_FAILED',
        message: mintResult.message ?? 'Failed to generate Telegram linking token',
      });
      return;
    }

    const botUsername = config.telegramBotUsername || 'PayGuardBot';
    const deepLink = `https://t.me/${botUsername}?start=${mintResult.rawToken}`;

    res.json({
      success: true,
      deepLink,
      expiresAt: mintResult.expiresAt,
      ttlSeconds: 600,
    });
  });

  // ==========================================================================
  // 3. POST /unlink — Unlink Telegram Account
  // ==========================================================================
  router.post('/unlink', ownerAuth, (req: Request, res: Response): void => {
    const ownerId = req.ownerSession?.ownerId || 'default';
    const owner = repos.owners.get(ownerId);

    if (!owner || !owner.telegram_chat_id) {
      res.json({
        success: true,
        message: 'Account is not linked to any Telegram chat',
      });
      return;
    }

    const previousChatId = owner.telegram_chat_id;
    const previousUsername = owner.telegram_username;
    const nowIso = new Date().toISOString();

    // Atomically clear owner link, cancel pending notifications, invalidate callbacks, and write audit log
    runInTransaction(db, () => {
      repos.owners.unlinkTelegram(ownerId);
      repos.notifications.cancelPendingByOwnerId(ownerId, 'OWNER_UNLINKED');
      repos.telegramApprovalCallbacks.invalidateForOwner(ownerId, nowIso);
      writeAuditLogEntry(db, repos, {
        actor: 'owner',
        event: 'TELEGRAM_ACCOUNT_UNLINKED',
        timestamp: nowIso,
        payload: {
          owner_id: ownerId,
          previous_chat_id: previousChatId,
          previous_user_id: owner.telegram_user_id ?? null,
          previous_username: previousUsername,
        },
      });
    });

    // Best-effort unlinked notification to previous Telegram chat (fail-soft)
    if (telegramClient && previousChatId) {
      void telegramClient
        .sendMessage({
          chat_id: previousChatId,
          text: 'ℹ️ Your Telegram account has been unlinked from PayGuard.',
        })
        .catch((err: unknown) => {
          logger?.warn?.(
            `[TelegramRouter] Failed to send unlink notification to ${previousChatId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        });
    }

    res.json({
      success: true,
      message: 'Telegram account unlinked successfully',
    });
  });

  // ==========================================================================
  // 4. POST /webhook — Telegram Webhook Handler (/start <token>)
  // ==========================================================================
  router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
    const update = req.body as TelegramUpdate | undefined;
    const updateId = update?.update_id;

    // Deduplication check
    if (updateId !== undefined) {
      const state = deduplicator.get(updateId);
      if (state === 'COMPLETED') {
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      if (state === 'IN_PROGRESS') {
        res.setHeader('Retry-After', '2');
        res.status(503).json({ error: 'Update is currently in progress', retryAfter: 2 });
        return;
      }
      deduplicator.markInProgress(updateId);
    }

    try {
      const callbackQuery = update?.callback_query;
      const message = update?.message;

      // ========================================================================
      // Branch A: Process Inline Keyboard Callback Query (Approval / Void)
      // ========================================================================
      if (callbackQuery) {
        const queryId = callbackQuery.id;
        const fromUser = callbackQuery.from;
        const chat = callbackQuery.message?.chat;

        // 1. Enforce private chats: group / channel callbacks are rejected
        if (!chat || chat.type !== 'private') {
          if (telegramClient && queryId) {
            void telegramClient
              .answerCallbackQuery({
                callback_query_id: queryId,
                text: '⚠️ Actions can only be performed in private chats with the bot.',
                show_alert: true,
              })
              .catch(() => {});
          }
          if (updateId !== undefined) deduplicator.markCompleted(updateId);
          res.status(200).json({ ok: true, ignored: 'non_private_chat' });
          return;
        }

        // 2. Validate numeric identity: from.id and chat.id must be valid numbers
        const fromId = fromUser?.id;
        const chatId = chat.id;
        if (
          typeof fromId !== 'number' ||
          !Number.isSafeInteger(fromId) ||
          fromId <= 0 ||
          typeof chatId !== 'number' ||
          !Number.isSafeInteger(chatId)
        ) {
          if (telegramClient && queryId) {
            void telegramClient
              .answerCallbackQuery({
                callback_query_id: queryId,
                text: '❌ Invalid caller or chat identity.',
                show_alert: true,
              })
              .catch(() => {});
          }
          if (updateId !== undefined) deduplicator.markCompleted(updateId);
          res.status(200).json({ ok: true, error: 'INVALID_CALLER_IDENTITY' });
          return;
        }

        const telegramUserId = String(fromId);
        const telegramChatId = String(chatId);

        // 3. Parse action and raw token from callback_data
        const data = callbackQuery.data;
        let action: ApprovalAction | undefined;
        let rawCallbackToken = '';

        if (typeof data === 'string') {
          const trimmed = data.trim();
          if (trimmed.startsWith('pg:app:')) {
            action = 'APPROVE';
            rawCallbackToken = trimmed.slice(7).trim();
          } else if (trimmed.startsWith('pg:void:')) {
            action = 'VOID';
            rawCallbackToken = trimmed.slice(8).trim();
          } else if (trimmed.startsWith('app:')) {
            action = 'APPROVE';
            rawCallbackToken = trimmed.slice(4).trim();
          } else if (trimmed.startsWith('void:')) {
            action = 'VOID';
            rawCallbackToken = trimmed.slice(5).trim();
          } else if (trimmed.length > 0) {
            // Raw token without prefix: look up action from callback record
            rawCallbackToken = trimmed;
            const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
            const cb = repos.telegramApprovalCallbacks.getByTokenHash(hash);
            if (cb) {
              action = cb.action;
            }
          }
        }

        if (!action || !rawCallbackToken) {
          if (telegramClient && queryId) {
            void telegramClient
              .answerCallbackQuery({
                callback_query_id: queryId,
                text: '❌ Invalid or unrecognized callback action data.',
                show_alert: true,
              })
              .catch(() => {});
          }
          if (updateId !== undefined) deduplicator.markCompleted(updateId);
          res.status(200).json({ ok: true, error: 'INVALID_CALLBACK_DATA' });
          return;
        }

        // Pre-fetch callback and owner rows to evaluate message modification authorization
        const tokenHash = crypto.createHash('sha256').update(rawCallbackToken).digest('hex');
        const callbackRow = repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
        const ownerRow = callbackRow ? repos.owners.get(callbackRow.owner_id) : undefined;
        const messageId = callbackQuery.message?.message_id;
        const outboxRow = callbackRow
          ? repos.notifications.getByDedupKey(`payment_held:${callbackRow.request_id}`)
          : undefined;

        const isMessageAuthorized =
          callbackRow && ownerRow
            ? verifyTelegramMessageAuthorization({
                ownerId: ownerRow.id,
                expectedOwnerId: callbackRow.owner_id,
                originalRecipientChatId: callbackRow.telegram_chat_id,
                currentOwnerChatId: ownerRow.telegram_chat_id,
                incomingChatId: chatId,
                callbackLinkEpoch: callbackRow.linked_at,
                currentOwnerLinkEpoch: ownerRow.telegram_linked_at,
                messageId: messageId,
                expectedMessageId: outboxRow?.telegram_message_id ?? null,
              }).authorized
            : false;

        // 4. Dispatch through shared ApprovalExecutionService
        try {
          const outcome = await approvalExecutionService.execute({
            action,
            credentials: {
              channel: 'telegram',
              rawCallbackToken,
              telegramUserId,
              telegramChatId,
            },
            onClaimed: (_claimedReq) => {
              if (!telegramClient) return;

              const intermediateText =
                action === 'APPROVE'
                  ? '⏳ Request verified. Contacting PayPal to complete payment...'
                  : '⏳ Request verified. Voiding payment hold...';

              // Bounded independent timeout controller for prompt intermediate acknowledgement
              const ackController = new AbortController();
              const ackTimeoutId = setTimeout(() => {
                ackController.abort();
              }, 750);

              const reqOptions = {
                signal: ackController.signal,
                timeoutMs: 750,
                maxRetries: 0,
              };

              const p1 = queryId
                ? telegramClient
                    .answerCallbackQuery(
                      {
                        callback_query_id: queryId,
                        text: intermediateText,
                        show_alert: false,
                      },
                      reqOptions
                    )
                    .catch((err) => {
                      logger?.warn?.(
                        `[TelegramRouter] onClaimed answerCallbackQuery failed: ${
                          err instanceof Error ? err.message : String(err)
                        }`
                      );
                    })
                : Promise.resolve();

              // Only clear buttons if message modification is authorized
              const p2 = isMessageAuthorized && messageId
                ? telegramClient
                    .editMessageReplyMarkup(
                      {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: { inline_keyboard: [] },
                      },
                      reqOptions
                    )
                    .catch((err) => {
                      logger?.warn?.(
                        `[TelegramRouter] onClaimed editMessageReplyMarkup failed: ${
                          err instanceof Error ? err.message : String(err)
                        }`
                      );
                    })
                : Promise.resolve();

              void Promise.allSettled([p1, p2]).finally(() => {
                clearTimeout(ackTimeoutId);
              });
            },
          });

          // Mark update completed in deduplicator
          if (updateId !== undefined) deduplicator.markCompleted(updateId);

          // 5. Send Telegram feedback (decoupled from payment success)
          if (telegramClient && isMessageAuthorized && messageId) {
            try {
              let outcomeStatus: PaymentOutcomeStatus;

              if (outcome.action === 'APPROVE') {
                if (outcome.status === 'CAPTURED') {
                  outcomeStatus = 'CAPTURED';
                } else if (outcome.status === 'CAPTURING') {
                  outcomeStatus = 'CAPTURING';
                } else {
                  outcomeStatus = 'FAILED';
                }
              } else {
                if (outcome.remoteVoidStatus === 'CONFIRMED' || outcome.remoteVoidSuccess) {
                  outcomeStatus = 'VOID_CONFIRMED';
                } else if (outcome.remoteVoidStatus === 'PENDING') {
                  outcomeStatus = 'VOID_PENDING';
                } else {
                  outcomeStatus = 'VOID_FAILED';
                }
              }

              // Reconstruct message strictly from trusted database records (never reuse callbackQuery.message.text)
              const paymentReq = repos.paymentRequests.getById(outcome.requestId);
              const vendor = paymentReq?.vendor_id ? repos.vendors.getById(paymentReq.vendor_id) : null;
              const vendorName = vendor?.name || paymentReq?.vendor_id || 'Unknown Vendor';
              const amountDecimal = paymentReq ? formatMinorUnitsToDecimal(paymentReq.amount_minor) : '0.00';
              const currency = paymentReq?.currency || 'USD';
              const purpose = paymentReq?.purpose || '';
              const captureId =
                outcome.action === 'APPROVE' && outcome.status === 'CAPTURED'
                  ? outcome.captureId
                  : null;

              const updatedMessageText = formatPaymentOutcomeMessage({
                requestId: outcome.requestId,
                amountDecimal,
                currency,
                vendorName,
                purpose,
                status: outcomeStatus,
                publicBaseUrl: config.publicBaseUrl,
                isProduction: options.isProduction ?? config.isProduction,
                captureId,
              });

              try {
                await telegramClient.editMessageText({
                  chat_id: chatId,
                  message_id: messageId,
                  text: updatedMessageText,
                  parse_mode: 'HTML',
                  reply_markup: { inline_keyboard: [] },
                });
              } catch {
                // Fall back to just clearing the buttons
                await telegramClient
                  .editMessageReplyMarkup({
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: { inline_keyboard: [] },
                  })
                  .catch(() => {});
              }
            } catch (notifyErr: unknown) {
              logger?.warn?.(
                `[TelegramRouter] Post-approval Telegram response delivery failed: ${
                  notifyErr instanceof Error ? notifyErr.message : String(notifyErr)
                }`
              );
            }
          }

          res.status(200).json({ ok: true, outcome });
          return;
        } catch (execErr: unknown) {
          // Mark completed so Telegram does not retry domain rejections
          if (updateId !== undefined) deduplicator.markCompleted(updateId);

          if (execErr instanceof ApprovalValidationError) {
            let errorFeedback = '❌ Action failed: Validation error.';
            let shouldClearControls = true;

            if (execErr.code === 'TOKEN_ALREADY_USED') {
              errorFeedback = '⚠️ This payment request has already been decided.';
            } else if (execErr.code === 'TOKEN_EXPIRED' || execErr.code === 'HOLD_EXPIRED') {
              errorFeedback = '⏱️ This payment approval hold has expired.';
            } else if (
              execErr.code === 'USER_MISMATCH' ||
              execErr.code === 'CHAT_MISMATCH' ||
              execErr.code === 'OWNER_NOT_FOUND' ||
              execErr.code === 'OWNER_UNLINKED' ||
              execErr.code === 'OWNER_USER_MISMATCH' ||
              execErr.code === 'STALE_LINK_EPOCH'
            ) {
              errorFeedback = '⛔ Unauthorized: Telegram account is not linked to this owner.';
              shouldClearControls = false; // Don't modify owner's message on unauthorized attempt
            } else if (execErr.code === 'SNAPSHOT_MISMATCH') {
              errorFeedback = '❌ Security alert: Payment details mismatch detected.';
            } else if (execErr.code === 'INVALID_REQUEST_STATUS') {
              errorFeedback = '⚠️ Payment request is no longer awaiting decision.';
            } else {
              errorFeedback = `❌ Action rejected: ${execErr.message}`;
            }

            if (telegramClient) {
              try {
                if (queryId) {
                  await telegramClient.answerCallbackQuery({
                    callback_query_id: queryId,
                    text: errorFeedback,
                    show_alert: true,
                  });
                }
                const messageId = callbackQuery.message?.message_id;
                if (shouldClearControls && isMessageAuthorized && messageId) {
                  await telegramClient
                    .editMessageReplyMarkup({
                      chat_id: chatId,
                      message_id: messageId,
                      reply_markup: { inline_keyboard: [] },
                    })
                    .catch(() => {});
                }
              } catch (clientErr: unknown) {
                logger?.warn?.(
                  `[TelegramRouter] Failed to deliver validation error feedback to Telegram: ${
                    clientErr instanceof Error ? clientErr.message : String(clientErr)
                  }`
                );
              }
            }

            res.status(200).json({ ok: true, error: execErr.code, message: execErr.message });
            return;
          }

          // Unexpected or database errors
          logger?.error?.(
            `[TelegramRouter] Unexpected error executing callback query ${queryId}: ${
              execErr instanceof Error ? execErr.message : String(execErr)
            }`
          );

          if (telegramClient && queryId) {
            void telegramClient
              .answerCallbackQuery({
                callback_query_id: queryId,
                text: '❌ An error occurred while processing the request.',
                show_alert: true,
              })
              .catch(() => {});
          }

          // Database or internal server error: rethrow to return 500 and allow Telegram retry if appropriate
          throw execErr;
        }
      }

      // ========================================================================
      // Branch B: Process /start Commands & Account Linking
      // ========================================================================

      // 1. Non-text or unsupported update types: acknowledge and ignore
      if (!message || typeof message.text !== 'string') {
        if (updateId !== undefined) deduplicator.markCompleted(updateId);
        res.status(200).json({ ok: true, ignored: true });
        return;
      }

      // 2. Enforce private chats: group/channel interactions are rejected
      if (message.chat.type !== 'private') {
        if (telegramClient) {
          void telegramClient
            .sendMessage({
              chat_id: message.chat.id,
              text: '⚠️ PayGuard account linking must be performed in a private chat with the bot.',
            })
            .catch(() => {});
        }
        if (updateId !== undefined) deduplicator.markCompleted(updateId);
        res.status(200).json({ ok: true, ignored: 'non_private_chat' });
        return;
      }

      const text = message.text.trim();
      const match = text.match(/^\/start(?:\s+(.+))?$/);

      // 3. Not a /start command: provide helpful welcome instructions
      if (!match) {
        if (telegramClient) {
          void telegramClient
            .sendMessage({
              chat_id: message.chat.id,
              text: 'Welcome to PayGuard. To link your account, use the linking link from your PayGuard Dashboard Settings.',
            })
            .catch(() => {});
        }
        if (updateId !== undefined) deduplicator.markCompleted(updateId);
        res.status(200).json({ ok: true, ignored: 'not_start_command' });
        return;
      }

      const rawToken = match[1]?.trim();

      // 4. /start without token parameter
      if (!rawToken) {
        if (telegramClient) {
          void telegramClient
            .sendMessage({
              chat_id: message.chat.id,
              text: 'Welcome to PayGuard. To link your Telegram account for payment approvals, log in to your PayGuard dashboard and click "Link Telegram".',
            })
            .catch(() => {});
        }
        if (updateId !== undefined) deduplicator.markCompleted(updateId);
        res.status(200).json({ ok: true, action: 'start_without_token' });
        return;
      }

      // 5. Validate caller identity (fail closed: reject bots and missing/non-positive IDs)
      const fromUser = message.from;
      if (fromUser?.is_bot === true) {
        if (updateId !== undefined) deduplicator.markCompleted(updateId);
        res.status(200).json({ ok: true, error: 'BOT_NOT_ALLOWED' });
        return;
      }

      const fromId = fromUser?.id;
      const chatId = message.chat.id;
      if (
        typeof fromId !== 'number' ||
        !Number.isSafeInteger(fromId) ||
        fromId <= 0 ||
        typeof chatId !== 'number' ||
        !Number.isSafeInteger(chatId)
      ) {
        if (updateId !== undefined) deduplicator.markCompleted(updateId);
        res.status(200).json({ ok: true, error: 'INVALID_CALLER_IDENTITY' });
        return;
      }

      // 6. Stage 1: Execute atomic SQLite transaction
      const username = fromUser?.username || null;

      const consumeResult = consumeTelegramLinkToken(db, repos, {
        rawToken,
        chatId,
        userId: fromId,
        username,
      });

      // 7. Handle domain result
      if (!consumeResult.success) {
        // Terminal domain failure: mark completed so Telegram does not retry
        if (updateId !== undefined) deduplicator.markCompleted(updateId);

        let replyMessage = '❌ Linking failed: Invalid token.';
        if (consumeResult.error === 'INVALID_TOKEN_FORMAT') {
          replyMessage = '❌ Invalid linking token format. Please generate a new link from your PayGuard dashboard.';
        } else if (consumeResult.error === 'INVALID_CALLER_IDENTITY') {
          replyMessage = '❌ Linking failed: Invalid Telegram caller identity.';
        } else if (consumeResult.error === 'TOKEN_NOT_FOUND') {
          replyMessage = '❌ Linking token not found or unrecognized. Please generate a fresh link from your dashboard.';
        } else if (consumeResult.error === 'TOKEN_EXPIRED') {
          replyMessage = '❌ This linking token has expired. Please generate a fresh link from your PayGuard dashboard.';
        } else if (consumeResult.error === 'TOKEN_ALREADY_USED') {
          replyMessage = '❌ This linking token has already been used.';
        } else if (consumeResult.error === 'CONFLICTING_OWNERSHIP') {
          replyMessage =
            '❌ Linking rejected: PayGuard is already linked to another Telegram account. Please unlink your previous account from the dashboard first.';
        } else if (consumeResult.error === 'CHAT_ALREADY_BOUND') {
          replyMessage =
            '❌ Linking rejected: This Telegram account is already linked to another PayGuard instance.';
        }

        if (telegramClient) {
          void telegramClient.sendMessage({ chat_id: chatId, text: replyMessage }).catch(() => {});
        }

        res.status(200).json({ ok: true, error: consumeResult.error });
        return;
      }

      // 8. Stage 1 committed successfully! Mark update completed
      if (updateId !== undefined) deduplicator.markCompleted(updateId);

      // 9. Stage 2: Best-effort Telegram confirmation delivery (decoupled from DB success)
      if (telegramClient) {
        try {
          await telegramClient.sendMessage({
            chat_id: chatId,
            text: '✅ PayGuard account linked successfully! You will receive payment approval notifications here.',
          });
        } catch (msgErr: unknown) {
          // Log sanitized error but DO NOT return 500 — DB state is already committed!
          logger?.warn?.(
            `[TelegramRouter] Post-commit Telegram confirmation delivery failed for chat ${chatId}: ${
              msgErr instanceof Error ? msgErr.message : String(msgErr)
            }`
          );
        }
      }

      res.status(200).json({ ok: true, linked: true, ownerId: consumeResult.ownerId });
    } catch (err: unknown) {
      // Clear in-flight state so Telegram retry can be processed
      if (updateId !== undefined) deduplicator.clear(updateId);

      logger?.error?.(
        `[TelegramRouter] Webhook error processing update ${updateId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

