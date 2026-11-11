/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3-A: Telegram Account Link Tokens
 *
 * Implements:
 * - 32-byte cryptographically secure random deep-link tokens
 * - Secure persistence: only SHA-256 digests are stored in the database
 * - Single-use enforcement via atomic CAS (used_at IS NULL)
 * - Safe verification and consumption logic
 */

import * as crypto from 'node:crypto';
import type { Database } from '../db/connection.js';
import { runInTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import type { TelegramLinkTokenRow } from '../db/types.js';
import { writeAuditLogEntry } from '../core/stateMachine.js';
import {
  formatSecurityLinkConflictMessage,
  enqueuePaymentNotification,
} from './notifications.js';

export const TELEGRAM_LINK_TOKEN_BYTES = 32;
export const DEFAULT_TELEGRAM_LINK_TTL_SECONDS = 10 * 60; // 10 minutes default

export type TelegramLinkErrorCode =
  | 'INVALID_TOKEN_FORMAT'
  | 'INVALID_CALLER_IDENTITY'
  | 'TOKEN_NOT_FOUND'
  | 'TOKEN_ALREADY_USED'
  | 'TOKEN_EXPIRED'
  | 'OWNER_NOT_FOUND'
  | 'CONFLICTING_OWNERSHIP'
  | 'CHAT_ALREADY_BOUND';

export interface MintTelegramLinkTokenParams {
  readonly ownerId?: string;
  readonly ttlSeconds?: number;
  readonly now?: Date | string;
}

export interface MintTelegramLinkTokenResult {
  readonly success: boolean;
  readonly id?: string;
  readonly rawToken?: string;
  readonly tokenHash?: string;
  readonly ownerId?: string;
  readonly expiresAt?: string;
  readonly error?: TelegramLinkErrorCode;
  readonly message?: string;
}

export interface VerifyTelegramLinkTokenResult {
  readonly valid: boolean;
  readonly tokenRow?: TelegramLinkTokenRow;
  readonly error?: TelegramLinkErrorCode;
  readonly message?: string;
}

export interface ConsumeTelegramLinkTokenParams {
  readonly rawToken: string;
  readonly chatId: string | number;
  readonly userId?: string | number;
  readonly username?: string | null;
  readonly now?: Date | string;
}

export interface ConsumeTelegramLinkTokenResult {
  readonly success: boolean;
  readonly ownerId?: string;
  readonly chatId?: string;
  readonly userId?: string;
  readonly username?: string | null;
  readonly error?: TelegramLinkErrorCode;
  readonly message?: string;
}

/**
 * Generates a cryptographically secure 32-byte base64url token.
 */
export function generateRawTelegramLinkToken(): string {
  return crypto.randomBytes(TELEGRAM_LINK_TOKEN_BYTES).toString('base64url');
}

/**
 * Computes the SHA-256 digest of a raw link token.
 */
export function hashTelegramLinkToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Validates token string format (base64url representation of 32 bytes).
 */
export function isValidTelegramLinkTokenFormat(rawToken: string): boolean {
  if (typeof rawToken !== 'string') return false;
  const trimmed = rawToken.trim();
  // 32 bytes base64url is 43 characters
  return /^[A-Za-z0-9_-]{43}$/.test(trimmed);
}

/**
 * Mints a new short-lived, single-use Telegram linking token.
 * Raw token is returned once to the caller; only the SHA-256 digest is persisted.
 */
export function mintTelegramLinkToken(
  db: Database,
  repos: Repositories,
  params: MintTelegramLinkTokenParams = {}
): MintTelegramLinkTokenResult {
  const ownerId = params.ownerId ?? 'default';
  const owner = repos.owners.get(ownerId);
  if (!owner) {
    return {
      success: false,
      error: 'OWNER_NOT_FOUND',
      message: `Owner '${ownerId}' not found`,
    };
  }

  const nowMs = params.now ? new Date(params.now).getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const ttlMs = (params.ttlSeconds ?? DEFAULT_TELEGRAM_LINK_TTL_SECONDS) * 1000;
  const expiresAtIso = new Date(nowMs + ttlMs).toISOString();

  const rawToken = generateRawTelegramLinkToken();
  const tokenHash = hashTelegramLinkToken(rawToken);
  const tokenId = `tlt-${crypto.randomUUID()}`;

  runInTransaction(db, () => {
    repos.telegramLinkTokens.insert({
      id: tokenId,
      owner_id: ownerId,
      token_hash: tokenHash,
      expires_at: expiresAtIso,
      used_at: null,
      created_at: nowIso,
    });

    writeAuditLogEntry(db, repos, {
      actor: 'owner',
      event: 'TELEGRAM_LINK_TOKEN_MINTED',
      timestamp: nowIso,
      payload: {
        owner_id: ownerId,
        link_token_id: tokenId,
        expires_at: expiresAtIso,
      },
    });
  });

  return {
    success: true,
    id: tokenId,
    rawToken,
    tokenHash,
    ownerId,
    expiresAt: expiresAtIso,
  };
}

/**
 * Verifies the validity of a Telegram link token without consuming it.
 */
export function verifyTelegramLinkToken(
  _db: Database,
  repos: Repositories,
  rawToken: string,
  now?: Date | string
): VerifyTelegramLinkTokenResult {
  if (!isValidTelegramLinkTokenFormat(rawToken)) {
    return {
      valid: false,
      error: 'INVALID_TOKEN_FORMAT',
      message: 'Linking token is malformed or invalid format',
    };
  }

  const tokenHash = hashTelegramLinkToken(rawToken.trim());
  const tokenRow = repos.telegramLinkTokens.getByTokenHash(tokenHash);

  if (!tokenRow) {
    return {
      valid: false,
      error: 'TOKEN_NOT_FOUND',
      message: 'Linking token not found',
    };
  }

  if (tokenRow.used_at !== null) {
    return {
      valid: false,
      error: 'TOKEN_ALREADY_USED',
      message: 'Linking token has already been used',
    };
  }

  const nowMs = now ? new Date(now).getTime() : Date.now();
  const expiresMs = new Date(tokenRow.expires_at).getTime();
  if (expiresMs <= nowMs) {
    return {
      valid: false,
      error: 'TOKEN_EXPIRED',
      message: 'Linking token has expired',
    };
  }

  return {
    valid: true,
    tokenRow,
  };
}

/**
 * Atomically consumes a Telegram link token, verifies conflicts and global uniqueness,
 * and binds the Telegram chat ID to the owner.
 *
 * Runs inside a single SQLite transaction: a failure at any check rolls back all state changes.
 */
function parsePositiveTelegramId(rawId: string | number): string | null {
  if (typeof rawId === 'number') {
    if (!Number.isSafeInteger(rawId) || rawId <= 0) {
      return null;
    }
    return String(rawId);
  }
  if (typeof rawId === 'string') {
    const trimmed = rawId.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return null;
    }
    return trimmed;
  }
  return null;
}

export function consumeTelegramLinkToken(
  db: Database,
  repos: Repositories,
  params: ConsumeTelegramLinkTokenParams
): ConsumeTelegramLinkTokenResult {
  if (!isValidTelegramLinkTokenFormat(params.rawToken)) {
    return {
      success: false,
      error: 'INVALID_TOKEN_FORMAT',
      message: 'Linking token is malformed or invalid format',
    };
  }

  let normalizedUserId: string | null = null;
  if (params.userId !== undefined) {
    normalizedUserId = parsePositiveTelegramId(params.userId);
    if (!normalizedUserId) {
      return {
        success: false,
        error: 'INVALID_CALLER_IDENTITY',
        message: 'Invalid Telegram user identity',
      };
    }
  }

  const chatIdStr = String(params.chatId).trim();
  if (!chatIdStr || !/^-?[1-9]\d*$/.test(chatIdStr)) {
    return {
      success: false,
      error: 'INVALID_CALLER_IDENTITY',
      message: 'Invalid Telegram chat identity',
    };
  }

  const tokenHash = hashTelegramLinkToken(params.rawToken.trim());
  const nowMs = params.now ? new Date(params.now).getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cleanUsername = params.username?.trim().replace(/^@/, '') || null;

  return runInTransaction(db, () => {
    // 1. Look up token row
    const tokenRow = repos.telegramLinkTokens.getByTokenHash(tokenHash);
    if (!tokenRow) {
      return {
        success: false,
        error: 'TOKEN_NOT_FOUND',
        message: 'Linking token not found',
      };
    }

    // 2. Check if already used
    if (tokenRow.used_at !== null) {
      return {
        success: false,
        error: 'TOKEN_ALREADY_USED',
        message: 'Linking token has already been used',
      };
    }

    // 3. Check expiration
    const expiresMs = new Date(tokenRow.expires_at).getTime();
    if (expiresMs <= nowMs) {
      return {
        success: false,
        error: 'TOKEN_EXPIRED',
        message: 'Linking token has expired',
      };
    }

    // 4. Target owner verification
    const owner = repos.owners.get(tokenRow.owner_id);
    if (!owner) {
      return {
        success: false,
        error: 'OWNER_NOT_FOUND',
        message: `Owner '${tokenRow.owner_id}' not found`,
      };
    }

    // 5. Conflicting ownership check:
    // If this owner is already linked to a DIFFERENT chat ID or Telegram user ID, reject with CONFLICTING_OWNERSHIP
    const chatConflict = owner.telegram_chat_id !== null && owner.telegram_chat_id !== chatIdStr;
    const userConflict =
      normalizedUserId !== null &&
      owner.telegram_user_id !== null &&
      owner.telegram_user_id !== normalizedUserId;

    if (chatConflict || userConflict) {
      const conflictReason = chatConflict
        ? 'OWNER_ALREADY_LINKED_TO_DIFFERENT_CHAT'
        : 'OWNER_ALREADY_LINKED_TO_DIFFERENT_USER';

      writeAuditLogEntry(db, repos, {
        actor: 'owner',
        event: 'TELEGRAM_LINK_CONFLICT',
        timestamp: nowIso,
        payload: {
          owner_id: tokenRow.owner_id,
          existing_chat_id: owner.telegram_chat_id,
          attempted_chat_id: chatIdStr,
          ...(normalizedUserId !== null
            ? {
                existing_user_id: owner.telegram_user_id,
                attempted_user_id: normalizedUserId,
              }
            : {}),
          link_token_id: tokenRow.id,
          reason: conflictReason,
        },
      });

      const conflictText = formatSecurityLinkConflictMessage({
        attemptedChatId: chatIdStr,
        timeIso: nowIso,
      });
      enqueuePaymentNotification(repos, {
        eventType: 'SECURITY_LINK_CONFLICT',
        ownerId: tokenRow.owner_id,
        dedupKey: `security_conflict:${tokenRow.owner_id}:${tokenRow.id}`,
        messageText: conflictText,
      });

      return {
        success: false,
        error: 'CONFLICTING_OWNERSHIP',
        message: 'PayGuard is already linked to another Telegram account. Unlink from dashboard first.',
      };
    }

    // 6. Global chat & user uniqueness check:
    // Verify whether this chatId or userId is already bound to another owner
    const existingBoundOwner = repos.owners.getByTelegramChatId(chatIdStr);
    if (existingBoundOwner && existingBoundOwner.id !== tokenRow.owner_id) {
      writeAuditLogEntry(db, repos, {
        actor: 'owner',
        event: 'TELEGRAM_LINK_CONFLICT',
        timestamp: nowIso,
        payload: {
          owner_id: tokenRow.owner_id,
          conflicting_owner_id: existingBoundOwner.id,
          attempted_chat_id: chatIdStr,
          ...(normalizedUserId !== null ? { attempted_user_id: normalizedUserId } : {}),
          link_token_id: tokenRow.id,
          reason: 'CHAT_ALREADY_BOUND_TO_ANOTHER_OWNER',
        },
      });
      return {
        success: false,
        error: 'CHAT_ALREADY_BOUND',
        message: 'This Telegram account is already linked to another PayGuard instance.',
      };
    }

    const existingBoundByUser =
      normalizedUserId !== null ? repos.owners.getByTelegramUserId(normalizedUserId) : undefined;
    if (existingBoundByUser && existingBoundByUser.id !== tokenRow.owner_id) {
      writeAuditLogEntry(db, repos, {
        actor: 'owner',
        event: 'TELEGRAM_LINK_CONFLICT',
        timestamp: nowIso,
        payload: {
          owner_id: tokenRow.owner_id,
          conflicting_owner_id: existingBoundByUser.id,
          attempted_chat_id: chatIdStr,
          attempted_user_id: normalizedUserId,
          link_token_id: tokenRow.id,
          reason: 'USER_ALREADY_BOUND_TO_ANOTHER_OWNER',
        },
      });
      return {
        success: false,
        error: 'CHAT_ALREADY_BOUND',
        message: 'This Telegram account is already linked to another PayGuard instance.',
      };
    }

    // 7. Atomic CAS consumption (prevents concurrent race conditions)
    const consumed = repos.telegramLinkTokens.consume(tokenHash, nowIso);
    if (!consumed) {
      return {
        success: false,
        error: 'TOKEN_ALREADY_USED',
        message: 'Linking token was already consumed by another request',
      };
    }

    // 8. Bind chat_id, user_id, and metadata to owner
    const persistedUserId = normalizedUserId ?? owner.telegram_user_id ?? null;
    repos.owners.linkTelegram({
      ownerId: tokenRow.owner_id,
      chatId: chatIdStr,
      userId: persistedUserId,
      username: cleanUsername,
      linkedAtIso: nowIso,
    });

    // 9. Record state change in audit log
    writeAuditLogEntry(db, repos, {
      actor: 'owner',
      event: 'TELEGRAM_ACCOUNT_LINKED',
      timestamp: nowIso,
      payload: {
        owner_id: tokenRow.owner_id,
        chat_id: chatIdStr,
        ...(normalizedUserId !== null ? { telegram_user_id: normalizedUserId } : {}),
        username: cleanUsername,
        link_token_id: tokenRow.id,
      },
    });

    return {
      success: true,
      ownerId: tokenRow.owner_id,
      chatId: chatIdStr,
      ...(normalizedUserId !== null ? { userId: normalizedUserId } : {}),
      username: cleanUsername,
    };
  });
}

// ============================================================================
// Telegram Approval Callback Tokens (M6-T3.3)
// ============================================================================

export const TELEGRAM_APPROVAL_TOKEN_BYTES = 32;

/**
 * Generates a 32-byte cryptographically secure random callback token (base64url, 43 chars).
 */
export function generateRawTelegramApprovalToken(): string {
  return crypto.randomBytes(TELEGRAM_APPROVAL_TOKEN_BYTES).toString('base64url');
}

/**
 * Computes deterministic SHA-256 digest hex of a callback token.
 */
export function hashTelegramApprovalToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export interface MintTelegramApprovalCallbacksParams {
  readonly db?: Database;
  readonly repos: Repositories;
  readonly requestId: string;
  readonly ownerId: string;
  readonly telegramChatId: string;
  readonly telegramUserId: string;
  readonly linkedAt: string;
  readonly snapshotHash: string;
  readonly expiresAt: string;
  readonly nowIso?: string;
}

export interface MintTelegramApprovalCallbacksResult {
  readonly rawApproveToken: string;
  readonly rawVoidToken: string;
  readonly approveTokenHash: string;
  readonly voidTokenHash: string;
}

/**
 * Mints dual APPROVE and VOID callback tokens and stores only their hashes
 * in telegram_approval_callbacks bound to owner, request, chat, user, and link epoch.
 *
 * MUST execute inside an atomic SQLite write transaction.
 */
export function mintTelegramApprovalCallbacks(
  params: MintTelegramApprovalCallbacksParams
): MintTelegramApprovalCallbacksResult {
  if (
    typeof params.linkedAt !== 'string' ||
    params.linkedAt.trim().length === 0
  ) {
    throw new Error(
      'Valid non-empty linkedAt link epoch string is required to mint Telegram approval callbacks'
    );
  }

  const {
    repos,
    requestId,
    ownerId,
    telegramChatId,
    telegramUserId,
    linkedAt,
    snapshotHash,
    expiresAt,
  } = params;
  const nowIso = params.nowIso ?? new Date().toISOString();

  const rawApproveToken = generateRawTelegramApprovalToken();
  const rawVoidToken = generateRawTelegramApprovalToken();

  const approveTokenHash = hashTelegramApprovalToken(rawApproveToken);
  const voidTokenHash = hashTelegramApprovalToken(rawVoidToken);

  repos.telegramApprovalCallbacks.insert({
    token_hash: approveTokenHash,
    request_id: requestId,
    owner_id: ownerId,
    action: 'APPROVE',
    telegram_chat_id: telegramChatId,
    telegram_user_id: telegramUserId,
    snapshot_hash: snapshotHash,
    expires_at: expiresAt,
    linked_at: linkedAt,
    created_at: nowIso,
  });

  repos.telegramApprovalCallbacks.insert({
    token_hash: voidTokenHash,
    request_id: requestId,
    owner_id: ownerId,
    action: 'VOID',
    telegram_chat_id: telegramChatId,
    telegram_user_id: telegramUserId,
    snapshot_hash: snapshotHash,
    expires_at: expiresAt,
    linked_at: linkedAt,
    created_at: nowIso,
  });

  return {
    rawApproveToken,
    rawVoidToken,
    approveTokenHash,
    voidTokenHash,
  };
}

