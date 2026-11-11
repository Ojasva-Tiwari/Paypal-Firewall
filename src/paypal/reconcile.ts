/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T7: PayPal Reconciliation Subsystem & Reconciler Job
 *
 * Implements:
 * - Authoritative reconciliation of persisted payment requests against PayPal remote state
 * - Flow A (AUTO_EXECUTING): Verifies Orders v2 state; repairs captured payments (SPEND row)
 *   or marks failed (RELEASE row) if voided; fails closed on missing order ID or ambiguity.
 * - Flow B (HELD): Verifies authorization holds; repairs missing authorization ID from remote order
 *   if status is CREATED; requires strict dual-attestation before releasing reservation on void/expired.
 * - Flow C (CAPTURING): Verifies authorization capture status; repairs to CAPTURED if completed;
 *   never assumes CREATED makes a new capture safe; retains CAPTURING and reservation on CREATED.
 * - Strict dual-attestation on terminal hold recovery: Never releases reservation without proof
 *   across both order and direct authorization lookups that no capture occurred.
 * - Missing identifier safety: Never guesses IDs, never creates replacement orders, fails closed.
 * - Preserves Invariant I2 (state machine), Invariant I3 (only executeDecision moves money),
 *   and Invariant I4 (idempotent ledger; never duplicates SPEND/RELEASE; never RELEASE after SPEND).
 * - Canonical 60-second periodic background worker (ReconcilerWorker) per PLAN.md Section 9 & 13.
 */

import * as crypto from 'node:crypto';
import type { Database } from '../db/connection.js';
import { runInTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import { createRepositories } from '../db/repositories.js';
import type {
  LedgerRow,
  AuditLogRow,
} from '../db/types.js';
import type {
  PayPalOrdersService,
  PayPalOrderResult,
} from './orders.js';
import type {
  PayPalAuthorizationsService,
  PayPalAuthorizationDetails,
} from './authorizations.js';
import { AuthorizationError } from './authorizations.js';
import { executeDecision, AmbiguousExecutionError } from '../core/executeDecision.js';
import {
  transitionPaymentRequest,
  writeAuditLogEntry,
  writeAuditLogEntryIfChanged,
  type PaymentRequestStatus,
  type AuditActor,
  TERMINAL_STATUSES,
  IllegalStateTransitionError,
} from '../core/stateMachine.js';
import { formatMinorUnitsToDecimal } from '../core/money.js';
import { sanitizePublicBaseUrl } from '../config/index.js';
import {
  formatPaymentCapturedMessage,
  formatPaymentFailedMessage,
  enqueuePaymentTerminalOutcome,
  recoverVoidNotification,
} from '../telegram/notifications.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type ReconcileActionTaken =
  | 'CAPTURED'
  | 'FAILED'
  | 'VOIDED'
  | 'REPAIRED_HOLD_ID'
  | 'NO_OP';

export type ReconcileStatus = PaymentRequestStatus | 'UNRESOLVED';

export interface ReconcileRequestOptions {
  readonly db?: Database;
  readonly repos?: Repositories;
  readonly ordersService?: PayPalOrdersService;
  readonly authorizationsService?: PayPalAuthorizationsService;
  readonly now?: Date;
  readonly actor?: AuditActor;
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
  readonly shouldContinue?: () => boolean;
  readonly logger?: {
    readonly info?: (msg: string, ...args: unknown[]) => void;
    readonly warn?: (msg: string, ...args: unknown[]) => void;
    readonly error?: (msg: string, ...args: unknown[]) => void;
  };
}

export interface ReconcileRequestResult {
  readonly requestId: string;
  readonly status: ReconcileStatus;
  readonly requestStatus?: PaymentRequestStatus;
  readonly actionTaken: ReconcileActionTaken;
  readonly reconciled: boolean;
  readonly resolved?: boolean;
  readonly isUnresolved?: boolean;
  readonly reason?: string;
  readonly error?: string;
  readonly orderId?: string | null;
  readonly authorizationId?: string | null;
  readonly captureId?: string | null;
  readonly ledgerEntry?: LedgerRow;
  readonly auditEntry?: AuditLogRow;
}

export interface ReconcileBatchResult {
  readonly totalProcessed: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly results: readonly ReconcileRequestResult[];
}

export interface ReconcilerWorkerOptions {
  readonly db: Database;
  readonly repos?: Repositories;
  readonly ordersService?: PayPalOrdersService;
  readonly authorizationsService?: PayPalAuthorizationsService;
  readonly intervalMs?: number; // default: 60_000 (60s canonical)
  readonly publicBaseUrl?: string;
  readonly isProduction?: boolean;
  readonly logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function sanitizeRecoveredOrderId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function extractProvisionalOrderIdFromAudit(
  repos: Repositories,
  requestId: string
): string | undefined {
  const auditEntries = repos.auditLog.listByRequestId(requestId);
  for (const entry of auditEntries) {
    if (entry.payload) {
      try {
        const parsed = JSON.parse(entry.payload) as Record<string, unknown>;
        const candidate =
          sanitizeRecoveredOrderId(parsed.paypal_order_id) ??
          sanitizeRecoveredOrderId(parsed.orderId) ??
          sanitizeRecoveredOrderId(parsed.order_id);
        if (candidate) {
          return candidate;
        }
      } catch {
        // ignore malformed audit JSON
      }
    }
  }
  return undefined;
}

function persistRecoveredOrderId(
  db: Database,
  repos: Repositories,
  params: {
    requestId: string;
    orderId: string;
    actor: AuditActor;
    timestamp: string;
  }
): void {
  runInTransaction(db, () => {
    const latest = repos.paymentRequests.getById(params.requestId);
    if (!latest || (latest.paypal_order_id && latest.paypal_order_id.trim())) {
      return;
    }

    repos.paymentRequests.updatePayPalIds(params.requestId, {
      orderId: params.orderId,
      updatedAt: params.timestamp,
    });

    writeAuditLogEntry(db, repos, {
      actor: params.actor,
      event: 'RECONCILE_RECOVERED_ORDER_ID',
      requestId: params.requestId,
      timestamp: params.timestamp,
      payload: {
        paypal_order_id: params.orderId,
        source: 'audit_log',
      },
    });
  });
}

interface ConcurrencyRaceCheckParams {
  readonly requestId: string;
  readonly observedOutcome: 'CAPTURED' | 'FAILED' | 'VOIDED';
  readonly orderId?: string | null;
  readonly authorizationId?: string | null;
  readonly captureId?: string | null;
  readonly actor?: AuditActor;
  readonly error?: unknown;
}

function handleConcurrentReconciliationRace(
  db: Database,
  repos: Repositories,
  params: ConcurrencyRaceCheckParams
): ReconcileRequestResult {
  const actor = params.actor ?? 'system';
  const nowIso = new Date().toISOString();

  // 1. Re-read payment from the database
  const latestReq = repos.paymentRequests.getById(params.requestId);
  if (!latestReq) {
    return {
      requestId: params.requestId,
      status: 'UNRESOLVED',
      actionTaken: 'NO_OP',
      reconciled: false,
      resolved: false,
      isUnresolved: true,
      reason: `Payment request not found on concurrency check: ${params.requestId}`,
      error: 'REQUEST_NOT_FOUND',
    };
  }

  // 2. Re-read ledger entries from the database
  const ledgerEntries = repos.ledger.listByRequestId(params.requestId);
  const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');
  const hasRelease = ledgerEntries.some((l) => l.kind === 'RELEASE');

  // 3. Confirm consistency against the observed remote outcome
  if (params.observedOutcome === 'CAPTURED') {
    // Consistent if database is CAPTURED, has a SPEND row, and no RELEASE row
    const isConsistent = latestReq.status === 'CAPTURED' && hasSpend && !hasRelease;

    if (isConsistent) {
      return {
        requestId: params.requestId,
        status: 'CAPTURED',
        requestStatus: 'CAPTURED',
        actionTaken: 'NO_OP',
        reconciled: true,
        resolved: true,
        isUnresolved: false,
        orderId: latestReq.paypal_order_id ?? params.orderId,
        authorizationId: latestReq.paypal_authorization_id ?? params.authorizationId,
        captureId: latestReq.paypal_capture_id ?? params.captureId,
        reason: 'Concurrent reconciliation race resolved: payment already in consistent CAPTURED state with SPEND ledger entry',
      };
    }

    // Never treat a conflicting terminal state as successful reconciliation
    writeAuditLogEntryIfChanged(db, repos, {
      actor,
      event: 'RECONCILIATION_INTEGRITY_MISMATCH',
      requestId: params.requestId,
      timestamp: nowIso,
      payload: {
        reason: 'CONCURRENCY_CONFLICT_CAPTURED_OBSERVED',
        observed_outcome: params.observedOutcome,
        database_status: latestReq.status,
        has_spend: hasSpend,
        has_release: hasRelease,
        error: params.error instanceof Error ? params.error.message : String(params.error),
      },
    });

    return {
      requestId: params.requestId,
      status: 'UNRESOLVED',
      requestStatus: latestReq.status as PaymentRequestStatus,
      actionTaken: 'NO_OP',
      reconciled: false,
      resolved: false,
      isUnresolved: true,
      orderId: latestReq.paypal_order_id ?? params.orderId,
      authorizationId: latestReq.paypal_authorization_id ?? params.authorizationId,
      captureId: latestReq.paypal_capture_id ?? params.captureId,
      reason: `CONCURRENCY_CONFLICT: Observed remote CAPTURED outcome conflicts with database status '${latestReq.status}' (hasSpend=${hasSpend}, hasRelease=${hasRelease})`,
      error: `CONCURRENCY_CONFLICT: Conflicting terminal state '${latestReq.status}' with remote CAPTURED`,
    };
  }

  // Observed outcome is FAILED or VOIDED
  // Consistent if database is FAILED or VOIDED, has RELEASE row, and no SPEND row
  const isConsistent =
    (latestReq.status === 'FAILED' || latestReq.status === 'VOIDED') &&
    hasRelease &&
    !hasSpend;

  if (isConsistent) {
    return {
      requestId: params.requestId,
      status: latestReq.status as PaymentRequestStatus,
      requestStatus: latestReq.status as PaymentRequestStatus,
      actionTaken: 'NO_OP',
      reconciled: true,
      resolved: true,
      isUnresolved: false,
      orderId: latestReq.paypal_order_id ?? params.orderId,
      authorizationId: latestReq.paypal_authorization_id ?? params.authorizationId,
      reason: `Concurrent reconciliation race resolved: payment already in consistent ${latestReq.status} state with RELEASE ledger entry`,
    };
  }

  // Never treat a conflicting terminal state as successful reconciliation
  writeAuditLogEntryIfChanged(db, repos, {
    actor,
    event: 'RECONCILIATION_INTEGRITY_MISMATCH',
    requestId: params.requestId,
    timestamp: nowIso,
    payload: {
      reason: 'CONCURRENCY_CONFLICT_VOID_OR_FAILED_OBSERVED',
      observed_outcome: params.observedOutcome,
      database_status: latestReq.status,
      has_spend: hasSpend,
      has_release: hasRelease,
      error: params.error instanceof Error ? params.error.message : String(params.error),
    },
  });

  return {
    requestId: params.requestId,
    status: 'UNRESOLVED',
    requestStatus: latestReq.status as PaymentRequestStatus,
    actionTaken: 'NO_OP',
    reconciled: false,
    resolved: false,
    isUnresolved: true,
    orderId: latestReq.paypal_order_id ?? params.orderId,
    authorizationId: latestReq.paypal_authorization_id ?? params.authorizationId,
    reason: `CONCURRENCY_CONFLICT: Observed remote ${params.observedOutcome} outcome conflicts with database status '${latestReq.status}' (hasSpend=${hasSpend}, hasRelease=${hasRelease})`,
    error: `CONCURRENCY_CONFLICT: Conflicting terminal state '${latestReq.status}' with remote ${params.observedOutcome}`,
  };
}

// ============================================================================
// Core Single Request Reconciliation
// ============================================================================

export async function reconcilePaymentRequest(
  dbOrParams: Database | { requestId: string },
  requestIdOrOptions?: string | ReconcileRequestOptions,
  maybeOptions?: ReconcileRequestOptions
): Promise<ReconcileRequestResult> {
  let db: Database;
  let requestId: string;
  let options: ReconcileRequestOptions;

  if (dbOrParams && typeof (dbOrParams as Database).prepare === 'function') {
    db = dbOrParams as Database;
    requestId = requestIdOrOptions as string;
    options = maybeOptions || {};
  } else {
    const params = dbOrParams as { requestId: string };
    requestId = params.requestId;
    options = (requestIdOrOptions as ReconcileRequestOptions) || {};
    if (!options.db) {
      throw new Error('Database instance must be provided in reconcile options or as first argument');
    }
    db = options.db;
  }

  // Safety Constraint: Reconciler must never be called inside an open SQLite transaction
  if (db.inTransaction) {
    throw new Error('reconcilePaymentRequest must not be called inside an open database transaction');
  }

  const repos = options.repos ?? createRepositories(db);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const actor = options.actor ?? 'system';
  const isProd = options.isProduction ?? process.env.NODE_ENV === 'production';
  const hasExplicitBaseUrl = 'publicBaseUrl' in options;
  const publicBaseUrl = hasExplicitBaseUrl
    ? sanitizePublicBaseUrl(options.publicBaseUrl, isProd)
    : isProd
      ? undefined
      : sanitizePublicBaseUrl(process.env.PUBLIC_BASE_URL, isProd);
  const urlOptions = { publicBaseUrl, isProduction: isProd };

  // 1. Fetch Request from repository
  const request = repos.paymentRequests.getById(requestId);
  if (!request) {
    return {
      requestId,
      status: 'UNRESOLVED',
      actionTaken: 'NO_OP',
      reconciled: false,
      resolved: false,
      isUnresolved: true,
      reason: `Payment request not found: ${requestId}`,
    };
  }

  const currentStatus = request.status as PaymentRequestStatus;

  // 2. Terminal state guard: Already finalized, no-op (unless remote void is still pending or failed)
  if (
    TERMINAL_STATUSES.has(currentStatus) &&
    request.remote_void_status !== 'PENDING' &&
    request.remote_void_status !== 'FAILED'
  ) {
    return {
      requestId,
      status: currentStatus,
      requestStatus: currentStatus,
      actionTaken: 'NO_OP',
      reconciled: true,
      resolved: true,
      isUnresolved: false,
      orderId: request.paypal_order_id,
      authorizationId: request.paypal_authorization_id,
      captureId: request.paypal_capture_id,
      reason: `Request is already in terminal state '${currentStatus}'`,
    };
  }

  if (currentStatus === 'RECEIVED') {
    return {
      requestId,
      status: currentStatus,
      requestStatus: currentStatus,
      actionTaken: 'NO_OP',
      reconciled: false,
      resolved: false,
      isUnresolved: true,
      reason: "Request is in 'RECEIVED' state; policy evaluation not completed",
    };
  }

  // ==========================================================================
  // Flow A: AUTO_EXECUTING Reconciliation
  // ==========================================================================
  if (currentStatus === 'AUTO_EXECUTING') {
    // Determine order ID: from request row or provisional record in audit log
    let orderId = sanitizeRecoveredOrderId(request.paypal_order_id);
    const recoveredFromAudit = !orderId;
    if (!orderId) {
      orderId = extractProvisionalOrderIdFromAudit(repos, requestId);
    }

    if (!orderId) {
      // Fail closed: Never guess IDs or create replacement orders
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'MISSING_REMOTE_ORDER_ID',
          status: currentStatus,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'Missing remote PayPal order ID; manual reconciliation required',
      };
    }

    // Persist recovered remote order ID before lookup or terminal transition
    if (recoveredFromAudit) {
      persistRecoveredOrderId(db, repos, {
        requestId,
        orderId,
        actor,
        timestamp: nowIso,
      });
    }

    if (!options.ordersService) {
      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        orderId,
        reason: 'PayPal ordersService not configured',
      };
    }

    let orderResult: PayPalOrderResult;
    try {
      // Read-only remote query outside DB transaction
      orderResult = await options.ordersService.getOrder(orderId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'REMOTE_ORDER_LOOKUP_FAILED',
          orderId,
          error: errMsg,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        orderId,
        reason: `Remote order lookup failed: ${errMsg}`,
      };
    }

    // Validate remote order (and capture monetary details if present) against persisted request
    const identityMatch = orderResult.id === orderId;
    const customIdMatch = !orderResult.customId || orderResult.customId === requestId;
    const amountMatch = orderResult.amountMinor === request.amount_minor;
    const currencyMatch = orderResult.currency === request.currency;
    const intentMatch = orderResult.intent === 'CAPTURE';
    const captureAmountMatch = !orderResult.capture || orderResult.capture.amountMinor === request.amount_minor;
    const captureCurrencyMatch = !orderResult.capture || orderResult.capture.currency === request.currency;

    if (
      !identityMatch ||
      !customIdMatch ||
      !amountMatch ||
      !currencyMatch ||
      !intentMatch ||
      !captureAmountMatch ||
      !captureCurrencyMatch
    ) {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_INTEGRITY_MISMATCH',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'ORDER_INTEGRITY_MISMATCH',
          expected: {
            orderId,
            requestId,
            amountMinor: request.amount_minor,
            currency: request.currency,
            intent: 'CAPTURE',
          },
          actual: {
            id: orderResult.id,
            customId: orderResult.customId,
            amountMinor: orderResult.amountMinor,
            currency: orderResult.currency,
            intent: orderResult.intent,
            captureAmountMinor: orderResult.capture?.amountMinor,
            captureCurrency: orderResult.capture?.currency,
          },
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        orderId,
        reason: 'Remote order integrity mismatch; values differ from persisted payment request',
      };
    }

    // Case A.1: Remote order is captured (COMPLETED with completed capture)
    if (orderResult.isCaptured && orderResult.capture && orderResult.capture.status === 'COMPLETED') {
      const captureId = orderResult.capture.id;

      try {
        return runInTransaction(db, () => {
          const ledgerEntries = repos.ledger.listByRequestId(requestId);
          const hasRelease = ledgerEntries.some((l) => l.kind === 'RELEASE');
          if (hasRelease) {
            throw new Error('Illegal ledger state: cannot record SPEND on request with existing RELEASE entry');
          }
          const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');

          let ledgerEntry: LedgerRow | undefined;
          if (!hasSpend) {
            ledgerEntry = {
              id: `led-${crypto.randomUUID()}`,
              request_id: requestId,
              kind: 'SPEND',
              amount_minor: request.amount_minor,
              currency: request.currency,
              created_at: nowIso,
            };
            repos.ledger.insert(ledgerEntry);
          }

          const { auditEntry } = transitionPaymentRequest(db, repos, {
            requestId,
            to: 'CAPTURED',
            actor,
            event: 'TRANSITION_TO_CAPTURED',
            paypalOrderId: orderResult.id,
            paypalCaptureId: captureId,
            timestamp: nowIso,
            payload: {
              reconciled: true,
              paypal_order_id: orderResult.id,
              paypal_capture_id: captureId,
              amount_minor: request.amount_minor.toString(),
              currency: request.currency,
            },
          });

          const vendor = repos.vendors.getById(request.vendor_id);
          const vendorName = vendor?.name ?? request.vendor_id;
          const capturedText = formatPaymentCapturedMessage({
            requestId,
            amountDecimal: formatMinorUnitsToDecimal(request.amount_minor),
            currency: request.currency,
            vendorName,
            purpose: request.purpose,
            captureId,
            ...urlOptions,
          });
          enqueuePaymentTerminalOutcome(repos, {
            eventType: 'PAYMENT_CAPTURED',
            requestId,
            dedupKey: `payment_captured:${requestId}`,
            messageText: capturedText,
          });

          return {
            requestId,
            status: 'CAPTURED',
            requestStatus: 'CAPTURED',
            actionTaken: 'CAPTURED',
            reconciled: true,
            resolved: true,
            isUnresolved: false,
            orderId: orderResult.id,
            captureId,
            ledgerEntry,
            auditEntry,
          };
        });
      } catch (err: unknown) {
        if (
          err instanceof IllegalStateTransitionError ||
          (err instanceof Error && err.message.includes('Illegal ledger state'))
        ) {
          return handleConcurrentReconciliationRace(db, repos, {
            requestId,
            observedOutcome: 'CAPTURED',
            orderId: orderResult.id,
            captureId,
            actor,
            error: err,
          });
        }
        throw err;
      }
    }

    // Case A.2: Remote order is conclusively voided without capture
    if (orderResult.status === 'VOIDED' && !orderResult.isCaptured && orderResult.capture === undefined) {
      try {
        return runInTransaction(db, () => {
          const ledgerEntries = repos.ledger.listByRequestId(requestId);
          const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');
          if (hasSpend) {
            throw new Error('Illegal ledger state: cannot release reservation on request with existing SPEND entry');
          }

          const hasRelease = ledgerEntries.some((l) => l.kind === 'RELEASE');
          let ledgerEntry: LedgerRow | undefined;
          if (!hasRelease) {
            ledgerEntry = {
              id: `led-${crypto.randomUUID()}`,
              request_id: requestId,
              kind: 'RELEASE',
              amount_minor: request.amount_minor,
              currency: request.currency,
              created_at: nowIso,
            };
            repos.ledger.insert(ledgerEntry);
          }

          const { auditEntry } = transitionPaymentRequest(db, repos, {
            requestId,
            to: 'FAILED',
            actor,
            event: 'TRANSITION_TO_FAILED',
            paypalOrderId: orderResult.id,
            timestamp: nowIso,
            payload: {
              reconciled: true,
              reason: 'Remote order was VOIDED without capture',
              paypal_order_id: orderResult.id,
            },
          });

          const vendor = repos.vendors.getById(request.vendor_id);
          const vendorName = vendor?.name ?? request.vendor_id;
          const failedText = formatPaymentFailedMessage({
            requestId,
            amountDecimal: formatMinorUnitsToDecimal(request.amount_minor),
            currency: request.currency,
            vendorName,
            reason: 'Remote order was VOIDED without capture',
            ...urlOptions,
          });
          enqueuePaymentTerminalOutcome(repos, {
            eventType: 'PAYMENT_FAILED',
            requestId,
            dedupKey: `payment_failed:${requestId}`,
            messageText: failedText,
          });

          return {
            requestId,
            status: 'FAILED',
            requestStatus: 'FAILED',
            actionTaken: 'FAILED',
            reconciled: true,
            resolved: true,
            isUnresolved: false,
            orderId: orderResult.id,
            ledgerEntry,
            auditEntry,
            reason: 'Remote order was VOIDED without capture',
          };
        });
      } catch (err: unknown) {
        if (
          err instanceof IllegalStateTransitionError ||
          (err instanceof Error && err.message.includes('Illegal ledger state'))
        ) {
          return handleConcurrentReconciliationRace(db, repos, {
            requestId,
            observedOutcome: 'FAILED',
            orderId: orderResult.id,
            actor,
            error: err,
          });
        }
        throw err;
      }
    }

    // Case A.3: Inconclusive status (CREATED, SAVED, PAYER_ACTION_REQUIRED, PENDING)
    writeAuditLogEntryIfChanged(db, repos, {
      actor,
      event: 'RECONCILIATION_UNRESOLVED',
      requestId,
      timestamp: nowIso,
      payload: {
        reason: 'INCONCLUSIVE_ORDER_STATUS',
        orderStatus: orderResult.status,
      },
    });

    return {
      requestId,
      status: 'UNRESOLVED',
      requestStatus: currentStatus,
      actionTaken: 'NO_OP',
      reconciled: false,
      resolved: false,
      isUnresolved: true,
      reason: `Order status '${orderResult.status}' is inconclusive for auto-executing request`,
    };
  }

  // ==========================================================================
  // Flow C: CAPTURING Reconciliation
  // ==========================================================================
  if (currentStatus === 'CAPTURING') {
    const authId = request.paypal_authorization_id?.trim();
    if (!authId) {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: { reason: 'MISSING_AUTHORIZATION_ID_IN_CAPTURING' },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'Missing paypal_authorization_id in CAPTURING request',
      };
    }

    if (!options.authorizationsService) {
      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'PayPal authorizationsService not configured',
      };
    }

    let authDetails: PayPalAuthorizationDetails;
    try {
      authDetails = await options.authorizationsService.getAuthorization(authId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'AUTHORIZATION_LOOKUP_FAILED',
          authId,
          error: errMsg,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Authorization lookup failed: ${errMsg}`,
      };
    }

    if (!authDetails) {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'AUTHORIZATION_LOOKUP_EMPTY',
          authId,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'Authorization lookup returned no details',
      };
    }

    // Exact Authorization Amount & Currency Validation
    const authIdMatch = authDetails.id === authId;
    const authAmountMatch = authDetails.amountMinor === request.amount_minor;
    const authCurrencyMatch = authDetails.currency === request.currency;

    if (!authIdMatch || !authAmountMatch || !authCurrencyMatch) {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_INTEGRITY_MISMATCH',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'AUTHORIZATION_AMOUNT_OR_CURRENCY_MISMATCH',
          expected: { authId, amountMinor: request.amount_minor, currency: request.currency },
          actual: { id: authDetails.id, amountMinor: authDetails.amountMinor, currency: authDetails.currency },
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'Authorization integrity mismatch: amount or currency differs from persisted request',
      };
    }

    // Case C.0: Remote authorization is PARTIALLY_CAPTURED -> fail closed without SPEND or RELEASE
    if (authDetails.status === 'PARTIALLY_CAPTURED' || authDetails.isPartiallyCaptured) {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'AUTHORIZATION_PARTIALLY_CAPTURED',
          authorizationStatus: authDetails.status,
          authorizationId: authId,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Authorization status is '${authDetails.status}' (partially captured); retaining CAPTURING and reservation pending manual reconciliation.`,
      };
    }

    // Case C.1: Remote authorization is CAPTURED
    if (authDetails.status === 'CAPTURED' && authDetails.isCaptured && !authDetails.isPartiallyCaptured) {
      try {
        return runInTransaction(db, () => {
          const ledgerEntries = repos.ledger.listByRequestId(requestId);
          const hasRelease = ledgerEntries.some((l) => l.kind === 'RELEASE');
          if (hasRelease) {
            throw new Error('Illegal ledger state: cannot record SPEND on request with existing RELEASE entry');
          }
          const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');

          let ledgerEntry: LedgerRow | undefined;
          if (!hasSpend) {
            ledgerEntry = {
              id: `led-${crypto.randomUUID()}`,
              request_id: requestId,
              kind: 'SPEND',
              amount_minor: request.amount_minor,
              currency: request.currency,
              created_at: nowIso,
            };
            repos.ledger.insert(ledgerEntry);
          }

          const { auditEntry } = transitionPaymentRequest(db, repos, {
            requestId,
            to: 'CAPTURED',
            actor,
            event: 'TRANSITION_TO_CAPTURED',
            paypalAuthorizationId: authId,
            timestamp: nowIso,
            payload: {
              reconciled: true,
              paypal_authorization_id: authId,
              status: 'CAPTURED',
            },
          });

          const vendor = repos.vendors.getById(request.vendor_id);
          const vendorName = vendor?.name ?? request.vendor_id;
          const capturedText = formatPaymentCapturedMessage({
            requestId,
            amountDecimal: formatMinorUnitsToDecimal(request.amount_minor),
            currency: request.currency,
            vendorName,
            purpose: request.purpose,
            captureId: request.paypal_capture_id ?? undefined,
            ...urlOptions,
          });
          enqueuePaymentTerminalOutcome(repos, {
            eventType: 'PAYMENT_CAPTURED',
            requestId,
            dedupKey: `payment_captured:${requestId}`,
            messageText: capturedText,
          });

          return {
            requestId,
            status: 'CAPTURED',
            requestStatus: 'CAPTURED',
            actionTaken: 'CAPTURED',
            reconciled: true,
            resolved: true,
            isUnresolved: false,
            authorizationId: authId,
            ledgerEntry,
            auditEntry,
          };
        });
      } catch (err: unknown) {
        if (
          err instanceof IllegalStateTransitionError ||
          (err instanceof Error && err.message.includes('Illegal ledger state'))
        ) {
          return handleConcurrentReconciliationRace(db, repos, {
            requestId,
            observedOutcome: 'CAPTURED',
            authorizationId: authId,
            actor,
            error: err,
          });
        }
        throw err;
      }
    }

    // Case C.2: Remote authorization is terminally closed without capture
    if (
      (authDetails.status === 'VOIDED' || authDetails.status === 'EXPIRED' || authDetails.status === 'DENIED') &&
      !authDetails.isCaptured &&
      !authDetails.isPartiallyCaptured
    ) {
      try {
        return runInTransaction(db, () => {
          const ledgerEntries = repos.ledger.listByRequestId(requestId);
          const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');
          if (hasSpend) {
            throw new Error('Illegal ledger state: cannot release reservation on request with existing SPEND entry');
          }

          const hasRelease = ledgerEntries.some((l) => l.kind === 'RELEASE');
          let ledgerEntry: LedgerRow | undefined;
          if (!hasRelease) {
            ledgerEntry = {
              id: `led-${crypto.randomUUID()}`,
              request_id: requestId,
              kind: 'RELEASE',
              amount_minor: request.amount_minor,
              currency: request.currency,
              created_at: nowIso,
            };
            repos.ledger.insert(ledgerEntry);
          }

          const { auditEntry } = transitionPaymentRequest(db, repos, {
            requestId,
            to: 'FAILED',
            actor,
            event: 'TRANSITION_TO_FAILED',
            paypalAuthorizationId: authId,
            timestamp: nowIso,
            payload: {
              reconciled: true,
              reason: `Remote authorization is ${authDetails.status}`,
              paypal_authorization_id: authId,
            },
          });

          const vendor = repos.vendors.getById(request.vendor_id);
          const vendorName = vendor?.name ?? request.vendor_id;
          const failedText = formatPaymentFailedMessage({
            requestId,
            amountDecimal: formatMinorUnitsToDecimal(request.amount_minor),
            currency: request.currency,
            vendorName,
            reason: `Remote authorization is ${authDetails.status}`,
            ...urlOptions,
          });
          enqueuePaymentTerminalOutcome(repos, {
            eventType: 'PAYMENT_FAILED',
            requestId,
            dedupKey: `payment_failed:${requestId}`,
            messageText: failedText,
          });

          return {
            requestId,
            status: 'FAILED',
            requestStatus: 'FAILED',
            actionTaken: 'FAILED',
            reconciled: true,
            resolved: true,
            isUnresolved: false,
            authorizationId: authId,
            ledgerEntry,
            auditEntry,
            reason: `Remote authorization is ${authDetails.status}`,
          };
        });
      } catch (err: unknown) {
        if (
          err instanceof IllegalStateTransitionError ||
          (err instanceof Error && err.message.includes('Illegal ledger state'))
        ) {
          return handleConcurrentReconciliationRace(db, repos, {
            requestId,
            observedOutcome: 'FAILED',
            authorizationId: authId,
            actor,
            error: err,
          });
        }
        throw err;
      }
    }

    // Case C.3: Remote authorization is PENDING (capture in review / pending settlement)
    if (authDetails.status === 'PENDING' || authDetails.isPending) {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'AUTHORIZATION_CAPTURE_PENDING',
          authorizationStatus: authDetails.status,
          authorizationId: authId,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Authorization status is '${authDetails.status}' (pending review or settlement); retaining CAPTURING and reservation.`,
      };
    }

    // Case C.4: Remote authorization is CREATED
    // Mandatory Safety Constraint: CREATED alone does not make a new capture safe.
    // An earlier ambiguous capture may still be in transit or processing at PayPal.
    // Retain CAPTURING, preserve reservation, and report UNRESOLVED.
    if (
      authDetails.status === 'CREATED' &&
      !authDetails.isCaptured &&
      !authDetails.isPartiallyCaptured &&
      !authDetails.isPending
    ) {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'AUTHORIZATION_HOLD_UNCAPTURED_IN_FLIGHT',
          authorizationStatus: authDetails.status,
          authorizationId: authId,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Authorization status is '${authDetails.status}'. Previous ambiguous capture attempt may still complete. Retaining CAPTURING and reservation.`,
      };
    }

    // Case C.5: Unexpected, ambiguous, or contradictory remote authorization status -> fail closed
    writeAuditLogEntryIfChanged(db, repos, {
      actor,
      event: 'RECONCILIATION_UNRESOLVED',
      requestId,
      timestamp: nowIso,
      payload: {
        reason: 'UNEXPECTED_REMOTE_AUTHORIZATION_STATUS',
        authorizationStatus: authDetails.status,
        authorizationId: authId,
        isCaptured: Boolean(authDetails.isCaptured),
        isPartiallyCaptured: Boolean(authDetails.isPartiallyCaptured),
      },
    });

    return {
      requestId,
      status: 'UNRESOLVED',
      requestStatus: currentStatus,
      actionTaken: 'NO_OP',
      reconciled: false,
      resolved: false,
      isUnresolved: true,
      reason: `Unexpected or ambiguous authorization status '${authDetails.status}'. Retaining CAPTURING and reservation.`,
    };
  }

  // ==========================================================================
  // Flow B: HELD Reconciliation
  // ==========================================================================
  if (currentStatus === 'HELD') {
    // Sub-path 1: Request already has paypal_authorization_id
    if (request.paypal_authorization_id) {
      const authId = request.paypal_authorization_id.trim();
      if (!options.authorizationsService) {
        return {
          requestId,
          status: 'UNRESOLVED',
          requestStatus: currentStatus,
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: 'PayPal authorizationsService not configured',
        };
      }

      let authDetails: PayPalAuthorizationDetails;
      try {
        authDetails = await options.authorizationsService.getAuthorization(authId);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'AUTHORIZATION_LOOKUP_FAILED',
            authId,
            error: errMsg,
          },
        });

        return {
          requestId,
          status: 'UNRESOLVED',
          requestStatus: currentStatus,
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: `Authorization lookup failed: ${errMsg}`,
        };
      }

      // Exact amount and currency validation
      if (authDetails.id !== authId || authDetails.amountMinor !== request.amount_minor || authDetails.currency !== request.currency) {
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_INTEGRITY_MISMATCH',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'AUTHORIZATION_AMOUNT_OR_CURRENCY_MISMATCH',
            expected: { authId, amountMinor: request.amount_minor, currency: request.currency },
            actual: { id: authDetails.id, amountMinor: authDetails.amountMinor, currency: authDetails.currency },
          },
        });

        return {
          requestId,
          status: 'UNRESOLVED',
          requestStatus: currentStatus,
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: 'Authorization integrity mismatch for HELD request',
        };
      }

      // Case B.1.1: Healthy active hold awaiting owner action
      if (
        authDetails.status === 'CREATED' &&
        Boolean(authDetails.isCapturable) &&
        !authDetails.isCaptured &&
        !authDetails.isPartiallyCaptured &&
        !authDetails.isPending
      ) {
        return {
          requestId,
          status: 'HELD',
          requestStatus: 'HELD',
          actionTaken: 'NO_OP',
          reconciled: true,
          resolved: true,
          isUnresolved: false,
          authorizationId: authId,
          orderId: request.paypal_order_id,
          reason: 'Authorization hold is active (CREATED) and awaiting owner review',
        };
      }

      // Case B.1.2: Terminal voided/expired/denied hold
      if (
        (authDetails.status === 'VOIDED' || authDetails.status === 'EXPIRED' || authDetails.status === 'DENIED') &&
        !authDetails.isCaptured &&
        !authDetails.isPartiallyCaptured
      ) {
        const targetStatus = authDetails.status === 'VOIDED' ? 'VOIDED' : 'FAILED';
        try {
          return runInTransaction(db, () => {
            const ledgerEntries = repos.ledger.listByRequestId(requestId);
            const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');
            if (hasSpend) {
              throw new Error('Illegal ledger state: cannot release reservation on request with existing SPEND entry');
            }

            const hasRelease = ledgerEntries.some((l) => l.kind === 'RELEASE');
            let ledgerEntry: LedgerRow | undefined;
            if (!hasRelease) {
              ledgerEntry = {
                id: `led-${crypto.randomUUID()}`,
                request_id: requestId,
                kind: 'RELEASE',
                amount_minor: request.amount_minor,
                currency: request.currency,
                created_at: nowIso,
              };
              repos.ledger.insert(ledgerEntry);
            }

            const { auditEntry } = transitionPaymentRequest(db, repos, {
              requestId,
              to: targetStatus,
              actor,
              event: targetStatus === 'VOIDED' ? 'TRANSITION_TO_VOIDED' : 'TRANSITION_TO_FAILED',
              paypalAuthorizationId: authId,
              timestamp: nowIso,
              payload: {
                reconciled: true,
                reason: `Authorization is ${authDetails.status}`,
                paypal_authorization_id: authId,
              },
            });

            const vendor = repos.vendors.getById(request.vendor_id);
            const vendorName = vendor?.name ?? request.vendor_id;
            if (targetStatus === 'VOIDED') {
              recoverVoidNotification(repos, {
                requestId,
                amountMinor: request.amount_minor,
                currency: request.currency,
                vendorId: request.vendor_id,
                remoteVoidStatus: 'CONFIRMED',
                reason: `Authorization is ${authDetails.status}`,
                ...urlOptions,
              });
            } else {
              const failedText = formatPaymentFailedMessage({
                requestId,
                amountDecimal: formatMinorUnitsToDecimal(request.amount_minor),
                currency: request.currency,
                vendorName,
                reason: `Authorization is ${authDetails.status}`,
                ...urlOptions,
              });
              enqueuePaymentTerminalOutcome(repos, {
                eventType: 'PAYMENT_FAILED',
                requestId,
                dedupKey: `payment_failed:${requestId}`,
                messageText: failedText,
              });
            }

            return {
              requestId,
              status: targetStatus,
              requestStatus: targetStatus,
              actionTaken: targetStatus === 'VOIDED' ? 'VOIDED' : 'FAILED',
              reconciled: true,
              resolved: true,
              isUnresolved: false,
              authorizationId: authId,
              ledgerEntry,
              auditEntry,
              reason: `Remote authorization is ${authDetails.status}`,
            };
          });
        } catch (err: unknown) {
          if (
            err instanceof IllegalStateTransitionError ||
            (err instanceof Error && err.message.includes('Illegal ledger state'))
          ) {
            return handleConcurrentReconciliationRace(db, repos, {
              requestId,
              observedOutcome: targetStatus,
              authorizationId: authId,
              actor,
              error: err,
            });
          }
          throw err;
        }
      }

      // Case B.1.3: Authorization is PARTIALLY_CAPTURED while request is HELD
      if (authDetails.status === 'PARTIALLY_CAPTURED' || authDetails.isPartiallyCaptured) {
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'AUTHORIZATION_PARTIALLY_CAPTURED_WHILE_HELD',
            authorizationStatus: authDetails.status,
            authorizationId: authId,
          },
        });

        return {
          requestId,
          status: 'UNRESOLVED',
          requestStatus: currentStatus,
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: 'Remote authorization is PARTIALLY_CAPTURED while local request is HELD; preserving reservation for manual reconciliation',
        };
      }

      // Case B.1.4: Authorization is PENDING while request is HELD
      if (authDetails.status === 'PENDING' || authDetails.isPending) {
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'AUTHORIZATION_PENDING_REVIEW_WHILE_HELD',
            authorizationStatus: authDetails.status,
            authorizationId: authId,
          },
        });

        return {
          requestId,
          status: 'UNRESOLVED',
          requestStatus: currentStatus,
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: 'Remote authorization is PENDING while local request is HELD; requires reconciliation',
        };
      }

      // Case B.1.5: Authorization already CAPTURED while request is HELD
      // Fails closed: HELD cannot legally transition to CAPTURED
      if (authDetails.status === 'CAPTURED' || authDetails.isCaptured) {
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'AUTHORIZATION_ALREADY_CAPTURED_WHILE_HELD',
            authorizationStatus: authDetails.status,
            authorizationId: authId,
          },
        });

        return {
          requestId,
          status: 'UNRESOLVED',
          requestStatus: currentStatus,
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: 'Remote authorization is already CAPTURED while local request is HELD; requires manual reconciliation',
        };
      }

      // Case B.1.6: Unexpected, non-capturable CREATED, or contradictory authorization state -> fail closed
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'UNEXPECTED_REMOTE_AUTHORIZATION_STATUS',
          authorizationStatus: authDetails.status,
          authorizationId: authId,
          isCapturable: Boolean(authDetails.isCapturable),
          isCaptured: Boolean(authDetails.isCaptured),
          isPartiallyCaptured: Boolean(authDetails.isPartiallyCaptured),
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Unexpected or ambiguous remote authorization status '${authDetails.status}' while HELD; preserving reservation`,
      };
    }

    // Sub-path 2: Request is missing paypal_authorization_id
    // Precondition: Must have a persisted or audit-recovered order ID
    let orderId = sanitizeRecoveredOrderId(request.paypal_order_id);
    const recoveredFromAudit = !orderId;
    if (!orderId) {
      orderId = extractProvisionalOrderIdFromAudit(repos, requestId);
    }
    if (!orderId) {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'MISSING_PERSISTED_ORDER_ID',
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'Missing persisted PayPal order ID for HELD request',
      };
    }

    // Persist recovered remote order ID before lookup or terminal transition
    if (recoveredFromAudit) {
      persistRecoveredOrderId(db, repos, {
        requestId,
        orderId,
        actor,
        timestamp: nowIso,
      });
    }

    if (!options.ordersService) {
      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        orderId,
        reason: 'PayPal ordersService not configured',
      };
    }

    let orderResult: PayPalOrderResult;
    try {
      orderResult = await options.ordersService.getOrder(orderId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'REMOTE_ORDER_LOOKUP_FAILED',
          orderId,
          error: errMsg,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        orderId,
        reason: `Remote order lookup failed: ${errMsg}`,
      };
    }

    // Authoritative Remote Order Validation (including authorization monetary match)
    const idMatch = orderResult.id === orderId;
    const customIdMatch = !orderResult.customId || orderResult.customId === requestId;
    const amountMatch = orderResult.amountMinor === request.amount_minor;
    const currencyMatch = orderResult.currency === request.currency;
    const intentMatch = orderResult.intent === 'AUTHORIZE';
    const authSummary = orderResult.authorization;
    const authIdPresent = Boolean(authSummary?.id && authSummary.id.trim());
    const authAmountMatch = Boolean(authSummary && authSummary.amountMinor === request.amount_minor);
    const authCurrencyMatch = Boolean(authSummary && authSummary.currency === request.currency);

    if (
      !idMatch ||
      !customIdMatch ||
      !amountMatch ||
      !currencyMatch ||
      !intentMatch ||
      !authIdPresent ||
      !authAmountMatch ||
      !authCurrencyMatch
    ) {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_INTEGRITY_MISMATCH',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'INCOMPLETE_OR_MISMATCHED_REMOTE_AUTHORIZATION_EVIDENCE',
          expected: { orderId, requestId, amountMinor: request.amount_minor, currency: request.currency, intent: 'AUTHORIZE' },
          actual: {
            id: orderResult.id,
            customId: orderResult.customId,
            amountMinor: orderResult.amountMinor,
            currency: orderResult.currency,
            intent: orderResult.intent,
            authorizationId: authSummary?.id,
            authorizationAmountMinor: authSummary?.amountMinor,
            authorizationCurrency: authSummary?.currency,
          },
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        orderId,
        reason: 'Incomplete or mismatched authorization evidence in remote order',
      };
    }

    const discoveredAuthId = authSummary!.id.trim();

    // Case B.2.1: Active uncaptured hold (CREATED)
    if (authSummary!.status === 'CREATED' && !orderResult.isCaptured && orderResult.capture === undefined) {
      return runInTransaction(db, () => {
        repos.paymentRequests.updatePayPalIds(requestId, {
          orderId: orderResult.id,
          authorizationId: discoveredAuthId,
          updatedAt: nowIso,
        });

        const auditEntry = writeAuditLogEntry(db, repos, {
          actor,
          event: 'RECONCILE_LINKED_AUTHORIZATION',
          requestId,
          timestamp: nowIso,
          payload: {
            paypal_order_id: orderResult.id,
            paypal_authorization_id: discoveredAuthId,
            status: 'HELD',
          },
        });

        return {
          requestId,
          status: 'HELD',
          requestStatus: 'HELD',
          actionTaken: 'REPAIRED_HOLD_ID',
          reconciled: true,
          resolved: true,
          isUnresolved: false,
          orderId: orderResult.id,
          authorizationId: discoveredAuthId,
          auditEntry,
          reason: 'Successfully linked active PayPal authorization ID to HELD request',
        };
      });
    }

    // Case B.2.2: Terminal authorization on order (VOIDED, EXPIRED, DENIED)
    // Mandatory Safety Constraint: Dual-attestation required before releasing reservation.
    if (authSummary!.status === 'VOIDED' || authSummary!.status === 'EXPIRED' || authSummary!.status === 'DENIED') {
      // 1. Order Attestation: Order must have zero captures
      if (orderResult.capture !== undefined || orderResult.isCaptured) {
        // Contradictory evidence: order reports voided auth but has capture!
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'CONTRADICTORY_CAPTURE_EVIDENCE',
            orderCapture: orderResult.capture,
            orderAuthStatus: authSummary!.status,
          },
        });

        return {
          requestId,
          status: 'UNRESOLVED',
          requestStatus: currentStatus,
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: 'Contradictory capture evidence: order reports terminal authorization but has capture details',
        };
      }

      // 2. Direct Authorization Attestation: Query authorization directly
      if (!options.authorizationsService) {
        return {
          requestId,
          status: 'UNRESOLVED',
          requestStatus: currentStatus,
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: 'authorizationsService required for dual-attestation on terminal authorization recovery',
        };
      }

      let directAuth: PayPalAuthorizationDetails;
      try {
        directAuth = await options.authorizationsService.getAuthorization(discoveredAuthId);
      } catch (err: unknown) {
        // Missing capture evidence: direct auth check failed
        const errMsg = err instanceof Error ? err.message : String(err);
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'MISSING_CAPTURE_EVIDENCE',
            discoveredAuthId,
            error: errMsg,
          },
        });

        return {
          requestId,
          status: 'UNRESOLVED',
          requestStatus: currentStatus,
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: `Missing capture evidence: direct authorization lookup failed: ${errMsg}`,
        };
      }

      // Validate direct authorization details
      const directIdMatch = directAuth.id === discoveredAuthId;
      const directAmountMatch = directAuth.amountMinor === request.amount_minor;
      const directCurrencyMatch = directAuth.currency === request.currency;
      const directNegativeCapture = !directAuth.isCaptured && !directAuth.isPartiallyCaptured;
      const directTerminalStatus =
        directAuth.status === 'VOIDED' || directAuth.status === 'EXPIRED' || directAuth.status === 'DENIED';

      if (!directIdMatch || !directAmountMatch || !directCurrencyMatch || !directNegativeCapture || !directTerminalStatus) {
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'CONTRADICTORY_CAPTURE_EVIDENCE',
            directAuthStatus: directAuth.status,
            isCaptured: directAuth.isCaptured,
            isPartiallyCaptured: directAuth.isPartiallyCaptured,
          },
        });

        return {
          requestId,
          status: 'UNRESOLVED',
          requestStatus: currentStatus,
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: 'Contradictory capture evidence during dual-attestation authorization lookup',
        };
      }

      // Dual-attestation confirmed! Safe to release reservation and transition
      const targetStatus = directAuth.status === 'VOIDED' ? 'VOIDED' : 'FAILED';
      try {
        return runInTransaction(db, () => {
          const ledgerEntries = repos.ledger.listByRequestId(requestId);
          const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');
          if (hasSpend) {
            throw new Error('Illegal ledger state: cannot release reservation on request with existing SPEND entry');
          }

          const hasRelease = ledgerEntries.some((l) => l.kind === 'RELEASE');
          let ledgerEntry: LedgerRow | undefined;
          if (!hasRelease) {
            ledgerEntry = {
              id: `led-${crypto.randomUUID()}`,
              request_id: requestId,
              kind: 'RELEASE',
              amount_minor: request.amount_minor,
              currency: request.currency,
              created_at: nowIso,
            };
            repos.ledger.insert(ledgerEntry);
          }

          const { auditEntry } = transitionPaymentRequest(db, repos, {
            requestId,
            to: targetStatus,
            actor,
            event: targetStatus === 'VOIDED' ? 'TRANSITION_TO_VOIDED' : 'TRANSITION_TO_FAILED',
            paypalOrderId: orderResult.id,
            paypalAuthorizationId: discoveredAuthId,
            timestamp: nowIso,
            payload: {
              reconciled: true,
              reason: `Dual-attestation confirmed authorization is ${directAuth.status} without capture`,
              paypal_order_id: orderResult.id,
              paypal_authorization_id: discoveredAuthId,
            },
          });

          const vendor = repos.vendors.getById(request.vendor_id);
          const vendorName = vendor?.name ?? request.vendor_id;
          if (targetStatus === 'VOIDED') {
            recoverVoidNotification(repos, {
              requestId,
              amountMinor: request.amount_minor,
              currency: request.currency,
              vendorId: request.vendor_id,
              remoteVoidStatus: 'CONFIRMED',
              reason: `Dual-attestation confirmed authorization is ${directAuth.status} without capture`,
              ...urlOptions,
            });
          } else {
            const failedText = formatPaymentFailedMessage({
              requestId,
              amountDecimal: formatMinorUnitsToDecimal(request.amount_minor),
              currency: request.currency,
              vendorName,
              reason: `Dual-attestation confirmed authorization is ${directAuth.status} without capture`,
              ...urlOptions,
            });
            enqueuePaymentTerminalOutcome(repos, {
              eventType: 'PAYMENT_FAILED',
              requestId,
              dedupKey: `payment_failed:${requestId}`,
              messageText: failedText,
            });
          }

          return {
            requestId,
            status: targetStatus,
            requestStatus: targetStatus,
            actionTaken: targetStatus === 'VOIDED' ? 'VOIDED' : 'FAILED',
            reconciled: true,
            resolved: true,
            isUnresolved: false,
            orderId: orderResult.id,
            authorizationId: discoveredAuthId,
            ledgerEntry,
            auditEntry,
            reason: `Dual-attestation confirmed authorization is ${directAuth.status} without capture`,
          };
        });
      } catch (err: unknown) {
        if (
          err instanceof IllegalStateTransitionError ||
          (err instanceof Error && err.message.includes('Illegal ledger state'))
        ) {
          return handleConcurrentReconciliationRace(db, repos, {
            requestId,
            observedOutcome: targetStatus,
            orderId: orderResult.id,
            authorizationId: discoveredAuthId,
            actor,
            error: err,
          });
        }
        throw err;
      }
    }

    // Case B.2.3: PARTIALLY_CAPTURED authorization in remote order
    if (authSummary!.status === 'PARTIALLY_CAPTURED') {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'AUTHORIZATION_PARTIALLY_CAPTURED_WHILE_HELD',
          paypal_order_id: orderResult.id,
          discoveredAuthId,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'Remote authorization is PARTIALLY_CAPTURED while local request is HELD; requires manual reconciliation',
      };
    }

    // Case B.2.4: PENDING authorization in remote order
    if (authSummary!.status === 'PENDING') {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'AUTHORIZATION_PENDING_REVIEW_WHILE_HELD',
          paypal_order_id: orderResult.id,
          discoveredAuthId,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'Remote authorization is PENDING while local request is HELD; requires reconciliation',
      };
    }

    // Case B.2.5: Already CAPTURED authorization in remote order
    if (authSummary!.status === 'CAPTURED') {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'AUTHORIZATION_ALREADY_CAPTURED_WHILE_HELD',
          paypal_order_id: orderResult.id,
          discoveredAuthId,
        },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'Remote authorization is already CAPTURED while local request is HELD; requires manual reconciliation',
      };
    }

    // Case B.2.6: Unexpected or unverified status
    writeAuditLogEntryIfChanged(db, repos, {
      actor,
      event: 'RECONCILIATION_UNRESOLVED',
      requestId,
      timestamp: nowIso,
      payload: {
        reason: 'UNEXPECTED_REMOTE_AUTHORIZATION_STATUS',
        remoteStatus: authSummary!.status,
      },
    });

    return {
      requestId,
      status: 'UNRESOLVED',
      requestStatus: currentStatus,
      actionTaken: 'NO_OP',
      reconciled: false,
      resolved: false,
      isUnresolved: true,
      reason: `Unexpected remote authorization status '${authSummary!.status}'`,
    };
  }

  // ==========================================================================
  // Flow C / Recovery: APPROVED Reconciliation (Orphaned approval crash recovery)
  // ==========================================================================
  if (currentStatus === 'APPROVED') {
    const authId = request.paypal_authorization_id?.trim();
    const expiresAt = request.expires_at ? new Date(request.expires_at).getTime() : 0;
    const nowTime = now.getTime();

    // Refinement 4: If hold expired while in APPROVED state
    if (expiresAt > 0 && nowTime > expiresAt) {
      // Expired! Never capture. Safely transition into terminal non-capturable state (FAILED).
      // Release the reservation exactly once.
      // Attempt remote authorization cancellation if authorization exists (outside DB transaction).
      let terminalResult: { ledgerEntry?: LedgerRow; auditEntry?: AuditLogRow; initialRemoteVoidStatus: string };
      try {
        terminalResult = runInTransaction(db, () => {
          const ledgerEntries = repos.ledger.listByRequestId(requestId);
          const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');
          if (hasSpend) {
            throw new Error('Illegal ledger state: cannot fail request with existing SPEND entry');
          }

          const hasRelease = ledgerEntries.some((l) => l.kind === 'RELEASE');
          let ledgerEntry: LedgerRow | undefined;
          if (!hasRelease) {
            ledgerEntry = {
              id: `led-${crypto.randomUUID()}`,
              request_id: requestId,
              kind: 'RELEASE',
              amount_minor: request.amount_minor,
              currency: request.currency,
              created_at: nowIso,
            };
            repos.ledger.insert(ledgerEntry);
          }

          const initialRemoteVoidStatus = authId ? 'PENDING' : 'FAILED';
          const { auditEntry } = transitionPaymentRequest(db, repos, {
            requestId,
            to: 'FAILED',
            actor,
            event: 'TRANSITION_TO_FAILED',
            timestamp: nowIso,
            payload: {
              reconciled: true,
              reason: 'Hold expired while request was in APPROVED state (process crash recovery)',
              remote_void_status: initialRemoteVoidStatus,
            },
          });

          repos.paymentRequests.updateRemoteVoidStatus(requestId, initialRemoteVoidStatus, nowIso);

          const vendor = repos.vendors.getById(request.vendor_id);
          const vendorName = vendor?.name ?? request.vendor_id;
          const failedText = formatPaymentFailedMessage({
            requestId,
            amountDecimal: formatMinorUnitsToDecimal(request.amount_minor),
            currency: request.currency,
            vendorName,
            reason: 'Hold expired while request was in APPROVED state (process crash recovery)',
            ...urlOptions,
          });
          enqueuePaymentTerminalOutcome(repos, {
            eventType: 'PAYMENT_FAILED',
            requestId,
            dedupKey: `payment_failed:${requestId}`,
            messageText: failedText,
          });

          return { ledgerEntry, auditEntry, initialRemoteVoidStatus };
        });
      } catch (err: unknown) {
        if (
          err instanceof IllegalStateTransitionError ||
          (err instanceof Error && err.message.includes('Illegal ledger state'))
        ) {
          return handleConcurrentReconciliationRace(db, repos, {
            requestId,
            observedOutcome: 'FAILED',
            authorizationId: authId,
            actor,
            error: err,
          });
        }
        throw err;
      }

      if (authId && options.authorizationsService) {
        let voidRes: Awaited<ReturnType<PayPalAuthorizationsService['voidAuthorization']>> | undefined;
        let voidError: unknown;
        try {
          voidRes = await options.authorizationsService.voidAuthorization({
            authorizationId: authId,
            requestId,
          });
        } catch (err: unknown) {
          voidError = err;
        }

        if (voidRes !== undefined) {
          if (voidRes.isVoided) {
            runInTransaction(db, () => {
              const latest = repos.paymentRequests.getById(requestId);
              if (latest && latest.remote_void_status === 'CONFIRMED') {
                return;
              }
              repos.paymentRequests.updateRemoteVoidStatus(requestId, 'CONFIRMED', nowIso);
              writeAuditLogEntry(db, repos, {
                actor,
                event: 'PAYPAL_VOID_CONFIRMED',
                requestId,
                timestamp: nowIso,
                payload: { authorizationId: authId, reason: 'Voided expired authorization after crash recovery' },
              });
              recoverVoidNotification(repos, {
                requestId,
                amountMinor: request.amount_minor,
                currency: request.currency,
                vendorId: request.vendor_id,
                remoteVoidStatus: 'CONFIRMED',
                reason: 'Voided expired authorization after crash recovery',
                ...urlOptions,
              });
            });
          } else {
            runInTransaction(db, () => {
              const latest = repos.paymentRequests.getById(requestId);
              if (!latest || latest.remote_void_status !== 'PENDING') {
                return;
              }
              writeAuditLogEntryIfChanged(db, repos, {
                actor,
                event: 'PAYPAL_VOID_PENDING_RETRY',
                requestId,
                timestamp: nowIso,
                payload: {
                  error: 'PayPal voidAuthorization returned unconfirmed status',
                  authorizationId: authId,
                  remote_void_status: 'PENDING',
                },
              });
            });
          }
        } else {
          const errMsg = voidError instanceof Error ? voidError.message : String(voidError);
          const isDefinitive =
            voidError instanceof AuthorizationError &&
            (voidError.code === 'INVALID_REQUEST' || voidError.code === 'DECLINED');

          if (isDefinitive) {
            runInTransaction(db, () => {
              const latest = repos.paymentRequests.getById(requestId);
              if (!latest || latest.remote_void_status === 'CONFIRMED' || latest.remote_void_status === 'FAILED') {
                return;
              }
              repos.paymentRequests.updateRemoteVoidStatus(requestId, 'FAILED', nowIso);
              writeAuditLogEntry(db, repos, {
                actor,
                event: 'PAYPAL_VOID_FAILED',
                requestId,
                timestamp: nowIso,
                payload: {
                  error: errMsg,
                  authorizationId: authId,
                  remote_void_status: 'FAILED',
                },
              });
            });
          } else {
            runInTransaction(db, () => {
              const latest = repos.paymentRequests.getById(requestId);
              if (!latest || latest.remote_void_status !== 'PENDING') {
                return;
              }
              writeAuditLogEntryIfChanged(db, repos, {
                actor,
                event: 'PAYPAL_VOID_PENDING_RETRY',
                requestId,
                timestamp: nowIso,
                payload: {
                  error: errMsg,
                  authorizationId: authId,
                  remote_void_status: 'PENDING',
                },
              });
            });
          }
        }
      }

      const finalReq = repos.paymentRequests.getById(requestId)!;
      return {
        requestId,
        status: 'FAILED',
        requestStatus: 'FAILED',
        actionTaken: 'FAILED',
        reconciled: true,
        resolved: finalReq.remote_void_status === 'CONFIRMED',
        isUnresolved: finalReq.remote_void_status !== 'CONFIRMED',
        authorizationId: authId,
        ledgerEntry: terminalResult.ledgerEntry,
        auditEntry: terminalResult.auditEntry,
        reason: 'Hold expired while request was in APPROVED state; transitioned to FAILED and released reservation',
      };
    }

    // Unexpired APPROVED request: Recover through executeDecision() Flow C!
    try {
      const execution = await executeDecision(
        { requestId },
        {
          db,
          repos,
          authorizationsService: options.authorizationsService,
          ordersService: options.ordersService,
          actor,
          now,
          ...urlOptions,
        }
      );

      const resolved = execution.status === 'CAPTURED' || execution.status === 'FAILED';
      return {
        requestId,
        status: execution.status,
        requestStatus: execution.status,
        actionTaken: execution.executedAction as ReconcileActionTaken,
        reconciled: resolved,
        resolved,
        isUnresolved: !resolved,
        authorizationId: execution.authorizationId,
        captureId: execution.captureId,
        ledgerEntry: execution.ledgerEntry,
        auditEntry: execution.auditEntry,
      };
    } catch (err: unknown) {
      if (err instanceof AmbiguousExecutionError) {
        return {
          requestId,
          status: 'CAPTURING',
          requestStatus: 'CAPTURING',
          actionTaken: 'NO_OP',
          reconciled: false,
          resolved: false,
          isUnresolved: true,
          reason: `Execution ambiguous: ${err.message}`,
        };
      }

      if (
        err instanceof IllegalStateTransitionError ||
        (err instanceof Error && err.message.includes('Illegal ledger state'))
      ) {
        const latestReq = repos.paymentRequests.getById(requestId);
        if (latestReq && TERMINAL_STATUSES.has(latestReq.status as PaymentRequestStatus)) {
          const ledgerEntries = repos.ledger.listByRequestId(requestId);
          const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');
          const hasRelease = ledgerEntries.some((l) => l.kind === 'RELEASE');

          if (latestReq.status === 'CAPTURED' && hasSpend && !hasRelease) {
            return {
              requestId,
              status: 'CAPTURED',
              requestStatus: 'CAPTURED',
              actionTaken: 'NO_OP',
              reconciled: true,
              resolved: true,
              isUnresolved: false,
              authorizationId: latestReq.paypal_authorization_id,
              captureId: latestReq.paypal_capture_id,
              reason: 'Concurrent execution race resolved: payment already in consistent CAPTURED state',
            };
          }

          if (latestReq.status === 'FAILED' && hasRelease && !hasSpend) {
            return {
              requestId,
              status: 'FAILED',
              requestStatus: 'FAILED',
              actionTaken: 'NO_OP',
              reconciled: true,
              resolved: true,
              isUnresolved: false,
              authorizationId: latestReq.paypal_authorization_id,
              reason: 'Concurrent execution race resolved: payment already in consistent FAILED state',
            };
          }
        }
      }

      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: { error: err instanceof Error ? err.message : String(err), status: currentStatus },
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Recovery execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ==========================================================================
  // Flow D: Remote Void Reconciliation (PENDING or FAILED remote_void_status)
  // ==========================================================================
  if (
    (currentStatus === 'VOIDED' || currentStatus === 'FAILED') &&
    (request.remote_void_status === 'PENDING' || request.remote_void_status === 'FAILED')
  ) {
    const authId = request.paypal_authorization_id?.trim();
    if (!authId) {
      runInTransaction(db, () => {
        const latest = repos.paymentRequests.getById(requestId);
        if (latest && latest.remote_void_status !== 'FAILED') {
          repos.paymentRequests.updateRemoteVoidStatus(requestId, 'FAILED', nowIso);
        }

        if ((latest?.status ?? currentStatus) === 'VOIDED') {
          recoverVoidNotification(repos, {
            requestId,
            amountMinor: request.amount_minor,
            currency: request.currency,
            vendorId: request.vendor_id,
            remoteVoidStatus: 'FAILED',
            reason: 'Cannot cancel remote authorization: request is missing paypal_authorization_id',
            ...urlOptions,
          });
        }

        // Check whether this unresolved condition has already been logged to prevent
        // duplicate audit events on every reconciliation cycle.
        const existingLogs = repos.auditLog.listByRequestId(requestId);
        const alreadyLogged = existingLogs.some(
          (log) => log.event === 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID'
        );

        if (!alreadyLogged) {
          writeAuditLogEntry(db, repos, {
            actor,
            event: 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID',
            requestId,
            timestamp: nowIso,
            payload: {
              reason: 'Cannot cancel remote authorization: request is missing paypal_authorization_id',
              remote_void_status: 'FAILED',
            },
          });
        }
      });

      return {
        requestId,
        status: currentStatus,
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'Cannot cancel remote authorization: request is missing paypal_authorization_id',
      };
    }

    if (!options.authorizationsService) {
      if (currentStatus === 'VOIDED' && request.remote_void_status === 'FAILED') {
        runInTransaction(db, () => {
          recoverVoidNotification(repos, {
            requestId,
            amountMinor: request.amount_minor,
            currency: request.currency,
            vendorId: request.vendor_id,
            remoteVoidStatus: 'FAILED',
            reason: 'PayPal authorizationsService not configured for remote void reconciliation',
            ...urlOptions,
          });
        });
      }

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'PayPal authorizationsService not configured for remote void reconciliation',
      };
    }

    // Inspect remote authorization status first (outside DB transaction)
    let authDetails: PayPalAuthorizationDetails | undefined;
    try {
      authDetails = await options.authorizationsService.getAuthorization(authId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      runInTransaction(db, () => {
        const latest = repos.paymentRequests.getById(requestId);
        if ((latest?.status ?? currentStatus) === 'VOIDED' && latest?.remote_void_status === 'FAILED') {
          recoverVoidNotification(repos, {
            requestId,
            amountMinor: request.amount_minor,
            currency: request.currency,
            vendorId: request.vendor_id,
            remoteVoidStatus: 'FAILED',
            reason: `Remote authorization lookup failed: ${errMsg}`,
            ...urlOptions,
          });
        }

        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'REMOTE_AUTHORIZATION_LOOKUP_FAILED',
            authorizationId: authId,
            error: errMsg,
          },
        });
      });

      return {
        requestId,
        status: currentStatus,
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Remote authorization lookup failed: ${errMsg}`,
      };
    }

    // Treat an already-VOIDED or EXPIRED remote authorization (without capture) as successfully reconciled!
    if (
      (authDetails.status === 'VOIDED' || authDetails.status === 'EXPIRED') &&
      !authDetails.isCaptured &&
      !authDetails.isPartiallyCaptured
    ) {
      const auditEntry = runInTransaction(db, () => {
        const latest = repos.paymentRequests.getById(requestId);
        if (latest && latest.remote_void_status === 'CONFIRMED') {
          return undefined;
        }
        repos.paymentRequests.updateRemoteVoidStatus(requestId, 'CONFIRMED', nowIso);
        if ((latest?.status ?? currentStatus) === 'VOIDED') {
          recoverVoidNotification(repos, {
            requestId,
            amountMinor: request.amount_minor,
            currency: request.currency,
            vendorId: request.vendor_id,
            remoteVoidStatus: 'CONFIRMED',
            ...urlOptions,
          });
        }

        return writeAuditLogEntry(db, repos, {
          actor,
          event: 'PAYPAL_VOID_RECONCILED',
          requestId,
          timestamp: nowIso,
          payload: {
            authorizationId: authId,
            remote_status: authDetails.status,
            remote_void_status: 'CONFIRMED',
          },
        });
      });

      return {
        requestId,
        status: currentStatus,
        requestStatus: currentStatus,
        actionTaken: auditEntry ? 'VOIDED' : 'NO_OP',
        reconciled: true,
        resolved: true,
        isUnresolved: false,
        authorizationId: authId,
        auditEntry,
        reason: `Remote authorization verified as ${authDetails.status}`,
      };
    }

    // If remote state reports CAPTURED while local is VOIDED/FAILED:
    if (authDetails.status === 'CAPTURED' || authDetails.isCaptured) {
      runInTransaction(db, () => {
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_INTEGRITY_MISMATCH',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'REMOTE_AUTHORIZATION_ALREADY_CAPTURED_FOR_VOIDED_REQUEST',
            authorizationId: authId,
          },
        });
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'Contradictory state: remote authorization is CAPTURED but local request is VOIDED/FAILED',
      };
    }

    // Explicit fail-closed handling for PARTIALLY_CAPTURED, PENDING, DENIED
    if (authDetails.status === 'PARTIALLY_CAPTURED' || authDetails.isPartiallyCaptured) {
      runInTransaction(db, () => {
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'AUTHORIZATION_PARTIALLY_CAPTURED_FOR_VOID_REQUEST',
            authorizationId: authId,
            authorizationStatus: authDetails.status,
          },
        });
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Remote authorization is PARTIALLY_CAPTURED while local request is ${currentStatus}; requires manual reconciliation`,
      };
    }

    if (authDetails.status === 'PENDING' || authDetails.isPending) {
      runInTransaction(db, () => {
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'AUTHORIZATION_PENDING_FOR_VOID_REQUEST',
            authorizationId: authId,
            authorizationStatus: authDetails.status,
          },
        });
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Remote authorization is PENDING while local request is ${currentStatus}; retaining unresolved state`,
      };
    }

    if (authDetails.status === 'DENIED') {
      runInTransaction(db, () => {
        writeAuditLogEntryIfChanged(db, repos, {
          actor,
          event: 'RECONCILIATION_UNRESOLVED',
          requestId,
          timestamp: nowIso,
          payload: {
            reason: 'REMOTE_AUTHORIZATION_DENIED_FOR_VOID_REQUEST',
            authorizationId: authId,
            authorizationStatus: authDetails.status,
          },
        });
      });

      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Remote authorization status is DENIED while local request is ${currentStatus}; requires operator verification`,
      };
    }

    // Only retry voidAuthorization when remote authorization is cleanly CREATED
    if (authDetails.status === 'CREATED') {
      let currentRemoteVoidStatus: string | null = request.remote_void_status;

      // If request.remote_void_status is FAILED, do not blindly retry without operator intervention.
      // If request.remote_void_status is PENDING, attempt safe retry using voidAuthorization outside tx.
      if (request.remote_void_status === 'PENDING') {
        let voidRes: Awaited<ReturnType<PayPalAuthorizationsService['voidAuthorization']>> | undefined;
        let voidError: unknown;
        try {
          voidRes = await options.authorizationsService.voidAuthorization({
            authorizationId: authId,
            requestId,
          });
        } catch (err: unknown) {
          voidError = err;
        }

        if (voidRes !== undefined) {
          if (voidRes.isVoided) {
            const auditEntry = runInTransaction(db, () => {
              const latest = repos.paymentRequests.getById(requestId);
              if (latest && latest.remote_void_status === 'CONFIRMED') {
                return undefined;
              }
              repos.paymentRequests.updateRemoteVoidStatus(requestId, 'CONFIRMED', nowIso);
              if ((latest?.status ?? currentStatus) === 'VOIDED') {
                recoverVoidNotification(repos, {
                  requestId,
                  amountMinor: request.amount_minor,
                  currency: request.currency,
                  vendorId: request.vendor_id,
                  remoteVoidStatus: 'CONFIRMED',
                  ...urlOptions,
                });
              }

              return writeAuditLogEntry(db, repos, {
                actor,
                event: 'PAYPAL_VOID_RECONCILED',
                requestId,
                timestamp: nowIso,
                payload: {
                  authorizationId: authId,
                  remote_void_status: 'CONFIRMED',
                },
              });
            });

            return {
              requestId,
              status: currentStatus,
              requestStatus: currentStatus,
              actionTaken: auditEntry ? 'VOIDED' : 'NO_OP',
              reconciled: true,
              resolved: true,
              isUnresolved: false,
              authorizationId: authId,
              auditEntry,
              reason: 'Remote authorization void confirmed via retry',
            };
          } else {
            currentRemoteVoidStatus = 'PENDING';
            runInTransaction(db, () => {
              const latest = repos.paymentRequests.getById(requestId);
              if (!latest || latest.remote_void_status !== 'PENDING') {
                return;
              }
              writeAuditLogEntryIfChanged(db, repos, {
                actor,
                event: 'PAYPAL_VOID_PENDING_RETRY',
                requestId,
                timestamp: nowIso,
                payload: {
                  reason: 'REMOTE_VOID_NOT_CONFIRMED',
                  authorizationId: authId,
                  remote_void_status: 'PENDING',
                },
              });
            });
          }
        } else {
          const errMsg = voidError instanceof Error ? voidError.message : String(voidError);
          const isDefinitive =
            voidError instanceof AuthorizationError &&
            (voidError.code === 'INVALID_REQUEST' || voidError.code === 'DECLINED');

          if (isDefinitive) {
            currentRemoteVoidStatus = 'FAILED';
            runInTransaction(db, () => {
              const latest = repos.paymentRequests.getById(requestId);
              if (!latest || latest.remote_void_status === 'CONFIRMED' || latest.remote_void_status === 'FAILED') {
                return;
              }
              repos.paymentRequests.updateRemoteVoidStatus(requestId, 'FAILED', nowIso);
              if ((latest.status ?? currentStatus) === 'VOIDED') {
                recoverVoidNotification(repos, {
                  requestId,
                  amountMinor: request.amount_minor,
                  currency: request.currency,
                  vendorId: request.vendor_id,
                  remoteVoidStatus: 'FAILED',
                  reason: errMsg,
                  ...urlOptions,
                });
              }

              writeAuditLogEntry(db, repos, {
                actor,
                event: 'PAYPAL_VOID_FAILED',
                requestId,
                timestamp: nowIso,
                payload: {
                  error: errMsg,
                  authorizationId: authId,
                  remote_void_status: 'FAILED',
                },
              });
            });
          } else {
            // Preserve remote_void_status = 'PENDING' on transient error so future retries continue
            currentRemoteVoidStatus = 'PENDING';
            runInTransaction(db, () => {
              const latest = repos.paymentRequests.getById(requestId);
              if (!latest || latest.remote_void_status !== 'PENDING') {
                return;
              }
              writeAuditLogEntryIfChanged(db, repos, {
                actor,
                event: 'PAYPAL_VOID_PENDING_RETRY',
                requestId,
                timestamp: nowIso,
                payload: {
                  error: errMsg,
                  authorizationId: authId,
                  remote_void_status: 'PENDING',
                },
              });
            });
          }
        }
      } else {
        runInTransaction(db, () => {
          const latest = repos.paymentRequests.getById(requestId);
          if ((latest?.status ?? currentStatus) === 'VOIDED' && latest?.remote_void_status === 'FAILED') {
            recoverVoidNotification(repos, {
              requestId,
              amountMinor: request.amount_minor,
              currency: request.currency,
              vendorId: request.vendor_id,
              remoteVoidStatus: 'FAILED',
              reason: 'Remote authorization void previously failed and requires operator intervention',
              ...urlOptions,
            });
          }
          writeAuditLogEntryIfChanged(db, repos, {
            actor,
            event: 'RECONCILIATION_UNRESOLVED',
            requestId,
            timestamp: nowIso,
            payload: {
              reason: 'REMOTE_VOID_PREVIOUSLY_FAILED',
              authorizationId: authId,
              authorizationStatus: authDetails.status,
            },
          });
        });
      }

      return {
        requestId,
        status: currentStatus,
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Remote void reconciliation unresolved (status: ${currentRemoteVoidStatus}, remoteAuthStatus: ${authDetails.status})`,
      };
    }

    // Any unexpected or unrecognized remote authorization status must fail closed without retrying void
    runInTransaction(db, () => {
      writeAuditLogEntryIfChanged(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'UNEXPECTED_REMOTE_AUTHORIZATION_STATUS',
          authorizationId: authId,
          authorizationStatus: authDetails.status,
        },
      });
    });

    return {
      requestId,
      status: 'UNRESOLVED',
      requestStatus: currentStatus,
      actionTaken: 'NO_OP',
      reconciled: false,
      resolved: false,
      isUnresolved: true,
      reason: `Unexpected remote authorization status '${authDetails.status}' while reconciling remote void`,
    };
  }

  return {
    requestId,
    status: 'UNRESOLVED',
    requestStatus: currentStatus,
    actionTaken: 'NO_OP',
    reconciled: false,
    resolved: false,
    isUnresolved: true,
    reason: `Unsupported status for reconciliation: ${currentStatus}`,
  };
}

// ============================================================================
// Batch Candidate Reconciliation
// ============================================================================

export async function reconcilePendingRequests(
  db: Database,
  options?: ReconcileRequestOptions
): Promise<ReconcileBatchResult> {
  const repos = options?.repos ?? createRepositories(db);
  const candidates = repos.paymentRequests.listNeedingReconciliation();

  const results: ReconcileRequestResult[] = [];
  let resolved = 0;
  let unresolved = 0;

  for (const candidate of candidates) {
    if (options?.shouldContinue && !options.shouldContinue()) {
      break;
    }
    try {
      const result = await reconcilePaymentRequest(db, candidate.id, options);
      results.push(result);
      if (result.reconciled && !result.isUnresolved) {
        resolved++;
      } else {
        unresolved++;
      }
    } catch (err: unknown) {
      unresolved++;
      const sanitizedError = err instanceof Error ? err.message : String(err);
      options?.logger?.error?.(
        `[reconcilePendingRequests] Unexpected error reconciling candidate ${candidate.id}: ${sanitizedError}`
      );
      results.push({
        requestId: candidate.id,
        status: 'UNRESOLVED',
        requestStatus: candidate.status as PaymentRequestStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: `Unexpected reconciliation error: ${sanitizedError}`,
        error: sanitizedError,
      });
    }
  }

  return {
    totalProcessed: results.length,
    resolved,
    unresolved,
    results,
  };
}

// ============================================================================
// Canonical 60-Second Reconciler Worker
// ============================================================================

export class ReconcilerWorker {
  private readonly db: Database;
  private readonly options: ReconcilerWorkerOptions;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private activeTickPromise: Promise<ReconcileBatchResult> | null = null;

  constructor(options: ReconcilerWorkerOptions) {
    this.db = options.db;
    this.options = options;
    // Canonical 60-second default per PLAN.md Section 9 Flow F and Section 13
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  public isRunning(): boolean {
    return this.running;
  }

  public getIntervalMs(): number {
    return this.intervalMs;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.stopped = false;
    this.running = true;

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Unref timer so it does not block Node process termination in CLI/tools
    if (typeof this.timer?.unref === 'function') {
      this.timer.unref();
    }

    this.options.logger?.info?.(`[ReconcilerWorker] Started background job with interval ${this.intervalMs}ms`);
  }

  public async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeTickPromise) {
      try {
        await this.activeTickPromise;
      } catch {
        // Tick errors are handled and logged inside tick()
      }
    }
    this.options.logger?.info?.('[ReconcilerWorker] Stopped background job');
  }

  public async tick(): Promise<ReconcileBatchResult> {
    if (this.stopped || this.activeTickPromise) {
      return { totalProcessed: 0, resolved: 0, unresolved: 0, results: [] };
    }

    const tickPromise = this.runTick();
    this.activeTickPromise = tickPromise;
    try {
      return await tickPromise;
    } finally {
      if (this.activeTickPromise === tickPromise) {
        this.activeTickPromise = null;
      }
    }
  }

  private async runTick(): Promise<ReconcileBatchResult> {
    try {
      return await reconcilePendingRequests(this.db, {
        repos: this.options.repos,
        ordersService: this.options.ordersService,
        authorizationsService: this.options.authorizationsService,
        ...('publicBaseUrl' in this.options ? { publicBaseUrl: this.options.publicBaseUrl } : {}),
        ...('isProduction' in this.options ? { isProduction: this.options.isProduction } : {}),
        shouldContinue: () => !this.stopped,
        logger: this.options.logger,
      });
    } catch (err: unknown) {
      this.options.logger?.error?.('[ReconcilerWorker] Error in reconciliation tick:', err);
      return { totalProcessed: 0, resolved: 0, unresolved: 0, results: [] };
    }
  }
}
