/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3-C: Telegram Payment Notifications
 *
 * Implements:
 * - HTML escaping for Telegram HTML parse mode
 * - Structured message templates for 7 notification event types
 * - Transactional outbox enqueuing helper (link-epoch validated)
 */

import * as crypto from 'node:crypto';
import type { Database } from '../db/connection.js';
import { runInTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import type { NotificationEventType } from '../db/types.js';
import { writeAuditLogEntry } from '../core/stateMachine.js';
import { formatMinorUnitsToDecimal } from '../core/money.js';
import { sanitizePublicBaseUrl } from '../config/index.js';
import type { TelegramInlineKeyboardMarkup } from './types.js';
import { mintTelegramApprovalCallbacks } from './tokens.js';
import { encryptReplyMarkup } from './crypto.js';

/**
 * Escapes text for Telegram HTML parse mode.
 * Allowed tags in Telegram HTML: <b>, <i>, <code>, <s>, <u>, <pre>, <a href="...">
 * Characters '&', '<', '>', and '"' must be escaped.
 */
export function escapeTelegramHtml(text: string | null | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface PaymentHeldParams {
  readonly requestId: string;
  readonly amountDecimal: string;
  readonly currency: string;
  readonly vendorName: string;
  readonly purpose: string;
  readonly expiresAt: string;
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
}

export function formatPaymentHeldMessage(params: PaymentHeldParams): string {
  const safePublicBaseUrl = sanitizePublicBaseUrl(params.publicBaseUrl, params.isProduction);
  const lines = [
    '⏳ <b>Payment Held for Review</b>',
    '',
    `<b>Request ID:</b> <code>${escapeTelegramHtml(params.requestId)}</code>`,
    `<b>Amount:</b> ${escapeTelegramHtml(params.amountDecimal)} ${escapeTelegramHtml(params.currency)}`,
    `<b>Vendor:</b> ${escapeTelegramHtml(params.vendorName)}`,
    `<b>Purpose:</b> ${escapeTelegramHtml(params.purpose)}`,
    `<b>Expires At:</b> ${escapeTelegramHtml(params.expiresAt)}`,
  ];
  if (safePublicBaseUrl) {
    const dashboardUrl = `${safePublicBaseUrl}/#/requests/${encodeURIComponent(params.requestId)}`;
    lines.push('');
    lines.push(`👉 <a href="${escapeTelegramHtml(dashboardUrl)}">Review in Dashboard</a>`);
  }
  return lines.join('\n');
}

export interface PaymentDeniedParams {
  readonly requestId: string;
  readonly amountDecimal: string;
  readonly currency: string;
  readonly vendorName: string;
  readonly reasons: readonly string[];
}

export function formatPaymentDeniedMessage(params: PaymentDeniedParams): string {
  const reasonsFormatted =
    params.reasons.length > 0
      ? params.reasons.map((r) => `• ${escapeTelegramHtml(r)}`).join('\n')
      : '• Policy violation';
  return [
    '🚫 <b>Payment Request Denied</b>',
    '',
    `<b>Request ID:</b> <code>${escapeTelegramHtml(params.requestId)}</code>`,
    `<b>Amount:</b> ${escapeTelegramHtml(params.amountDecimal)} ${escapeTelegramHtml(params.currency)}`,
    `<b>Vendor:</b> ${escapeTelegramHtml(params.vendorName)}`,
    '<b>Reasons:</b>',
    reasonsFormatted,
  ].join('\n');
}

export interface PaymentVoidedParams {
  readonly requestId: string;
  readonly amountDecimal: string;
  readonly currency: string;
  readonly vendorName: string;
  readonly reason?: string;
  readonly remoteVoidStatus?: 'CONFIRMED' | 'PENDING' | 'FAILED';
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
}

export function formatPaymentVoidedMessage(params: PaymentVoidedParams): string {
  let statusNote: string;
  if (params.remoteVoidStatus === 'CONFIRMED') {
    statusNote = 'Payment voided locally. PayPal authorization cancellation confirmed.';
  } else if (params.remoteVoidStatus === 'FAILED') {
    statusNote = 'Payment voided locally and budget reservation released. PayPal cancellation failed and requires attention.';
  } else {
    statusNote = 'Payment voided locally and budget reservation released. PayPal cancellation is pending reconciliation.';
  }

  const lines = [
    '🛑 <b>Payment Request Voided</b>',
    '',
    `<b>Request ID:</b> <code>${escapeTelegramHtml(params.requestId)}</code>`,
    `<b>Amount:</b> ${escapeTelegramHtml(params.amountDecimal)} ${escapeTelegramHtml(params.currency)}`,
    `<b>Vendor:</b> ${escapeTelegramHtml(params.vendorName)}`,
    `<b>Reason:</b> ${escapeTelegramHtml(params.reason || 'Voided by owner')}`,
    `<b>Status:</b> ${escapeTelegramHtml(statusNote)}`,
  ];

  const safePublicBaseUrl = sanitizePublicBaseUrl(params.publicBaseUrl, params.isProduction);
  if (safePublicBaseUrl) {
    const dashboardUrl = `${safePublicBaseUrl}/#/requests/${encodeURIComponent(params.requestId)}`;
    lines.push('');
    lines.push(`👉 <a href="${escapeTelegramHtml(dashboardUrl)}">View in Dashboard</a>`);
  }

  return lines.join('\n');
}

export interface PaymentExpiredParams {
  readonly requestId: string;
  readonly amountDecimal: string;
  readonly currency: string;
  readonly vendorName: string;
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
}

export function formatPaymentExpiredMessage(params: PaymentExpiredParams): string {
  const lines = [
    '⏰ <b>Payment Approval Expired</b>',
    '',
    `<b>Request ID:</b> <code>${escapeTelegramHtml(params.requestId)}</code>`,
    `<b>Amount:</b> ${escapeTelegramHtml(params.amountDecimal)} ${escapeTelegramHtml(params.currency)}`,
    `<b>Vendor:</b> ${escapeTelegramHtml(params.vendorName)}`,
    'The hold duration elapsed without owner approval. The reservation has been released.',
  ];

  const safePublicBaseUrl = sanitizePublicBaseUrl(params.publicBaseUrl, params.isProduction);
  if (safePublicBaseUrl) {
    const dashboardUrl = `${safePublicBaseUrl}/#/requests/${encodeURIComponent(params.requestId)}`;
    lines.push('');
    lines.push(`👉 <a href="${escapeTelegramHtml(dashboardUrl)}">View in Dashboard</a>`);
  }

  return lines.join('\n');
}

export interface PaymentCapturedParams {
  readonly requestId: string;
  readonly amountDecimal: string;
  readonly currency: string;
  readonly vendorName: string;
  readonly purpose?: string;
  readonly captureId?: string | null;
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
}

export function formatPaymentCapturedMessage(params: PaymentCapturedParams): string {
  const lines = [
    '✅ <b>Payment Approved &amp; Captured</b>',
    '',
    `<b>Request ID:</b> <code>${escapeTelegramHtml(params.requestId)}</code>`,
    `<b>Amount:</b> ${escapeTelegramHtml(params.amountDecimal)} ${escapeTelegramHtml(params.currency)}`,
    `<b>Vendor:</b> ${escapeTelegramHtml(params.vendorName)}`,
  ];
  if (params.purpose) {
    lines.push(`<b>Purpose:</b> ${escapeTelegramHtml(params.purpose)}`);
  }
  lines.push('<b>Status:</b> ✅ Captured successfully');
  if (params.captureId) {
    lines.push(`<b>Capture ID:</b> <code>${escapeTelegramHtml(params.captureId)}</code>`);
  }
  const safePublicBaseUrl = sanitizePublicBaseUrl(params.publicBaseUrl, params.isProduction);
  if (safePublicBaseUrl) {
    const dashboardUrl = `${safePublicBaseUrl}/#/requests/${encodeURIComponent(params.requestId)}`;
    lines.push('');
    lines.push(`👉 <a href="${escapeTelegramHtml(dashboardUrl)}">View in Dashboard</a>`);
  }
  return lines.join('\n');
}

export interface PaymentFailedParams {
  readonly requestId: string;
  readonly amountDecimal: string;
  readonly currency: string;
  readonly vendorName: string;
  readonly reason?: string;
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
}

export function formatPaymentFailedMessage(params: PaymentFailedParams): string {
  const lines = [
    '❌ <b>Payment Execution Failed</b>',
    '',
    `<b>Request ID:</b> <code>${escapeTelegramHtml(params.requestId)}</code>`,
    `<b>Amount:</b> ${escapeTelegramHtml(params.amountDecimal)} ${escapeTelegramHtml(params.currency)}`,
    `<b>Vendor:</b> ${escapeTelegramHtml(params.vendorName)}`,
    '<b>Status:</b> ❌ Execution failed at PayPal',
  ];
  if (params.reason) {
    lines.push(`<b>Reason:</b> ${escapeTelegramHtml(params.reason)}`);
  }
  const safePublicBaseUrl = sanitizePublicBaseUrl(params.publicBaseUrl, params.isProduction);
  if (safePublicBaseUrl) {
    const dashboardUrl = `${safePublicBaseUrl}/#/requests/${encodeURIComponent(params.requestId)}`;
    lines.push('');
    lines.push(`👉 <a href="${escapeTelegramHtml(dashboardUrl)}">View in Dashboard</a>`);
  }
  return lines.join('\n');
}

export interface BudgetWarningParams {
  readonly targetType: 'VENDOR' | 'AGENT' | 'GLOBAL';
  readonly targetName: string;
  readonly targetId: string;
  readonly usedDecimal: string;
  readonly totalDecimal: string;
  readonly currency: string;
  readonly percent: number;
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
}

export function formatBudgetWarningMessage(params: BudgetWarningParams): string {
  const dashboardPath =
    params.targetType === 'VENDOR'
      ? '/#/vendors'
      : params.targetType === 'AGENT'
        ? '/#/agents'
        : '/#/';
  const lines = [
    '⚠️ <b>Budget Threshold Warning</b>',
    '',
    `<b>Target:</b> ${escapeTelegramHtml(params.targetType)} (${escapeTelegramHtml(params.targetName)})`,
    `<b>Usage:</b> ${escapeTelegramHtml(params.usedDecimal)} / ${escapeTelegramHtml(params.totalDecimal)} ${escapeTelegramHtml(params.currency)} (${params.percent}%)`,
  ];
  const safePublicBaseUrl = sanitizePublicBaseUrl(params.publicBaseUrl, params.isProduction);
  if (safePublicBaseUrl) {
    const dashboardUrl = `${safePublicBaseUrl}${dashboardPath}`;
    lines.push('');
    lines.push(`👉 <a href="${escapeTelegramHtml(dashboardUrl)}">View Budget Details</a>`);
  }
  return lines.join('\n');
}

export interface SecurityHighRiskParams {
  readonly agentId: string;
  readonly agentName?: string;
  readonly ruleName: string;
  readonly purpose: string;
  readonly requestId?: string;
}

export function formatSecurityHighRiskMessage(params: SecurityHighRiskParams): string {
  const lines = [
    '🚨 <b>Security Alert: High-Risk Activity Detected</b>',
    '',
    `<b>Agent:</b> ${escapeTelegramHtml(params.agentName || params.agentId)} (<code>${escapeTelegramHtml(params.agentId)}</code>)`,
    `<b>Rule Triggered:</b> ${escapeTelegramHtml(params.ruleName)}`,
    `<b>Suspicious Input:</b> <code>${escapeTelegramHtml(params.purpose)}</code>`,
  ];
  if (params.requestId) {
    lines.push(`<b>Request ID:</b> <code>${escapeTelegramHtml(params.requestId)}</code>`);
  }
  return lines.join('\n');
}

export interface SecurityLinkConflictParams {
  readonly attemptedChatId: string;
  readonly timeIso: string;
}

export function formatSecurityLinkConflictMessage(params: SecurityLinkConflictParams): string {
  return [
    '🛡️ <b>Security Alert: Unauthorized Telegram Link Attempt</b>',
    '',
    'An attempt was made to link another Telegram account to your PayGuard dashboard.',
    `<b>Attempted Chat ID:</b> <code>${escapeTelegramHtml(params.attemptedChatId)}</code>`,
    `<b>Time:</b> ${escapeTelegramHtml(params.timeIso)}`,
    '',
    'If this was not you, please verify your session security.',
  ].join('\n');
}

export type PaymentOutcomeStatus =
  | 'CAPTURED'
  | 'CAPTURING'
  | 'FAILED'
  | 'VOID_CONFIRMED'
  | 'VOID_PENDING'
  | 'VOID_FAILED';

export interface FormatPaymentOutcomeMessageParams {
  readonly requestId: string;
  readonly amountDecimal: string;
  readonly currency: string;
  readonly vendorName: string;
  readonly purpose: string;
  readonly status: PaymentOutcomeStatus;
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
  readonly captureId?: string | null;
}

/**
 * Renders an authoritative, trusted Telegram HTML message for a payment decision outcome.
 * Reconstructed strictly from trusted database records (never from incoming message text).
 * All dynamic parameters are escaped using escapeTelegramHtml().
 */
export function formatPaymentOutcomeMessage(params: FormatPaymentOutcomeMessageParams): string {
  let header: string;
  let statusText: string;

  switch (params.status) {
    case 'CAPTURED':
      header = '✅ <b>Payment Approved &amp; Captured</b>';
      statusText = '<b>Status:</b> ✅ Captured successfully';
      break;
    case 'CAPTURING':
      header = '⏳ <b>Payment Approved (Capture Pending)</b>';
      statusText = '<b>Status:</b> ⏳ Approved — Capture pending reconciliation';
      break;
    case 'FAILED':
      header = '❌ <b>Payment Execution Failed</b>';
      statusText = '<b>Status:</b> ❌ Execution failed at PayPal';
      break;
    case 'VOID_CONFIRMED':
      header = '🛑 <b>Payment Voided &amp; Cancelled</b>';
      statusText = '<b>Status:</b> 🚫 Voided — PayPal authorization cancelled';
      break;
    case 'VOID_PENDING':
      header = '🛑 <b>Payment Voided (Pending Cancellation)</b>';
      statusText = '<b>Status:</b> ⏳ Voided locally — Remote cancellation pending retry';
      break;
    case 'VOID_FAILED':
      header = '🛑 <b>Payment Voided (Remote Void Failed)</b>';
      statusText = '<b>Status:</b> ⚠️ Voided locally — Remote cancellation failed';
      break;
  }

  const lines = [
    header,
    '',
    `<b>Request ID:</b> <code>${escapeTelegramHtml(params.requestId)}</code>`,
    `<b>Amount:</b> ${escapeTelegramHtml(params.amountDecimal)} ${escapeTelegramHtml(params.currency)}`,
    `<b>Vendor:</b> ${escapeTelegramHtml(params.vendorName)}`,
    `<b>Purpose:</b> ${escapeTelegramHtml(params.purpose)}`,
    statusText,
  ];

  if (params.status === 'CAPTURED' && params.captureId) {
    lines.push(`<b>Capture ID:</b> <code>${escapeTelegramHtml(params.captureId)}</code>`);
  }

  const safePublicBaseUrl = sanitizePublicBaseUrl(params.publicBaseUrl, params.isProduction);
  if (safePublicBaseUrl) {
    const dashboardUrl = `${safePublicBaseUrl}/#/requests/${encodeURIComponent(params.requestId)}`;
    lines.push('');
    lines.push(`👉 <a href="${escapeTelegramHtml(dashboardUrl)}">View in Dashboard</a>`);
  }

  return lines.join('\n');
}

export interface TelegramMessageAuthorizationContext {
  readonly ownerId?: string | null;
  readonly expectedOwnerId?: string | null;
  readonly originalRecipientChatId?: string | null;
  readonly currentOwnerChatId?: string | null;
  readonly incomingChatId?: string | number | null;
  readonly callbackLinkEpoch?: string | null;
  readonly currentOwnerLinkEpoch?: string | null;
  readonly messageId?: number | null;
  readonly expectedMessageId?: number | null;
}

export interface TelegramMessageAuthorizationResult {
  readonly authorized: boolean;
  readonly reason?: string;
}

/**
 * Enforces the 5-point authorization contract before allowing any Telegram message modifications:
 * 1. Correct owner ID.
 * 2. Original recipient chat ID matches incoming chat ID.
 * 3. Current owner Telegram chat ID matches original recipient chat ID.
 * 4. Exact link-epoch match (prevents unlink/relink token attacks).
 * 5. Valid original Telegram message ID (positive safe integer, matching outbox if tracked).
 */
export function verifyTelegramMessageAuthorization(
  context: TelegramMessageAuthorizationContext
): TelegramMessageAuthorizationResult {
  // 1. Valid stored outbox message ID (must be positive safe integer)
  if (
    typeof context.expectedMessageId !== 'number' ||
    !Number.isSafeInteger(context.expectedMessageId) ||
    context.expectedMessageId <= 0
  ) {
    return { authorized: false, reason: 'INVALID_STORED_MESSAGE_ID' };
  }

  // 2. Valid incoming callback message ID (must be positive safe integer)
  if (
    typeof context.messageId !== 'number' ||
    !Number.isSafeInteger(context.messageId) ||
    context.messageId <= 0
  ) {
    return { authorized: false, reason: 'INVALID_MESSAGE_ID' };
  }

  // 3. Exact equality between stored and incoming message ID
  if (context.messageId !== context.expectedMessageId) {
    return { authorized: false, reason: 'MESSAGE_ID_MISMATCH' };
  }

  // 2. Correct owner ID
  if (
    !context.ownerId ||
    !context.expectedOwnerId ||
    context.ownerId !== context.expectedOwnerId
  ) {
    return { authorized: false, reason: 'OWNER_MISMATCH' };
  }

  // 3. Original recipient chat ID matches incoming chat ID
  const incomingChat =
    context.incomingChatId !== null && context.incomingChatId !== undefined
      ? String(context.incomingChatId)
      : '';
  if (
    !context.originalRecipientChatId ||
    !incomingChat ||
    context.originalRecipientChatId !== incomingChat
  ) {
    return { authorized: false, reason: 'CHAT_MISMATCH' };
  }

  // 4. Current owner Telegram chat ID matches original recipient chat ID
  if (
    !context.currentOwnerChatId ||
    context.currentOwnerChatId !== context.originalRecipientChatId
  ) {
    return { authorized: false, reason: 'OWNER_CHAT_MISMATCH' };
  }

  // 5. Exact link-epoch match
  if (
    typeof context.callbackLinkEpoch !== 'string' ||
    context.callbackLinkEpoch.trim() === '' ||
    typeof context.currentOwnerLinkEpoch !== 'string' ||
    context.currentOwnerLinkEpoch.trim() === '' ||
    context.callbackLinkEpoch !== context.currentOwnerLinkEpoch
  ) {
    return { authorized: false, reason: 'STALE_LINK_EPOCH' };
  }

  return { authorized: true };
}

export interface EnqueueNotificationOptions {
  readonly eventType: NotificationEventType;
  readonly ownerId?: string;
  readonly requestId?: string | null;
  readonly dedupKey: string;
  readonly messageText: string;
  readonly parseMode?: 'HTML' | 'None';
  readonly snapshotHash?: string;
  readonly expiresAt?: string;
  readonly encryptionKey?: string;
  readonly telegramMessageId?: number | null;
}

export interface EnqueueNotificationResult {
  readonly enqueued: boolean;
  readonly id?: string;
  readonly reason?: string;
}

/**
 * Enqueues a notification into the notification_outbox table.
 * Validates that the owner exists and has an active Telegram binding.
 * Captures owner.telegram_linked_at at enqueue time for downstream link-epoch verification.
 * For PAYMENT_HELD notifications with valid encryptionKey and snapshotHash:
 * - Generates dual APPROVE and VOID callback tokens bound to link epoch.
 * - Stores token hashes in telegram_approval_callbacks.
 * - Constructs and encrypts inline keyboard using AES-256-GCM and PGA1 AAD.
 * Safe to call inside an existing SQLite transaction.
 */
export function enqueuePaymentNotification(
  repos: Repositories,
  options: EnqueueNotificationOptions
): EnqueueNotificationResult {
  const ownerId = options.ownerId ?? 'default';
  const owner = repos.owners.get(ownerId);
  if (!owner || !owner.telegram_chat_id || !owner.telegram_linked_at) {
    return { enqueued: false, reason: 'OWNER_NOT_LINKED' };
  }

  // Generate inline keyboard buttons ONLY for PAYMENT_HELD notifications
  if (
    options.eventType === 'PAYMENT_HELD' &&
    options.requestId &&
    options.snapshotHash &&
    options.expiresAt &&
    owner.telegram_user_id &&
    options.encryptionKey &&
    options.encryptionKey.trim().length === 64
  ) {
    const outboxId = crypto.randomUUID();
    const callbacks = mintTelegramApprovalCallbacks({
      repos,
      requestId: options.requestId,
      ownerId: owner.id,
      telegramChatId: owner.telegram_chat_id,
      telegramUserId: owner.telegram_user_id,
      linkedAt: owner.telegram_linked_at,
      snapshotHash: options.snapshotHash,
      expiresAt: options.expiresAt,
    });

    const markup: TelegramInlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `pg:app:${callbacks.rawApproveToken}` },
          { text: '🚫 Void', callback_data: `pg:void:${callbacks.rawVoidToken}` },
        ],
      ],
    };

    const replyMarkupEnc = encryptReplyMarkup(
      markup,
      {
        outboxId,
        ownerId: owner.id,
        requestId: options.requestId,
        recipientChatId: owner.telegram_chat_id,
        linkedAt: owner.telegram_linked_at,
      },
      options.encryptionKey
    );

    const res = repos.notifications.enqueue({
      id: outboxId,
      event_type: options.eventType,
      recipient_chat_id: owner.telegram_chat_id,
      owner_id: owner.id,
      linked_at: owner.telegram_linked_at,
      request_id: options.requestId,
      dedup_key: options.dedupKey,
      message_text: options.messageText,
      parse_mode: options.parseMode ?? 'HTML',
      reply_markup_enc: replyMarkupEnc,
    });

    if (!res.inserted) {
      return { enqueued: false, id: res.id, reason: 'DUPLICATE_DEDUP_KEY' };
    }

    return { enqueued: true, id: res.id };
  }

  const res = repos.notifications.enqueue({
    event_type: options.eventType,
    recipient_chat_id: owner.telegram_chat_id,
    owner_id: owner.id,
    linked_at: owner.telegram_linked_at,
    request_id: options.requestId ?? null,
    dedup_key: options.dedupKey,
    message_text: options.messageText,
    parse_mode: options.parseMode ?? 'HTML',
    telegram_message_id: options.telegramMessageId ?? null,
  });

  if (!res.inserted) {
    return { enqueued: false, id: res.id, reason: 'DUPLICATE_DEDUP_KEY' };
  }

  return { enqueued: true, id: res.id };
}

export interface EnqueueSecurityNotificationOptions {
  readonly agentId: string;
  readonly agentName?: string;
  readonly ruleName: string;
  readonly purpose: string;
  readonly ownerId?: string;
  readonly requestId?: string | null;
  readonly now?: Date | string;
  readonly maxPerWindow?: number; // default: 5
  readonly windowMinutes?: number; // default: 60
}

export interface EnqueueSecurityNotificationResult {
  readonly enqueued: boolean;
  readonly id?: string;
  readonly suppressed?: boolean;
  readonly reason?: string;
}

/**
 * Enqueues a SECURITY_HIGH_RISK notification with persistent SQLite rolling-window rate limiting.
 * Enforces the approved maximum of 5 alerts per rolling 60-minute window.
 * The check and reservation execute inside an atomic SQLite transaction to prevent concurrent bypass.
 * Deduplicates identical injection payloads via SHA-256 purpose hash.
 * Records suppressed security events in audit_log without sensitive source context.
 */
export function enqueueSecurityNotification(
  db: Database,
  repos: Repositories,
  options: EnqueueSecurityNotificationOptions
): EnqueueSecurityNotificationResult {
  const ownerId = options.ownerId ?? 'default';
  const owner = repos.owners.get(ownerId);
  if (!owner || !owner.telegram_chat_id || !owner.telegram_linked_at) {
    return { enqueued: false, reason: 'OWNER_NOT_LINKED' };
  }

  const recipientChatId = owner.telegram_chat_id;
  const ownerLinkedAt = owner.telegram_linked_at;

  const nowDate = options.now instanceof Date
    ? options.now
    : options.now
      ? new Date(options.now)
      : new Date();
  const nowIso = nowDate.toISOString();
  const maxPerWindow = options.maxPerWindow ?? 5;
  const windowMinutes = options.windowMinutes ?? 60;
  const windowStartIso = new Date(nowDate.getTime() - windowMinutes * 60 * 1000).toISOString();

  const purposeHash = crypto
    .createHash('sha256')
    .update(options.purpose, 'utf8')
    .digest('hex')
    .slice(0, 16);
  const dedupKey = `security_injection:${options.agentId}:${purposeHash}`;

  return runInTransaction(db, () => {
    // 1. Check if an alert with this exact dedup_key already exists
    const existing = repos.notifications.getByDedupKey(dedupKey);
    if (existing) {
      return { enqueued: false, id: existing.id, reason: 'DUPLICATE_DEDUP_KEY' };
    }

    // 2. Count persistent qualifying alert reservations in the rolling window
    // (counted independently of transient delivery status, so DEAD/FAILED/SENT/PENDING all count against quota)
    const count = repos.notifications.countInWindow({
      ownerId: owner.id,
      eventType: 'SECURITY_HIGH_RISK',
      sinceIso: windowStartIso,
    });

    // 3. Suppress if rate limit reached
    if (count >= maxPerWindow) {
      writeAuditLogEntry(db, repos, {
        actor: 'system',
        event: 'SECURITY_NOTIFICATION_RATE_LIMITED',
        timestamp: nowIso,
        payload: {
          agent_id: options.agentId,
          rule_name: options.ruleName,
          limit: maxPerWindow,
          window_minutes: windowMinutes,
          current_count: count,
          reason: 'RATE_LIMIT_EXCEEDED',
        },
      });

      return {
        enqueued: false,
        suppressed: true,
        reason: 'RATE_LIMIT_EXCEEDED',
      };
    }

    // 4. Format and enqueue atomically
    const secText = formatSecurityHighRiskMessage({
      agentId: options.agentId,
      agentName: options.agentName,
      ruleName: options.ruleName,
      purpose: options.purpose,
      requestId: options.requestId ?? undefined,
    });

    const res = repos.notifications.enqueue({
      event_type: 'SECURITY_HIGH_RISK',
      recipient_chat_id: recipientChatId,
      owner_id: owner.id,
      linked_at: ownerLinkedAt,
      request_id: options.requestId ?? null,
      dedup_key: dedupKey,
      message_text: secText,
      parse_mode: 'HTML',
      created_at: nowIso,
      next_attempt_at: nowIso,
    });

    return { enqueued: res.inserted, id: res.id };
  });
}

export interface RecoverVoidNotificationOptions {
  readonly requestId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly vendorId: string;
  readonly remoteVoidStatus: 'CONFIRMED' | 'FAILED' | 'PENDING';
  readonly reason?: string;
  readonly ownerId?: string;
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
}

export interface RecoverVoidNotificationResult {
  readonly enqueued: boolean;
  readonly updated: boolean;
  readonly id?: string;
  readonly reason?: string;
  readonly isTerminalUpdate?: boolean;
}

/**
 * Idempotently enqueues or updates a PAYMENT_VOIDED notification.
 *
 * 1. If no notification exists yet (e.g. process crashed before Phase 2 outbox enqueue),
 *    enqueues a new outbox entry using canonical dedup key payment_voided:${requestId}.
 * 2. If an outbox entry already exists with DUPLICATE_DEDUP_KEY and remoteVoidStatus !== 'PENDING':
 *    - If the existing record is still PENDING: atomically updates the message in-place
 *      without creating a duplicate.
 *    - If the existing record is PROCESSING: does not mutate its in-flight payload;
 *      enqueues a separate terminal status update using deterministic key payment_voided:${requestId}:${status}
 *      so the eventual outcome is communicated after in-flight delivery completes.
 *    - If the existing record is SENT: does not resend or mutate the original;
 *      enqueues a separate terminal status update using deterministic key payment_voided:${requestId}:${status}.
 *    - If the existing record is DEAD or FAILED: preserves dead-letter / retry semantics;
 *      does not silently mark delivered or fabricate delivery success.
 */
export function recoverVoidNotification(
  repos: Repositories,
  options: RecoverVoidNotificationOptions
): RecoverVoidNotificationResult {
  const vendor = repos.vendors.getById(options.vendorId);
  const voidedText = formatPaymentVoidedMessage({
    requestId: options.requestId,
    amountDecimal: formatMinorUnitsToDecimal(options.amountMinor),
    currency: options.currency,
    vendorName: vendor?.name ?? options.vendorId,
    reason: options.reason || 'Owner rejected and voided payment hold',
    remoteVoidStatus: options.remoteVoidStatus,
    publicBaseUrl: options.publicBaseUrl,
    isProduction: options.isProduction,
  });

  const dedupKey = `payment_voided:${options.requestId}`;

  const eventType: NotificationEventType = 'PAYMENT_VOIDED';

  // 1. Attempt to enqueue the primary notification (handles crash before Phase 2 or initial void)
  const enqueueRes = enqueuePaymentNotification(repos, {
    eventType,
    ownerId: options.ownerId ?? 'default',
    requestId: options.requestId,
    dedupKey,
    messageText: voidedText,
  });

  if (enqueueRes.enqueued) {
    if (options.remoteVoidStatus !== 'PENDING') {
      repos.notifications.supersedeIntermediateForRequest(options.requestId);
    }
    return { enqueued: true, updated: false, id: enqueueRes.id };
  }

  // 2. Primary notification already exists (DUPLICATE_DEDUP_KEY)
  if (enqueueRes.reason === 'DUPLICATE_DEDUP_KEY' && options.remoteVoidStatus !== 'PENDING') {
    // 2a. Attempt atomic in-place conditional update if still PENDING
    const updated = repos.notifications.updatePendingMessageByDedupKey(dedupKey, voidedText);
    if (updated) {
      repos.notifications.supersedeIntermediateForRequest(options.requestId);
      return {
        enqueued: false,
        updated: true,
        id: enqueueRes.id,
        reason: enqueueRes.reason,
      };
    }

    // 2b. Row exists but status is not PENDING (it is PROCESSING, SENT, DEAD, or FAILED)
    const existing = repos.notifications.getByDedupKey(dedupKey);

    // If SENT, PROCESSING, DEAD, or FAILED: deliver separate terminal status update
    // The original row's payload, status, attempt_count, and last_error are preserved untouched.
    if (
      existing?.status === 'SENT' ||
      existing?.status === 'PROCESSING' ||
      existing?.status === 'DEAD' ||
      existing?.status === 'FAILED'
    ) {
      repos.notifications.supersedeIntermediateForRequest(options.requestId);
      const terminalDedupKey = `payment_voided:${options.requestId}:${options.remoteVoidStatus.toLowerCase()}`;
      const terminalEnqueueRes = enqueuePaymentNotification(repos, {
        eventType,
        ownerId: options.ownerId ?? 'default',
        requestId: options.requestId,
        dedupKey: terminalDedupKey,
        messageText: voidedText,
      });

      return {
        enqueued: terminalEnqueueRes.enqueued,
        updated: false,
        id: terminalEnqueueRes.id ?? existing.id,
        reason: terminalEnqueueRes.reason,
        isTerminalUpdate: true,
      };
    }
  }

  return {
    enqueued: false,
    updated: false,
    id: enqueueRes.id,
    reason: enqueueRes.reason,
  };
}

/**
 * Atomically supersedes older intermediate notifications for a payment request
 * and enqueues an authoritative terminal notification row.
 */
export function enqueuePaymentTerminalOutcome(
  repos: Repositories,
  options: {
    readonly eventType: NotificationEventType;
    readonly requestId: string;
    readonly dedupKey: string;
    readonly messageText: string;
    readonly ownerId?: string;
  }
): EnqueueNotificationResult {
  // 1. Atomically cancel PENDING/FAILED intermediate rows and mark in-flight rows
  repos.notifications.supersedeIntermediateForRequest(options.requestId);

  // 2. Look up existing message ID strictly scoped to owner, chat ID and link epoch
  const ownerId = options.ownerId ?? 'default';
  const owner = repos.owners.get(ownerId);
  let telegramMessageId: number | null = null;
  if (owner?.telegram_chat_id && owner?.telegram_linked_at) {
    telegramMessageId = repos.notifications.findActiveMessageIdForRequest({
      requestId: options.requestId,
      ownerId: owner.id,
      recipientChatId: owner.telegram_chat_id,
      linkedAt: owner.telegram_linked_at,
    });
  }

  // 3. Enqueue the authoritative terminal notification with scoped telegramMessageId if available
  return enqueuePaymentNotification(repos, {
    eventType: options.eventType,
    requestId: options.requestId,
    dedupKey: options.dedupKey,
    messageText: options.messageText,
    ownerId: options.ownerId,
    telegramMessageId,
  });
}

