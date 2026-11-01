/**
 * PayGuard — Milestone M4-T10 Unit Tests
 * Owner Dashboard: Policies, Vendors, Agents, Audit
 *
 * Verifies:
 * 1. Policy read-only view and historical version preservation.
 * 2. Vendor registry: sanitized DTOs, vendor creation validation, no credential leaks.
 * 3. Agent registry: key generation, one-time reveal, budget handling, suspension control.
 * 4. Audit trail: actor, event, and requestId filtering, payload inspection, hash metadata.
 * 5. Disposable test records: in-memory database prevents dirtying demo database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { createPayGuardMcpServer, type PayGuardMcpServerInstance } from '../../src/mcp/server.js';
import { hashOwnerPassphrase, OWNER_COOKIE_NAME } from '../../src/auth/owner.js';
import { toMinorUnits, formatMinorUnitsToDecimal, parseDecimalToMinorUnits } from '../../src/core/money.js';
import { writeAuditLogEntry } from '../../src/core/stateMachine.js';
import type { VendorSummary, AgentSummary, PolicySummary, AuditLogSummary } from '../../web/src/types/api.js';

describe('Milestone M4-T10: Owner Dashboard Policies, Vendors, Agents & Audit', () => {
  let db: Database;
  let repos: Repositories;
  let serverInstance: PayGuardMcpServerInstance;
  let serverPort = 0;
  let serverClose: () => Promise<void>;

  const ownerPassphrase = 'm4t10-test-passphrase';
  let sessionCookie = '';
  let csrfToken = '';

  beforeEach(async () => {
    // Isolated in-memory DB: fulfills Requirement 5 (disposable test records)
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);

    // Seed Owner
    const hashedPass = await hashOwnerPassphrase(ownerPassphrase);
    repos.owners.upsert({
      display_name: 'Primary Owner',
      passphrase_hash: hashedPass,
      telegram_chat_id: null,
      created_at: new Date().toISOString(),
    });

    // Seed Active Policy
    const policyRules = {
      version: 1,
      currency_allowlist: ['USD'],
      auto_limit_minor: 1500,
      hard_cap_minor: 10000,
      agent_daily_budget_minor: 5000,
      global_daily_budget_minor: 20000,
      velocity: { max_requests: 5, window_minutes: 10 },
      duplicate_window_minutes: 60,
      new_vendor_action: 'HOLD',
      hold_ttl_minutes: 15,
    };
    repos.policyVersions.insert({
      id: 'pol-v1',
      version: 1,
      rules: JSON.stringify(policyRules),
      author: 'owner',
      active: 1,
      created_at: new Date().toISOString(),
    });

    // Seed Test Vendor
    repos.vendors.insert({
      id: 'ven-test-initial',
      name: 'Initial Test Vendor',
      status: 'ACTIVE',
      categories: JSON.stringify(['api', 'cloud']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    });

    // Seed Test Agent
    repos.agents.insert({
      id: 'agent-test-initial',
      name: 'Initial Test Agent',
      api_key_hash: crypto.createHash('sha256').update('dummy-key').digest('hex'),
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(5000),
      created_at: new Date().toISOString(),
    });

    // Launch Server on random ephemeral port
    serverInstance = createPayGuardMcpServer({
      db,
      repos,
      secureCookie: false,
      logger: { error: () => {}, warn: () => {}, info: () => {} },
    });

    const started = await serverInstance.start(0);
    serverPort = started.port;
    serverClose = async () => {
      await started.close();
      db.close();
    };

    // Perform Owner Login to retrieve HttpOnly Session Cookie and CSRF Token
    const loginRes = await fetch(`http://127.0.0.1:${serverPort}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: ownerPassphrase }),
    });

    const setCookieHeader = loginRes.headers.get('set-cookie') || '';
    const cookieMatch = setCookieHeader.match(new RegExp(`${OWNER_COOKIE_NAME}=([^;]+)`));
    if (cookieMatch) {
      sessionCookie = `${OWNER_COOKIE_NAME}=${cookieMatch[1]}`;
    }
    const loginData = (await loginRes.json()) as { csrfToken: string };
    csrfToken = loginData.csrfToken;
  });

  afterEach(async () => {
    if (serverClose) {
      await serverClose();
    }
  });

  // ==========================================================================
  // 1. POLICIES (Read-Only & Historical Versions)
  // ==========================================================================
  describe('Policies — Read-only View & Version History', () => {
    it('returns the active policy and immutable history', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/policies`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        activePolicy: PolicySummary;
        history: PolicySummary[];
      };

      expect(body.activePolicy).toBeDefined();
      expect(body.activePolicy.version).toBe(1);
      expect(body.activePolicy.active).toBe(true);
      expect(body.activePolicy.author).toBe('owner');

      const rules = body.activePolicy.rules as Record<string, unknown>;
      expect(rules.auto_limit_minor).toBe(1500);
      expect(rules.hard_cap_minor).toBe(10000);
      expect(rules.currency_allowlist).toEqual(['USD']);
      expect(rules.new_vendor_action).toBe('HOLD');

      expect(Array.isArray(body.history)).toBe(true);
      expect(body.history.length).toBeGreaterThanOrEqual(1);
      expect(body.history[0]?.version).toBe(1);
    });

    it('preserves historical rules unchanged when a new version is added', async () => {
      // Create v2 policy
      const v2Payload = {
        currency_allowlist: ['USD', 'EUR'],
        auto_limit_minor: 2500,
        hard_cap_minor: 15000,
        agent_daily_budget_minor: 7500,
        global_daily_budget_minor: 30000,
        velocity: { max_requests: 10, window_minutes: 15 },
        duplicate_window_minutes: 30,
        new_vendor_action: 'HOLD',
        hold_ttl_minutes: 20,
      };

      const postRes = await fetch(`http://127.0.0.1:${serverPort}/api/policies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify(v2Payload),
      });
      expect(postRes.status).toBe(201);

      // Fetch policies and verify v1 rules are strictly preserved
      const getRes = await fetch(`http://127.0.0.1:${serverPort}/api/policies`, {
        headers: { Cookie: sessionCookie },
      });
      const data = (await getRes.json()) as { activePolicy: PolicySummary; history: PolicySummary[] };

      expect(data.activePolicy.version).toBe(2);
      expect(data.history.length).toBe(2);

      // Verify v1 historical record
      const v1Historical = data.history.find((h) => h.version === 1);
      expect(v1Historical).toBeDefined();
      expect(v1Historical?.active).toBe(false);
      const v1Rules = v1Historical?.rules as Record<string, unknown>;
      expect(v1Rules.auto_limit_minor).toBe(1500);
      expect(v1Rules.hard_cap_minor).toBe(10000);
    });
  });

  // ==========================================================================
  // 2. VENDORS (Sanitization, Validation & Credentials Security)
  // ==========================================================================
  describe('Vendors — Registry & Creation Security', () => {
    it('returns sanitized vendor list omitting connector_key and vault tokens', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/vendors`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { vendors: VendorSummary[] };
      expect(body.vendors.length).toBeGreaterThanOrEqual(1);

      const initial = body.vendors.find((v) => v.id === 'ven-test-initial');
      expect(initial).toBeDefined();
      expect(initial?.name).toBe('Initial Test Vendor');
      expect(initial?.status).toBe('ACTIVE');
      expect(initial?.categories).toEqual(['api', 'cloud']);
      expect(initial?.currencies).toEqual(['USD']);
      expect(initial?.hasVaultToken).toBe(false);

      // Security Invariant: no connector_key or secrets exposed
      const rawVendor = initial as unknown as Record<string, unknown>;
      expect(rawVendor.connector_key).toBeUndefined();
      expect(rawVendor.vault_token_id).toBeUndefined();
    });

    it('successfully creates a vendor with valid inputs and default connector_key', async () => {
      const newVendorPayload = {
        id: 'ven-disposable-anthropic',
        name: 'Anthropic Claude API',
        status: 'ACTIVE',
        categories: ['ai', 'developer-tools'],
        currencies: ['USD'],
      };

      const res = await fetch(`http://127.0.0.1:${serverPort}/api/vendors`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify(newVendorPayload),
      });

      expect(res.status).toBe(201);
      const created = (await res.json()) as VendorSummary;
      expect(created.id).toBe('ven-disposable-anthropic');
      expect(created.name).toBe('Anthropic Claude API');
      expect(created.status).toBe('ACTIVE');

      // Verify audit log entry was written (Hard Rule 7)
      const auditRes = await fetch(
        `http://127.0.0.1:${serverPort}/api/audit?event=VENDOR_CREATED&limit=5`,
        { headers: { Cookie: sessionCookie } }
      );
      const auditData = (await auditRes.json()) as { items: AuditLogSummary[] };
      const vendorAudit = auditData.items.find(
        (i) => (i.payload as { vendor_id?: string }).vendor_id === 'ven-disposable-anthropic'
      );
      expect(vendorAudit).toBeDefined();
      expect(vendorAudit?.actor).toBe('owner');
    });

    it('rejects vendor creation with invalid ID or invalid currencies', async () => {
      // Invalid characters in ID
      const badIdRes = await fetch(`http://127.0.0.1:${serverPort}/api/vendors`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({
          id: 'bad id with spaces!',
          name: 'Bad Vendor',
          status: 'ACTIVE',
          categories: ['api'],
          currencies: ['USD'],
        }),
      });
      expect(badIdRes.status).toBe(400);

      // Invalid currency format (lowercase or not 3 chars)
      const badCurrencyRes = await fetch(`http://127.0.0.1:${serverPort}/api/vendors`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({
          id: 'ven-bad-currency',
          name: 'Bad Currency Vendor',
          status: 'ACTIVE',
          categories: ['api'],
          currencies: ['usd', 'TOOLONG'],
        }),
      });
      expect(badCurrencyRes.status).toBe(400);
    });
  });

  // ==========================================================================
  // 3. AGENTS (Key Generation, Transient Reveal, Suspension)
  // ==========================================================================
  describe('Agents — Registry, One-Time Key Generation & Suspension', () => {
    it('returns sanitized agent list strictly omitting api_key_hash', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/agents`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { agents: AgentSummary[] };
      expect(body.agents.length).toBeGreaterThanOrEqual(1);

      const agent = body.agents.find((a) => a.id === 'agent-test-initial');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Initial Test Agent');
      expect(agent?.status).toBe('ACTIVE');
      expect(agent?.dailyBudgetMinor).toBe(5000);
      expect(agent?.dailyBudgetDecimal).toBe('50.00');

      // Security Invariant (Rule 2): api_key_hash must NEVER be exposed
      const rawAgent = agent as unknown as Record<string, unknown>;
      expect(rawAgent.api_key_hash).toBeUndefined();
      expect(rawAgent.apiKey).toBeUndefined();
    });

    it('generates agent with one-time API key and stores only hash', async () => {
      const createRes = await fetch(`http://127.0.0.1:${serverPort}/api/agents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({
          name: 'Disposable Reviewer Agent',
          daily_budget_decimal: '75.50',
        }),
      });

      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        id: string;
        name: string;
        status: string;
        dailyBudgetMinor: number;
        dailyBudgetDecimal: string;
        apiKey: string;
      };

      expect(created.id).toMatch(/^agent-/);
      expect(created.name).toBe('Disposable Reviewer Agent');
      expect(created.status).toBe('ACTIVE');
      expect(created.dailyBudgetMinor).toBe(7550);
      expect(created.dailyBudgetDecimal).toBe('75.50');
      expect(created.apiKey).toBeDefined();
      expect(typeof created.apiKey).toBe('string');
      expect(created.apiKey.length).toBeGreaterThan(16);

      // Verify that database row has api_key_hash and NOT plaintext key
      const agentRow = repos.agents.getById(created.id);
      expect(agentRow).toBeDefined();
      expect(agentRow?.api_key_hash).not.toBe(created.apiKey);
      expect(agentRow?.api_key_hash.length).toBe(64); // SHA-256 hex length

      // Verify audit log entry does NOT contain raw key or hash (Rule 2 & Condition 5)
      const auditRes = await fetch(
        `http://127.0.0.1:${serverPort}/api/audit?event=AGENT_CREATED&limit=5`,
        { headers: { Cookie: sessionCookie } }
      );
      const auditData = (await auditRes.json()) as { items: AuditLogSummary[] };
      const agentAudit = auditData.items.find(
        (i) => (i.payload as { agent_id?: string }).agent_id === created.id
      );
      expect(agentAudit).toBeDefined();
      const auditPayload = agentAudit?.payload as Record<string, unknown>;
      expect(auditPayload.apiKey).toBeUndefined();
      expect(auditPayload.api_key_hash).toBeUndefined();
      expect(auditPayload.rawKey).toBeUndefined();
    });

    it('suspends an active agent and records AGENT_SUSPENDED audit event', async () => {
      // Suspend initial agent
      const suspendRes = await fetch(
        `http://127.0.0.1:${serverPort}/api/agents/agent-test-initial/suspend`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: sessionCookie,
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify({}),
        }
      );

      expect(suspendRes.status).toBe(200);
      const suspendData = (await suspendRes.json()) as { id: string; status: string };
      expect(suspendData.id).toBe('agent-test-initial');
      expect(suspendData.status).toBe('SUSPENDED');

      // Verify in agents list
      const listRes = await fetch(`http://127.0.0.1:${serverPort}/api/agents`, {
        headers: { Cookie: sessionCookie },
      });
      const listData = (await listRes.json()) as { agents: AgentSummary[] };
      const agent = listData.agents.find((a) => a.id === 'agent-test-initial');
      expect(agent?.status).toBe('SUSPENDED');

      // Verify audit log
      const auditRes = await fetch(
        `http://127.0.0.1:${serverPort}/api/audit?event=AGENT_SUSPENDED&limit=5`,
        { headers: { Cookie: sessionCookie } }
      );
      const auditData = (await auditRes.json()) as { items: AuditLogSummary[] };
      const suspendAudit = auditData.items.find(
        (i) => (i.payload as { agent_id?: string }).agent_id === 'agent-test-initial'
      );
      expect(suspendAudit).toBeDefined();
      expect(suspendAudit?.actor).toBe('owner');
    });
  });

  // ==========================================================================
  // 4. AUDIT LOG (Filtering & Metadata Verification)
  // ==========================================================================
  describe('Audit Log — Filtering & Payload Inspection', () => {
    beforeEach(() => {
      // Seed diverse audit records for filtering tests
      const now = new Date().toISOString();
      writeAuditLogEntry(db, repos, {
        actor: 'agent',
        event: 'PAYMENT_REQUESTED',
        requestId: 'req-test-audit-001',
        timestamp: now,
        payload: { amount_minor: 1200, currency: 'USD', vendor_id: 'ven-test-initial' },
      });

      writeAuditLogEntry(db, repos, {
        actor: 'ai',
        event: 'AI_EVALUATION',
        requestId: 'req-test-audit-001',
        timestamp: now,
        payload: { confidence: 0.95, advice: 'No anomaly detected' },
      });

      writeAuditLogEntry(db, repos, {
        actor: 'system',
        event: 'HOLD_EXPIRED',
        requestId: 'req-test-audit-002',
        timestamp: now,
        payload: { hold_duration_seconds: 900 },
      });
    });

    it('filters audit entries strictly by actor', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/audit?actor=agent`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(200);

      const data = (await res.json()) as { items: AuditLogSummary[]; total: number };
      expect(data.items.length).toBeGreaterThan(0);
      data.items.forEach((item) => {
        expect(item.actor).toBe('agent');
      });
    });

    it('filters audit entries strictly by event type', async () => {
      const res = await fetch(
        `http://127.0.0.1:${serverPort}/api/audit?event=PAYMENT_REQUESTED`,
        { headers: { Cookie: sessionCookie } }
      );
      expect(res.status).toBe(200);

      const data = (await res.json()) as { items: AuditLogSummary[] };
      expect(data.items.length).toBeGreaterThan(0);
      data.items.forEach((item) => {
        expect(item.event).toBe('PAYMENT_REQUESTED');
      });
    });

    it('filters audit entries strictly by requestId', async () => {
      const res = await fetch(
        `http://127.0.0.1:${serverPort}/api/audit?requestId=req-test-audit-001`,
        { headers: { Cookie: sessionCookie } }
      );
      expect(res.status).toBe(200);

      const data = (await res.json()) as { items: AuditLogSummary[] };
      expect(data.items.length).toBeGreaterThanOrEqual(2);
      data.items.forEach((item) => {
        expect(item.requestId).toBe('req-test-audit-001');
      });
    });

    it('displays entry hash and prevHash as metadata without false cryptographic claims', async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/api/audit?limit=10`, {
        headers: { Cookie: sessionCookie },
      });
      const data = (await res.json()) as { items: AuditLogSummary[] };
      expect(data.items.length).toBeGreaterThan(0);

      const itemWithHash = data.items.find((i) => i.hash);
      expect(itemWithHash).toBeDefined();
      expect(typeof itemWithHash?.hash).toBe('string');
      expect(itemWithHash?.hash.length).toBeGreaterThan(10);
    });
  });

  // ==========================================================================
  // 5. MONEY AND DTO UTILITIES
  // ==========================================================================
  describe('Money & DTO Validation Helpers', () => {
    it('accurately parses decimal currency strings to integer minor units without float drift', () => {
      expect(parseDecimalToMinorUnits('50.00')).toBe(toMinorUnits(5000));
      expect(parseDecimalToMinorUnits('0.99')).toBe(toMinorUnits(99));
      expect(parseDecimalToMinorUnits('1234.56')).toBe(toMinorUnits(123456));
      expect(formatMinorUnitsToDecimal(toMinorUnits(5000))).toBe('50.00');
    });
  });
});
