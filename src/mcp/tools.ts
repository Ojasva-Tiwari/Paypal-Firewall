/**
 * PayGuard — Milestone M3: MCP Integration
 * M3-T3: Core MCP Tool Handlers & Input Validation
 *
 * Implements the 4 canonical MCP tools:
 * 1. request_payment: Ingests, validates, evaluates policy, and delegates execution
 * 2. get_payment_status: Read-only status inquiry with strict ownership enforcement
 * 3. get_budget: Rolling 24h budget commitments and allowed currencies (thresholds hidden)
 * 4. list_vendors: Active and unverified vendor directory (blocked vendors excluded)
 *
 * Security Invariants & Hard Rules:
 * - Rule 3 & Invariant I1: The agent-facing MCP tools are exactly these four.
 * - Rule 4 & Invariant I3: Money-moving calls happen ONLY via executeDecision in src/core.
 * - Rule 5 & Invariant I4: Money represented strictly as integer minor units.
 * - Rule 6 & Invariant I6: AI output may only make decisions stricter.
 * - Rule 7 & Invariant I2: Every state transition writes an audit_log row in the same transaction.
 * - Rule 8: Fail closed on error or ambiguity; never leak stack traces, database internals, or credentials.
 * - Agent identity is derived strictly from AsyncLocalStorage (never client-supplied parameters).
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import { createRepositories } from '../db/repositories.js';
import {
  parseDecimalToMinorUnits,
  formatMinorUnitsToDecimal,
  toMinorUnits,
  AMOUNT_DECIMAL_REGEX,
} from '../core/money.js';
import {
  evaluateAndReserve,
  IdempotencyConflictError,
  VendorNotFoundError,
} from '../core/service.js';
import { executeDecision, type ExecuteDecisionOptions } from '../core/executeDecision.js';
import { getRollingBudgets } from '../core/facts.js';
import { getAuthenticatedAgent } from './auth.js';
import type { PolicyDocument } from '../policy/types.js';

// ============================================================================
// Tool Result Interface
// ============================================================================

export type ToolResult = CallToolResult;

// ============================================================================
// Zod Input Validation Schemas
// ============================================================================

/**
 * Zod schema for request_payment input per PLAN.md line 486.
 * .strict() ensures client cannot supply unexpected fields (e.g. agent_id, credentials).
 */
export const requestPaymentInputSchema = z
  .object({
    vendor_id: z
      .string()
      .trim()
      .min(1, 'vendor_id cannot be empty'),
    amount: z
      .string()
      .trim()
      .regex(
        AMOUNT_DECIMAL_REGEX,
        'amount must be a decimal string matching up to 7 digits before decimal and up to 2 decimal places (e.g. "12.00")'
      ),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter uppercase ISO currency code (e.g. "USD")'),
    purpose: z
      .string()
      .trim()
      .min(1, 'purpose cannot be empty')
      .max(200, 'purpose must not exceed 200 characters'),
    category: z.string().trim().max(100, 'category must not exceed 100 characters').optional().nullable(),
    idempotency_key: z
      .string()
      .trim()
      .min(8, 'idempotency_key must be at least 8 characters')
      .max(64, 'idempotency_key must not exceed 64 characters'),
    source_context: z
      .string()
      .max(2000, 'source_context must not exceed 2000 characters')
      .optional()
      .nullable(),
  })
  .strict();

export type RequestPaymentInput = z.infer<typeof requestPaymentInputSchema>;

/**
 * Zod schema for get_payment_status input per PLAN.md line 487.
 */
export const getPaymentStatusInputSchema = z
  .object({
    request_id: z
      .string()
      .trim()
      .min(1, 'request_id cannot be empty'),
  })
  .strict();

export type GetPaymentStatusInput = z.infer<typeof getPaymentStatusInputSchema>;

/**
 * Zod schema for get_budget input per PLAN.md line 488.
 */
export const getBudgetInputSchema = z.object({}).strict();

/**
 * Zod schema for list_vendors input per PLAN.md line 489.
 */
export const listVendorsInputSchema = z.object({}).strict();

// ============================================================================
// Error Sanitization Helper
// ============================================================================

/**
 * Formats Zod errors to return only field paths and validation constraints,
 * preventing leakage of internal execution traces, SQL statements, or system state.
 */
export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((i) => {
    const path = i.path.length > 0 ? i.path.join('.') : 'input';
    return `${path}: ${i.message}`;
  });
  return `Validation error: ${issues.join('; ')}`;
}

function getNextStep(decision: string | null, status: string): string {
  if (status === 'CAPTURED') {
    return 'Payment successfully captured. No further action needed.';
  }
  if (status === 'HELD') {
    return 'Payment is placed on hold awaiting human review and approval by the account owner. Check status later using get_payment_status with request_id. Do not resubmit with altered parameters.';
  }
  if (decision === 'DENY' || status === 'DENIED') {
    return 'DENIED decisions are final; do not retry with altered parameters.';
  }
  if (status === 'FAILED') {
    return 'Payment execution failed. Do not retry automatically.';
  }
  return 'Payment request submitted.';
}

// ============================================================================
// Tool 1: request_payment
// ============================================================================

export async function handleRequestPayment(
  db: Database,
  args: unknown,
  repositories?: Repositories,
  options?: ExecuteDecisionOptions
): Promise<ToolResult> {
  const parseResult = requestPaymentInputSchema.safeParse(args);
  if (!parseResult.success) {
    return {
      content: [{ type: 'text', text: formatZodError(parseResult.error) }],
      isError: true,
    };
  }

  const input = parseResult.data;
  const repos = repositories ?? createRepositories(db);

  // Authenticated agent identity strictly from context
  const { agentId } = getAuthenticatedAgent();

  // Parse decimal amount string to branded MinorUnits
  let amountMinor;
  try {
    amountMinor = parseDecimalToMinorUnits(input.amount);
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Validation error: amount: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      isError: true,
    };
  }

  if (amountMinor <= 0) {
    return {
      content: [{ type: 'text', text: 'Validation error: amount: payment amount must be greater than zero' }],
      isError: true,
    };
  }

  // 1. Transactional evaluation and reservation (Flow A, B, E)
  let evalResult;
  try {
    evalResult = evaluateAndReserve(
      db,
      {
        agentId,
        vendorId: input.vendor_id,
        amountMinor,
        currency: input.currency,
        purpose: input.purpose,
        category: input.category,
        idempotencyKey: input.idempotency_key,
        sourceContext: input.source_context,
      },
      repos
    );
  } catch (err: unknown) {
    if (err instanceof IdempotencyConflictError) {
      return {
        content: [
          {
            type: 'text',
            text: `IDEMPOTENCY_CONFLICT: Idempotency key "${input.idempotency_key}" was previously used with differing request parameters. Reusing idempotency keys with different payloads is prohibited.`,
          },
        ],
        isError: true,
      };
    }
    if (err instanceof VendorNotFoundError) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: Vendor "${input.vendor_id}" is not registered in the PayGuard firewall. Call list_vendors to see allowed vendors.`,
          },
        ],
        isError: true,
      };
    }
    // Fail-closed sanitized error
    return {
      content: [{ type: 'text', text: 'Error: Payment evaluation failed due to policy configuration.' }],
      isError: true,
    };
  }

  // Handle idempotent replay of previously evaluated request
  if (evalResult.isIdempotentReplay) {
    const existingReq = evalResult.request;
    const existingReasons = existingReq.reasons ? JSON.parse(existingReq.reasons) : [];
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              request_id: existingReq.id,
              status: existingReq.status,
              decision: existingReq.decision,
              reasons: existingReasons,
              message: 'Idempotent replay: returning existing payment request result.',
              next_step: getNextStep(existingReq.decision, existingReq.status),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // 2. Choke-point execution for newly evaluated request
  let currentStatus = evalResult.request.status;
  const decision = evalResult.decision;
  const reasons = [...evalResult.reasons];

  if (decision === 'ALLOW') {
    // Flow A: Auto-execute CAPTURE via executeDecision
    try {
      const execRes = await executeDecision(
        { requestId: evalResult.request.id },
        { db, repos, ...options }
      );
      currentStatus = execRes.status;
    } catch {
      // Re-read authoritative status from database after failure/ambiguity
      const updated = repos.paymentRequests.getById(evalResult.request.id);
      currentStatus = updated?.status ?? 'FAILED';
    }
  } else if (decision === 'HOLD') {
    // Flow B: Authorize hold established via executeDecision if PayPal ordersService configured
    if (options?.ordersService) {
      try {
        const execRes = await executeDecision(
          { requestId: evalResult.request.id },
          { db, repos, ...options }
        );
        currentStatus = execRes.status;
      } catch {
        currentStatus = 'HELD';
      }
    }
  }

  let userMessage = 'Payment evaluated successfully.';
  if (currentStatus === 'CAPTURED') {
    userMessage = 'Payment captured successfully via PayPal sandbox.';
  } else if (currentStatus === 'HELD') {
    userMessage = 'Payment placed on hold: awaiting human review and approval by the account owner.';
  } else if (decision === 'DENY' || currentStatus === 'DENIED') {
    userMessage = 'Payment denied by policy firewall.';
  } else if (currentStatus === 'FAILED') {
    userMessage = 'Payment execution failed on PayPal sandbox.';
  }

  const responsePayload = {
    request_id: evalResult.request.id,
    status: currentStatus,
    decision,
    reasons,
    message: userMessage,
    next_step: getNextStep(decision, currentStatus),
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(responsePayload, null, 2),
      },
    ],
  };
}

// ============================================================================
// Tool 2: get_payment_status
// ============================================================================

export async function handleGetPaymentStatus(
  _db: Database,
  args: unknown,
  repositories?: Repositories
): Promise<ToolResult> {
  const parseResult = getPaymentStatusInputSchema.safeParse(args);
  if (!parseResult.success) {
    return {
      content: [{ type: 'text', text: formatZodError(parseResult.error) }],
      isError: true,
    };
  }

  const repos = repositories!;
  const { agentId } = getAuthenticatedAgent();
  const requestId = parseResult.data.request_id;
  const request = repos.paymentRequests.getById(requestId);

  // Enforce tenant isolation & request ownership: reject if non-existent or owned by another agent
  if (!request || request.agent_id !== agentId) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: Payment request "${requestId}" not found.`,
        },
      ],
      isError: true,
    };
  }

  const reasons = request.reasons ? JSON.parse(request.reasons) : [];

  // Strictly return only public status metadata (never approval links, tokens, or credentials)
  const responsePayload = {
    request_id: request.id,
    status: request.status,
    decision: request.decision,
    reasons,
    created_at: request.created_at,
    updated_at: request.updated_at,
    expires_at: request.expires_at,
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(responsePayload, null, 2),
      },
    ],
  };
}

// ============================================================================
// Tool 3: get_budget
// ============================================================================

export async function handleGetBudget(
  db: Database,
  args: unknown,
  repositories?: Repositories
): Promise<ToolResult> {
  const parseResult = getBudgetInputSchema.safeParse(args ?? {});
  if (!parseResult.success) {
    return {
      content: [{ type: 'text', text: formatZodError(parseResult.error) }],
      isError: true,
    };
  }

  const repos = repositories ?? createRepositories(db);
  const { agentId, agent } = getAuthenticatedAgent();

  const activePolicyRow = repos.policyVersions.getActive();
  if (!activePolicyRow) {
    return {
      content: [{ type: 'text', text: 'Error: Policy system not configured.' }],
      isError: true,
    };
  }

  const policyDoc = JSON.parse(activePolicyRow.rules) as PolicyDocument;
  const allowedCurrencies = policyDoc.currency_allowlist ?? ['USD'];
  const primaryCurrency = allowedCurrencies[0] ?? 'USD';

  // Rolling 24h window
  const windowStartIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const budgets = getRollingBudgets(db, agentId, primaryCurrency, windowStartIso);

  const commitmentsMinor =
    (budgets.agentSpendRolling24hMinor as number) +
    (budgets.agentReservedRolling24hMinor as number);
  const agentDailyLimit = agent.daily_budget_minor as number;
  const policyDailyLimit = policyDoc.agent_daily_budget_minor as number;
  const effectiveLimit = Math.min(agentDailyLimit, policyDailyLimit);
  const remainingMinor = Math.max(0, effectiveLimit - commitmentsMinor);

  const responsePayload: Record<string, unknown> = {
    currency: primaryCurrency,
    remaining_daily_budget: formatMinorUnitsToDecimal(toMinorUnits(remainingMinor)),
    remaining_daily_budget_minor: remainingMinor,
    allowed_currencies: allowedCurrencies,
  };

  // Thresholds hidden unless expose_limits: true per PLAN.md Section 11
  const docAny = policyDoc as Record<string, unknown>;
  if (docAny.expose_limits === true) {
    responsePayload.daily_limit = formatMinorUnitsToDecimal(toMinorUnits(effectiveLimit));
    responsePayload.spent_24h = formatMinorUnitsToDecimal(budgets.agentSpendRolling24hMinor);
    responsePayload.reserved = formatMinorUnitsToDecimal(budgets.agentReservedRolling24hMinor);
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(responsePayload, null, 2),
      },
    ],
  };
}

// ============================================================================
// Tool 4: list_vendors
// ============================================================================

export async function handleListVendors(
  _db: Database,
  args: unknown,
  repositories?: Repositories
): Promise<ToolResult> {
  const parseResult = listVendorsInputSchema.safeParse(args ?? {});
  if (!parseResult.success) {
    return {
      content: [{ type: 'text', text: formatZodError(parseResult.error) }],
      isError: true,
    };
  }

  const repos = repositories!;

  // Only list ACTIVE and UNVERIFIED vendors; BLOCKED vendors are strictly excluded
  const allVendors = repos.vendors.listAll();
  const visibleVendors = allVendors
    .filter((v) => v.status === 'ACTIVE' || v.status === 'UNVERIFIED')
    .map((v) => ({
      vendor_id: v.id,
      name: v.name,
      categories: JSON.parse(v.categories),
      currencies: JSON.parse(v.currencies),
      status: v.status,
      verification_status: v.status === 'ACTIVE' ? 'VERIFIED_ACTIVE' : 'UNVERIFIED_PENDING_REVIEW',
      safety_notice:
        v.status === 'UNVERIFIED'
          ? 'UNVERIFIED: Vendor is NOT verified. Payment requests will require human review and approval (Soft HOLD).'
          : 'ACTIVE: Verified vendor approved for policy-evaluated automated payments.',
    }));

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ vendors: visibleVendors }, null, 2),
      },
    ],
  };
}
