/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T5: Deterministic Policy Engine
 *
 * Implements pure, deterministic policy evaluation per PAYGUARD_PLAN.md Section 10.
 *
 * Security Invariants:
 * - I4: Monetary amounts are represented strictly as integer minor units (MinorUnits).
 * - I6: AI output can only make decisions stricter (never looser).
 * - D7: Fail closed on ambiguity; ALLOW requires all conditions to pass cleanly.
 * - Section 10: Shape errors are rejected before/at the engine boundary (errors, not decisions).
 * - Section 10: All triggered reasons and rule IDs are collected; DENY beats HOLD.
 */

import type {
  PolicyRequest,
  PolicyFacts,
  PolicyEvaluationOptions,
  PolicyEvaluationResult,
  PolicyDocument,
  ReasonCode,
  Decision,
} from './types.js';

// ============================================================================
// Error Class for Input Shape Violations
// ============================================================================

export class PolicyEngineError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'PolicyEngineError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// Hard DENY Codes per PAYGUARD_PLAN.md Section 10
// ============================================================================

const HARD_DENY_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'AGENT_SUSPENDED',
  'VENDOR_UNKNOWN',
  'VENDOR_BLOCKED',
  'CURRENCY_NOT_ALLOWED',
  'OVER_HARD_CAP',
  'GLOBAL_BUDGET_EXCEEDED',
]);

// ============================================================================
// Pure Validation & Arithmetic Helpers
// ============================================================================

function isNonNegativeSafeInteger(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0;
}

/**
 * Validates whether a budget comparison overflows or exceeds the allowed threshold.
 * Prevents JavaScript safe-integer addition overflow from producing an unreliable false negative.
 */
function isBudgetExceeded(
  spend: number,
  reserved: number,
  amount: number,
  budget: number
): boolean {
  // If any single component exceeds the budget, it is exceeded immediately
  if (spend > budget || reserved > budget || amount > budget) {
    return true;
  }

  // Safe intermediate sum of current commitments
  const currentTotal = spend + reserved;
  if (!Number.isSafeInteger(currentTotal)) {
    // Current total has exceeded Number.MAX_SAFE_INTEGER (> 9e15);
    // infinitely greater than any valid budget (<= MAX_MINOR_UNITS = 999,999,999).
    return true;
  }

  // Subtraction-based comparison to prevent addition overflow with amount
  const remainingBudget = budget - currentTotal;
  return amount > remainingBudget;
}

/**
 * Validates runtime shapes of request, facts, and policy.
 * Per Section 10 line 451: Shape errors are rejected as errors, not decisions.
 */
function validateInputs(
  request: PolicyRequest,
  facts: PolicyFacts,
  policy: PolicyDocument,
  options?: PolicyEvaluationOptions
): void {
  if (!request || typeof request !== 'object') {
    throw new PolicyEngineError('INVALID_REQUEST_SHAPE', 'PolicyRequest must be a non-null object');
  }
  if (typeof request.agentId !== 'string' || request.agentId.trim().length === 0) {
    throw new PolicyEngineError('INVALID_REQUEST_SHAPE', 'request.agentId must be a non-empty string');
  }
  if (typeof request.vendorId !== 'string' || request.vendorId.trim().length === 0) {
    throw new PolicyEngineError('INVALID_REQUEST_SHAPE', 'request.vendorId must be a non-empty string');
  }
  if (typeof request.currency !== 'string' || request.currency.trim().length === 0) {
    throw new PolicyEngineError('INVALID_REQUEST_SHAPE', 'request.currency must be a non-empty string');
  }
  if (typeof request.purpose !== 'string') {
    throw new PolicyEngineError('INVALID_REQUEST_SHAPE', 'request.purpose must be a string');
  }
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim().length === 0) {
    throw new PolicyEngineError('INVALID_REQUEST_SHAPE', 'request.idempotencyKey must be a non-empty string');
  }
  if (typeof request.amountMinor !== 'number' || !Number.isSafeInteger(request.amountMinor)) {
    throw new PolicyEngineError(
      'INVALID_REQUEST_SHAPE',
      'request.amountMinor must be a safe integer'
    );
  }
  if (request.category !== undefined && typeof request.category !== 'string') {
    throw new PolicyEngineError(
      'INVALID_REQUEST_SHAPE',
      'request.category must be a string when supplied'
    );
  }

  if (!facts || typeof facts !== 'object') {
    throw new PolicyEngineError('INVALID_FACTS_SHAPE', 'PolicyFacts must be a non-null object');
  }
  if (facts.agentStatus !== 'ACTIVE' && facts.agentStatus !== 'SUSPENDED') {
    throw new PolicyEngineError(
      'INVALID_FACTS_SHAPE',
      `facts.agentStatus must be 'ACTIVE' or 'SUSPENDED', received: ${String(facts.agentStatus)}`
    );
  }
  if (
    facts.vendorStatus !== 'ACTIVE' &&
    facts.vendorStatus !== 'UNVERIFIED' &&
    facts.vendorStatus !== 'BLOCKED' &&
    facts.vendorStatus !== 'MISSING'
  ) {
    throw new PolicyEngineError(
      'INVALID_FACTS_SHAPE',
      `facts.vendorStatus must be 'ACTIVE', 'UNVERIFIED', 'BLOCKED', or 'MISSING', received: ${String(facts.vendorStatus)}`
    );
  }
  if (facts.vendorCategories !== undefined) {
    if (!Array.isArray(facts.vendorCategories)) {
      throw new PolicyEngineError(
        'INVALID_FACTS_SHAPE',
        'facts.vendorCategories must be an array of strings when supplied'
      );
    }
    if (facts.vendorCategories.some((cat) => typeof cat !== 'string')) {
      throw new PolicyEngineError(
        'INVALID_FACTS_SHAPE',
        'facts.vendorCategories must contain only strings'
      );
    }
  }
  if (facts.vendorCurrencies !== undefined) {
    if (!Array.isArray(facts.vendorCurrencies)) {
      throw new PolicyEngineError(
        'INVALID_FACTS_SHAPE',
        'facts.vendorCurrencies must be an array of strings when supplied'
      );
    }
    if (facts.vendorCurrencies.some((curr) => typeof curr !== 'string')) {
      throw new PolicyEngineError(
        'INVALID_FACTS_SHAPE',
        'facts.vendorCurrencies must contain only strings'
      );
    }
  }
  if (!isNonNegativeSafeInteger(facts.agentSpendRolling24hMinor)) {
    throw new PolicyEngineError(
      'INVALID_FACTS_SHAPE',
      'facts.agentSpendRolling24hMinor must be a non-negative safe integer'
    );
  }
  if (!isNonNegativeSafeInteger(facts.agentReservedRolling24hMinor)) {
    throw new PolicyEngineError(
      'INVALID_FACTS_SHAPE',
      'facts.agentReservedRolling24hMinor must be a non-negative safe integer'
    );
  }
  if (!isNonNegativeSafeInteger(facts.globalSpendRolling24hMinor)) {
    throw new PolicyEngineError(
      'INVALID_FACTS_SHAPE',
      'facts.globalSpendRolling24hMinor must be a non-negative safe integer'
    );
  }
  if (!isNonNegativeSafeInteger(facts.globalReservedRolling24hMinor)) {
    throw new PolicyEngineError(
      'INVALID_FACTS_SHAPE',
      'facts.globalReservedRolling24hMinor must be a non-negative safe integer'
    );
  }
  if (!isNonNegativeSafeInteger(facts.recentRequestCountInVelocityWindow)) {
    throw new PolicyEngineError(
      'INVALID_FACTS_SHAPE',
      'facts.recentRequestCountInVelocityWindow must be a non-negative safe integer'
    );
  }
  if (typeof facts.hasDuplicateInWindow !== 'boolean') {
    throw new PolicyEngineError(
      'INVALID_FACTS_SHAPE',
      'facts.hasDuplicateInWindow must be a boolean'
    );
  }

  if (!policy || typeof policy !== 'object') {
    throw new PolicyEngineError('INVALID_POLICY_SHAPE', 'PolicyDocument must be a non-null object');
  }
  if (typeof policy.version !== 'number' || !Number.isSafeInteger(policy.version) || policy.version < 1) {
    throw new PolicyEngineError(
      'INVALID_POLICY_SHAPE',
      'policy.version must be an integer >= 1'
    );
  }
  if (!Array.isArray(policy.currency_allowlist) || policy.currency_allowlist.length === 0) {
    throw new PolicyEngineError(
      'INVALID_POLICY_SHAPE',
      'policy.currency_allowlist must be a non-empty array'
    );
  }
  if (!isNonNegativeSafeInteger(policy.auto_limit_minor)) {
    throw new PolicyEngineError(
      'INVALID_POLICY_SHAPE',
      'policy.auto_limit_minor must be a non-negative safe integer'
    );
  }
  if (!isNonNegativeSafeInteger(policy.hard_cap_minor)) {
    throw new PolicyEngineError(
      'INVALID_POLICY_SHAPE',
      'policy.hard_cap_minor must be a non-negative safe integer'
    );
  }
  if (policy.hard_cap_minor < policy.auto_limit_minor) {
    throw new PolicyEngineError(
      'INVALID_POLICY_SHAPE',
      'policy.hard_cap_minor must be greater than or equal to policy.auto_limit_minor'
    );
  }
  if (!isNonNegativeSafeInteger(policy.agent_daily_budget_minor)) {
    throw new PolicyEngineError(
      'INVALID_POLICY_SHAPE',
      'policy.agent_daily_budget_minor must be a non-negative safe integer'
    );
  }
  if (!isNonNegativeSafeInteger(policy.global_daily_budget_minor)) {
    throw new PolicyEngineError(
      'INVALID_POLICY_SHAPE',
      'policy.global_daily_budget_minor must be a non-negative safe integer'
    );
  }
  if (
    !policy.velocity ||
    typeof policy.velocity !== 'object' ||
    typeof policy.velocity.max_requests !== 'number' ||
    !Number.isSafeInteger(policy.velocity.max_requests) ||
    policy.velocity.max_requests < 1 ||
    typeof policy.velocity.window_minutes !== 'number' ||
    !Number.isSafeInteger(policy.velocity.window_minutes) ||
    policy.velocity.window_minutes < 1
  ) {
    throw new PolicyEngineError('INVALID_POLICY_SHAPE', 'policy.velocity is invalid or missing');
  }
  if (!isNonNegativeSafeInteger(policy.duplicate_window_minutes)) {
    throw new PolicyEngineError(
      'INVALID_POLICY_SHAPE',
      'policy.duplicate_window_minutes must be a non-negative safe integer'
    );
  }
  if (policy.new_vendor_action !== 'HOLD' && policy.new_vendor_action !== 'DENY') {
    throw new PolicyEngineError(
      'INVALID_POLICY_SHAPE',
      `policy.new_vendor_action must be 'HOLD' or 'DENY', received: ${String(policy.new_vendor_action)}`
    );
  }
  if (
    typeof policy.hold_ttl_minutes !== 'number' ||
    !Number.isSafeInteger(policy.hold_ttl_minutes) ||
    policy.hold_ttl_minutes < 1
  ) {
    throw new PolicyEngineError(
      'INVALID_POLICY_SHAPE',
      'policy.hold_ttl_minutes must be an integer >= 1'
    );
  }

  if (options && options.aiFlags !== undefined) {
    if (!Array.isArray(options.aiFlags) || options.aiFlags.some((flag) => typeof flag !== 'string')) {
      throw new PolicyEngineError('INVALID_OPTIONS_SHAPE', 'options.aiFlags must be an array of strings');
    }
  }
}

// ============================================================================
// Main Policy Evaluation Engine (PAYGUARD_PLAN.md Section 10)
// ============================================================================

/**
 * Pure, deterministic policy evaluation engine.
 *
 * Evaluates payment requests against runtime facts and active policy rules.
 *
 * Rules:
 * 1. Shape errors are rejected as errors, not decisions.
 * 2. Agent not ACTIVE -> DENY AGENT_SUSPENDED.
 * 3. Vendor missing -> DENY VENDOR_UNKNOWN; BLOCKED -> DENY VENDOR_BLOCKED.
 *    Vendor UNVERIFIED -> VENDOR_NEW (HOLD or DENY per policy.new_vendor_action).
 *    Category mismatch against registered categories -> HOLD CATEGORY_MISMATCH.
 * 4. Hard DENY: CURRENCY_NOT_ALLOWED, OVER_HARD_CAP (also amount <= 0), GLOBAL_BUDGET_EXCEEDED.
 * 5. Soft HOLD: VENDOR_NEW, OVER_AUTO_LIMIT, AGENT_BUDGET_EXCEEDED, VELOCITY, DUPLICATE, CATEGORY_MISMATCH, AI_FLAG.
 * 6. Decision precedence: Any DENY beats HOLD. No DENY and no HOLD -> ALLOW.
 *    All triggered reasons and matching rule IDs are collected.
 */
export function evaluatePolicy(
  request: PolicyRequest,
  facts: PolicyFacts,
  policy: PolicyDocument,
  options?: PolicyEvaluationOptions
): PolicyEvaluationResult {
  // Validate input shapes fail-closed per Section 10 line 451
  validateInputs(request, facts, policy, options);

  const reasons: ReasonCode[] = [];
  const ruleIds: string[] = [];

  function trigger(reason: ReasonCode, ruleId: string): void {
    reasons.push(reason);
    ruleIds.push(ruleId);
  }

  // --------------------------------------------------------------------------
  // Step 1: Agent Check
  // --------------------------------------------------------------------------
  if (facts.agentStatus !== 'ACTIVE') {
    trigger('AGENT_SUSPENDED', 'RULE_AGENT_STATUS');
  }

  // --------------------------------------------------------------------------
  // Step 2: Vendor Checks
  // --------------------------------------------------------------------------
  if (facts.vendorStatus === 'MISSING') {
    trigger('VENDOR_UNKNOWN', 'RULE_VENDOR_STATUS');
  } else if (facts.vendorStatus === 'BLOCKED') {
    trigger('VENDOR_BLOCKED', 'RULE_VENDOR_STATUS');
  } else if (facts.vendorStatus === 'UNVERIFIED') {
    trigger('VENDOR_NEW', 'RULE_VENDOR_NEW');
  }

  // Category mismatch check: only applies when vendor defines permitted categories
  if (facts.vendorCategories && facts.vendorCategories.length > 0) {
    if (!request.category || !facts.vendorCategories.includes(request.category)) {
      trigger('CATEGORY_MISMATCH', 'RULE_VENDOR_CATEGORY');
    }
  }

  // --------------------------------------------------------------------------
  // Step 3: Currency Check
  // --------------------------------------------------------------------------
  if (!policy.currency_allowlist.includes(request.currency)) {
    trigger('CURRENCY_NOT_ALLOWED', 'RULE_CURRENCY_ALLOWLIST');
  }

  // --------------------------------------------------------------------------
  // Step 4: Amount, Hard Cap & Auto Limit Checks
  // Section 10 line 454: OVER_HARD_CAP (also amount <= 0)
  // --------------------------------------------------------------------------
  if (request.amountMinor <= 0 || request.amountMinor > policy.hard_cap_minor) {
    trigger('OVER_HARD_CAP', 'RULE_HARD_CAP');
  }

  if (request.amountMinor > policy.auto_limit_minor) {
    trigger('OVER_AUTO_LIMIT', 'RULE_AUTO_LIMIT');
  }

  // --------------------------------------------------------------------------
  // Step 5: Rolling 24h Budget Checks
  // --------------------------------------------------------------------------
  // Global daily budget check (Hard DENY)
  if (
    isBudgetExceeded(
      facts.globalSpendRolling24hMinor,
      facts.globalReservedRolling24hMinor,
      request.amountMinor,
      policy.global_daily_budget_minor
    )
  ) {
    trigger('GLOBAL_BUDGET_EXCEEDED', 'RULE_GLOBAL_DAILY_BUDGET');
  }

  // Agent daily budget check (Soft HOLD)
  if (
    isBudgetExceeded(
      facts.agentSpendRolling24hMinor,
      facts.agentReservedRolling24hMinor,
      request.amountMinor,
      policy.agent_daily_budget_minor
    )
  ) {
    trigger('AGENT_BUDGET_EXCEEDED', 'RULE_AGENT_DAILY_BUDGET');
  }

  // --------------------------------------------------------------------------
  // Step 6: Velocity and Duplicate Checks
  // --------------------------------------------------------------------------
  if (facts.recentRequestCountInVelocityWindow >= policy.velocity.max_requests) {
    trigger('VELOCITY', 'RULE_VELOCITY');
  }

  if (facts.hasDuplicateInWindow === true) {
    trigger('DUPLICATE', 'RULE_DUPLICATE');
  }

  // --------------------------------------------------------------------------
  // Step 7: Stricter-Only AI Flags Check (Invariant I6)
  // --------------------------------------------------------------------------
  if (options?.aiFlags && options.aiFlags.length > 0) {
    trigger('AI_FLAG', 'RULE_AI_FLAG');
  }

  // --------------------------------------------------------------------------
  // Step 8: Precedence & Decision Determination
  // Precedence: Any DENY beats HOLD. No DENY and no HOLD -> ALLOW.
  // --------------------------------------------------------------------------
  const hasHardDeny = reasons.some((reason) => {
    if (HARD_DENY_CODES.has(reason)) {
      return true;
    }
    // VENDOR_NEW triggers DENY if policy.new_vendor_action is configured as 'DENY'
    if (reason === 'VENDOR_NEW' && policy.new_vendor_action === 'DENY') {
      return true;
    }
    return false;
  });

  let decision: Decision;
  if (hasHardDeny) {
    decision = 'DENY';
  } else if (reasons.length > 0) {
    decision = 'HOLD';
  } else {
    decision = 'ALLOW';
  }

  return {
    decision,
    reasons,
    ruleIds,
  };
}
