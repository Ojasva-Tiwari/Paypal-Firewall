/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T6: Facts Aggregator
 *
 * Gathers database-backed facts required by the deterministic policy engine:
 * - Agent status (active, suspended, missing)
 * - Vendor status and metadata (categories, currencies)
 * - Rolling 24-hour spend and reserved commitments from the ledger
 * - Velocity window request count per agent
 * - Duplicate request detection within configured duplicate window
 *
 * Security Invariants & Rules:
 * - AGENTS.md Rule 5 & I4: Money is integer minor units (MinorUnits).
 * - AGENTS.md Rule 8: Fail closed on missing records or ambiguity.
 * - Deterministic, pure clock injection via optional `now` parameter.
 */

import type { Database } from '../db/connection.js';
import { createRepositories } from '../db/repositories.js';
import type {
  PolicyRequest,
  PolicyFacts,
  PolicyDocument,
} from '../policy/types.js';
import {
  type MinorUnits,
  MAX_MINOR_UNITS,
} from './money.js';

export interface GatherFactsOptions {
  readonly now?: Date;
  readonly currentRequestId?: string;
}

export interface RollingBudgets {
  readonly agentSpendRolling24hMinor: MinorUnits;
  readonly agentReservedRolling24hMinor: MinorUnits;
  readonly globalSpendRolling24hMinor: MinorUnits;
  readonly globalReservedRolling24hMinor: MinorUnits;
}

export interface VendorFacts {
  readonly vendorStatus: 'ACTIVE' | 'UNVERIFIED' | 'BLOCKED' | 'MISSING';
  readonly vendorCategories?: readonly string[];
  readonly vendorCurrencies?: readonly string[];
}

/**
 * Casts a calculated number safely into MinorUnits.
 * Clamps negative values to 0 and values exceeding MAX_MINOR_UNITS to MAX_MINOR_UNITS
 * to avoid throwing while remaining strictly fail-closed against budget caps.
 */
function toSafeMinorUnits(value: unknown): MinorUnits {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0 as MinorUnits;
  }
  const integerVal = Math.floor(value);
  if (integerVal > MAX_MINOR_UNITS) {
    return MAX_MINOR_UNITS;
  }
  return integerVal as MinorUnits;
}

/**
 * Resolves the agent's status from the registry.
 * Fails closed: if the agent is not found or malformed, returns 'SUSPENDED'.
 */
export function getAgentStatus(db: Database, agentId: string): 'ACTIVE' | 'SUSPENDED' {
  if (!agentId || typeof agentId !== 'string') {
    return 'SUSPENDED';
  }
  const repos = createRepositories(db);
  const agent = repos.agents.getById(agentId);
  if (!agent) {
    return 'SUSPENDED';
  }
  return agent.status === 'ACTIVE' ? 'ACTIVE' : 'SUSPENDED';
}

/**
 * Resolves the vendor's status, allowed categories, and currencies from the registry.
 * Fails closed: if the vendor is not found, returns 'MISSING'.
 */
export function getVendorFacts(db: Database, vendorId: string): VendorFacts {
  if (!vendorId || typeof vendorId !== 'string') {
    return { vendorStatus: 'MISSING' };
  }

  const repos = createRepositories(db);
  const vendor = repos.vendors.getById(vendorId);
  if (!vendor) {
    return { vendorStatus: 'MISSING' };
  }

  let categories: string[] | undefined;
  let currencies: string[] | undefined;

  try {
    const parsedCats = JSON.parse(vendor.categories);
    if (Array.isArray(parsedCats)) {
      categories = parsedCats.filter((c): c is string => typeof c === 'string');
    }
  } catch {
    categories = [];
  }

  try {
    const parsedCurrs = JSON.parse(vendor.currencies);
    if (Array.isArray(parsedCurrs)) {
      currencies = parsedCurrs.filter((c): c is string => typeof c === 'string');
    }
  } catch {
    currencies = [];
  }

  return {
    vendorStatus: vendor.status,
    vendorCategories: categories,
    vendorCurrencies: currencies,
  };
}

/**
 * Aggregates agent and global spend and reserved commitments over a rolling 24h window
 * from the financial ledger.
 *
 * Rules:
 * - Spend: Sum of SPEND ledger entries created in the rolling 24h window.
 * - Reserved: Net unspent and unreleased reservations (RESERVE - RELEASE - SPEND).
 *   Only commitments matching the requested currency are aggregated.
 */
export function getRollingBudgets(
  db: Database,
  agentId: string,
  currency: string,
  window24hStartIso: string
): RollingBudgets {
  const query = `
    WITH commitments AS (
      SELECT
        l.request_id,
        pr.agent_id,
        SUM(CASE WHEN l.kind = 'SPEND' AND l.created_at >= ? THEN l.amount_minor ELSE 0 END) AS spend_24h,
        SUM(CASE WHEN l.kind = 'RESERVE' THEN l.amount_minor ELSE 0 END) -
          SUM(CASE WHEN l.kind IN ('RELEASE', 'SPEND') THEN l.amount_minor ELSE 0 END) AS net_reserved
      FROM ledger l
      JOIN payment_requests pr ON l.request_id = pr.id
      WHERE l.currency = ?
      GROUP BY l.request_id, pr.agent_id
    )
    SELECT
      COALESCE(SUM(CASE WHEN agent_id = ? THEN spend_24h ELSE 0 END), 0) AS agent_spend,
      COALESCE(SUM(CASE WHEN agent_id = ? AND net_reserved > 0 THEN net_reserved ELSE 0 END), 0) AS agent_reserved,
      COALESCE(SUM(spend_24h), 0) AS global_spend,
      COALESCE(SUM(CASE WHEN net_reserved > 0 THEN net_reserved ELSE 0 END), 0) AS global_reserved
    FROM commitments;
  `;

  interface BudgetRow {
    agent_spend: number;
    agent_reserved: number;
    global_spend: number;
    global_reserved: number;
  }

  const row = db.prepare(query).get(window24hStartIso, currency, agentId, agentId) as BudgetRow | undefined;

  return {
    agentSpendRolling24hMinor: toSafeMinorUnits(row?.agent_spend ?? 0),
    agentReservedRolling24hMinor: toSafeMinorUnits(row?.agent_reserved ?? 0),
    globalSpendRolling24hMinor: toSafeMinorUnits(row?.global_spend ?? 0),
    globalReservedRolling24hMinor: toSafeMinorUnits(row?.global_reserved ?? 0),
  };
}

/**
 * Counts the number of requests submitted by the agent within the rolling velocity window.
 * Optionally excludes the current request ID to avoid self-counting if already inserted.
 */
export function getVelocityCount(
  db: Database,
  agentId: string,
  velocityWindowStartIso: string,
  currentRequestId?: string
): number {
  const query = `
    SELECT COUNT(*) AS req_count
    FROM payment_requests
    WHERE agent_id = ?
      AND created_at >= ?
      AND (? IS NULL OR id != ?);
  `;

  interface CountRow {
    req_count: number;
  }

  const excludeId = currentRequestId ?? null;
  const row = db.prepare(query).get(agentId, velocityWindowStartIso, excludeId, excludeId) as CountRow | undefined;
  return row?.req_count ?? 0;
}

/**
 * Determines whether an identical request (same agent, vendor, amount, currency, and purpose)
 * was already submitted within the duplicate window.
 * Optionally excludes the current request ID to avoid self-matching.
 */
export function checkDuplicate(
  db: Database,
  request: PolicyRequest,
  duplicateWindowMinutes: number,
  now: Date,
  currentRequestId?: string
): boolean {
  if (duplicateWindowMinutes <= 0) {
    return false;
  }

  const windowStartIso = new Date(now.getTime() - duplicateWindowMinutes * 60 * 1000).toISOString();
  const query = `
    SELECT 1
    FROM payment_requests
    WHERE agent_id = ?
      AND vendor_id = ?
      AND amount_minor = ?
      AND currency = ?
      AND purpose = ?
      AND created_at >= ?
      AND (? IS NULL OR id != ?)
    LIMIT 1;
  `;

  const excludeId = currentRequestId ?? null;
  const match = db
    .prepare(query)
    .get(
      request.agentId,
      request.vendorId,
      request.amountMinor,
      request.currency,
      request.purpose,
      windowStartIso,
      excludeId,
      excludeId
    );

  return match !== undefined;
}

/**
 * Main entry point: Gathers all database-backed facts for a given policy evaluation.
 *
 * @param db - SQLite Database instance
 * @param request - Normalized policy request
 * @param policy - Active policy document
 * @param options - Optional injected clock and current request ID
 * @returns Fully populated PolicyFacts conforming to the policy engine interface
 */
export function gatherFacts(
  db: Database,
  request: PolicyRequest,
  policy: PolicyDocument,
  options?: GatherFactsOptions
): PolicyFacts {
  const now = options?.now ?? new Date();
  const window24hStartIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const velocityWindowStartIso = new Date(
    now.getTime() - policy.velocity.window_minutes * 60 * 1000
  ).toISOString();

  // 1. Agent status
  const agentStatus = getAgentStatus(db, request.agentId);

  // 2. Vendor facts
  const vendorFacts = getVendorFacts(db, request.vendorId);

  // 3. Rolling 24h budgets from ledger
  const budgets = getRollingBudgets(db, request.agentId, request.currency, window24hStartIso);

  // 4. Velocity window count
  const recentRequestCountInVelocityWindow = getVelocityCount(
    db,
    request.agentId,
    velocityWindowStartIso,
    options?.currentRequestId
  );

  // 5. Duplicate detection
  const hasDuplicateInWindow = checkDuplicate(
    db,
    request,
    policy.duplicate_window_minutes,
    now,
    options?.currentRequestId
  );

  return {
    agentStatus,
    vendorStatus: vendorFacts.vendorStatus,
    vendorCategories: vendorFacts.vendorCategories,
    vendorCurrencies: vendorFacts.vendorCurrencies,
    agentSpendRolling24hMinor: budgets.agentSpendRolling24hMinor,
    agentReservedRolling24hMinor: budgets.agentReservedRolling24hMinor,
    globalSpendRolling24hMinor: budgets.globalSpendRolling24hMinor,
    globalReservedRolling24hMinor: budgets.globalReservedRolling24hMinor,
    recentRequestCountInVelocityWindow,
    hasDuplicateInWindow,
  };
}
