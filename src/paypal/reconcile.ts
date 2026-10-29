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
import {
  transitionPaymentRequest,
  writeAuditLogEntry,
  type PaymentRequestStatus,
  type AuditActor,
  TERMINAL_STATUSES,
} from '../core/stateMachine.js';

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
  readonly logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function extractProvisionalOrderIdFromAudit(
  repos: Repositories,
  requestId: string
): string | undefined {
  const auditEntries = repos.auditLog.listByRequestId(requestId);
  for (const entry of auditEntries) {
    if (entry.payload) {
      try {
        const parsed = JSON.parse(entry.payload) as Record<string, unknown>;
        if (typeof parsed.paypal_order_id === 'string' && parsed.paypal_order_id.trim()) {
          return parsed.paypal_order_id.trim();
        }
        if (typeof parsed.orderId === 'string' && parsed.orderId.trim()) {
          return parsed.orderId.trim();
        }
        if (typeof parsed.order_id === 'string' && parsed.order_id.trim()) {
          return parsed.order_id.trim();
        }
      } catch {
        // ignore malformed audit JSON
      }
    }
  }
  return undefined;
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

  // 2. Terminal state guard: Already finalized, no-op
  if (TERMINAL_STATUSES.has(currentStatus)) {
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
    let orderId = request.paypal_order_id?.trim();
    if (!orderId) {
      orderId = extractProvisionalOrderIdFromAudit(repos, requestId);
    }

    if (!orderId) {
      // Fail closed: Never guess IDs or create replacement orders
      writeAuditLogEntry(db, repos, {
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

    if (!options.ordersService) {
      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'PayPal ordersService not configured',
      };
    }

    let orderResult: PayPalOrderResult;
    try {
      // Read-only remote query outside DB transaction
      orderResult = await options.ordersService.getOrder(orderId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      writeAuditLogEntry(db, repos, {
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
        reason: `Remote order lookup failed: ${errMsg}`,
      };
    }

    // Validate remote order against persisted request
    const identityMatch = orderResult.id === orderId;
    const customIdMatch = !orderResult.customId || orderResult.customId === requestId;
    const amountMatch = orderResult.amountMinor === request.amount_minor;
    const currencyMatch = orderResult.currency === request.currency;
    const intentMatch = orderResult.intent === 'CAPTURE';

    if (!identityMatch || !customIdMatch || !amountMatch || !currencyMatch || !intentMatch) {
      writeAuditLogEntry(db, repos, {
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
        reason: 'Remote order integrity mismatch; values differ from persisted payment request',
      };
    }

    // Case A.1: Remote order is captured (COMPLETED with completed capture)
    if (orderResult.isCaptured && orderResult.capture && orderResult.capture.status === 'COMPLETED') {
      const captureId = orderResult.capture.id;

      return runInTransaction(db, () => {
        const ledgerEntries = repos.ledger.listByRequestId(requestId);
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
    }

    // Case A.2: Remote order is conclusively voided without capture
    if (orderResult.status === 'VOIDED') {
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
    }

    // Case A.3: Inconclusive status (CREATED, SAVED, PAYER_ACTION_REQUIRED, PENDING)
    writeAuditLogEntry(db, repos, {
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
      writeAuditLogEntry(db, repos, {
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
      writeAuditLogEntry(db, repos, {
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

    // Exact Authorization Amount & Currency Validation
    const authIdMatch = authDetails.id === authId;
    const authAmountMatch = authDetails.amountMinor === request.amount_minor;
    const authCurrencyMatch = authDetails.currency === request.currency;

    if (!authIdMatch || !authAmountMatch || !authCurrencyMatch) {
      writeAuditLogEntry(db, repos, {
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

    // Case C.1: Remote authorization is CAPTURED
    if (authDetails.status === 'CAPTURED' && authDetails.isCaptured) {
      return runInTransaction(db, () => {
        const ledgerEntries = repos.ledger.listByRequestId(requestId);
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
    }

    // Case C.2: Remote authorization is terminally closed without capture
    if (
      (authDetails.status === 'VOIDED' || authDetails.status === 'EXPIRED' || authDetails.status === 'DENIED') &&
      !authDetails.isCaptured &&
      !authDetails.isPartiallyCaptured
    ) {
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
    }

    // Case C.3: Remote authorization is CREATED (or PENDING)
    // Mandatory Safety Constraint: CREATED alone does not make a new capture safe.
    // An earlier ambiguous capture may still be in transit or processing at PayPal.
    // Retain CAPTURING, preserve reservation, and report UNRESOLVED.
    writeAuditLogEntry(db, repos, {
      actor,
      event: 'RECONCILIATION_UNRESOLVED',
      requestId,
      timestamp: nowIso,
      payload: {
        reason: 'AUTHORIZATION_HOLD_UNCAPTURED_IN_FLIGHT',
        authorizationStatus: authDetails.status,
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
        writeAuditLogEntry(db, repos, {
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
        writeAuditLogEntry(db, repos, {
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
      if (authDetails.status === 'CREATED' && authDetails.isCapturable) {
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

          const targetStatus = authDetails.status === 'VOIDED' ? 'VOIDED' : 'FAILED';
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
      }

      // Case B.1.3: Authorization already CAPTURED while request is HELD
      // Fails closed: HELD cannot legally transition to CAPTURED
      writeAuditLogEntry(db, repos, {
        actor,
        event: 'RECONCILIATION_UNRESOLVED',
        requestId,
        timestamp: nowIso,
        payload: {
          reason: 'AUTHORIZATION_ALREADY_CAPTURED_WHILE_HELD',
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

    // Sub-path 2: Request is missing paypal_authorization_id
    // Precondition: Must have a persisted order ID
    const orderId = request.paypal_order_id?.trim();
    if (!orderId) {
      writeAuditLogEntry(db, repos, {
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

    if (!options.ordersService) {
      return {
        requestId,
        status: 'UNRESOLVED',
        requestStatus: currentStatus,
        actionTaken: 'NO_OP',
        reconciled: false,
        resolved: false,
        isUnresolved: true,
        reason: 'PayPal ordersService not configured',
      };
    }

    let orderResult: PayPalOrderResult;
    try {
      orderResult = await options.ordersService.getOrder(orderId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      writeAuditLogEntry(db, repos, {
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
        reason: `Remote order lookup failed: ${errMsg}`,
      };
    }

    // Authoritative Remote Order Validation
    const idMatch = orderResult.id === orderId;
    const customIdMatch = !orderResult.customId || orderResult.customId === requestId;
    const amountMatch = orderResult.amountMinor === request.amount_minor;
    const currencyMatch = orderResult.currency === request.currency;
    const intentMatch = orderResult.intent === 'AUTHORIZE';
    const authSummary = orderResult.authorization;
    const authIdPresent = Boolean(authSummary?.id && authSummary.id.trim());

    if (!idMatch || !customIdMatch || !amountMatch || !currencyMatch || !intentMatch || !authIdPresent) {
      writeAuditLogEntry(db, repos, {
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
        reason: 'Incomplete or mismatched authorization evidence in remote order',
      };
    }

    const discoveredAuthId = authSummary!.id.trim();

    // Case B.2.1: Active uncaptured hold (CREATED)
    if (authSummary!.status === 'CREATED') {
      return runInTransaction(db, () => {
        repos.paymentRequests.updatePayPalIds(requestId, {
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
        writeAuditLogEntry(db, repos, {
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
        writeAuditLogEntry(db, repos, {
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
        writeAuditLogEntry(db, repos, {
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

        const targetStatus = directAuth.status === 'VOIDED' ? 'VOIDED' : 'FAILED';
        const { auditEntry } = transitionPaymentRequest(db, repos, {
          requestId,
          to: targetStatus,
          actor,
          event: targetStatus === 'VOIDED' ? 'TRANSITION_TO_VOIDED' : 'TRANSITION_TO_FAILED',
          paypalAuthorizationId: discoveredAuthId,
          timestamp: nowIso,
          payload: {
            reconciled: true,
            reason: `Dual-attestation confirmed authorization is ${directAuth.status} without capture`,
            paypal_order_id: orderResult.id,
            paypal_authorization_id: discoveredAuthId,
          },
        });

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
    }

    // Case B.2.3: Already CAPTURED authorization in remote order
    if (authSummary!.status === 'CAPTURED') {
      writeAuditLogEntry(db, repos, {
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

    // Case B.2.4: Unexpected or unverified status
    writeAuditLogEntry(db, repos, {
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
    const result = await reconcilePaymentRequest(db, candidate.id, options);
    results.push(result);
    if (result.reconciled && !result.isUnresolved) {
      resolved++;
    } else {
      unresolved++;
    }
  }

  return {
    totalProcessed: candidates.length,
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
  private isTickInProgress = false;

  constructor(options: ReconcilerWorkerOptions) {
    this.db = options.db;
    this.options = options;
    // Canonical 60-second default per PLAN.md Section 9 Flow F and Section 13
    this.intervalMs = options.intervalMs ?? 60_000;
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

    this.options.logger?.info?.(`[ReconcilerWorker] Started background job with interval ${this.intervalMs}ms`);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.options.logger?.info?.('[ReconcilerWorker] Stopped background job');
  }

  public async tick(): Promise<ReconcileBatchResult> {
    if (this.isTickInProgress) {
      return { totalProcessed: 0, resolved: 0, unresolved: 0, results: [] };
    }

    this.isTickInProgress = true;
    try {
      return await reconcilePendingRequests(this.db, {
        repos: this.options.repos,
        ordersService: this.options.ordersService,
        authorizationsService: this.options.authorizationsService,
      });
    } catch (err: unknown) {
      this.options.logger?.error?.('[ReconcilerWorker] Error in reconciliation tick:', err);
      return { totalProcessed: 0, resolved: 0, unresolved: 0, results: [] };
    } finally {
      this.isTickInProgress = false;
    }
  }
}
