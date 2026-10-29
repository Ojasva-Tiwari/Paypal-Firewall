/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T6: Decision Execution Choke Point (executeDecision)
 *
 * Implements:
 * - The single choke point in the codebase permitted to invoke money-moving
 *   PayPal operations (createOrder with CAPTURE/AUTHORIZE and captureAuthorization).
 * - Flow A (ALLOW): Auto-execute CAPTURE order -> transition to CAPTURED + SPEND row.
 * - Flow B (HOLD): Create AUTHORIZE order -> store authorization ID -> remain HELD.
 * - Flow C (APPROVE): Atomic claim APPROVED -> CAPTURING -> captureAuthorization -> CAPTURED + SPEND row.
 * - Strict dual-layer execution protection:
 *     1. In-process single-flight promise map (inFlightExecutions) to deduplicate concurrent calls.
 *     2. Persisted-state guards preventing duplicate submissions on crash recovery or ambiguous outcomes.
 * - Strict error classification:
 *     - Definitive failure: Only when proof exists that no hold or capture occurred (e.g. 422 DECLINED,
 *       pre-flight missing vault token). Releases funds via RELEASE row and transitions to FAILED.
 *     - Ambiguous outcome: Network failures, HTTP 5xx, pending status, malformed response, or
 *       AUTHORIZATION_ALREADY_CAPTURED. Never releases reservation; remains in-flight; throws AmbiguousExecutionError.
 * - Fail-closed: Ambiguous requests remain blocked until M2-T7 reconciliation.
 *
 * Security & Invariants:
 * - Hard Rule 1: Sandbox only. Production refused.
 * - Hard Rule 3 & I3: Money-moving PayPal calls happen ONLY inside executeDecision.
 * - Hard Rule 4 & I3: Only executeDecision in src/core may call money-moving PayPal functions.
 * - Hard Rule 5: Money is integer minor units; converted to decimal strings only at PayPal boundary.
 * - Hard Rule 7 & I2: Every state transition writes an audit_log row in the same transaction.
 * - Hard Rule 8: Fail closed on any error or ambiguity; never move money or release holds prematurely.
 */

import * as crypto from 'node:crypto';
import type { Database } from '../db/connection.js';
import { runInTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import { createRepositories } from '../db/repositories.js';
import type {
  PaymentRequestRow,
  LedgerRow,
  AuditLogRow,
} from '../db/types.js';
import type { MinorUnits } from './money.js';
import type {
  PayPalOrdersService,
  PayPalOrderResult,
} from '../paypal/orders.js';
import type {
  PayPalAuthorizationsService,
  PayPalCaptureResult,
} from '../paypal/authorizations.js';
import {
  transitionPaymentRequest,
  writeAuditLogEntry,
  type PaymentRequestStatus,
  type AuditActor,
  TERMINAL_STATUSES,
} from './stateMachine.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface ExecuteDecisionParams {
  readonly requestId: string;
}

export interface ExecuteDecisionOptions {
  readonly db?: Database;
  readonly repos?: Repositories;
  readonly ordersService?: PayPalOrdersService;
  readonly authorizationsService?: PayPalAuthorizationsService;
  readonly defaultVaultTokenId?: string;
  readonly now?: Date;
  readonly actor?: AuditActor;
}

export type ExecutedAction =
  | 'CAPTURED'           // Flow A: Auto-execute CAPTURE completed
  | 'HELD_AUTHORIZED'    // Flow B: Authorize hold established for HELD request
  | 'CAPTURED_APPROVED'  // Flow C: Captured previously approved authorization
  | 'NO_OP'              // Terminal state or already processed
  | 'FAILED';            // PayPal execution failed closed; reservation released

export interface ExecuteDecisionResult {
  readonly request: PaymentRequestRow;
  readonly status: PaymentRequestStatus;
  readonly executedAction: ExecutedAction;
  readonly actionTaken: ExecutedAction; // ergonomic alias
  readonly executed: boolean;
  readonly orderId?: string | null;
  readonly authorizationId?: string | null;
  readonly captureId?: string | null;
  readonly paypalOrderId?: string | null;
  readonly paypalAuthorizationId?: string | null;
  readonly paypalCaptureId?: string | null;
  readonly ledgerEntry?: LedgerRow;
  readonly auditEntry?: AuditLogRow;
  readonly error?: string;
}

// ============================================================================
// Error Classes
// ============================================================================

export class ExecuteDecisionError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly debugId?: string;
  public readonly causeError?: unknown;

  constructor(
    code: string,
    requestId: string,
    message: string,
    options?: { debugId?: string; causeError?: unknown }
  ) {
    const debugSuffix = options?.debugId ? ` (debug_id: ${options.debugId})` : '';
    super(`[${code}] Payment request ${requestId}: ${message}${debugSuffix}`);
    this.name = 'ExecuteDecisionError';
    this.code = code;
    this.requestId = requestId;
    this.debugId = options?.debugId;
    this.causeError = options?.causeError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AmbiguousExecutionError extends ExecuteDecisionError {
  constructor(
    requestId: string,
    message: string,
    options?: { debugId?: string; causeError?: unknown }
  ) {
    super('AMBIGUOUS_OUTCOME', requestId, message, options);
    this.name = 'AmbiguousExecutionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// In-Memory Single-Flight Promise Map
// ============================================================================

const inFlightExecutions = new Map<string, Promise<ExecuteDecisionResult>>();

/**
 * Resets the in-process execution map. Used strictly in automated unit tests.
 */
export function _resetInFlightExecutionsForTest(): void {
  inFlightExecutions.clear();
}

// ============================================================================
// Error Classification Helper
// ============================================================================

interface ExtractedErrorDetails {
  code?: string;
  status?: number;
  issue?: string;
  debugId?: string;
  message: string;
  isAlreadyCaptured: boolean;
  isNetworkOrTimeout: boolean;
  isServer5xx: boolean;
}

function extractErrorDetails(err: unknown): ExtractedErrorDetails {
  let code: string | undefined;
  let status: number | undefined;
  let issue: string | undefined;
  let debugId: string | undefined;
  const message = err instanceof Error ? err.message : String(err);

  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (typeof o.code === 'string') code = o.code;
    if (typeof o.status === 'number') status = o.status;
    if (typeof o.issue === 'string') issue = o.issue;
    if (typeof o.debugId === 'string') debugId = o.debugId;

    if (o.causeError && typeof o.causeError === 'object') {
      const cause = o.causeError as Record<string, unknown>;
      if (!code && typeof cause.code === 'string') code = cause.code;
      if (typeof cause.status === 'number') status = cause.status;
      if (typeof cause.issue === 'string') issue = cause.issue;
      if (!debugId && typeof cause.debugId === 'string') debugId = cause.debugId;
    }
  }

  // Check for ALREADY_CAPTURED condition across issue, message, and details
  const isAlreadyCaptured = Boolean(
    issue === 'AUTHORIZATION_ALREADY_CAPTURED' ||
    issue === 'ORDER_ALREADY_CAPTURED' ||
    message.includes('AUTHORIZATION_ALREADY_CAPTURED') ||
    message.includes('ORDER_ALREADY_CAPTURED')
  );

  const isNetworkOrTimeout = Boolean(
    code === 'NETWORK' ||
    message.includes('timeout') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ECONNRESET') ||
    message.includes('Network')
  );

  const isServer5xx = Boolean(
    (status !== undefined && status >= 500) ||
    code === 'UNKNOWN'
  );

  return {
    code,
    status,
    issue,
    debugId,
    message,
    isAlreadyCaptured,
    isNetworkOrTimeout,
    isServer5xx,
  };
}

/**
 * Determines whether a PayPal error constitutes a definitive failure
 * where we have conclusive proof that no hold or capture occurred.
 */
function isDefinitivePayPalFailure(details: ExtractedErrorDetails): boolean {
  // If money was already captured in a prior attempt, this is NOT a failure!
  if (details.isAlreadyCaptured) {
    return false;
  }

  // Network timeouts and 5xx server errors are strictly ambiguous
  if (details.isNetworkOrTimeout || details.isServer5xx) {
    return false;
  }

  // Recognized definitive 4xx client errors from PayPal
  const definitiveIssues = new Set([
    'INSTRUMENT_DECLINED',
    'PAYER_ACTION_REQUIRED',
    'PAYMENT_SOURCE_CANNOT_BE_USED',
    'INVALID_REQUEST',
    'MISSING_REQUIRED_PARAMETER',
    'AUTHORIZATION_EXPIRED',
    'AUTHORIZATION_VOIDED',
  ]);

  if (details.issue && definitiveIssues.has(details.issue)) {
    return true;
  }

  const definitiveCodes = new Set([
    'DECLINED',
    'VAULT_INVALID',
    'INVALID_REQUEST',
    'AUTH_EXPIRED',
  ]);

  if (details.code && definitiveCodes.has(details.code)) {
    return true;
  }

  if (details.status !== undefined && details.status >= 400 && details.status < 500) {
    return true;
  }

  return false;
}

// ============================================================================
// Ledger and State Helper Functions
// ============================================================================

function commitDefinitiveFailure(
  db: Database,
  repos: Repositories,
  params: {
    requestId: string;
    fromStatus: PaymentRequestStatus;
    amountMinor: MinorUnits;
    currency: string;
    actor: AuditActor;
    timestamp: string;
    reason: string;
    event?: string;
    debugId?: string;
    errorDetails?: unknown;
  }
): ExecuteDecisionResult {
  return runInTransaction(db, () => {
    // 1. Insert RELEASE row in ledger
    const ledgerId = `led-${crypto.randomUUID()}`;
    const ledgerEntry: LedgerRow = {
      id: ledgerId,
      request_id: params.requestId,
      kind: 'RELEASE',
      amount_minor: params.amountMinor,
      currency: params.currency,
      created_at: params.timestamp,
    };
    repos.ledger.insert(ledgerEntry);

    // 2. Transition fromStatus -> FAILED & write audit log
    const { request: updatedRequest, auditEntry } = transitionPaymentRequest(db, repos, {
      requestId: params.requestId,
      to: 'FAILED',
      actor: params.actor,
      event: params.event || 'TRANSITION_TO_FAILED',
      reason: params.reason,
      timestamp: params.timestamp,
      payload: {
        reason: params.reason,
        debug_id: params.debugId,
        details: params.errorDetails,
      },
    });

    return {
      request: updatedRequest,
      status: 'FAILED',
      executedAction: 'FAILED',
      actionTaken: 'FAILED',
      executed: false,
      ledgerEntry,
      auditEntry,
      error: params.reason,
    };
  });
}

function recordAmbiguousOutcome(
  db: Database,
  repos: Repositories,
  params: {
    requestId: string;
    actor: AuditActor;
    timestamp: string;
    event?: string;
    orderId?: string | null;
    captureId?: string | null;
    reason: string;
    debugId?: string;
    details?: unknown;
  }
): AuditLogRow {
  return runInTransaction(db, () => {
    if (params.orderId || params.captureId) {
      repos.paymentRequests.updatePayPalIds(params.requestId, {
        orderId: params.orderId,
        captureId: params.captureId,
        updatedAt: params.timestamp,
      });
    }

    return writeAuditLogEntry(db, repos, {
      actor: params.actor,
      event: params.event || 'EXECUTION_AMBIGUOUS',
      requestId: params.requestId,
      timestamp: params.timestamp,
      payload: {
        reason: params.reason,
        debug_id: params.debugId,
        details: params.details,
      },
    });
  });
}

// ============================================================================
// Main Execution Implementation
// ============================================================================

async function doExecuteDecision(
  db: Database,
  params: ExecuteDecisionParams,
  options: ExecuteDecisionOptions
): Promise<ExecuteDecisionResult> {
  const { requestId } = params;
  const repos = options.repos ?? createRepositories(db);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const actor = options.actor ?? 'system';

  // 1. Fetch Request
  const request = repos.paymentRequests.getById(requestId);
  if (!request) {
    throw new ExecuteDecisionError('REQUEST_NOT_FOUND', requestId, `Payment request not found: ${requestId}`);
  }

  // 2. Terminal state handling: No-op
  if (TERMINAL_STATUSES.has(request.status as PaymentRequestStatus)) {
    return {
      request,
      status: request.status as PaymentRequestStatus,
      executedAction: 'NO_OP',
      actionTaken: 'NO_OP',
      executed: false,
      orderId: request.paypal_order_id,
      authorizationId: request.paypal_authorization_id,
      captureId: request.paypal_capture_id,
      paypalOrderId: request.paypal_order_id,
      paypalAuthorizationId: request.paypal_authorization_id,
      paypalCaptureId: request.paypal_capture_id,
    };
  }

  if (request.status === 'EXPIRED') {
    return {
      request,
      status: 'EXPIRED',
      executedAction: 'NO_OP',
      actionTaken: 'NO_OP',
      executed: false,
      orderId: request.paypal_order_id,
      authorizationId: request.paypal_authorization_id,
      captureId: request.paypal_capture_id,
      paypalOrderId: request.paypal_order_id,
      paypalAuthorizationId: request.paypal_authorization_id,
      paypalCaptureId: request.paypal_capture_id,
    };
  }

  if (request.status === 'RECEIVED') {
    throw new ExecuteDecisionError(
      'INVALID_STATE',
      requestId,
      'Payment request is in RECEIVED state; evaluateAndReserve must be executed first'
    );
  }

  // 3. Flow B HELD with existing authorization: Already established hold awaiting approval
  if (request.status === 'HELD' && request.paypal_authorization_id) {
    return {
      request,
      status: 'HELD',
      executedAction: 'NO_OP',
      actionTaken: 'NO_OP',
      executed: false,
      orderId: request.paypal_order_id,
      authorizationId: request.paypal_authorization_id,
      paypalOrderId: request.paypal_order_id,
      paypalAuthorizationId: request.paypal_authorization_id,
    };
  }

  // 4. Persisted-state guards: Fail closed on in-flight or ambiguous states without active promise
  if (request.status === 'CAPTURING') {
    throw new AmbiguousExecutionError(
      requestId,
      "Payment request is in-flight with status 'CAPTURING' without an active execution promise. Reconciliation required before retrying."
    );
  }

  if (request.status === 'AUTO_EXECUTING' && request.paypal_order_id !== null) {
    throw new AmbiguousExecutionError(
      requestId,
      `Payment request is in-flight with status 'AUTO_EXECUTING' and existing paypal_order_id '${request.paypal_order_id}'. Reconciliation required before retrying.`
    );
  }

  const previousAudit = repos.auditLog.listByRequestId(requestId);
  const hadAmbiguousAttempt = previousAudit.some(
    (a) => a.event === 'EXECUTION_AMBIGUOUS' || a.event === 'EXECUTION_FAILED_AMBIGUOUS'
  );
  if (hadAmbiguousAttempt) {
    throw new AmbiguousExecutionError(
      requestId,
      'Payment request has a previous ambiguous execution recorded. Reconciliation required before retrying.'
    );
  }

  // ==========================================================================
  // Flow A: AUTO_EXECUTING (createOrder intent: CAPTURE)
  // ==========================================================================
  if (request.status === 'AUTO_EXECUTING') {
    // Resolve vendor vault token
    let vaultTokenId: string | undefined;
    const vendorVault = repos.vendorVaultTokens.getByVendorId(request.vendor_id);
    if (vendorVault && vendorVault.vault_token_id && vendorVault.status !== 'BLOCKED') {
      vaultTokenId = vendorVault.vault_token_id;
    }
    if (!vaultTokenId) {
      vaultTokenId = options.defaultVaultTokenId || process.env.VAULT_TOKEN_ID;
    }

    if (!vaultTokenId) {
      return commitDefinitiveFailure(db, repos, {
        requestId,
        fromStatus: 'AUTO_EXECUTING',
        amountMinor: request.amount_minor,
        currency: request.currency,
        actor,
        timestamp: nowIso,
        reason: 'Missing vendor vault token',
        event: 'EXECUTION_FAILED_PREFLIGHT',
      });
    }

    if (!options.ordersService) {
      throw new ExecuteDecisionError('CONFIG_ERROR', requestId, 'PayPal ordersService not configured');
    }

    let orderResult: PayPalOrderResult;
    try {
      // Money-moving call outside DB transaction
      orderResult = await options.ordersService.createOrder({
        requestId,
        amountMinor: request.amount_minor,
        currency: request.currency,
        intent: 'CAPTURE',
        vaultTokenId,
        description: request.purpose,
      });
    } catch (err: unknown) {
      const details = extractErrorDetails(err);
      if (isDefinitivePayPalFailure(details)) {
        return commitDefinitiveFailure(db, repos, {
          requestId,
          fromStatus: 'AUTO_EXECUTING',
          amountMinor: request.amount_minor,
          currency: request.currency,
          actor,
          timestamp: nowIso,
          reason: details.message,
          debugId: details.debugId,
          errorDetails: details,
        });
      }

      // Ambiguous error: Keep reservation, leave AUTO_EXECUTING, audit, throw
      recordAmbiguousOutcome(db, repos, {
        requestId,
        actor,
        timestamp: nowIso,
        event: 'EXECUTION_AMBIGUOUS',
        reason: details.message,
        debugId: details.debugId,
        details,
      });
      throw new AmbiguousExecutionError(
        requestId,
        `Payment order execution returned ambiguous outcome: ${details.message}`,
        { debugId: details.debugId, causeError: err }
      );
    }

    // Verify capture result
    if (!orderResult.isCaptured || !orderResult.capture || orderResult.capture.status !== 'COMPLETED') {
      recordAmbiguousOutcome(db, repos, {
        requestId,
        actor,
        timestamp: nowIso,
        event: 'EXECUTION_AMBIGUOUS',
        orderId: orderResult.id,
        reason: `Order capture returned non-completed status: ${orderResult.capture?.status || orderResult.status}`,
        details: { orderResult },
      });
      throw new AmbiguousExecutionError(
        requestId,
        `Order capture was not completed (status: ${orderResult.capture?.status || orderResult.status}). Funds may be pending. Handed off to reconciliation.`
      );
    }

    // Confirmed capture success! Commit SPEND row and state transition atomically
    return runInTransaction(db, () => {
      const ledgerId = `led-${crypto.randomUUID()}`;
      const ledgerEntry: LedgerRow = {
        id: ledgerId,
        request_id: requestId,
        kind: 'SPEND',
        amount_minor: request.amount_minor,
        currency: request.currency,
        created_at: nowIso,
      };
      repos.ledger.insert(ledgerEntry);

      const { request: updatedRequest, auditEntry } = transitionPaymentRequest(db, repos, {
        requestId,
        to: 'CAPTURED',
        actor,
        event: 'TRANSITION_TO_CAPTURED',
        paypalOrderId: orderResult.id,
        paypalCaptureId: orderResult.capture!.id,
        timestamp: nowIso,
        payload: {
          paypal_order_id: orderResult.id,
          paypal_capture_id: orderResult.capture!.id,
          amount_minor: request.amount_minor.toString(),
          currency: request.currency,
        },
      });

      return {
        request: updatedRequest,
        status: 'CAPTURED',
        executedAction: 'CAPTURED',
        actionTaken: 'CAPTURED',
        executed: true,
        orderId: orderResult.id,
        captureId: orderResult.capture!.id,
        paypalOrderId: orderResult.id,
        paypalCaptureId: orderResult.capture!.id,
        ledgerEntry,
        auditEntry,
      };
    });
  }

  // ==========================================================================
  // Flow B: HELD without authorization ID (createOrder intent: AUTHORIZE)
  // ==========================================================================
  if (request.status === 'HELD') {
    let vaultTokenId: string | undefined;
    const vendorVault = repos.vendorVaultTokens.getByVendorId(request.vendor_id);
    if (vendorVault && vendorVault.vault_token_id && vendorVault.status !== 'BLOCKED') {
      vaultTokenId = vendorVault.vault_token_id;
    }
    if (!vaultTokenId) {
      vaultTokenId = options.defaultVaultTokenId || process.env.VAULT_TOKEN_ID;
    }

    if (!vaultTokenId) {
      return commitDefinitiveFailure(db, repos, {
        requestId,
        fromStatus: 'HELD',
        amountMinor: request.amount_minor,
        currency: request.currency,
        actor,
        timestamp: nowIso,
        reason: 'Missing vendor vault token',
        event: 'EXECUTION_FAILED_PREFLIGHT',
      });
    }

    if (!options.ordersService) {
      throw new ExecuteDecisionError('CONFIG_ERROR', requestId, 'PayPal ordersService not configured');
    }

    let orderResult: PayPalOrderResult;
    try {
      orderResult = await options.ordersService.createOrder({
        requestId,
        amountMinor: request.amount_minor,
        currency: request.currency,
        intent: 'AUTHORIZE',
        vaultTokenId,
        description: request.purpose,
      });
    } catch (err: unknown) {
      const details = extractErrorDetails(err);
      if (isDefinitivePayPalFailure(details)) {
        // Option B: HELD -> FAILED with RELEASE row
        return commitDefinitiveFailure(db, repos, {
          requestId,
          fromStatus: 'HELD',
          amountMinor: request.amount_minor,
          currency: request.currency,
          actor,
          timestamp: nowIso,
          reason: details.message,
          debugId: details.debugId,
          errorDetails: details,
        });
      }

      recordAmbiguousOutcome(db, repos, {
        requestId,
        actor,
        timestamp: nowIso,
        event: 'EXECUTION_AMBIGUOUS',
        reason: details.message,
        debugId: details.debugId,
        details,
      });
      throw new AmbiguousExecutionError(
        requestId,
        `Authorization order execution returned ambiguous outcome: ${details.message}`,
        { debugId: details.debugId, causeError: err }
      );
    }

    if (!orderResult.isAuthorized || !orderResult.authorization?.id) {
      recordAmbiguousOutcome(db, repos, {
        requestId,
        actor,
        timestamp: nowIso,
        event: 'EXECUTION_AMBIGUOUS',
        orderId: orderResult.id,
        reason: `Order authorization was not created (status: ${orderResult.authorization?.status || orderResult.status})`,
        details: { orderResult },
      });
      throw new AmbiguousExecutionError(
        requestId,
        `Order authorization was not created (status: ${orderResult.authorization?.status || orderResult.status}). Handed off to reconciliation.`
      );
    }

    return runInTransaction(db, () => {
      repos.paymentRequests.updatePayPalIds(requestId, {
        orderId: orderResult.id,
        authorizationId: orderResult.authorization!.id,
        updatedAt: nowIso,
      });

      const auditEntry = writeAuditLogEntry(db, repos, {
        actor,
        event: 'PAYPAL_AUTHORIZATION_ESTABLISHED',
        requestId,
        timestamp: nowIso,
        payload: {
          paypal_order_id: orderResult.id,
          paypal_authorization_id: orderResult.authorization!.id,
          status: 'HELD',
        },
      });

      const updatedRequest = repos.paymentRequests.getById(requestId)!;

      return {
        request: updatedRequest,
        status: 'HELD',
        executedAction: 'HELD_AUTHORIZED',
        actionTaken: 'HELD_AUTHORIZED',
        executed: true,
        orderId: orderResult.id,
        authorizationId: orderResult.authorization!.id,
        paypalOrderId: orderResult.id,
        paypalAuthorizationId: orderResult.authorization!.id,
        auditEntry,
      };
    });
  }

  // ==========================================================================
  // Flow C: APPROVED (captureAuthorization)
  // ==========================================================================
  if (request.status === 'APPROVED') {
    if (!request.paypal_authorization_id) {
      return commitDefinitiveFailure(db, repos, {
        requestId,
        fromStatus: 'APPROVED',
        amountMinor: request.amount_minor,
        currency: request.currency,
        actor,
        timestamp: nowIso,
        reason: 'Cannot capture approved request: missing paypal_authorization_id',
        event: 'EXECUTION_FAILED_PREFLIGHT',
      });
    }

    // Atomic database-level claim: APPROVED -> CAPTURING
    runInTransaction(db, () => {
      transitionPaymentRequest(db, repos, {
        requestId,
        to: 'CAPTURING',
        actor,
        event: 'TRANSITION_TO_CAPTURING',
        timestamp: nowIso,
      });
    });

    if (!options.authorizationsService) {
      throw new ExecuteDecisionError('CONFIG_ERROR', requestId, 'PayPal authorizationsService not configured');
    }

    let captureResult: PayPalCaptureResult;
    try {
      captureResult = await options.authorizationsService.captureAuthorization({
        authorizationId: request.paypal_authorization_id,
        requestId,
        amountMinor: request.amount_minor,
        currency: request.currency,
        finalCapture: true,
      });
    } catch (err: unknown) {
      const details = extractErrorDetails(err);
      if (isDefinitivePayPalFailure(details)) {
        return commitDefinitiveFailure(db, repos, {
          requestId,
          fromStatus: 'CAPTURING',
          amountMinor: request.amount_minor,
          currency: request.currency,
          actor,
          timestamp: nowIso,
          reason: details.message,
          debugId: details.debugId,
          errorDetails: details,
        });
      }

      // Ambiguous outcome (including AUTHORIZATION_ALREADY_CAPTURED)
      recordAmbiguousOutcome(db, repos, {
        requestId,
        actor,
        timestamp: nowIso,
        event: 'EXECUTION_AMBIGUOUS',
        reason: details.message,
        debugId: details.debugId,
        details,
      });
      throw new AmbiguousExecutionError(
        requestId,
        `Authorization capture returned ambiguous outcome: ${details.message}`,
        { debugId: details.debugId, causeError: err }
      );
    }

    if (!captureResult.isCaptured || captureResult.status !== 'COMPLETED') {
      recordAmbiguousOutcome(db, repos, {
        requestId,
        actor,
        timestamp: nowIso,
        event: 'EXECUTION_AMBIGUOUS',
        captureId: captureResult.id,
        reason: `Authorization capture returned non-completed status: ${captureResult.status}`,
        details: { captureResult },
      });
      throw new AmbiguousExecutionError(
        requestId,
        `Authorization capture status is not COMPLETED (status: ${captureResult.status}). Funds may be in-flight. Handed off to reconciliation.`
      );
    }

    // Confirmed capture success! Commit SPEND row and state transition atomically
    return runInTransaction(db, () => {
      const ledgerId = `led-${crypto.randomUUID()}`;
      const ledgerEntry: LedgerRow = {
        id: ledgerId,
        request_id: requestId,
        kind: 'SPEND',
        amount_minor: request.amount_minor,
        currency: request.currency,
        created_at: nowIso,
      };
      repos.ledger.insert(ledgerEntry);

      const { request: updatedRequest, auditEntry } = transitionPaymentRequest(db, repos, {
        requestId,
        to: 'CAPTURED',
        actor,
        event: 'TRANSITION_TO_CAPTURED',
        paypalCaptureId: captureResult.id,
        timestamp: nowIso,
        payload: {
          paypal_authorization_id: request.paypal_authorization_id,
          paypal_capture_id: captureResult.id,
          amount_minor: request.amount_minor.toString(),
          currency: request.currency,
        },
      });

      return {
        request: updatedRequest,
        status: 'CAPTURED',
        executedAction: 'CAPTURED_APPROVED',
        actionTaken: 'CAPTURED_APPROVED',
        executed: true,
        authorizationId: request.paypal_authorization_id,
        captureId: captureResult.id,
        paypalAuthorizationId: request.paypal_authorization_id,
        paypalCaptureId: captureResult.id,
        ledgerEntry,
        auditEntry,
      };
    });
  }

  throw new ExecuteDecisionError(
    'UNSUPPORTED_STATUS',
    requestId,
    `Cannot execute decision for request in status: ${request.status}`
  );
}

// ============================================================================
// Public Entry Point
// ============================================================================

export async function executeDecision(
  paramsOrDb: ExecuteDecisionParams | Database,
  optionsOrParams?: ExecuteDecisionOptions | ExecuteDecisionParams,
  maybeOptions?: ExecuteDecisionOptions
): Promise<ExecuteDecisionResult> {
  let db: Database;
  let params: ExecuteDecisionParams;
  let options: ExecuteDecisionOptions;

  if (paramsOrDb && typeof (paramsOrDb as Database).prepare === 'function') {
    db = paramsOrDb as Database;
    params = optionsOrParams as ExecuteDecisionParams;
    options = maybeOptions || {};
  } else {
    params = paramsOrDb as ExecuteDecisionParams;
    options = (optionsOrParams as ExecuteDecisionOptions) || {};
    if (!options.db) {
      throw new Error('Database instance must be provided in executeDecision options or as first argument');
    }
    db = options.db;
  }

  // Enforce Hard Rule 3: Never execute PayPal calls inside an open DB transaction
  if (db.inTransaction) {
    throw new ExecuteDecisionError(
      'INVALID_INVOCATION',
      params.requestId,
      'executeDecision must not be called inside an open database transaction'
    );
  }

  const { requestId } = params;
  if (!requestId || typeof requestId !== 'string' || requestId.trim() === '') {
    throw new ExecuteDecisionError('INVALID_INPUT', '', 'requestId must be a non-empty string');
  }

  // In-process single-flight deduplication: return existing active promise
  const existingPromise = inFlightExecutions.get(requestId);
  if (existingPromise) {
    return await existingPromise;
  }

  const executionPromise = doExecuteDecision(db, params, options);
  inFlightExecutions.set(requestId, executionPromise);

  try {
    return await executionPromise;
  } finally {
    inFlightExecutions.delete(requestId);
  }
}
