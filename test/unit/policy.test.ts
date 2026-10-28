/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T5: Deterministic Policy Engine Unit Tests
 *
 * Implements comprehensive table-driven tests (>= 40 cases),
 * edge/boundary tests, precedence tests, safe integer overflow tests,
 * malformed input rejection tests, and Invariant I6 stricter-only AI tests.
 */

import { describe, it, expect } from 'vitest';
import { evaluatePolicy, PolicyEngineError } from '../../src/policy/engine.js';
import type {
  PolicyRequest,
  PolicyFacts,
  PolicyDocument,
  ReasonCode,
  Decision,
} from '../../src/policy/types.js';
import { type MinorUnits, MAX_MINOR_UNITS } from '../../src/core/money.js';

describe('Deterministic Policy Engine (M1-T5)', () => {
  // Canonical Demo Policy v1 per PAYGUARD_PLAN.md Section 4.2
  const canonicalPolicy: PolicyDocument = {
    version: 1,
    currency_allowlist: ['USD'],
    auto_limit_minor: 1500 as MinorUnits, // $15.00 auto-approve
    hard_cap_minor: 10000 as MinorUnits, // $100.00 absolute max
    agent_daily_budget_minor: 5000 as MinorUnits, // $50.00 agent rolling 24h budget
    global_daily_budget_minor: 20000 as MinorUnits, // $200.00 global rolling 24h budget
    velocity: {
      max_requests: 5,
      window_minutes: 10,
    },
    duplicate_window_minutes: 60,
    new_vendor_action: 'HOLD',
    hold_ttl_minutes: 15,
  };

  // Baseline clean request ($12.00 to Acme Cloud)
  const baseRequest: PolicyRequest = {
    agentId: 'honest-agent-1',
    vendorId: 'acme-cloud',
    amountMinor: 1200 as MinorUnits, // $12.00
    currency: 'USD',
    purpose: 'API credits subscription',
    category: 'cloud',
    idempotencyKey: 'idemp-key-001',
  };

  // Baseline clean facts
  const baseFacts: PolicyFacts = {
    agentStatus: 'ACTIVE',
    vendorStatus: 'ACTIVE',
    vendorCategories: ['cloud', 'hosting'],
    vendorCurrencies: ['USD'],
    agentSpendRolling24hMinor: 0 as MinorUnits,
    agentReservedRolling24hMinor: 0 as MinorUnits,
    globalSpendRolling24hMinor: 0 as MinorUnits,
    globalReservedRolling24hMinor: 0 as MinorUnits,
    recentRequestCountInVelocityWindow: 0,
    hasDuplicateInWindow: false,
  };

  // ==========================================================================
  // 1. Table-Driven Evaluation Tests (>= 40 cases)
  // ==========================================================================
  interface TestCase {
    readonly id: number;
    readonly description: string;
    readonly request?: Partial<PolicyRequest>;
    readonly facts?: Partial<PolicyFacts>;
    readonly policy?: Partial<PolicyDocument>;
    readonly options?: { aiFlags?: string[]; now?: Date };
    readonly expectedDecision: Decision;
    readonly expectedReasons: readonly ReasonCode[];
  }

  const tableDrivenCases: readonly TestCase[] = [
    // ------------------------------------------------------------------------
    // Baseline & Amount Boundaries (Auto Limit & Hard Cap)
    // ------------------------------------------------------------------------
    {
      id: 1,
      description: 'Scenario 1: Normal clean purchase under auto-limit ($12.00)',
      request: { amountMinor: 1200 as MinorUnits },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 2,
      description: 'Minimum permitted positive payment (1 minor unit / $0.01)',
      request: { amountMinor: 1 as MinorUnits },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 3,
      description: 'Auto-limit exact boundary ($15.00 / 1500 minor units)',
      request: { amountMinor: 1500 as MinorUnits },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 4,
      description: 'Auto-limit boundary + 1 minor unit ($15.01 / 1501 minor units)',
      request: { amountMinor: 1501 as MinorUnits },
      expectedDecision: 'HOLD',
      expectedReasons: ['OVER_AUTO_LIMIT'],
    },
    {
      id: 5,
      description: 'Auto-limit boundary - 1 minor unit ($14.99 / 1499 minor units)',
      request: { amountMinor: 1499 as MinorUnits },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 6,
      description: 'Hard-cap exact boundary ($100.00 / 10000 minor units) -> Soft HOLD for auto-limit only',
      request: { amountMinor: 10000 as MinorUnits },
      policy: {
        agent_daily_budget_minor: 50000 as MinorUnits,
        global_daily_budget_minor: 50000 as MinorUnits,
      },
      expectedDecision: 'HOLD',
      expectedReasons: ['OVER_AUTO_LIMIT'],
    },
    {
      id: 7,
      description: 'Hard-cap boundary + 1 minor unit ($100.01 / 10001 minor units) -> Hard DENY',
      request: { amountMinor: 10001 as MinorUnits },
      policy: {
        agent_daily_budget_minor: 50000 as MinorUnits,
        global_daily_budget_minor: 50000 as MinorUnits,
      },
      expectedDecision: 'DENY',
      expectedReasons: ['OVER_HARD_CAP', 'OVER_AUTO_LIMIT'],
    },
    {
      id: 8,
      description: 'Hard-cap boundary - 1 minor unit ($99.99 / 9999 minor units) -> Soft HOLD',
      request: { amountMinor: 9999 as MinorUnits },
      policy: {
        agent_daily_budget_minor: 50000 as MinorUnits,
        global_daily_budget_minor: 50000 as MinorUnits,
      },
      expectedDecision: 'HOLD',
      expectedReasons: ['OVER_AUTO_LIMIT'],
    },
    {
      id: 9,
      description: 'Zero amount payment (0 minor units) -> Hard DENY OVER_HARD_CAP',
      request: { amountMinor: 0 as MinorUnits },
      expectedDecision: 'DENY',
      expectedReasons: ['OVER_HARD_CAP'],
    },
    {
      id: 10,
      description: 'Negative amount payment (-1 minor units) -> Hard DENY OVER_HARD_CAP',
      request: { amountMinor: -1 as MinorUnits },
      expectedDecision: 'DENY',
      expectedReasons: ['OVER_HARD_CAP'],
    },

    // ------------------------------------------------------------------------
    // Agent Status Checks
    // ------------------------------------------------------------------------
    {
      id: 11,
      description: 'Agent active -> clean ALLOW',
      facts: { agentStatus: 'ACTIVE' },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 12,
      description: 'Agent suspended -> Hard DENY AGENT_SUSPENDED',
      facts: { agentStatus: 'SUSPENDED' },
      expectedDecision: 'DENY',
      expectedReasons: ['AGENT_SUSPENDED'],
    },

    // ------------------------------------------------------------------------
    // Vendor Status Checks
    // ------------------------------------------------------------------------
    {
      id: 13,
      description: 'Vendor active -> clean ALLOW',
      facts: { vendorStatus: 'ACTIVE' },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 14,
      description: 'Vendor missing from registry -> Hard DENY VENDOR_UNKNOWN',
      facts: { vendorStatus: 'MISSING' },
      expectedDecision: 'DENY',
      expectedReasons: ['VENDOR_UNKNOWN'],
    },
    {
      id: 15,
      description: 'Vendor blocked in registry -> Hard DENY VENDOR_BLOCKED',
      facts: { vendorStatus: 'BLOCKED' },
      expectedDecision: 'DENY',
      expectedReasons: ['VENDOR_BLOCKED'],
    },
    {
      id: 16,
      description: 'Vendor unverified with new_vendor_action = HOLD -> Soft HOLD VENDOR_NEW',
      facts: { vendorStatus: 'UNVERIFIED' },
      policy: { new_vendor_action: 'HOLD' },
      expectedDecision: 'HOLD',
      expectedReasons: ['VENDOR_NEW'],
    },
    {
      id: 17,
      description: 'Vendor unverified with new_vendor_action = DENY -> Hard DENY VENDOR_NEW',
      facts: { vendorStatus: 'UNVERIFIED' },
      policy: { new_vendor_action: 'DENY' },
      expectedDecision: 'DENY',
      expectedReasons: ['VENDOR_NEW'],
    },

    // ------------------------------------------------------------------------
    // Vendor Category Checks
    // ------------------------------------------------------------------------
    {
      id: 18,
      description: 'Request category matches vendor registered category -> ALLOW',
      request: { category: 'cloud' },
      facts: { vendorCategories: ['cloud', 'hosting'] },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 19,
      description: 'Request category does not match vendor registered categories -> Soft HOLD CATEGORY_MISMATCH',
      request: { category: 'marketing' },
      facts: { vendorCategories: ['cloud', 'hosting'] },
      expectedDecision: 'HOLD',
      expectedReasons: ['CATEGORY_MISMATCH'],
    },
    {
      id: 20,
      description: 'Request category missing when vendor has registered categories -> Soft HOLD CATEGORY_MISMATCH',
      request: { category: undefined },
      facts: { vendorCategories: ['cloud', 'hosting'] },
      expectedDecision: 'HOLD',
      expectedReasons: ['CATEGORY_MISMATCH'],
    },
    {
      id: 21,
      description: 'Vendor has no category restrictions (undefined) -> ALLOW',
      request: { category: 'any-category' },
      facts: { vendorCategories: undefined },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 22,
      description: 'Vendor has empty category array -> ALLOW',
      request: { category: 'any-category' },
      facts: { vendorCategories: [] },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },

    // ------------------------------------------------------------------------
    // Currency Allowlist Checks
    // ------------------------------------------------------------------------
    {
      id: 23,
      description: 'Currency allowed in policy allowlist (USD) -> ALLOW',
      request: { currency: 'USD' },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 24,
      description: 'Currency not in policy allowlist (EUR when only USD allowed) -> Hard DENY CURRENCY_NOT_ALLOWED',
      request: { currency: 'EUR' },
      expectedDecision: 'DENY',
      expectedReasons: ['CURRENCY_NOT_ALLOWED'],
    },

    // ------------------------------------------------------------------------
    // Agent Daily Budget Checks (Soft HOLD, rolling 24h)
    // ------------------------------------------------------------------------
    {
      id: 25,
      description: 'Agent budget exact boundary: total spend+reserved+request equals budget ($50.00 / 5000)',
      request: { amountMinor: 1000 as MinorUnits }, // $10.00
      facts: {
        agentSpendRolling24hMinor: 3000 as MinorUnits, // $30.00
        agentReservedRolling24hMinor: 1000 as MinorUnits, // $10.00 (Total = 5000 == 5000 budget)
      },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 26,
      description: 'Agent budget exceeded by 1 minor unit (Total = 5001 > 5000 budget) -> Soft HOLD',
      request: { amountMinor: 1001 as MinorUnits }, // $10.01
      facts: {
        agentSpendRolling24hMinor: 3000 as MinorUnits,
        agentReservedRolling24hMinor: 1000 as MinorUnits,
      },
      expectedDecision: 'HOLD',
      expectedReasons: ['AGENT_BUDGET_EXCEEDED'],
    },
    {
      id: 27,
      description: 'Agent existing spend alone equals budget; any new positive request exceeds budget',
      request: { amountMinor: 100 as MinorUnits }, // $1.00
      facts: {
        agentSpendRolling24hMinor: 5000 as MinorUnits, // $50.00
        agentReservedRolling24hMinor: 0 as MinorUnits,
      },
      expectedDecision: 'HOLD',
      expectedReasons: ['AGENT_BUDGET_EXCEEDED'],
    },
    {
      id: 28,
      description: 'Agent existing reserved alone equals budget; any new positive request exceeds budget',
      request: { amountMinor: 100 as MinorUnits },
      facts: {
        agentSpendRolling24hMinor: 0 as MinorUnits,
        agentReservedRolling24hMinor: 5000 as MinorUnits,
      },
      expectedDecision: 'HOLD',
      expectedReasons: ['AGENT_BUDGET_EXCEEDED'],
    },

    // ------------------------------------------------------------------------
    // Global Daily Budget Checks (Hard DENY, rolling 24h)
    // ------------------------------------------------------------------------
    {
      id: 29,
      description: 'Global budget exact boundary: total spend+reserved+request equals global budget ($200.00 / 20000)',
      request: { amountMinor: 1000 as MinorUnits }, // $10.00
      facts: {
        globalSpendRolling24hMinor: 15000 as MinorUnits, // $150.00
        globalReservedRolling24hMinor: 4000 as MinorUnits, // $40.00 (Total = 20000 == 20000 budget)
      },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 30,
      description: 'Global budget exceeded by 1 minor unit (Total = 20001 > 20000 budget) -> Hard DENY',
      request: { amountMinor: 1001 as MinorUnits }, // $10.01
      facts: {
        globalSpendRolling24hMinor: 15000 as MinorUnits,
        globalReservedRolling24hMinor: 4000 as MinorUnits,
      },
      expectedDecision: 'DENY',
      expectedReasons: ['GLOBAL_BUDGET_EXCEEDED'],
    },
    {
      id: 31,
      description: 'Global existing spend alone exceeds global budget -> Hard DENY',
      request: { amountMinor: 100 as MinorUnits },
      facts: {
        globalSpendRolling24hMinor: 20000 as MinorUnits,
        globalReservedRolling24hMinor: 0 as MinorUnits,
      },
      expectedDecision: 'DENY',
      expectedReasons: ['GLOBAL_BUDGET_EXCEEDED'],
    },
    {
      id: 32,
      description: 'Both Agent and Global budgets exceeded simultaneously -> Hard DENY with both reasons',
      request: { amountMinor: 1200 as MinorUnits },
      facts: {
        agentSpendRolling24hMinor: 4500 as MinorUnits, // 4500 + 1200 = 5700 > 5000
        agentReservedRolling24hMinor: 0 as MinorUnits,
        globalSpendRolling24hMinor: 19500 as MinorUnits, // 19500 + 1200 = 20700 > 20000
        globalReservedRolling24hMinor: 0 as MinorUnits,
      },
      expectedDecision: 'DENY',
      expectedReasons: ['GLOBAL_BUDGET_EXCEEDED', 'AGENT_BUDGET_EXCEEDED'],
    },

    // ------------------------------------------------------------------------
    // Velocity & Duplicate Window Checks
    // ------------------------------------------------------------------------
    {
      id: 33,
      description: 'Velocity count below max_requests (4 < 5) -> ALLOW',
      facts: { recentRequestCountInVelocityWindow: 4 },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },
    {
      id: 34,
      description: 'Velocity count exactly at max_requests (5 >= 5) -> Soft HOLD VELOCITY',
      facts: { recentRequestCountInVelocityWindow: 5 },
      expectedDecision: 'HOLD',
      expectedReasons: ['VELOCITY'],
    },
    {
      id: 35,
      description: 'Velocity count above max_requests (6 >= 5) -> Soft HOLD VELOCITY',
      facts: { recentRequestCountInVelocityWindow: 6 },
      expectedDecision: 'HOLD',
      expectedReasons: ['VELOCITY'],
    },
    {
      id: 36,
      description: 'Duplicate detected in window (hasDuplicateInWindow = true) -> Soft HOLD DUPLICATE',
      facts: { hasDuplicateInWindow: true },
      expectedDecision: 'HOLD',
      expectedReasons: ['DUPLICATE'],
    },
    {
      id: 37,
      description: 'Duplicate not in window (hasDuplicateInWindow = false) -> ALLOW',
      facts: { hasDuplicateInWindow: false },
      expectedDecision: 'ALLOW',
      expectedReasons: [],
    },

    // ------------------------------------------------------------------------
    // Multiple Reasons & Precedence (DENY beats HOLD)
    // ------------------------------------------------------------------------
    {
      id: 38,
      description: 'Hard Cap (DENY) and Auto Limit (HOLD) triggered together -> DENY beats HOLD',
      request: { amountMinor: 15000 as MinorUnits }, // $150.00
      policy: {
        agent_daily_budget_minor: 50000 as MinorUnits,
        global_daily_budget_minor: 50000 as MinorUnits,
      },
      expectedDecision: 'DENY',
      expectedReasons: ['OVER_HARD_CAP', 'OVER_AUTO_LIMIT'],
    },
    {
      id: 39,
      description: 'Suspended agent (DENY) with Velocity triggered (HOLD) -> DENY beats HOLD',
      facts: {
        agentStatus: 'SUSPENDED',
        recentRequestCountInVelocityWindow: 5,
      },
      expectedDecision: 'DENY',
      expectedReasons: ['AGENT_SUSPENDED', 'VELOCITY'],
    },
    {
      id: 40,
      description: 'Vendor unknown (DENY) with Duplicate detected (HOLD) -> DENY beats HOLD',
      facts: {
        vendorStatus: 'MISSING',
        hasDuplicateInWindow: true,
      },
      expectedDecision: 'DENY',
      expectedReasons: ['VENDOR_UNKNOWN', 'DUPLICATE'],
    },
    {
      id: 41,
      description: 'Currency not allowed (DENY) with Agent budget exceeded (HOLD) -> DENY beats HOLD',
      request: {
        currency: 'EUR',
        amountMinor: 1200 as MinorUnits,
      },
      facts: {
        agentSpendRolling24hMinor: 4500 as MinorUnits,
      },
      expectedDecision: 'DENY',
      expectedReasons: ['CURRENCY_NOT_ALLOWED', 'AGENT_BUDGET_EXCEEDED'],
    },
    {
      id: 42,
      description: 'Global budget exceeded (DENY) with Auto Limit (HOLD) -> DENY beats HOLD',
      request: { amountMinor: 2000 as MinorUnits }, // $20.00 (> 15.00 auto limit)
      facts: {
        globalSpendRolling24hMinor: 19000 as MinorUnits, // 19000 + 2000 = 21000 > 20000
      },
      expectedDecision: 'DENY',
      expectedReasons: ['OVER_AUTO_LIMIT', 'GLOBAL_BUDGET_EXCEEDED'],
    },
    {
      id: 43,
      description: 'Scenario 2: Hijacked agent asking $500 to unknown vendor -> all 5 reasons triggered (Section 10)',
      request: {
        vendorId: 'attacker-001',
        amountMinor: 50000 as MinorUnits, // $500.00
      },
      facts: {
        vendorStatus: 'MISSING',
      },
      expectedDecision: 'DENY',
      expectedReasons: [
        'VENDOR_UNKNOWN',
        'OVER_HARD_CAP',
        'OVER_AUTO_LIMIT',
        'GLOBAL_BUDGET_EXCEEDED',
        'AGENT_BUDGET_EXCEEDED',
      ],
    },
    {
      id: 44,
      description: 'Multiple soft HOLD reasons accumulated together -> decision HOLD with all reasons present',
      request: {
        amountMinor: 2000 as MinorUnits, // OVER_AUTO_LIMIT
        category: 'marketing', // CATEGORY_MISMATCH
      },
      facts: {
        vendorCategories: ['cloud'],
        recentRequestCountInVelocityWindow: 5, // VELOCITY
        hasDuplicateInWindow: true, // DUPLICATE
        agentSpendRolling24hMinor: 4000 as MinorUnits, // AGENT_BUDGET_EXCEEDED (4000 + 2000 > 5000)
      },
      expectedDecision: 'HOLD',
      expectedReasons: [
        'CATEGORY_MISMATCH',
        'OVER_AUTO_LIMIT',
        'AGENT_BUDGET_EXCEEDED',
        'VELOCITY',
        'DUPLICATE',
      ],
    },
    {
      id: 45,
      description: 'Multiple Hard DENY and Soft HOLD reasons accumulated -> decision DENY with all reasons present',
      request: {
        amountMinor: 15000 as MinorUnits, // OVER_HARD_CAP, OVER_AUTO_LIMIT
        currency: 'GBP', // CURRENCY_NOT_ALLOWED
      },
      facts: {
        agentStatus: 'SUSPENDED', // AGENT_SUSPENDED
        vendorStatus: 'BLOCKED', // VENDOR_BLOCKED
        recentRequestCountInVelocityWindow: 5, // VELOCITY
        hasDuplicateInWindow: true, // DUPLICATE
      },
      policy: {
        agent_daily_budget_minor: 50000 as MinorUnits,
        global_daily_budget_minor: 50000 as MinorUnits,
      },
      expectedDecision: 'DENY',
      expectedReasons: [
        'AGENT_SUSPENDED',
        'VENDOR_BLOCKED',
        'CURRENCY_NOT_ALLOWED',
        'OVER_HARD_CAP',
        'OVER_AUTO_LIMIT',
        'VELOCITY',
        'DUPLICATE',
      ],
    },
  ];

  describe('Table-Driven Evaluation Suite (45 Cases)', () => {
    tableDrivenCases.forEach((tc) => {
      it(`Case #${tc.id}: ${tc.description}`, () => {
        const req: PolicyRequest = { ...baseRequest, ...tc.request };
        const fts: PolicyFacts = { ...baseFacts, ...tc.facts };
        const pol: PolicyDocument = { ...canonicalPolicy, ...tc.policy };

        const result = evaluatePolicy(req, fts, pol, tc.options);

        expect(result.decision).toBe(tc.expectedDecision);
        // Verify every expected reason is present in result.reasons
        expect(result.reasons).toEqual(expect.arrayContaining([...tc.expectedReasons]));
        expect(result.reasons.length).toBe(tc.expectedReasons.length);
        // Rule IDs should match reasons count
        expect(result.ruleIds.length).toBe(result.reasons.length);
      });
    });
  });

  // ==========================================================================
  // 2. Invariant I6: Stricter-Only AI Flags Tests
  // ==========================================================================
  describe('Invariant I6: Stricter-Only AI Output', () => {
    it('should leave ALLOW untouched when aiFlags is undefined or empty', () => {
      const resUndefined = evaluatePolicy(baseRequest, baseFacts, canonicalPolicy);
      expect(resUndefined.decision).toBe('ALLOW');
      expect(resUndefined.reasons).toEqual([]);

      const resEmpty = evaluatePolicy(baseRequest, baseFacts, canonicalPolicy, { aiFlags: [] });
      expect(resEmpty.decision).toBe('ALLOW');
      expect(resEmpty.reasons).toEqual([]);
    });

    it('should escalate ALLOW to HOLD when aiFlags contains a signal', () => {
      const res = evaluatePolicy(baseRequest, baseFacts, canonicalPolicy, {
        aiFlags: ['suspicious_prompt_injection'],
      });
      expect(res.decision).toBe('HOLD');
      expect(res.reasons).toEqual(['AI_FLAG']);
      expect(res.ruleIds).toEqual(['RULE_AI_FLAG']);
    });

    it('should keep HOLD as HOLD when aiFlags contains a signal, appending AI_FLAG to reasons', () => {
      // Over auto limit ($40.00)
      const holdReq: PolicyRequest = {
        ...baseRequest,
        amountMinor: 4000 as MinorUnits,
      };
      const resWithoutAi = evaluatePolicy(holdReq, baseFacts, canonicalPolicy);
      expect(resWithoutAi.decision).toBe('HOLD');
      expect(resWithoutAi.reasons).toEqual(['OVER_AUTO_LIMIT']);

      const resWithAi = evaluatePolicy(holdReq, baseFacts, canonicalPolicy, {
        aiFlags: ['invoice_anomaly'],
      });
      expect(resWithAi.decision).toBe('HOLD');
      expect(resWithAi.reasons).toContain('OVER_AUTO_LIMIT');
      expect(resWithAi.reasons).toContain('AI_FLAG');
      expect(resWithAi.reasons.length).toBe(2);
    });

    it('should keep DENY as DENY when aiFlags contains a signal, never downgrading or relaxing', () => {
      // Attacker request
      const denyReq: PolicyRequest = {
        ...baseRequest,
        amountMinor: 50000 as MinorUnits,
      };
      const denyFacts: PolicyFacts = {
        ...baseFacts,
        vendorStatus: 'MISSING',
      };
      const resWithoutAi = evaluatePolicy(denyReq, denyFacts, canonicalPolicy);
      expect(resWithoutAi.decision).toBe('DENY');

      const resWithAi = evaluatePolicy(denyReq, denyFacts, canonicalPolicy, {
        aiFlags: ['malicious_behavior_detected'],
      });
      expect(resWithAi.decision).toBe('DENY');
      expect(resWithAi.reasons).toContain('AI_FLAG');
      expect(resWithAi.reasons).toContain('VENDOR_UNKNOWN');
    });

    it('property test: across all table cases, applying AI flags never produces a less restrictive decision', () => {
      const severityOrder: Record<Decision, number> = {
        ALLOW: 1,
        HOLD: 2,
        DENY: 3,
      };

      for (const tc of tableDrivenCases) {
        const req: PolicyRequest = { ...baseRequest, ...tc.request };
        const fts: PolicyFacts = { ...baseFacts, ...tc.facts };
        const pol: PolicyDocument = { ...canonicalPolicy, ...tc.policy };

        const baseResult = evaluatePolicy(req, fts, pol);
        const aiResult = evaluatePolicy(req, fts, pol, { aiFlags: ['ai_flag_signal'] });

        // Severity of result with AI must be >= severity without AI
        expect(severityOrder[aiResult.decision]).toBeGreaterThanOrEqual(severityOrder[baseResult.decision]);
        expect(aiResult.reasons).toContain('AI_FLAG');
      }
    });
  });

  // ==========================================================================
  // 3. Safe Integer Arithmetic & Overflow Protection Tests
  // ==========================================================================
  describe('Safe Integer Arithmetic & Overflow Protection', () => {
    it('should safely handle maximum permitted minor units (MAX_MINOR_UNITS = 999,999,999)', () => {
      const maxReq: PolicyRequest = {
        ...baseRequest,
        amountMinor: MAX_MINOR_UNITS,
      };
      const maxPolicy: PolicyDocument = {
        ...canonicalPolicy,
        auto_limit_minor: MAX_MINOR_UNITS,
        hard_cap_minor: MAX_MINOR_UNITS,
        agent_daily_budget_minor: MAX_MINOR_UNITS,
        global_daily_budget_minor: MAX_MINOR_UNITS,
      };

      const res = evaluatePolicy(maxReq, baseFacts, maxPolicy);
      expect(res.decision).toBe('ALLOW');
      expect(res.reasons).toEqual([]);
    });

    it('should detect budget exceeded without overflow when intermediate sum exceeds Number.MAX_SAFE_INTEGER', () => {
      // Construct a huge spend that is a safe integer individually, but sum exceeds safe integer
      const hugeSpend = (Number.MAX_SAFE_INTEGER - 100) as MinorUnits;
      const fts: PolicyFacts = {
        ...baseFacts,
        globalSpendRolling24hMinor: hugeSpend,
        globalReservedRolling24hMinor: 200 as MinorUnits,
      };

      const res = evaluatePolicy(baseRequest, fts, canonicalPolicy);
      expect(res.decision).toBe('DENY');
      expect(res.reasons).toContain('GLOBAL_BUDGET_EXCEEDED');
    });

    it('should prevent overflow when spend or reserved individually exceeds budget', () => {
      const fts: PolicyFacts = {
        ...baseFacts,
        agentSpendRolling24hMinor: 100000 as MinorUnits, // > 5000 budget
      };

      const res = evaluatePolicy(baseRequest, fts, canonicalPolicy);
      expect(res.decision).toBe('HOLD');
      expect(res.reasons).toContain('AGENT_BUDGET_EXCEEDED');
    });
  });

  // ==========================================================================
  // 4. Injected Clock Tests
  // ==========================================================================
  describe('Clock Injection Support', () => {
    it('should accept an injected now Date in options without altering pure evaluation', () => {
      const customNow = new Date('2026-10-28T12:00:00Z');
      const res = evaluatePolicy(baseRequest, baseFacts, canonicalPolicy, { now: customNow });
      expect(res.decision).toBe('ALLOW');
      expect(res.reasons).toEqual([]);
    });
  });

  // ==========================================================================
  // 5. Malformed Input Rejection Tests (Shape Errors)
  // Per Section 10 line 451: Shape errors are rejected as errors, not decisions
  // ==========================================================================
  describe('Malformed Input Shape Error Rejection (Fail-Closed)', () => {
    it('should throw PolicyEngineError when request is null or non-object', () => {
      expect(() => evaluatePolicy(null as unknown as PolicyRequest, baseFacts, canonicalPolicy)).toThrow(
        PolicyEngineError
      );
      expect(() => evaluatePolicy(undefined as unknown as PolicyRequest, baseFacts, canonicalPolicy)).toThrow(
        PolicyEngineError
      );
      expect(() => evaluatePolicy('invalid' as unknown as PolicyRequest, baseFacts, canonicalPolicy)).toThrow(
        PolicyEngineError
      );
    });

    it('should throw PolicyEngineError when request has missing or empty string fields', () => {
      expect(() => evaluatePolicy({ ...baseRequest, agentId: '' }, baseFacts, canonicalPolicy)).toThrow(
        PolicyEngineError
      );
      expect(() => evaluatePolicy({ ...baseRequest, vendorId: '   ' }, baseFacts, canonicalPolicy)).toThrow(
        PolicyEngineError
      );
      expect(() => evaluatePolicy({ ...baseRequest, currency: '' }, baseFacts, canonicalPolicy)).toThrow(
        PolicyEngineError
      );
      expect(() => evaluatePolicy({ ...baseRequest, idempotencyKey: '' }, baseFacts, canonicalPolicy)).toThrow(
        PolicyEngineError
      );
    });

    it('should throw PolicyEngineError when request amountMinor is NaN, non-integer, or non-numeric', () => {
      expect(() =>
        evaluatePolicy({ ...baseRequest, amountMinor: NaN as unknown as MinorUnits }, baseFacts, canonicalPolicy)
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy({ ...baseRequest, amountMinor: 12.5 as unknown as MinorUnits }, baseFacts, canonicalPolicy)
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy(
          { ...baseRequest, amountMinor: '1200' as unknown as MinorUnits },
          baseFacts,
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);
    });

    it('should throw PolicyEngineError when facts is null or non-object', () => {
      expect(() => evaluatePolicy(baseRequest, null as unknown as PolicyFacts, canonicalPolicy)).toThrow(
        PolicyEngineError
      );
    });

    it('should throw PolicyEngineError when agentStatus is invalid', () => {
      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, agentStatus: 'INVALID' as unknown as 'ACTIVE' },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);
    });

    it('should throw PolicyEngineError when vendorStatus is invalid', () => {
      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, vendorStatus: 'UNKNOWN_STATUS' as unknown as 'ACTIVE' },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);
    });

    it('should throw PolicyEngineError when spending facts are NaN, undefined, negative, or non-integer', () => {
      const spendingFields = [
        'agentSpendRolling24hMinor',
        'agentReservedRolling24hMinor',
        'globalSpendRolling24hMinor',
        'globalReservedRolling24hMinor',
      ] as const;

      for (const field of spendingFields) {
        expect(() =>
          evaluatePolicy(
            baseRequest,
            { ...baseFacts, [field]: NaN as unknown as MinorUnits },
            canonicalPolicy
          )
        ).toThrow(PolicyEngineError);

        expect(() =>
          evaluatePolicy(
            baseRequest,
            { ...baseFacts, [field]: undefined as unknown as MinorUnits },
            canonicalPolicy
          )
        ).toThrow(PolicyEngineError);

        expect(() =>
          evaluatePolicy(
            baseRequest,
            { ...baseFacts, [field]: -10 as unknown as MinorUnits },
            canonicalPolicy
          )
        ).toThrow(PolicyEngineError);

        expect(() =>
          evaluatePolicy(
            baseRequest,
            { ...baseFacts, [field]: 15.7 as unknown as MinorUnits },
            canonicalPolicy
          )
        ).toThrow(PolicyEngineError);
      }
    });

    it('should throw PolicyEngineError when recentRequestCountInVelocityWindow is NaN, negative, or non-integer', () => {
      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, recentRequestCountInVelocityWindow: NaN },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, recentRequestCountInVelocityWindow: -1 },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, recentRequestCountInVelocityWindow: 2.5 },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);
    });

    it('should throw PolicyEngineError when hasDuplicateInWindow is non-boolean', () => {
      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, hasDuplicateInWindow: undefined as unknown as boolean },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, hasDuplicateInWindow: null as unknown as boolean },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, hasDuplicateInWindow: 1 as unknown as boolean },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);
    });

    it('should throw PolicyEngineError when policy is null, missing, or malformed', () => {
      expect(() => evaluatePolicy(baseRequest, baseFacts, null as unknown as PolicyDocument)).toThrow(
        PolicyEngineError
      );

      expect(() =>
        evaluatePolicy(baseRequest, baseFacts, { ...canonicalPolicy, currency_allowlist: [] })
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy(baseRequest, baseFacts, {
          ...canonicalPolicy,
          new_vendor_action: 'ALLOW' as unknown as 'HOLD',
        })
      ).toThrow(PolicyEngineError);

      // PolicyDocument shape regressions (Finding 2)
      // Missing or invalid version
      const missingVersion = { ...canonicalPolicy };
      delete (missingVersion as Partial<PolicyDocument>).version;
      expect(() => evaluatePolicy(baseRequest, baseFacts, missingVersion as PolicyDocument)).toThrow(
        PolicyEngineError
      );
      expect(() => evaluatePolicy(baseRequest, baseFacts, { ...canonicalPolicy, version: 0 })).toThrow(
        PolicyEngineError
      );

      // Missing or invalid hold_ttl_minutes
      const missingTtl = { ...canonicalPolicy };
      delete (missingTtl as Partial<PolicyDocument>).hold_ttl_minutes;
      expect(() => evaluatePolicy(baseRequest, baseFacts, missingTtl as PolicyDocument)).toThrow(
        PolicyEngineError
      );
      expect(() => evaluatePolicy(baseRequest, baseFacts, { ...canonicalPolicy, hold_ttl_minutes: 0 })).toThrow(
        PolicyEngineError
      );
      expect(() => evaluatePolicy(baseRequest, baseFacts, { ...canonicalPolicy, hold_ttl_minutes: -5 })).toThrow(
        PolicyEngineError
      );

      // Missing or invalid duplicate_window_minutes
      const missingDup = { ...canonicalPolicy };
      delete (missingDup as Partial<PolicyDocument>).duplicate_window_minutes;
      expect(() => evaluatePolicy(baseRequest, baseFacts, missingDup as PolicyDocument)).toThrow(
        PolicyEngineError
      );
      expect(() =>
        evaluatePolicy(baseRequest, baseFacts, { ...canonicalPolicy, duplicate_window_minutes: -1 })
      ).toThrow(PolicyEngineError);

      // hard_cap_minor < auto_limit_minor
      expect(() =>
        evaluatePolicy(baseRequest, baseFacts, {
          ...canonicalPolicy,
          auto_limit_minor: 5000 as MinorUnits,
          hard_cap_minor: 2000 as MinorUnits,
        })
      ).toThrow(PolicyEngineError);
    });

    it('should throw PolicyEngineError when request.category is supplied with a non-string type (Finding 1)', () => {
      expect(() =>
        evaluatePolicy(
          { ...baseRequest, category: 123 as unknown as string },
          baseFacts,
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy(
          { ...baseRequest, category: true as unknown as string },
          baseFacts,
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy(
          { ...baseRequest, category: {} as unknown as string },
          baseFacts,
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);
    });

    it('should accept legitimately omitted optional request.category (Finding 1)', () => {
      const omittedCategoryReq: PolicyRequest = {
        ...baseRequest,
        category: undefined,
      };
      // When vendor has no category restrictions, omitting category should be clean ALLOW
      const unrestrictedFacts: PolicyFacts = {
        ...baseFacts,
        vendorCategories: undefined,
      };
      const result = evaluatePolicy(omittedCategoryReq, unrestrictedFacts, canonicalPolicy);
      expect(result.decision).toBe('ALLOW');
      expect(result.reasons).toEqual([]);
    });

    it('should throw PolicyEngineError when facts.vendorCategories is supplied with a non-array or contains non-strings (Finding 1)', () => {
      // String supplied instead of array
      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, vendorCategories: 'cloud' as unknown as string[] },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);

      // Object supplied instead of array
      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, vendorCategories: { 0: 'cloud' } as unknown as string[] },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);

      // Array containing non-string elements
      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, vendorCategories: ['cloud', 123 as unknown as string] },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy(
          baseRequest,
          { ...baseFacts, vendorCategories: [null as unknown as string] },
          canonicalPolicy
        )
      ).toThrow(PolicyEngineError);
    });

    it('should accept legitimately omitted or empty facts.vendorCategories (Finding 1)', () => {
      const undefinedCategories = evaluatePolicy(
        baseRequest,
        { ...baseFacts, vendorCategories: undefined },
        canonicalPolicy
      );
      expect(undefinedCategories.decision).toBe('ALLOW');

      const emptyCategories = evaluatePolicy(
        baseRequest,
        { ...baseFacts, vendorCategories: [] },
        canonicalPolicy
      );
      expect(emptyCategories.decision).toBe('ALLOW');
    });

    it('should throw PolicyEngineError when options.aiFlags is not an array or contains non-strings', () => {
      expect(() =>
        evaluatePolicy(baseRequest, baseFacts, canonicalPolicy, {
          aiFlags: 'not-an-array' as unknown as string[],
        })
      ).toThrow(PolicyEngineError);

      expect(() =>
        evaluatePolicy(baseRequest, baseFacts, canonicalPolicy, {
          aiFlags: ['valid_flag', 123 as unknown as string],
        })
      ).toThrow(PolicyEngineError);
    });
  });
});
