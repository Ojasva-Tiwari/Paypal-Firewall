import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createDatabase,
  runMigrations,
  runInTransaction,
  createRepositories,
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
    it('should create all 10 canonical Section 8 tables on empty database', () => {
      const freshDb = createDatabase(':memory:');
      const count = runMigrations(freshDb);

      expect(count).toBe(3);

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
        vault_token_id: '2m430894bj312712d',
        status: 'VAULTED',
        created_at: new Date().toISOString(),
      });

      const token = repos.vendorVaultTokens.getByVendorId('ven-acme');
      expect(token?.vault_token_id).toBe('2m430894bj312712d');
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
});
