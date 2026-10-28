/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T4: Policy Types & Schema Validation
 *
 * Defines the type system, reason codes, request/facts interfaces,
 * and Zod validation schema for Policy documents per PAYGUARD_PLAN.md.
 *
 * Security Invariants:
 * - I4: Monetary amounts are represented strictly as integer minor units (MinorUnits).
 * - D5: Vendors referenced strictly by registry ID.
 * - D7: Fail closed on ambiguity.
 */

import { z } from 'zod';
import {
  type MinorUnits,
  toMinorUnits,
  MAX_MINOR_UNITS,
  CURRENCY_CODE_REGEX,
} from '../core/money.js';

// ============================================================================
// Decision & Reason Code Types (PAYGUARD_PLAN.md Section 10)
// ============================================================================

export type Decision = 'ALLOW' | 'HOLD' | 'DENY';

/**
 * Hard DENY reason codes per Section 10.
 * Any DENY reason immediately forces decision = 'DENY'.
 */
export type DenyReasonCode =
  | 'AGENT_SUSPENDED'
  | 'VENDOR_UNKNOWN'
  | 'VENDOR_BLOCKED'
  | 'CURRENCY_NOT_ALLOWED'
  | 'OVER_HARD_CAP'
  | 'GLOBAL_BUDGET_EXCEEDED';

/**
 * Soft HOLD reason codes per Section 10.
 * Triggers a native PayPal authorization hold requiring owner approval.
 */
export type HoldReasonCode =
  | 'VENDOR_NEW'
  | 'OVER_AUTO_LIMIT'
  | 'AGENT_BUDGET_EXCEEDED'
  | 'VELOCITY'
  | 'DUPLICATE'
  | 'CATEGORY_MISMATCH'
  | 'AI_FLAG';

export type ReasonCode = DenyReasonCode | HoldReasonCode;

export type RuleId = string;

// ============================================================================
// Policy Engine Input Interfaces (PAYGUARD_PLAN.md Section 10)
// ============================================================================

export interface PolicyRequest {
  readonly agentId: string;
  readonly vendorId: string;
  readonly amountMinor: MinorUnits;
  readonly currency: string;
  readonly purpose: string;
  readonly category?: string;
  readonly idempotencyKey: string;
}

export interface PolicyFacts {
  readonly agentStatus: 'ACTIVE' | 'SUSPENDED';
  readonly vendorStatus: 'ACTIVE' | 'UNVERIFIED' | 'BLOCKED' | 'MISSING';
  readonly vendorCategories?: readonly string[];
  readonly vendorCurrencies?: readonly string[];
  readonly agentSpendRolling24hMinor: MinorUnits;
  readonly agentReservedRolling24hMinor: MinorUnits;
  readonly globalSpendRolling24hMinor: MinorUnits;
  readonly globalReservedRolling24hMinor: MinorUnits;
  readonly recentRequestCountInVelocityWindow: number;
  readonly hasDuplicateInWindow: boolean;
}

export interface PolicyEvaluationOptions {
  readonly aiFlags?: readonly string[];
  readonly now?: Date;
}

export interface PolicyEvaluationResult {
  readonly decision: Decision;
  readonly reasons: readonly ReasonCode[];
  readonly ruleIds: readonly string[];
}

// ============================================================================
// Policy Document Zod Schema (PAYGUARD_PLAN.md Section 4.2 & Section 10)
// ============================================================================

/**
 * Helper schema validating integer minor units within permitted range [0, MAX_MINOR_UNITS].
 * Casts valid integer numbers to branded MinorUnits without floating-point arithmetic.
 */
export const minorUnitsSchema = z
  .number({ message: 'Amount in minor units must be a number' })
  .int('Minor units must be an integer')
  .min(0, 'Minor units cannot be negative')
  .max(MAX_MINOR_UNITS, `Minor units cannot exceed ${MAX_MINOR_UNITS}`)
  .transform((val) => toMinorUnits(val));

/**
 * Currency code schema: strictly 3 uppercase ASCII letters matching /^[A-Z]{3}$/.
 */
export const currencyCodeSchema = z
  .string({ message: 'Currency code must be a string' })
  .regex(CURRENCY_CODE_REGEX, 'Currency must be a 3-letter uppercase ASCII code (e.g. USD)');

/**
 * Velocity rule schema: maximum number of requests allowed in a rolling minute window.
 */
export const velocitySchema = z.object({
  max_requests: z
    .number({ message: 'velocity.max_requests must be a number' })
    .int('velocity.max_requests must be an integer')
    .min(1, 'velocity.max_requests must be at least 1'),
  window_minutes: z
    .number({ message: 'velocity.window_minutes must be a number' })
    .int('velocity.window_minutes must be an integer')
    .min(1, 'velocity.window_minutes must be at least 1'),
});

/**
 * Canonical Policy Document Schema.
 * Matches Demo policy v1 structure in PAYGUARD_PLAN.md Section 4.2:
 *
 * version: 1
 * currency_allowlist: [USD]
 * auto_limit_minor: 1500          # $15.00 auto-approve
 * hard_cap_minor: 10000           # $100.00 absolute max
 * agent_daily_budget_minor: 5000  # $50.00 per agent per rolling 24h
 * global_daily_budget_minor: 20000
 * velocity: { max_requests: 5, window_minutes: 10 }
 * duplicate_window_minutes: 60
 * new_vendor_action: HOLD
 * hold_ttl_minutes: 15
 */
export const PolicyDocumentSchema = z
  .object({
    version: z
      .number({ message: 'version must be a number' })
      .int('version must be an integer')
      .min(1, 'version must be at least 1'),
    currency_allowlist: z
      .array(currencyCodeSchema, { message: 'currency_allowlist must be an array of currency strings' })
      .min(1, 'currency_allowlist must contain at least one currency code'),
    auto_limit_minor: minorUnitsSchema,
    hard_cap_minor: minorUnitsSchema,
    agent_daily_budget_minor: minorUnitsSchema,
    global_daily_budget_minor: minorUnitsSchema,
    velocity: velocitySchema,
    duplicate_window_minutes: z
      .number({ message: 'duplicate_window_minutes must be a number' })
      .int('duplicate_window_minutes must be an integer')
      .min(0, 'duplicate_window_minutes cannot be negative'),
    new_vendor_action: z.enum(['HOLD', 'DENY'] as const, {
      message: 'new_vendor_action must be either "HOLD" or "DENY"',
    }),
    hold_ttl_minutes: z
      .number({ message: 'hold_ttl_minutes must be a number' })
      .int('hold_ttl_minutes must be an integer')
      .min(1, 'hold_ttl_minutes must be at least 1 minute'),
  })
  .refine(
    (data) => data.hard_cap_minor >= data.auto_limit_minor,
    {
      message: 'hard_cap_minor must be greater than or equal to auto_limit_minor',
      path: ['hard_cap_minor'],
    }
  );

/**
 * Inferred type of a validated PolicyDocument.
 */
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

/**
 * Validates untrusted raw policy data against the PolicyDocumentSchema.
 * Throws a ZodError if validation fails (acceptance: invalid docs rejected).
 */
export function validatePolicyDocument(raw: unknown): PolicyDocument {
  return PolicyDocumentSchema.parse(raw);
}

/**
 * Safe parser returning success or error result without throwing.
 */
export function safeValidatePolicyDocument(raw: unknown): ReturnType<typeof PolicyDocumentSchema.safeParse> {
  return PolicyDocumentSchema.safeParse(raw);
}
