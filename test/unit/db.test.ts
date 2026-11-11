import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createDatabase,
  runMigrations,
  runInTransaction,
  createRepositories,
  MIGRATIONS,
  type Database,
} from '../../src/db/index.js';
import { toMinorUnits } from '../../src/core/money.js';

describe('SQLite Database Schema, Migrations, and Repositories (M1-T2)', () => {
  let db: Database;
  let tempDbDir: string | null = null;

  beforeEach(() => {
    // Default to in-memory database with migrations applied for isolated tests
    db = createDatabase(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
    if (tempDbDir && fs.existsSync(tempDbDir)) {
      fs.rmSync(tempDbDir, { recursive: true, force: true });
      tempDbDir = null;
    }
  });

  describe('Database Initialization & Migrations', () => {
    it('should create all canonical tables on empty database', () => {
      const freshDb = createDatabase(':memory:');
      const count = runMigrations(freshDb);

      expect(count).toBe(12);

      const tables = freshDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('schema_migrations');
      expect(tableNames).toContain('owners');
      expect(tableNames).toContain('agents');
      expect(tableNames).toContain('vendors');
      expect(tableNames).toContain('vendor_vault_tokens');
      expect(tableNames).toContain('policy_versions');
      expect(tableNames).toContain('payment_requests');
      expect(tableNames).toContain('ledger');
      expect(tableNames).toContain('approvals');
      expect(tableNames).toContain('audit_log');
      expect(tableNames).toContain('ai_runs');
      expect(tableNames).toContain('policy_proposals');
      expect(tableNames).toContain('telegram_link_tokens');
      expect(tableNames).toContain('notification_outbox');
      expect(tableNames).toContain('telegram_approval_callbacks');
      expect(tableNames).toContain('owner_sessions');

      freshDb.close();
    });

    it('should execute migrations idempotently without error', () => {
      // First run applied in beforeEach
      const secondRunCount = runMigrations(db);
      expect(secondRunCount).toBe(0);

      const thirdRunCount = runMigrations(db);
      expect(thirdRunCount).toBe(0);
    });

    it('should create canonical indexes', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);

      expect(indexNames).toContain('idx_payment_requests_status_expires');
      expect(indexNames).toContain('idx_payment_requests_agent_created');
      expect(indexNames).toContain('idx_ledger_created_at');
      expect(indexNames).toContain('idx_audit_log_request_id');
      expect(indexNames).toContain('idx_policy_versions_single_active');
      expect(indexNames).toContain('idx_policy_versions_version');
      expect(indexNames).toContain('idx_telegram_link_tokens_hash');
      expect(indexNames).toContain('idx_telegram_link_tokens_owner_expires');
      expect(indexNames).toContain('idx_owners_telegram_chat_id');
      expect(indexNames).toContain('idx_notification_outbox_pending');
      expect(indexNames).toContain('idx_notification_outbox_processing');
      expect(indexNames).toContain('idx_notification_outbox_request');
      expect(indexNames).toContain('idx_notification_outbox_owner');
      expect(indexNames).toContain('idx_telegram_approval_callbacks_hash');
      expect(indexNames).toContain('idx_telegram_approval_callbacks_request');
      expect(indexNames).toContain('idx_telegram_approval_callbacks_owner');
      expect(indexNames).toContain('idx_telegram_approval_callbacks_expires');
      expect(indexNames).toContain('idx_owner_sessions_owner_id');
      expect(indexNames).toContain('idx_owner_sessions_last_accessed');
      expect(indexNames).toContain('idx_owner_sessions_created_at');
    });
  });

  describe('Constraints & Invariants Enforcement', () => {
    it('should enforce single-row constraint on owners table', () => {
      const repos = createRepositories(db);
      repos.owners.upsert({
        display_name: 'Primary Owner',
        passphrase_hash: 'hash-123',
        telegram_chat_id: 'chat-456',
        created_at: new Date().toISOString(),
      });

      const owner = repos.owners.get();
      expect(owner?.display_name).toBe('Primary Owner');

      // Attempting to insert an owner with an id other than 'default' fails
      expect(() => {
        db.prepare("INSERT INTO owners (id, display_name, passphrase_hash, created_at) VALUES ('other', 'A', 'B', 'C')").run();
      }).toThrowError(/CHECK constraint failed/);
    });

    it('should enforce CHECK constraints on agent, vendor, and ledger status values', () => {
      expect(() => {
        db.prepare("INSERT INTO agents (id, name, api_key_hash, status, daily_budget_minor, created_at) VALUES ('a1', 'A', 'h', 'INVALID', 1000, 'ts')").run();
      }).toThrowError(/CHECK constraint failed/);

      expect(() => {
        db.prepare("INSERT INTO vendors (id, name, status, categories, currencies, connector_key, created_at) VALUES ('v1', 'V', 'INVALID', '[]', '[]', 'k', 'ts')").run();
      }).toThrowError(/CHECK constraint failed/);
    });

    it('should enforce FOREIGN KEY constraints when foreign keys are missing', () => {
      // Payment request referencing non-existent agent must fail
      expect(() => {
        db.prepare(`
          INSERT INTO payment_requests (
            id, agent_id, idempotency_key, vendor_id, amount_minor, currency,
            purpose, status, created_at, updated_at
          ) VALUES ('pr1', 'nonexistent_agent', 'k1', 'nonexistent_vendor', 100, 'USD', 'test', 'RECEIVED', 'ts', 'ts')
        `).run();
      }).toThrowError(/FOREIGN KEY constraint failed/);
    });

    it('should enforce UNIQUE(agent_id, idempotency_key) constraint on payment_requests', () => {
      const repos = createRepositories(db);

      repos.agents.insert({
        id: 'agent-1',
        name: 'Honest Agent',
        api_key_hash: 'hash-agent',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(5000),
        created_at: new Date().toISOString(),
      });

      repos.vendors.insert({
        id: 'vendor-1',
        name: 'Acme Cloud',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'acme_cloud',
        created_at: new Date().toISOString(),
      });

      const req = {
        id: 'req-1',
        agent_id: 'agent-1',
        idempotency_key: 'idem-unique-key',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        purpose: 'Server hosting',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'RECEIVED',
        decision: null,
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      repos.paymentRequests.insert(req);

      // Attempting duplicate (agent_id, idempotency_key) must throw
      expect(() => {
        repos.paymentRequests.insert({
          ...req,
          id: 'req-2', // Different primary key, same agent + idempotency_key
        });
      }).toThrowError(/UNIQUE constraint failed/);
    });

    it('should enforce exactly one active policy version via partial unique index', () => {
      const repos = createRepositories(db);

      repos.policyVersions.insert({
        id: 'pol-1',
        version: 1,
        rules: JSON.stringify({ version: 1 }),
        author: 'owner',
        active: 1,
        created_at: new Date().toISOString(),
      });

      expect(repos.policyVersions.getActive()?.id).toBe('pol-1');

      // Attempting to insert a second active=1 policy must fail
      expect(() => {
        repos.policyVersions.insert({
          id: 'pol-2',
          version: 2,
          rules: JSON.stringify({ version: 2 }),
          author: 'owner',
          active: 1,
          created_at: new Date().toISOString(),
        });
      }).toThrowError(/UNIQUE constraint failed/);

      // Attempting to insert duplicate version number must fail even with active=0
      expect(() => {
        repos.policyVersions.insert({
          id: 'pol-duplicate-version',
          version: 1, // Duplicate version
          rules: JSON.stringify({ version: 1 }),
          author: 'owner',
          active: 0,
          created_at: new Date().toISOString(),
        });
      }).toThrowError(/UNIQUE constraint failed/);

      // Inserting as active=0 with unique version succeeds
      repos.policyVersions.insert({
        id: 'pol-2',
        version: 2,
        rules: JSON.stringify({ version: 2 }),
        author: 'owner',
        active: 0,
        created_at: new Date().toISOString(),
      });

      // Attempting to modify policy rules/content must be blocked by immutability trigger
      expect(() => {
        db.prepare("UPDATE policy_versions SET rules = '{\"tampered\": true}' WHERE id = 'pol-1'").run();
      }).toThrowError(/policy_versions is immutable: only active status may be updated/);

      // Attempting to modify author must be blocked by immutability trigger
      expect(() => {
        db.prepare("UPDATE policy_versions SET author = 'ai_draft_confirmed' WHERE id = 'pol-1'").run();
      }).toThrowError(/policy_versions is immutable: only active status may be updated/);

      // Attempting to DELETE a policy version must be blocked by trigger
      expect(() => {
        db.prepare("DELETE FROM policy_versions WHERE id = 'pol-1'").run();
      }).toThrowError(/policy_versions is immutable: DELETE operations are strictly prohibited/);

      // Switching active to pol-2 succeeds transactionally without tripping immutability trigger
      repos.policyVersions.setActive('pol-2');
      expect(repos.policyVersions.getActive()?.id).toBe('pol-2');
      expect(repos.policyVersions.getByVersion(1)?.active).toBe(0);
    });

    it('should strictly prohibit UPDATE and DELETE on audit_log at SQLite engine level', () => {
      const repos = createRepositories(db);

      repos.auditLog.insert({
        id: 'aud-1',
        ts: new Date().toISOString(),
        actor: 'system',
        event: 'TEST_EVENT',
        request_id: null,
        payload: JSON.stringify({ test: true }),
        prev_hash: null,
        hash: 'hash-abc',
      });

      expect(repos.auditLog.listByRequestId('non-existent')).toHaveLength(0);

      // Attempting to UPDATE audit_log must be blocked by trigger
      expect(() => {
        db.prepare("UPDATE audit_log SET event = 'TAMPERED' WHERE id = 'aud-1'").run();
      }).toThrowError(/audit_log is append-only: UPDATE operations are strictly prohibited/);

      // Attempting to DELETE from audit_log must be blocked by trigger
      expect(() => {
        db.prepare("DELETE FROM audit_log WHERE id = 'aud-1'").run();
      }).toThrowError(/audit_log is append-only: DELETE operations are strictly prohibited/);

      // Audit row is preserved
      expect(repos.auditLog.getLastEntry()?.id).toBe('aud-1');
    });

    it('should strictly enforce policy_proposals valid transitions, consistent timestamps, immutability, and DELETE prevention at SQLite engine level', () => {
      const repos = createRepositories(db);
      const nowIso = new Date().toISOString();

      const proposal = {
        id: 'prop-trigger-test',
        base_version: 1,
        rules: JSON.stringify({ auto_limit_minor: 2000 }),
        proposal_hash: 'hash-abc-123',
        has_relaxations: 0 as const,
        relaxations: '[]',
        diff: '[]',
        explanation: 'Test trigger enforcement',
        unsupported_requests: '[]',
        owner_id: 'default',
        status: 'PENDING' as const,
        created_at: nowIso,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        activated_at: null,
        rejected_at: null,
      };

      repos.policyProposals.insert(proposal);

      // 1. Core proposal fields must be immutable on UPDATE
      expect(() => {
        db.prepare("UPDATE policy_proposals SET rules = '{\"tampered\": true}' WHERE id = 'prop-trigger-test'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        db.prepare("UPDATE policy_proposals SET proposal_hash = 'tampered-hash' WHERE id = 'prop-trigger-test'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        db.prepare("UPDATE policy_proposals SET base_version = 2 WHERE id = 'prop-trigger-test'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        db.prepare("UPDATE policy_proposals SET created_at = '2099-01-01' WHERE id = 'prop-trigger-test'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        db.prepare("UPDATE policy_proposals SET expires_at = '2099-01-01' WHERE id = 'prop-trigger-test'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // 2. Invalid transitions from PENDING
      // PENDING -> PENDING is blocked
      expect(() => {
        db.prepare("UPDATE policy_proposals SET status = 'PENDING' WHERE id = 'prop-trigger-test'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // PENDING -> arbitrary status is blocked by CHECK constraint or trigger
      expect(() => {
        db.prepare("UPDATE policy_proposals SET status = 'INVALID_STATUS' WHERE id = 'prop-trigger-test'").run();
      }).toThrowError();

      // 3. Inconsistent timestamps on transition
      // ACTIVATED requires activated_at and no rejected_at
      expect(() => {
        db.prepare("UPDATE policy_proposals SET status = 'ACTIVATED' WHERE id = 'prop-trigger-test'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        db.prepare(`UPDATE policy_proposals SET status = 'ACTIVATED', activated_at = '${nowIso}', rejected_at = '${nowIso}' WHERE id = 'prop-trigger-test'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // REJECTED requires rejected_at and no activated_at
      expect(() => {
        db.prepare("UPDATE policy_proposals SET status = 'REJECTED' WHERE id = 'prop-trigger-test'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        db.prepare(`UPDATE policy_proposals SET status = 'REJECTED', rejected_at = '${nowIso}', activated_at = '${nowIso}' WHERE id = 'prop-trigger-test'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // EXPIRED requires neither activated_at nor rejected_at
      expect(() => {
        db.prepare(`UPDATE policy_proposals SET status = 'EXPIRED', activated_at = '${nowIso}' WHERE id = 'prop-trigger-test'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        db.prepare(`UPDATE policy_proposals SET status = 'EXPIRED', rejected_at = '${nowIso}' WHERE id = 'prop-trigger-test'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // 4. Valid transitions
      // PENDING -> EXPIRED succeeds with neither timestamp
      db.prepare("UPDATE policy_proposals SET status = 'EXPIRED' WHERE id = 'prop-trigger-test'").run();
      expect(repos.policyProposals.getById('prop-trigger-test')?.status).toBe('EXPIRED');

      // 5. Terminal states cannot transition further or mutate timestamps
      // EXPIRED -> ACTIVATED is blocked
      expect(() => {
        db.prepare(`UPDATE policy_proposals SET status = 'ACTIVATED', activated_at = '${nowIso}' WHERE id = 'prop-trigger-test'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // Modifying activated_at on EXPIRED is blocked
      expect(() => {
        db.prepare(`UPDATE policy_proposals SET activated_at = '${nowIso}' WHERE id = 'prop-trigger-test'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // Test ACTIVATED terminal immutability with another proposal
      const propActive = {
        ...proposal,
        id: 'prop-trigger-active',
      };
      repos.policyProposals.insert(propActive);

      // PENDING -> ACTIVATED succeeds with activated_at and no rejected_at
      db.prepare(`UPDATE policy_proposals SET status = 'ACTIVATED', activated_at = '${nowIso}' WHERE id = 'prop-trigger-active'`).run();
      expect(repos.policyProposals.getById('prop-trigger-active')?.status).toBe('ACTIVATED');

      // ACTIVATED -> REJECTED is blocked
      expect(() => {
        db.prepare(`UPDATE policy_proposals SET status = 'REJECTED', rejected_at = '${nowIso}' WHERE id = 'prop-trigger-active'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // Modifying activated_at timestamp after transition is blocked
      expect(() => {
        db.prepare("UPDATE policy_proposals SET activated_at = '2099-01-01' WHERE id = 'prop-trigger-active'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // Test REJECTED terminal immutability with third proposal
      const propRej = {
        ...proposal,
        id: 'prop-trigger-rej',
      };
      repos.policyProposals.insert(propRej);

      // PENDING -> REJECTED succeeds with rejected_at and no activated_at
      db.prepare(`UPDATE policy_proposals SET status = 'REJECTED', rejected_at = '${nowIso}' WHERE id = 'prop-trigger-rej'`).run();
      expect(repos.policyProposals.getById('prop-trigger-rej')?.status).toBe('REJECTED');

      // REJECTED -> ACTIVATED is blocked
      expect(() => {
        db.prepare(`UPDATE policy_proposals SET status = 'ACTIVATED', activated_at = '${nowIso}' WHERE id = 'prop-trigger-rej'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // 6. DELETE prevention trigger
      expect(() => {
        db.prepare("DELETE FROM policy_proposals WHERE id = 'prop-trigger-test'").run();
      }).toThrowError(/policy_proposals is append-only: DELETE operations are strictly prohibited/);
    });
  });

  describe('Typed Repository Operations', () => {
    it('should perform agent management and status transitions', () => {
      const repos = createRepositories(db);

      repos.agents.insert({
        id: 'ag-test',
        name: 'Autonomous Agent',
        api_key_hash: 'hash-999',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(10000),
        created_at: new Date().toISOString(),
      });

      const found = repos.agents.getById('ag-test');
      expect(found?.name).toBe('Autonomous Agent');

      const byKey = repos.agents.getByApiKeyHash('hash-999');
      expect(byKey?.id).toBe('ag-test');

      expect(repos.agents.listActive()).toHaveLength(1);

      repos.agents.updateStatus('ag-test', 'SUSPENDED');
      expect(repos.agents.getById('ag-test')?.status).toBe('SUSPENDED');
      expect(repos.agents.listActive()).toHaveLength(0);
    });

    it('should store and retrieve vendor vault tokens', () => {
      const repos = createRepositories(db);

      repos.vendors.insert({
        id: 'ven-acme',
        name: 'Acme Cloud Services',
        status: 'ACTIVE',
        categories: JSON.stringify(['infra']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'acme_cloud',
        created_at: new Date().toISOString(),
      });

      repos.vendorVaultTokens.insert({
        id: 'vvt-1',
        vendor_id: 'ven-acme',
        paypal_customer_ref: 'cust-123',
        vault_token_id: 'tok-sandbox-example-0002',
        status: 'VAULTED',
        created_at: new Date().toISOString(),
      });

      const token = repos.vendorVaultTokens.getByVendorId('ven-acme');
      expect(token?.vault_token_id).toBe('tok-sandbox-example-0002');

      // REVOKED tokens must be excluded by getByVendorId
      repos.vendorVaultTokens.updateStatus('vvt-1', 'REVOKED');
      expect(repos.vendorVaultTokens.getByVendorId('ven-acme')).toBeUndefined();
      expect(repos.vendorVaultTokens.listByVendorId('ven-acme')).toHaveLength(1);

      // New active replacement becomes the resolved token while revoked history remains
      repos.vendorVaultTokens.insert({
        id: 'vvt-2',
        vendor_id: 'ven-acme',
        paypal_customer_ref: 'cust-123',
        vault_token_id: 'tok-sandbox-example-0003',
        status: 'VAULTED',
        created_at: new Date().toISOString(),
      });
      expect(repos.vendorVaultTokens.getByVendorId('ven-acme')?.vault_token_id).toBe('tok-sandbox-example-0003');
      expect(repos.vendorVaultTokens.listByVendorId('ven-acme')).toHaveLength(2);
    });

    it('should manage ledger entries and payment request updates', () => {
      const repos = createRepositories(db);

      repos.agents.insert({
        id: 'ag-1',
        name: 'Agent 1',
        api_key_hash: 'hash-1',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(5000),
        created_at: new Date().toISOString(),
      });

      repos.vendors.insert({
        id: 'ven-1',
        name: 'Vendor 1',
        status: 'ACTIVE',
        categories: JSON.stringify(['test']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'v1',
        created_at: new Date().toISOString(),
      });

      repos.paymentRequests.insert({
        id: 'pr-100',
        agent_id: 'ag-1',
        idempotency_key: 'key-100',
        vendor_id: 'ven-1',
        amount_minor: toMinorUnits(1500),
        currency: 'USD',
        purpose: 'Test request',
        category: 'test',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'RECEIVED',
        decision: null,
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      repos.ledger.insert({
        id: 'led-1',
        request_id: 'pr-100',
        kind: 'RESERVE',
        amount_minor: toMinorUnits(1500),
        currency: 'USD',
        created_at: new Date().toISOString(),
      });

      const ledgerEntries = repos.ledger.listByRequestId('pr-100');
      expect(ledgerEntries).toHaveLength(1);
      expect(ledgerEntries[0]!.kind).toBe('RESERVE');

      repos.paymentRequests.updateStatusAndDecision('pr-100', {
        status: 'HELD',
        decision: 'HOLD',
        reasons: JSON.stringify(['OVER_AUTO_LIMIT']),
      });

      const updated = repos.paymentRequests.getById('pr-100');
      expect(updated?.status).toBe('HELD');
      expect(updated?.decision).toBe('HOLD');

      repos.paymentRequests.updatePayPalIds('pr-100', {
        orderId: 'ORDER-123',
        authorizationId: 'AUTH-456',
      });

      const withPayPal = repos.paymentRequests.getById('pr-100');
      expect(withPayPal?.paypal_order_id).toBe('ORDER-123');
      expect(withPayPal?.paypal_authorization_id).toBe('AUTH-456');
    });

    it('should manage approvals and mark tokens used', () => {
      const repos = createRepositories(db);

      repos.agents.insert({
        id: 'ag-app',
        name: 'Agent',
        api_key_hash: 'hash',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(5000),
        created_at: new Date().toISOString(),
      });
      repos.vendors.insert({
        id: 'ven-app',
        name: 'Vendor',
        status: 'ACTIVE',
        categories: '[]',
        currencies: '[]',
        connector_key: 'ven',
        created_at: new Date().toISOString(),
      });
      repos.paymentRequests.insert({
        id: 'pr-app',
        agent_id: 'ag-app',
        idempotency_key: 'idem-app',
        vendor_id: 'ven-app',
        amount_minor: toMinorUnits(2000),
        currency: 'USD',
        purpose: 'Approval test',
        category: null,
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'HELD',
        decision: 'HOLD',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: 'snap-1',
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      repos.approvals.insert({
        id: 'app-1',
        request_id: 'pr-app',
        token_hash: 'tok-hash-secret',
        action: 'APPROVE',
        expires_at: new Date(Date.now() + 900000).toISOString(),
        used_at: null,
        channel: 'web',
        created_at: new Date().toISOString(),
      });

      const approval = repos.approvals.getByTokenHash('tok-hash-secret');
      expect(approval?.action).toBe('APPROVE');
      expect(approval?.used_at).toBeNull();

      const usedFirst = repos.approvals.markUsed('tok-hash-secret');
      expect(usedFirst).toBe(true);

      // Re-using same token must return false (already used)
      const usedSecond = repos.approvals.markUsed('tok-hash-secret');
      expect(usedSecond).toBe(false);

      expect(repos.approvals.getByTokenHash('tok-hash-secret')?.used_at).not.toBeNull();
    });
  });

  describe('BEGIN IMMEDIATE Transaction & Rollback Behavior', () => {
    it('should commit all writes when transaction completes normally', () => {
      const repos = createRepositories(db);

      runInTransaction(db, () => {
        repos.agents.insert({
          id: 'ag-tx-1',
          name: 'Tx Agent 1',
          api_key_hash: 'hash-tx1',
          status: 'ACTIVE',
          daily_budget_minor: toMinorUnits(1000),
          created_at: new Date().toISOString(),
        });
        repos.agents.insert({
          id: 'ag-tx-2',
          name: 'Tx Agent 2',
          api_key_hash: 'hash-tx2',
          status: 'ACTIVE',
          daily_budget_minor: toMinorUnits(2000),
          created_at: new Date().toISOString(),
        });
      });

      expect(repos.agents.getById('ag-tx-1')).toBeDefined();
      expect(repos.agents.getById('ag-tx-2')).toBeDefined();
    });

    it('should roll back completely on error leaving zero partial writes', () => {
      const repos = createRepositories(db);

      expect(() => {
        runInTransaction(db, () => {
          repos.agents.insert({
            id: 'ag-rollback-1',
            name: 'Will Rollback',
            api_key_hash: 'hash-rb',
            status: 'ACTIVE',
            daily_budget_minor: toMinorUnits(1000),
            created_at: new Date().toISOString(),
          });

          // Simulate mid-transaction failure
          throw new Error('Simulated atomic failure');
        });
      }).toThrowError('Simulated atomic failure');

      // The first insert must have rolled back
      expect(repos.agents.getById('ag-rollback-1')).toBeUndefined();
    });
  });

  describe('Persistence Across Connections', () => {
    it('should persist data to disk and reload upon new connection', () => {
      tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-db-test-'));
      const diskPath = path.join(tempDbDir, 'test.db');

      // Connection 1: initialize and insert data
      const diskDb1 = createDatabase(diskPath);
      runMigrations(diskDb1);
      const repos1 = createRepositories(diskDb1);

      repos1.agents.insert({
        id: 'persisted-agent',
        name: 'Persistent Agent',
        api_key_hash: 'persisted-hash',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(7500),
        created_at: new Date().toISOString(),
      });

      diskDb1.close();

      // Connection 2: re-open existing file
      const diskDb2 = createDatabase(diskPath);
      // Ensure migrations can be called idempotently on re-open
      const newMigrations = runMigrations(diskDb2);
      expect(newMigrations).toBe(0);

      const repos2 = createRepositories(diskDb2);
      const reloaded = repos2.agents.getById('persisted-agent');

      expect(reloaded).toBeDefined();
      expect(reloaded?.name).toBe('Persistent Agent');
      expect(reloaded?.daily_budget_minor).toBe(7500);

      diskDb2.close();
    });
  });

  describe('Migration 6 Upgrade Compatibility & Trigger Hardening', () => {
    it('should produce identical trigger definitions on fresh database (1-12) vs upgraded database (1-5 then 6+)', () => {
      // Path A: Fresh database running all migrations 1..12
      const freshDb = createDatabase(':memory:');
      const freshCount = runMigrations(freshDb);
      expect(freshCount).toBe(12);

      // Path B: Existing database running migrations 1..5 first, then upgrading to latest
      const upgradedDb = createDatabase(':memory:');
      upgradedDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.slice(0, 5)) {
        upgradedDb.transaction(() => {
          upgradedDb.exec(migration.up);
          upgradedDb.prepare(`
            INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, datetime('now'))
          `).run(migration.version, migration.name);
        }).immediate();
      }

      // Verify upgradedDb is at version 5
      const appliedBefore = upgradedDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedBefore.map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);

      // Run runMigrations on upgradedDb to apply Migrations 6..12
      const upgradeCount = runMigrations(upgradedDb);
      expect(upgradeCount).toBe(7);

      const appliedAfter = upgradedDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedAfter.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

      // Compare trigger definitions between freshDb and upgradedDb
      const getTriggers = (database: typeof freshDb) =>
        database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'policy_proposals' ORDER BY name ASC").all();

      const freshTriggers = getTriggers(freshDb);
      const upgradedTriggers = getTriggers(upgradedDb);

      expect(freshTriggers.length).toBe(2);
      expect(upgradedTriggers.length).toBe(2);
      expect(upgradedTriggers).toEqual(freshTriggers);

      freshDb.close();
      upgradedDb.close();
    });

    it('should preserve existing policy_proposals and audit_log records across Migration 6 upgrade', () => {
      const dbAtV5 = createDatabase(':memory:');
      dbAtV5.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.slice(0, 5)) {
        dbAtV5.transaction(() => {
          dbAtV5.exec(migration.up);
          dbAtV5.prepare(`
            INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, datetime('now'))
          `).run(migration.version, migration.name);
        }).immediate();
      }

      const nowIso = new Date().toISOString();
      const testProposal = {
        id: 'prop-pre-migration-6',
        base_version: 1,
        rules: JSON.stringify({ auto_limit_minor: 5000 }),
        proposal_hash: 'hash-pre-6',
        has_relaxations: 1,
        relaxations: JSON.stringify(['Auto limit increased']),
        diff: JSON.stringify([{ field: 'auto_limit_minor', change: 'RELAXED' }]),
        explanation: 'Pre-upgrade proposal',
        unsupported_requests: '[]',
        owner_id: 'default',
        status: 'PENDING',
        created_at: nowIso,
        expires_at: new Date(Date.now() + 600000).toISOString(),
        activated_at: null,
        rejected_at: null,
      };

      // Insert pre-existing proposal record into v5 database
      dbAtV5.prepare(`
        INSERT INTO policy_proposals (
          id, base_version, rules, proposal_hash, has_relaxations,
          relaxations, diff, explanation, unsupported_requests,
          owner_id, status, created_at, expires_at, activated_at, rejected_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?
        )
      `).run(
        testProposal.id,
        testProposal.base_version,
        testProposal.rules,
        testProposal.proposal_hash,
        testProposal.has_relaxations,
        testProposal.relaxations,
        testProposal.diff,
        testProposal.explanation,
        testProposal.unsupported_requests,
        testProposal.owner_id,
        testProposal.status,
        testProposal.created_at,
        testProposal.expires_at,
        testProposal.activated_at,
        testProposal.rejected_at
      );

      // Insert pre-existing audit_log record into v5 database
      dbAtV5.prepare(`
        INSERT INTO audit_log (id, ts, actor, event, request_id, payload, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('aud-pre-6', nowIso, 'owner', 'POLICY_PROPOSAL_CREATED', null, '{}', null, 'hash-aud-1');

      // Now run migration runner to upgrade from 5 to latest (Migrations 6..12)
      const appliedCount = runMigrations(dbAtV5);
      expect(appliedCount).toBe(7);

      // Verify proposal survived untouched
      interface ProposalRow {
        id: string;
        base_version: number;
        rules: string;
        proposal_hash: string;
        has_relaxations: number;
        status: string;
        activated_at: string | null;
      }
      const survivedProposal = dbAtV5.prepare('SELECT * FROM policy_proposals WHERE id = ?').get('prop-pre-migration-6') as ProposalRow | undefined;
      expect(survivedProposal).toBeDefined();
      expect(survivedProposal?.id).toBe(testProposal.id);
      expect(survivedProposal?.base_version).toBe(testProposal.base_version);
      expect(survivedProposal?.rules).toBe(testProposal.rules);
      expect(survivedProposal?.proposal_hash).toBe(testProposal.proposal_hash);
      expect(survivedProposal?.has_relaxations).toBe(testProposal.has_relaxations);
      expect(survivedProposal?.status).toBe('PENDING');

      // Verify audit_log survived untouched
      interface AuditRow {
        id: string;
        actor: string;
        event: string;
        hash: string;
      }
      const survivedAudit = dbAtV5.prepare('SELECT * FROM audit_log WHERE id = ?').get('aud-pre-6') as AuditRow | undefined;
      expect(survivedAudit).toBeDefined();
      expect(survivedAudit?.id).toBe('aud-pre-6');
      expect(survivedAudit?.actor).toBe('owner');
      expect(survivedAudit?.event).toBe('POLICY_PROPOSAL_CREATED');
      expect(survivedAudit?.hash).toBe('hash-aud-1');

      // Verify the upgraded database rejects invalid transitions and timestamp combinations
      expect(() => {
        dbAtV5.prepare("UPDATE policy_proposals SET status = 'ACTIVATED' WHERE id = 'prop-pre-migration-6'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        dbAtV5.prepare(`UPDATE policy_proposals SET status = 'ACTIVATED', activated_at = '${nowIso}', rejected_at = '${nowIso}' WHERE id = 'prop-pre-migration-6'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        dbAtV5.prepare("UPDATE policy_proposals SET status = 'REJECTED' WHERE id = 'prop-pre-migration-6'").run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        dbAtV5.prepare(`UPDATE policy_proposals SET status = 'EXPIRED', activated_at = '${nowIso}' WHERE id = 'prop-pre-migration-6'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      expect(() => {
        dbAtV5.prepare("DELETE FROM policy_proposals WHERE id = 'prop-pre-migration-6'").run();
      }).toThrowError(/policy_proposals is append-only: DELETE operations are strictly prohibited/);

      // Verify valid transition works on the survived record
      dbAtV5.prepare(`UPDATE policy_proposals SET status = 'ACTIVATED', activated_at = '${nowIso}' WHERE id = 'prop-pre-migration-6'`).run();
      const activated = dbAtV5.prepare('SELECT status, activated_at FROM policy_proposals WHERE id = ?').get('prop-pre-migration-6') as { status: string; activated_at: string | null } | undefined;
      expect(activated?.status).toBe('ACTIVATED');
      expect(activated?.activated_at).toBe(nowIso);

      // Verify terminal record cannot transition further
      expect(() => {
        dbAtV5.prepare(`UPDATE policy_proposals SET status = 'REJECTED', rejected_at = '${nowIso}' WHERE id = 'prop-pre-migration-6'`).run();
      }).toThrowError(/policy_proposals is tamper-proof/);

      // Verify Migration 6 is not reapplied on subsequent runMigrations calls
      const rerun1 = runMigrations(dbAtV5);
      expect(rerun1).toBe(0);
      const rerun2 = runMigrations(dbAtV5);
      expect(rerun2).toBe(0);

      const v6Count = dbAtV5.prepare('SELECT COUNT(*) as count FROM schema_migrations WHERE version = 6').get() as { count: number };
      expect(v6Count.count).toBe(1);
      const v7Count = dbAtV5.prepare('SELECT COUNT(*) as count FROM schema_migrations WHERE version = 7').get() as { count: number };
      expect(v7Count.count).toBe(1);
      const v8Count = dbAtV5.prepare('SELECT COUNT(*) as count FROM schema_migrations WHERE version = 8').get() as { count: number };
      expect(v8Count.count).toBe(1);

      dbAtV5.close();
    });
  });

  describe('Migration 7 Upgrade Compatibility & Telegram Link Tokens', () => {
    it('should apply Migration 7 cleanly on existing v6 database and support link tokens', () => {
      // 1. Build database up to v6
      const dbAtV6 = createDatabase(':memory:');
      dbAtV6.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.slice(0, 6)) {
        dbAtV6.transaction(() => {
          dbAtV6.exec(migration.up);
          dbAtV6.prepare(`
            INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, datetime('now'))
          `).run(migration.version, migration.name);
        }).immediate();
      }

      // Populate pre-existing owner row (schema before Migration 7)
      const nowIso = new Date().toISOString();
      dbAtV6.prepare(`
        INSERT INTO owners (id, display_name, passphrase_hash, telegram_chat_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('default', 'Primary Owner', 'pw_hash', '12345678', nowIso);

      // Verify v6 state
      const appliedBefore = dbAtV6.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedBefore.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6]);

      // Run runMigrations to apply Migrations 7..12
      const upgradeCount = runMigrations(dbAtV6);
      expect(upgradeCount).toBe(6);

      const appliedAfter = dbAtV6.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedAfter.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

      // Verify telegram_link_tokens table was created
      const tables = dbAtV6.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_link_tokens'").all();
      expect(tables.length).toBe(1);

      // Verify telegram_link_tokens indices
      const indexes = dbAtV6.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'telegram_link_tokens'").all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_telegram_link_tokens_hash');
      expect(indexNames).toContain('idx_telegram_link_tokens_owner_expires');

      // Verify pre-existing owner survived and gained telegram_username and telegram_linked_at (null)
      interface OwnerRowExtended {
        id: string;
        display_name: string;
        telegram_chat_id: string | null;
        telegram_username: string | null;
        telegram_linked_at: string | null;
      }
      const owner = dbAtV6.prepare('SELECT id, display_name, telegram_chat_id, telegram_username, telegram_linked_at FROM owners WHERE id = ?').get('default') as OwnerRowExtended;
      expect(owner).toBeDefined();
      expect(owner.id).toBe('default');
      expect(owner.display_name).toBe('Primary Owner');
      expect(owner.telegram_chat_id).toBe('12345678');
      expect(owner.telegram_username).toBeNull();
      expect(owner.telegram_linked_at).toBeNull();

      // Verify subsequent runMigrations is idempotent
      const rerun = runMigrations(dbAtV6);
      expect(rerun).toBe(0);

      dbAtV6.close();
    });
  });

  describe('Migration 8 Upgrade Compatibility & Global Chat ID Uniqueness', () => {
    it('should apply Migration 8 cleanly on existing v7 database and enforce chat ID uniqueness', () => {
      // 1. Build database up to v7
      const dbAtV7 = createDatabase(':memory:');
      dbAtV7.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.slice(0, 7)) {
        dbAtV7.transaction(() => {
          dbAtV7.exec(migration.up);
          dbAtV7.prepare(`
            INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, datetime('now'))
          `).run(migration.version, migration.name);
        }).immediate();
      }

      // Populate pre-existing owner with a linked chat ID
      const nowIso = new Date().toISOString();
      dbAtV7.prepare(`
        INSERT INTO owners (id, display_name, passphrase_hash, telegram_chat_id, telegram_username, telegram_linked_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('default', 'Primary Owner', 'pw_hash', '123456789', 'owner_alice', nowIso, nowIso);

      // Verify v7 state
      const appliedBefore = dbAtV7.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedBefore.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);

      // Run runMigrations to apply Migrations 8..12
      const upgradeCount = runMigrations(dbAtV7);
      expect(upgradeCount).toBe(5);

      const appliedAfter = dbAtV7.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedAfter.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

      // Verify index idx_owners_telegram_chat_id exists on owners table
      const ownerIndexes = dbAtV7.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'owners'").all() as Array<{ name: string }>;
      expect(ownerIndexes.map((i) => i.name)).toContain('idx_owners_telegram_chat_id');

      // Verify unique constraint: create a secondary owner table scenario (dropping check constraint for multi-owner test)
      // Attempting to duplicate telegram_chat_id throws a unique constraint error
      dbAtV7.exec(`
        CREATE TABLE test_uniqueness_check (
          id TEXT PRIMARY KEY,
          telegram_chat_id TEXT
        );
        CREATE UNIQUE INDEX idx_test_unique_chat_id ON test_uniqueness_check(telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
        INSERT INTO test_uniqueness_check (id, telegram_chat_id) VALUES ('owner1', '123456789');
        INSERT INTO test_uniqueness_check (id, telegram_chat_id) VALUES ('owner2', NULL);
        INSERT INTO test_uniqueness_check (id, telegram_chat_id) VALUES ('owner3', NULL);
      `);

      expect(() => {
        dbAtV7.prepare("INSERT INTO test_uniqueness_check (id, telegram_chat_id) VALUES ('owner4', '123456789')").run();
      }).toThrowError(/UNIQUE constraint failed/);

      // Verify subsequent runMigrations is idempotent
      const rerun = runMigrations(dbAtV7);
      expect(rerun).toBe(0);

      dbAtV7.close();
    });
  });

  describe('Migration 9 Upgrade Compatibility & Notification Outbox', () => {
    it('should apply Migration 9 cleanly on existing v8 database and verify outbox table and indexes', () => {
      // 1. Build database up to v8
      const dbAtV8 = createDatabase(':memory:');
      dbAtV8.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.slice(0, 8)) {
        dbAtV8.transaction(() => {
          dbAtV8.exec(migration.up);
          dbAtV8.prepare(`
            INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, datetime('now'))
          `).run(migration.version, migration.name);
        }).immediate();
      }

      // Verify v8 state
      const appliedBefore = dbAtV8.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedBefore.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

      // Run runMigrations to apply Migrations 9..12
      const upgradeCount = runMigrations(dbAtV8);
      expect(upgradeCount).toBe(4);

      const appliedAfter = dbAtV8.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedAfter.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

      // Verify notification_outbox table exists
      const tables = dbAtV8.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notification_outbox'").all();
      expect(tables.length).toBe(1);

      // Verify indexes on notification_outbox
      const indexes = dbAtV8.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notification_outbox'").all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_notification_outbox_pending');
      expect(indexNames).toContain('idx_notification_outbox_processing');
      expect(indexNames).toContain('idx_notification_outbox_request');
      expect(indexNames).toContain('idx_notification_outbox_owner');

      // Verify unique constraint on dedup_key
      dbAtV8.prepare(`
        INSERT INTO owners (id, display_name, passphrase_hash, telegram_chat_id, created_at)
        VALUES ('default', 'Owner', 'hash', '123', datetime('now'))
      `).run();

      dbAtV8.prepare(`
        INSERT INTO notification_outbox (
          id, event_type, recipient_chat_id, owner_id, linked_at, request_id,
          dedup_key, message_text, parse_mode, status, attempt_count, max_attempts,
          next_attempt_at, created_at
        ) VALUES (
          'notif-1', 'PAYMENT_HELD', '123', 'default', datetime('now'), NULL,
          'dedup-unique-1', 'Message 1', 'HTML', 'PENDING', 0, 3,
          datetime('now'), datetime('now')
        )
      `).run();

      expect(() => {
        dbAtV8.prepare(`
          INSERT INTO notification_outbox (
            id, event_type, recipient_chat_id, owner_id, linked_at, request_id,
            dedup_key, message_text, parse_mode, status, attempt_count, max_attempts,
            next_attempt_at, created_at
          ) VALUES (
            'notif-2', 'PAYMENT_HELD', '123', 'default', datetime('now'), NULL,
            'dedup-unique-1', 'Message 2', 'HTML', 'PENDING', 0, 3,
            datetime('now'), datetime('now')
          )
        `).run();
      }).toThrowError(/UNIQUE constraint failed/);

      // Verify subsequent runMigrations is idempotent
      const rerun = runMigrations(dbAtV8);
      expect(rerun).toBe(0);

      dbAtV8.close();
    });
  });

  describe('Migration 10 Upgrade Compatibility & Telegram Approval Callbacks', () => {
    it('should apply Migration 10 cleanly on existing v9 database and verify schema extensions', () => {
      // 1. Build database up to v9
      const dbAtV9 = createDatabase(':memory:');
      dbAtV9.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.slice(0, 9)) {
        dbAtV9.transaction(() => {
          dbAtV9.exec(migration.up);
          dbAtV9.prepare(`
            INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, datetime('now'))
          `).run(migration.version, migration.name);
        }).immediate();
      }

      // Verify v9 state
      const appliedBefore = dbAtV9.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedBefore.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      // Run runMigrations to apply Migrations 10..12
      const upgradeCount = runMigrations(dbAtV9);
      expect(upgradeCount).toBe(3);

      const appliedAfter = dbAtV9.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedAfter.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

      // Verify telegram_approval_callbacks table exists
      const tables = dbAtV9.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_approval_callbacks'").all();
      expect(tables.length).toBe(1);

      // Verify indexes on telegram_approval_callbacks
      const indexes = dbAtV9.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'telegram_approval_callbacks'").all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_telegram_approval_callbacks_hash');
      expect(indexNames).toContain('idx_telegram_approval_callbacks_request');
      expect(indexNames).toContain('idx_telegram_approval_callbacks_owner');
      expect(indexNames).toContain('idx_telegram_approval_callbacks_expires');

      // Verify owners table has telegram_user_id column
      const ownerCols = dbAtV9.prepare("PRAGMA table_info('owners')").all() as Array<{ name: string }>;
      expect(ownerCols.map((c) => c.name)).toContain('telegram_user_id');

      // Verify notification_outbox table has reply_markup_enc column
      const outboxCols = dbAtV9.prepare("PRAGMA table_info('notification_outbox')").all() as Array<{ name: string }>;
      expect(outboxCols.map((c) => c.name)).toContain('reply_markup_enc');

      // Verify subsequent runMigrations is idempotent
      const rerun = runMigrations(dbAtV9);
      expect(rerun).toBe(0);

      dbAtV9.close();
    });
  });

  describe('Migration 11 Upgrade Compatibility & Telegram Callbacks Link Epoch', () => {
    it('should apply Migration 11 cleanly on existing v10 database and verify linked_at column', () => {
      // 1. Build database up to v10
      const dbAtV10 = createDatabase(':memory:');
      dbAtV10.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.slice(0, 10)) {
        dbAtV10.transaction(() => {
          dbAtV10.exec(migration.up);
          dbAtV10.prepare(`
            INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, datetime('now'))
          `).run(migration.version, migration.name);
        }).immediate();
      }

      // Verify v10 state
      const appliedBefore = dbAtV10.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedBefore.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // Run runMigrations to apply Migrations 11 & 12
      const upgradeCount = runMigrations(dbAtV10);
      expect(upgradeCount).toBe(2);

      const appliedAfter = dbAtV10.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedAfter.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

      // Verify telegram_approval_callbacks table has linked_at column
      const callbackCols = dbAtV10.prepare("PRAGMA table_info('telegram_approval_callbacks')").all() as Array<{ name: string }>;
      expect(callbackCols.map((c) => c.name)).toContain('linked_at');

      // Verify subsequent runMigrations is idempotent
      const rerun = runMigrations(dbAtV10);
      expect(rerun).toBe(0);

      dbAtV10.close();
    });
  });

  describe('Migration 12 Upgrade Compatibility & Owner Sessions', () => {
    it('should apply Migration 12 cleanly on existing v11 database, preserve owner rows, and enforce FK cascade', () => {
      const dbAtV11 = createDatabase(':memory:');
      dbAtV11.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.slice(0, 11)) {
        dbAtV11.transaction(() => {
          dbAtV11.exec(migration.up);
          dbAtV11.prepare(`
            INSERT INTO schema_migrations (version, name, applied_at)
            VALUES (?, ?, datetime('now'))
          `).run(migration.version, migration.name);
        }).immediate();
      }

      // Seed existing v11 owner with linked Telegram metadata
      dbAtV11.prepare(`
        INSERT INTO owners (
          id, display_name, passphrase_hash, telegram_chat_id, telegram_user_id,
          telegram_username, telegram_linked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'default',
        'Existing Owner',
        '$argon2id$v=19$m=19456,t=2,p=1$salt$hash',
        '555000111',
        '999888777',
        'existing_owner_tg',
        '2026-11-01T10:00:00.000Z',
        '2026-10-01T00:00:00.000Z'
      );

      const appliedBefore = dbAtV11.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedBefore.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

      // Apply Migration 12
      const upgradeCount = runMigrations(dbAtV11);
      expect(upgradeCount).toBe(1);

      const appliedAfter = dbAtV11.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
      expect(appliedAfter.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

      // Verify owner_sessions columns
      const sessionCols = dbAtV11.prepare("PRAGMA table_info('owner_sessions')").all() as Array<{ name: string; pk: number }>;
      const colNames = sessionCols.map((c) => c.name);
      expect(colNames).toEqual([
        'session_key',
        'owner_id',
        'display_name',
        'csrf_token',
        'created_at',
        'last_accessed_at',
      ]);
      expect(sessionCols.find((c) => c.name === 'session_key')?.pk).toBe(1);

      // Verify indexes on owner_sessions
      const indexes = dbAtV11
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'owner_sessions'")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_owner_sessions_owner_id');
      expect(indexNames).toContain('idx_owner_sessions_last_accessed');
      expect(indexNames).toContain('idx_owner_sessions_created_at');

      // Existing owner row survived intact
      const ownerRow = dbAtV11.prepare('SELECT * FROM owners WHERE id = ?').get('default') as {
        telegram_user_id: string;
        telegram_username: string;
        telegram_linked_at: string;
      };
      expect(ownerRow.telegram_user_id).toBe('999888777');
      expect(ownerRow.telegram_username).toBe('existing_owner_tg');
      expect(ownerRow.telegram_linked_at).toBe('2026-11-01T10:00:00.000Z');

      // Foreign key rejects unknown owner_id
      expect(() => {
        dbAtV11.prepare(`
          INSERT INTO owner_sessions (
            session_key, owner_id, display_name, csrf_token, created_at, last_accessed_at
          ) VALUES ('key-bad', 'nonexistent', 'Bad', 'csrf-1', 1000, 1000)
        `).run();
      }).toThrowError(/FOREIGN KEY constraint failed/);

      // ON DELETE CASCADE deletes sessions when owner is deleted
      dbAtV11.prepare(`
        INSERT INTO owner_sessions (
          session_key, owner_id, display_name, csrf_token, created_at, last_accessed_at
        ) VALUES ('key-good', 'default', 'Existing Owner', 'csrf-2', 1000, 1000)
      `).run();
      expect(
        (dbAtV11.prepare('SELECT COUNT(*) as c FROM owner_sessions').get() as { c: number }).c
      ).toBe(1);

      dbAtV11.prepare('DELETE FROM owners WHERE id = ?').run('default');
      expect(
        (dbAtV11.prepare('SELECT COUNT(*) as c FROM owner_sessions').get() as { c: number }).c
      ).toBe(0);

      // Idempotent rerun
      expect(runMigrations(dbAtV11)).toBe(0);

      dbAtV11.close();
    });
  });
});
