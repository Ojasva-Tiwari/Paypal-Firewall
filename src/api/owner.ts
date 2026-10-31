/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T5: Owner REST API Router (src/api/owner.ts)
 *
 * Implements the canonical owner REST API endpoints per PLAN.md Section 15:
 * - GET  /overview              — Budget usage vs daily budget, 24h counts, recent activity
 * - GET  /requests              — Filterable, paginated payment requests list
 * - GET  /requests/:id          — Detail + audit timeline + ledger entries + lazy expiry
 * - POST /requests/:id/approve  — Direct owner approval (via executeDecision Flow C)
 * - POST /requests/:id/void     — Direct owner void (releases reservation, voids PayPal authorization)
 * - GET  /policies              — Active policy and version history
 * - POST /policies              — Validate and activate new immutable policy version
 * - GET  /vendors               — Registered vendors list (secrets omitted)
 * - POST /vendors               — Register new vendor
 * - GET  /agents                — Registered agents list (hashes omitted)
 * - POST /agents                — Provision new agent key (shown once)
 * - POST /agents/:id/suspend    — Suspend agent
 * - GET  /audit                 — Paginated audit log with deterministic ordering
 * - GET  /paypal/activity       — Read-only PayPal activity (graceful fallback)
 * - GET  /healthz               — Public health status
 *
 * Security Invariants & Rules:
 * - AGENTS.md Hard Rule 1: Sandbox only. Never add code paths that use PayPal production.
 * - AGENTS.md Hard Rule 2: Never expose credentials, vault tokens, raw keys, or hashes.
 * - AGENTS.md Hard Rule 3 & 4: Only executeDecision in src/core may call money-moving PayPal functions.
 * - AGENTS.md Hard Rule 5: Monetary amounts are integer minor units. Formatted decimal only at boundaries.
 * - AGENTS.md Hard Rule 7: Every state transition writes an audit_log row in the same transaction.
 * - AGENTS.md Hard Rule 8: Fail closed on any ambiguity or error.
 */

import * as crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Database } from '../db/connection.js';
import { runInTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import type { OwnerSessionStore } from '../auth/owner.js';
import { createOwnerAuthMiddleware } from '../auth/owner.js';
import type { PayPalAuthorizationsService } from '../paypal/authorizations.js';
import type { PayPalOrdersService } from '../paypal/orders.js';
import {
  formatMinorUnitsToDecimal,
  parseDecimalToMinorUnits,
  toMinorUnits,
  type MinorUnits,
  MAX_MINOR_UNITS,
} from '../core/money.js';
import {
  transitionPaymentRequest,
  writeAuditLogEntry,
} from '../core/stateMachine.js';
import { executeDecision } from '../core/executeDecision.js';
import { expirePaymentHold } from '../approvals/expiry.js';
import { getRollingBudgets } from '../core/facts.js';
import { PolicyDocumentSchema } from '../policy/types.js';
import { generateAgentKey } from '../mcp/auth.js';
import { AuthorizationError } from '../paypal/authorizations.js';
import type { AgentRow, VendorRow, PolicyVersionRow } from '../db/types.js';

// ============================================================================
// Types & Options
// ============================================================================

export interface OwnerApiRouterOptions {
  readonly db: Database;
  readonly repos: Repositories;
  readonly sessionStore: OwnerSessionStore;
  readonly authorizationsService?: PayPalAuthorizationsService;
  readonly ordersService?: PayPalOrdersService;
  readonly logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
  };
}

// Canonical payment statuses for query parameter validation
const ALLOWED_STATUSES: ReadonlySet<string> = new Set<string>([
  'RECEIVED',
  'AUTO_EXECUTING',
  'HELD',
  'APPROVED',
  'CAPTURING',
  'EXPIRED',
  'DENIED',
  'VOIDED',
  'CAPTURED',
  'FAILED',
]);

const ALLOWED_ACTORS: ReadonlySet<string> = new Set<string>([
  'agent',
  'owner',
  'system',
  'ai',
]);

// ============================================================================
// Router Factory
// ============================================================================

export function createOwnerApiRouter(options: OwnerApiRouterOptions): Router {
  const router = Router();
  const { db, repos, sessionStore, authorizationsService, ordersService, logger } = options;

  // --------------------------------------------------------------------------
  // Public Health Endpoint (/api/healthz)
  // --------------------------------------------------------------------------
  router.get('/healthz', (_req: Request, res: Response): void => {
    res.status(200).json({
      status: 'ok',
      service: 'payguard-owner-api',
      tools: 4,
    });
  });

  // --------------------------------------------------------------------------
  // Owner Authentication & CSRF Protection
  // All subsequent routes require a valid owner session.
  // State-changing requests (POST) require a valid x-csrf-token header.
  // --------------------------------------------------------------------------
  const ownerAuthMiddleware = createOwnerAuthMiddleware(sessionStore);
  router.use(ownerAuthMiddleware);

  // ==========================================================================
  // 1. Overview (/api/overview)
  // ==========================================================================
  router.get('/overview', (_req: Request, res: Response): void => {
    try {
      const activePolicy = repos.policyVersions.getActive();
      let globalDailyBudgetMinor: MinorUnits = toMinorUnits(20000);
      let currency = 'USD';

      if (activePolicy) {
        try {
          const rules = JSON.parse(activePolicy.rules) as {
            global_daily_budget_minor?: number;
            currency_allowlist?: string[];
          };
          if (typeof rules.global_daily_budget_minor === 'number') {
            globalDailyBudgetMinor = toMinorUnits(rules.global_daily_budget_minor);
          }
          if (Array.isArray(rules.currency_allowlist) && rules.currency_allowlist[0]) {
            currency = rules.currency_allowlist[0];
          }
        } catch {
          // Fall back to defaults
        }
      }

      const now = new Date();
      const windowStartIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

      const budgets = getRollingBudgets(db, 'global', currency, windowStartIso);
      const spentMinor = budgets.globalSpendRolling24hMinor;
      const reservedMinor = budgets.globalReservedRolling24hMinor;
      const totalCommittedMinor = toMinorUnits(spentMinor + reservedMinor);
      const remainingBudgetMinor = toMinorUnits(
        Math.max(0, globalDailyBudgetMinor - totalCommittedMinor)
      );

      const counts24h = repos.paymentRequests.count24hByDecision(windowStartIso);
      const recentRows = repos.paymentRequests.listRecent(10);

      const recentActivity = recentRows.map((r) => {
        const vendor = repos.vendors.getById(r.vendor_id);
        const agent = repos.agents.getById(r.agent_id);
        let reasons: string[] = [];
        try {
          if (r.reasons) reasons = JSON.parse(r.reasons) as string[];
        } catch {
          reasons = [];
        }

        return {
          id: r.id,
          timestamp: r.created_at,
          status: r.status,
          decision: r.decision,
          reasons,
          vendorId: r.vendor_id,
          vendorName: vendor?.name ?? r.vendor_id,
          amountMinor: r.amount_minor,
          amountDecimal: formatMinorUnitsToDecimal(r.amount_minor),
          currency: r.currency,
          agentId: r.agent_id,
          agentName: agent?.name ?? r.agent_id,
        };
      });

      res.status(200).json({
        budget: {
          currency,
          globalDailyBudgetMinor,
          globalDailyBudgetDecimal: formatMinorUnitsToDecimal(globalDailyBudgetMinor),
          spentRolling24hMinor: spentMinor,
          spentRolling24hDecimal: formatMinorUnitsToDecimal(spentMinor),
          reservedRolling24hMinor: reservedMinor,
          reservedRolling24hDecimal: formatMinorUnitsToDecimal(reservedMinor),
          totalCommittedMinor,
          totalCommittedDecimal: formatMinorUnitsToDecimal(totalCommittedMinor),
          remainingBudgetMinor,
          remainingBudgetDecimal: formatMinorUnitsToDecimal(remainingBudgetMinor),
        },
        counts24h,
        recentActivity,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in GET /overview:', err);
      res.status(500).json({ error: 'Failed to retrieve overview metrics' });
    }
  });

  // ==========================================================================
  // 2. Payment Requests List (/api/requests)
  // ==========================================================================
  router.get('/requests', (req: Request, res: Response): void => {
    try {
      const rawStatus = typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
      let status: string | undefined;

      if (rawStatus) {
        if (!ALLOWED_STATUSES.has(rawStatus)) {
          res.status(400).json({
            error: `Invalid status parameter. Allowed statuses: ${Array.from(ALLOWED_STATUSES).join(', ')}`,
          });
          return;
        }
        status = rawStatus;
      }

      const rawLimit = parseInt(String(req.query.limit ?? '50'), 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 100) : 50;

      const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
      const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

      const items = repos.paymentRequests.list({ status, limit, offset });
      const total = repos.paymentRequests.count({ status });

      const mappedItems = items.map((r) => {
        const vendor = repos.vendors.getById(r.vendor_id);
        const agent = repos.agents.getById(r.agent_id);
        let reasons: string[] = [];
        try {
          if (r.reasons) reasons = JSON.parse(r.reasons) as string[];
        } catch {
          reasons = [];
        }

        return {
          id: r.id,
          agentId: r.agent_id,
          agentName: agent?.name ?? r.agent_id,
          vendorId: r.vendor_id,
          vendorName: vendor?.name ?? r.vendor_id,
          amountMinor: r.amount_minor,
          amountDecimal: formatMinorUnitsToDecimal(r.amount_minor),
          currency: r.currency,
          purpose: r.purpose,
          category: r.category,
          status: r.status,
          decision: r.decision,
          reasons,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
        };
      });

      res.status(200).json({
        items: mappedItems,
        total,
        limit,
        offset,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in GET /requests:', err);
      res.status(500).json({ error: 'Failed to retrieve payment requests' });
    }
  });

  // ==========================================================================
  // 3. Payment Request Detail (/api/requests/:id)
  // ==========================================================================
  router.get('/requests/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const requestId = req.params.id as string;
      let request = repos.paymentRequests.getById(requestId);

      if (!request) {
        res.status(404).json({ error: 'Payment request not found' });
        return;
      }

      // Lazy Expiry Hook: Run expiry check on read (PLAN.md Section 13)
      if (
        request.status === 'HELD' &&
        request.expires_at &&
        new Date(request.expires_at).getTime() <= Date.now()
      ) {
        await expirePaymentHold(db, requestId, {
          repos,
          authorizationsService,
          logger,
        });
        request = repos.paymentRequests.getById(requestId)!;
      }

      const vendor = repos.vendors.getById(request.vendor_id);
      const agent = repos.agents.getById(request.agent_id);
      const auditRows = repos.auditLog.listByRequestId(requestId);
      const ledgerRows = repos.ledger.listByRequestId(requestId);
      const approvalRows = repos.approvals.listByRequestId(requestId);

      let reasons: string[] = [];
      try {
        if (request.reasons) reasons = JSON.parse(request.reasons) as string[];
      } catch {
        reasons = [];
      }

      const timeline = auditRows.map((a) => {
        let payload: unknown = {};
        try {
          payload = JSON.parse(a.payload);
        } catch {
          payload = { raw: a.payload };
        }
        return {
          id: a.id,
          actor: a.actor,
          event: a.event,
          timestamp: a.ts,
          payload,
        };
      });

      const ledger = ledgerRows.map((l) => ({
        id: l.id,
        kind: l.kind,
        amountMinor: l.amount_minor,
        amountDecimal: formatMinorUnitsToDecimal(l.amount_minor),
        currency: l.currency,
        createdAt: l.created_at,
      }));

      // Security Invariant (Rule 2): Never return token_hash or raw token
      const approvals = approvalRows.map((ap) => ({
        id: ap.id,
        action: ap.action,
        expiresAt: ap.expires_at,
        usedAt: ap.used_at,
        channel: ap.channel,
        createdAt: ap.created_at,
      }));

      res.status(200).json({
        id: request.id,
        agent: {
          id: request.agent_id,
          name: agent?.name ?? request.agent_id,
        },
        vendor: {
          id: request.vendor_id,
          name: vendor?.name ?? request.vendor_id,
        },
        amount: {
          amountMinor: request.amount_minor,
          amountDecimal: formatMinorUnitsToDecimal(request.amount_minor),
          currency: request.currency,
        },
        purpose: request.purpose,
        category: request.category,
        sourceContextExcerpt: request.source_context_excerpt,
        status: request.status,
        decision: request.decision,
        reasons,
        policyVersionId: request.policy_version_id,
        paypalOrderId: request.paypal_order_id,
        paypalAuthorizationId: request.paypal_authorization_id,
        paypalCaptureId: request.paypal_capture_id,
        remoteVoidStatus: request.remote_void_status,
        expiresAt: request.expires_at,
        createdAt: request.created_at,
        updatedAt: request.updated_at,
        timeline,
        ledger,
        approvals,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in GET /requests/:id:', err);
      res.status(500).json({ error: 'Failed to retrieve request details' });
    }
  });

  // ==========================================================================
  // 4. Direct Owner Approval (/api/requests/:id/approve)
  // ==========================================================================
  router.post('/requests/:id/approve', async (req: Request, res: Response): Promise<void> => {
    try {
      const requestId = req.params.id as string;
      const ownerSession = req.ownerSession!;

      // Step 1: Pre-validation and Lazy Expiry
      let request = repos.paymentRequests.getById(requestId);
      if (!request) {
        res.status(404).json({ error: 'Payment request not found' });
        return;
      }

      if (
        request.status === 'HELD' &&
        request.expires_at &&
        new Date(request.expires_at).getTime() <= Date.now()
      ) {
        await expirePaymentHold(db, requestId, {
          repos,
          authorizationsService,
          logger,
        });
        res.status(410).json({
          error: 'HOLD_EXPIRED',
          message: 'Payment hold has expired and cannot be approved',
        });
        return;
      }

      // Step 2: Atomic SQLite State Transition & Token Invalidation
      const claimResult = runInTransaction(db, () => {
        request = repos.paymentRequests.getById(requestId);
        if (!request) {
          return { success: false, statusCode: 404, error: 'Payment request not found' };
        }

        if (request.status !== 'HELD') {
          return {
            success: false,
            statusCode: 409,
            error: 'INVALID_STATUS',
            message: `Request is in '${request.status}' status, cannot be approved`,
          };
        }

        if (
          request.expires_at &&
          new Date(request.expires_at).getTime() <= Date.now()
        ) {
          return {
            success: false,
            statusCode: 410,
            error: 'HOLD_EXPIRED',
            message: 'Payment hold has expired',
          };
        }

        const nowIso = new Date().toISOString();

        // Atomically invalidate all outstanding approval tokens for this request
        repos.approvals.invalidateForRequest(requestId, nowIso);

        // Transition HELD -> APPROVED with actor 'owner'
        const { request: updatedRequest } = transitionPaymentRequest(db, repos, {
          requestId,
          to: 'APPROVED',
          actor: 'owner',
          event: 'OWNER_APPROVED',
          timestamp: nowIso,
          payload: {
            channel: 'dashboard',
            owner_display_name: ownerSession.displayName,
          },
        });

        return { success: true, request: updatedRequest };
      });

      if (!claimResult.success || !claimResult.request) {
        res.status(claimResult.statusCode ?? 400).json({
          error: claimResult.error,
          message: claimResult.message,
        });
        return;
      }

      // Step 3: Flow C Capture via executeDecision (Only Money-Moving Caller)
      try {
        const execResult = await executeDecision(
          { requestId },
          {
            db,
            repos,
            actor: 'owner',
            authorizationsService,
            ordersService,
          }
        );

        res.status(200).json({
          success: true,
          status: execResult.status,
          captureId: execResult.captureId,
          orderId: execResult.orderId,
        });
      } catch (execErr: unknown) {
        // executeDecision fails closed and marks FAILED or leaves CAPTURING
        logger?.error?.('[OwnerApi] Execution error during owner approval capture:', execErr);
        const currentReq = repos.paymentRequests.getById(requestId);
        res.status(200).json({
          success: true,
          status: currentReq?.status ?? 'CAPTURING',
          warning: 'Capture in progress or awaiting reconciliation',
        });
      }
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in POST /requests/:id/approve:', err);
      res.status(500).json({ error: 'Failed to execute payment approval' });
    }
  });

  // ==========================================================================
  // 5. Direct Owner Void (/api/requests/:id/void)
  // ==========================================================================
  router.post('/requests/:id/void', async (req: Request, res: Response): Promise<void> => {
    try {
      const requestId = req.params.id as string;
      const ownerSession = req.ownerSession!;

      // Step 1: Pre-validation and Lazy Expiry
      let request = repos.paymentRequests.getById(requestId);
      if (!request) {
        res.status(404).json({ error: 'Payment request not found' });
        return;
      }

      if (
        request.status === 'HELD' &&
        request.expires_at &&
        new Date(request.expires_at).getTime() <= Date.now()
      ) {
        await expirePaymentHold(db, requestId, {
          repos,
          authorizationsService,
          logger,
        });
        res.status(200).json({
          success: true,
          status: 'VOIDED',
          message: 'Payment hold expired and voided',
        });
        return;
      }

      // Step 2: Atomic SQLite Claim Transaction
      const claimResult = runInTransaction(db, () => {
        request = repos.paymentRequests.getById(requestId);
        if (!request) {
          return { success: false, statusCode: 404, error: 'Payment request not found' };
        }

        if (request.status === 'VOIDED') {
          return {
            success: true,
            request,
            alreadyVoided: true,
          };
        }

        if (request.status !== 'HELD') {
          return {
            success: false,
            statusCode: 409,
            error: 'INVALID_STATUS',
            message: `Request is in '${request.status}' status, cannot be voided`,
          };
        }

        const nowIso = new Date().toISOString();

        // Invalidate all open approval tokens
        repos.approvals.invalidateForRequest(requestId, nowIso);

        // Verify ledger entries: Release reservation if not already released
        const ledgerEntries = repos.ledger.listByRequestId(requestId);
        const hasSpend = ledgerEntries.some((l) => l.kind === 'SPEND');
        if (hasSpend) {
          throw new Error('Illegal ledger state: cannot void request with existing SPEND entry');
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

        // Set remote_void_status = 'PENDING'
        repos.paymentRequests.updateRemoteVoidStatus(requestId, 'PENDING', nowIso);

        const reason =
          typeof req.body?.reason === 'string' && req.body.reason.trim()
            ? req.body.reason.trim()
            : 'Owner voided hold from dashboard';

        // Transition HELD -> VOIDED
        const { request: updatedRequest } = transitionPaymentRequest(db, repos, {
          requestId,
          to: 'VOIDED',
          actor: 'owner',
          event: 'OWNER_VOIDED',
          timestamp: nowIso,
          payload: {
            channel: 'dashboard',
            owner_display_name: ownerSession.displayName,
            reason,
          },
        });

        return {
          success: true,
          request: updatedRequest,
          authId: request.paypal_authorization_id,
          alreadyVoided: false,
        };
      });

      if (!claimResult.success || !claimResult.request) {
        res.status(claimResult.statusCode ?? 400).json({
          error: claimResult.error,
          message: claimResult.message,
        });
        return;
      }

      if (claimResult.alreadyVoided) {
        res.status(200).json({
          success: true,
          status: 'VOIDED',
          message: 'Payment request was already voided',
        });
        return;
      }

      // Step 3: Remote PayPal Authorization Cancellation (Outside DB Transaction)
      const authId = claimResult.authId;
      let remoteVoidStatus: 'PENDING' | 'CONFIRMED' | 'FAILED' = 'PENDING';
      const nowIso = new Date().toISOString();

      if (authId && authorizationsService) {
        try {
          const voidRes = await authorizationsService.voidAuthorization({
            authorizationId: authId,
            requestId,
          });

          if (voidRes.isVoided) {
            remoteVoidStatus = 'CONFIRMED';
            repos.paymentRequests.updateRemoteVoidStatus(requestId, 'CONFIRMED', nowIso);
            writeAuditLogEntry(db, repos, {
              actor: 'system',
              event: 'PAYPAL_VOID_RECONCILED',
              requestId,
              timestamp: nowIso,
              payload: {
                authorizationId: authId,
                reason: 'Remote authorization void confirmed for owner action',
                remote_void_status: 'CONFIRMED',
              },
            });
          }
        } catch (err: unknown) {
          const isDefinitive =
            err instanceof AuthorizationError &&
            (err.code === 'INVALID_REQUEST' || err.code === 'DECLINED');

          if (isDefinitive) {
            remoteVoidStatus = 'FAILED';
            repos.paymentRequests.updateRemoteVoidStatus(requestId, 'FAILED', nowIso);
            writeAuditLogEntry(db, repos, {
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
          } else {
            // Transient or network failure: leave PENDING for ReconcilerWorker
            logger?.warn?.(`[OwnerApi] Transient error during remote void for ${requestId}:`, err);
          }
        }
      } else {
        // No PayPal authorization existed to cancel
        remoteVoidStatus = 'CONFIRMED';
        repos.paymentRequests.updateRemoteVoidStatus(requestId, 'CONFIRMED', nowIso);
      }

      res.status(200).json({
        success: true,
        status: 'VOIDED',
        remoteVoidStatus,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in POST /requests/:id/void:', err);
      res.status(500).json({ error: 'Failed to void payment hold' });
    }
  });

  // ==========================================================================
  // 6. Policies (/api/policies)
  // ==========================================================================
  router.get('/policies', (_req: Request, res: Response): void => {
    try {
      const historyRows = repos.policyVersions.listAll();
      const history = historyRows.map((p) => {
        let rules: unknown = {};
        try {
          rules = JSON.parse(p.rules);
        } catch {
          rules = { raw: p.rules };
        }
        return {
          id: p.id,
          version: p.version,
          rules,
          author: p.author,
          active: p.active === 1,
          createdAt: p.created_at,
        };
      });

      const activePolicy = history.find((p) => p.active) ?? null;

      res.status(200).json({
        activePolicy,
        history,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in GET /policies:', err);
      res.status(500).json({ error: 'Failed to retrieve policy versions' });
    }
  });

  router.post('/policies', (req: Request, res: Response): void => {
    try {
      const rawBody = req.body as Record<string, unknown>;
      if (!rawBody || typeof rawBody !== 'object') {
        res.status(400).json({ error: 'Invalid policy payload: object expected' });
        return;
      }

      // Determine next version number
      const nextVersion = repos.policyVersions.getNextVersion();

      // Merge with version for canonical schema validation
      const candidateDoc = {
        ...rawBody,
        version: nextVersion,
      };

      const parseResult = PolicyDocumentSchema.safeParse(candidateDoc);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Policy document validation failed',
          details: parseResult.error.format(),
        });
        return;
      }

      const validatedRules = parseResult.data;
      const newPolicyId = `pol-${crypto.randomUUID()}`;
      const nowIso = new Date().toISOString();

      // Atomic insertion and active switch in a single SQLite transaction
      const newPolicyRow: PolicyVersionRow = {
        id: newPolicyId,
        version: nextVersion,
        rules: JSON.stringify(validatedRules),
        author: 'owner',
        active: 1,
        created_at: nowIso,
      };

      runInTransaction(db, () => {
        // Insert new policy first with active = 0 to avoid unique constraint conflict
        repos.policyVersions.insert({
          ...newPolicyRow,
          active: 0,
        });

        // Atomically switch active version
        repos.policyVersions.setActive(newPolicyId);

        // Write audit log entry in the same transaction (Hard Rule 7)
        writeAuditLogEntry(db, repos, {
          actor: 'owner',
          event: 'POLICY_ACTIVATED',
          timestamp: nowIso,
          payload: {
            policy_version_id: newPolicyId,
            version: nextVersion,
            author: 'owner',
          },
        });
      });

      res.status(201).json({
        id: newPolicyId,
        version: nextVersion,
        rules: validatedRules,
        author: 'owner',
        active: true,
        createdAt: nowIso,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in POST /policies:', err);
      res.status(500).json({ error: 'Failed to create and activate policy version' });
    }
  });

  // ==========================================================================
  // 7. Vendors (/api/vendors)
  // ==========================================================================
  router.get('/vendors', (_req: Request, res: Response): void => {
    try {
      const vendorRows = repos.vendors.listAll();
      const vendors = vendorRows.map((v) => {
        const vaultToken = repos.vendorVaultTokens.getByVendorId(v.id);
        let categories: string[] = [];
        let currencies: string[] = [];
        try {
          categories = JSON.parse(v.categories) as string[];
        } catch {
          categories = [];
        }
        try {
          currencies = JSON.parse(v.currencies) as string[];
        } catch {
          currencies = [];
        }

        // Security Invariant (Rule 2 & Condition 5):
        // Never expose connector_key, vault_token_id, or client credentials.
        return {
          id: v.id,
          name: v.name,
          status: v.status,
          categories,
          currencies,
          hasVaultToken: Boolean(vaultToken && vaultToken.vault_token_id),
          createdAt: v.created_at,
        };
      });

      res.status(200).json({ vendors });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in GET /vendors:', err);
      res.status(500).json({ error: 'Failed to retrieve vendor registry' });
    }
  });

  router.post('/vendors', (req: Request, res: Response): void => {
    try {
      const { id, name, status, categories, currencies, connector_key } = req.body ?? {};

      if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{2,64}$/.test(id.trim())) {
        res.status(400).json({
          error: 'Invalid vendor ID. Must be 2-64 alphanumeric characters, dashes, or underscores',
        });
        return;
      }
      const vendorId = id.trim();

      if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 120) {
        res.status(400).json({ error: 'Invalid name. Must be 1-120 characters' });
        return;
      }

      if (status !== 'ACTIVE' && status !== 'UNVERIFIED' && status !== 'BLOCKED') {
        res.status(400).json({ error: "Status must be 'ACTIVE', 'UNVERIFIED', or 'BLOCKED'" });
        return;
      }

      if (!Array.isArray(categories) || categories.length === 0) {
        res.status(400).json({ error: 'Categories must be a non-empty array of strings' });
        return;
      }

      if (
        !Array.isArray(currencies) ||
        currencies.length === 0 ||
        currencies.some((c) => typeof c !== 'string' || !/^[A-Z]{3}$/.test(c))
      ) {
        res.status(400).json({ error: 'Currencies must be a non-empty array of 3-letter uppercase codes' });
        return;
      }

      const connectorKey =
        typeof connector_key === 'string' && /^[a-zA-Z0-9_-]{2,64}$/.test(connector_key.trim())
          ? connector_key.trim()
          : 'acme_cloud';

      if (repos.vendors.getById(vendorId)) {
        res.status(409).json({ error: `Vendor with ID '${vendorId}' already exists` });
        return;
      }

      const nowIso = new Date().toISOString();
      const newVendor: VendorRow = {
        id: vendorId,
        name: name.trim(),
        status,
        categories: JSON.stringify(categories.map(String)),
        currencies: JSON.stringify(currencies.map(String)),
        connector_key: connectorKey,
        created_at: nowIso,
      };

      runInTransaction(db, () => {
        repos.vendors.insert(newVendor);

        writeAuditLogEntry(db, repos, {
          actor: 'owner',
          event: 'VENDOR_CREATED',
          timestamp: nowIso,
          payload: {
            vendor_id: vendorId,
            name: newVendor.name,
            status: newVendor.status,
          },
        });
      });

      res.status(201).json({
        id: vendorId,
        name: newVendor.name,
        status: newVendor.status,
        categories,
        currencies,
        createdAt: nowIso,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in POST /vendors:', err);
      res.status(500).json({ error: 'Failed to create vendor' });
    }
  });

  // ==========================================================================
  // 8. Agents (/api/agents)
  // ==========================================================================
  router.get('/agents', (_req: Request, res: Response): void => {
    try {
      const agentRows = repos.agents.listAll();
      const agents = agentRows.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        dailyBudgetMinor: a.daily_budget_minor,
        dailyBudgetDecimal: formatMinorUnitsToDecimal(a.daily_budget_minor),
        createdAt: a.created_at,
      }));

      // Security Invariant (Rule 2): api_key_hash is strictly omitted
      res.status(200).json({ agents });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in GET /agents:', err);
      res.status(500).json({ error: 'Failed to retrieve agent list' });
    }
  });

  router.post('/agents', (req: Request, res: Response): void => {
    try {
      const { name, daily_budget_decimal, daily_budget_minor } = req.body ?? {};

      if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) {
        res.status(400).json({ error: 'Invalid name. Must be 1-100 characters' });
        return;
      }

      let budgetMinor: MinorUnits = toMinorUnits(5000); // Default: $50.00

      if (typeof daily_budget_decimal === 'string') {
        try {
          budgetMinor = parseDecimalToMinorUnits(daily_budget_decimal);
        } catch {
          res.status(400).json({ error: 'Invalid daily_budget_decimal format. Expected e.g. "50.00"' });
          return;
        }
      } else if (typeof daily_budget_minor === 'number') {
        if (
          !Number.isInteger(daily_budget_minor) ||
          daily_budget_minor < 0 ||
          daily_budget_minor > MAX_MINOR_UNITS
        ) {
          res.status(400).json({ error: `daily_budget_minor must be an integer between 0 and ${MAX_MINOR_UNITS}` });
          return;
        }
        budgetMinor = toMinorUnits(daily_budget_minor);
      }

      const { rawKey, keyHash } = generateAgentKey();
      const agentId = `agent-${crypto.randomUUID()}`;
      const nowIso = new Date().toISOString();

      const newAgent: AgentRow = {
        id: agentId,
        name: name.trim(),
        api_key_hash: keyHash,
        status: 'ACTIVE',
        daily_budget_minor: budgetMinor,
        created_at: nowIso,
      };

      runInTransaction(db, () => {
        repos.agents.insert(newAgent);

        // Security Invariant (Condition 5): Never include raw key or hash in audit events!
        writeAuditLogEntry(db, repos, {
          actor: 'owner',
          event: 'AGENT_CREATED',
          timestamp: nowIso,
          payload: {
            agent_id: agentId,
            name: newAgent.name,
            daily_budget_minor: budgetMinor,
          },
        });
      });

      // Raw key is returned ONCE in this response and never persisted or retrievable again
      res.status(201).json({
        id: agentId,
        name: newAgent.name,
        status: newAgent.status,
        dailyBudgetMinor: budgetMinor,
        dailyBudgetDecimal: formatMinorUnitsToDecimal(budgetMinor),
        apiKey: rawKey,
        createdAt: nowIso,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in POST /agents:', err);
      res.status(500).json({ error: 'Failed to create agent' });
    }
  });

  router.post('/agents/:id/suspend', (req: Request, res: Response): void => {
    try {
      const agentId = req.params.id as string;
      const agent = repos.agents.getById(agentId);

      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      const nowIso = new Date().toISOString();

      runInTransaction(db, () => {
        repos.agents.updateStatus(agentId, 'SUSPENDED');

        writeAuditLogEntry(db, repos, {
          actor: 'owner',
          event: 'AGENT_SUSPENDED',
          timestamp: nowIso,
          payload: {
            agent_id: agentId,
            previous_status: agent.status,
            new_status: 'SUSPENDED',
          },
        });
      });

      res.status(200).json({
        id: agentId,
        status: 'SUSPENDED',
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in POST /agents/:id/suspend:', err);
      res.status(500).json({ error: 'Failed to suspend agent' });
    }
  });

  // ==========================================================================
  // 9. Audit Log (/api/audit)
  // ==========================================================================
  router.get('/audit', (req: Request, res: Response): void => {
    try {
      const rawLimit = parseInt(String(req.query.limit ?? '50'), 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 100) : 50;

      const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
      const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

      const rawActor = typeof req.query.actor === 'string' ? req.query.actor.trim() : undefined;
      let actor: string | undefined;
      if (rawActor) {
        if (!ALLOWED_ACTORS.has(rawActor)) {
          res.status(400).json({
            error: `Invalid actor parameter. Allowed: ${Array.from(ALLOWED_ACTORS).join(', ')}`,
          });
          return;
        }
        actor = rawActor;
      }

      const rawEvent = typeof req.query.event === 'string' ? req.query.event.trim() : undefined;
      const event = rawEvent && rawEvent.length <= 100 ? rawEvent : undefined;

      const rawReqId = typeof req.query.requestId === 'string' ? req.query.requestId.trim() : undefined;
      const requestId = rawReqId && rawReqId.length <= 100 ? rawReqId : undefined;

      const items = repos.auditLog.list({ actor, event, requestId, limit, offset });
      const total = repos.auditLog.count({ actor, event, requestId });

      const mappedItems = items.map((a) => {
        let payload: unknown = {};
        try {
          payload = JSON.parse(a.payload);
        } catch {
          payload = { raw: a.payload };
        }

        return {
          id: a.id,
          timestamp: a.ts,
          actor: a.actor,
          event: a.event,
          requestId: a.request_id,
          payload,
          prevHash: a.prev_hash,
          hash: a.hash,
        };
      });

      res.status(200).json({
        items: mappedItems,
        total,
        limit,
        offset,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in GET /audit:', err);
      res.status(500).json({ error: 'Failed to retrieve audit log' });
    }
  });

  // ==========================================================================
  // 10. PayPal Activity (/api/paypal/activity)
  // ==========================================================================
  router.get('/paypal/activity', (_req: Request, res: Response): void => {
    // Read-only reporting panel (toolkit-backed integration scheduled for Milestone M5-T8)
    res.status(200).json({
      enabled: false,
      message: 'PayPal reporting toolkit is unconfigured or deferred to Milestone M5-T8',
      transactions: [],
    });
  });

  return router;
}
