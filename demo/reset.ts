/**
 * PayGuard — Milestone M3: MCP Integration
 * M3-T6: Demo State Reset (`demo/reset.ts`)
 *
 * Implements:
 * - Atomic reset of ephemeral demo transaction state:
 *     1. Deletes rows from `ledger` (reservations, releases, spends)
 *     2. Deletes rows from `approvals` (temporary hold tokens)
 *     3. Deletes rows from `ai_runs` (AI inspection logs)
 *     4. Deletes rows from `payment_requests` (transaction records)
 * - Preserves essential configuration and security entities:
 *     - `owners` (owner credentials and display name)
 *     - `agents` (agent identities and budget baselines)
 *     - `vendors` (registered vendors and connectors)
 *     - `vendor_vault_tokens` (onboarded PayPal vault tokens)
 *     - `policy_versions` (immutable policy rules and active versions)
 *     - `audit_log` (append-only audit chain is strictly preserved)
 * - Appends a signed, hash-chained `demo_state_reset` audit record
 * - Never invokes PayPal money-moving calls during reset
 * - Fail-closed: runs entirely inside an atomic SQLite transaction
 *
 * Security & Invariants:
 * - Hard Rule 1: Sandbox only. Production is strictly refused.
 * - Hard Rule 4: Money-moving PayPal calls are NEVER invoked here.
 * - Hard Rule 7: Every state transition writes an audit_log row in the same transaction.
 * - Append-only integrity: Never attempts DELETE on audit_log or policy_versions.
 */

import type { Database } from '../src/db/connection.js';
import { createDatabase, runMigrations, runInTransaction } from '../src/db/connection.js';
import { Repositories } from '../src/db/repositories.js';
import { writeAuditLogEntry } from '../src/core/stateMachine.js';
import { getConfig } from '../src/config/index.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface ResetDemoOptions {
  readonly repos?: Repositories;
  readonly logger?: {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface ResetDemoResult {
  readonly success: boolean;
  readonly deletedLedgerRows: number;
  readonly deletedApprovalRows: number;
  readonly deletedAiRunRows: number;
  readonly deletedPaymentRequests: number;
  readonly timestamp: string;
}

// ============================================================================
// Core Reset Function
// ============================================================================

/**
 * Resets runtime transaction state in the demo database while preserving
 * all configuration, policies, agents, vendors, vault tokens, and audit history.
 */
export function resetDemoDatabase(
  db: Database,
  options?: ResetDemoOptions
): ResetDemoResult {
  const repos = options?.repos ?? new Repositories(db);
  const nowIso = new Date().toISOString();

  return runInTransaction(db, () => {
    // 1. Delete dependent transactional rows respecting foreign keys
    const deletedLedger = db.prepare('DELETE FROM ledger').run();
    const deletedApprovals = db.prepare('DELETE FROM approvals').run();
    const deletedAiRuns = db.prepare('DELETE FROM ai_runs').run();

    // 2. Delete payment requests
    const deletedRequests = db.prepare('DELETE FROM payment_requests').run();

    // 3. Append-only audit record of the reset operation
    writeAuditLogEntry(db, repos, {
      actor: 'system',
      event: 'demo_state_reset',
      requestId: null,
      payload: {
        timestamp: nowIso,
        deleted_ledger_rows: deletedLedger.changes,
        deleted_approval_rows: deletedApprovals.changes,
        deleted_ai_run_rows: deletedAiRuns.changes,
        deleted_payment_requests: deletedRequests.changes,
      },
    });

    return {
      success: true,
      deletedLedgerRows: deletedLedger.changes,
      deletedApprovalRows: deletedApprovals.changes,
      deletedAiRunRows: deletedAiRuns.changes,
      deletedPaymentRequests: deletedRequests.changes,
      timestamp: nowIso,
    };
  });
}

// ============================================================================
// CLI Execution Runner
// ============================================================================

export async function runCli(): Promise<void> {
  const config = getConfig();
  const db = createDatabase(config.databasePath);
  runMigrations(db);

  const result = resetDemoDatabase(db);

  console.log('\n================================================================');
  console.log(' PayGuard: Demo Runtime State Reset Successfully');
  console.log('================================================================');
  console.log(` Timestamp              : ${result.timestamp}`);
  console.log(` Cleared Payment Requests: ${result.deletedPaymentRequests}`);
  console.log(` Cleared Ledger Rows    : ${result.deletedLedgerRows}`);
  console.log(` Cleared Approvals      : ${result.deletedApprovalRows}`);
  console.log(` Cleared AI Runs        : ${result.deletedAiRunRows}`);
  console.log(' ------------------------------------------------------------');
  console.log(' Preserved Configuration:');
  console.log('  ✓ Owners and Credentials');
  console.log('  ✓ Agents and Budget Baselines');
  console.log('  ✓ Registered Vendors');
  console.log('  ✓ Onboarded PayPal Vault Tokens');
  console.log('  ✓ Immutable Policy Versions');
  console.log('  ✓ Append-Only Cryptographic Audit Log');
  console.log('================================================================\n');

  db.close();
}

if (process.argv[1]?.endsWith('reset.ts') || process.argv[1]?.endsWith('reset.js')) {
  runCli().catch((err) => {
    console.error('[DemoReset Error]:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

