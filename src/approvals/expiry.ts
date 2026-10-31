/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T4: Hold Expiry Worker (src/approvals/expiry.ts)
 *
 * Implements canonical hold expiry per PLAN.md Section 9 & 13:
 * - Discovers stale HELD payment requests where expires_at <= current time.
 * - Atomically inside BEGIN IMMEDIATE:
 *   - Verifies request is still in HELD state.
 *   - Transitions HELD -> EXPIRED -> VOIDED (Invariant I2).
 *   - Inserts exactly one RELEASE row in the ledger (Invariant I4).
 *   - Initializes remote_void_status ('PENDING' or 'FAILED').
 *   - Emits hash-chained audit rows with actor 'system' (Rule 7).
 * - Outside database transaction:
 *   - Voids remote PayPal authorization with idempotency key payguard-void-${requestId}.
 *   - Updates remote_void_status to 'CONFIRMED' on success or 'FAILED' on definitive error.
 *   - Leaves 'PENDING' on network/transient failures for M4-T3 ReconcilerWorker recovery.
 * - Periodic background worker running every 30 seconds by default.
 * - Unref timer so worker does not hang Node process termination.
 */

import * as crypto from 'node:crypto';
import type { Database } from '../db/connection.js';
import { runInTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import { createRepositories } from '../db/repositories.js';
import type { AuditLogRow } from '../db/types.js';
import {

  transitionPaymentRequest,
  writeAuditLogEntry,
} from '../core/stateMachine.js';
import type { PayPalAuthorizationsService } from '../paypal/authorizations.js';
import { AuthorizationError } from '../paypal/authorizations.js';

export interface ExpireHoldOptions {
  readonly repos?: Repositories;
  readonly authorizationsService?: PayPalAuthorizationsService;
  readonly now?: Date;
  readonly logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
  };
}

export interface ExpireHoldResult {
  readonly requestId: string;
  readonly expired: boolean;
  readonly actionTaken: 'EXPIRED' | 'NO_OP';
  readonly remoteVoidStatus?: 'PENDING' | 'CONFIRMED' | 'FAILED';
  readonly authorizationId?: string | null;
  readonly releasedMinor?: number;
  readonly reason?: string;
  readonly auditEntries?: readonly AuditLogRow[];
}

export interface ExpireStaleHoldsBatchResult {
  readonly totalDiscovered: number;
  readonly totalExpired: number;
  readonly totalNoOp: number;
  readonly results: readonly ExpireHoldResult[];
}

export interface HoldExpiryWorkerOptions {
  readonly db: Database;
  readonly repos?: Repositories;
  readonly authorizationsService?: PayPalAuthorizationsService;
  readonly intervalMs?: number; // default: 30_000 (30s canonical)
  readonly logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
  };
}

/**
 * Expire a single payment hold if still HELD and past expiration time.
 * Strictly atomic: database transitions and ledger release execute in BEGIN IMMEDIATE.
 * Remote cancellation executes outside the transaction.
 */
export async function expirePaymentHold(
  db: Database,
  requestId: string,
  options?: ExpireHoldOptions
): Promise<ExpireHoldResult> {
  const repos = options?.repos ?? createRepositories(db);
  const now = options?.now ?? new Date();
  const nowIso = now.toISOString();
  const nowTime = now.getTime();

  // Step 1: Atomic SQLite Transaction (BEGIN IMMEDIATE)
  const claimResult = runInTransaction(db, () => {
    const request = repos.paymentRequests.getById(requestId);
    if (!request) {
      return {
        success: false,
        actionTaken: 'NO_OP' as const,
        reason: `Payment request '${requestId}' not found`,
      };
    }

    if (request.status !== 'HELD') {
      return {
        success: false,
        actionTaken: 'NO_OP' as const,
        reason: `Payment request is not in HELD status (current: ${request.status})`,
      };
    }

    const expiresAtMs = request.expires_at ? new Date(request.expires_at).getTime() : 0;
    if (expiresAtMs <= 0 || expiresAtMs > nowTime) {
      return {
        success: false,
        actionTaken: 'NO_OP' as const,
        reason: `Payment request hold has not expired (expiresAt: ${request.expires_at}, now: ${nowIso})`,
      };
    }

    // Invariant I4: Verify ledger state before release
    const ledgerEntries = repos.ledger.listByRequestId(requestId);
    const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');
    if (hasSpend) {
      throw new Error(`Illegal ledger state: cannot expire hold for request '${requestId}' with existing SPEND entry`);
    }

    const hasRelease = ledgerEntries.some((l) => l.kind === 'RELEASE');
    if (!hasRelease) {
      repos.ledger.insert({
        id: `led-${crypto.randomUUID()}`,
        request_id: requestId,
        kind: 'RELEASE',
        amount_minor: request.amount_minor,
        currency: request.currency,
        created_at: nowIso,
      });
    }

    // Determine initial remote void status
    const authId = request.paypal_authorization_id?.trim();
    const initialVoidStatus: 'PENDING' | 'FAILED' = authId ? 'PENDING' : 'FAILED';

    // Transition 1: HELD -> EXPIRED (actor: 'system')
    const { auditEntry: expiredAudit } = transitionPaymentRequest(db, repos, {
      requestId,
      to: 'EXPIRED',
      actor: 'system',
      event: 'HOLD_EXPIRED',
      reason: 'Payment hold authorization expired before owner approval',
      timestamp: nowIso,
    });

    // Transition 2: EXPIRED -> VOIDED (actor: 'system')
    const { request: updatedRequest, auditEntry: voidedAudit } = transitionPaymentRequest(db, repos, {
      requestId,
      to: 'VOIDED',
      actor: 'system',
      event: 'TRANSITION_TO_VOIDED',
      reason: 'Expired hold voided and budget released',
      timestamp: nowIso,
      payload: {
        remote_void_status: initialVoidStatus,
      },
    });

    repos.paymentRequests.updateRemoteVoidStatus(requestId, initialVoidStatus, nowIso);

    // If missing authorization ID, record the unresolved condition once
    if (!authId) {
      const existingLogs = repos.auditLog.listByRequestId(requestId);
      const alreadyLogged = existingLogs.some((l) => l.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID');
      if (!alreadyLogged) {
        writeAuditLogEntry(db, repos, {
          actor: 'system',
          event: 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'Cannot cancel remote authorization: request is missing paypal_authorization_id',
            remote_void_status: 'FAILED',
          },
        });
      }
    }

    return {
      success: true,
      actionTaken: 'EXPIRED' as const,
      request: updatedRequest,
      authId,
      initialVoidStatus,
      auditEntries: [expiredAudit, voidedAudit],
    };
  });

  if (!claimResult.success || !claimResult.request) {
    return {
      requestId,
      expired: false,
      actionTaken: 'NO_OP',
      reason: claimResult.reason,
    };
  }

  // Step 2: Remote PayPal Authorization Cancellation (outside SQLite transaction)
  const authId = claimResult.authId;
  let finalVoidStatus: 'PENDING' | 'CONFIRMED' | 'FAILED' = claimResult.initialVoidStatus;

  if (authId && options?.authorizationsService) {
    try {
      const voidRes = await options.authorizationsService.voidAuthorization({
        authorizationId: authId,
        requestId,
      });

      if (voidRes.isVoided) {
        finalVoidStatus = 'CONFIRMED';
        repos.paymentRequests.updateRemoteVoidStatus(requestId, 'CONFIRMED', nowIso);
        const auditEntry = writeAuditLogEntry(db, repos, {
          actor: 'system',
          event: 'PAYPAL_VOID_RECONCILED',
          requestId,
          timestamp: nowIso,
          payload: {
            authorizationId: authId,
            reason: 'Remote authorization void confirmed for expired hold',
            remote_void_status: 'CONFIRMED',
          },
        });
        claimResult.auditEntries.push(auditEntry);
      }
    } catch (err: unknown) {
      const isDefinitive =
        err instanceof AuthorizationError &&
        (err.code === 'INVALID_REQUEST' || err.code === 'DECLINED');

      if (isDefinitive) {
        finalVoidStatus = 'FAILED';
        repos.paymentRequests.updateRemoteVoidStatus(requestId, 'FAILED', nowIso);
        const auditEntry = writeAuditLogEntry(db, repos, {
          actor: 'system',
          event: 'PAYPAL_VOID_FAILED',
          requestId,
          timestamp: nowIso,
          payload: {
            authorizationId: authId,
            error: err instanceof Error ? err.message : String(err),
            remote_void_status: 'FAILED',
          },
        });
        claimResult.auditEntries.push(auditEntry);
      } else {
        // Transient error or network failure:
        // Leave remote_void_status as 'PENDING'. ReconcilerWorker will recover it.
        options?.logger?.warn?.(
          `[HoldExpiry] Remote void call failed transiently for request '${requestId}', left as PENDING for reconciliation:`,
          err
        );
      }
    }
  }

  return {
    requestId,
    expired: true,
    actionTaken: 'EXPIRED',
    remoteVoidStatus: finalVoidStatus,
    authorizationId: authId ?? null,
    releasedMinor: claimResult.request.amount_minor,
    reason: 'Payment hold expired and voided successfully',
    auditEntries: claimResult.auditEntries,
  };
}

/**
 * Discovers and expires all stale HELD requests where expires_at <= current time.
 */
export async function expireStaleHolds(
  db: Database,
  options?: ExpireHoldOptions
): Promise<ExpireStaleHoldsBatchResult> {
  const repos = options?.repos ?? createRepositories(db);
  const now = options?.now ?? new Date();
  const candidates = repos.paymentRequests.listExpiredHeld(now.toISOString());

  const results: ExpireHoldResult[] = [];
  let totalExpired = 0;
  let totalNoOp = 0;

  for (const candidate of candidates) {
    try {
      const result = await expirePaymentHold(db, candidate.id, options);
      results.push(result);
      if (result.expired) {
        totalExpired++;
      } else {
        totalNoOp++;
      }
    } catch (err: unknown) {
      options?.logger?.error?.(`[HoldExpiry] Error expiring hold for request '${candidate.id}':`, err);
      totalNoOp++;
      results.push({
        requestId: candidate.id,
        expired: false,
        actionTaken: 'NO_OP',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    totalDiscovered: candidates.length,
    totalExpired,
    totalNoOp,
    results,
  };
}

/**
 * Periodic background worker running every 30 seconds by default.
 */
export class HoldExpiryWorker {
  private readonly db: Database;
  private readonly options: HoldExpiryWorkerOptions;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private isTickInProgress = false;

  constructor(options: HoldExpiryWorkerOptions) {
    this.db = options.db;
    this.options = options;
    // Canonical 30-second default per PLAN.md Section 9 Flow D and Section 13
    this.intervalMs = options.intervalMs ?? 30_000;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Unref timer so it does not block Node process termination in CLI/tools
    if (typeof this.timer?.unref === 'function') {
      this.timer.unref();
    }

    this.options.logger?.info?.(`[HoldExpiryWorker] Started background job with interval ${this.intervalMs}ms`);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.options.logger?.info?.('[HoldExpiryWorker] Stopped background job');
  }

  public async tick(): Promise<ExpireStaleHoldsBatchResult> {
    if (this.isTickInProgress) {
      return { totalDiscovered: 0, totalExpired: 0, totalNoOp: 0, results: [] };
    }

    this.isTickInProgress = true;
    try {
      return await expireStaleHolds(this.db, {
        repos: this.options.repos,
        authorizationsService: this.options.authorizationsService,
        logger: this.options.logger,
      });
    } catch (err: unknown) {
      this.options.logger?.error?.('[HoldExpiryWorker] Error in expiry tick:', err);
      return { totalDiscovered: 0, totalExpired: 0, totalNoOp: 0, results: [] };
    } finally {
      this.isTickInProgress = false;
    }
  }
}
