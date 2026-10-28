import { describe, it, expect } from 'vitest';
import {
  validatePolicyDocument,
  safeValidatePolicyDocument,
  type PolicyDocument,
} from '../../src/policy/types.js';
import { MAX_MINOR_UNITS } from '../../src/core/money.js';

describe('Policy Document Schema Validation (M1-T4)', () => {
  // Canonical Demo Policy v1 per PAYGUARD_PLAN.md Section 4.2
  const validDemoPolicyV1 = {
    version: 1,
    currency_allowlist: ['USD'],
    auto_limit_minor: 1500, // $15.00 auto-approve
    hard_cap_minor: 10000, // $100.00 absolute max
    agent_daily_budget_minor: 5000, // $50.00 per agent per rolling 24h
    global_daily_budget_minor: 20000, // $200.00 global daily budget
    velocity: {
      max_requests: 5,
      window_minutes: 10,
    },
    duplicate_window_minutes: 60,
    new_vendor_action: 'HOLD',
    hold_ttl_minutes: 15,
  };

  describe('Valid Policy Document Acceptance', () => {
    it('should parse and accept the canonical Demo Policy v1', () => {
      const policy: PolicyDocument = validatePolicyDocument(validDemoPolicyV1);

      expect(policy.version).toBe(1);
      expect(policy.currency_allowlist).toEqual(['USD']);
      expect(policy.auto_limit_minor).toBe(1500);
      expect(policy.hard_cap_minor).toBe(10000);
      expect(policy.agent_daily_budget_minor).toBe(5000);
      expect(policy.global_daily_budget_minor).toBe(20000);
      expect(policy.velocity).toEqual({ max_requests: 5, window_minutes: 10 });
      expect(policy.duplicate_window_minutes).toBe(60);
      expect(policy.new_vendor_action).toBe('HOLD');
      expect(policy.hold_ttl_minutes).toBe(15);
    });

    it('should accept policy with multiple valid currencies', () => {
      const customPolicy = {
        ...validDemoPolicyV1,
        currency_allowlist: ['USD', 'EUR', 'GBP'],
      };
      const result = validatePolicyDocument(customPolicy);
      expect(result.currency_allowlist).toEqual(['USD', 'EUR', 'GBP']);
    });

    it('should accept new_vendor_action set to DENY', () => {
      const denyPolicy = {
        ...validDemoPolicyV1,
        new_vendor_action: 'DENY',
      };
      const result = validatePolicyDocument(denyPolicy);
      expect(result.new_vendor_action).toBe('DENY');
    });

    it('should accept hard_cap_minor exactly equal to auto_limit_minor', () => {
      const equalPolicy = {
        ...validDemoPolicyV1,
        auto_limit_minor: 5000,
        hard_cap_minor: 5000,
      };
      const result = validatePolicyDocument(equalPolicy);
      expect(result.auto_limit_minor).toBe(5000);
      expect(result.hard_cap_minor).toBe(5000);
    });

    it('should accept global_daily_budget_minor exactly equal to agent_daily_budget_minor', () => {
      const equalPolicy = {
        ...validDemoPolicyV1,
        agent_daily_budget_minor: 5000,
        global_daily_budget_minor: 5000,
      };
      const result = validatePolicyDocument(equalPolicy);
      expect(result.agent_daily_budget_minor).toBe(5000);
      expect(result.global_daily_budget_minor).toBe(5000);
    });

    it('should accept policy where global_daily_budget_minor is smaller than agent_daily_budget_minor', () => {
      const policyWithLowerGlobal = {
        ...validDemoPolicyV1,
        agent_daily_budget_minor: 10000, // $100.00
        global_daily_budget_minor: 5000, // $50.00 (independent budget allocations)
      };
      const result = validatePolicyDocument(policyWithLowerGlobal);
      expect(result.agent_daily_budget_minor).toBe(10000);
      expect(result.global_daily_budget_minor).toBe(5000);
    });

    it('should accept maximum permitted minor units (999,999,999)', () => {
      const maxPolicy = {
        ...validDemoPolicyV1,
        auto_limit_minor: 1000,
        hard_cap_minor: MAX_MINOR_UNITS,
        agent_daily_budget_minor: MAX_MINOR_UNITS,
        global_daily_budget_minor: MAX_MINOR_UNITS,
      };
      const result = validatePolicyDocument(maxPolicy);
      expect(result.hard_cap_minor).toBe(MAX_MINOR_UNITS);
    });

    it('should return success in safeValidatePolicyDocument for valid documents', () => {
      const result = safeValidatePolicyDocument(validDemoPolicyV1);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBe(1);
      }
    });
  });

  describe('Invalid Policy Document Rejection (M1-T4 Acceptance Gate)', () => {
    it('should reject missing required fields', () => {
      const requiredFields = [
        'version',
        'currency_allowlist',
        'auto_limit_minor',
        'hard_cap_minor',
        'agent_daily_budget_minor',
        'global_daily_budget_minor',
        'velocity',
        'duplicate_window_minutes',
        'new_vendor_action',
        'hold_ttl_minutes',
      ] as const;

      for (const field of requiredFields) {
        const invalidDoc = { ...validDemoPolicyV1 };
        delete (invalidDoc as Record<string, unknown>)[field];

        expect(() => validatePolicyDocument(invalidDoc)).toThrow();
        const safe = safeValidatePolicyDocument(invalidDoc);
        expect(safe.success).toBe(false);
      }
    });

    it('should reject empty currency_allowlist', () => {
      const invalid = {
        ...validDemoPolicyV1,
        currency_allowlist: [],
      };
      expect(() => validatePolicyDocument(invalid)).toThrow();
    });

    it('should reject invalid currency codes in allowlist', () => {
      const testCases = [
        ['usd'], // lowercase
        ['US'], // 2 letters
        ['USDD'], // 4 letters
        ['U$D'], // special characters
        ['123'], // digits
        [''], // empty string
      ];

      for (const currency_allowlist of testCases) {
        const invalid = { ...validDemoPolicyV1, currency_allowlist };
        expect(() => validatePolicyDocument(invalid)).toThrow();
      }
    });

    it('should reject negative minor unit limits', () => {
      const fields = [
        'auto_limit_minor',
        'hard_cap_minor',
        'agent_daily_budget_minor',
        'global_daily_budget_minor',
      ] as const;

      for (const field of fields) {
        const invalid = { ...validDemoPolicyV1, [field]: -1 };
        expect(() => validatePolicyDocument(invalid)).toThrow();
      }
    });

    it('should reject floating-point decimals in monetary limits', () => {
      const fields = [
        'auto_limit_minor',
        'hard_cap_minor',
        'agent_daily_budget_minor',
        'global_daily_budget_minor',
      ] as const;

      for (const field of fields) {
        const invalid = { ...validDemoPolicyV1, [field]: 15.5 };
        expect(() => validatePolicyDocument(invalid)).toThrow();
      }
    });

    it('should reject monetary amounts exceeding MAX_MINOR_UNITS', () => {
      const invalid = {
        ...validDemoPolicyV1,
        hard_cap_minor: 1_000_000_000,
        global_daily_budget_minor: 1_000_000_000,
      };
      expect(() => validatePolicyDocument(invalid)).toThrow();
    });

    it('should reject hard_cap_minor smaller than auto_limit_minor', () => {
      const invalid = {
        ...validDemoPolicyV1,
        auto_limit_minor: 15000, // $150.00
        hard_cap_minor: 10000, // $100.00 (hard cap < auto limit)
      };
      expect(() => validatePolicyDocument(invalid)).toThrow();
      const safe = safeValidatePolicyDocument(invalid);
      expect(safe.success).toBe(false);
      if (!safe.success) {
        const issue = safe.error.issues.find((i: { path: readonly PropertyKey[] }) =>
          i.path.includes('hard_cap_minor')
        );
        expect(issue).toBeDefined();
        expect(issue?.message).toContain('hard_cap_minor must be greater than or equal to auto_limit_minor');
      }
    });

    it('should reject hold_ttl_minutes less than 1 or non-integer', () => {
      expect(() => validatePolicyDocument({ ...validDemoPolicyV1, hold_ttl_minutes: 0 })).toThrow();
      expect(() => validatePolicyDocument({ ...validDemoPolicyV1, hold_ttl_minutes: -1 })).toThrow();
      expect(() => validatePolicyDocument({ ...validDemoPolicyV1, hold_ttl_minutes: 1.5 })).toThrow();
    });

    it('should reject invalid new_vendor_action values, especially ALLOW', () => {
      // Critical security rule: unverified vendors must never be automatically allowed
      const forbiddenValues = ['ALLOW', 'APPROVED', 'IGNORE', 'SKIP', '', 'hold', 'deny', 123];

      for (const new_vendor_action of forbiddenValues) {
        const invalid = { ...validDemoPolicyV1, new_vendor_action };
        expect(() => validatePolicyDocument(invalid)).toThrow();
      }
    });

    it('should reject non-positive or non-integer velocity settings', () => {
      expect(() =>
        validatePolicyDocument({
          ...validDemoPolicyV1,
          velocity: { max_requests: 0, window_minutes: 10 },
        })
      ).toThrow();

      expect(() =>
        validatePolicyDocument({
          ...validDemoPolicyV1,
          velocity: { max_requests: 5, window_minutes: 0 },
        })
      ).toThrow();

      expect(() =>
        validatePolicyDocument({
          ...validDemoPolicyV1,
          velocity: { max_requests: 2.5, window_minutes: 10 },
        })
      ).toThrow();
    });

    it('should reject negative duplicate_window_minutes', () => {
      const invalid = {
        ...validDemoPolicyV1,
        duplicate_window_minutes: -1,
      };
      expect(() => validatePolicyDocument(invalid)).toThrow();
    });

    it('should reject version less than 1 or non-integer', () => {
      expect(() => validatePolicyDocument({ ...validDemoPolicyV1, version: 0 })).toThrow();
      expect(() => validatePolicyDocument({ ...validDemoPolicyV1, version: -1 })).toThrow();
      expect(() => validatePolicyDocument({ ...validDemoPolicyV1, version: 1.5 })).toThrow();
    });

    it('should reject non-object or null input', () => {
      expect(() => validatePolicyDocument(null)).toThrow();
      expect(() => validatePolicyDocument(undefined)).toThrow();
      expect(() => validatePolicyDocument('string')).toThrow();
      expect(() => validatePolicyDocument(123)).toThrow();
      expect(() => validatePolicyDocument([])).toThrow();
    });
  });
});
