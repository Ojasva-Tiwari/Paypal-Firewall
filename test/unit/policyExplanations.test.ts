/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T2: Comprehensive Deterministic Policy Explanations Test Suite
 *
 * Verifies:
 * 1. Exact mandatory wording for ALLOW decisions (never claims capture/execution).
 * 2. VENDOR_NEW severity and copy dynamically aligns with HOLD vs DENY precedence.
 * 3. All 13 canonical reason codes produce valid, fact-disciplined explanations.
 * 4. Overall evaluated decision governs compound reason severity (DENY is never approvable).
 * 5. Fact discipline: missing metadata falls back to generic copy without inventing facts or printing undefined/NaN.
 * 6. Unknown reason codes degrade safely without throwing.
 * 7. Security: explanations never leak tokens, hashes, credentials, or internal secrets.
 */

import { describe, it, expect } from 'vitest';
import {
  explainReasonCode,
  explainPolicyDecision,
  type PolicyExplanationContext,
} from '../../src/policy/explanations.js';

describe('M5-T2: Deterministic Policy Explanations', () => {
  // ==========================================================================
  // 1. Mandatory ALLOW Wording Verification
  // ==========================================================================
  describe('ALLOW Decision Precision', () => {
    it('uses exact approved phrasing and NEVER claims capture or PayPal execution', () => {
      const result = explainPolicyDecision('ALLOW', []);

      expect(result.decision).toBe('ALLOW');
      expect(result.items).toHaveLength(1);

      const item = result.items[0]!;
      expect(item.title).toBe('Policy Check Passed');
      expect(item.description).toBe('The payment request satisfied all deterministic policy checks.');
      expect(item.recommendedAction).toBe('Continue through the configured payment execution workflow.');
      expect(item.severity).toBe('INFO');

      // Negative assertion: must never state or imply funds were moved or PayPal succeeded
      const serialized = JSON.stringify(result).toLowerCase();
      expect(serialized).not.toContain('captured');
      expect(serialized).not.toContain('paypal executed');
      expect(serialized).not.toContain('funds moved');
      expect(serialized).not.toContain('payment sent');
    });

    it('handles empty reasons list with ALLOW decision', () => {
      const result = explainPolicyDecision('ALLOW', [], {
        amountMinor: 1500,
        currency: 'USD',
        vendorName: 'Acme Cloud',
      });

      expect(result.decision).toBe('ALLOW');
      expect(result.summary).toBe('Policy check passed: transaction satisfied all deterministic policy rules.');
      expect(result.nextSteps).toBe('Continue through the configured payment execution workflow.');
    });
  });

  // ==========================================================================
  // 2. VENDOR_NEW Severity & Decision Precedence
  // ==========================================================================
  describe('VENDOR_NEW Precedence & Dynamic Severity', () => {
    it('reflects HOLD severity when policy new_vendor_action is HOLD', () => {
      const context: PolicyExplanationContext = {
        vendorName: 'Acme Cloud',
        vendorId: 'ven-acme',
        newVendorAction: 'HOLD',
      };

      const item = explainReasonCode('VENDOR_NEW', context, 'HOLD');
      expect(item.severity).toBe('HOLD');
      expect(item.title).toBe('Unverified Vendor Awaiting Review');
      expect(item.description).toContain("Recipient vendor 'Acme Cloud' is newly registered and unverified.");
      expect(item.description).toContain('First-time payments require owner confirmation.');
      expect(item.recommendedAction).toContain('approve or void the payment hold before expiry');
    });

    it('reflects DENY severity when policy new_vendor_action is DENY', () => {
      const context: PolicyExplanationContext = {
        vendorName: 'Acme Cloud',
        vendorId: 'ven-acme',
        newVendorAction: 'DENY',
      };

      const item = explainReasonCode('VENDOR_NEW', context, 'DENY');
      expect(item.severity).toBe('DENY');
      expect(item.title).toBe('Unverified Vendor Prohibited');
      expect(item.description).toContain("Recipient vendor 'Acme Cloud' is unverified.");
      expect(item.description).toContain('payments to unverified vendors are denied.');
      expect(item.recommendedAction).toContain('Verify and activate the vendor in the vendor registry');
    });

    it('overall decision DENY forces VENDOR_NEW item severity to DENY even if newVendorAction was HOLD', () => {
      const context: PolicyExplanationContext = {
        vendorName: 'Acme Cloud',
        newVendorAction: 'HOLD',
      };

      // In a compound decision where another rule caused a DENY, VENDOR_NEW must reflect DENY
      const item = explainReasonCode('VENDOR_NEW', context, 'DENY');
      expect(item.severity).toBe('DENY');
      expect(item.title).toBe('Unverified Vendor Prohibited');
    });
  });

  // ==========================================================================
  // 3. All 13 Canonical Reason Codes Verification
  // ==========================================================================
  describe('Canonical Reason Code Explanations', () => {
    const fullContext: PolicyExplanationContext = {
      agentId: 'agent-123',
      agentName: 'Research Agent',
      vendorId: 'ven-acme',
      vendorName: 'Acme Cloud',
      amountMinor: 2500,
      currency: 'USD',
      category: 'cloud_services',
      purpose: 'API cluster hosting',
      autoLimitMinor: 1500,
      hardCapMinor: 5000,
      agentBudgetMinor: 10000,
      globalBudgetMinor: 50000,
      currentAgentSpendMinor: 9500,
      currentGlobalSpendMinor: 49000,
      recentRequestCount: 6,
      velocityWindowMinutes: 5,
      velocityMaxRequests: 5,
      duplicateWindowMinutes: 10,
      allowedCurrencies: ['USD', 'EUR'],
      vendorCategories: ['cloud_compute', 'saas'],
    };

    it('explains AGENT_SUSPENDED correctly', () => {
      const item = explainReasonCode('AGENT_SUSPENDED', fullContext, 'DENY');
      expect(item.severity).toBe('DENY');
      expect(item.title).toBe('Agent Credentials Suspended');
      expect(item.ruleId).toBe('RULE_AGENT_STATUS');
      expect(item.description).toContain("Requesting agent 'Research Agent' has been marked SUSPENDED");
      expect(item.recommendedAction).toContain('Re-activate the agent in the agent registry');
    });

    it('explains VENDOR_UNKNOWN correctly', () => {
      const item = explainReasonCode('VENDOR_UNKNOWN', fullContext, 'DENY');
      expect(item.severity).toBe('DENY');
      expect(item.title).toBe('Unregistered Payee');
      expect(item.ruleId).toBe('RULE_VENDOR_STATUS');
      expect(item.description).toContain("Recipient vendor 'Acme Cloud' is not in the approved vendor registry");
      expect(item.recommendedAction).toContain('Register and verify the payee');
    });

    it('explains VENDOR_BLOCKED correctly', () => {
      const item = explainReasonCode('VENDOR_BLOCKED', fullContext, 'DENY');
      expect(item.severity).toBe('DENY');
      expect(item.title).toBe('Payee Explicitly Blocked');
      expect(item.ruleId).toBe('RULE_VENDOR_STATUS');
      expect(item.description).toContain("Recipient vendor 'Acme Cloud' is explicitly flagged as BLOCKED");
      expect(item.recommendedAction).toContain('Payments to blocked payees are prohibited');
    });

    it('explains CURRENCY_NOT_ALLOWED correctly', () => {
      const item = explainReasonCode('CURRENCY_NOT_ALLOWED', { ...fullContext, currency: 'GBP' }, 'DENY');
      expect(item.severity).toBe('DENY');
      expect(item.title).toBe('Currency Not Permitted');
      expect(item.ruleId).toBe('RULE_CURRENCY_ALLOWLIST');
      expect(item.description).toContain("Currency 'GBP' is not permitted");
      expect(item.description).toContain('[USD, EUR]');
      expect(item.recommendedAction).toContain('Submit payment requests using an authorized currency');
    });

    it('explains OVER_HARD_CAP correctly', () => {
      const item = explainReasonCode('OVER_HARD_CAP', fullContext, 'DENY');
      expect(item.severity).toBe('DENY');
      expect(item.title).toBe('Exceeds Maximum Hard Cap');
      expect(item.ruleId).toBe('RULE_HARD_CAP');
      expect(item.description).toContain('Requested amount of $25.00 USD exceeds the non-negotiable policy hard cap of $50.00 USD');
      expect(item.recommendedAction).toContain('Transaction cannot be approved');
    });

    it('explains GLOBAL_BUDGET_EXCEEDED correctly', () => {
      const item = explainReasonCode('GLOBAL_BUDGET_EXCEEDED', fullContext, 'DENY');
      expect(item.severity).toBe('DENY');
      expect(item.title).toBe('Global Daily Budget Exhausted');
      expect(item.ruleId).toBe('RULE_GLOBAL_DAILY_BUDGET');
      expect(item.description).toContain('Total system rolling 24-hour spend and reserves ($490.00 USD) exceed the global daily budget limit ($500.00 USD)');
      expect(item.recommendedAction).toContain('Wait for the rolling 24-hour budget window to replenish');
    });

    it('explains OVER_AUTO_LIMIT correctly under HOLD', () => {
      const item = explainReasonCode('OVER_AUTO_LIMIT', fullContext, 'HOLD');
      expect(item.severity).toBe('HOLD');
      expect(item.title).toBe('Exceeds Auto-Approval Limit');
      expect(item.ruleId).toBe('RULE_AUTO_LIMIT');
      expect(item.description).toContain('Requested amount of $25.00 USD exceeds the single-transaction auto-approval limit of $15.00 USD');
      expect(item.recommendedAction).toContain('Review payment justification and approve or void');
    });

    it('explains AGENT_BUDGET_EXCEEDED correctly under HOLD', () => {
      const item = explainReasonCode('AGENT_BUDGET_EXCEEDED', fullContext, 'HOLD');
      expect(item.severity).toBe('HOLD');
      expect(item.title).toBe('Agent Daily Budget Exhausted');
      expect(item.ruleId).toBe('RULE_AGENT_DAILY_BUDGET');
      expect(item.description).toContain("Requesting agent 'Research Agent' rolling 24-hour spend and reserves exceed their allocated daily limit of $100.00 USD");
      expect(item.recommendedAction).toContain('Wait for rolling 24-hour budget window to replenish');
    });

    it('explains VELOCITY correctly under HOLD', () => {
      const item = explainReasonCode('VELOCITY', fullContext, 'HOLD');
      expect(item.severity).toBe('HOLD');
      expect(item.title).toBe('High Request Velocity');
      expect(item.ruleId).toBe('RULE_VELOCITY');
      expect(item.description).toContain('Agent submitted 6 payment requests within a 5-minute velocity window');
      expect(item.recommendedAction).toContain('ensure it is not looping before approving');
    });

    it('explains DUPLICATE correctly under HOLD', () => {
      const item = explainReasonCode('DUPLICATE', fullContext, 'HOLD');
      expect(item.severity).toBe('HOLD');
      expect(item.title).toBe('Duplicate Transaction Pattern');
      expect(item.ruleId).toBe('RULE_DUPLICATE');
      expect(item.description).toContain("A matching payment to 'Acme Cloud' with identical amount was submitted within the 10-minute deduplication window");
      expect(item.recommendedAction).toContain('Verify the agent did not duplicate an existing invoice');
    });

    it('explains CATEGORY_MISMATCH correctly under HOLD', () => {
      const item = explainReasonCode('CATEGORY_MISMATCH', fullContext, 'HOLD');
      expect(item.severity).toBe('HOLD');
      expect(item.title).toBe('Vendor Category Mismatch');
      expect(item.ruleId).toBe('RULE_VENDOR_CATEGORY');
      expect(item.description).toContain("Payment category 'cloud_services' does not match registered categories for vendor 'Acme Cloud'");
      expect(item.recommendedAction).toContain('Confirm purchase category matches expected vendor services');
    });

    it('explains AI_FLAG correctly under HOLD', () => {
      const item = explainReasonCode('AI_FLAG', fullContext, 'HOLD');
      expect(item.severity).toBe('HOLD');
      expect(item.title).toBe('Security Risk Flag');
      expect(item.ruleId).toBe('RULE_AI_FLAG');
      expect(item.description).toContain('external risk scanner flagged this transaction for human oversight');
      expect(item.recommendedAction).toContain('Inspect source context, invoice details, and agent instructions');
    });
  });

  // ==========================================================================
  // 4. Overall Decision Precedence in Compound Outcomes
  // ==========================================================================
  describe('Compound Reasons & Overall Decision Precedence', () => {
    it('governs compound reasons under DENY: soft triggers are never presented as approvable', () => {
      const reasons = ['OVER_HARD_CAP', 'OVER_AUTO_LIMIT', 'VENDOR_NEW', 'AI_FLAG'];
      const decision = 'DENY';

      const result = explainPolicyDecision(decision, reasons, {
        amountMinor: 100000,
        currency: 'USD',
        vendorName: 'Untrusted Vendor',
      });

      expect(result.decision).toBe('DENY');
      expect(result.summary).toContain('Payment denied: request violates deterministic policy restrictions (4 triggers)');
      expect(result.nextSteps).toContain('Transaction cannot be approved or retried');

      // Every item must have severity DENY
      for (const item of result.items) {
        expect(item.severity).toBe('DENY');
        // Recommended action must never tell the user to approve a hold
        expect(item.recommendedAction.toLowerCase()).not.toContain('approve or void the payment hold');
        expect(item.recommendedAction.toLowerCase()).not.toContain('approve the hold');
      }
    });

    it('governs compound reasons under HOLD: communicates human review and expiry', () => {
      const reasons = ['OVER_AUTO_LIMIT', 'VENDOR_NEW', 'AI_FLAG'];
      const decision = 'HOLD';

      const result = explainPolicyDecision(decision, reasons, {
        amountMinor: 2500,
        currency: 'USD',
        vendorName: 'Acme Cloud',
      });

      expect(result.decision).toBe('HOLD');
      expect(result.summary).toContain('Payment held: transaction requires manual owner review (3 triggers)');
      expect(result.nextSteps).toContain('An owner session must approve or void the authorization before hold expiration');

      for (const item of result.items) {
        expect(item.severity).toBe('HOLD');
      }
    });
  });

  // ==========================================================================
  // 5. Fact Discipline & Zero Fabrication (Missing Metadata)
  // ==========================================================================
  describe('Fact Discipline & Missing Metadata Resilience', () => {
    it('generates clean fallback copy when context is completely empty or undefined', () => {
      const allCodes = [
        'AGENT_SUSPENDED',
        'VENDOR_UNKNOWN',
        'VENDOR_BLOCKED',
        'CURRENCY_NOT_ALLOWED',
        'OVER_HARD_CAP',
        'GLOBAL_BUDGET_EXCEEDED',
        'VENDOR_NEW',
        'OVER_AUTO_LIMIT',
        'AGENT_BUDGET_EXCEEDED',
        'VELOCITY',
        'DUPLICATE',
        'CATEGORY_MISMATCH',
        'AI_FLAG',
      ];

      for (const code of allCodes) {
        const item = explainReasonCode(code, {}, 'HOLD');

        expect(item.title).toBeTruthy();
        expect(item.description).toBeTruthy();
        expect(item.recommendedAction).toBeTruthy();

        // Check for forbidden artifacts
        expect(item.description).not.toContain('undefined');
        expect(item.description).not.toContain('null');
        expect(item.description).not.toContain('NaN');
        expect(item.description).not.toContain('[object Object]');
        expect(item.description).not.toContain("''");
        expect(item.recommendedAction).not.toContain('undefined');
      }
    });

    it('safely handles partial metadata without fabricating absent fields', () => {
      // Amount is provided, but hard cap limit is omitted
      const item = explainReasonCode('OVER_HARD_CAP', { amountMinor: 2500, currency: 'USD' }, 'DENY');
      expect(item.description).toBe('Requested amount of $25.00 USD exceeds the non-negotiable policy hard cap.');
      expect(item.description).not.toContain('exceeds the non-negotiable policy hard cap of $');
    });

    it('safely handles vendor ID when vendor Name is omitted', () => {
      const item = explainReasonCode('VENDOR_UNKNOWN', { vendorId: 'ven-anonymous-123' }, 'DENY');
      expect(item.description).toContain("Recipient vendor 'ven-anonymous-123' is not in the approved vendor registry");
    });
  });

  // ==========================================================================
  // 6. Unknown Reason Code Handling
  // ==========================================================================
  describe('Unknown Reason Code Fallback', () => {
    it('degrades safely without throwing for unrecognized reason codes', () => {
      const item = explainReasonCode('EXPERIMENTAL_HEURISTIC_TRIGGER', {}, 'HOLD');

      expect(item.code).toBe('EXPERIMENTAL_HEURISTIC_TRIGGER');
      expect(item.title).toBe('Policy Trigger: EXPERIMENTAL_HEURISTIC_TRIGGER');
      expect(item.severity).toBe('HOLD');
      expect(item.description).toBe("Triggered policy condition 'EXPERIMENTAL_HEURISTIC_TRIGGER'. Standard policy rules apply.");
      expect(item.recommendedAction).toContain('Review transaction parameters');
    });

    it('unknown code under DENY decision adopts DENY severity and denial action', () => {
      const item = explainReasonCode('UNKNOWN_TRIGGER_CODE', {}, 'DENY');
      expect(item.severity).toBe('DENY');
      expect(item.recommendedAction).toContain('Transaction is denied under policy precedence');
    });
  });

  // ==========================================================================
  // 7. Security & Non-Exposure
  // ==========================================================================
  describe('Security & Sensitive Data Isolation', () => {
    it('never leaks internal secrets or tokens into explanation descriptions', () => {
      const dirtyContext: PolicyExplanationContext = {
        vendorName: 'Acme Cloud',
        purpose: 'Server hosting',
      };

      const result = explainPolicyDecision('HOLD', ['OVER_AUTO_LIMIT', 'AI_FLAG'], dirtyContext);
      const output = JSON.stringify(result);

      // Verify no credential tokens or database internals are fabricated
      expect(output).not.toContain('token_hash');
      expect(output).not.toContain('snapshot_hash');
      expect(output).not.toContain('client_secret');
      expect(output).not.toContain('session_secret');
      expect(output).not.toContain('api_key');
    });
  });
});
