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
import { writeAuditLogEntry } from '../core/stateMachine.js';
import {
  ApprovalExecutionService,
  ApprovalValidationError,
} from '../approvals/service.js';
import { getRollingBudgets } from '../core/facts.js';
import { PolicyDocumentSchema, type Decision, type PolicyDocument } from '../policy/types.js';

class PolicyValidationError extends Error {
  constructor(message: string, public readonly details: unknown) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}
import {
  explainPolicyDecision,
  type PolicyExplanationContext,
} from '../policy/explanations.js';
import { generateAgentKey } from '../mcp/auth.js';
import type { AgentRow, VendorRow, PolicyVersionRow, PolicyProposalRow, ProposalStatus } from '../db/types.js';
import type { AiService } from '../ai/service.js';
import { RiskExplainer, type AiRiskExplanationResponse } from '../ai/riskExplainer.js';
import { PolicyDrafter, PolicyDrafterError, computeProposalHash } from '../ai/policyDrafter.js';
import { getConfig, validateHardCapWithinCeiling } from '../config/index.js';

// ============================================================================
// Types & Options
// ============================================================================

export interface OwnerApiRouterOptions {
  readonly db: Database;
  readonly repos: Repositories;
  readonly sessionStore: OwnerSessionStore;
  readonly isProduction?: boolean;
  readonly publicBaseUrl?: string;
  readonly secureCookie?: boolean;
  readonly maxHardCapMinor?: MinorUnits;
  readonly authorizationsService?: PayPalAuthorizationsService;
  readonly ordersService?: PayPalOrdersService;
  readonly aiService?: AiService;
  readonly approvalExecutionService?: ApprovalExecutionService;
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
  const { db, repos, sessionStore, authorizationsService, ordersService, aiService, logger } = options;
  const resolveMaxHardCapMinor = (): MinorUnits =>
    options.maxHardCapMinor ?? getConfig().maxHardCapMinor;
  const approvalExecutionService =
    options.approvalExecutionService ??
    new ApprovalExecutionService({
      db,
      repos,
      authorizationsService,
      ordersService,
      ...('publicBaseUrl' in options ? { publicBaseUrl: options.publicBaseUrl } : {}),
      ...('isProduction' in options ? { isProduction: options.isProduction } : {}),
      logger,
    });

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
  const ownerAuthMiddleware = createOwnerAuthMiddleware(sessionStore, {
    isProduction: options.isProduction,
    secureCookie: options.secureCookie,
  });
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
          paypalOrderId: r.paypal_order_id,
          paypalAuthorizationId: r.paypal_authorization_id,
          paypalCaptureId: r.paypal_capture_id,
          remoteVoidStatus: r.remote_void_status ?? null,
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
          paypalOrderId: r.paypal_order_id,
          paypalAuthorizationId: r.paypal_authorization_id,
          paypalCaptureId: r.paypal_capture_id,
          remoteVoidStatus: r.remote_void_status ?? null,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
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
        await approvalExecutionService.expireHoldTracked(requestId);
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

      // Build deterministic policy explanation context (M5-T2)
      let autoLimitMinor: number | undefined;
      let hardCapMinor: number | undefined;
      let agentBudgetMinor: number | undefined;
      let globalBudgetMinor: number | undefined;
      let velocityWindowMinutes: number | undefined;
      let velocityMaxRequests: number | undefined;
      let duplicateWindowMinutes: number | undefined;
      let newVendorAction: 'HOLD' | 'DENY' | undefined;
      let allowedCurrencies: string[] | undefined;
      let vendorCategories: string[] | undefined;

      const readNonNegativeInt = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0
          ? Math.floor(value)
          : undefined;
      const readPositiveInt = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) && value >= 1
          ? Math.floor(value)
          : undefined;

      if (vendor?.categories) {
        try {
          const parsedCats: unknown = JSON.parse(vendor.categories);
          if (Array.isArray(parsedCats)) {
            vendorCategories = parsedCats.filter(
              (c): c is string => typeof c === 'string' && c.trim().length > 0
            );
          }
        } catch {
          // Safe degradation: ignore malformed vendor categories JSON
        }
      }

      try {
        const policyVersion =
          (request.policy_version_id
            ? repos.policyVersions.getById(request.policy_version_id)
            : undefined) ?? repos.policyVersions.getActive();

        if (policyVersion?.rules) {
          const parsedRules: unknown = JSON.parse(policyVersion.rules);
          if (parsedRules && typeof parsedRules === 'object' && !Array.isArray(parsedRules)) {
            const rules = parsedRules as Record<string, unknown>;
            autoLimitMinor = readNonNegativeInt(rules.auto_limit_minor);
            hardCapMinor = readNonNegativeInt(rules.hard_cap_minor);
            agentBudgetMinor = readNonNegativeInt(rules.agent_daily_budget_minor);
            globalBudgetMinor = readNonNegativeInt(rules.global_daily_budget_minor);
            duplicateWindowMinutes = readNonNegativeInt(rules.duplicate_window_minutes);

            if (rules.velocity && typeof rules.velocity === 'object' && !Array.isArray(rules.velocity)) {
              const vel = rules.velocity as Record<string, unknown>;
              velocityMaxRequests = readPositiveInt(vel.max_requests);
              velocityWindowMinutes = readPositiveInt(vel.window_minutes);
            }

            if (rules.new_vendor_action === 'HOLD' || rules.new_vendor_action === 'DENY') {
              newVendorAction = rules.new_vendor_action;
            }

            if (Array.isArray(rules.currency_allowlist)) {
              const currencies = rules.currency_allowlist
                .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
                .map((c) => c.trim());
              if (currencies.length > 0) {
                allowedCurrencies = currencies;
              }
            }
          }
        }
      } catch {
        // Safe degradation: explanation engine handles missing context gracefully
      }

      const explanationContext: PolicyExplanationContext = {
        agentId: request.agent_id,
        agentName: agent?.name,
        vendorId: request.vendor_id,
        vendorName: vendor?.name,
        amountMinor: request.amount_minor,
        currency: request.currency,
        category: request.category,
        purpose: request.purpose,
        autoLimitMinor,
        hardCapMinor,
        agentBudgetMinor,
        globalBudgetMinor,
        velocityWindowMinutes,
        velocityMaxRequests,
        duplicateWindowMinutes,
        newVendorAction,
        allowedCurrencies,
        vendorCategories,
      };

      const explanation = explainPolicyDecision(
        (request.decision as Decision) ?? 'HOLD',
        reasons,
        explanationContext
      );

      let aiRiskExplanation: AiRiskExplanationResponse | null = null;
      if (options.aiService) {
        try {
          const riskExplainer = new RiskExplainer(options.aiService);
          aiRiskExplanation = await riskExplainer.explainRisk({
            requestId: request.id,
            decision: (request.decision as Decision) ?? 'HOLD',
            reasons,
            vendorId: request.vendor_id,
            vendorName: vendor?.name,
            agentId: request.agent_id,
            agentName: agent?.name,
            amountMinor: request.amount_minor,
            currency: request.currency,
            category: request.category,
            purpose: request.purpose,
            sourceContextExcerpt: request.source_context_excerpt,
          });
        } catch (err: unknown) {
          logger?.warn?.('[OwnerApi] AI RiskExplainer failed gracefully:', err);
          aiRiskExplanation = null;
        }
      }

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
        explanation,
        aiRiskExplanation,
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
    const requestId = req.params.id as string;
    const ownerSession = req.ownerSession!;

    try {
      const outcome = await approvalExecutionService.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'dashboard',
          requestId,
          ownerId: ownerSession.ownerId,
          ownerDisplayName: ownerSession.displayName,
        },
      });

      if (outcome.action === 'APPROVE') {
        if (outcome.status === 'CAPTURED') {
          res.status(200).json({
            success: true,
            requestId: outcome.requestId,
            status: outcome.status,
            executedAction: outcome.executedAction,
            captureId: outcome.captureId,
          });
          return;
        }

        if (outcome.status === 'CAPTURING') {
          res.status(202).json({
            success: false,
            requestId: outcome.requestId,
            status: outcome.status,
            error: outcome.error,
            message: outcome.message,
            warning: outcome.message,
            reconciliationRequired: outcome.reconciliationRequired,
          });
          return;
        }

        if (outcome.status === 'FAILED') {
          res.status(500).json({
            success: false,
            requestId: outcome.requestId,
            status: outcome.status,
            error: outcome.error,
            message: outcome.message,
          });
          return;
        }
      }

      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Unexpected execution state',
      });
    } catch (err: unknown) {
      if (err instanceof ApprovalValidationError) {
        if (err.code === 'HOLD_EXPIRED') {
          await approvalExecutionService.expireHoldTracked(requestId);
        }
        res.status(err.statusCode).json({
          error: err.code === 'REQUEST_NOT_FOUND' ? err.message : err.code,
          message: err.message,
        });
        return;
      }

      logger?.error?.('[OwnerApi] Error in POST /requests/:id/approve:', err);
      res.status(500).json({
        success: false,
        error: 'EXECUTION_ERROR',
        message: 'Failed to execute payment approval',
      });
    }
  });

  // ==========================================================================
  // 5. Direct Owner Void (/api/requests/:id/void)
  // ==========================================================================
  router.post('/requests/:id/void', async (req: Request, res: Response): Promise<void> => {
    const requestId = req.params.id as string;
    const ownerSession = req.ownerSession!;
    const voidReason =
      typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : 'Owner voided hold from dashboard';

    try {
      const outcome = await approvalExecutionService.execute({
        action: 'VOID',
        credentials: {
          channel: 'dashboard',
          requestId,
          ownerId: ownerSession.ownerId,
          ownerDisplayName: ownerSession.displayName,
          reason: voidReason,
        },
      });

      if (outcome.action === 'VOID') {
        if (outcome.alreadyVoided || outcome.remoteVoidSuccess) {
          res.status(200).json({
            success: true,
            requestId: outcome.requestId,
            status: outcome.status,
            remoteVoidStatus: outcome.remoteVoidStatus,
            remoteVoidSuccess: outcome.remoteVoidSuccess,
            ...(outcome.message ? { message: outcome.message } : {}),
          });
          return;
        }

        res.status(202).json({
          success: true,
          requestId: outcome.requestId,
          status: outcome.status,
          remoteVoidStatus: outcome.remoteVoidStatus,
          remoteVoidSuccess: false,
          reconciliationRequired: true,
          message: outcome.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Unexpected execution state',
      });
    } catch (err: unknown) {
      if (err instanceof ApprovalValidationError) {
        if (err.code === 'HOLD_EXPIRED') {
          const expiryResult = await approvalExecutionService.expireHoldTracked(requestId);
          if (expiryResult.expired) {
            const remoteVoidStatus = expiryResult.remoteVoidStatus ?? 'PENDING';
            const confirmed = remoteVoidStatus === 'CONFIRMED';
            res.status(confirmed ? 200 : 202).json({
              success: true,
              requestId,
              status: 'VOIDED',
              remoteVoidStatus,
              remoteVoidSuccess: confirmed,
              ...(confirmed ? {} : { reconciliationRequired: true }),
              message: 'Payment hold expired and voided',
            });
            return;
          }

          const currentReq = repos.paymentRequests.getById(requestId);
          if (currentReq?.status === 'VOIDED') {
            const currentVoidStatus = currentReq.remote_void_status ?? 'CONFIRMED';
            const confirmed = currentVoidStatus === 'CONFIRMED';
            res.status(confirmed ? 200 : 202).json({
              success: true,
              requestId,
              status: 'VOIDED',
              remoteVoidStatus: currentVoidStatus,
              remoteVoidSuccess: confirmed,
              ...(confirmed ? {} : { reconciliationRequired: true }),
              message: 'Payment hold expired and voided',
            });
            return;
          }
        }

        res.status(err.statusCode).json({
          error: err.code === 'REQUEST_NOT_FOUND' ? err.message : err.code,
          message: err.message,
        });
        return;
      }

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

  // ==========================================================================
  // Helper: Proposal Activation Handler
  // ==========================================================================
  const handleProposalActivation = async (
    req: Request,
    res: Response,
    explicitProposalId?: string
  ): Promise<void> => {
    try {
      const rawBody = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const proposalId = explicitProposalId ?? (typeof rawBody.proposalId === 'string' ? rawBody.proposalId.trim() : '');
      const clientProposalHash = typeof rawBody.proposalHash === 'string' ? rawBody.proposalHash.trim() : undefined;
      const acknowledgeRelaxations = rawBody.acknowledgeRelaxations === true;

      if (!proposalId) {
        res.status(400).json({ error: 'INVALID_PROPOSAL_ID', message: 'Proposal ID is required' });
        return;
      }

      // Step 1: Pre-fetch proposal
      const proposal = repos.policyProposals.getById(proposalId);
      if (!proposal) {
        res.status(404).json({ error: 'PROPOSAL_NOT_FOUND', message: 'Policy proposal not found' });
        return;
      }

      // Step 2: Ownership verification (Safeguard 1)
      const currentOwnerId = req.ownerSession?.ownerId || 'default';
      if (proposal.owner_id !== currentOwnerId) {
        res.status(403).json({ error: 'FORBIDDEN', message: 'Proposal belongs to another owner or session' });
        return;
      }

      // Step 3: Status checks
      if (proposal.status === 'ACTIVATED') {
        res.status(409).json({ error: 'ALREADY_ACTIVATED', message: 'Proposal has already been activated' });
        return;
      }
      if (proposal.status === 'REJECTED') {
        res.status(409).json({ error: 'ALREADY_REJECTED', message: 'Proposal has been rejected' });
        return;
      }

      // Step 4: Lazy Expiry Check
      const nowIso = new Date().toISOString();
      const isExpired = proposal.status === 'EXPIRED' || new Date(proposal.expires_at).getTime() <= Date.now();
      if (isExpired) {
        if (proposal.status !== 'EXPIRED') {
          runInTransaction(db, () => {
            repos.policyProposals.updateStatus(proposal.id, 'EXPIRED', nowIso);
            writeAuditLogEntry(db, repos, {
              actor: 'system',
              event: 'POLICY_PROPOSAL_EXPIRED',
              timestamp: nowIso,
              payload: {
                proposal_id: proposal.id,
                base_version: proposal.base_version,
              },
            });
          });
        }
        res.status(410).json({ error: 'PROPOSAL_EXPIRED', message: 'Policy proposal has expired and cannot be activated' });
        return;
      }

      // Step 5: Hash verification (Safeguards 4 & 5)
      // If client provided proposalHash, it MUST match the proposal's stored hash
      if (clientProposalHash && clientProposalHash !== proposal.proposal_hash) {
        res.status(400).json({
          error: 'PROPOSAL_HASH_MISMATCH',
          message: 'Client provided proposal hash does not match stored proposal hash',
        });
        return;
      }

      // Recompute hash from stored rules to verify DB record has not been tampered with
      let rawParsedRules: unknown;
      try {
        rawParsedRules = JSON.parse(proposal.rules);
      } catch {
        res.status(400).json({ error: 'CORRUPTED_RULES', message: 'Stored proposal rules are malformed JSON' });
        return;
      }

      const rulesParse = PolicyDocumentSchema.safeParse({
        ...(rawParsedRules as Record<string, unknown>),
        version: proposal.base_version,
      });
      if (!rulesParse.success) {
        res.status(400).json({
          error: 'RULE_CONSTRAINT_VIOLATION',
          message: 'Stored proposal rules failed schema validation',
          details: rulesParse.error.format(),
        });
        return;
      }

      const { version: _storedV, ...validatedStoredRules } = rulesParse.data;
      const recomputedHash = computeProposalHash(proposal.base_version, validatedStoredRules);
      if (recomputedHash !== proposal.proposal_hash) {
        res.status(400).json({
          error: 'PROPOSAL_HASH_TAMPERED',
          message: 'Stored proposal hash does not match recomputed rules hash',
        });
        return;
      }

      const effectiveMaxHardCapMinor = resolveMaxHardCapMinor();
      const storedCeilingCheck = validateHardCapWithinCeiling(
        validatedStoredRules.hard_cap_minor,
        effectiveMaxHardCapMinor
      );
      if (!storedCeilingCheck.valid) {
        res.status(400).json({
          error: 'RULE_CONSTRAINT_VIOLATION',
          message:
            storedCeilingCheck.message ??
            'Proposed policy exceeds configured MAX_HARD_CAP_MINOR ceiling',
          details: {
            field: 'hard_cap_minor',
            hard_cap_minor: validatedStoredRules.hard_cap_minor,
            max_hard_cap_minor: effectiveMaxHardCapMinor,
          },
        });
        return;
      }

      // Step 6: Relaxation acknowledgement check (Safeguard 6)
      if (proposal.has_relaxations === 1 && !acknowledgeRelaxations) {
        let relaxationsList: unknown[] = [];
        try {
          relaxationsList = JSON.parse(proposal.relaxations);
        } catch {
          relaxationsList = [];
        }
        res.status(400).json({
          error: 'RELAXATION_ACKNOWLEDGEMENT_REQUIRED',
          message: 'This policy proposal contains relaxations that must be explicitly acknowledged',
          relaxations: relaxationsList,
        });
        return;
      }

      // Step 7: Atomic SQLite Transaction (Safeguard 7)
      let claimResult: {
        success: boolean;
        statusCode?: number;
        error?: string;
        message?: string;
        details?: unknown;
        policy?: {
          id: string;
          version: number;
          rules: unknown;
          author: string;
          active: boolean;
          createdAt: string;
        };
      };

      try {
        claimResult = runInTransaction(db, () => {
          // A. Concurrency Check: re-check active policy version
          const currentActive = repos.policyVersions.getActive();
          if (!currentActive || currentActive.version !== proposal.base_version) {
            return {
              success: false,
              statusCode: 409,
              error: 'CONCURRENCY_CONFLICT',
              message: `Active policy version (${currentActive?.version ?? 'none'}) does not match proposal base version (${proposal.base_version})`,
            };
          }

          // B. Next version number
          const nextVersion = repos.policyVersions.getNextVersion();

          // C. Validate canonical schema for candidate doc
          const candidateDoc = {
            ...validatedStoredRules,
            version: nextVersion,
          };
          const parseResult = PolicyDocumentSchema.safeParse(candidateDoc);
          if (!parseResult.success) {
            return {
              success: false,
              statusCode: 400,
              error: 'RULE_CONSTRAINT_VIOLATION',
              message: 'Policy document validation failed',
              details: parseResult.error.format(),
            };
          }

          const txCeilingCheck = validateHardCapWithinCeiling(
            parseResult.data.hard_cap_minor,
            effectiveMaxHardCapMinor
          );
          if (!txCeilingCheck.valid) {
            return {
              success: false,
              statusCode: 400,
              error: 'RULE_CONSTRAINT_VIOLATION',
              message:
                txCeilingCheck.message ??
                'Policy exceeds configured MAX_HARD_CAP_MINOR ceiling',
              details: {
                field: 'hard_cap_minor',
                hard_cap_minor: parseResult.data.hard_cap_minor,
                max_hard_cap_minor: effectiveMaxHardCapMinor,
              },
            };
          }

          // D. Transition proposal status to ACTIVATED
          const transitioned = repos.policyProposals.updateStatus(proposal.id, 'ACTIVATED', nowIso);
          if (!transitioned) {
            return {
              success: false,
              statusCode: 409,
              error: 'ALREADY_ACTIVATED',
              message: 'Proposal status could not be transitioned to ACTIVATED (already processed)',
            };
          }

          // E. Insert new immutable policy version
          const newPolicyId = `pol-${crypto.randomUUID()}`;
          const newPolicyRow: PolicyVersionRow = {
            id: newPolicyId,
            version: nextVersion,
            rules: JSON.stringify(parseResult.data),
            author: 'ai_draft_confirmed',
            active: 0,
            created_at: nowIso,
          };
          repos.policyVersions.insert(newPolicyRow);

          // F. Set active
          repos.policyVersions.setActive(newPolicyId);

          // G. Write audit log entry in the same transaction
          writeAuditLogEntry(db, repos, {
            actor: 'owner',
            event: 'POLICY_ACTIVATED',
            timestamp: nowIso,
            payload: {
              proposal_id: proposal.id,
              policy_version_id: newPolicyId,
              version: nextVersion,
              base_version: proposal.base_version,
              author: 'ai_draft_confirmed',
              has_relaxations: proposal.has_relaxations === 1,
              proposal_hash: proposal.proposal_hash,
            },
          });

          return {
            success: true,
            policy: {
              id: newPolicyId,
              version: nextVersion,
              rules: parseResult.data,
              author: 'ai_draft_confirmed',
              active: true,
              createdAt: nowIso,
            },
          };
        });
      } catch (txErr: unknown) {
        logger?.error?.('[OwnerApi] Transaction error during policy activation:', txErr);
        res.status(500).json({ error: 'TRANSACTION_FAILED', message: 'Failed to atomically activate policy' });
        return;
      }

      if (!claimResult.success || !claimResult.policy) {
        res.status(claimResult.statusCode ?? 400).json({
          error: claimResult.error,
          message: claimResult.message,
          details: claimResult.details,
        });
        return;
      }

      res.status(200).json({
        success: true,
        id: claimResult.policy.id,
        version: claimResult.policy.version,
        rules: claimResult.policy.rules,
        author: claimResult.policy.author,
        active: claimResult.policy.active,
        createdAt: claimResult.policy.createdAt,
        proposalId: proposal.id,
        policy: claimResult.policy,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in handleProposalActivation:', err);
      res.status(500).json({ error: 'Failed to activate policy proposal' });
    }
  };

  // ==========================================================================
  // Helper: Proposal Rejection Handler
  // ==========================================================================
  const handleProposalRejection = async (
    req: Request,
    res: Response,
    explicitProposalId?: string
  ): Promise<void> => {
    try {
      const rawBody = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const proposalId = explicitProposalId ?? (typeof rawBody.proposalId === 'string' ? rawBody.proposalId.trim() : '');
      const reason = typeof rawBody.reason === 'string' && rawBody.reason.trim() ? rawBody.reason.trim() : 'Rejected by owner';

      if (!proposalId) {
        res.status(400).json({ error: 'INVALID_PROPOSAL_ID', message: 'Proposal ID is required' });
        return;
      }

      const proposal = repos.policyProposals.getById(proposalId);
      if (!proposal) {
        res.status(404).json({ error: 'PROPOSAL_NOT_FOUND', message: 'Policy proposal not found' });
        return;
      }

      // Ownership verification
      const currentOwnerId = req.ownerSession?.ownerId || 'default';
      if (proposal.owner_id !== currentOwnerId) {
        res.status(403).json({ error: 'FORBIDDEN', message: 'Proposal belongs to another owner or session' });
        return;
      }

      if (proposal.status === 'ACTIVATED') {
        res.status(409).json({ error: 'ALREADY_ACTIVATED', message: 'Proposal has already been activated' });
        return;
      }
      if (proposal.status === 'REJECTED') {
        res.status(409).json({ error: 'ALREADY_REJECTED', message: 'Proposal has been rejected' });
        return;
      }

      const nowIso = new Date().toISOString();
      const isExpired = proposal.status === 'EXPIRED' || new Date(proposal.expires_at).getTime() <= Date.now();
      if (isExpired) {
        if (proposal.status !== 'EXPIRED') {
          runInTransaction(db, () => {
            repos.policyProposals.updateStatus(proposal.id, 'EXPIRED', nowIso);
            writeAuditLogEntry(db, repos, {
              actor: 'system',
              event: 'POLICY_PROPOSAL_EXPIRED',
              timestamp: nowIso,
              payload: {
                proposal_id: proposal.id,
                base_version: proposal.base_version,
              },
            });
          });
        }
        res.status(410).json({ error: 'PROPOSAL_EXPIRED', message: 'Policy proposal has expired and cannot be rejected' });
        return;
      }

      let rejectionResult: { success: boolean; statusCode?: number; error?: string; message?: string };
      try {
        rejectionResult = runInTransaction(db, () => {
          const transitioned = repos.policyProposals.updateStatus(proposal.id, 'REJECTED', nowIso);
          if (!transitioned) {
            return {
              success: false,
              statusCode: 409,
              error: 'ALREADY_REJECTED',
              message: 'Proposal could not be transitioned to REJECTED',
            };
          }

          writeAuditLogEntry(db, repos, {
            actor: 'owner',
            event: 'POLICY_PROPOSAL_REJECTED',
            timestamp: nowIso,
            payload: {
              proposal_id: proposal.id,
              base_version: proposal.base_version,
              reason,
            },
          });

          return { success: true };
        });
      } catch (txErr: unknown) {
        logger?.error?.('[OwnerApi] Transaction error during policy proposal rejection:', txErr);
        res.status(500).json({ error: 'TRANSACTION_FAILED', message: 'Failed to atomically reject policy proposal' });
        return;
      }

      if (!rejectionResult.success) {
        res.status(rejectionResult.statusCode ?? 400).json({
          error: rejectionResult.error,
          message: rejectionResult.message,
        });
        return;
      }

      res.status(200).json({
        success: true,
        proposalId: proposal.id,
        status: 'REJECTED',
        reason,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in handleProposalRejection:', err);
      res.status(500).json({ error: 'Failed to reject policy proposal' });
    }
  };

  // POST /policies — Direct creation or proposal activation
  router.post('/policies', async (req: Request, res: Response): Promise<void> => {
    try {
      const rawBody = req.body as Record<string, unknown>;
      if (!rawBody || typeof rawBody !== 'object') {
        res.status(400).json({ error: 'Invalid policy payload: object expected' });
        return;
      }

      // If proposalId is provided, delegate to proposal activation
      if (typeof rawBody.proposalId === 'string' && rawBody.proposalId.trim()) {
        await handleProposalActivation(req, res);
        return;
      }

      let createdPolicy: {
        id: string;
        version: number;
        rules: PolicyDocument;
        createdAt: string;
      };

      try {
        createdPolicy = runInTransaction(db, () => {
          // Determine next version number atomically inside transaction
          const nextVersion = repos.policyVersions.getNextVersion();

          // Merge with version for canonical schema validation
          const candidateDoc = {
            ...rawBody,
            version: nextVersion,
          };

          const parseResult = PolicyDocumentSchema.safeParse(candidateDoc);
          if (!parseResult.success) {
            throw new PolicyValidationError('Policy document validation failed', parseResult.error.format());
          }

          const validatedRules = parseResult.data;
          const effectiveMaxHardCapMinor = resolveMaxHardCapMinor();
          const ceilingCheck = validateHardCapWithinCeiling(
            validatedRules.hard_cap_minor,
            effectiveMaxHardCapMinor
          );
          if (!ceilingCheck.valid) {
            throw new PolicyValidationError(
              ceilingCheck.message ?? 'Policy exceeds configured MAX_HARD_CAP_MINOR ceiling',
              {
                field: 'hard_cap_minor',
                hard_cap_minor: validatedRules.hard_cap_minor,
                max_hard_cap_minor: effectiveMaxHardCapMinor,
              }
            );
          }

          const newPolicyId = `pol-${crypto.randomUUID()}`;
          const nowIso = new Date().toISOString();

          // Insert new policy first with active = 0 to avoid unique constraint conflict
          repos.policyVersions.insert({
            id: newPolicyId,
            version: nextVersion,
            rules: JSON.stringify(validatedRules),
            author: 'owner',
            active: 0,
            created_at: nowIso,
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

          return {
            id: newPolicyId,
            version: nextVersion,
            rules: validatedRules,
            createdAt: nowIso,
          };
        });
      } catch (err: unknown) {
        if (err instanceof PolicyValidationError) {
          res.status(400).json({
            error: err.message,
            details: err.details,
          });
          return;
        }
        logger?.error?.('[OwnerApi] Error in POST /policies:', err);
        res.status(500).json({ error: 'Failed to create and activate policy version' });
        return;
      }

      res.status(201).json({
        id: createdPolicy.id,
        version: createdPolicy.version,
        rules: createdPolicy.rules,
        author: 'owner',
        active: true,
        createdAt: createdPolicy.createdAt,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in POST /policies:', err);
      res.status(500).json({ error: 'Failed to create and activate policy version' });
    }
  });

  // POST /policies/draft — Draft policy proposal via AI PolicyDrafter
  router.post('/policies/draft', async (req: Request, res: Response): Promise<void> => {
    try {
      const rawBody = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
      const prompt = typeof rawBody.prompt === 'string' ? rawBody.prompt.trim() : '';
      const rawTtl = typeof rawBody.ttlMinutes === 'number' ? rawBody.ttlMinutes : undefined;
      const ttlMinutes = rawTtl && Number.isInteger(rawTtl) && rawTtl > 0 ? Math.min(rawTtl, 1440) : 60;

      if (!prompt) {
        res.status(400).json({
          error: 'INVALID_PROMPT',
          message: 'Policy authoring prompt must be a non-empty string',
        });
        return;
      }

      if (prompt.length > 2000) {
        res.status(400).json({
          error: 'INVALID_PROMPT',
          message: 'Policy authoring prompt exceeds maximum allowed length of 2000 characters',
        });
        return;
      }

      if (!aiService) {
        res.status(503).json({
          error: 'AI_SERVICE_UNAVAILABLE',
          message: 'AI service is not configured or available',
        });
        return;
      }

      const activePolicy = repos.policyVersions.getActive();
      if (!activePolicy) {
        res.status(500).json({
          error: 'NO_ACTIVE_POLICY',
          message: 'No active policy found in repository',
        });
        return;
      }

      let parsedActive: unknown;
      try {
        parsedActive = JSON.parse(activePolicy.rules);
      } catch {
        res.status(500).json({
          error: 'MALFORMED_ACTIVE_POLICY',
          message: 'Current active policy rules are malformed JSON',
        });
        return;
      }

      const activeParse = PolicyDocumentSchema.safeParse({
        ...(parsedActive as Record<string, unknown>),
        version: activePolicy.version,
      });
      if (!activeParse.success) {
        res.status(500).json({
          error: 'MALFORMED_ACTIVE_POLICY',
          message: 'Active policy rules failed schema validation',
          details: activeParse.error.format(),
        });
        return;
      }

      const { version: _actV, ...activeClean } = activeParse.data;
      const effectiveMaxHardCapMinor = resolveMaxHardCapMinor();

      const drafter = new PolicyDrafter(aiService, undefined, {
        maxHardCapMinor: effectiveMaxHardCapMinor,
      });

      let draftResult;
      try {
        draftResult = await drafter.draftPolicy({
          prompt,
          activePolicy: activeClean,
          baseVersion: activePolicy.version,
          maxHardCapMinor: effectiveMaxHardCapMinor,
        });
      } catch (drafterErr: unknown) {
        if (drafterErr instanceof PolicyDrafterError) {
          let status = 400;
          let errorCode = drafterErr.code;

          if (drafterErr.code === 'INJECTION_SCAN_INDETERMINATE') {
            status = 422;
          } else if (
            drafterErr.code === 'AI_RATE_LIMITED' ||
            drafterErr.code === 'AI_SERVICE_RATE_LIMITED'
          ) {
            status = 429;
            errorCode = 'AI_SERVICE_RATE_LIMITED';
          } else if (
            drafterErr.code === 'AI_TIMEOUT' ||
            drafterErr.code === 'AI_SERVICE_TIMEOUT'
          ) {
            status = 504;
            errorCode = 'AI_SERVICE_TIMEOUT';
          } else if (
            drafterErr.code === 'AI_PROVIDER_ERROR' ||
            drafterErr.code === 'AI_SERVICE_UNAVAILABLE'
          ) {
            status = 502;
            errorCode = 'AI_SERVICE_UNAVAILABLE';
          }

          res.status(status).json({
            error: errorCode,
            message: drafterErr.message,
            details: drafterErr.details,
          });
          return;
        }
        throw drafterErr;
      }

      const proposalId = `prop-${crypto.randomUUID()}`;
      const nowIso = new Date().toISOString();
      const expiresAtIso = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
      const ownerId = req.ownerSession?.ownerId || 'default';

      const proposalRow: PolicyProposalRow = {
        id: proposalId,
        base_version: draftResult.baseVersion,
        rules: JSON.stringify(draftResult.proposedRules),
        proposal_hash: draftResult.proposalHash,
        has_relaxations: draftResult.hasRelaxations ? 1 : 0,
        relaxations: JSON.stringify(draftResult.relaxations),
        diff: JSON.stringify(draftResult.diff),
        explanation: draftResult.explanation,
        unsupported_requests: JSON.stringify(draftResult.unsupportedRequests),
        owner_id: ownerId,
        status: 'PENDING',
        created_at: nowIso,
        expires_at: expiresAtIso,
        activated_at: null,
        rejected_at: null,
      };

      runInTransaction(db, () => {
        repos.policyProposals.insert(proposalRow);
        writeAuditLogEntry(db, repos, {
          actor: 'owner',
          event: 'POLICY_PROPOSAL_GENERATED',
          timestamp: nowIso,
          payload: {
            proposal_id: proposalId,
            base_version: draftResult.baseVersion,
            proposal_hash: draftResult.proposalHash,
            has_relaxations: draftResult.hasRelaxations,
            model: draftResult.metadata.model,
            prompt,
          },
        });
      });

      res.status(201).json({
        id: proposalId,
        baseVersion: draftResult.baseVersion,
        rules: draftResult.proposedRules,
        proposalHash: draftResult.proposalHash,
        hasRelaxations: draftResult.hasRelaxations,
        relaxations: draftResult.relaxations,
        diff: draftResult.diff,
        explanation: draftResult.explanation,
        unsupportedRequests: draftResult.unsupportedRequests,
        status: 'PENDING',
        createdAt: nowIso,
        expiresAt: expiresAtIso,
        metadata: draftResult.metadata,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in POST /policies/draft:', err);
      res.status(500).json({ error: 'Failed to draft policy proposal' });
    }
  });

  // GET /policies/drafts — List policy proposals
  router.get('/policies/drafts', (req: Request, res: Response): void => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status.trim().toUpperCase() : undefined;
      const validStatus = statusParam && ['PENDING', 'ACTIVATED', 'REJECTED', 'EXPIRED'].includes(statusParam)
        ? (statusParam as ProposalStatus)
        : undefined;

      const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
      const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(1, rawLimit), 100) : 50;

      // Owner isolation: strictly filter proposals by authenticated owner session
      const ownerId = req.ownerSession?.ownerId || 'default';
      const proposals = repos.policyProposals.list({ ownerId, status: validStatus, limit });

      const mapped = proposals.map((p) => {
        let rules: unknown = {};
        let diff: unknown = [];
        let relaxations: unknown = [];
        let unsupportedRequests: unknown = [];
        try { rules = JSON.parse(p.rules); } catch { rules = { raw: p.rules }; }
        try { diff = JSON.parse(p.diff); } catch { diff = []; }
        try { relaxations = JSON.parse(p.relaxations); } catch { relaxations = []; }
        try { unsupportedRequests = JSON.parse(p.unsupported_requests); } catch { unsupportedRequests = []; }

        return {
          id: p.id,
          baseVersion: p.base_version,
          rules,
          proposalHash: p.proposal_hash,
          hasRelaxations: p.has_relaxations === 1,
          relaxations,
          diff,
          explanation: p.explanation,
          unsupportedRequests,
          ownerId: p.owner_id,
          status: p.status,
          createdAt: p.created_at,
          expiresAt: p.expires_at,
          activatedAt: p.activated_at,
          rejectedAt: p.rejected_at,
        };
      });

      res.status(200).json({ drafts: mapped, total: mapped.length });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in GET /policies/drafts:', err);
      res.status(500).json({ error: 'Failed to retrieve policy proposals' });
    }
  });

  // GET /policies/drafts/:id — Get proposal detail with lazy expiry
  router.get('/policies/drafts/:id', (req: Request, res: Response): void => {
    try {
      const proposalId = req.params.id as string;
      const proposal = repos.policyProposals.getById(proposalId);
      if (!proposal) {
        res.status(404).json({ error: 'PROPOSAL_NOT_FOUND', message: 'Policy proposal not found' });
        return;
      }

      // Ownership verification
      const currentOwnerId = req.ownerSession?.ownerId || 'default';
      if (proposal.owner_id !== currentOwnerId) {
        res.status(403).json({ error: 'FORBIDDEN', message: 'Proposal belongs to another owner or session' });
        return;
      }

      // Check lazy expiry
      const nowIso = new Date().toISOString();
      const isExpired = proposal.status === 'PENDING' && new Date(proposal.expires_at).getTime() <= Date.now();
      let currentStatus = proposal.status;

      if (isExpired) {
        runInTransaction(db, () => {
          repos.policyProposals.updateStatus(proposal.id, 'EXPIRED', nowIso);
          writeAuditLogEntry(db, repos, {
            actor: 'system',
            event: 'POLICY_PROPOSAL_EXPIRED',
            timestamp: nowIso,
            payload: {
              proposal_id: proposal.id,
              base_version: proposal.base_version,
            },
          });
        });
        currentStatus = 'EXPIRED';
      }

      let rules: unknown = {};
      let diff: unknown = [];
      let relaxations: unknown = [];
      let unsupportedRequests: unknown = [];
      try { rules = JSON.parse(proposal.rules); } catch { rules = { raw: proposal.rules }; }
      try { diff = JSON.parse(proposal.diff); } catch { diff = []; }
      try { relaxations = JSON.parse(proposal.relaxations); } catch { relaxations = []; }
      try { unsupportedRequests = JSON.parse(proposal.unsupported_requests); } catch { unsupportedRequests = []; }

      res.status(200).json({
        id: proposal.id,
        baseVersion: proposal.base_version,
        rules,
        proposalHash: proposal.proposal_hash,
        hasRelaxations: proposal.has_relaxations === 1,
        relaxations,
        diff,
        explanation: proposal.explanation,
        unsupportedRequests,
        ownerId: proposal.owner_id,
        status: currentStatus,
        createdAt: proposal.created_at,
        expiresAt: proposal.expires_at,
        activatedAt: proposal.activated_at,
        rejectedAt: proposal.rejected_at,
      });
    } catch (err: unknown) {
      logger?.error?.('[OwnerApi] Error in GET /policies/drafts/:id:', err);
      res.status(500).json({ error: 'Failed to retrieve proposal' });
    }
  });

  // Proposal Activation endpoints
  router.post('/policies/activate', (req: Request, res: Response) => handleProposalActivation(req, res));
  router.post('/policies/drafts/:id/activate', (req: Request, res: Response) => handleProposalActivation(req, res, req.params.id as string));

  // Proposal Rejection endpoints
  router.post('/policies/reject', (req: Request, res: Response) => handleProposalRejection(req, res));
  router.post('/policies/drafts/:id/reject', (req: Request, res: Response) => handleProposalRejection(req, res, req.params.id as string));

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
