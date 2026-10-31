/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T2: Approval Tokens (src/approvals/tokens.ts)
 *
 * Implements:
 * - Generation of 32-byte cryptographically secure random approval tokens (base64url).
 * - Secure persistence: only SHA-256 digests are stored in the database.
 *   Raw tokens are NEVER persisted, logged, or reflected in error messages.
 * - Cryptographic binding:
 *     - Bound to request_id (foreign key).
 *     - Bound to action ('APPROVE' | 'VOID').
 *     - Bound to snapshot_hash (canonical SHA-256 of request fields).
 *     - Bound to expires_at (strictly clamped to never exceed payment hold expiry).
 * - Single-use enforcement:
 *     - Atomic compare-and-swap consumption via SQLite BEGIN IMMEDIATE.
 *     - Prevents token replay across concurrent verification/consumption requests.
 * - Constant-time comparison for token hash and snapshot verification (timingSafeEqual).
 * - Fail-closed rejection of invalid, expired, consumed, mismatched, or tampered tokens.
 *
 * Security & Invariants:
 * - Hard Rule 1: Sandbox only. Never add code paths that use PayPal production.
 * - Hard Rule 2: Never commit or persist raw secrets or tokens.
 * - Hard Rule 7: Every state transition writes an audit_log row in the same transaction.
 * - Hard Rule 8: Fail closed on any error or ambiguity.
 */

import * as crypto from 'node:crypto';
import type { Database } from '../db/connection.js';
import { runInTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import type { ApprovalRow, PaymentRequestRow } from '../db/types.js';
import { computeSnapshotHash } from '../core/service.js';

// ============================================================================
// Constants & Configuration
// ============================================================================

export const APPROVAL_TOKEN_BYTES = 32;
export const DEFAULT_APPROVAL_TTL_SECONDS = 15 * 60; // 15 minutes default

// ============================================================================
// Types & Error Codes
// ============================================================================

export type ApprovalTokenErrorCode =
  | 'INVALID_TOKEN_FORMAT'
  | 'TOKEN_NOT_FOUND'
  | 'TOKEN_ALREADY_USED'
  | 'TOKEN_EXPIRED'
  | 'HOLD_EXPIRED'
  | 'REQUEST_NOT_FOUND'
  | 'REQUEST_MISMATCH'
  | 'ACTION_MISMATCH'
  | 'INVALID_REQUEST_STATUS'
  | 'SNAPSHOT_MISMATCH';

export interface MintApprovalTokenParams {
  readonly requestId: string;
  readonly action: 'APPROVE' | 'VOID';
  readonly channel?: 'web' | 'telegram';
  readonly ttlSeconds?: number;
  readonly now?: Date | string;
}

export interface MintApprovalTokenResult {
  readonly success: boolean;
  readonly rawToken?: string;
  readonly tokenHash?: string;
  readonly approvalId?: string;
  readonly requestId?: string;
  readonly action?: 'APPROVE' | 'VOID';
  readonly snapshotHash?: string;
  readonly expiresAt?: string;
  readonly channel?: 'web' | 'telegram';
  readonly error?: ApprovalTokenErrorCode;
  readonly message?: string;
}

export interface VerifyApprovalTokenParams {
  readonly rawToken: string;
  readonly expectedAction?: 'APPROVE' | 'VOID';
  readonly expectedRequestId?: string;
  readonly expectedSnapshotHash?: string;
  readonly now?: Date | string;
}

export interface VerifyApprovalTokenResult {
  readonly valid: boolean;
  readonly approval?: ApprovalRow;
  readonly request?: PaymentRequestRow;
  readonly error?: ApprovalTokenErrorCode;
  readonly message?: string;
}

export interface ConsumeApprovalTokenParams {
  readonly rawToken: string;
  readonly expectedAction?: 'APPROVE' | 'VOID';
  readonly expectedRequestId?: string;
  readonly expectedSnapshotHash?: string;
  readonly now?: Date | string;
}

export interface ConsumeApprovalTokenResult {
  readonly success: boolean;
  readonly approval?: ApprovalRow;
  readonly request?: PaymentRequestRow;
  readonly error?: ApprovalTokenErrorCode;
  readonly message?: string;
}

// ============================================================================
// Cryptographic Helpers & Token Generation
// ============================================================================

/**
 * Generates a 32-byte cryptographically random approval token encoded as base64url.
 * Returns exactly 43 URL-safe base64 characters with no padding.
 */
export function generateRawApprovalToken(): string {
  return crypto.randomBytes(APPROVAL_TOKEN_BYTES).toString('base64url');
}

/**
 * Computes the deterministic SHA-256 digest of a raw approval token.
 * Only this digest is stored or queried in the database.
 */
export function hashApprovalToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Validates whether a token conforms to the 32-byte base64url format.
 */
export function isValidTokenFormat(rawToken: unknown): rawToken is string {
  if (typeof rawToken !== 'string') {
    return false;
  }
  const trimmed = rawToken.trim();
  // 32 bytes in base64url has exactly 43 characters (no padding)
  return trimmed.length === 43 && /^[A-Za-z0-9_-]+$/.test(trimmed);
}

/**
 * Constant-time comparison between two strings.
 * Prevents timing attacks when comparing cryptographic digests.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ============================================================================
// Minting Approval Tokens
// ============================================================================

/**
 * Mints a new single-use approval token bound to a HELD payment request.
 *
 * Enforces:
 * 1. Request must exist and be in status 'HELD'.
 * 2. Request must possess a valid, tamper-free snapshot_hash.
 * 3. Token expiry is strictly clamped to never exceed payment hold expiry.
 * 4. Only the SHA-256 digest is persisted in SQLite; raw token is returned once.
 */
export function mintApprovalToken(
  db: Database,
  repos: Repositories,
  params: MintApprovalTokenParams
): MintApprovalTokenResult {
  // Validate action
  if (params.action !== 'APPROVE' && params.action !== 'VOID') {
    return {
      success: false,
      error: 'ACTION_MISMATCH',
      message: `Invalid approval action: '${params.action}' (must be APPROVE or VOID)`,
    };
  }

  const channel: 'web' | 'telegram' = params.channel ?? 'web';
  if (channel !== 'web' && channel !== 'telegram') {
    return {
      success: false,
      error: 'INVALID_TOKEN_FORMAT',
      message: `Invalid channel '${channel}' (must be web or telegram)`,
    };
  }

  const nowMs = params.now ? new Date(params.now).getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  return runInTransaction(db, () => {
    // 1. Fetch target payment request
    const request = repos.paymentRequests.getById(params.requestId);
    if (!request) {
      return {
        success: false,
        error: 'REQUEST_NOT_FOUND',
        message: `Payment request '${params.requestId}' not found`,
      };
    }

    // 2. Validate request status (must be HELD)
    if (request.status !== 'HELD') {
      return {
        success: false,
        error: 'INVALID_REQUEST_STATUS',
        message: `Cannot mint approval token for request in status '${request.status}' (must be HELD)`,
      };
    }

    // 3. Validate snapshot hash integrity
    if (!request.snapshot_hash) {
      return {
        success: false,
        error: 'SNAPSHOT_MISMATCH',
        message: 'Payment request is missing snapshot_hash',
      };
    }

    const computedSnapshot = computeSnapshotHash({
      requestId: request.id,
      agentId: request.agent_id,
      vendorId: request.vendor_id,
      amountMinor: request.amount_minor,
      currency: request.currency,
      purpose: request.purpose,
      category: request.category,
    });

    if (!constantTimeCompare(request.snapshot_hash, computedSnapshot)) {
      return {
        success: false,
        error: 'SNAPSHOT_MISMATCH',
        message: 'Payment request fields do not match persisted snapshot_hash (tamper detected)',
      };
    }

    // 4. Validate hold expiry & calculate token expiry (clamped to hold expiry)
    if (!request.expires_at) {
      return {
        success: false,
        error: 'HOLD_EXPIRED',
        message: 'Payment request is missing hold expiration timestamp',
      };
    }

    const holdExpiresMs = new Date(request.expires_at).getTime();
    if (holdExpiresMs <= nowMs) {
      return {
        success: false,
        error: 'HOLD_EXPIRED',
        message: 'Payment request hold has already expired',
      };
    }

    const requestedTtlMs = (params.ttlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS) * 1000;
    // Token expiry must NEVER exceed the associated payment hold's expiry (Hard Requirement 4)
    const tokenExpiresMs = Math.min(nowMs + requestedTtlMs, holdExpiresMs);
    const tokenExpiresAtIso = new Date(tokenExpiresMs).toISOString();

    // 5. Generate 32-byte raw token and SHA-256 hash
    const rawToken = generateRawApprovalToken();
    const tokenHash = hashApprovalToken(rawToken);
    const approvalId = `app-${crypto.randomUUID()}`;

    // 6. Persist approval row (storing only tokenHash)
    repos.approvals.insert({
      id: approvalId,
      request_id: request.id,
      token_hash: tokenHash,
      action: params.action,
      expires_at: tokenExpiresAtIso,
      used_at: null,
      channel,
      created_at: nowIso,
    });

    return {
      success: true,
      rawToken,
      tokenHash,
      approvalId,
      requestId: request.id,
      action: params.action,
      snapshotHash: request.snapshot_hash,
      expiresAt: tokenExpiresAtIso,
      channel,
    };
  });
}

// ============================================================================
// Verifying Approval Tokens
// ============================================================================

/**
 * Verifies the validity of an approval token without consuming it.
 *
 * Checks:
 * 1. Token format is a valid 32-byte base64url string.
 * 2. Token exists in the database.
 * 3. Token has not already been used.
 * 4. Token has not expired.
 * 5. Action matches expected action (if specified).
 * 6. Associated request exists, is in HELD status, and hold has not expired.
 * 7. Associated request ID matches expected request ID (if specified).
 * 8. Snapshot hash matches expected snapshot hash and passes integrity recomputation.
 */
export function verifyApprovalToken(
  _db: Database,
  repos: Repositories,
  params: VerifyApprovalTokenParams
): VerifyApprovalTokenResult {
  // 1. Validate token format
  if (!isValidTokenFormat(params.rawToken)) {
    return {
      valid: false,
      error: 'INVALID_TOKEN_FORMAT',
      message: 'Approval token is malformed or invalid format',
    };
  }

  const tokenHash = hashApprovalToken(params.rawToken.trim());
  const nowMs = params.now ? new Date(params.now).getTime() : Date.now();

  // 2. Fetch approval row by token hash
  const approval = repos.approvals.getByTokenHash(tokenHash);
  if (!approval) {
    return {
      valid: false,
      error: 'TOKEN_NOT_FOUND',
      message: 'Approval token not found',
    };
  }

  // Constant-time compare on token hash
  if (!constantTimeCompare(approval.token_hash, tokenHash)) {
    return {
      valid: false,
      error: 'TOKEN_NOT_FOUND',
      message: 'Approval token hash mismatch',
    };
  }

  // 3. Check single-use consumption
  if (approval.used_at !== null) {
    return {
      valid: false,
      error: 'TOKEN_ALREADY_USED',
      message: 'Approval token has already been consumed',
    };
  }

  // 4. Check token expiration
  const tokenExpiresMs = new Date(approval.expires_at).getTime();
  if (tokenExpiresMs <= nowMs) {
    return {
      valid: false,
      error: 'TOKEN_EXPIRED',
      message: 'Approval token has expired',
    };
  }

  // 5. Check action matching (if specified)
  if (params.expectedAction && approval.action !== params.expectedAction) {
    return {
      valid: false,
      error: 'ACTION_MISMATCH',
      message: `Token action '${approval.action}' does not match expected action '${params.expectedAction}'`,
    };
  }

  // 6. Fetch associated payment request
  const request = repos.paymentRequests.getById(approval.request_id);
  if (!request) {
    return {
      valid: false,
      error: 'REQUEST_NOT_FOUND',
      message: `Associated payment request '${approval.request_id}' not found`,
    };
  }

  // 7. Check request ID matching (if specified)
  if (params.expectedRequestId && approval.request_id !== params.expectedRequestId) {
    return {
      valid: false,
      error: 'REQUEST_MISMATCH',
      message: `Token request '${approval.request_id}' does not match expected request '${params.expectedRequestId}'`,
    };
  }

  // 8. Check request status (must still be HELD)
  if (request.status !== 'HELD') {
    return {
      valid: false,
      error: 'INVALID_REQUEST_STATUS',
      message: `Payment request is in status '${request.status}' (must be HELD)`,
    };
  }

  // 9. Check hold expiration
  if (request.expires_at && new Date(request.expires_at).getTime() <= nowMs) {
    return {
      valid: false,
      error: 'HOLD_EXPIRED',
      message: 'Associated payment hold has expired',
      approval,
      request,
    };
  }

  // 10. Check snapshot hash integrity
  if (!request.snapshot_hash) {
    return {
      valid: false,
      error: 'SNAPSHOT_MISMATCH',
      message: 'Payment request is missing snapshot_hash',
    };
  }

  // Check against expected snapshot hash (if specified)
  if (params.expectedSnapshotHash && !constantTimeCompare(request.snapshot_hash, params.expectedSnapshotHash)) {
    return {
      valid: false,
      error: 'SNAPSHOT_MISMATCH',
      message: 'Payment request snapshot_hash does not match expected snapshot hash',
    };
  }

  // Recompute snapshot hash to verify tamper-free integrity
  const computedSnapshot = computeSnapshotHash({
    requestId: request.id,
    agentId: request.agent_id,
    vendorId: request.vendor_id,
    amountMinor: request.amount_minor,
    currency: request.currency,
    purpose: request.purpose,
    category: request.category,
  });

  if (!constantTimeCompare(request.snapshot_hash, computedSnapshot)) {
    return {
      valid: false,
      error: 'SNAPSHOT_MISMATCH',
      message: 'Payment request fields do not match canonical snapshot_hash (tampering detected)',
    };
  }

  return {
    valid: true,
    approval,
    request,
  };
}

// ============================================================================
// Consuming Approval Tokens (Single-Use Atomic Transition)
// ============================================================================

/**
 * Atomically verifies and consumes an approval token in a single SQLite transaction.
 *
 * Enforces single-use consumption:
 * Concurrent attempts to consume the same token will fail with TOKEN_ALREADY_USED.
 */
export function consumeApprovalToken(
  db: Database,
  repos: Repositories,
  params: ConsumeApprovalTokenParams
): ConsumeApprovalTokenResult {
  const nowMs = params.now ? new Date(params.now).getTime() : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  return runInTransaction(db, () => {
    // 1. Verify token validity
    const verification = verifyApprovalToken(db, repos, params);
    if (!verification.valid || !verification.approval || !verification.request) {
      return {
        success: false,
        error: verification.error,
        message: verification.message,
        request: verification.request,
      };
    }

    const tokenHash = hashApprovalToken(params.rawToken.trim());

    // 2. Atomically mark token as used
    const consumed = repos.approvals.markUsed(tokenHash, nowIso);
    if (!consumed) {
      return {
        success: false,
        error: 'TOKEN_ALREADY_USED',
        message: 'Approval token has already been consumed (concurrent race prevented)',
      };
    }

    // 3. Return updated approval row
    const updatedApproval = repos.approvals.getByTokenHash(tokenHash)!;
    return {
      success: true,
      approval: updatedApproval,
      request: verification.request,
    };
  });
}
