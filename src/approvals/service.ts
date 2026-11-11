/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3-D Subtask 2: Shared Approval Execution Service (src/approvals/service.ts)
 *
 * Implements:
 * - Single authoritative application-level execution path for payment approvals and voids.
 * - Shared across Web Dashboard (/a/:token) and Telegram inline callbacks (pg:app, pg:void).
 * - Phase 1 (Atomic SQLite Transaction):
 *     1. Validates token format, hash lookup, expiry, snapshot hash, and caller identity.
 *     2. Enforces single-use CAS consumption on the relevant token.
 *     3. Performs cross-channel and sibling token invalidation for the request.
 *     4. Revalidates payment request state and snapshot binding.
 *     5. Applies state transition via stateMachine (HELD -> APPROVED or HELD -> VOIDED).
 *     6. Inserts budget RELEASE ledger entry (for VOID).
 *     7. Writes audit log entry in the same transaction.
 *     8. Enqueues PAYMENT_VOIDED notification (for VOID).
 * - Phase 2 (Remote Network Execution, Outside SQLite Transaction):
 *     - APPROVE: Delegates capture to src/core/executeDecision.ts (the sole money-moving path).
 *     - VOID: Calls authorizationsService.voidAuthorization() (the authorized void path).
 *
 * Security & Invariants:
 * - Hard Rule 1: Sandbox only. Production refused.
 * - Hard Rule 2: Never persist, log, or leak raw tokens or credentials.
 * - Hard Rule 4: Only executeDecision in src/core may call money-moving PayPal functions.
 * - Hard Rule 7: Every state transition writes an audit_log row in the same transaction.
 * - Hard Rule 8: Fail closed on any error, ambiguity, or snapshot mismatch.
 */

import * as crypto from 'node:crypto';
import type { Database } from '../db/connection.js';
import { runInTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import type { PaymentRequestRow, RemoteVoidStatus } from '../db/types.js';
import {
  transitionPaymentRequest,
  writeAuditLogEntry,
  writeAuditLogEntryIfChanged,
} from '../core/stateMachine.js';
import { computeSnapshotHash } from '../core/service.js';
import {
  executeDecision,
  AmbiguousExecutionError,
  ExecuteDecisionError,
} from '../core/executeDecision.js';
import {
  verifyApprovalToken,
  hashApprovalToken,
} from './tokens.js';
import { expirePaymentHold, type ExpireHoldResult } from './expiry.js';
import type { PayPalAuthorizationsService } from '../paypal/authorizations.js';
import { AuthorizationError } from '../paypal/authorizations.js';
import type { PayPalOrdersService } from '../paypal/orders.js';
import { sanitizePublicBaseUrl } from '../config/index.js';
import { recoverVoidNotification } from '../telegram/notifications.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type ApprovalAction = 'APPROVE' | 'VOID';
export type ApprovalChannel = 'web' | 'telegram' | 'dashboard';

export interface WebApprovalCredentials {
  readonly channel: 'web';
  readonly rawToken: string;
  readonly ownerId?: string;
  readonly ownerDisplayName?: string;
}

export interface TelegramApprovalCredentials {
  readonly channel: 'telegram';
  readonly rawCallbackToken: string;
  readonly telegramUserId: string; // Immutable numeric Telegram user ID
  readonly telegramChatId: string; // Numeric Telegram chat ID
}

export interface DashboardApprovalCredentials {
  readonly channel: 'dashboard';
  readonly requestId: string;
  readonly ownerId?: string;
  readonly ownerDisplayName?: string;
  readonly reason?: string;
}

export type ApprovalCredentials =
  | WebApprovalCredentials
  | TelegramApprovalCredentials
  | DashboardApprovalCredentials;

export interface ExecuteApprovalRequest {
  readonly action: ApprovalAction;
  readonly credentials: ApprovalCredentials;
  readonly onClaimed?: (request: PaymentRequestRow) => Promise<void> | void;
}

export type ApprovalExecutionOutcome =
  | {
      readonly success: true;
      readonly action: 'APPROVE';
      readonly requestId: string;
      readonly status: 'CAPTURED';
      readonly captureId?: string | null;
      readonly executedAction: 'CAPTURED_APPROVED';
    }
  | {
      readonly success: false;
      readonly action: 'APPROVE';
      readonly requestId: string;
      readonly status: 'CAPTURING';
      readonly error: 'AMBIGUOUS_EXECUTION';
      readonly reconciliationRequired: true;
      readonly message: string;
    }
  | {
      readonly success: false;
      readonly action: 'APPROVE';
      readonly requestId: string;
      readonly status: 'FAILED';
      readonly error: string;
      readonly message: string;
    }
  | {
      readonly success: true;
      readonly action: 'VOID';
      readonly requestId: string;
      readonly status: 'VOIDED';
      readonly remoteVoidStatus: RemoteVoidStatus;
      readonly remoteVoidSuccess: boolean;
      readonly alreadyVoided?: boolean;
      readonly reconciliationRequired?: boolean;
      readonly message?: string;
    };

export class ApprovalValidationError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly requestId?: string;

  constructor(code: string, message: string, statusCode = 400, requestId?: string) {
    super(message);
    this.name = 'ApprovalValidationError';
    this.code = code;
    this.statusCode = statusCode;
    this.requestId = requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ApprovalExecutionServiceOptions {
  readonly db: Database;
  readonly repos: Repositories;
  readonly authorizationsService?: PayPalAuthorizationsService;
  readonly ordersService?: PayPalOrdersService;
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
  readonly logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
  };
}

// ============================================================================
// Service Class
// ============================================================================

export class ApprovalExecutionService {
  private readonly db: Database;
  private readonly repos: Repositories;
  private readonly authorizationsService?: PayPalAuthorizationsService;
  private readonly ordersService?: PayPalOrdersService;
  private readonly hasExplicitPublicBaseUrl: boolean;
  private readonly publicBaseUrl?: string;
  private readonly hasExplicitIsProduction: boolean;
  private readonly isProduction?: boolean;
  private readonly logger?: ApprovalExecutionServiceOptions['logger'];
  private shuttingDown = false;
  private readonly pendingExpiries = new Map<string, Promise<ExpireHoldResult>>();
  private readonly pendingExecutions = new Set<Promise<ApprovalExecutionOutcome>>();

  constructor(options: ApprovalExecutionServiceOptions) {
    this.db = options.db;
    this.repos = options.repos;
    this.authorizationsService = options.authorizationsService;
    this.ordersService = options.ordersService;
    this.hasExplicitPublicBaseUrl = 'publicBaseUrl' in options;
    this.publicBaseUrl = options.publicBaseUrl;
    this.hasExplicitIsProduction = 'isProduction' in options;
    this.isProduction = options.isProduction;
    this.logger = options.logger;
  }

  private getNotificationUrlOptions(): { publicBaseUrl?: string; isProduction: boolean } {
    const isProd = this.hasExplicitIsProduction
      ? Boolean(this.isProduction)
      : process.env.NODE_ENV === 'production';
    const publicBaseUrl = this.hasExplicitPublicBaseUrl
      ? sanitizePublicBaseUrl(this.publicBaseUrl, isProd)
      : isProd
        ? undefined
        : sanitizePublicBaseUrl(process.env.PUBLIC_BASE_URL, isProd);
    return { publicBaseUrl, isProduction: isProd };
  }

  public markShuttingDown(): void {
    this.shuttingDown = true;
  }

  public async drainPendingTasks(): Promise<void> {
    this.shuttingDown = true;
    while (this.pendingExecutions.size > 0 || this.pendingExpiries.size > 0) {
      const batch: Promise<unknown>[] = [
        ...Array.from(this.pendingExecutions),
        ...Array.from(this.pendingExpiries.values()),
      ];
      await Promise.allSettled(batch);
    }
  }

  public expireHoldTracked(requestId: string): Promise<ExpireHoldResult> {
    if (!this.db.open) {
      return Promise.resolve({
        requestId,
        expired: false,
        actionTaken: 'NO_OP',
        reason: 'Database is closed',
      });
    }

    const existing = this.pendingExpiries.get(requestId);
    if (existing) {
      return existing;
    }

    const urlOptions = this.getNotificationUrlOptions();
    const expiryPromise = expirePaymentHold(this.db, requestId, {
      repos: this.repos,
      authorizationsService: this.authorizationsService,
      ...urlOptions,
      logger: this.logger,
    }).finally(() => {
      if (this.pendingExpiries.get(requestId) === expiryPromise) {
        this.pendingExpiries.delete(requestId);
      }
    });

    this.pendingExpiries.set(requestId, expiryPromise);
    return expiryPromise;
  }

  /**
   * Authoritative entry point for executing an owner payment decision (APPROVE or VOID)
   * originating from Web Approval Links, Owner Dashboard, or Telegram inline callbacks.
   */
  public execute(params: ExecuteApprovalRequest): Promise<ApprovalExecutionOutcome> {
    const executionPromise = this.doExecute(params).finally(() => {
      this.pendingExecutions.delete(executionPromise);
    });
    this.pendingExecutions.add(executionPromise);
    return executionPromise;
  }

  private async doExecute(params: ExecuteApprovalRequest): Promise<ApprovalExecutionOutcome> {
    const { action, credentials } = params;
    const nowIso = new Date().toISOString();

    // ========================================================================
    // Phase 1: Atomic SQLite Claim & State Transition Transaction
    // ========================================================================
    let committedRequest: PaymentRequestRow;
    let committedChannel: ApprovalChannel;
    let alreadyVoided = false;
    let voidReason = 'Owner rejected and voided payment hold';

    try {
      const claimResult = runInTransaction(this.db, () => {
        if (credentials.channel === 'web') {
          return this.validateAndClaimWebApproval(credentials, action, nowIso);
        } else if (credentials.channel === 'telegram') {
          return this.validateAndClaimTelegramApproval(credentials, action, nowIso);
        } else {
          return this.validateAndClaimDashboardApproval(credentials, action, nowIso);
        }
      });

      committedRequest = claimResult.request;
      committedChannel = credentials.channel;
      alreadyVoided = Boolean(claimResult.alreadyVoided);
      if (claimResult.voidReason) {
        voidReason = claimResult.voidReason;
      }
    } catch (err: unknown) {
      if (err instanceof ApprovalValidationError) {
        if (err.code === 'HOLD_EXPIRED' && err.requestId) {
          this.triggerLazyHoldExpiry(err.requestId);
        }
      }
      throw err;
    }

    if (alreadyVoided) {
      return {
        success: true,
        action: 'VOID',
        requestId: committedRequest.id,
        status: 'VOIDED',
        remoteVoidStatus: (committedRequest.remote_void_status as RemoteVoidStatus) ?? 'CONFIRMED',
        remoteVoidSuccess:
          committedRequest.remote_void_status === 'CONFIRMED' ||
          committedRequest.remote_void_status === null,
        alreadyVoided: true,
        message: 'Payment request was already voided',
      };
    }

    // ========================================================================
    // Post-Claim Hook (Optional, Non-Blocking to Phase 1 Commit)
    // ========================================================================
    if (params.onClaimed) {
      try {
        await params.onClaimed(committedRequest);
      } catch (claimHookErr: unknown) {
        this.logger?.warn?.(
          `[ApprovalExecutionService] onClaimed hook error: ${
            claimHookErr instanceof Error ? claimHookErr.message : String(claimHookErr)
          }`
        );
      }
    }

    // ========================================================================
    // Phase 2: Remote Network Execution (Outside Database Transaction)
    // ========================================================================

    if (action === 'APPROVE') {
      return await this.executeRemoteCapture(committedRequest.id);
    } else {
      return await this.executeRemoteVoid(committedRequest, committedChannel, voidReason);
    }
  }

  // ==========================================================================
  // Phase 1 Helper: Web Approval Validation & CAS Claim
  // ==========================================================================

  private validateAndClaimWebApproval(
    credentials: WebApprovalCredentials,
    action: ApprovalAction,
    nowIso: string
  ): { request: PaymentRequestRow; alreadyVoided?: boolean; voidReason?: string } {
    const { rawToken } = credentials;
    if (!rawToken || typeof rawToken !== 'string') {
      throw new ApprovalValidationError('INVALID_TOKEN_FORMAT', 'Raw approval token is required', 400);
    }

    // 1. Verify token bound to the requested action
    const verification = verifyApprovalToken(this.db, this.repos, {
      rawToken,
      expectedAction: action,
    });

    if (!verification.valid || !verification.approval || !verification.request) {
      const statusCode =
        verification.error === 'TOKEN_ALREADY_USED'
          ? 409
          : verification.error === 'TOKEN_EXPIRED' || verification.error === 'HOLD_EXPIRED'
          ? 410
          : verification.error === 'TOKEN_NOT_FOUND' || verification.error === 'INVALID_TOKEN_FORMAT'
          ? 404
          : 400;

      throw new ApprovalValidationError(
        verification.error ?? 'VERIFICATION_FAILED',
        verification.message ?? 'Token verification failed',
        statusCode,
        verification.request?.id
      );
    }

    const { approval, request } = verification;
    const tokenHash = hashApprovalToken(rawToken.trim());

    // 2. Atomic CAS mark token used
    const marked = this.repos.approvals.markUsed(tokenHash, nowIso);
    if (!marked) {
      throw new ApprovalValidationError(
        'TOKEN_ALREADY_USED',
        'Approval token has already been consumed (concurrent race prevented)',
        409,
        request.id
      );
    }

    // 3. Sibling and cross-channel invalidation: invalidate all remaining approval tokens for this request
    this.repos.invalidateAllApprovalsForRequest(request.id, nowIso);

    // 4. State transition and ledger mutations
    if (action === 'APPROVE') {
      const { request: updatedRequest } = transitionPaymentRequest(this.db, this.repos, {
        requestId: request.id,
        to: 'APPROVED',
        actor: 'owner',
        event: 'OWNER_APPROVED',
        timestamp: nowIso,
        payload: {
          approval_id: approval.id,
          channel: 'web',
          owner_id: credentials.ownerId ?? 'default',
          owner_display_name: credentials.ownerDisplayName ?? 'Owner',
        },
      });

      return { request: updatedRequest };
    } else {
      const ledgerEntries = this.repos.ledger.listByRequestId(request.id);
      if (ledgerEntries.some((l) => l.kind === 'SPEND')) {
        throw new Error(`Illegal ledger state: cannot void request '${request.id}' with existing SPEND entry`);
      }
      if (!ledgerEntries.some((l) => l.kind === 'RELEASE')) {
        const ledgerId = `led-${crypto.randomUUID()}`;
        this.repos.ledger.insert({
          id: ledgerId,
          request_id: request.id,
          kind: 'RELEASE',
          amount_minor: request.amount_minor,
          currency: request.currency,
          created_at: nowIso,
        });
      }

      const authId = request.paypal_authorization_id?.trim();
      const initialVoidStatus: RemoteVoidStatus = authId ? 'PENDING' : 'FAILED';
      const reason = 'Owner rejected and voided payment hold';

      const { request: updatedRequest } = transitionPaymentRequest(this.db, this.repos, {
        requestId: request.id,
        to: 'VOIDED',
        actor: 'owner',
        event: 'TRANSITION_TO_VOIDED',
        timestamp: nowIso,
        payload: {
          approval_id: approval.id,
          channel: 'web',
          owner_id: credentials.ownerId ?? 'default',
          owner_display_name: credentials.ownerDisplayName ?? 'Owner',
          reason,
          remote_void_status: initialVoidStatus,
        },
      });

      this.repos.paymentRequests.updateRemoteVoidStatus(request.id, initialVoidStatus, nowIso);

      this.enqueuePaymentVoidedNotification(request, initialVoidStatus, reason);

      return { request: updatedRequest, voidReason: reason };
    }
  }

  // ==========================================================================
  // Phase 1 Helper: Telegram Callback Validation & CAS Claim
  // ==========================================================================

  private validateAndClaimTelegramApproval(
    credentials: TelegramApprovalCredentials,
    action: ApprovalAction,
    nowIso: string
  ): { request: PaymentRequestRow; alreadyVoided?: boolean; voidReason?: string } {
    const { rawCallbackToken, telegramUserId, telegramChatId } = credentials;
    if (!rawCallbackToken || typeof rawCallbackToken !== 'string') {
      throw new ApprovalValidationError('INVALID_TOKEN_FORMAT', 'Raw callback token is required', 400);
    }
    if (!telegramUserId || !telegramChatId) {
      throw new ApprovalValidationError('CALLER_IDENTITY_REQUIRED', 'Telegram user and chat ID are required', 400);
    }

    // 1. Hash raw callback token
    const tokenHash = crypto.createHash('sha256').update(rawCallbackToken.trim()).digest('hex');

    // 2. Lookup callback row by hash
    const callback = this.repos.telegramApprovalCallbacks.getByTokenHash(tokenHash);
    if (!callback) {
      throw new ApprovalValidationError('TOKEN_NOT_FOUND', 'Telegram approval callback not found', 404);
    }

    // 3. Verify single-use consumption state
    if (callback.used_at !== null) {
      throw new ApprovalValidationError(
        'TOKEN_ALREADY_USED',
        'Telegram approval callback has already been consumed',
        409,
        callback.request_id
      );
    }

    // 4. Verify token expiry
    if (new Date(callback.expires_at).getTime() <= new Date(nowIso).getTime()) {
      throw new ApprovalValidationError(
        'TOKEN_EXPIRED',
        'Telegram approval callback token has expired',
        410,
        callback.request_id
      );
    }

    // 5. Verify action match
    if (callback.action !== action) {
      throw new ApprovalValidationError(
        'ACTION_MISMATCH',
        `Callback token is bound to ${callback.action}, cannot execute ${action}`,
        400,
        callback.request_id
      );
    }

    // 6. Verify caller identity against callback metadata
    const normUserId = String(telegramUserId).trim();
    const normChatId = String(telegramChatId).trim();

    if (callback.telegram_user_id !== normUserId) {
      throw new ApprovalValidationError(
        'USER_MISMATCH',
        'Telegram user ID does not match callback recipient',
        403,
        callback.request_id
      );
    }
    if (callback.telegram_chat_id !== normChatId) {
      throw new ApprovalValidationError(
        'CHAT_MISMATCH',
        'Telegram chat ID does not match callback recipient chat',
        403,
        callback.request_id
      );
    }

    // 7. Verify caller identity against currently linked owner
    const owner = this.repos.owners.get(callback.owner_id);
    if (!owner) {
      throw new ApprovalValidationError('OWNER_NOT_FOUND', 'Linked owner record not found', 403, callback.request_id);
    }
    if (!owner.telegram_chat_id || owner.telegram_chat_id !== normChatId) {
      throw new ApprovalValidationError('OWNER_UNLINKED', 'Owner is no longer linked to this Telegram chat', 403, callback.request_id);
    }
    if (owner.telegram_user_id && owner.telegram_user_id !== normUserId) {
      throw new ApprovalValidationError('OWNER_USER_MISMATCH', 'Owner numeric Telegram user ID mismatch', 403, callback.request_id);
    }
    if (
      typeof callback.linked_at !== 'string' ||
      callback.linked_at.trim().length === 0 ||
      typeof owner.telegram_linked_at !== 'string' ||
      owner.telegram_linked_at.trim().length === 0 ||
      callback.linked_at !== owner.telegram_linked_at
    ) {
      throw new ApprovalValidationError(
        'STALE_LINK_EPOCH',
        'Callback token was issued without or under a previous Telegram link epoch',
        403,
        callback.request_id
      );
    }

    // 8. Lookup and validate associated payment request
    const request = this.repos.paymentRequests.getById(callback.request_id);
    if (!request) {
      throw new ApprovalValidationError('REQUEST_NOT_FOUND', 'Associated payment request not found', 404);
    }
    if (request.status !== 'HELD') {
      throw new ApprovalValidationError(
        'INVALID_REQUEST_STATUS',
        `Payment request status is ${request.status}, expected HELD`,
        400,
        request.id
      );
    }
    if (request.expires_at && new Date(request.expires_at).getTime() <= new Date(nowIso).getTime()) {
      throw new ApprovalValidationError(
        'HOLD_EXPIRED',
        'Payment hold has expired',
        410,
        request.id
      );
    }

    // 9. Verify snapshot hash integrity (constant-time compare)
    const currentSnapshotHash = computeSnapshotHash({
      requestId: request.id,
      agentId: request.agent_id,
      vendorId: request.vendor_id,
      amountMinor: request.amount_minor,
      currency: request.currency,
      purpose: request.purpose,
      category: request.category,
    });
    const expectedBuf = Buffer.from(callback.snapshot_hash, 'hex');
    const actualBuf = Buffer.from(currentSnapshotHash, 'hex');
    if (
      expectedBuf.length !== actualBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, actualBuf)
    ) {
      throw new ApprovalValidationError(
        'SNAPSHOT_MISMATCH',
        'Payment request fields do not match persisted snapshot hash (tamper detected)',
        400,
        request.id
      );
    }

    // 10. Atomic CAS consumption
    const marked = this.repos.telegramApprovalCallbacks.markUsed(tokenHash, nowIso);
    if (!marked) {
      throw new ApprovalValidationError(
        'TOKEN_ALREADY_USED',
        'Telegram approval callback has already been consumed (concurrent race prevented)',
        409,
        request.id
      );
    }

    // 11. Sibling and cross-channel invalidation: invalidate all remaining approval tokens for this request
    this.repos.invalidateAllApprovalsForRequest(request.id, nowIso);

    // 12. State transition and ledger mutations
    if (action === 'APPROVE') {
      const { request: updatedRequest } = transitionPaymentRequest(this.db, this.repos, {
        requestId: request.id,
        to: 'APPROVED',
        actor: 'owner',
        event: 'OWNER_APPROVED',
        timestamp: nowIso,
        payload: {
          callback_id: callback.id,
          channel: 'telegram',
          owner_id: callback.owner_id,
          telegram_user_id: normUserId,
          telegram_chat_id: normChatId,
        },
      });

      return { request: updatedRequest };
    } else {
      const ledgerEntries = this.repos.ledger.listByRequestId(request.id);
      if (ledgerEntries.some((l) => l.kind === 'SPEND')) {
        throw new Error(`Illegal ledger state: cannot void request '${request.id}' with existing SPEND entry`);
      }
      if (!ledgerEntries.some((l) => l.kind === 'RELEASE')) {
        const ledgerId = `led-${crypto.randomUUID()}`;
        this.repos.ledger.insert({
          id: ledgerId,
          request_id: request.id,
          kind: 'RELEASE',
          amount_minor: request.amount_minor,
          currency: request.currency,
          created_at: nowIso,
        });
      }

      const authId = request.paypal_authorization_id?.trim();
      const initialVoidStatus: RemoteVoidStatus = authId ? 'PENDING' : 'FAILED';
      const reason = 'Owner rejected and voided payment hold via Telegram';

      const { request: updatedRequest } = transitionPaymentRequest(this.db, this.repos, {
        requestId: request.id,
        to: 'VOIDED',
        actor: 'owner',
        event: 'TRANSITION_TO_VOIDED',
        timestamp: nowIso,
        payload: {
          callback_id: callback.id,
          channel: 'telegram',
          owner_id: callback.owner_id,
          telegram_user_id: normUserId,
          telegram_chat_id: normChatId,
          reason,
          remote_void_status: initialVoidStatus,
        },
      });

      this.repos.paymentRequests.updateRemoteVoidStatus(request.id, initialVoidStatus, nowIso);

      this.enqueuePaymentVoidedNotification(request, initialVoidStatus, reason);

      return { request: updatedRequest, voidReason: reason };
    }
  }

  // ==========================================================================
  // Phase 1 Helper: Dashboard Session Direct Approval/Void & CAS Claim
  // ==========================================================================

  private validateAndClaimDashboardApproval(
    credentials: DashboardApprovalCredentials,
    action: ApprovalAction,
    nowIso: string
  ): { request: PaymentRequestRow; alreadyVoided?: boolean; voidReason?: string } {
    const { requestId } = credentials;
    if (!requestId || typeof requestId !== 'string' || !requestId.trim()) {
      throw new ApprovalValidationError('INVALID_INPUT', 'Payment request ID is required', 400);
    }

    const normalizedId = requestId.trim();
    const request = this.repos.paymentRequests.getById(normalizedId);
    if (!request) {
      throw new ApprovalValidationError('REQUEST_NOT_FOUND', 'Payment request not found', 404, normalizedId);
    }

    if (action === 'VOID' && request.status === 'VOIDED') {
      return { request, alreadyVoided: true };
    }

    if (request.status !== 'HELD') {
      throw new ApprovalValidationError(
        'INVALID_STATUS',
        `Request is in '${request.status}' status, cannot be ${action === 'APPROVE' ? 'approved' : 'voided'}`,
        409,
        request.id
      );
    }

    if (request.expires_at && new Date(request.expires_at).getTime() <= new Date(nowIso).getTime()) {
      throw new ApprovalValidationError(
        'HOLD_EXPIRED',
        'Payment hold has expired and cannot be approved',
        410,
        request.id
      );
    }

    if (request.snapshot_hash) {
      const currentSnapshotHash = computeSnapshotHash({
        requestId: request.id,
        agentId: request.agent_id,
        vendorId: request.vendor_id,
        amountMinor: request.amount_minor,
        currency: request.currency,
        purpose: request.purpose,
        category: request.category,
      });
      const expectedBuf = Buffer.from(request.snapshot_hash, 'hex');
      const actualBuf = Buffer.from(currentSnapshotHash, 'hex');
      if (
        expectedBuf.length !== actualBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, actualBuf)
      ) {
        throw new ApprovalValidationError(
          'SNAPSHOT_MISMATCH',
          'Payment request fields do not match persisted snapshot hash (tamper detected)',
          400,
          request.id
        );
      }
    }

    // Sibling and cross-channel invalidation: invalidate both web approval links and Telegram callbacks
    this.repos.invalidateAllApprovalsForRequest(request.id, nowIso);

    if (action === 'APPROVE') {
      const { request: updatedRequest } = transitionPaymentRequest(this.db, this.repos, {
        requestId: request.id,
        to: 'APPROVED',
        actor: 'owner',
        event: 'OWNER_APPROVED',
        timestamp: nowIso,
        payload: {
          channel: 'dashboard',
          owner_id: credentials.ownerId ?? 'default',
          owner_display_name: credentials.ownerDisplayName ?? 'Owner',
        },
      });

      return { request: updatedRequest };
    } else {
      const ledgerEntries = this.repos.ledger.listByRequestId(request.id);
      if (ledgerEntries.some((l) => l.kind === 'SPEND')) {
        throw new Error(`Illegal ledger state: cannot void request '${request.id}' with existing SPEND entry`);
      }
      if (!ledgerEntries.some((l) => l.kind === 'RELEASE')) {
        const ledgerId = `led-${crypto.randomUUID()}`;
        this.repos.ledger.insert({
          id: ledgerId,
          request_id: request.id,
          kind: 'RELEASE',
          amount_minor: request.amount_minor,
          currency: request.currency,
          created_at: nowIso,
        });
      }

      const authId = request.paypal_authorization_id?.trim();
      const initialVoidStatus: RemoteVoidStatus = authId ? 'PENDING' : 'FAILED';
      const reason = credentials.reason?.trim() || 'Owner voided hold from dashboard';

      const { request: updatedRequest } = transitionPaymentRequest(this.db, this.repos, {
        requestId: request.id,
        to: 'VOIDED',
        actor: 'owner',
        event: 'OWNER_VOIDED',
        timestamp: nowIso,
        payload: {
          channel: 'dashboard',
          owner_id: credentials.ownerId ?? 'default',
          owner_display_name: credentials.ownerDisplayName ?? 'Owner',
          reason,
          remote_void_status: initialVoidStatus,
        },
      });

      this.repos.paymentRequests.updateRemoteVoidStatus(request.id, initialVoidStatus, nowIso);

      this.enqueuePaymentVoidedNotification(request, initialVoidStatus, reason);

      return { request: updatedRequest, voidReason: reason };
    }
  }

  // ==========================================================================
  // Phase 2 Helper: Remote Capture Execution (Sole Money-Moving Path)
  // ==========================================================================

  private async executeRemoteCapture(requestId: string): Promise<ApprovalExecutionOutcome> {
    try {
      const urlOptions = this.getNotificationUrlOptions();
      const execution = await executeDecision(
        { requestId },
        {
          db: this.db,
          repos: this.repos,
          actor: 'owner',
          authorizationsService: this.authorizationsService,
          ordersService: this.ordersService,
          ...urlOptions,
        }
      );

      if (execution.status === 'FAILED') {
        return {
          success: false,
          action: 'APPROVE',
          requestId,
          status: 'FAILED',
          error: execution.error || 'EXECUTION_FAILED',
          message: 'Payment execution failed at PayPal and request has been marked FAILED',
        };
      }

      return {
        success: true,
        action: 'APPROVE',
        requestId: execution.request.id,
        status: 'CAPTURED',
        captureId: execution.captureId,
        executedAction: 'CAPTURED_APPROVED',
      };
    } catch (err: unknown) {
      if (err instanceof AmbiguousExecutionError) {
        return {
          success: false,
          action: 'APPROVE',
          requestId: err.requestId,
          status: 'CAPTURING',
          error: 'AMBIGUOUS_EXECUTION',
          reconciliationRequired: true,
          message: err.message,
        };
      }

      if (err instanceof ExecuteDecisionError) {
        return {
          success: false,
          action: 'APPROVE',
          requestId,
          status: 'FAILED',
          error: err.code,
          message: err.message,
        };
      }

      return {
        success: false,
        action: 'APPROVE',
        requestId,
        status: 'FAILED',
        error: 'EXECUTION_ERROR',
        message: err instanceof Error ? err.message : 'An error occurred during payment capture execution',
      };
    }
  }

  // ==========================================================================
  // Phase 2 Helper: Remote Void Execution (Authorized Void Path)
  // ==========================================================================

  private async executeRemoteVoid(
    request: PaymentRequestRow,
    _channel: ApprovalChannel,
    reason = 'Owner rejected and voided payment hold'
  ): Promise<ApprovalExecutionOutcome> {
    const authId = request.paypal_authorization_id?.trim();

    // Case 1: Missing authorization ID -> cannot void remotely
    if (!authId) {
      runInTransaction(this.db, () => {
        const existingLogs = this.repos.auditLog.listByRequestId(request.id);
        const alreadyLogged = existingLogs.some((l) => l.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID');
        if (!alreadyLogged) {
          writeAuditLogEntry(this.db, this.repos, {
            actor: 'system',
            event: 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID',
            requestId: request.id,
            payload: {
              reason: 'Cannot cancel remote authorization: request is missing paypal_authorization_id',
              remote_void_status: 'FAILED',
            },
          });
        }
        this.enqueuePaymentVoidedNotification(request, 'FAILED', reason);
      });

      return {
        success: true,
        action: 'VOID',
        requestId: request.id,
        status: 'VOIDED',
        remoteVoidStatus: 'FAILED',
        remoteVoidSuccess: false,
        reconciliationRequired: true,
        message: 'Local void committed, but remote cancellation failed: missing paypal_authorization_id',
      };
    }

    // Case 2: AuthorizationsService not configured -> leave PENDING for reconciler
    if (!this.authorizationsService) {
      runInTransaction(this.db, () => {
        this.enqueuePaymentVoidedNotification(request, 'PENDING', reason);
      });

      return {
        success: true,
        action: 'VOID',
        requestId: request.id,
        status: 'VOIDED',
        remoteVoidStatus: 'PENDING',
        remoteVoidSuccess: false,
        reconciliationRequired: true,
        message: 'Local void committed; remote cancellation pending reconciliation',
      };
    }

    // Case 3: AuthorizationsService configured -> execute remote void (outside SQLite transaction)
    let remoteVoidSuccess = false;
    let finalRemoteVoidStatus: RemoteVoidStatus = 'PENDING';
    const nowIso = new Date().toISOString();

    let voidRes: Awaited<ReturnType<PayPalAuthorizationsService['voidAuthorization']>> | undefined;
    let voidError: unknown;
    try {
      voidRes = await this.authorizationsService.voidAuthorization({
        authorizationId: authId,
        requestId: request.id,
      });
    } catch (err: unknown) {
      voidError = err;
    }

    if (voidRes !== undefined) {
      remoteVoidSuccess = Boolean(voidRes.isVoided);
      if (remoteVoidSuccess) {
        finalRemoteVoidStatus = 'CONFIRMED';
      } else {
        finalRemoteVoidStatus = 'PENDING';
        runInTransaction(this.db, () => {
          const latest = this.repos.paymentRequests.getById(request.id);
          if (latest && latest.remote_void_status !== 'CONFIRMED') {
            writeAuditLogEntryIfChanged(this.db, this.repos, {
              actor: 'system',
              event: 'PAYPAL_VOID_PENDING_RETRY',
              requestId: request.id,
              payload: {
                error: 'PayPal voidAuthorization returned unconfirmed status',
                authorizationId: authId,
                remote_void_status: 'PENDING',
              },
            });
          }
          this.enqueuePaymentVoidedNotification(request, 'PENDING', reason);
        });
      }
    } else {
      const isDefinitiveFailure =
        voidError instanceof AuthorizationError &&
        (voidError.code === 'INVALID_REQUEST' || voidError.code === 'DECLINED');

      if (isDefinitiveFailure) {
        finalRemoteVoidStatus = 'FAILED';
        runInTransaction(this.db, () => {
          this.repos.paymentRequests.updateRemoteVoidStatus(request.id, 'FAILED', nowIso);
          writeAuditLogEntry(this.db, this.repos, {
            actor: 'system',
            event: 'PAYPAL_VOID_FAILED',
            requestId: request.id,
            payload: {
              error: voidError instanceof Error ? voidError.message : String(voidError),
              authorizationId: authId,
              remote_void_status: 'FAILED',
            },
          });
          this.enqueuePaymentVoidedNotification(request, 'FAILED', reason);
        });
      } else {
        finalRemoteVoidStatus = 'PENDING';
        runInTransaction(this.db, () => {
          writeAuditLogEntryIfChanged(this.db, this.repos, {
            actor: 'system',
            event: 'PAYPAL_VOID_PENDING_RETRY',
            requestId: request.id,
            payload: {
              error: voidError instanceof Error ? voidError.message : String(voidError),
              authorizationId: authId,
              remote_void_status: 'PENDING',
            },
          });
          this.enqueuePaymentVoidedNotification(request, 'PENDING', reason);
        });
      }
    }

    if (remoteVoidSuccess) {
      runInTransaction(this.db, () => {
        const latest = this.repos.paymentRequests.getById(request.id);
        if (!latest || latest.remote_void_status !== 'CONFIRMED') {
          this.repos.paymentRequests.updateRemoteVoidStatus(request.id, 'CONFIRMED', nowIso);
          writeAuditLogEntry(this.db, this.repos, {
            actor: 'system',
            event: 'PAYPAL_VOID_CONFIRMED',
            requestId: request.id,
            payload: {
              authorizationId: authId,
              remote_void_status: 'CONFIRMED',
            },
          });
        }
        this.enqueuePaymentVoidedNotification(request, 'CONFIRMED', reason);
      });

      return {
        success: true,
        action: 'VOID',
        requestId: request.id,
        status: 'VOIDED',
        remoteVoidStatus: 'CONFIRMED',
        remoteVoidSuccess: true,
        message: 'Payment voided and remote authorization released',
      };
    }

    return {
      success: true,
      action: 'VOID',
      requestId: request.id,
      status: 'VOIDED',
      remoteVoidStatus: finalRemoteVoidStatus,
      remoteVoidSuccess: false,
      reconciliationRequired: finalRemoteVoidStatus !== 'CONFIRMED',
      message:
        finalRemoteVoidStatus === 'FAILED'
          ? 'Local void committed, but remote PayPal cancellation failed'
          : 'Local void committed; remote cancellation pending reconciliation',
    };
  }

  // ==========================================================================
  // Helper: Background Notifications & Lazy Expiry
  // ==========================================================================

  private enqueuePaymentVoidedNotification(
    request: PaymentRequestRow,
    remoteVoidStatus: RemoteVoidStatus = 'PENDING',
    reason = 'Owner rejected and voided payment hold'
  ): void {
    const urlOptions = this.getNotificationUrlOptions();
    this.repos.notifications.supersedeIntermediateForRequest(request.id);
    recoverVoidNotification(this.repos, {
      requestId: request.id,
      amountMinor: request.amount_minor,
      currency: request.currency,
      vendorId: request.vendor_id,
      remoteVoidStatus,
      reason,
      ...urlOptions,
    });
  }

  public triggerLazyHoldExpiry(requestId: string): void {
    if (this.shuttingDown || !this.db.open) {
      return;
    }
    void this.expireHoldTracked(requestId).catch((err: unknown) => {
      this.logger?.error?.('[ApprovalExecutionService] Error during lazy hold expiry:', err);
    });
  }
}
