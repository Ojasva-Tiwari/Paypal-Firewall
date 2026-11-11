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
 *    - Requires authenticated owner session + CSRF verification (x-csrf-token header or form _csrf).
 *    - Verifies token is bound to 'APPROVE'.
 *    - Atomically claims token consumption and transitions request HELD -> APPROVED in SQLite.
 *    - Calls executeDecision() in src/core for Flow C capture (the only money-moving caller).
 *    - Handles ambiguous outcomes gracefully with handoff to reconciliation.
 *
 * 3. POST /a/:token/void
 *    - Requires authenticated owner session + CSRF verification (x-csrf-token header or form _csrf).
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

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { Database } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import { formatMinorUnitsToDecimal } from '../core/money.js';
import type { PayPalOrdersService } from '../paypal/orders.js';
import type { PayPalAuthorizationsService } from '../paypal/authorizations.js';
import type { OwnerSessionStore } from '../auth/owner.js';
import { createOwnerAuthMiddleware } from '../auth/owner.js';
import {
  verifyApprovalToken,
} from './tokens.js';
import {
  explainPolicyDecision,
  type PolicyExplanationItem,
} from '../policy/explanations.js';
import type { Decision } from '../policy/types.js';
import type { AiService } from '../ai/service.js';
import { RiskExplainer, type AiRiskExplanationResponse } from '../ai/riskExplainer.js';
import {
  ApprovalExecutionService,
  ApprovalValidationError,
} from './service.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface ApprovalRouterOptions {
  readonly db: Database;
  readonly repos: Repositories;
  readonly sessionStore: OwnerSessionStore;
  readonly isProduction?: boolean;
  readonly publicBaseUrl?: string;
  readonly secureCookie?: boolean;
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
  readonly explanations?: readonly PolicyExplanationItem[];
  readonly aiRiskExplanation?: AiRiskExplanationResponse | null;
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

function prefersHtml(req: Request): boolean {
  return req.accepts(['json', 'html']) === 'html';
}

function formatCurrencyPrefix(currency: string): string {
  switch (currency.trim().toUpperCase()) {
    case 'USD':
      return '$';
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'INR':
      return '₹';
    case 'JPY':
      return '¥';
    default:
      return '';
  }
}

function sendHtmlResponse(res: Response, statusCode: number, html: string): void {
  res.status(statusCode);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

interface ApprovalStatusHtmlOptions {
  readonly badge: string;
  readonly badgeTone: 'success' | 'warn' | 'error';
  readonly title: string;
  readonly message: string;
  readonly details?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly backHref: string;
  readonly backLabel: string;
}

function renderStatusHtml(opts: ApprovalStatusHtmlOptions): string {
  const badgeStyle =
    opts.badgeTone === 'success'
      ? 'background: #064e3b; color: #a7f3d0;'
      : opts.badgeTone === 'warn'
      ? 'background: #854d0e; color: #fef08a;'
      : 'background: #7f1d1d; color: #fecaca;';

  const detailsHtml =
    opts.details && opts.details.length > 0
      ? opts.details
          .map(
            (item) => `
    <div class="field">
      <div class="label">${escapeHtml(item.label)}</div>
      <div class="value">${escapeHtml(item.value)}</div>
    </div>`
          )
          .join('')
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PayGuard — ${escapeHtml(opts.title)}</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; }
    body { margin: 0; padding: 1.5rem; display: flex; justify-content: center; align-items: center; min-height: 90vh; }
    .card { background: #1e293b; border-radius: 1rem; border: 1px solid #334155; padding: 1.5rem; max-width: 440px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
    .badge { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; ${badgeStyle} }
    h1 { font-size: 1.35rem; margin: 1rem 0 0.75rem; color: #f8fafc; }
    p { font-size: 0.95rem; color: #cbd5e1; line-height: 1.5; margin: 0 0 1.25rem; word-break: break-word; }
    .field { margin-bottom: 0.85rem; }
    .label { font-size: 0.75rem; text-transform: uppercase; font-weight: 600; color: #64748b; margin-bottom: 0.2rem; }
    .value { font-size: 0.9rem; color: #e2e8f0; line-height: 1.4; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .btn { display: block; width: 100%; box-sizing: border-box; padding: 0.85rem; border-radius: 0.5rem; border: 1px solid #475569; font-size: 0.95rem; font-weight: 600; cursor: pointer; color: #e2e8f0; background: transparent; margin-top: 1.25rem; text-align: center; text-decoration: none; }
    .btn:hover { opacity: 0.92; }
  </style>
</head>
<body>
  <div class="card">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
      <span style="font-weight: 700; font-size: 0.9rem; letter-spacing: 0.05em; color: #38bdf8;">PAYGUARD FIREWALL</span>
      <span class="badge">${escapeHtml(opts.badge)}</span>
    </div>
    <h1>${escapeHtml(opts.title)}</h1>
    <p>${escapeHtml(opts.message)}</p>
    ${detailsHtml}
    <a class="btn" href="${escapeHtml(opts.backHref)}">${escapeHtml(opts.backLabel)}</a>
  </div>
</body>
</html>`;
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

    <div class="amount">${escapeHtml(formatCurrencyPrefix(data.amount.currency))}${escapeHtml(data.amount.amountDecimal)}<span class="currency">${escapeHtml(data.amount.currency)}</span></div>

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
      ${data.explanations && data.explanations.length > 0 ? `
      <div style="margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem;">
        ${data.explanations.map((exp) => `
          <div style="background: #0f172a; border: 1px solid #334155; border-radius: 0.5rem; padding: 0.6rem 0.75rem; font-size: 0.8rem;">
            <div style="font-weight: 600; color: #f8fafc; margin-bottom: 0.2rem;">${escapeHtml(exp.title)}</div>
            <div style="color: #cbd5e1; line-height: 1.35; margin-bottom: 0.35rem;">${escapeHtml(exp.description)}</div>
            <div style="font-size: 0.75rem; color: #94a3b8;"><strong style="color: #64748b;">Recommended Action:</strong> ${escapeHtml(exp.recommendedAction)}</div>
          </div>
        `).join('')}
      </div>` : ''}
    </div>

    ${data.aiRiskExplanation ? `
    <div class="field" style="margin-top: 1.25rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
        <div class="label" style="margin-bottom: 0; color: #a78bfa;">
          AI Risk Explainer (${data.aiRiskExplanation.isMock ? 'Mock Advisory - Test Mode' : 'Advisory - Non-Authoritative'})
        </div>
        <span class="badge" style="background: ${
          data.aiRiskExplanation.risk_level === 'HIGH' ? '#dc2626' : data.aiRiskExplanation.risk_level === 'MEDIUM' ? '#d97706' : '#059669'
        }; color: #ffffff;">
          ${escapeHtml(data.aiRiskExplanation.risk_level)} RISK
        </span>
      </div>
      <div style="background: #1e1b4b; border: 1px solid #4338ca; border-radius: 0.5rem; padding: 0.75rem; font-size: 0.85rem; line-height: 1.4; color: #e0e7ff;">
        <div>${escapeHtml(data.aiRiskExplanation.summary)}</div>
        ${data.aiRiskExplanation.suspicious_phrases && data.aiRiskExplanation.suspicious_phrases.length > 0 ? `
        <div style="margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid #3730a3; font-size: 0.75rem;">
          <strong style="color: #c7d2fe;">Flagged Phrases:</strong>
          <div style="margin-top: 0.25rem;">
            ${data.aiRiskExplanation.suspicious_phrases.map((p) => `<span class="reason-tag" style="background: #312e81; color: #fca5a5; border: 1px solid #4338ca;">${escapeHtml(p)}</span>`).join('')}
          </div>
        </div>` : ''}
        <div style="margin-top: 0.5rem; font-size: 0.7rem; color: #818cf8;">
          Model: ${escapeHtml(data.aiRiskExplanation.model)} • Advisory only (Hard Rule 6: cannot override policy)
        </div>
      </div>
    </div>` : ''}

    ${data.sourceContextExcerpt ? `
    <div class="field">
      <div class="label">Source Context Excerpt</div>
      <div class="value" style="font-family: monospace; font-size: 0.8rem; background: #0f172a; padding: 0.5rem; border-radius: 0.25rem;">${escapeHtml(data.sourceContextExcerpt)}</div>
    </div>` : ''}

    <div class="field">
      <div class="label">Hold Expiry</div>
      <div class="value" style="font-size: 0.85rem; color: #f59e0b;">${escapeHtml(data.expiresAt)}</div>
    </div>

    <form method="POST" action="${escapeHtml(submitPath)}">
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
  const approvalExecutionService =
    options.approvalExecutionService ??
    new ApprovalExecutionService({
      db,
      repos,
      authorizationsService: options.authorizationsService,
      ordersService: options.ordersService,
      ...('publicBaseUrl' in options ? { publicBaseUrl: options.publicBaseUrl } : {}),
      ...('isProduction' in options ? { isProduction: options.isProduction } : {}),
      logger: options.logger,
    });

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

  // 2. Parse HTML form POST bodies (application/x-www-form-urlencoded) before CSRF verification
  const urlencodedParser = express.urlencoded({ extended: false, limit: '16kb' });
  router.use((req: Request, res: Response, next: NextFunction) => {
    urlencodedParser(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      const errObj = err as { type?: string; status?: number; statusCode?: number };
      const status =
        errObj.type === 'entity.too.large' || errObj.status === 413 || errObj.statusCode === 413
          ? 413
          : 400;
      const errorCode = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_FORM_BODY';
      const message =
        status === 413
          ? 'Submitted approval form body exceeds maximum allowed size'
          : 'Malformed approval form submission';
      if (prefersHtml(req)) {
        sendHtmlResponse(
          res,
          status,
          renderStatusHtml({
            badge: status === 413 ? 'Payload Too Large' : 'Bad Request',
            badgeTone: 'error',
            title: 'Invalid Submission',
            message,
            backHref: '/#/approvals',
            backLabel: 'Back to Approvals',
          })
        );
        return;
      }
      res.status(status).json({ success: false, error: errorCode, message });
    });
  });

  // 3. Enforce Owner Authentication (session cookie + CSRF header or form _csrf on POST)
  const ownerAuth = createOwnerAuthMiddleware(sessionStore, {
    isProduction: options.isProduction,
    secureCookie: options.secureCookie,
    allowFormBodyCsrf: true,
    htmlErrorResponses: true,
  });
  router.use(ownerAuth);

  // ==========================================================================
  // GET /a/:token — Review Screen / Read-Only Inspection
  // ==========================================================================
  router.get('/:token', async (req: Request, res: Response): Promise<void> => {
    const wantsHtml = prefersHtml(req);

    try {
      const rawToken = typeof req.params.token === 'string' ? req.params.token : '';
      if (!rawToken) {
        if (wantsHtml) {
          sendHtmlResponse(
            res,
            400,
            renderStatusHtml({
              badge: 'Invalid Token',
              badgeTone: 'error',
              title: 'Approval Link Invalid',
              message: 'Token parameter is required.',
              backHref: '/#/approvals',
              backLabel: 'Back to Approvals',
            })
          );
          return;
        }
        res.status(400).json({ success: false, error: 'INVALID_TOKEN_FORMAT', message: 'Token parameter is required' });
        return;
      }

      // 1. Verify approval token (pure read-only verification)
      const verification = verifyApprovalToken(db, repos, { rawToken });
      if (!verification.valid || !verification.approval || !verification.request) {
        if (verification.error === 'HOLD_EXPIRED' && verification.request) {
          approvalExecutionService.triggerLazyHoldExpiry(verification.request.id);
        }

        const statusCode =
          verification.error === 'TOKEN_NOT_FOUND' || verification.error === 'INVALID_TOKEN_FORMAT'
            ? 404
            : verification.error === 'TOKEN_ALREADY_USED' || verification.error === 'TOKEN_EXPIRED' || verification.error === 'HOLD_EXPIRED'
            ? 410
            : 400;

        if (wantsHtml) {
          sendHtmlResponse(
            res,
            statusCode,
            renderStatusHtml({
              badge: verification.error || 'Error',
              badgeTone: statusCode === 410 ? 'warn' : 'error',
              title:
                statusCode === 410
                  ? 'Approval Link No Longer Active'
                  : statusCode === 404
                  ? 'Approval Link Not Found'
                  : 'Unable to Load Approval',
              message: verification.message || 'Approval token could not be verified.',
              backHref: '/#/approvals',
              backLabel: 'Open Approvals Dashboard',
            })
          );
          return;
        }

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

      const explanationResult = explainPolicyDecision(
        (request.decision as Decision) ?? 'HOLD',
        policyReasons,
        {
          vendorId: request.vendor_id,
          vendorName,
          amountMinor: request.amount_minor,
          currency: request.currency,
          category: request.category,
          purpose: request.purpose,
        }
      );

      let aiRiskExplanation: AiRiskExplanationResponse | null = null;
      if (options.aiService) {
        try {
          const riskExplainer = new RiskExplainer(options.aiService);
          aiRiskExplanation = await riskExplainer.explainRisk({
            requestId: request.id,
            decision: (request.decision as Decision) ?? 'HOLD',
            reasons: policyReasons,
            vendorId: request.vendor_id,
            vendorName,
            agentId: request.agent_id,
            amountMinor: request.amount_minor,
            currency: request.currency,
            category: request.category,
            purpose: request.purpose,
            sourceContextExcerpt: request.source_context_excerpt,
          });
        } catch (err: unknown) {
          options.logger?.warn?.('[Routes] AI RiskExplainer failed gracefully:', err);
          aiRiskExplanation = null;
        }
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
        explanations: explanationResult.items,
        aiRiskExplanation,
        sourceContextExcerpt: request.source_context_excerpt,
        expiresAt: approval.expires_at,
        holdExpiresAt: request.expires_at,
        createdAt: request.created_at,
        channel: approval.channel,
      };

      // Return HTML when request prefers HTML (including browser Accept headers with */*), otherwise JSON
      if (wantsHtml) {
        const csrfToken = req.ownerSession?.csrfToken || '';
        sendHtmlResponse(res, 200, renderApprovalHtml(reviewData, rawToken, csrfToken));
        return;
      }

      res.json({
        success: true,
        review: reviewData,
      });
    } catch {
      if (wantsHtml) {
        sendHtmlResponse(
          res,
          500,
          renderStatusHtml({
            badge: 'Error',
            badgeTone: 'error',
            title: 'Unexpected Error',
            message: 'An unexpected error occurred while loading this approval request.',
            backHref: '/#/approvals',
            backLabel: 'Back to Approvals',
          })
        );
        return;
      }
      res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    }
  });

  // ==========================================================================
  // POST /a/:token/approve — Execute Payment Approval
  // ==========================================================================
  router.post('/:token/approve', async (req: Request, res: Response): Promise<void> => {
    const wantsHtml = prefersHtml(req);
    const rawToken = typeof req.params.token === 'string' ? req.params.token : '';
    if (!rawToken) {
      if (wantsHtml) {
        sendHtmlResponse(
          res,
          400,
          renderStatusHtml({
            badge: 'Invalid Token',
            badgeTone: 'error',
            title: 'Approval Failed',
            message: 'Token parameter is required.',
            backHref: '/#/approvals',
            backLabel: 'Back to Approvals',
          })
        );
        return;
      }
      res.status(400).json({ success: false, error: 'INVALID_TOKEN_FORMAT', message: 'Token parameter is required' });
      return;
    }
    const ownerSession = req.ownerSession!;

    try {
      const outcome = await approvalExecutionService.execute({
        action: 'APPROVE',
        credentials: {
          channel: 'web',
          rawToken,
          ownerId: ownerSession.ownerId,
          ownerDisplayName: ownerSession.displayName,
        },
      });

      if (outcome.action === 'APPROVE') {
        if (outcome.status === 'CAPTURED') {
          if (wantsHtml) {
            sendHtmlResponse(
              res,
              200,
              renderStatusHtml({
                badge: 'CAPTURED',
                badgeTone: 'success',
                title: 'Payment Approved & Captured',
                message: 'The held payment authorization was approved and captured.',
                details: [
                  { label: 'Request ID', value: outcome.requestId },
                  ...(outcome.captureId ? [{ label: 'Capture ID', value: outcome.captureId }] : []),
                ],
                backHref: `/#/requests/${encodeURIComponent(outcome.requestId)}`,
                backLabel: 'View Payment Request',
              })
            );
            return;
          }
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
          if (wantsHtml) {
            sendHtmlResponse(
              res,
              202,
              renderStatusHtml({
                badge: 'CAPTURING',
                badgeTone: 'warn',
                title: 'Approval Accepted — Capture Pending',
                message: outcome.message || 'Capture status is ambiguous and queued for reconciliation.',
                details: [{ label: 'Request ID', value: outcome.requestId }],
                backHref: `/#/requests/${encodeURIComponent(outcome.requestId)}`,
                backLabel: 'View Payment Request',
              })
            );
            return;
          }
          res.status(202).json({
            success: false,
            status: outcome.status,
            error: outcome.error,
            message: outcome.message,
            requestId: outcome.requestId,
            reconciliationRequired: outcome.reconciliationRequired,
          });
          return;
        }

        if (outcome.status === 'FAILED') {
          if (wantsHtml) {
            sendHtmlResponse(
              res,
              500,
              renderStatusHtml({
                badge: 'FAILED',
                badgeTone: 'error',
                title: 'Payment Capture Failed',
                message: outcome.message || 'Payment capture could not be completed.',
                details: [{ label: 'Request ID', value: outcome.requestId }],
                backHref: `/#/requests/${encodeURIComponent(outcome.requestId)}`,
                backLabel: 'View Payment Request',
              })
            );
            return;
          }
          res.status(500).json({
            success: false,
            status: outcome.status,
            error: outcome.error,
            message: outcome.message,
          });
          return;
        }
      }

      if (wantsHtml) {
        sendHtmlResponse(
          res,
          500,
          renderStatusHtml({
            badge: 'INTERNAL_ERROR',
            badgeTone: 'error',
            title: 'Unexpected Execution State',
            message: 'Unexpected execution state encountered during payment approval.',
            backHref: '/#/approvals',
            backLabel: 'Back to Approvals',
          })
        );
        return;
      }
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Unexpected execution state',
      });
    } catch (err: unknown) {
      if (err instanceof ApprovalValidationError) {
        if (wantsHtml) {
          sendHtmlResponse(
            res,
            err.statusCode,
            renderStatusHtml({
              badge: err.code,
              badgeTone: err.statusCode === 410 || err.statusCode === 409 ? 'warn' : 'error',
              title: 'Approval Could Not Be Completed',
              message: err.message,
              backHref: '/#/approvals',
              backLabel: 'Open Approvals Dashboard',
            })
          );
          return;
        }
        res.status(err.statusCode).json({
          success: false,
          error: err.code,
          message: err.message,
        });
        return;
      }

      if (wantsHtml) {
        sendHtmlResponse(
          res,
          500,
          renderStatusHtml({
            badge: 'EXECUTION_ERROR',
            badgeTone: 'error',
            title: 'Payment Approval Error',
            message: 'An error occurred during payment capture execution.',
            backHref: '/#/approvals',
            backLabel: 'Back to Approvals',
          })
        );
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
    const wantsHtml = prefersHtml(req);
    const rawToken = typeof req.params.token === 'string' ? req.params.token : '';
    if (!rawToken) {
      if (wantsHtml) {
        sendHtmlResponse(
          res,
          400,
          renderStatusHtml({
            badge: 'Invalid Token',
            badgeTone: 'error',
            title: 'Void Failed',
            message: 'Token parameter is required.',
            backHref: '/#/approvals',
            backLabel: 'Back to Approvals',
          })
        );
        return;
      }
      res.status(400).json({ success: false, error: 'INVALID_TOKEN_FORMAT', message: 'Token parameter is required' });
      return;
    }
    const ownerSession = req.ownerSession!;

    try {
      const outcome = await approvalExecutionService.execute({
        action: 'VOID',
        credentials: {
          channel: 'web',
          rawToken,
          ownerId: ownerSession.ownerId,
          ownerDisplayName: ownerSession.displayName,
        },
      });

      if (outcome.action === 'VOID') {
        if (outcome.remoteVoidSuccess) {
          if (wantsHtml) {
            sendHtmlResponse(
              res,
              200,
              renderStatusHtml({
                badge: 'VOIDED',
                badgeTone: 'success',
                title: 'Payment Hold Voided',
                message: 'The authorization hold was voided and reserved budget was released.',
                details: [
                  { label: 'Request ID', value: outcome.requestId },
                  { label: 'Remote Void Status', value: outcome.remoteVoidStatus },
                ],
                backHref: `/#/requests/${encodeURIComponent(outcome.requestId)}`,
                backLabel: 'View Payment Request',
              })
            );
            return;
          }
          res.status(200).json({
            success: true,
            requestId: outcome.requestId,
            status: outcome.status,
            remoteVoidStatus: outcome.remoteVoidStatus,
            remoteVoidSuccess: true,
          });
          return;
        }

        if (wantsHtml) {
          sendHtmlResponse(
            res,
            202,
            renderStatusHtml({
              badge: 'VOIDED (RECONCILIATION QUEUED)',
              badgeTone: 'warn',
              title: 'Local Hold Voided — Remote Void Pending',
              message:
                outcome.message ||
                'Reserved funds were released locally; remote PayPal authorization void requires background reconciliation.',
              details: [
                { label: 'Request ID', value: outcome.requestId },
                { label: 'Remote Void Status', value: outcome.remoteVoidStatus },
              ],
              backHref: `/#/requests/${encodeURIComponent(outcome.requestId)}`,
              backLabel: 'View Payment Request',
            })
          );
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

      if (wantsHtml) {
        sendHtmlResponse(
          res,
          500,
          renderStatusHtml({
            badge: 'INTERNAL_ERROR',
            badgeTone: 'error',
            title: 'Unexpected Execution State',
            message: 'Unexpected execution state encountered during payment void.',
            backHref: '/#/approvals',
            backLabel: 'Back to Approvals',
          })
        );
        return;
      }
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'Unexpected execution state',
      });
    } catch (err: unknown) {
      if (err instanceof ApprovalValidationError) {
        if (wantsHtml) {
          sendHtmlResponse(
            res,
            err.statusCode,
            renderStatusHtml({
              badge: err.code,
              badgeTone: err.statusCode === 410 || err.statusCode === 409 ? 'warn' : 'error',
              title: 'Void Could Not Be Completed',
              message: err.message,
              backHref: '/#/approvals',
              backLabel: 'Open Approvals Dashboard',
            })
          );
          return;
        }
        res.status(err.statusCode).json({
          success: false,
          error: err.code,
          message: err.message,
        });
        return;
      }

      if (wantsHtml) {
        sendHtmlResponse(
          res,
          500,
          renderStatusHtml({
            badge: 'INTERNAL_ERROR',
            badgeTone: 'error',
            title: 'Payment Void Error',
            message: 'An error occurred during payment void execution.',
            backHref: '/#/approvals',
            backLabel: 'Back to Approvals',
          })
        );
        return;
      }
      res.status(500).json({
        success: false,
        error: 'INTERNAL_ERROR',
        message: 'An error occurred during payment void execution',
      });
    }
  });

  return router;
}

export { createApprovalRouter as createApprovalsRouter };
