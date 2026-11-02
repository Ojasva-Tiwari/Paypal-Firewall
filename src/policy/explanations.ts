/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T2: Deterministic Policy Explanations
 *
 * Single Source of Truth for generating human-readable, fact-disciplined,
 * deterministic explanations directly from policy reason codes and evaluated facts.
 *
 * Invariants & Guardrails:
 * 1. Zero LLM / AI dependencies: purely deterministic string formatting.
 * 2. Fact Discipline: Never invent facts. Generic fallback copy is preferred over
 *    fabricated specifics when optional metadata is omitted.
 * 3. Precedence Governed: An item's severity and action must never contradict the
 *    overall governing decision (e.g. DENY is never presented as approvable).
 * 4. ALLOW Precision: Never states or implies funds were captured or that PayPal
 *    executed a payment; only that deterministic checks were satisfied.
 * 5. Safe Degradation: Unknown reason codes degrade safely to generic trigger items.
 */

import { formatMinorUnitsToDecimal } from '../core/money.js';
import type { Decision } from './types.js';

export type ExplanationSeverity = 'DENY' | 'HOLD' | 'INFO';

export interface PolicyExplanationItem {
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly severity: ExplanationSeverity;
  readonly ruleId?: string;
  readonly recommendedAction: string;
}

export interface PolicyDecisionExplanation {
  readonly decision: Decision;
  readonly summary: string;
  readonly items: readonly PolicyExplanationItem[];
  readonly nextSteps: string;
}

export interface PolicyExplanationContext {
  readonly agentId?: string;
  readonly agentName?: string;
  readonly vendorId?: string;
  readonly vendorName?: string;
  readonly amountMinor?: number;
  readonly currency?: string;
  readonly category?: string | null;
  readonly purpose?: string;
  readonly autoLimitMinor?: number;
  readonly hardCapMinor?: number;
  readonly agentBudgetMinor?: number;
  readonly globalBudgetMinor?: number;
  readonly currentAgentSpendMinor?: number;
  readonly currentGlobalSpendMinor?: number;
  readonly recentRequestCount?: number;
  readonly velocityWindowMinutes?: number;
  readonly velocityMaxRequests?: number;
  readonly duplicateWindowMinutes?: number;
  readonly vendorCategories?: readonly string[];
  readonly allowedCurrencies?: readonly string[];
  readonly newVendorAction?: 'HOLD' | 'DENY';
}

// ============================================================================
// Formatting Helpers (Guaranteed No 'undefined' or 'NaN' in output)
// ============================================================================

function formatMoney(amountMinor?: number, currency?: string): string | undefined {
  if (
    typeof amountMinor === 'number' &&
    Number.isFinite(amountMinor) &&
    amountMinor >= 0 &&
    typeof currency === 'string' &&
    currency.trim().length > 0
  ) {
    return `$${formatMinorUnitsToDecimal(amountMinor)} ${currency.trim()}`;
  }
  return undefined;
}

function formatVendorName(context?: PolicyExplanationContext): string | undefined {
  const name = context?.vendorName?.trim();
  if (name && name.length > 0) return `'${name}'`;
  const id = context?.vendorId?.trim();
  if (id && id.length > 0) return `'${id}'`;
  return undefined;
}

function formatAgentName(context?: PolicyExplanationContext): string | undefined {
  const name = context?.agentName?.trim();
  if (name && name.length > 0) return `'${name}'`;
  const id = context?.agentId?.trim();
  if (id && id.length > 0) return `'${id}'`;
  return undefined;
}

// ============================================================================
// Single Reason Code Explainer
// ============================================================================

export function explainReasonCode(
  code: string,
  context?: PolicyExplanationContext,
  governingDecision?: Decision
): PolicyExplanationItem {
  const isDeny = governingDecision === 'DENY';
  const amountStr = formatMoney(context?.amountMinor, context?.currency);
  const vendorStr = formatVendorName(context);
  const agentStr = formatAgentName(context);

  switch (code) {
    case 'AGENT_SUSPENDED':
      return {
        code,
        title: 'Agent Credentials Suspended',
        ruleId: 'RULE_AGENT_STATUS',
        severity: 'DENY',
        description: agentStr
          ? `Requesting agent ${agentStr} has been marked SUSPENDED by the owner. All payment requests from suspended agents are denied.`
          : 'The requesting agent credentials have been marked SUSPENDED by the owner. All payment requests from suspended agents are denied.',
        recommendedAction: 'Re-activate the agent in the agent registry or issue fresh credentials.',
      };

    case 'VENDOR_UNKNOWN':
      return {
        code,
        title: 'Unregistered Payee',
        ruleId: 'RULE_VENDOR_STATUS',
        severity: 'DENY',
        description: vendorStr
          ? `Recipient vendor ${vendorStr} is not in the approved vendor registry. Payments to unregistered payees are prohibited.`
          : 'The recipient vendor is not in the approved vendor registry. Payments to unregistered payees are prohibited.',
        recommendedAction: 'Register and verify the payee in the vendor registry before submitting payment requests.',
      };

    case 'VENDOR_BLOCKED':
      return {
        code,
        title: 'Payee Explicitly Blocked',
        ruleId: 'RULE_VENDOR_STATUS',
        severity: 'DENY',
        description: vendorStr
          ? `Recipient vendor ${vendorStr} is explicitly flagged as BLOCKED in the vendor registry.`
          : 'The recipient vendor is explicitly flagged as BLOCKED in the vendor registry.',
        recommendedAction: 'Payments to blocked payees are prohibited under policy. Review vendor status in the registry.',
      };

    case 'CURRENCY_NOT_ALLOWED': {
      const curr = context?.currency?.trim();
      const allowed = context?.allowedCurrencies?.filter((c) => c.trim().length > 0);
      let desc = 'The requested payment currency is not permitted by the active policy currency allowlist.';
      if (curr && allowed && allowed.length > 0) {
        desc = `Currency '${curr}' is not permitted by the active policy currency allowlist [${allowed.join(', ')}].`;
      } else if (curr) {
        desc = `Currency '${curr}' is not permitted by the active policy currency allowlist.`;
      }
      return {
        code,
        title: 'Currency Not Permitted',
        ruleId: 'RULE_CURRENCY_ALLOWLIST',
        severity: 'DENY',
        description: desc,
        recommendedAction: 'Submit payment requests using an authorized currency.',
      };
    }

    case 'OVER_HARD_CAP': {
      const capStr = formatMoney(context?.hardCapMinor, context?.currency);
      let desc = 'The requested payment amount exceeds the non-negotiable policy hard cap.';
      if (amountStr && capStr) {
        desc = `Requested amount of ${amountStr} exceeds the non-negotiable policy hard cap of ${capStr}.`;
      } else if (amountStr) {
        desc = `Requested amount of ${amountStr} exceeds the non-negotiable policy hard cap.`;
      }
      return {
        code,
        title: 'Exceeds Maximum Hard Cap',
        ruleId: 'RULE_HARD_CAP',
        severity: 'DENY',
        description: desc,
        recommendedAction: 'Transaction cannot be approved. Reduce payment amount below the hard cap threshold.',
      };
    }

    case 'GLOBAL_BUDGET_EXCEEDED': {
      const budgetStr = formatMoney(context?.globalBudgetMinor, context?.currency);
      const spendStr = formatMoney(context?.currentGlobalSpendMinor, context?.currency);
      let desc = 'Total system rolling 24-hour spend and reserves exceed the global daily budget limit.';
      if (spendStr && budgetStr) {
        desc = `Total system rolling 24-hour spend and reserves (${spendStr}) exceed the global daily budget limit (${budgetStr}).`;
      } else if (budgetStr) {
        desc = `Total system rolling 24-hour spend and reserves exceed the global daily budget limit of ${budgetStr}.`;
      }
      return {
        code,
        title: 'Global Daily Budget Exhausted',
        ruleId: 'RULE_GLOBAL_DAILY_BUDGET',
        severity: 'DENY',
        description: desc,
        recommendedAction: 'Wait for the rolling 24-hour budget window to replenish or increase the global daily budget in policy.',
      };
    }

    case 'VENDOR_NEW': {
      const isVendorDeny = isDeny || context?.newVendorAction === 'DENY';
      if (isVendorDeny) {
        return {
          code,
          title: 'Unverified Vendor Prohibited',
          ruleId: 'RULE_VENDOR_NEW',
          severity: 'DENY',
          description: vendorStr
            ? `Recipient vendor ${vendorStr} is unverified. Under active policy, payments to unverified vendors are denied.`
            : 'The recipient payee is unverified. Under active policy, payments to unverified vendors are denied.',
          recommendedAction: 'Verify and activate the vendor in the vendor registry before re-submitting.',
        };
      }
      return {
        code,
        title: 'Unverified Vendor Awaiting Review',
        ruleId: 'RULE_VENDOR_NEW',
        severity: 'HOLD',
        description: vendorStr
          ? `Recipient vendor ${vendorStr} is newly registered and unverified. First-time payments require owner confirmation.`
          : 'The recipient payee is newly registered and unverified. First-time payments require owner confirmation.',
        recommendedAction: 'Verify payee credentials and approve or void the payment hold before expiry.',
      };
    }

    case 'OVER_AUTO_LIMIT': {
      const autoLimitStr = formatMoney(context?.autoLimitMinor, context?.currency);
      let desc = 'The requested payment amount exceeds the single-transaction auto-approval limit.';
      if (amountStr && autoLimitStr) {
        desc = `Requested amount of ${amountStr} exceeds the single-transaction auto-approval limit of ${autoLimitStr}.`;
      } else if (amountStr) {
        desc = `Requested amount of ${amountStr} exceeds the single-transaction auto-approval limit.`;
      }
      return {
        code,
        title: 'Exceeds Auto-Approval Limit',
        ruleId: 'RULE_AUTO_LIMIT',
        severity: isDeny ? 'DENY' : 'HOLD',
        description: desc,
        recommendedAction: isDeny
          ? 'Transaction is denied under policy precedence. Adjust payment amount and resolve governing denial reasons.'
          : 'Review payment justification and approve or void the authorization hold before expiry.',
      };
    }

    case 'AGENT_BUDGET_EXCEEDED': {
      const budgetStr = formatMoney(context?.agentBudgetMinor, context?.currency);
      let desc = 'Requesting agent rolling 24-hour spend and reserves exceed their allocated daily limit.';
      if (agentStr && budgetStr) {
        desc = `Requesting agent ${agentStr} rolling 24-hour spend and reserves exceed their allocated daily limit of ${budgetStr}.`;
      } else if (budgetStr) {
        desc = `Requesting agent rolling 24-hour spend and reserves exceed their allocated daily limit of ${budgetStr}.`;
      }
      return {
        code,
        title: 'Agent Daily Budget Exhausted',
        ruleId: 'RULE_AGENT_DAILY_BUDGET',
        severity: isDeny ? 'DENY' : 'HOLD',
        description: desc,
        recommendedAction: isDeny
          ? 'Transaction is denied under policy precedence. Wait for rolling 24-hour window to replenish or adjust agent budget.'
          : 'Wait for rolling 24-hour budget window to replenish, adjust agent limit, or authorize hold.',
      };
    }

    case 'VELOCITY': {
      const count = context?.recentRequestCount;
      const windowMin = context?.velocityWindowMinutes;
      let desc = 'Payment request count exceeds allowed burst limits within the rolling velocity window.';
      if (typeof count === 'number' && typeof windowMin === 'number') {
        desc = `Agent submitted ${count} payment requests within a ${windowMin}-minute velocity window.`;
      } else if (typeof count === 'number') {
        desc = `Agent submitted ${count} payment requests in rapid succession.`;
      }
      return {
        code,
        title: 'High Request Velocity',
        ruleId: 'RULE_VELOCITY',
        severity: isDeny ? 'DENY' : 'HOLD',
        description: desc,
        recommendedAction: isDeny
          ? 'Transaction is denied under policy precedence. Throttle agent requests before retrying.'
          : 'Review agent activity to ensure it is not looping before approving the hold.',
      };
    }

    case 'DUPLICATE': {
      const windowMin = context?.duplicateWindowMinutes;
      let desc = 'A matching payment with identical payee and amount was submitted within the deduplication window.';
      if (vendorStr && typeof windowMin === 'number') {
        desc = `A matching payment to ${vendorStr} with identical amount was submitted within the ${windowMin}-minute deduplication window.`;
      } else if (typeof windowMin === 'number') {
        desc = `A matching payment with identical payee and amount was submitted within the ${windowMin}-minute deduplication window.`;
      }
      return {
        code,
        title: 'Duplicate Transaction Pattern',
        ruleId: 'RULE_DUPLICATE',
        severity: isDeny ? 'DENY' : 'HOLD',
        description: desc,
        recommendedAction: isDeny
          ? 'Transaction is denied under policy precedence. Verify agent did not double-submit an invoice.'
          : 'Verify the agent did not duplicate an existing invoice or request before authorizing.',
      };
    }

    case 'CATEGORY_MISMATCH': {
      const cat = context?.category?.trim();
      let desc = 'The requested payment category does not match the vendor approved categories.';
      if (cat && vendorStr) {
        desc = `Payment category '${cat}' does not match registered categories for vendor ${vendorStr}.`;
      } else if (cat) {
        desc = `Payment category '${cat}' does not match the vendor registered categories.`;
      }
      return {
        code,
        title: 'Vendor Category Mismatch',
        ruleId: 'RULE_VENDOR_CATEGORY',
        severity: isDeny ? 'DENY' : 'HOLD',
        description: desc,
        recommendedAction: isDeny
          ? 'Transaction is denied under policy precedence. Use an approved category matching vendor profile.'
          : 'Confirm purchase category matches expected vendor services before approving.',
      };
    }

    case 'AI_FLAG':
      return {
        code,
        title: 'Security Risk Flag',
        ruleId: 'RULE_AI_FLAG',
        severity: isDeny ? 'DENY' : 'HOLD',
        description:
          'An external risk scanner flagged this transaction for human oversight (Rule RULE_AI_FLAG). Per Invariant I6, AI flags escalate transactions to require owner verification.',
        recommendedAction: isDeny
          ? 'Transaction is denied under policy precedence. Inspect source context for security threats.'
          : 'Inspect source context, invoice details, and agent instructions before approving.',
      };

    default:
      return {
        code,
        title: `Policy Trigger: ${code}`,
        severity: isDeny ? 'DENY' : 'HOLD',
        description: `Triggered policy condition '${code}'. Standard policy rules apply.`,
        recommendedAction: isDeny
          ? 'Transaction is denied under policy precedence. Review policy rules and request parameters.'
          : 'Review transaction parameters and policy configuration before authorizing.',
      };
  }
}

// ============================================================================
// Overall Decision Explainer
// ============================================================================

export function explainPolicyDecision(
  decision: Decision,
  reasons: readonly string[],
  context?: PolicyExplanationContext
): PolicyDecisionExplanation {
  // Case 1: ALLOW (Empty reason codes)
  if (decision === 'ALLOW' || reasons.length === 0) {
    const allowItem: PolicyExplanationItem = {
      code: 'POLICY_ALLOW',
      title: 'Policy Check Passed',
      description: 'The payment request satisfied all deterministic policy checks.',
      severity: 'INFO',
      recommendedAction: 'Continue through the configured payment execution workflow.',
    };

    return {
      decision: 'ALLOW',
      summary: 'Policy check passed: transaction satisfied all deterministic policy rules.',
      items: [allowItem],
      nextSteps: 'Continue through the configured payment execution workflow.',
    };
  }

  // Case 2: HOLD or DENY with triggered reason codes
  const items = reasons.map((code) => explainReasonCode(code, context, decision));
  const count = items.length;
  const triggerPlural = count === 1 ? 'trigger' : 'triggers';

  if (decision === 'DENY') {
    return {
      decision: 'DENY',
      summary: `Payment denied: request violates deterministic policy restrictions (${count} ${triggerPlural}).`,
      items,
      nextSteps:
        'Payment denied. Transaction cannot be approved or retried under the active policy without modifying request parameters or resolving policy violations.',
    };
  }

  return {
    decision: 'HOLD',
    summary: `Payment held: transaction requires manual owner review (${count} ${triggerPlural}).`,
    items,
    nextSteps:
      'Payment held for owner authorization. An owner session must approve or void the authorization before hold expiration (default 15 minutes).',
  };
}

