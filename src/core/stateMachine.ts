/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T7: State Machine and Audit Hash Chain
 *
 * Implements:
 * 1. Deterministic payment request state transitions per PLAN.md Section 9:
 *    - RECEIVED -> DENIED (terminal)
 *    - RECEIVED -> AUTO_EXECUTING -> CAPTURED | FAILED
 *    - RECEIVED -> HELD -> APPROVED -> CAPTURING -> CAPTURED | FAILED
 *    - HELD -> VOIDED (owner rejects)
 *    - HELD -> EXPIRED -> VOIDED (timeout; default deny)
 *    - Flow F: pre-execution or capture failures transition to FAILED
 * 2. Rejection of illegal state transitions (Invariant I2).
 * 3. Append-only SHA-256 audit log hash-chain construction.
 * 4. Atomic execution of state transition and audit log insert in the same transaction (Rule 7).
 * 5. Chain verification and tampering detection.
 */

import * as crypto from 'node:crypto';
import type { Database } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import type { AuditLogRow, PaymentRequestRow } from '../db/types.js';

/**
 * Canonical payment request statuses per PLAN.md Section 9.
 */
export type PaymentRequestStatus =
  | 'RECEIVED'
  | 'AUTO_EXECUTING'
  | 'HELD'
  | 'APPROVED'
  | 'CAPTURING'
  | 'EXPIRED'
  | 'DENIED'
  | 'VOIDED'
  | 'CAPTURED'
  | 'FAILED';

/**
 * Terminal states per Invariant I2:
 * Every payment request ends in exactly one terminal state.
 * Terminal states have no valid outgoing transitions.
 */
export type TerminalStatus = 'DENIED' | 'VOIDED' | 'CAPTURED' | 'FAILED';

export const TERMINAL_STATUSES: ReadonlySet<PaymentRequestStatus> = new Set<PaymentRequestStatus>([
  'DENIED',
  'VOIDED',
  'CAPTURED',
  'FAILED',
]);

/**
 * Canonical state transition map per PLAN.md Section 9 & Flow F.
 */
export const VALID_TRANSITIONS: Readonly<Record<PaymentRequestStatus, readonly PaymentRequestStatus[]>> = {
  RECEIVED: ['DENIED', 'AUTO_EXECUTING', 'HELD', 'FAILED'],
  AUTO_EXECUTING: ['CAPTURED', 'FAILED'],
  HELD: ['APPROVED', 'EXPIRED', 'VOIDED', 'FAILED'],
  APPROVED: ['CAPTURING', 'FAILED'],
  CAPTURING: ['CAPTURED', 'FAILED'],
  EXPIRED: ['VOIDED'],
  DENIED: [],
  VOIDED: [],
  CAPTURED: [],
  FAILED: [],
};

/**
 * Canonical actor types per PLAN.md Section 8 (audit_log table).
 */
export type AuditActor = 'agent' | 'owner' | 'system' | 'ai';

/**
 * Error thrown when an illegal or unsupported state transition is attempted.
 */
export class IllegalStateTransitionError extends Error {
  public readonly from: string;
  public readonly to: string;
  public readonly requestId?: string;

  constructor(from: string, to: string, requestId?: string) {
    const msg = requestId
      ? `Illegal state transition for request '${requestId}': cannot transition from '${from}' to '${to}'`
      : `Illegal state transition: cannot transition from '${from}' to '${to}'`;
    super(msg);
    this.name = 'IllegalStateTransitionError';
    this.from = from;
    this.to = to;
    this.requestId = requestId;
  }
}

/**
 * Checks whether a given status is terminal.
 */
export function isTerminalStatus(status: PaymentRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Checks whether a transition between two statuses is valid.
 */
export function isValidTransition(from: PaymentRequestStatus, to: PaymentRequestStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Asserts that a state transition is valid, throwing IllegalStateTransitionError if not.
 */
export function assertValidTransition(
  from: PaymentRequestStatus,
  to: PaymentRequestStatus,
  requestId?: string
): void {
  if (!isValidTransition(from, to)) {
    throw new IllegalStateTransitionError(from, to, requestId);
  }
}

/**
 * Recursively sorts object keys for deterministic canonical JSON serialization.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = sortKeys(obj[key]);
  }
  return result;
}

/**
 * Serializes an audit payload deterministically.
 */
export function serializeAuditPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      return JSON.stringify(sortKeys(parsed));
    } catch {
      return JSON.stringify({ message: payload });
    }
  }
  return JSON.stringify(sortKeys(payload ?? {}));
}

export interface AuditHashInput {
  readonly id: string;
  readonly ts: string;
  readonly actor: AuditActor;
  readonly event: string;
  readonly request_id: string | null;
  readonly payload: string;
  readonly prev_hash: string | null;
}

/**
 * Computes the canonical SHA-256 hash for an audit log entry.
 * Uses a strictly deterministic canonical JSON representation of all fields.
 */
export function computeAuditHash(entry: AuditHashInput): string {
  const canonicalString = JSON.stringify({
    actor: entry.actor,
    event: entry.event,
    id: entry.id,
    payload: entry.payload,
    prev_hash: entry.prev_hash,
    request_id: entry.request_id,
    ts: entry.ts,
  });

  return crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

export interface ChainVerificationResult {
  readonly valid: boolean;
  readonly totalEntries: number;
  readonly brokenIndex?: number;
  readonly error?: string;
}

/**
 * Verifies the integrity of an audit log hash chain.
 * Validates:
 * 1. Genesis entry has prev_hash === null.
 * 2. Every entry's hash matches computeAuditHash(entry).
 * 3. Every subsequent entry's prev_hash matches the previous entry's hash.
 */
export function verifyAuditChain(entries: readonly AuditLogRow[]): ChainVerificationResult {
  if (entries.length === 0) {
    return { valid: true, totalEntries: 0 };
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;

    // 1. Check prev_hash link
    if (i === 0) {
      if (entry.prev_hash !== null) {
        return {
          valid: false,
          totalEntries: entries.length,
          brokenIndex: 0,
          error: `Genesis entry '${entry.id}' must have prev_hash null, got '${entry.prev_hash}'`,
        };
      }
    } else {
      const prevEntry = entries[i - 1]!;
      if (entry.prev_hash !== prevEntry.hash) {
        return {
          valid: false,
          totalEntries: entries.length,
          brokenIndex: i,
          error: `Chain broken at entry index ${i} ('${entry.id}'): prev_hash '${entry.prev_hash}' does not match previous hash '${prevEntry.hash}'`,
        };
      }
    }

    // 2. Check hash validity
    const expectedHash = computeAuditHash({
      id: entry.id,
      ts: entry.ts,
      actor: entry.actor,
      event: entry.event,
      request_id: entry.request_id,
      payload: entry.payload,
      prev_hash: entry.prev_hash,
    });

    if (entry.hash !== expectedHash) {
      return {
        valid: false,
        totalEntries: entries.length,
        brokenIndex: i,
        error: `Hash mismatch at entry index ${i} ('${entry.id}'): recorded '${entry.hash}', expected '${expectedHash}'`,
      };
    }
  }

  return { valid: true, totalEntries: entries.length };
}

/**
 * Verifies the integrity of the entire audit log stored in SQLite.
 */
export function verifyDatabaseAuditChain(db: Database): ChainVerificationResult {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY rowid ASC').all() as AuditLogRow[];
  return verifyAuditChain(rows);
}

export interface TransitionParams {
  readonly requestId: string;
  readonly to: PaymentRequestStatus;
  readonly actor: AuditActor;
  readonly event?: string;
  readonly reason?: string;
  readonly payload?: Record<string, unknown>;
  readonly decision?: 'ALLOW' | 'HOLD' | 'DENY';
  readonly reasons?: readonly string[];
  readonly snapshotHash?: string | null;
  readonly expiresAt?: string | null;
  readonly paypalOrderId?: string | null;
  readonly paypalAuthorizationId?: string | null;
  readonly paypalCaptureId?: string | null;
  readonly timestamp?: string;
}

export interface WriteAuditParams {
  readonly actor: AuditActor;
  readonly event: string;
  readonly requestId?: string | null;
  readonly payload: unknown;
  readonly timestamp?: string;
}

/**
 * Appends a standalone hash-chained audit log entry.
 * Can be called within an existing transaction or standalone.
 */
export function writeAuditLogEntry(
  db: Database,
  repos: Repositories,
  params: WriteAuditParams
): AuditLogRow {
  const execute = (): AuditLogRow => {
    const lastEntry = repos.auditLog.getLastEntry();
    const prevHash = lastEntry ? lastEntry.hash : null;
    const id = `aud-${crypto.randomUUID()}`;
    const ts = params.timestamp || new Date().toISOString();
    const payloadStr = serializeAuditPayload(params.payload);

    const hash = computeAuditHash({
      id,
      ts,
      actor: params.actor,
      event: params.event,
      request_id: params.requestId ?? null,
      payload: payloadStr,
      prev_hash: prevHash,
    });

    const entry: AuditLogRow = {
      id,
      ts,
      actor: params.actor,
      event: params.event,
      request_id: params.requestId ?? null,
      payload: payloadStr,
      prev_hash: prevHash,
      hash,
    };

    repos.auditLog.insert(entry);
    return entry;
  };

  if (db.inTransaction) {
    return execute();
  }

  const tx = db.transaction(execute);
  return tx.immediate();
}

/**
 * Atomically transitions a payment request to a new status and appends
 * an audit log row within the SAME transaction (Hard Rule 7 & Invariant I2).
 *
 * If the transition is illegal or any database write fails, the entire
 * transaction rolls back and no state changes persist.
 */
export function transitionPaymentRequest(
  db: Database,
  repos: Repositories,
  params: TransitionParams
): { request: PaymentRequestRow; auditEntry: AuditLogRow } {
  const execute = (): { request: PaymentRequestRow; auditEntry: AuditLogRow } => {
    const request = repos.paymentRequests.getById(params.requestId);
    if (!request) {
      throw new Error(`Payment request not found: ${params.requestId}`);
    }

    const currentStatus = request.status as PaymentRequestStatus;
    assertValidTransition(currentStatus, params.to, params.requestId);

    const now = params.timestamp || new Date().toISOString();

    // 1. Update payment request status and associated fields
    repos.paymentRequests.updateStatusAndDecision(params.requestId, {
      status: params.to,
      decision: params.decision,
      reasons: params.reasons ? JSON.stringify(params.reasons) : undefined,
      snapshotHash: params.snapshotHash,
      expiresAt: params.expiresAt,
      updatedAt: now,
    });

    if (params.paypalOrderId || params.paypalAuthorizationId || params.paypalCaptureId) {
      repos.paymentRequests.updatePayPalIds(params.requestId, {
        orderId: params.paypalOrderId,
        authorizationId: params.paypalAuthorizationId,
        captureId: params.paypalCaptureId,
        updatedAt: now,
      });
    }

    // 2. Fetch updated request
    const updatedRequest = repos.paymentRequests.getById(params.requestId);
    if (!updatedRequest) {
      throw new Error(`Failed to retrieve updated payment request: ${params.requestId}`);
    }

    // 3. Construct and append audit entry to the hash chain
    const lastEntry = repos.auditLog.getLastEntry();
    const prevHash = lastEntry ? lastEntry.hash : null;
    const auditId = `aud-${crypto.randomUUID()}`;

    const auditPayload = serializeAuditPayload({
      from_status: currentStatus,
      to_status: params.to,
      reason: params.reason,
      decision: params.decision ?? request.decision,
      ...(params.payload || {}),
    });

    const event = params.event || `TRANSITION_TO_${params.to}`;

    const hash = computeAuditHash({
      id: auditId,
      ts: now,
      actor: params.actor,
      event,
      request_id: params.requestId,
      payload: auditPayload,
      prev_hash: prevHash,
    });

    const auditEntry: AuditLogRow = {
      id: auditId,
      ts: now,
      actor: params.actor,
      event,
      request_id: params.requestId,
      payload: auditPayload,
      prev_hash: prevHash,
      hash,
    };

    repos.auditLog.insert(auditEntry);

    return { request: updatedRequest, auditEntry };
  };

  if (db.inTransaction) {
    return execute();
  }

  const tx = db.transaction(execute);
  return tx.immediate();
}
