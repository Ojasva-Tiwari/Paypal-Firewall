/**
 * PayGuard — Policy Authoring & Diff Utilities Unit Tests (M5-T6 Phase C)
 *
 * Verifies pure functions for:
 * 1. Policy field and diff formatting
 * 2. Visual diff badges (TIGHTENED, RELAXED, UNCHANGED)
 * 3. Proposal TTL expiry and countdown formatting
 * 4. Gating logic for activation and relaxation acknowledgement
 * 5. Error translation for drafting and activation
 */

import { describe, it, expect } from 'vitest';
import {
  formatPolicyFieldValue,
  getPolicyFieldLabel,
  getDiffChangeBadgeProps,
  getProposalStatusBadgeProps,
  isProposalExpired,
  calculateRemainingProposalMs,
  formatProposalCountdown,
  canActivateProposal,
  resolveDraftErrorMessage,
  resolveActivationErrorMessage,
} from '../../web/src/lib/policyUtils.js';
import type { PolicyProposalSummary } from '../../web/src/types/api.js';

describe('Policy Authoring & Diff Utilities (M5-T6 Phase C)', () => {
  describe('formatPolicyFieldValue', () => {
    it('formats currency minor units into formatted USD strings', () => {
      expect(formatPolicyFieldValue('auto_limit_minor', 1500)).toBe('$15.00');
      expect(formatPolicyFieldValue('hard_cap_minor', 10000)).toBe('$100.00');
      expect(formatPolicyFieldValue('agent_daily_budget_minor', 5000)).toBe('$50.00');
      expect(formatPolicyFieldValue('global_daily_budget_minor', 25000)).toBe('$250.00');
    });

    it('formats velocity ceilings into human-readable string', () => {
      expect(formatPolicyFieldValue('velocity', { max_requests: 5, window_minutes: 10 })).toBe(
        '5 requests / 10 min'
      );
      expect(formatPolicyFieldValue('velocity', { max_requests: 12, window_minutes: 30 })).toBe(
        '12 requests / 30 min'
      );
    });

    it('formats currency allowlists as comma-separated lists', () => {
      expect(formatPolicyFieldValue('currency_allowlist', ['USD', 'EUR'])).toBe('USD, EUR');
      expect(formatPolicyFieldValue('currency_allowlist', ['USD'])).toBe('USD');
      expect(formatPolicyFieldValue('currency_allowlist', [])).toBe('[] (empty)');
    });

    it('formats TTL and window minutes with min suffix', () => {
      expect(formatPolicyFieldValue('hold_ttl_minutes', 15)).toBe('15 min');
      expect(formatPolicyFieldValue('duplicate_window_minutes', 60)).toBe('60 min');
    });

    it('handles null and undefined gracefully', () => {
      expect(formatPolicyFieldValue('auto_limit_minor', null)).toBe('—');
      expect(formatPolicyFieldValue('velocity', undefined)).toBe('—');
    });

    it('formats primitive strings and booleans directly', () => {
      expect(formatPolicyFieldValue('new_vendor_action', 'HOLD')).toBe('HOLD');
      expect(formatPolicyFieldValue('new_vendor_action', 'DENY')).toBe('DENY');
    });
  });

  describe('getPolicyFieldLabel', () => {
    it('maps canonical policy field keys to friendly display labels', () => {
      expect(getPolicyFieldLabel('auto_limit_minor')).toBe('Auto-Approve Limit');
      expect(getPolicyFieldLabel('hard_cap_minor')).toBe('Maximum Hard Cap');
      expect(getPolicyFieldLabel('agent_daily_budget_minor')).toBe('Agent Daily Cap');
      expect(getPolicyFieldLabel('global_daily_budget_minor')).toBe('Global Daily Budget');
      expect(getPolicyFieldLabel('currency_allowlist')).toBe('Allowed Currencies');
      expect(getPolicyFieldLabel('velocity')).toBe('Velocity Ceiling');
      expect(getPolicyFieldLabel('new_vendor_action')).toBe('New Vendor Action');
      expect(getPolicyFieldLabel('hold_ttl_minutes')).toBe('Hold Review TTL');
    });

    it('returns unknown field keys unmodified', () => {
      expect(getPolicyFieldLabel('unknown_custom_rule')).toBe('unknown_custom_rule');
    });
  });

  describe('getDiffChangeBadgeProps', () => {
    it('returns green sage styling for TIGHTENED changes', () => {
      const badge = getDiffChangeBadgeProps('TIGHTENED');
      expect(badge.label).toBe('TIGHTENED');
      expect(badge.variant).toBe('tightened');
      expect(badge.className).toContain('var(--accent-sage)');
    });

    it('returns peach/warn styling for RELAXED changes', () => {
      const badge = getDiffChangeBadgeProps('RELAXED');
      expect(badge.label).toBe('RELAXED');
      expect(badge.variant).toBe('relaxed');
      expect(badge.className).toContain('var(--status-warn');
    });

    it('returns muted neutral styling for UNCHANGED changes', () => {
      const badge = getDiffChangeBadgeProps('UNCHANGED');
      expect(badge.label).toBe('UNCHANGED');
      expect(badge.variant).toBe('unchanged');
      expect(badge.className).toContain('var(--elevated-bg)');
    });
  });

  describe('getProposalStatusBadgeProps', () => {
    it('returns appropriate label and class names for all proposal statuses', () => {
      expect(getProposalStatusBadgeProps('PENDING').label).toBe('PENDING');
      expect(getProposalStatusBadgeProps('ACTIVATED').label).toBe('ACTIVATED');
      expect(getProposalStatusBadgeProps('REJECTED').label).toBe('REJECTED');
      expect(getProposalStatusBadgeProps('EXPIRED').label).toBe('EXPIRED');
    });
  });

  describe('Proposal TTL & Countdown Calculations', () => {
    const fixedNow = 1700000000000;

    it('correctly determines whether a proposal is expired', () => {
      const past = new Date(fixedNow - 1000).toISOString();
      const future = new Date(fixedNow + 60000).toISOString();

      expect(isProposalExpired(past, fixedNow)).toBe(true);
      expect(isProposalExpired(future, fixedNow)).toBe(false);
      expect(isProposalExpired(new Date(fixedNow).toISOString(), fixedNow)).toBe(true);
      expect(isProposalExpired(null, fixedNow)).toBe(false);
      expect(isProposalExpired(undefined, fixedNow)).toBe(false);
      expect(isProposalExpired('invalid-date', fixedNow)).toBe(false);
    });

    it('calculates remaining proposal TTL in milliseconds clamped to 0', () => {
      const future = new Date(fixedNow + 30000).toISOString();
      const past = new Date(fixedNow - 30000).toISOString();

      expect(calculateRemainingProposalMs(future, fixedNow)).toBe(30000);
      expect(calculateRemainingProposalMs(past, fixedNow)).toBe(0);
      expect(calculateRemainingProposalMs(null, fixedNow)).toBe(0);
    });

    it('formats countdown string appropriately across scales', () => {
      expect(formatProposalCountdown(0)).toBe('Expired');
      expect(formatProposalCountdown(-1000)).toBe('Expired');
      expect(formatProposalCountdown(25000)).toBe('25s');
      expect(formatProposalCountdown(65000)).toBe('1m 5s');
      expect(formatProposalCountdown(120000)).toBe('2m');
      expect(formatProposalCountdown(3660000)).toBe('1h 1m');
      expect(formatProposalCountdown(7200000)).toBe('2h');
    });
  });

  describe('canActivateProposal Gating Logic', () => {
    const baseProposal: PolicyProposalSummary = {
      id: 'prop-test-1',
      baseVersion: 1,
      rules: { auto_limit_minor: 1500 },
      proposalHash: 'hash-123',
      hasRelaxations: false,
      relaxations: [],
      diff: [],
      explanation: 'Test explanation',
      unsupportedRequests: [],
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };

    it('rejects null or undefined proposal', () => {
      expect(canActivateProposal(null)).toEqual({ allowed: false, reason: 'NO_PROPOSAL' });
      expect(canActivateProposal(undefined)).toEqual({ allowed: false, reason: 'NO_PROPOSAL' });
    });

    it('rejects non-PENDING proposals', () => {
      expect(canActivateProposal({ ...baseProposal, status: 'ACTIVATED' })).toEqual({
        allowed: false,
        reason: 'Proposal status is ACTIVATED, cannot be activated',
      });
      expect(canActivateProposal({ ...baseProposal, status: 'REJECTED' })).toEqual({
        allowed: false,
        reason: 'Proposal status is REJECTED, cannot be activated',
      });
      expect(canActivateProposal({ ...baseProposal, status: 'EXPIRED' })).toEqual({
        allowed: false,
        reason: 'Proposal status is EXPIRED, cannot be activated',
      });
    });

    it('rejects expired proposals', () => {
      const expiredProposal = {
        ...baseProposal,
        expiresAt: new Date(Date.now() - 5000).toISOString(),
      };
      expect(canActivateProposal(expiredProposal)).toEqual({
        allowed: false,
        reason: 'PROPOSAL_EXPIRED',
      });
    });

    it('blocks proposal with relaxations when not explicitly acknowledged', () => {
      const relaxedProposal = {
        ...baseProposal,
        hasRelaxations: true,
        relaxations: ['Auto-approve limit increased from $15.00 to $50.00'],
      };

      expect(canActivateProposal(relaxedProposal, { acknowledged: false })).toEqual({
        allowed: false,
        reason: 'RELAXATION_UNACKNOWLEDGED',
      });

      expect(canActivateProposal(relaxedProposal, { acknowledged: undefined })).toEqual({
        allowed: false,
        reason: 'RELAXATION_UNACKNOWLEDGED',
      });
    });

    it('allows proposal with relaxations when explicitly acknowledged', () => {
      const relaxedProposal = {
        ...baseProposal,
        hasRelaxations: true,
        relaxations: ['Auto-approve limit increased from $15.00 to $50.00'],
      };

      expect(canActivateProposal(relaxedProposal, { acknowledged: true })).toEqual({
        allowed: true,
      });
    });

    it('allows proposal without relaxations without requiring acknowledgement', () => {
      expect(canActivateProposal(baseProposal)).toEqual({ allowed: true });
      expect(canActivateProposal(baseProposal, { acknowledged: false })).toEqual({ allowed: true });
    });
  });

  describe('Error Message Resolution', () => {
    it('translates draft errors into clear, security-conscious explanations', () => {
      expect(
        resolveDraftErrorMessage({ data: { error: 'INJECTION_DETECTED' } })
      ).toContain('Security Alert: Prompt injection pattern detected');

      expect(
        resolveDraftErrorMessage({ data: { error: 'INJECTION_SCAN_INDETERMINATE' } })
      ).toContain('Security Alert: Security scanner could not definitively verify prompt safety');

      expect(
        resolveDraftErrorMessage({ data: { error: 'AI_SERVICE_RATE_LIMITED' } })
      ).toContain('AI rate limit exceeded');

      expect(
        resolveDraftErrorMessage({ data: { error: 'AI_SERVICE_TIMEOUT' } })
      ).toContain('AI service timed out');

      expect(
        resolveDraftErrorMessage({ data: { error: 'AI_SERVICE_UNAVAILABLE' } })
      ).toContain('AI service is currently unavailable');

      expect(
        resolveDraftErrorMessage({ data: { error: 'INVALID_PROMPT', message: 'Prompt too long' } })
      ).toBe('Prompt too long');
    });

    it('translates activation errors into actionable guidance', () => {
      expect(
        resolveActivationErrorMessage({ data: { error: 'CONCURRENCY_CONFLICT' } })
      ).toContain('Concurrency Conflict: The active policy version has changed');

      expect(
        resolveActivationErrorMessage({ data: { error: 'PROPOSAL_EXPIRED' } })
      ).toContain('Proposal Expired');

      expect(
        resolveActivationErrorMessage({ data: { error: 'RELAXATION_ACKNOWLEDGEMENT_REQUIRED' } })
      ).toContain('Relaxation Acknowledgement Required');

      expect(
        resolveActivationErrorMessage({ data: { error: 'PROPOSAL_HASH_MISMATCH' } })
      ).toContain('Security Error: Proposal hash mismatch detected');

      expect(
        resolveActivationErrorMessage({ data: { error: 'RULE_CONSTRAINT_VIOLATION' } })
      ).toContain('Validation Error: Proposal rules violate deterministic policy engine invariants');
    });
  });
});

