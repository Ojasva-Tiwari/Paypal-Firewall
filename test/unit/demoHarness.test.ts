/**
 * PayGuard — Milestone M3: MCP Integration
 * Unit & Integration Tests: M3-T6 (Demo Harness) & M3-T7 (Honest Agent)
 *
 * Tests:
 * 1. seedDemoDatabase:
 *    - Seeds deterministic owner, vendor, policy v1, and honest agent
 *    - Is idempotent and safe to rerun repeatedly
 *    - Generates 32-byte crypto key when not supplied; hashes it in database
 *    - Uses supplied API key or env key
 *    - Inspects vault token and warns without fabricating fake credentials
 * 2. resetDemoDatabase:
 *    - Atomically clears payment_requests, ledger, approvals, and ai_runs
 *    - Strictly preserves owners, agents, vendors, vault tokens, and policy versions
 *    - Preserves audit_log (never deletes) and appends a hash-chained demo_state_reset entry
 *    - Is idempotent on empty or already-cleared database
 * 3. runHonestAgent:
 *    - Connects through Streamable HTTP transport with Bearer token
 *    - Discovers 4 canonical tools (Invariant I1)
 *    - Queries budget and lists vendors
 *    - Requests $12.00 commercial payment to 'ven-acme'
 *    - Verifies policy returns ALLOW
 *    - Confirms CAPTURED status when PayPal Orders service succeeds
 *    - Inquires and verifies status via get_payment_status
 *    - Fails gracefully without fabricating capture when PayPal service is missing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { hashApiKey } from '../../src/mcp/auth.js';
import { hashOwnerPassphrase } from '../../src/auth/owner.js';
import { toMinorUnits } from '../../src/core/money.js';
import type { PayPalOrdersService, PayPalOrderResult } from '../../src/paypal/orders.js';
import {
  seedDemoDatabase,
  DEMO_HONEST_AGENT_ID,
  DEMO_VENDOR_ID,
  DEMO_POLICY_VERSION_ID,
} from '../../demo/seed.js';
import { resetDemoDatabase } from '../../demo/reset.js';
import { runHonestAgent } from '../../demo/honestAgent.js';

describe('M3 Batch 3: Demo Harness (M3-T6) & Scripted Honest Agent (M3-T7)', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================================
  // 1. M3-T6: Demo Seeding Tests
  // ============================================================================

  describe('M3-T6: seedDemoDatabase', () => {
    it('first-time seed generates a usable 32-byte key, hashes it, and returns it once', () => {
      const result = seedDemoDatabase(db, { repos });

      expect(result.success).toBe(true);
      expect(result.ownerId).toBe('default');
      expect(result.vendorId).toBe(DEMO_VENDOR_ID);
      expect(result.agentId).toBe(DEMO_HONEST_AGENT_ID);
      expect(result.policyVersion).toBe(1);
      expect(result.apiKeyWasGenerated).toBe(true);
      expect(result.rawApiKey).toHaveLength(64); // 32-byte hex

      // Verify Owner in database
      const owner = repos.owners.get();
      expect(owner).toBeDefined();
      expect(owner?.id).toBe('default');
      expect(owner?.display_name).toBe('Primary Owner');

      // Verify Vendor in database
      const vendor = repos.vendors.getById(DEMO_VENDOR_ID);
      expect(vendor).toBeDefined();
      expect(vendor?.name).toBe('Acme Cloud Hosting');
      expect(vendor?.status).toBe('ACTIVE');
      expect(vendor?.connector_key).toBe('acme_cloud');

      // Verify Policy Version in database
      const policy = repos.policyVersions.getByVersion(1);
      expect(policy).toBeDefined();
      expect(policy?.id).toBe(DEMO_POLICY_VERSION_ID);
      expect(policy?.active).toBe(1);

      // Verify Agent in database
      const agent = repos.agents.getById(DEMO_HONEST_AGENT_ID);
      expect(agent).toBeDefined();
      expect(agent?.status).toBe('ACTIVE');
      expect(agent?.daily_budget_minor).toBe(toMinorUnits(5000));
      expect(agent?.api_key_hash).toBe(hashApiKey(result.rawApiKey));
    });

    it('repeated seed without an API key preserves the existing hash and warns without generating a replacement', () => {
      // 1. Initial seed generates key 1
      const res1 = seedDemoDatabase(db, { repos });
      expect(res1.apiKeyWasGenerated).toBe(true);
      const agent1 = repos.agents.getById(DEMO_HONEST_AGENT_ID);
      const originalHash = agent1?.api_key_hash;
      expect(originalHash).toBeDefined();

      // 2. Second seed without DEMO_AGENT_API_KEY
      const warnLogs: string[] = [];
      const res2 = seedDemoDatabase(db, {
        repos,
        logger: {
          log: () => {},
          warn: (m) => warnLogs.push(m),
          error: () => {},
        },
      });

      expect(res2.success).toBe(true);
      expect(res2.apiKeyWasGenerated).toBe(false);
      expect(res2.rawApiKey).toBe(''); // Not re-generated or fabricated

      // Verify hash is strictly preserved (NOT silently rotated)
      const agent2 = repos.agents.getById(DEMO_HONEST_AGENT_ID);
      expect(agent2?.api_key_hash).toBe(originalHash);

      // Verify operator warning is emitted
      expect(warnLogs.some((m) => m.includes("Existing demo agent 'agent-demo-honest' credentials preserved"))).toBe(true);
      expect(res2.warnings.some((w) => w.includes('credentials preserved without rotation'))).toBe(true);
    });

    it('explicit API key updates the hash (intended rotation)', () => {
      // 1. Initial seed with auto-generated key
      const res1 = seedDemoDatabase(db, { repos });
      expect(res1.apiKeyWasGenerated).toBe(true);
      const initialHash = repos.agents.getById(DEMO_HONEST_AGENT_ID)?.api_key_hash;

      // 2. Second seed with explicitly provided rotation key
      const explicitKey = '9999999999abcdef9999999999abcdef9999999999abcdef9999999999abcdef';
      const res2 = seedDemoDatabase(db, { repos, apiKey: explicitKey });

      expect(res2.success).toBe(true);
      expect(res2.apiKeyWasGenerated).toBe(false);
      expect(res2.rawApiKey).toBe(explicitKey);

      // Verify hash was updated to match the new explicit key
      const agent2 = repos.agents.getById(DEMO_HONEST_AGENT_ID);
      expect(agent2?.api_key_hash).toBe(hashApiKey(explicitKey));
      expect(agent2?.api_key_hash).not.toBe(initialHash);
    });

    it('re-seeding a suspended agent keeps it suspended without silent reactivation', () => {
      // 1. Initial seed: agent is created with default status ACTIVE
      seedDemoDatabase(db, { repos });
      const initialAgent = repos.agents.getById(DEMO_HONEST_AGENT_ID);
      expect(initialAgent?.status).toBe('ACTIVE');

      // 2. Deliberately suspend the agent (e.g. by owner or security policy)
      repos.agents.updateStatus(DEMO_HONEST_AGENT_ID, 'SUSPENDED');
      expect(repos.agents.getById(DEMO_HONEST_AGENT_ID)?.status).toBe('SUSPENDED');

      // 3. Repeated seed without an API key
      const res = seedDemoDatabase(db, { repos });
      expect(res.success).toBe(true);

      // Verify agent remains SUSPENDED (NOT silently reactivated to ACTIVE)
      const agentAfterSeed = repos.agents.getById(DEMO_HONEST_AGENT_ID);
      expect(agentAfterSeed?.status).toBe('SUSPENDED');
    });

    it('explicit key rotation does not implicitly reactivate a suspended agent', () => {
      // 1. Initial seed
      seedDemoDatabase(db, { repos });

      // 2. Suspend agent
      repos.agents.updateStatus(DEMO_HONEST_AGENT_ID, 'SUSPENDED');
      expect(repos.agents.getById(DEMO_HONEST_AGENT_ID)?.status).toBe('SUSPENDED');

      // 3. Re-seed with explicit rotation key
      const rotationKey = '8888888888abcdef8888888888abcdef8888888888abcdef8888888888abcdef';
      const res = seedDemoDatabase(db, { repos, apiKey: rotationKey });
      expect(res.success).toBe(true);

      // Verify key hash was updated
      const agentAfterRotation = repos.agents.getById(DEMO_HONEST_AGENT_ID);
      expect(agentAfterRotation?.api_key_hash).toBe(hashApiKey(rotationKey));

      // Verify agent status remains SUSPENDED
      expect(agentAfterRotation?.status).toBe('SUSPENDED');
    });

    it('existing vault tokens remain unchanged on repeated seeding', () => {
      // 1. Initial seed with vault token
      const res1 = seedDemoDatabase(db, {
        repos,
        vaultTokenId: 'vault-original-tok-111',
      });
      expect(res1.hasVaultToken).toBe(true);
      expect(res1.vaultTokenId).toBe('vault-original-tok-111');

      // Verify row in database
      const row1 = repos.vendorVaultTokens.getByVendorId(DEMO_VENDOR_ID);
      expect(row1?.vault_token_id).toBe('vault-original-tok-111');

      // 2. Second seed with different or absent vault token: original must remain untouched
      const res2 = seedDemoDatabase(db, {
        repos,
        vaultTokenId: 'vault-attempted-overwrite-222',
      });

      expect(res2.hasVaultToken).toBe(true);
      expect(res2.vaultTokenId).toBe('vault-original-tok-111');

      const row2 = repos.vendorVaultTokens.getByVendorId(DEMO_VENDOR_ID);
      expect(row2?.vault_token_id).toBe('vault-original-tok-111');

      // Confirm no duplicate rows created
      const allTokens = db.prepare('SELECT * FROM vendor_vault_tokens WHERE vendor_id = ?').all(DEMO_VENDOR_ID);
      expect(allTokens).toHaveLength(1);
    });

    it('seeds vault token when explicitly provided and does not fabricate when missing', () => {
      // Run with missing vault token
      const warnLogs: string[] = [];
      const resWithout = seedDemoDatabase(db, {
        repos,
        logger: {
          log: () => {},
          warn: (m) => warnLogs.push(m),
          error: () => {},
        },
      });

      expect(resWithout.hasVaultToken).toBe(false);
      expect(resWithout.warnings.length).toBeGreaterThan(0);
      expect(warnLogs.some((m) => m.includes('PayPal Vault payment token is not configured'))).toBe(true);

      // Now run with explicitly supplied vault token
      const resWith = seedDemoDatabase(db, {
        repos,
        vaultTokenId: 'vault-sandbox-tok-12345',
      });

      expect(resWith.hasVaultToken).toBe(true);
      expect(resWith.vaultTokenId).toBe('vault-sandbox-tok-12345');

      const tokenRow = repos.vendorVaultTokens.getByVendorId(DEMO_VENDOR_ID);
      expect(tokenRow).toBeDefined();
      expect(tokenRow?.vault_token_id).toBe('vault-sandbox-tok-12345');
    });

    it('first-time seeding creates the owner with default configuration', () => {
      // 1. Fresh database without an owner
      expect(repos.owners.get()).toBeUndefined();

      // 2. Initial seed
      const res = seedDemoDatabase(db, { repos });
      expect(res.success).toBe(true);

      // 3. Verify owner row in database
      const owner = repos.owners.get();
      expect(owner).toBeDefined();
      expect(owner?.id).toBe('default');
      expect(owner?.display_name).toBe('Primary Owner');
      const expectedDefaultHash = crypto
        .createHash('sha256')
        .update('payguard-demo-passphrase', 'utf8')
        .digest('hex');
      expect(owner?.passphrase_hash).toBe(expectedDefaultHash);
      expect(owner?.telegram_chat_id).toBeNull();
    });

    it('repeated seeding preserves an existing Argon2id hash', async () => {
      // 1. Set up owner with an Argon2id hash
      const argon2Hash = await hashOwnerPassphrase('upgraded-argon2-owner-passphrase');
      repos.owners.upsert({
        display_name: 'Primary Owner',
        passphrase_hash: argon2Hash,
        telegram_chat_id: null,
        created_at: new Date().toISOString(),
      });

      // 2. Run demo seeding
      const res = seedDemoDatabase(db, { repos });
      expect(res.success).toBe(true);

      // 3. Verify Argon2id hash is preserved and NOT overwritten by the demo default
      const ownerAfter = repos.owners.get();
      expect(ownerAfter?.passphrase_hash).toBe(argon2Hash);
      expect(ownerAfter?.passphrase_hash.startsWith('$argon2id$')).toBe(true);
    });

    it('repeated seeding preserves an existing legacy hash until successful login migration', () => {
      // 1. Set up owner with a custom legacy SHA-256 hash
      const customLegacyHash = crypto
        .createHash('sha256')
        .update('legacy-owner-custom-secret', 'utf8')
        .digest('hex');
      repos.owners.upsert({
        display_name: 'Primary Owner',
        passphrase_hash: customLegacyHash,
        telegram_chat_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
      });

      // 2. Run demo seeding
      const res = seedDemoDatabase(db, { repos });
      expect(res.success).toBe(true);

      // 3. Verify custom legacy hash is preserved (re-seeding does not overwrite with demo default)
      const ownerAfter = repos.owners.get();
      expect(ownerAfter?.passphrase_hash).toBe(customLegacyHash);
    });

    it('changing OWNER_PASSPHRASE_HASH in the environment does not overwrite an existing owner hash', () => {
      // 1. Initial seed provisions owner
      seedDemoDatabase(db, { repos });
      const initialHash = repos.owners.get()?.passphrase_hash;
      expect(initialHash).toBeDefined();

      // 2. Change OWNER_PASSPHRASE_HASH in environment
      const originalEnv = process.env.OWNER_PASSPHRASE_HASH;
      try {
        process.env.OWNER_PASSPHRASE_HASH = 'attacker-or-different-env-hash-value-12345';
        const res = seedDemoDatabase(db, { repos });
        expect(res.success).toBe(true);

        // 3. Verify existing owner's hash remains unchanged
        const ownerAfter = repos.owners.get();
        expect(ownerAfter?.passphrase_hash).toBe(initialHash);
        expect(ownerAfter?.passphrase_hash).not.toBe('attacker-or-different-env-hash-value-12345');
      } finally {
        if (originalEnv !== undefined) {
          process.env.OWNER_PASSPHRASE_HASH = originalEnv;
        } else {
          delete process.env.OWNER_PASSPHRASE_HASH;
        }
      }
    });

    it('existing owner credentials remain unchanged after repeated demo seeding', async () => {
      // 1. Set up an existing owner with customized credentials
      const customCreatedAt = '2026-06-01T12:00:00.000Z';
      const customArgon2Hash = await hashOwnerPassphrase('custom-production-passphrase');
      repos.owners.upsert({
        display_name: 'Custom Admin Owner',
        passphrase_hash: customArgon2Hash,
        telegram_chat_id: 'chat-987654321',
        created_at: customCreatedAt,
      });

      // 2. Set conflicting environment variables that default seeding would normally use
      const originalTelegram = process.env.TELEGRAM_OWNER_CHAT_ID;
      const originalPassHash = process.env.OWNER_PASSPHRASE_HASH;
      try {
        process.env.TELEGRAM_OWNER_CHAT_ID = 'conflicting-chat-id-999';
        process.env.OWNER_PASSPHRASE_HASH = 'conflicting-hash-999';

        const res = seedDemoDatabase(db, { repos });
        expect(res.success).toBe(true);

        // 3. Verify all existing owner fields remain strictly unchanged
        const ownerAfter = repos.owners.get();
        expect(ownerAfter?.display_name).toBe('Custom Admin Owner');
        expect(ownerAfter?.passphrase_hash).toBe(customArgon2Hash);
        expect(ownerAfter?.telegram_chat_id).toBe('chat-987654321');
        expect(ownerAfter?.created_at).toBe(customCreatedAt);
      } finally {
        if (originalTelegram !== undefined) {
          process.env.TELEGRAM_OWNER_CHAT_ID = originalTelegram;
        } else {
          delete process.env.TELEGRAM_OWNER_CHAT_ID;
        }
        if (originalPassHash !== undefined) {
          process.env.OWNER_PASSPHRASE_HASH = originalPassHash;
        } else {
          delete process.env.OWNER_PASSPHRASE_HASH;
        }
      }
    });
  });

  // ============================================================================
  // 2. M3-T6: Demo Reset Tests
  // ============================================================================

  describe('M3-T6: resetDemoDatabase', () => {
    it('clears payment requests, ledger, approvals, and ai runs while strictly preserving configuration', () => {
      // 1. Seed base configuration
      seedDemoDatabase(db, { repos });

      // 2. Insert dummy runtime data
      const nowIso = new Date().toISOString();
      const reqId = 'req-dummy-1';
      repos.paymentRequests.insert({
        id: reqId,
        agent_id: DEMO_HONEST_AGENT_ID,
        idempotency_key: 'idem-1',
        vendor_id: DEMO_VENDOR_ID,
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        purpose: 'Test request',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: JSON.stringify([]),
        policy_version_id: DEMO_POLICY_VERSION_ID,
        snapshot_hash: null,
        paypal_order_id: 'ord-1',
        paypal_authorization_id: null,
        paypal_capture_id: 'cap-1',
        expires_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      });

      repos.ledger.insert({
        id: 'led-1',
        request_id: reqId,
        kind: 'SPEND',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        created_at: nowIso,
      });

      repos.approvals.insert({
        id: 'app-1',
        request_id: reqId,
        token_hash: crypto.createHash('sha256').update('tok-1').digest('hex'),
        action: 'APPROVE',
        expires_at: nowIso,
        used_at: null,
        channel: 'web',
        created_at: nowIso,
      });

      db.prepare(`
        INSERT INTO ai_runs (id, kind, request_id, model, input_hash, output, latency_ms, status, created_at)
        VALUES ('airun-1', 'risk_inspection', ?, 'gemini-1.5', 'hash1', 'SAFE', 150, 'SUCCESS', ?)
      `).run(reqId, nowIso);

      // Verify records exist before reset
      expect(repos.paymentRequests.getById(reqId)).toBeDefined();
      expect(repos.ledger.listByRequestId(reqId)).toHaveLength(1);

      // 3. Execute reset
      const resetResult = resetDemoDatabase(db, { repos });

      expect(resetResult.success).toBe(true);
      expect(resetResult.deletedPaymentRequests).toBe(1);
      expect(resetResult.deletedLedgerRows).toBe(1);
      expect(resetResult.deletedApprovalRows).toBe(1);
      expect(resetResult.deletedAiRunRows).toBe(1);

      // 4. Verify transaction state is cleared
      expect(repos.paymentRequests.getById(reqId)).toBeUndefined();
      expect(repos.ledger.listByRequestId(reqId)).toHaveLength(0);

      // 5. Verify configuration is preserved
      expect(repos.owners.get()).toBeDefined();
      expect(repos.vendors.getById(DEMO_VENDOR_ID)).toBeDefined();
      expect(repos.agents.getById(DEMO_HONEST_AGENT_ID)).toBeDefined();
      expect(repos.policyVersions.getByVersion(1)).toBeDefined();

      // 6. Verify audit_log is preserved and reset event was appended
      const auditEntries = db.prepare('SELECT * FROM audit_log ORDER BY ts DESC').all() as Array<{
        event: string;
        actor: string;
      }>;
      expect(auditEntries.length).toBeGreaterThan(0);
      expect(auditEntries[0]?.event).toBe('demo_state_reset');
      expect(auditEntries[0]?.actor).toBe('system');
    });

    it('is idempotent on an empty or already-reset database', () => {
      seedDemoDatabase(db, { repos });

      const res1 = resetDemoDatabase(db, { repos });
      expect(res1.success).toBe(true);
      expect(res1.deletedPaymentRequests).toBe(0);

      const res2 = resetDemoDatabase(db, { repos });
      expect(res2.success).toBe(true);
      expect(res2.deletedPaymentRequests).toBe(0);
    });
  });

  // ============================================================================
  // 3. M3-T7: Scripted Honest Agent Integration Tests
  // ============================================================================

  describe('M3-T7: runHonestAgent', () => {
    it('executes end-to-end commercial flow reaching CAPTURED when PayPal orders service succeeds', async () => {
      // 1. Seed database with vault token
      const seed = seedDemoDatabase(db, {
        repos,
        vaultTokenId: 'vault-sandbox-tok-456',
      });

      // 2. Mock PayPal Orders Service
      const mockOrdersService = {
        createOrder: vi.fn().mockImplementation((params) =>
          Promise.resolve({
            id: 'ord-sandbox-1234',
            status: 'COMPLETED',
            intent: 'CAPTURE',
            isCaptured: true,
            isAuthorized: false,
            captureId: 'cap-sandbox-5678',
            capture: {
              id: 'cap-sandbox-5678',
              status: 'COMPLETED',
              amountMinor: params.amountMinor,
              currency: params.currency,
            },
            rawResponse: {},
          } as unknown as PayPalOrderResult)
        ),
        getOrder: vi.fn(),
      } as unknown as PayPalOrdersService;

      // Silence stdout during test run
      const logs: string[] = [];
      const testLogger = {
        log: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
      };

      // 3. Run Honest Agent
      const result = await runHonestAgent({
        db,
        repos,
        rawApiKey: seed.rawApiKey,
        ordersService: mockOrdersService,
        defaultVaultTokenId: 'vault-sandbox-tok-456',
        logger: testLogger,
      });

      expect(result.success).toBe(true);
      expect(result.toolsDiscovered).toEqual(
        expect.arrayContaining(['request_payment', 'get_payment_status', 'get_budget', 'list_vendors'])
      );
      expect(result.initialBudget.remainingBudget).toBe('50.00');
      expect(result.initialBudget.currency).toBe('USD');
      expect(result.vendorVerified).toBe(true);
      expect(result.policyDecision).toBe('ALLOW');
      expect(result.executionStatus).toBe('CAPTURED');
      expect(result.isCaptured).toBe(true);
      expect(result.hasSandboxExecution).toBe(true);
      expect(result.statusVerified).toBe(true);

      // Verify PayPal createOrder was called with correct parameters
      expect(mockOrdersService.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          amountMinor: toMinorUnits(1200),
          currency: 'USD',
          intent: 'CAPTURE',
          vaultTokenId: 'vault-sandbox-tok-456',
        })
      );

      // Verify database record has SPEND row in ledger
      const ledgerRows = repos.ledger.listByRequestId(result.paymentRequestId);
      expect(ledgerRows.some((l) => l.kind === 'SPEND' && l.amount_minor === toMinorUnits(1200))).toBe(true);
    });

    it('safely completes policy evaluation as ALLOW without claiming capture when PayPal service is unconfigured', async () => {
      const seed = seedDemoDatabase(db, { repos });

      const logs: string[] = [];
      const testLogger = {
        log: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
        error: (m: string) => logs.push(m),
      };

      const result = await runHonestAgent({
        db,
        repos,
        rawApiKey: seed.rawApiKey,
        logger: testLogger,
      });

      expect(result.success).toBe(true);
      expect(result.policyDecision).toBe('ALLOW');
      expect(result.isCaptured).toBe(false);
      expect(result.hasSandboxExecution).toBe(false);
      expect(result.statusVerified).toBe(true);

      // Check log contains guidance on PayPal sandbox onboarding
      expect(logs.some((l) => l.includes('vault:onboard'))).toBe(true);
    });
  });
});
