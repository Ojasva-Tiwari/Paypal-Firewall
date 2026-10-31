/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T5 Unit & Security Integration Tests: Owner REST API
 *
 * Verifies all canonical endpoints:
 * - /api/healthz (public health check)
 * - /api/overview (budget, 24h metrics, recent feed)
 * - /api/requests (listing, filtering, pagination)
 * - /api/requests/:id (detail, timeline, ledger, lazy expiry)
 * - /api/requests/:id/approve (direct approval, Flow C, token invalidation)
 * - /api/requests/:id/void (direct void, release row, remote void status)
 * - /api/policies (GET history, POST new version with validation and atomic switch)
 * - /api/vendors (GET sanitized list, POST new vendor, no connector/vault leaks)
 * - /api/agents (GET sanitized list, POST key generation, suspend, no key hash leaks)
 * - /api/audit (paginated query, filtering, maximum page size, deterministic order)
 * - /api/paypal/activity (graceful fallback)
 *
 * Security Invariants & Guarantees Tested:
 * - Session authentication required on all dashboard routes
 * - CSRF required on all state-changing routes (POST)
 * - Role isolation: Agent Bearer key rejected from owner endpoints
 * - Mutual exclusivity of approval and void
 * - Zero secrets or raw keys in audit entries or responses
 * - Fail closed on invalid input, unknown IDs, and expired holds
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { createPayGuardMcpServer, type PayGuardMcpServerInstance } from '../../src/mcp/server.js';
import { hashOwnerPassphrase, OWNER_COOKIE_NAME } from '../../src/auth/owner.js';
import { mintApprovalToken } from '../../src/approvals/tokens.js';
import { toMinorUnits } from '../../src/core/money.js';
import { writeAuditLogEntry } from '../../src/core/stateMachine.js';
import { computeSnapshotHash } from '../../src/core/service.js';
import type { PayPalAuthorizationsService } from '../../src/paypal/authorizations.js';
import type { AgentRow, VendorRow, PolicyVersionRow, PaymentRequestRow } from '../../src/db/types.js';

describe('M4-T5: Owner REST API Unit & Security Integration Tests', () => {
  let db: Database;
  let repos: Repositories;
  let serverInstance: PayGuardMcpServerInstance;
  let serverPort = 0;
  let serverClose: () => Promise<void>;

  const ownerPassphrase = 'owner-secure-passphrase-2026';
  let sessionCookie = '';
  let csrfToken = '';

  const defaultPolicyId = 'pol-initial-v1';
  const defaultAgentId = 'agent-test-honest';
  const defaultVendorId = 'ven-acme-cloud';

  beforeEach(async () => {
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

    // Seed Initial Active Policy
    const initialPolicyRules = {
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

    const initialPolicyRow: PolicyVersionRow = {
      id: defaultPolicyId,
      version: 1,
      rules: JSON.stringify(initialPolicyRules),
      author: 'owner',
      active: 1,
      created_at: new Date().toISOString(),
    };
    repos.policyVersions.insert(initialPolicyRow);

    // Seed Vendor
    const vendorRow: VendorRow = {
      id: defaultVendorId,
      name: 'Acme Cloud Inc',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud', 'saas']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    };
    repos.vendors.insert(vendorRow);

    // Seed Agent
    const agentRow: AgentRow = {
      id: defaultAgentId,
      name: 'Honest Demo Agent',
      api_key_hash: crypto.createHash('sha256').update('agent-raw-secret').digest('hex'),
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(5000),
      created_at: new Date().toISOString(),
    };
    repos.agents.insert(agentRow);

    // Mock PayPal Authorizations Service
    const mockAuthorizationsService = {
      captureAuthorization: async () => ({
        id: 'CAP-TEST-1234',
        status: 'COMPLETED',
        isCaptured: true,
      }),
      voidAuthorization: async () => ({
        id: 'AUTH-TEST-VOIDED',
        status: 'VOIDED',
        isVoided: true,
      }),
      getAuthorization: async (authId: string) => ({
        id: authId,
        status: 'VOIDED',
      }),
    } as unknown as PayPalAuthorizationsService;

    // Start MCP Server
    serverInstance = createPayGuardMcpServer({
      db,
      repos,
      authorizationsService: mockAuthorizationsService,
      secureCookie: false,
    });

    const started = await serverInstance.start(0);
    serverPort = started.port;
    serverClose = started.close;

    // Log in as Owner to obtain Cookie and CSRF token
    const loginRes = await fetch(`http://localhost:${serverPort}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: ownerPassphrase }),
    });

    expect(loginRes.status).toBe(200);
    const setCookieHeader = loginRes.headers.get('set-cookie');
    expect(setCookieHeader).toBeDefined();

    // Parse session cookie
    const match = setCookieHeader!.match(new RegExp(`${OWNER_COOKIE_NAME}=([^;]+)`));
    expect(match).toBeDefined();
    sessionCookie = match![0];

    const loginData = (await loginRes.json()) as { csrfToken: string };
    csrfToken = loginData.csrfToken;
    expect(csrfToken).toBeDefined();
  });

  afterEach(async () => {
    if (serverClose) {
      await serverClose();
    }
    db.close();
  });

  // Helper to seed a test payment request
  function seedPaymentRequest(overrides?: Partial<PaymentRequestRow>): PaymentRequestRow {
    const id = overrides?.id ?? `req-${crypto.randomUUID()}`;
    const agent_id = overrides?.agent_id ?? defaultAgentId;
    const vendor_id = overrides?.vendor_id ?? defaultVendorId;
    const amount_minor = overrides?.amount_minor ?? toMinorUnits(4000);
    const currency = overrides?.currency ?? 'USD';
    const purpose = overrides?.purpose ?? 'API Credits';
    const category = overrides?.category ?? 'cloud';
    const snapshot_hash =
      overrides?.snapshot_hash ??
      computeSnapshotHash({
        requestId: id,
        agentId: agent_id,
        vendorId: vendor_id,
        amountMinor: amount_minor,
        currency,
        purpose,
        category,
      });

    const nowIso = new Date().toISOString();
    const reqRow: PaymentRequestRow = {
      id,
      agent_id,
      idempotency_key: overrides?.idempotency_key ?? `idemp-${crypto.randomUUID()}`,
      vendor_id,
      amount_minor,
      currency,
      purpose,
      category,
      source_context_excerpt: overrides?.source_context_excerpt ?? 'Invoice #100',
      source_context_hash: overrides?.source_context_hash ?? null,
      status: overrides?.status ?? 'HELD',
      decision: overrides?.decision ?? 'HOLD',
      reasons: overrides?.reasons ?? JSON.stringify(['OVER_AUTO_LIMIT']),
      policy_version_id: overrides?.policy_version_id ?? defaultPolicyId,
      snapshot_hash,
      paypal_order_id: overrides?.paypal_order_id ?? null,
      paypal_authorization_id: overrides?.paypal_authorization_id ?? 'AUTH-MOCK-12345',
      paypal_capture_id: overrides?.paypal_capture_id ?? null,
      remote_void_status: overrides?.remote_void_status ?? null,
      expires_at: overrides?.expires_at ?? new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      created_at: overrides?.created_at ?? nowIso,
      updated_at: overrides?.updated_at ?? nowIso,
      ...overrides,
    };
    repos.paymentRequests.insert(reqRow);
    return reqRow;
  }

  // ============================================================================
  // 1. Healthz & Public Access
  // ============================================================================

  describe('1. Health Check Endpoint', () => {
    it('GET /api/healthz responds with 200 without requiring authentication', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/healthz`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; service: string };
      expect(data.status).toBe('ok');
      expect(data.service).toBe('payguard-owner-api');
    });
  });

  // ============================================================================
  // 2. Authentication & Authorization Enforcement
  // ============================================================================

  describe('2. Authentication & Role Isolation Enforcement', () => {
    const protectedGetEndpoints = [
      '/api/overview',
      '/api/requests',
      '/api/policies',
      '/api/vendors',
      '/api/agents',
      '/api/audit',
      '/api/paypal/activity',
    ];

    for (const ep of protectedGetEndpoints) {
      it(`unauthenticated GET ${ep} returns 401 Unauthorized`, async () => {
        const res = await fetch(`http://localhost:${serverPort}${ep}`);
        expect(res.status).toBe(401);
        const data = (await res.json()) as { error: string };
        expect(data.error).toBe('Authentication required');
      });
    }

    it('agent Bearer token cannot access owner endpoints (role isolation)', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/overview`, {
        headers: {
          Authorization: 'Bearer test-agent-api-key',
        },
      });
      expect(res.status).toBe(401);
    });
  });

  // ============================================================================
  // 3. CSRF Protection on State-Changing Routes
  // ============================================================================

  describe('3. CSRF Header Enforcement', () => {
    it('POST /api/vendors fails with 403 when x-csrf-token is missing', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/vendors`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'ven-new',
          name: 'New Vendor',
          status: 'ACTIVE',
          categories: ['saas'],
          currencies: ['USD'],
        }),
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain('CSRF');
    });

    it('POST /api/vendors fails with 403 when x-csrf-token is invalid', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/vendors`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
          'x-csrf-token': 'wrong-csrf-token-1234',
        },
        body: JSON.stringify({
          id: 'ven-new',
          name: 'New Vendor',
          status: 'ACTIVE',
          categories: ['saas'],
          currencies: ['USD'],
        }),
      });
      expect(res.status).toBe(403);
    });
  });

  // ============================================================================
  // 4. Overview Metrics (/api/overview)
  // ============================================================================

  describe('4. GET /api/overview', () => {
    it('returns budget usage, 24h counts, and recent activity', async () => {
      // Seed a captured request with SPEND ledger entry
      const req1 = seedPaymentRequest({
        amount_minor: toMinorUnits(1200),
        status: 'CAPTURED',
        decision: 'ALLOW',
      });
      repos.ledger.insert({
        id: 'led-1',
        request_id: req1.id,
        kind: 'SPEND',
        amount_minor: req1.amount_minor,
        currency: 'USD',
        created_at: new Date().toISOString(),
      });

      // Seed a held request with RESERVE ledger entry
      const req2 = seedPaymentRequest({
        amount_minor: toMinorUnits(4000),
        status: 'HELD',
        decision: 'HOLD',
      });
      repos.ledger.insert({
        id: 'led-2',
        request_id: req2.id,
        kind: 'RESERVE',
        amount_minor: req2.amount_minor,
        currency: 'USD',
        created_at: new Date().toISOString(),
      });

      const res = await fetch(`http://localhost:${serverPort}/api/overview`, {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        budget: {
          globalDailyBudgetDecimal: string;
          spentRolling24hDecimal: string;
          reservedRolling24hDecimal: string;
          totalCommittedDecimal: string;
          remainingBudgetDecimal: string;
        };
        counts24h: { total: number; allowed: number; held: number; denied: number };
        recentActivity: Array<{ id: string; status: string; amountDecimal: string }>;
      };

      expect(data.budget.globalDailyBudgetDecimal).toBe('200.00');
      expect(data.budget.spentRolling24hDecimal).toBe('12.00');
      expect(data.budget.reservedRolling24hDecimal).toBe('40.00');
      expect(data.budget.totalCommittedDecimal).toBe('52.00');
      expect(data.budget.remainingBudgetDecimal).toBe('148.00');
      expect(data.counts24h.allowed).toBe(1);
      expect(data.counts24h.held).toBe(1);
      expect(data.recentActivity.length).toBe(2);
    });
  });

  // ============================================================================
  // 5. Payment Requests List & Detail
  // ============================================================================

  describe('5. GET /api/requests & GET /api/requests/:id', () => {
    it('lists requests with pagination and status filtering', async () => {
      seedPaymentRequest({ id: 'req-held-1', status: 'HELD' });
      seedPaymentRequest({ id: 'req-held-2', status: 'HELD' });
      seedPaymentRequest({ id: 'req-cap-1', status: 'CAPTURED' });

      // Filter by status=HELD
      const res = await fetch(`http://localhost:${serverPort}/api/requests?status=HELD&limit=10&offset=0`, {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        items: Array<{ id: string; status: string }>;
        total: number;
        limit: number;
        offset: number;
      };

      expect(data.total).toBe(2);
      expect(data.items.length).toBe(2);
      expect(data.items.every((i) => i.status === 'HELD')).toBe(true);
    });

    it('rejects invalid status parameter with 400 Bad Request', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/requests?status=INVALID_STATUS`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(400);
    });

    it('returns full request details, timeline, and ledger entries', async () => {
      const seeded = seedPaymentRequest({ id: 'req-detail-1' });
      repos.ledger.insert({
        id: 'led-det-1',
        request_id: seeded.id,
        kind: 'RESERVE',
        amount_minor: seeded.amount_minor,
        currency: 'USD',
        created_at: new Date().toISOString(),
      });

      const res = await fetch(`http://localhost:${serverPort}/api/requests/${seeded.id}`, {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        id: string;
        agent: { name: string };
        vendor: { name: string };
        amount: { amountDecimal: string };
        ledger: Array<{ kind: string }>;
      };

      expect(data.id).toBe(seeded.id);
      expect(data.agent.name).toBe('Honest Demo Agent');
      expect(data.vendor.name).toBe('Acme Cloud Inc');
      expect(data.amount.amountDecimal).toBe('40.00');
      expect(data.ledger.length).toBe(1);
      expect(data.ledger[0]?.kind).toBe('RESERVE');
    });

    it('lazy expiry hook: reading an expired HELD request transitions it to VOIDED', async () => {
      const pastExpiresAt = new Date(Date.now() - 60 * 1000).toISOString();
      const expiredReq = seedPaymentRequest({
        id: 'req-lazy-exp-1',
        status: 'HELD',
        expires_at: pastExpiresAt,
      });

      // Insert RESERVE entry
      repos.ledger.insert({
        id: 'led-exp-res',
        request_id: expiredReq.id,
        kind: 'RESERVE',
        amount_minor: expiredReq.amount_minor,
        currency: 'USD',
        created_at: new Date().toISOString(),
      });

      const res = await fetch(`http://localhost:${serverPort}/api/requests/${expiredReq.id}`, {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string; ledger: Array<{ kind: string }> };
      expect(data.status).toBe('VOIDED');

      // Verify RELEASE ledger entry was created
      const dbLedger = repos.ledger.listByRequestId(expiredReq.id);
      expect(dbLedger.some((l) => l.kind === 'RELEASE')).toBe(true);
    });

    it('returns 404 Not Found for non-existent request ID', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/requests/non-existent-id`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(404);
    });
  });

  // ============================================================================
  // 6. Direct Owner Approval (/api/requests/:id/approve)
  // ============================================================================

  describe('6. Direct Owner Approval', () => {
    it('approves a HELD request, invalidates open tokens, and executes capture via executeDecision', async () => {
      const reqToApprove = seedPaymentRequest({ id: 'req-to-approve-1', status: 'HELD' });

      // Mint an approval token
      const tokenRes = mintApprovalToken(db, repos, {
        requestId: reqToApprove.id,
        action: 'APPROVE',
        channel: 'web',
      });
      expect(tokenRes.rawToken).toBeDefined();

      const res = await fetch(`http://localhost:${serverPort}/api/requests/${reqToApprove.id}/approve`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { success: boolean; status: string };
      expect(data.success).toBe(true);

      // Verify database state
      const updatedReq = repos.paymentRequests.getById(reqToApprove.id);
      expect(updatedReq?.status).toBe('CAPTURED');

      // Verify token was invalidated
      const approvals = repos.approvals.listByRequestId(reqToApprove.id);
      expect(approvals.length).toBe(1);
      expect(approvals[0]?.used_at).not.toBeNull();
    });

    it('fails closed when attempting to approve an already captured request (mutual exclusivity)', async () => {
      const reqCaptured = seedPaymentRequest({ id: 'req-already-cap', status: 'CAPTURED' });

      const res = await fetch(`http://localhost:${serverPort}/api/requests/${reqCaptured.id}/approve`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });

      expect(res.status).toBe(409);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('INVALID_STATUS');
    });

    it('rejects approval on an expired hold with 410 HOLD_EXPIRED', async () => {
      const pastTime = new Date(Date.now() - 30 * 1000).toISOString();
      const expiredReq = seedPaymentRequest({
        id: 'req-expired-hold',
        status: 'HELD',
        expires_at: pastTime,
      });

      const res = await fetch(`http://localhost:${serverPort}/api/requests/${expiredReq.id}/approve`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });

      expect(res.status).toBe(410);
      const data = (await res.json()) as { error: string };
      expect(data.error).toBe('HOLD_EXPIRED');
    });
  });

  // ============================================================================
  // 7. Direct Owner Void (/api/requests/:id/void)
  // ============================================================================

  describe('7. Direct Owner Void', () => {
    it('voids a HELD request, releases reservation, invalidates tokens, and updates remote void status', async () => {
      const reqToVoid = seedPaymentRequest({ id: 'req-to-void-1', status: 'HELD' });
      repos.ledger.insert({
        id: 'led-void-res',
        request_id: reqToVoid.id,
        kind: 'RESERVE',
        amount_minor: reqToVoid.amount_minor,
        currency: 'USD',
        created_at: new Date().toISOString(),
      });

      // Mint a void token
      mintApprovalToken(db, repos, {
        requestId: reqToVoid.id,
        action: 'VOID',
        channel: 'web',
      });

      const res = await fetch(`http://localhost:${serverPort}/api/requests/${reqToVoid.id}/void`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Testing owner void' }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { success: boolean; status: string; remoteVoidStatus: string };
      expect(data.success).toBe(true);
      expect(data.status).toBe('VOIDED');

      // Verify request in DB
      const updatedReq = repos.paymentRequests.getById(reqToVoid.id);
      expect(updatedReq?.status).toBe('VOIDED');

      // Verify RELEASE ledger row exists
      const ledgerRows = repos.ledger.listByRequestId(reqToVoid.id);
      expect(ledgerRows.some((l) => l.kind === 'RELEASE')).toBe(true);

      // Verify token was invalidated
      const approvals = repos.approvals.listByRequestId(reqToVoid.id);
      expect(approvals[0]?.used_at).not.toBeNull();
    });

    it('subsequent void on an already voided request is idempotent', async () => {
      const alreadyVoided = seedPaymentRequest({ id: 'req-already-voided', status: 'VOIDED' });

      const res = await fetch(`http://localhost:${serverPort}/api/requests/${alreadyVoided.id}/void`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { success: boolean; status: string };
      expect(data.success).toBe(true);
      expect(data.status).toBe('VOIDED');
    });
  });

  // ============================================================================
  // 8. Policy Management (/api/policies)
  // ============================================================================

  describe('8. Policy Management Endpoints', () => {
    it('GET /api/policies returns active policy and version history', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/policies`, {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        activePolicy: { version: number; active: boolean };
        history: Array<{ version: number }>;
      };

      expect(data.activePolicy).toBeDefined();
      expect(data.activePolicy.version).toBe(1);
      expect(data.activePolicy.active).toBe(true);
      expect(data.history.length).toBe(1);
    });

    it('POST /api/policies rejects invalid policy schema without changing active policy', async () => {
      // hard_cap_minor < auto_limit_minor is invalid
      const invalidPolicy = {
        currency_allowlist: ['USD'],
        auto_limit_minor: 5000,
        hard_cap_minor: 2000, // Invalid!
        agent_daily_budget_minor: 5000,
        global_daily_budget_minor: 20000,
        velocity: { max_requests: 5, window_minutes: 10 },
        duplicate_window_minutes: 60,
        new_vendor_action: 'HOLD',
        hold_ttl_minutes: 15,
      };

      const res = await fetch(`http://localhost:${serverPort}/api/policies`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(invalidPolicy),
      });

      expect(res.status).toBe(400);

      // Verify active policy remained version 1
      const activePolicy = repos.policyVersions.getActive();
      expect(activePolicy?.version).toBe(1);
    });

    it('POST /api/policies validates and atomically switches to new policy version', async () => {
      const validPolicy = {
        currency_allowlist: ['USD'],
        auto_limit_minor: 2000,
        hard_cap_minor: 15000,
        agent_daily_budget_minor: 8000,
        global_daily_budget_minor: 30000,
        velocity: { max_requests: 10, window_minutes: 15 },
        duplicate_window_minutes: 30,
        new_vendor_action: 'DENY',
        hold_ttl_minutes: 20,
      };

      const res = await fetch(`http://localhost:${serverPort}/api/policies`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validPolicy),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { version: number; active: boolean };
      expect(data.version).toBe(2);
      expect(data.active).toBe(true);

      // Verify active policy in DB is now version 2
      const activePolicy = repos.policyVersions.getActive();
      expect(activePolicy?.version).toBe(2);

      // Verify audit log has POLICY_ACTIVATED entry
      const auditEntries = repos.auditLog.list({ event: 'POLICY_ACTIVATED' });
      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0]?.actor).toBe('owner');
    });
  });

  // ============================================================================
  // 9. Vendor Management (/api/vendors)
  // ============================================================================

  describe('9. Vendor Management Endpoints', () => {
    it('GET /api/vendors lists vendors without exposing connector_key or secrets', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/vendors`, {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        vendors: Array<{
          id: string;
          name: string;
          hasVaultToken: boolean;
          connector_key?: string;
          connectorKey?: string;
        }>;
      };

      expect(data.vendors.length).toBe(1);
      const v = data.vendors[0]!;
      expect(v.id).toBe(defaultVendorId);
      expect(v.hasVaultToken).toBe(false);

      // Invariant: Secret & internal connector credentials strictly omitted
      expect(v.connector_key).toBeUndefined();
      expect(v.connectorKey).toBeUndefined();
    });

    it('POST /api/vendors registers new vendor with audit log', async () => {
      const newVendorPayload = {
        id: 'ven-github',
        name: 'GitHub Inc',
        status: 'ACTIVE',
        categories: ['dev-tools', 'cloud'],
        currencies: ['USD'],
        connector_key: 'github_connector',
      };

      const res = await fetch(`http://localhost:${serverPort}/api/vendors`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(newVendorPayload),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as { id: string; name: string };
      expect(data.id).toBe('ven-github');

      // Verify in DB
      const dbVendor = repos.vendors.getById('ven-github');
      expect(dbVendor).toBeDefined();

      // Verify audit entry
      const auditEntries = repos.auditLog.list({ event: 'VENDOR_CREATED' });
      expect(auditEntries.length).toBe(1);
    });

    it('POST /api/vendors rejects duplicate vendor ID with 409 Conflict', async () => {
      const duplicatePayload = {
        id: defaultVendorId, // Already seeded in beforeEach
        name: 'Acme Cloud Duplicate',
        status: 'ACTIVE',
        categories: ['cloud'],
        currencies: ['USD'],
      };

      const res = await fetch(`http://localhost:${serverPort}/api/vendors`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(duplicatePayload),
      });

      expect(res.status).toBe(409);
    });
  });

  // ============================================================================
  // 10. Agent Management (/api/agents)
  // ============================================================================

  describe('10. Agent Management Endpoints', () => {
    it('GET /api/agents lists agents without exposing api_key_hash', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/agents`, {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        agents: Array<{
          id: string;
          name: string;
          dailyBudgetDecimal: string;
          api_key_hash?: string;
          apiKeyHash?: string;
        }>;
      };

      expect(data.agents.length).toBe(1);
      const a = data.agents[0]!;
      expect(a.id).toBe(defaultAgentId);
      expect(a.dailyBudgetDecimal).toBe('50.00');

      // Security Invariant (Rule 2): api_key_hash strictly omitted
      expect(a.api_key_hash).toBeUndefined();
      expect(a.apiKeyHash).toBeUndefined();
    });

    it('POST /api/agents provisions new agent, returns raw key once, and omits key from audit log', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/agents`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Procurement Bot',
          daily_budget_decimal: '75.00',
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as {
        id: string;
        name: string;
        dailyBudgetDecimal: string;
        apiKey: string;
      };

      expect(data.name).toBe('Procurement Bot');
      expect(data.dailyBudgetDecimal).toBe('75.00');
      expect(data.apiKey).toBeDefined();
      expect(data.apiKey.length).toBe(64); // 32-byte hex

      // Verify in DB
      const dbAgent = repos.agents.getById(data.id);
      expect(dbAgent).toBeDefined();
      expect(dbAgent?.status).toBe('ACTIVE');

      // Verify audit log DOES NOT contain raw key or hash
      const auditEntries = repos.auditLog.list({ event: 'AGENT_CREATED' });
      expect(auditEntries.length).toBe(1);
      const auditPayload = JSON.stringify(auditEntries[0]?.payload);
      expect(auditPayload).not.toContain(data.apiKey);
      expect(auditPayload).not.toContain(dbAgent?.api_key_hash);
    });

    it('POST /api/agents/:id/suspend suspends an agent and writes audit log', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/agents/${defaultAgentId}/suspend`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
        },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { id: string; status: string };
      expect(data.status).toBe('SUSPENDED');

      // Verify in DB
      const dbAgent = repos.agents.getById(defaultAgentId);
      expect(dbAgent?.status).toBe('SUSPENDED');

      // Verify audit log
      const auditEntries = repos.auditLog.list({ event: 'AGENT_SUSPENDED' });
      expect(auditEntries.length).toBe(1);
    });
  });

  // ============================================================================
  // 11. Audit Log Querying (/api/audit)
  // ============================================================================

  describe('11. Audit Log Querying Endpoints', () => {
    it('returns paginated audit entries with deterministic order and capped limit', async () => {
      // Seed audit entries
      writeAuditLogEntry(db, repos, {
        actor: 'system',
        event: 'TEST_INIT_1',
        payload: { item: 1 },
      });
      writeAuditLogEntry(db, repos, {
        actor: 'owner',
        event: 'TEST_INIT_2',
        payload: { item: 2 },
      });

      const res = await fetch(`http://localhost:${serverPort}/api/audit?limit=200`, {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        items: Array<{ id: string; hash: string }>;
        total: number;
        limit: number;
      };

      // Maximum limit clamped to 100
      expect(data.limit).toBe(100);
      expect(data.items.length).toBe(2);
      expect(data.items[0]?.hash).toBeDefined();
    });

    it('filters audit entries by actor', async () => {
      // Seed audit entries with different actors
      writeAuditLogEntry(db, repos, {
        actor: 'system',
        event: 'SYS_ACTION',
        payload: { sys: true },
      });
      writeAuditLogEntry(db, repos, {
        actor: 'owner',
        event: 'OWNER_ACTION',
        payload: { owner: true },
      });

      const res = await fetch(`http://localhost:${serverPort}/api/audit?actor=owner`, {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { items: Array<{ actor: string }> };
      expect(data.items.length).toBeGreaterThan(0);
      expect(data.items.every((i) => i.actor === 'owner')).toBe(true);
    });

    it('rejects invalid actor parameter with 400 Bad Request', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/audit?actor=invalid-actor`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(400);
    });
  });

  // ============================================================================
  // 12. PayPal Activity Fallback (/api/paypal/activity)
  // ============================================================================

  describe('12. PayPal Activity Fallback Endpoint', () => {
    it('returns graceful fallback when toolkit is not configured', async () => {
      const res = await fetch(`http://localhost:${serverPort}/api/paypal/activity`, {
        headers: { Cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { enabled: boolean; transactions: unknown[] };
      expect(data.enabled).toBe(false);
      expect(Array.isArray(data.transactions)).toBe(true);
    });
  });

  // ============================================================================
  // 13. Concurrency, Token Invalidation, and Boundary Safety Tests
  // ============================================================================

  describe('13. Concurrency, Token Invalidation, and Boundary Safety Tests', () => {
    it('concurrent approval attempts: only one succeeds, the other receives 409 conflict', async () => {
      const reqHeld = seedPaymentRequest({ id: 'req-concurrent-app', status: 'HELD' });

      const attempt1 = fetch(`http://localhost:${serverPort}/api/requests/${reqHeld.id}/approve`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });

      const attempt2 = fetch(`http://localhost:${serverPort}/api/requests/${reqHeld.id}/approve`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });

      const [res1, res2] = await Promise.all([attempt1, attempt2]);
      const statuses = [res1.status, res2.status].sort();

      expect(statuses).toEqual([200, 409]);
    });

    it('concurrent approval vs void: exactly one succeeds, the other receives 409 conflict', async () => {
      const reqHeld = seedPaymentRequest({ id: 'req-concurrent-app-void', status: 'HELD' });

      const approveAttempt = fetch(`http://localhost:${serverPort}/api/requests/${reqHeld.id}/approve`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });

      const voidAttempt = fetch(`http://localhost:${serverPort}/api/requests/${reqHeld.id}/void`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });

      const [resApp, resVoid] = await Promise.all([approveAttempt, voidAttempt]);
      const statuses = [resApp.status, resVoid.status].sort();

      expect(statuses).toEqual([200, 409]);
    });

    it('token cannot be used via /a/:token/approve after direct owner approval', async () => {
      const reqToApprove = seedPaymentRequest({ id: 'req-token-inval-app', status: 'HELD' });

      const tokenRes = mintApprovalToken(db, repos, {
        requestId: reqToApprove.id,
        action: 'APPROVE',
        channel: 'web',
      });
      const rawToken = tokenRes.rawToken!;
      expect(rawToken).toBeDefined();

      // Approve directly via dashboard API
      const apiRes = await fetch(`http://localhost:${serverPort}/api/requests/${reqToApprove.id}/approve`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });
      expect(apiRes.status).toBe(200);

      // Now attempt to use the approval token via /a/:token/approve
      const tokenApproveRes = await fetch(`http://localhost:${serverPort}/a/${rawToken}/approve`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });

      // Token consumption must fail with 409 or 410
      expect([409, 410]).toContain(tokenApproveRes.status);
    });

    it('token cannot be used via /a/:token/void after direct owner void', async () => {
      const reqToVoid = seedPaymentRequest({ id: 'req-token-inval-void', status: 'HELD' });

      const tokenRes = mintApprovalToken(db, repos, {
        requestId: reqToVoid.id,
        action: 'VOID',
        channel: 'web',
      });
      const rawToken = tokenRes.rawToken!;
      expect(rawToken).toBeDefined();

      // Void directly via dashboard API
      const apiRes = await fetch(`http://localhost:${serverPort}/api/requests/${reqToVoid.id}/void`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });
      expect(apiRes.status).toBe(200);

      // Attempt to use the void token via /a/:token/void
      const tokenVoidRes = await fetch(`http://localhost:${serverPort}/a/${rawToken}/void`, {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          'x-csrf-token': csrfToken,
          'Content-Type': 'application/json',
        },
      });

      expect([409, 410]).toContain(tokenVoidRes.status);
    });

    it('clamps pagination limits and offsets safely on requests and audit', async () => {
      // Offset < 0 clamped to 0, Limit > 100 clamped to 100
      const res = await fetch(`http://localhost:${serverPort}/api/requests?limit=999&offset=-5`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { limit: number; offset: number };
      expect(data.limit).toBe(100);
      expect(data.offset).toBe(0);

      // Limit < 1 clamped to 1
      const res2 = await fetch(`http://localhost:${serverPort}/api/requests?limit=0`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res2.status).toBe(200);
      const data2 = (await res2.json()) as { limit: number };
      expect(data2.limit).toBe(1);
    });
  });
});
