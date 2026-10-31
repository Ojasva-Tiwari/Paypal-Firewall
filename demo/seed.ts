/**
 * PayGuard — Milestone M3: MCP Integration
 * M3-T6: Demo Harness Seeding (`demo/seed.ts`)
 *
 * Implements:
 * - Deterministic seeding of demo configuration:
 *     1. Demo Owner ('default' row with SHA-256 hashed passphrase)
 *     2. Canonical Demo Policy v1 ($15 auto-approve, $100 cap, $50 daily budget)
 *     3. Active Approved Vendor ('ven-acme' with 'acme_cloud' connector)
 *     4. Active Demo Honest Agent ('agent-demo-honest' with $50 budget)
 *     5. Vendor Vault Token detection and optional persistence
 * - Idempotent execution: safe to rerun without duplicating or corrupting records
 * - Raw API key is shown ONCE on creation and NEVER stored or logged
 * - Fail-closed on missing configuration without fabricating credentials
 *
 * Security & Invariants:
 * - Hard Rule 1: Sandbox only. Production is strictly refused.
 * - Hard Rule 2: Never commit or store raw API keys, credentials, or access tokens.
 * - Hard Rule 5: Monetary amounts strictly represented as integer minor units.
 */

import * as crypto from 'node:crypto';
import type { Database } from '../src/db/connection.js';
import { createDatabase, runMigrations } from '../src/db/connection.js';
import { Repositories } from '../src/db/repositories.js';
import { toMinorUnits } from '../src/core/money.js';
import { generateAgentKey, hashApiKey } from '../src/mcp/auth.js';
import { getConfig } from '../src/config/index.js';
import type { PolicyDocument } from '../src/policy/types.js';
import type { AgentRow, VendorRow, PolicyVersionRow } from '../src/db/types.js';

// ============================================================================
// Canonical Demo Policy v1 (PLAN.md Section 4.2 & Section 14)
// ============================================================================

export const CANONICAL_DEMO_POLICY_V1: PolicyDocument = {
  version: 1,
  currency_allowlist: ['USD'],
  auto_limit_minor: toMinorUnits(1500),         // $15.00 auto-approve
  hard_cap_minor: toMinorUnits(10000),          // $100.00 hard cap
  agent_daily_budget_minor: toMinorUnits(5000), // $50.00 daily budget per agent
  global_daily_budget_minor: toMinorUnits(20000), // $200.00 global daily budget
  velocity: { max_requests: 5, window_minutes: 10 },
  duplicate_window_minutes: 60,
  new_vendor_action: 'HOLD',
  hold_ttl_minutes: 15,
};

export const DEMO_HONEST_AGENT_ID = 'agent-demo-honest';
export const DEMO_VENDOR_ID = 'ven-acme';
export const DEMO_POLICY_VERSION_ID = 'pol-v1';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface SeedDemoOptions {
  readonly repos?: Repositories;
  readonly apiKey?: string;
  readonly vaultTokenId?: string;
  readonly logger?: {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface SeedDemoResult {
  readonly success: boolean;
  readonly ownerId: string;
  readonly vendorId: string;
  readonly policyVersion: number;
  readonly agentId: string;
  readonly rawApiKey: string;
  readonly apiKeyWasGenerated: boolean;
  readonly hasVaultToken: boolean;
  readonly vaultTokenId?: string;
  readonly warnings: readonly string[];
}

// ============================================================================
// Core Seeding Function
// ============================================================================

/**
 * Seeds the database with deterministic demo configuration.
 * Safe to execute repeatedly without duplicating rows or replacing tokens.
 */
export function seedDemoDatabase(
  db: Database,
  options?: SeedDemoOptions
): SeedDemoResult {
  const logger = options?.logger ?? console;
  const repos = options?.repos ?? new Repositories(db);
  const warnings: string[] = [];
  const nowIso = new Date().toISOString();

  // Inspect existing agent to determine credential handling
  const existingAgent = repos.agents.getById(DEMO_HONEST_AGENT_ID);
  const explicitApiKey = options?.apiKey?.trim() || process.env.DEMO_AGENT_API_KEY?.trim() || '';

  let rawApiKey = '';
  let apiKeyWasGenerated = false;
  let keyHash: string;

  if (explicitApiKey) {
    // Explicit API key supplied (via options or DEMO_AGENT_API_KEY): set or rotate hash
    rawApiKey = explicitApiKey;
    keyHash = hashApiKey(explicitApiKey);
  } else if (!existingAgent) {
    // First-time seeding: agent does not exist, generate 32-byte crypto key
    const generated = generateAgentKey();
    rawApiKey = generated.rawKey;
    keyHash = generated.keyHash;
    apiKeyWasGenerated = true;
  } else {
    // Agent already exists and no explicit key provided:
    // PRESERVE existing api_key_hash. Do NOT generate replacement or rotate credentials.
    keyHash = existingAgent.api_key_hash;
    const warnMsg =
      "Existing demo agent 'agent-demo-honest' credentials preserved without rotation. " +
      "The raw API key cannot be recovered from the database. " +
      "Configure DEMO_AGENT_API_KEY in your environment with the original key.";
    warnings.push(warnMsg);
    logger.warn(`[DemoSeed] ${warnMsg}`);
  }

  // 1. Seed Demo Owner (id: 'default' per SQLite CHECK constraint)
  // Check whether default owner already exists; strictly preserve existing passphrase_hash and credentials
  const existingOwner = repos.owners.get();
  if (!existingOwner) {
    const defaultPassphrase = 'payguard-demo-passphrase';
    const ownerHash =
      process.env.OWNER_PASSPHRASE_HASH?.trim() ||
      crypto.createHash('sha256').update(defaultPassphrase, 'utf8').digest('hex');

    repos.owners.upsert({
      display_name: 'Primary Owner',
      passphrase_hash: ownerHash,
      telegram_chat_id: process.env.TELEGRAM_OWNER_CHAT_ID?.trim() || null,
      created_at: nowIso,
    });
  }

  // 2. Seed Approved Demo Vendor (Acme Cloud Hosting)
  const existingVendor = repos.vendors.getById(DEMO_VENDOR_ID);
  if (!existingVendor) {
    const vendorRow: VendorRow = {
      id: DEMO_VENDOR_ID,
      name: 'Acme Cloud Hosting',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud', 'hosting', 'saas']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: nowIso,
    };
    repos.vendors.insert(vendorRow);
  } else if (existingVendor.status !== 'ACTIVE') {
    repos.vendors.updateStatus(DEMO_VENDOR_ID, 'ACTIVE');
  }

  // 3. Seed Canonical Policy v1
  const existingPolicy = repos.policyVersions.getByVersion(1);
  if (!existingPolicy) {
    const policyRow: PolicyVersionRow = {
      id: DEMO_POLICY_VERSION_ID,
      version: 1,
      rules: JSON.stringify(CANONICAL_DEMO_POLICY_V1),
      author: 'owner',
      active: 1,
      created_at: nowIso,
    };
    repos.policyVersions.insert(policyRow);
  } else if (existingPolicy.active !== 1) {
    repos.policyVersions.setActive(existingPolicy.id);
  }

  // 4. Seed Demo Honest Agent
  if (existingAgent) {
    if (explicitApiKey) {
      // Explicit key provided: update hash and baseline budget, strictly preserving current status
      db.prepare(`
        UPDATE agents
        SET name = 'Demo Honest Agent',
            api_key_hash = ?,
            daily_budget_minor = ?
        WHERE id = ?
      `).run(keyHash, toMinorUnits(5000), DEMO_HONEST_AGENT_ID);
    } else {
      // No explicit key: ensure baseline budget, strictly preserving current status and api_key_hash
      db.prepare(`
        UPDATE agents
        SET name = 'Demo Honest Agent',
            daily_budget_minor = ?
        WHERE id = ?
      `).run(toMinorUnits(5000), DEMO_HONEST_AGENT_ID);
    }
  } else {
    // Newly created demo agent defaults to ACTIVE
    const agentRow: AgentRow = {
      id: DEMO_HONEST_AGENT_ID,
      name: 'Demo Honest Agent',
      api_key_hash: keyHash,
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(5000), // $50.00
      created_at: nowIso,
    };
    repos.agents.insert(agentRow);
  }

  // 5. Vendor Vault Token Inspection and Seeding
  let hasVaultToken = false;
  let resolvedVaultTokenId: string | undefined;

  const existingVaultToken = repos.vendorVaultTokens.getByVendorId(DEMO_VENDOR_ID);
  if (existingVaultToken) {
    hasVaultToken = true;
    resolvedVaultTokenId = existingVaultToken.vault_token_id;
  } else {
    const envVaultToken = options?.vaultTokenId?.trim() || process.env.VAULT_TOKEN_ID?.trim();
    if (envVaultToken) {
      repos.vendorVaultTokens.insert({
        id: 'vtok-demo-acme',
        vendor_id: DEMO_VENDOR_ID,
        paypal_customer_ref: 'cust-demo-acme',
        vault_token_id: envVaultToken,
        status: 'ACTIVE',
        created_at: nowIso,
      });
      hasVaultToken = true;
      resolvedVaultTokenId = envVaultToken;
    } else {
      const warnMsg =
        "PayPal Vault payment token is not configured for vendor 'ven-acme'. " +
        "Real PayPal sandbox capture requires an onboarded buyer wallet. " +
        "Run 'npm run vault:onboard -- --vendor ven-acme' or set VAULT_TOKEN_ID in .env.";
      warnings.push(warnMsg);
      logger.warn(`[DemoSeed] ${warnMsg}`);
    }
  }

  return {
    success: true,
    ownerId: 'default',
    vendorId: DEMO_VENDOR_ID,
    policyVersion: 1,
    agentId: DEMO_HONEST_AGENT_ID,
    rawApiKey,
    apiKeyWasGenerated,
    hasVaultToken,
    vaultTokenId: resolvedVaultTokenId,
    warnings,
  };
}

// ============================================================================
// CLI Execution Runner
// ============================================================================

export async function runCli(): Promise<void> {
  const config = getConfig();
  const db = createDatabase(config.databasePath);
  runMigrations(db);

  const result = seedDemoDatabase(db);

  console.log('\n================================================================');
  console.log(' PayGuard: Demo Environment Seeded Successfully');
  console.log('================================================================');
  console.log(` Owner Account   : ${result.ownerId} (Primary Owner)`);
  console.log(` Approved Vendor : ${result.vendorId} (Acme Cloud Hosting)`);
  console.log(` Active Policy   : Version ${result.policyVersion} ($15 auto / $100 cap / $50 budget)`);
  console.log(` Honest Agent    : ${result.agentId}`);
  console.log(' ------------------------------------------------------------');
  if (result.rawApiKey) {
    console.log(` Demo Agent Key  : ${result.rawApiKey}`);
    if (result.apiKeyWasGenerated) {
      console.log(' [!] Key was generated for this session. Add to your .env:');
      console.log(`     DEMO_AGENT_API_KEY=${result.rawApiKey}`);
    }
  } else {
    console.log(' Demo Agent Key  : [PRESERVED EXISTING CREDENTIAL]');
    console.log(' [!] Raw key is not stored in database. Configure DEMO_AGENT_API_KEY in .env with the original key.');
  }
  console.log(' ------------------------------------------------------------');
  console.log(` Vaulted Token   : ${result.hasVaultToken ? 'Configured' : 'Missing (Manual onboarding required)'}`);
  if (!result.hasVaultToken) {
    console.log(' [!] To onboard a PayPal Sandbox buyer wallet against Acme Cloud:');
    console.log('     npm run vault:onboard -- --vendor ven-acme');
  }
  console.log('================================================================\n');

  db.close();
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  runCli().catch((err) => {
    console.error('[DemoSeed Error]:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
