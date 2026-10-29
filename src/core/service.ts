/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T8: Transactional Evaluation and Reservation Service
 *
 * Implements:
 * - Transactional request ingestion, policy evaluation, and budget reservation
 * - Single outer BEGIN IMMEDIATE transaction isolation without nested transactions
 * - Deterministic SHA-256 snapshot hashing for hold requests
 * - Idempotent replay for identical requests & conflict detection on reuse
 * - Strict budget & velocity concurrency enforcement via atomic state machine
 *
 * Security Invariants & Rules:
 * - Rule 4 & I3: Only executeDecision may call money-moving PayPal functions (no PayPal calls here).
 * - Rule 7 & I2: Every state transition writes an audit_log row in the same transaction.
 * - Rule 8: Fail closed on missing policy or ambiguity.
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
import type { PolicyDocument, PolicyRequest, ReasonCode } from '../policy/types.js';
import { evaluatePolicy } from '../policy/engine.js';
import { gatherFacts } from './facts.js';
import {
  transitionPaymentRequest,
  type PaymentRequestStatus,
} from './stateMachine.js';

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Thrown when an idempotency key is reused with differing request parameters.
 */
export class IdempotencyConflictError extends Error {
  public readonly agentId: string;
  public readonly idempotencyKey: string;
  public readonly existingRequestId: string;

  constructor(
    agentId: string,
    idempotencyKey: string,
    existingRequestId: string,
    message?: string
  ) {
    super(
      message ??
        `Idempotency conflict: key "${idempotencyKey}" already used by agent "${agentId}" with different request parameters`
    );
    this.name = 'IdempotencyConflictError';
    this.agentId = agentId;
    this.idempotencyKey = idempotencyKey;
    this.existingRequestId = existingRequestId;
  }
}

/**
 * Thrown when no active policy version exists in the database (fail-closed rule).
 */
export class NoActivePolicyError extends Error {
  constructor(message = 'No active policy version found in database') {
    super(message);
    this.name = 'NoActivePolicyError';
  }
}

/**
 * Thrown when the requesting agent does not exist in the database.
 */
export class AgentNotFoundError extends Error {
  public readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent "${agentId}" not found in registry`);
    this.name = 'AgentNotFoundError';
    this.agentId = agentId;
  }
}

/**
 * Thrown when the target vendor does not exist in the database.
 */
export class VendorNotFoundError extends Error {
  public readonly vendorId: string;

  constructor(vendorId: string) {
    super(`Vendor "${vendorId}" not found in registry`);
    this.name = 'VendorNotFoundError';
    this.vendorId = vendorId;
  }
}

// ============================================================================
// Snapshot Hashing
// ============================================================================

export interface SnapshotHashFields {
  readonly requestId: string;
  readonly agentId: string;
  readonly vendorId: string;
  readonly amountMinor: MinorUnits;
  readonly currency: string;
  readonly purpose: string;
  readonly category?: string | null;
}

/**
 * Computes a deterministic SHA-256 snapshot hash over canonical request fields.
 *
 * NOTE: The canonical PLAN.md specifies that snapshot_hash is the SHA-256 of the
 * canonical request fields, but does not provide an exhaustive field list or serialization format.
 * Per the M1-T8 baseline convention, this implementation includes exactly these 7 fields:
 * - agentId: string
 * - amountMinor: string (minor units string representation)
 * - category: string | null
 * - currency: string
 * - purpose: string
 * - requestId: string
 * - vendorId: string
 *
 * Keys are serialized in deterministic alphabetical order as JSON, then hashed with SHA-256.
 */
export function computeSnapshotHash(fields: SnapshotHashFields): string {
  const canonicalPayload = {
    agentId: fields.agentId,
    amountMinor: fields.amountMinor.toString(),
    category: fields.category ?? null,
    currency: fields.currency,
    purpose: fields.purpose,
    requestId: fields.requestId,
    vendorId: fields.vendorId,
  };
  const canonicalJson = JSON.stringify(canonicalPayload);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

// ============================================================================
// Service Parameter & Result Interfaces
// ============================================================================

export interface EvaluateAndReserveParams {
  readonly agentId: string;
  readonly vendorId: string;
  readonly amountMinor: MinorUnits;
  readonly currency: string;
  readonly purpose: string;
  readonly idempotencyKey: string;
  readonly category?: string | null;
  readonly sourceContext?: string | null;
  readonly aiFlags?: readonly string[];
  readonly now?: Date;
  readonly requestId?: string;
}

export interface EvaluateAndReserveResult {
  readonly request: PaymentRequestRow;
  readonly decision: 'ALLOW' | 'HOLD' | 'DENY';
  readonly reasons: readonly ReasonCode[];
  readonly isIdempotentReplay: boolean;
  readonly auditEntry?: AuditLogRow;
  readonly ledgerEntry?: LedgerRow;
}

// ============================================================================
// Core Service Function: evaluateAndReserve
// ============================================================================

/**
 * Executes the evaluate-and-reserve transaction inside a single BEGIN IMMEDIATE transaction.
 *
 * Lifecycle:
 * 1. Open transaction (BEGIN IMMEDIATE)
 * 2. Verify active policy exists (fail closed if missing)
 * 3. Verify agent and vendor exist
 * 4. Idempotency lookup (return original if identical; throw IdempotencyConflictError if differing)
 * 5. Insert initial payment_requests record (status: 'RECEIVED')
 * 6. Gather facts (excluding current request from velocity/duplicates) & evaluate pure policy
 * 7. ALLOW: insert RESERVE ledger row, transition RECEIVED -> AUTO_EXECUTING, append audit row
 * 8. HOLD: insert RESERVE ledger row, compute snapshot_hash, calculate expires_at, transition RECEIVED -> HELD, append audit row
 * 9. DENY: zero ledger rows, transition RECEIVED -> DENIED, append audit row
 * 10. Commit transaction atomically
 *
 * Invariant I3: No money-moving PayPal functions are called here.
 */
export function evaluateAndReserve(
  db: Database,
  params: EvaluateAndReserveParams,
  repositories?: Repositories
): EvaluateAndReserveResult {
  if (params.amountMinor <= 0n) {
    throw new Error('Amount in minor units must be positive');
  }

  const repos = repositories ?? createRepositories(db);

  return runInTransaction(db, () => {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();

    // 1. Fail closed if no active policy version exists
    const activePolicyRow = repos.policyVersions.getActive();
    if (!activePolicyRow) {
      throw new NoActivePolicyError();
    }
    const policyDoc = JSON.parse(activePolicyRow.rules) as PolicyDocument;

    // 2. Validate agent exists in registry
    const agent = repos.agents.getById(params.agentId);
    if (!agent) {
      throw new AgentNotFoundError(params.agentId);
    }

    // 3. Validate vendor exists in registry
    const vendor = repos.vendors.getById(params.vendorId);
    if (!vendor) {
      throw new VendorNotFoundError(params.vendorId);
    }

    // 4. Idempotency check
    const existing = repos.paymentRequests.getByAgentAndIdempotencyKey(
      params.agentId,
      params.idempotencyKey
    );

    if (existing) {
      const isMatch =
        existing.vendor_id === params.vendorId &&
        existing.amount_minor === params.amountMinor &&
        existing.currency === params.currency &&
        existing.purpose === params.purpose &&
        (existing.category ?? null) === (params.category ?? null);

      if (isMatch) {
        // Idempotent replay: return original stored request without creating new ledger or audit rows
        return {
          request: existing,
          decision: (existing.decision as 'ALLOW' | 'HOLD' | 'DENY') ?? 'DENY',
          reasons: existing.reasons ? (JSON.parse(existing.reasons) as ReasonCode[]) : [],
          isIdempotentReplay: true,
        };
      }

      throw new IdempotencyConflictError(params.agentId, params.idempotencyKey, existing.id);
    }

    // 5. Generate request ID and insert initial RECEIVED request
    const requestId = params.requestId ?? `req-${crypto.randomUUID()}`;
    const sourceContextExcerpt = params.sourceContext ? params.sourceContext.slice(0, 500) : null;
    const sourceContextHash = params.sourceContext
      ? crypto.createHash('sha256').update(params.sourceContext, 'utf8').digest('hex')
      : null;

    const initialRequest: PaymentRequestRow = {
      id: requestId,
      agent_id: params.agentId,
      idempotency_key: params.idempotencyKey,
      vendor_id: params.vendorId,
      amount_minor: params.amountMinor,
      currency: params.currency,
      purpose: params.purpose,
      category: params.category ?? null,
      source_context_excerpt: sourceContextExcerpt,
      source_context_hash: sourceContextHash,
      status: 'RECEIVED',
      decision: null,
      reasons: null,
      policy_version_id: activePolicyRow.id,
      snapshot_hash: null,
      paypal_order_id: null,
      paypal_authorization_id: null,
      paypal_capture_id: null,
      expires_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    repos.paymentRequests.insert(initialRequest);

    // 6. Gather facts and evaluate policy
    const policyRequest: PolicyRequest = {
      agentId: params.agentId,
      vendorId: params.vendorId,
      amountMinor: params.amountMinor,
      currency: params.currency,
      purpose: params.purpose,
      category: params.category ?? undefined,
      idempotencyKey: params.idempotencyKey,
    };

    // Exclude currentRequestId so the newly inserted RECEIVED request is not self-counted
    const facts = gatherFacts(db, policyRequest, policyDoc, {
      now,
      currentRequestId: requestId,
    });

    const evaluation = evaluatePolicy(
      policyRequest,
      facts,
      policyDoc,
      {
        aiFlags: params.aiFlags,
        now,
      }
    );

    let ledgerEntry: LedgerRow | undefined;
    let targetStatus: PaymentRequestStatus;
    let snapshotHash: string | null = null;
    let expiresAt: string | null = null;

    if (evaluation.decision === 'ALLOW') {
      // Flow A: Insert RESERVE ledger row, transition RECEIVED -> AUTO_EXECUTING
      const ledgerId = `led-${crypto.randomUUID()}`;
      ledgerEntry = {
        id: ledgerId,
        request_id: requestId,
        kind: 'RESERVE',
        amount_minor: params.amountMinor,
        currency: params.currency,
        created_at: nowIso,
      };
      repos.ledger.insert(ledgerEntry);
      targetStatus = 'AUTO_EXECUTING';
    } else if (evaluation.decision === 'HOLD') {
      // Flow B: Insert RESERVE ledger row, compute snapshot_hash, calculate expires_at, transition RECEIVED -> HELD
      const ledgerId = `led-${crypto.randomUUID()}`;
      ledgerEntry = {
        id: ledgerId,
        request_id: requestId,
        kind: 'RESERVE',
        amount_minor: params.amountMinor,
        currency: params.currency,
        created_at: nowIso,
      };
      repos.ledger.insert(ledgerEntry);

      snapshotHash = computeSnapshotHash({
        requestId,
        agentId: params.agentId,
        vendorId: params.vendorId,
        amountMinor: params.amountMinor,
        currency: params.currency,
        purpose: params.purpose,
        category: params.category ?? null,
      });

      const expiryMs = now.getTime() + policyDoc.hold_ttl_minutes * 60 * 1000;
      expiresAt = new Date(expiryMs).toISOString();
      targetStatus = 'HELD';
    } else {
      // Flow E: DENY: No ledger row, transition RECEIVED -> DENIED
      targetStatus = 'DENIED';
    }

    // 7. Atomic state transition and hash-chained audit row
    const transitionResult = transitionPaymentRequest(db, repos, {
      requestId,
      to: targetStatus,
      actor: 'agent',
      event: `TRANSITION_TO_${targetStatus}`,
      decision: evaluation.decision,
      reasons: evaluation.reasons,
      snapshotHash,
      expiresAt,
      timestamp: nowIso,
      payload: {
        amount_minor: params.amountMinor.toString(),
        currency: params.currency,
        vendor_id: params.vendorId,
        rules_triggered: evaluation.ruleIds,
        decision: evaluation.decision,
      },
    });

    return {
      request: transitionResult.request,
      decision: evaluation.decision,
      reasons: evaluation.reasons,
      isIdempotentReplay: false,
      auditEntry: transitionResult.auditEntry,
      ledgerEntry,
    };
  });
}
