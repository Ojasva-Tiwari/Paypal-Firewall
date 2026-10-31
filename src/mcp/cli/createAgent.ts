#!/usr/bin/env node
/**
 * PayGuard — Milestone M3: MCP Integration
 * CLI: Agent Creation Tool (`npm run agent:create`)
 *
 * Usage:
 *   npm run agent:create "<Agent Name>" [dailyBudgetUSD]
 *   tsx src/mcp/cli/createAgent.ts "Honest Agent" 50.00
 *
 * Unit Clarification:
 * - dailyBudgetUSD must be passed in decimal dollars, NOT integer minor units.
 *   - "50.00" represents $50.00 USD (5,000 minor units).
 *   - "5000.00" (or "5000") represents $5,000.00 USD (500,000 minor units).
 * - The CLI parses the decimal dollar amount into integer minor units for storage.
 *
 * Security & Invariants:
 * - Generates 32 cryptographically secure random bytes.
 * - Stores ONLY the SHA-256 hash in SQLite (`agents.api_key_hash`).
 * - Displays the raw API key ONCE to stdout and NEVER logs or persists it.
 * - Budgets are stored strictly as integer minor units.
 */

import * as crypto from 'node:crypto';
import { loadConfig } from '../../config/index.js';
import { createDatabase, runMigrations } from '../../db/connection.js';
import { createRepositories } from '../../db/repositories.js';
import { parseDecimalToMinorUnits, type MinorUnits } from '../../core/money.js';
import { generateAgentKey } from '../auth.js';
import type { AgentRow } from '../../db/types.js';

import type { Database } from '../../db/connection.js';

export function runAgentCreation(
  args: string[],
  injectedDb?: Database
): {
  id: string;
  name: string;
  rawKey: string;
  keyHash: string;
  dailyBudgetMinor: MinorUnits;
} {
  const nameArg = args[0]?.trim();
  if (!nameArg) {
    throw new Error(
      'Usage: npm run agent:create "<Agent Name>" [dailyBudgetUSD]\n' +
        'Note: dailyBudgetUSD must be passed in decimal dollars (e.g. "50.00" for $50.00 USD / 5000 minor units). ' +
        'Do NOT pass minor units directly; "5000" represents $5,000.00 USD (500000 minor units).'
    );
  }

  const budgetArg = args[1]?.trim() ?? '50.00';
  let dailyBudgetMinor: MinorUnits;
  try {
    dailyBudgetMinor = parseDecimalToMinorUnits(budgetArg);
  } catch (err) {
    throw new Error(
      `Invalid dailyBudgetUSD "${budgetArg}": ${err instanceof Error ? err.message : String(err)}. ` +
        'Expected decimal dollars (e.g. "50.00" for $50.00 USD). Note: "5000" means $5,000.00 USD, not $50.00.'
    );
  }

  let db: Database;
  let shouldClose = false;
  if (injectedDb) {
    db = injectedDb;
  } else {
    const config = loadConfig();
    db = createDatabase(config.databasePath);
    runMigrations(db);
    shouldClose = true;
  }
  const repos = createRepositories(db);

  const { rawKey, keyHash } = generateAgentKey();
  const agentId = `agent-${crypto.randomUUID()}`;
  const nowIso = new Date().toISOString();

  const agent: AgentRow = {
    id: agentId,
    name: nameArg,
    api_key_hash: keyHash,
    status: 'ACTIVE',
    daily_budget_minor: dailyBudgetMinor,
    created_at: nowIso,
  };

  repos.agents.insert(agent);
  if (shouldClose) {
    db.close();
  }

  const formattedBudget = (dailyBudgetMinor / 100).toFixed(2);

  console.log('\n================================================================');
  console.log(' PayGuard: New Agent Created Successfully');
  console.log('================================================================');
  console.log(` Agent ID      : ${agentId}`);
  console.log(` Name          : ${nameArg}`);
  console.log(` Daily Budget  : $${formattedBudget} USD`);
  console.log(` Status        : ACTIVE`);
  console.log(' ------------------------------------------------------------');
  console.log(` Secret API Key: ${rawKey}`);
  console.log(' ------------------------------------------------------------');
  console.log(' WARNING: This secret key is shown ONCE and NEVER stored or logged.');
  console.log(' Store it securely in your agent environment configuration.');
  console.log('================================================================\n');

  return {
    id: agentId,
    name: nameArg,
    rawKey,
    keyHash,
    dailyBudgetMinor,
  };
}

// Only execute directly when run from CLI
if (process.argv[1]?.endsWith('createAgent.ts') || process.argv[1]?.endsWith('createAgent.js')) {
  runAgentCreation(process.argv.slice(2));
}
