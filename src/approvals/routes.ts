/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T3: Approval & Void HTTP Flow (src/approvals/routes.ts)
 *
 * Implements:
 * 1. GET /a/:token
 *    - Mobile-friendly approval review endpoint rendering strictly from snapshot data.
 *    - Requires authenticated owner session.
 *    - Read-only: never consumes tokens or executes payments.
 *    - Rejects expired, consumed, invalid, or snapshot-mismatched tokens.
 *    - Strict security headers (CSP frame-ancestors 'none', X-Frame-Options DENY).
 *    - Escapes all plain text; never renders raw agent or LLM HTML.
 *
 * 2. POST /a/:token/approve
 *    - Requires authenticated owner session + x-csrf-token header.
 *    - Verifies token is bound to 'APPROVE'.
 *    - Atomically claims token consumption and transitions request HELD -> APPROVED in SQLite.
 *    - Calls executeDecision() in src/core for Flow C capture (the only money-moving caller).
 *    - Handles ambiguous outcomes gracefully with handoff to reconciliation.
 *
 * 3. POST /a/:token/void
 *    - Requires authenticated owner session + x-csrf-token header.
 *    - Verifies token is bound to 'VOID'.
 *    - Atomically consumes token, inserts RELEASE ledger row, and transitions HELD -> VOIDED.
 *    - Voids remote PayPal authorization outside database transaction.
 *
 * Security Invariants:
 * - Hard Rule 1: Sandbox only. Never add code paths that use PayPal production.
 * - Hard Rule 2: Never expose raw credentials, secrets, or internal database rows.
 * - Hard Rule 3 & 4: Only executeDecision in src/core may call money-moving PayPal functions.
 * - Hard Rule 7: Every state transition writes an audit_log row in the same transaction.
 * - Hard Rule 8: Fail closed on any error or ambiguity.
 */

import { Router, type Request, type Response } from 'express';
import type { Database } from '../db/connection.js';
import { runInTransaction } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import { transitionPaymentRequest, writeAuditLogEntry } from '../core/stateMachine.js';
import { executeDecision, AmbiguousExecutionError, ExecuteDecisionError } from '../core/executeDecision.js';
import { formatMinorUnitsToDecimal } from '../core/money.js';
import type { PayPalOrdersService } from '../paypal/orders.js';
import type { PayPalAuthorizationsService } from '../paypal/authorizations.js';
import type { OwnerSessionStore } from '../auth/owner.js';
import { createOwnerAuthMiddleware } from '../auth/owner.js';
import {
  verifyApprovalToken,
  hashApprovalToken,
} from './tokens.js';
import { expirePaymentHold } from './expiry.js';
import * as crypto from 'node:crypto';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface ApprovalRouterOptions {
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

export interface ApprovalReviewData {
  readonly requestId: string;
  readonly action: 'APPROVE' | 'VOID';
  readonly status: string;
  readonly vendor: {
    readonly id: string;
    readonly name: string;
  };
  readonly amount: {
    readonly amountMinor: number;
    readonly amountDecimal: string;
    readonly currency: string;
  };
  readonly purpose: string;
  readonly category: string | null;
  readonly policyReasons: readonly string[];
  readonly sourceContextExcerpt: string | null;
  readonly expiresAt: string;
  readonly holdExpiresAt: string | null;
  readonly createdAt: string;
  readonly channel: string;
}

// ============================================================================
// HTML Escaping Helper (XSS Defense)
// ============================================================================

function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================================
// Mobile Review HTML Page Generator
// ============================================================================

function renderApprovalHtml(data: ApprovalReviewData, token: string, csrfToken: string): string {
  const isApprove = data.action === 'APPROVE';
  const actionColor = isApprove ? '#059669' : '#dc2626';
  const actionLabel = isApprove ? 'Approve Payment' : 'Void Payment Hold';
  const submitPath = isApprove ? `/a/${encodeURIComponent(token)}/approve` : `/a/${encodeURIComponent(token)}/void`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PayGuard — Payment Authorization</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; }
    body { margin: 0; padding: 1.5rem; display: flex; justify-content: center; align-items: center; min-height: 90vh; }
    .card { background: #1e293b; border-radius: 1rem; border: 1px solid #334155; padding: 1.5rem; max-width: 440px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
    .badge { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; background: #334155; color: #94a3b8; }
    .badge-hold { background: #854d0e; color: #fef08a; }
    .amount { font-size: 2.25rem; font-weight: 700; margin: 0.5rem 0 1.25rem; color: #f8fafc; }
    .currency { font-size: 1.25rem; font-weight: 500; color: #94a3b8; margin-left: 0.25rem; }
    .field { margin-bottom: 1rem; }
    .label { font-size: 0.75rem; text-transform: uppercase; font-weight: 600; color: #64748b; margin-bottom: 0.25rem; }
    .value { font-size: 0.95rem; color: #e2e8f0; line-height: 1.4; word-break: break-word; }
    .reasons { background: #0f172a; border-radius: 0.5rem; padding: 0.75rem; margin-top: 0.5rem; }
    .reason-tag { display: inline-block; background: #334155; color: #e2e8f0; font-size: 0.75rem; padding: 0.2rem 0.5rem; border-radius: 0.25rem; margin: 0.2rem; }
    .btn { display: block; width: 100%; padding: 0.85rem; border-radius: 0.5rem; border: none; font-size: 1rem; font-weight: 600; cursor: pointer; color: white; background: ${actionColor}; margin-top: 1.5rem; text-align: center; }
    .btn:hover { opacity: 0.92; }
    .btn-secondary { background: transparent; border: 1px solid #475569; color: #94a3b8; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="card">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
      <span style="font-weight: 700; font-size: 0.9rem; letter-spacing: 0.05em; color: #38bdf8;">PAYGUARD FIREWALL</span>
      <span class="badge badge-hold">HELD FOR REVIEW</span>
    </div>

    <div class="amount">$${escapeHtml(data.amount.amountDecimal)}<span class="currency">${escapeHtml(data.amount.currency)}</span></div>

    <div class="field">
      <div class="label">Vendor</div>
      <div class="value">${escapeHtml(data.vendor.name)} <span style="font-size: 0.8rem; color: #64748b;">(${escapeHtml(data.vendor.id)})</span></div>
    </div>

    <div class="field">
      <div class="label">Purpose</div>
      <div class="value">${escapeHtml(data.purpose)}</div>
    </div>

    ${data.category ? `
    <div class="field">
      <div class="label">Category</div>
      <div class="value">${escapeHtml(data.category)}</div>
    </div>` : ''}

    <div class="field">
      <div class="label">Policy Trigger Reason(s)</div>
      <div class="reasons">
        ${data.policyReasons.map((r) => `<span class="reason-tag">${escapeHtml(r)}</span>`).join('')}
      </div>
    </div>

    ${data.sourceContextExcerpt ? `
    <div class="field">
      <div class="label">Source Context Excerpt</div>
      <div class="value" style="font-family: monospace; font-size: 0.8rem; background: #0f172a; padding: 0.5rem; border-radius: 0.25rem;">${escapeHtml(data.sourceContextExcerpt)}</div>
    </div>` : ''}

    <div class="field">
      <div class="label">Hold Expiry</div>
      <div class="value" style="font-size: 0.85rem; color: #f59e0b;">${escapeHtml(data.expiresAt)}</div>
    </div>

    <form method="POST" action="${escapeHtml(submitPath)}" onsubmit="this.btnSubmit.disabled=true;">
      <input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">
      <button type="submit" name="btnSubmit" class="btn">${escapeHtml(actionLabel)}</button>
    </form>
  </div>
</body>
</html>`;
}

// ============================================================================
// Router Factory
// ============================================================================

export function createApprovalRouter(options: ApprovalRouterOptions): Router {
  const router = Router();
  const { db, repos, sessionStore } = options;

  // 1. Enforce strict security headers across all approval routes
  router.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
  });

  // 2. Enforce Owner Authentication (session cookie + CSRF on POST)
  const ownerAuth = createOwnerAuthMiddleware(sessionStore);
  router.use(ownerAuth);

  // ==========================================================================
  // GET /a/:token — Review Screen / Read-Only Inspection
  // ==========================================================================
  router.get('/:token', (req: Request, res: Response): void => {
    try {
      const rawToken = typeof req.params.token === 'string' ? req.params.token : '';
      if (!rawToken) {
        res.status(400).json({ success: false, error: 'INVALID_TOKEN_FORMAT', message: 'Token parameter is required' });
        return;
      }

      // 1. Verify approval token (pure read-only verification)
      const verification = verifyApprovalToken(db, repos, { rawToken });
      if (!verification.valid || !verification.approval || !verification.request) {
        if (verification.error === 'HOLD_EXPIRED' && verification.request) {
          void expirePaymentHold(db, verification.request.id, {
            repos,
            authorizationsService: options.authorizationsService,
            logger: options.logger,
          }).catch((err: unknown) => {
            options.logger?.error?.('[Routes] Error during lazy hold expiry on GET /a/:token:', err);
          });
        }

        const statusCode =
          verification.error === 'TOKEN_NOT_FOUND' || verification.error === 'INVALID_TOKEN_FORMAT'
            ? 404
            : verification.error === 'TOKEN_ALREADY_USED' || verification.error === 'TOKEN_EXPIRED' || verification.error === 'HOLD_EXPIRED'
            ? 410
            : 400;

        res.status(statusCode).json({
          success: false,
          error: verification.error,
          message: verification.message,
        });
        return;
      }

      const { approval, request } = verification;
      const vendor = repos.vendors.getById(request.vendor_id);
      const vendorName = vendor ? vendor.name : request.vendor_id;

      let policyReasons: string[] = [];
      try {
        policyReasons = request.reasons ? (JSON.parse(request.reasons) as string[]) : [];
      } catch {
        policyReasons = [];
      }

      const reviewData: ApprovalReviewData = {
        requestId: request.id,
        action: approval.action,
        status: request.status,
        vendor: {
          id: request.vendor_id,
          name: vendorName,
        },
        amount: {
          amountMinor: request.amount_minor,
          amountDecimal: formatMinorUnitsToDecimal(request.amount_minor),
          currency: request.currency,
        },
        purpose: request.purpose,
        category: request.category,
        policyReasons,
        sourceContextExcerpt: request.source_context_excerpt,
        expiresAt: approval.expires_at,
        holdExpiresAt: request.expires_at,
        createdAt: request.created_at,
        channel: approval.channel,
      };

      // Return HTML if specifically requested by a browser navigation, otherwise JSON
      if (req.accepts('html') && !req.accepts('json')) {
        const csrfToken = req.ownerSession?.csrfToken || '';
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderApprovalHtml(reviewData, rawToken, csrfToken));
        return;
      }

      res.json({
        success: true,
        review: reviewData,
      });
    } catch {
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    }
  });

  // ==========================================================================
  // POST /a/:token/approve — Execute Payment Approval
  // ==========================================================================
  router.post('/:token/approve', async (req: Request, res: Response): Promise<void> => {
    const rawToken = typeof req.params.token === 'string' ? req.params.token : '';
    if (!rawToken) {
      res.status(400).json({ success: false, error: 'INVALID_TOKEN_FORMAT', message: 'Token parameter is required' });
      return;
    }
    const ownerSession = req.ownerSession!;

    // Step 1: Atomic SQLite Claim Transaction
    // Atomically consumes token and transitions HELD -> APPROVED in a single BEGIN IMMEDIATE
    const claimResult = runInTransaction(db, () => {
      // 1. Verify token bound to APPROVE
      const verification = verifyApprovalToken(db, repos, {
        rawToken,
        expectedAction: 'APPROVE',
      });

      if (!verification.valid || !verification.approval || !verification.request) {
        return {
          success: false,
          error: verification.error,
          message: verification.message,
          request: verification.request,
        };
      }

      const tokenHash = hashApprovalToken(rawToken.trim());
      const nowIso = new Date().toISOString();

      // 2. Mark token used (CAS)
      const marked = repos.approvals.markUsed(tokenHash, nowIso);
      if (!marked) {
        return {
          success: false,
          error: 'TOKEN_ALREADY_USED',
          message: 'Approval token has already been consumed (concurrent race prevented)',
        };
      }

      // 3. Transition payment request HELD -> APPROVED
      const { request: updatedRequest, auditEntry } = transitionPaymentRequest(db, repos, {
        requestId: verification.request.id,
        to: 'APPROVED',
        actor: 'owner',
        event: 'OWNER_APPROVED',
        timestamp: nowIso,
        payload: {
          approval_id: verification.approval.id,
          channel: verification.approval.channel,
          owner_display_name: ownerSession.displayName,
        },
      });

      return {
        success: true,
        approval: verification.approval,
        request: updatedRequest,
        auditEntry,
      };
    });

    if (!claimResult.success || !claimResult.request) {
      if (claimResult.error === 'HOLD_EXPIRED' && claimResult.request) {
        void expirePaymentHold(db, claimResult.request.id, {
          repos,
          authorizationsService: options.authorizationsService,
          logger: options.logger,
        }).catch((err: unknown) => {
          options.logger?.error?.('[Routes] Error during lazy hold expiry on POST /a/:token/approve:', err);
        });
      }

      const statusCode =
        claimResult.error === 'TOKEN_ALREADY_USED'
          ? 409
          : claimResult.error === 'TOKEN_EXPIRED' || claimResult.error === 'HOLD_EXPIRED'
          ? 410
          : 400;

      res.status(statusCode).json({
        success: false,
        error: claimResult.error,
        message: claimResult.message,
      });
      return;
    }

    // Step 2: Route money-moving capture exclusively through executeDecision() in src/core
    try {
      const execution = await executeDecision(
        { requestId: claimResult.request.id },
        {
          db,
          repos,
          actor: 'owner',
          authorizationsService: options.authorizationsService,
          ordersService: options.ordersService,
        }
      );

      if (execution.status === 'FAILED') {
        res.status(500).json({
          success: false,
          status: 'FAILED',
          error: execution.error || 'EXECUTION_FAILED',
          message: 'Payment execution failed at PayPal and request has been marked FAILED',
        });
        return;
      }

      res.status(200).json({
        success: true,
        requestId: execution.request.id,
        status: execution.status,
        executedAction: execution.executedAction,
        captureId: execution.captureId,
      });
    } catch (err: unknown) {
      if (err instanceof AmbiguousExecutionError) {
        res.status(202).json({
          success: false,
          status: 'CAPTURING',
          error: 'AMBIGUOUS_EXECUTION',
          message: err.message,
          requestId: err.requestId,
          reconciliationRequired: true,
        });
        return;
      }

      if (err instanceof ExecuteDecisionError) {
        res.status(500).json({
          success: false,
          status: 'FAILED',
          error: err.code,
          message: err.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'EXECUTION_ERROR',
        message: 'An error occurred during payment capture execution',
      });
    }
  });

  // ==========================================================================
  // POST /a/:token/void — Execute Payment Void
  // ==========================================================================
  router.post('/:token/void', async (req: Request, res: Response): Promise<void> => {
    const rawToken = typeof req.params.token === 'string' ? req.params.token : '';
    if (!rawToken) {
      res.status(400).json({ success: false, error: 'INVALID_TOKEN_FORMAT', message: 'Token parameter is required' });
      return;
    }
    const ownerSession = req.ownerSession!;

    // Step 1: Atomic SQLite Void Transaction
    // Atomically consumes token, inserts RELEASE ledger row, and transitions HELD -> VOIDED
    const claimResult = runInTransaction(db, () => {
      // 1. Verify token bound to VOID
      const verification = verifyApprovalToken(db, repos, {
        rawToken,
        expectedAction: 'VOID',
      });

      if (!verification.valid || !verification.approval || !verification.request) {
        return {
          success: false,
          error: verification.error,
          message: verification.message,
          request: verification.request,
        };
      }

      const tokenHash = hashApprovalToken(rawToken.trim());
      const nowIso = new Date().toISOString();

      // 2. Mark token used (CAS)
      const marked = repos.approvals.markUsed(tokenHash, nowIso);
      if (!marked) {
        return {
          success: false,
          error: 'TOKEN_ALREADY_USED',
          message: 'Approval token has already been consumed (concurrent race prevented)',
        };
      }

      // 3. Insert RELEASE row in ledger (releasing budget reservation)
      const ledgerId = `led-${crypto.randomUUID()}`;
      repos.ledger.insert({
        id: ledgerId,
        request_id: verification.request.id,
        kind: 'RELEASE',
        amount_minor: verification.request.amount_minor,
        currency: verification.request.currency,
        created_at: nowIso,
      });

      // 4. Transition payment request HELD -> VOIDED
      const authId = verification.request.paypal_authorization_id;
      const initialVoidStatus = authId ? 'PENDING' : 'FAILED';

      const { request: updatedRequest, auditEntry } = transitionPaymentRequest(db, repos, {
        requestId: verification.request.id,
        to: 'VOIDED',
        actor: 'owner',
        event: 'TRANSITION_TO_VOIDED',
        timestamp: nowIso,
        payload: {
          approval_id: verification.approval.id,
          channel: verification.approval.channel,
          owner_display_name: ownerSession.displayName,
          reason: 'Owner rejected and voided payment hold',
          remote_void_status: initialVoidStatus,
        },
      });

      repos.paymentRequests.updateRemoteVoidStatus(verification.request.id, initialVoidStatus, nowIso);

      return {
        success: true,
        approval: verification.approval,
        request: updatedRequest,
        auditEntry,
      };
    });

    if (!claimResult.success || !claimResult.request) {
      if (claimResult.error === 'HOLD_EXPIRED' && claimResult.request) {
        void expirePaymentHold(db, claimResult.request.id, {
          repos,
          authorizationsService: options.authorizationsService,
          logger: options.logger,
        }).catch((err: unknown) => {
          options.logger?.error?.('[Routes] Error during lazy hold expiry on POST /a/:token/void:', err);
        });
      }

      const statusCode =
        claimResult.error === 'TOKEN_ALREADY_USED'
          ? 409
          : claimResult.error === 'TOKEN_EXPIRED' || claimResult.error === 'HOLD_EXPIRED'
          ? 410
          : 400;

      res.status(statusCode).json({
        success: false,
        error: claimResult.error,
        message: claimResult.message,
      });
      return;
    }

    // Step 2: Void remote PayPal authorization outside database transaction
    const authId = claimResult.request.paypal_authorization_id;

    if (!authId) {
      writeAuditLogEntry(db, repos, {
        actor: 'system',
        event: 'PAYPAL_VOID_UNRESOLVED_NO_AUTH_ID',
        requestId: claimResult.request.id,
        payload: {
          reason: 'Cannot cancel remote authorization: request is missing paypal_authorization_id',
          remote_void_status: 'FAILED',
        },
      });

      res.status(202).json({
        success: true,
        requestId: claimResult.request.id,
        status: 'VOIDED',
        remoteVoidStatus: 'FAILED',
        remoteVoidSuccess: false,
        reconciliationRequired: true,
        message: 'Local void committed, but remote cancellation failed: missing paypal_authorization_id',
      });
      return;
    }

    let remoteVoidSuccess = false;

    if (options.authorizationsService) {
      try {
        const voidRes = await options.authorizationsService.voidAuthorization({
          authorizationId: authId,
          requestId: claimResult.request.id,
        });
        remoteVoidSuccess = voidRes.isVoided;
      } catch (err: unknown) {
        // Audit remote void failure; local state is safely VOIDED and reservation released
        writeAuditLogEntry(db, repos, {
          actor: 'system',
          event: 'PAYPAL_VOID_PENDING_RETRY',
          requestId: claimResult.request.id,
          payload: {
            error: err instanceof Error ? err.message : String(err),
            authorizationId: authId,
            remote_void_status: 'PENDING',
          },
        });
      }
    }

    if (remoteVoidSuccess) {
      repos.paymentRequests.updateRemoteVoidStatus(claimResult.request.id, 'CONFIRMED');
      writeAuditLogEntry(db, repos, {
        actor: 'system',
        event: 'PAYPAL_VOID_CONFIRMED',
        requestId: claimResult.request.id,
        payload: {
          authorizationId: authId,
          remote_void_status: 'CONFIRMED',
        },
      });

      res.status(200).json({
        success: true,
        requestId: claimResult.request.id,
        status: 'VOIDED',
        remoteVoidStatus: 'CONFIRMED',
        remoteVoidSuccess: true,
      });
      return;
    }

    // Remote void unconfirmed / pending retry: return HTTP 202
    res.status(202).json({
      success: true,
      requestId: claimResult.request.id,
      status: 'VOIDED',
      remoteVoidStatus: 'PENDING',
      remoteVoidSuccess: false,
      reconciliationRequired: true,
      message: 'Local void committed; remote PayPal cancellation is pending retry',
    });
  });

  return router;
}
