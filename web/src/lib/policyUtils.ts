/**
 * PayGuard — Policy Authoring and Diff Utilities
 *
 * Pure functions for:
 * 1. Formatting deterministic policy diff values
 * 2. Visual styling and badges for diff changes (TIGHTENED, RELAXED, UNCHANGED)
 * 3. Proposal TTL expiry and live countdown formatting
 * 4. Activation readiness and relaxation acknowledgement validation
 * 5. Descriptive error translation for owner feedback
 */

import { formatCurrencyFromMinor } from './formatters.js';
import type { DiffChangeType, PolicyProposalSummary, ProposalStatus } from '../types/api.js';

/**
 * Format raw policy field values into human-readable strings.
 */
export function formatPolicyFieldValue(field: string, value: unknown, currency: string = 'USD'): string {
  if (value === undefined || value === null) {
    return '—';
  }

  if (typeof value === 'number') {
    if (field.endsWith('_minor')) {
      return formatCurrencyFromMinor(value, currency);
    }
    if (field === 'hold_ttl_minutes' || field === 'duplicate_window_minutes') {
      return `${value} min`;
    }
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[] (empty)';
    return value.join(', ');
  }

  if (typeof value === 'object' && value !== null) {
    if (field === 'velocity') {
      const vel = value as { max_requests?: number; window_minutes?: number };
      const maxReq = vel.max_requests ?? 0;
      const winMin = vel.window_minutes ?? 0;
      return `${maxReq} requests / ${winMin} min`;
    }
    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * Friendly field label for deterministic policy diff attributes.
 */
export function getPolicyFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    auto_limit_minor: 'Auto-Approve Limit',
    hard_cap_minor: 'Maximum Hard Cap',
    agent_daily_budget_minor: 'Agent Daily Cap',
    global_daily_budget_minor: 'Global Daily Budget',
    currency_allowlist: 'Allowed Currencies',
    velocity: 'Velocity Ceiling',
    duplicate_window_minutes: 'Duplicate Window',
    new_vendor_action: 'New Vendor Action',
    hold_ttl_minutes: 'Hold Review TTL',
  };
  return labels[field] || field;
}

export interface DiffBadgeInfo {
  label: string;
  variant: 'tightened' | 'relaxed' | 'unchanged';
  className: string;
}

/**
 * Returns UI badge styling for deterministic diff change classifications.
 */
export function getDiffChangeBadgeProps(change?: DiffChangeType): DiffBadgeInfo {
  switch (change) {
    case 'TIGHTENED':
      return {
        label: 'TIGHTENED',
        variant: 'tightened',
        className: 'bg-[var(--accent-sage)]/20 text-[var(--accent-sage)] border-[var(--accent-sage)]/40',
      };
    case 'RELAXED':
      return {
        label: 'RELAXED',
        variant: 'relaxed',
        className: 'bg-[var(--status-warn-bg)] text-[var(--status-warn)] border-[var(--status-warn-border)]',
      };
    case 'UNCHANGED':
    default:
      return {
        label: 'UNCHANGED',
        variant: 'unchanged',
        className: 'bg-[var(--elevated-bg)] text-[var(--text-secondary)] border-[var(--border-color)]',
      };
  }
}

/**
 * Determines proposal status badge color and label.
 */
export function getProposalStatusBadgeProps(status: ProposalStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'ACTIVATED':
      return {
        label: 'ACTIVATED',
        className: 'bg-[var(--accent-sage)]/20 text-[var(--accent-sage)] border-[var(--accent-sage)]/40',
      };
    case 'PENDING':
      return {
        label: 'PENDING',
        className: 'bg-[var(--accent-lavender)]/20 text-[var(--accent-lavender)] border-[var(--accent-lavender)]/40',
      };
    case 'REJECTED':
      return {
        label: 'REJECTED',
        className: 'bg-[var(--status-error-bg)] text-[var(--status-error)] border-[var(--status-error-border)]',
      };
    case 'EXPIRED':
    default:
      return {
        label: 'EXPIRED',
        className: 'bg-[var(--elevated-bg)] text-[var(--text-secondary)] border-[var(--border-color)]',
      };
  }
}

/**
 * Check whether a proposal is past its expiration timestamp.
 */
export function isProposalExpired(expiresAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) return false;
  return expiryMs <= nowMs;
}

/**
 * Calculate remaining TTL milliseconds, clamped to 0.
 */
export function calculateRemainingProposalMs(expiresAt: string | null | undefined, nowMs: number = Date.now()): number {
  if (!expiresAt) return 0;
  const expiryMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiryMs)) return 0;
  return Math.max(0, expiryMs - nowMs);
}

/**
 * Formats a live remaining TTL into a user-friendly countdown string.
 */
export function formatProposalCountdown(remainingMs: number): string {
  if (remainingMs <= 0) {
    return 'Expired';
  }

  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const remainingSecs = totalSeconds % 60;

  if (totalMinutes < 60) {
    return remainingSecs > 0 ? `${totalMinutes}m ${remainingSecs}s` : `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Client-side readiness check for proposal activation.
 * Note: The backend remains the authoritative gatekeeper.
 */
export function canActivateProposal(
  proposal: PolicyProposalSummary | null | undefined,
  options?: { acknowledged?: boolean; nowMs?: number }
): { allowed: boolean; reason?: string } {
  if (!proposal) {
    return { allowed: false, reason: 'NO_PROPOSAL' };
  }

  if (proposal.status !== 'PENDING') {
    return { allowed: false, reason: `Proposal status is ${proposal.status}, cannot be activated` };
  }

  if (isProposalExpired(proposal.expiresAt, options?.nowMs)) {
    return { allowed: false, reason: 'PROPOSAL_EXPIRED' };
  }

  if (proposal.hasRelaxations && !options?.acknowledged) {
    return { allowed: false, reason: 'RELAXATION_UNACKNOWLEDGED' };
  }

  return { allowed: true };
}

/**
 * Translates backend drafting errors into clear owner explanations.
 */
export function resolveDraftErrorMessage(error: unknown): string {
  if (!error) return 'An unexpected error occurred during policy drafting.';

  const errObj = error as { status?: number; data?: { error?: string; message?: string } };
  const errorCode = errObj.data?.error;
  const errorMsg = errObj.data?.message;

  switch (errorCode) {
    case 'INJECTION_DETECTED':
      return 'Security Alert: Prompt injection pattern detected in your input. For safety, this request was blocked.';
    case 'INJECTION_SCAN_INDETERMINATE':
      return 'Security Alert: Security scanner could not definitively verify prompt safety. Request refused (fail-closed).';
    case 'AI_SERVICE_RATE_LIMITED':
      return 'AI rate limit exceeded. Please wait a moment and try again.';
    case 'AI_SERVICE_TIMEOUT':
      return 'The AI service timed out while drafting rules. Please try again.';
    case 'AI_SERVICE_UNAVAILABLE':
      return 'The AI service is currently unavailable. Please check backend connectivity or try again later.';
    case 'INVALID_PROMPT':
      return errorMsg || 'Please provide a valid policy description (up to 2000 characters).';
    case 'NO_ACTIVE_POLICY':
      return 'Cannot draft policy: No active base policy found in the system.';
    case 'MALFORMED_ACTIVE_POLICY':
      return 'Cannot draft policy: Active policy contains invalid configuration.';
    default:
      return errorMsg || (error instanceof Error ? error.message : 'Failed to draft policy proposal.');
  }
}

/**
 * Translates backend activation errors into actionable owner guidance.
 */
export function resolveActivationErrorMessage(error: unknown): string {
  if (!error) return 'Failed to activate policy proposal.';

  const errObj = error as { status?: number; data?: { error?: string; message?: string } };
  const errorCode = errObj.data?.error;
  const errorMsg = errObj.data?.message;

  switch (errorCode) {
    case 'CONCURRENCY_CONFLICT':
      return 'Concurrency Conflict: The active policy version has changed since this draft was generated. Please review and generate a new proposal against the new active version.';
    case 'PROPOSAL_EXPIRED':
      return 'Proposal Expired: The review window for this proposal has elapsed. Please draft a new policy proposal.';
    case 'ALREADY_ACTIVATED':
      return 'Proposal already activated: This proposal has already been activated.';
    case 'ALREADY_REJECTED':
      return 'Proposal already rejected: This proposal has already been rejected.';
    case 'RELAXATION_ACKNOWLEDGEMENT_REQUIRED':
      return 'Relaxation Acknowledgement Required: You must check the acknowledgement box to authorize policy relaxations.';
    case 'PROPOSAL_HASH_MISMATCH':
    case 'PROPOSAL_HASH_TAMPERED':
      return 'Security Error: Proposal hash mismatch detected. Activation refused.';
    case 'RULE_CONSTRAINT_VIOLATION':
      return 'Validation Error: Proposal rules violate deterministic policy engine invariants.';
    case 'FORBIDDEN':
      return 'Access Denied: This proposal belongs to another owner or session.';
    default:
      return errorMsg || (error instanceof Error ? error.message : 'Failed to activate policy.');
  }
}
