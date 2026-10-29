import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createDatabase,
  runMigrations,
  createRepositories,
  type Database,
} from '../../src/db/index.js';
import {
  gatherFacts,
  getAgentStatus,
  getVendorFacts,
  getRollingBudgets,
  getVelocityCount,
  checkDuplicate,
} from '../../src/core/facts.js';
import { toMinorUnits } from '../../src/core/money.js';
import { evaluatePolicy } from '../../src/policy/engine.js';
import type { PolicyRequest, PolicyDocument } from '../../src/policy/types.js';

describe('Facts Aggregator (M1-T6)', () => {
  let db: Database;

  const mockPolicy: PolicyDocument = {
    version: 1,
    currency_allowlist: ['USD'],
    auto_limit_minor: toMinorUnits(1500), // $15.00
    hard_cap_minor: toMinorUnits(10000), // $100.00
    agent_daily_budget_minor: toMinorUnits(5000), // $50.00
    global_daily_budget_minor: toMinorUnits(20000), // $200.00
    velocity: { max_requests: 5, window_minutes: 10 },
    duplicate_window_minutes: 60,
    new_vendor_action: 'HOLD',
    hold_ttl_minutes: 15,
  };

  const sampleRequest: PolicyRequest = {
    agentId: 'agent-1',
    vendorId: 'vendor-1',
    amountMinor: toMinorUnits(1200), // $12.00
    currency: 'USD',
    purpose: 'Server hosting monthly',
    category: 'cloud',
    idempotencyKey: 'idem-key-1',
  };

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
  });

  describe('Agent Status Resolution', () => {
    it('should return ACTIVE for an active agent', () => {
      const repos = createRepositories(db);
      repos.agents.insert({
        id: 'agent-1',
        name: 'Autonomous Agent',
        api_key_hash: 'hash-key-1',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(10000),
        created_at: new Date().toISOString(),
      });

      const status = getAgentStatus(db, 'agent-1');
      expect(status).toBe('ACTIVE');
    });

    it('should return SUSPENDED for a suspended agent', () => {
      const repos = createRepositories(db);
      repos.agents.insert({
        id: 'agent-suspended',
        name: 'Suspended Agent',
        api_key_hash: 'hash-key-2',
        status: 'SUSPENDED',
        daily_budget_minor: toMinorUnits(10000),
        created_at: new Date().toISOString(),
      });

      const status = getAgentStatus(db, 'agent-suspended');
      expect(status).toBe('SUSPENDED');
    });

    it('should fail closed (return SUSPENDED) when agent is missing from registry', () => {
      const status = getAgentStatus(db, 'nonexistent-agent');
      expect(status).toBe('SUSPENDED');
    });

    it('should fail closed when agentId is empty or invalid', () => {
      expect(getAgentStatus(db, '')).toBe('SUSPENDED');
    });
  });

  describe('Vendor Facts Resolution', () => {
    it('should return vendor status, categories, and currencies for active vendor', () => {
      const repos = createRepositories(db);
      repos.vendors.insert({
        id: 'vendor-1',
        name: 'Acme Cloud',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud', 'hosting']),
        currencies: JSON.stringify(['USD', 'EUR']),
        connector_key: 'acme_cloud',
        created_at: new Date().toISOString(),
      });

      const facts = getVendorFacts(db, 'vendor-1');
      expect(facts.vendorStatus).toBe('ACTIVE');
      expect(facts.vendorCategories).toEqual(['cloud', 'hosting']);
      expect(facts.vendorCurrencies).toEqual(['USD', 'EUR']);
    });

    it('should return UNVERIFIED vendor status', () => {
      const repos = createRepositories(db);
      repos.vendors.insert({
        id: 'vendor-new',
        name: 'New Vendor',
        status: 'UNVERIFIED',
        categories: JSON.stringify(['saas']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'new_vendor',
        created_at: new Date().toISOString(),
      });

      const facts = getVendorFacts(db, 'vendor-new');
      expect(facts.vendorStatus).toBe('UNVERIFIED');
    });

    it('should return BLOCKED vendor status', () => {
      const repos = createRepositories(db);
      repos.vendors.insert({
        id: 'vendor-blocked',
        name: 'Rogue Vendor',
        status: 'BLOCKED',
        categories: JSON.stringify(['malicious']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'rogue',
        created_at: new Date().toISOString(),
      });

      const facts = getVendorFacts(db, 'vendor-blocked');
      expect(facts.vendorStatus).toBe('BLOCKED');
    });

    it('should fail closed (return MISSING) when vendor does not exist', () => {
      const facts = getVendorFacts(db, 'unknown-vendor');
      expect(facts.vendorStatus).toBe('MISSING');
      expect(facts.vendorCategories).toBeUndefined();
      expect(facts.vendorCurrencies).toBeUndefined();
    });

    it('should handle malformed JSON categories and currencies gracefully', () => {
      const repos = createRepositories(db);
      repos.vendors.insert({
        id: 'vendor-corrupt',
        name: 'Corrupt Vendor',
        status: 'ACTIVE',
        categories: 'not-json',
        currencies: 'invalid',
        connector_key: 'corrupt',
        created_at: new Date().toISOString(),
      });

      const facts = getVendorFacts(db, 'vendor-corrupt');
      expect(facts.vendorStatus).toBe('ACTIVE');
      expect(facts.vendorCategories).toEqual([]);
      expect(facts.vendorCurrencies).toEqual([]);
    });
  });

  describe('Rolling 24-Hour Budget Aggregation from Ledger', () => {
    const fixedNow = new Date('2026-10-29T12:00:00.000Z');
    const windowStartIso = new Date(fixedNow.getTime() - 24 * 60 * 60 * 1000).toISOString();

    beforeEach(() => {
      const repos = createRepositories(db);
      repos.agents.insert({
        id: 'agent-1',
        name: 'Agent 1',
        api_key_hash: 'k1',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(10000),
        created_at: new Date(fixedNow.getTime() - 48 * 60 * 60 * 1000).toISOString(),
      });
      repos.agents.insert({
        id: 'agent-2',
        name: 'Agent 2',
        api_key_hash: 'k2',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(10000),
        created_at: new Date(fixedNow.getTime() - 48 * 60 * 60 * 1000).toISOString(),
      });
      repos.vendors.insert({
        id: 'vendor-1',
        name: 'Vendor 1',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'v1',
        created_at: new Date(fixedNow.getTime() - 48 * 60 * 60 * 1000).toISOString(),
      });
    });

    it('should return zero when ledger is empty', () => {
      const budgets = getRollingBudgets(db, 'agent-1', 'USD', windowStartIso);
      expect(budgets.agentSpendRolling24hMinor).toBe(0);
      expect(budgets.agentReservedRolling24hMinor).toBe(0);
      expect(budgets.globalSpendRolling24hMinor).toBe(0);
      expect(budgets.globalReservedRolling24hMinor).toBe(0);
    });

    it('should aggregate SPEND rows created in the rolling 24h window', () => {
      const repos = createRepositories(db);

      // Request 1 by agent-1: $12.00 spent 2 hours ago
      repos.paymentRequests.insert({
        id: 'req-1',
        agent_id: 'agent-1',
        idempotency_key: 'key-1',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        purpose: 'Hosting',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      });

      repos.ledger.insert({
        id: 'led-1',
        request_id: 'req-1',
        kind: 'SPEND',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        created_at: new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      });

      const budgets = getRollingBudgets(db, 'agent-1', 'USD', windowStartIso);
      expect(budgets.agentSpendRolling24hMinor).toBe(1200);
      expect(budgets.agentReservedRolling24hMinor).toBe(0);
      expect(budgets.globalSpendRolling24hMinor).toBe(1200);
      expect(budgets.globalReservedRolling24hMinor).toBe(0);
    });

    it('should aggregate active RESERVE rows and eliminate them when SPENT or RELEASED', () => {
      const repos = createRepositories(db);

      // Request 2 by agent-1: $20.00 currently HELD (RESERVE only)
      repos.paymentRequests.insert({
        id: 'req-2',
        agent_id: 'agent-1',
        idempotency_key: 'key-2',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(2000),
        currency: 'USD',
        purpose: 'API Credits',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'HELD',
        decision: 'HOLD',
        reasons: JSON.stringify(['OVER_AUTO_LIMIT']),
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      });

      repos.ledger.insert({
        id: 'led-2',
        request_id: 'req-2',
        kind: 'RESERVE',
        amount_minor: toMinorUnits(2000),
        currency: 'USD',
        created_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      });

      // Request 3 by agent-1: $15.00 reserved then released (VOIDED)
      repos.paymentRequests.insert({
        id: 'req-3',
        agent_id: 'agent-1',
        idempotency_key: 'key-3',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1500),
        currency: 'USD',
        purpose: 'Cancelled order',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'VOIDED',
        decision: 'HOLD',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 3 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 3 * 60 * 60 * 1000).toISOString(),
      });

      repos.ledger.insert({
        id: 'led-3-res',
        request_id: 'req-3',
        kind: 'RESERVE',
        amount_minor: toMinorUnits(1500),
        currency: 'USD',
        created_at: new Date(fixedNow.getTime() - 3 * 60 * 60 * 1000).toISOString(),
      });
      repos.ledger.insert({
        id: 'led-3-rel',
        request_id: 'req-3',
        kind: 'RELEASE',
        amount_minor: toMinorUnits(1500),
        currency: 'USD',
        created_at: new Date(fixedNow.getTime() - 2.5 * 60 * 60 * 1000).toISOString(),
      });

      const budgets = getRollingBudgets(db, 'agent-1', 'USD', windowStartIso);
      // req-2 is active reservation ($20.00). req-3 is released ($0 net).
      expect(budgets.agentReservedRolling24hMinor).toBe(2000);
      expect(budgets.agentSpendRolling24hMinor).toBe(0);
      expect(budgets.globalReservedRolling24hMinor).toBe(2000);
    });

    it('should ignore spend outside the rolling 24-hour window', () => {
      const repos = createRepositories(db);

      // Request spent 26 hours ago
      repos.paymentRequests.insert({
        id: 'req-old',
        agent_id: 'agent-1',
        idempotency_key: 'key-old',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(5000),
        currency: 'USD',
        purpose: 'Old Hosting',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 26 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 26 * 60 * 60 * 1000).toISOString(),
      });

      repos.ledger.insert({
        id: 'led-old',
        request_id: 'req-old',
        kind: 'SPEND',
        amount_minor: toMinorUnits(5000),
        currency: 'USD',
        created_at: new Date(fixedNow.getTime() - 26 * 60 * 60 * 1000).toISOString(),
      });

      const budgets = getRollingBudgets(db, 'agent-1', 'USD', windowStartIso);
      expect(budgets.agentSpendRolling24hMinor).toBe(0);
      expect(budgets.globalSpendRolling24hMinor).toBe(0);
    });

    it('should filter commitments strictly by the requested currency', () => {
      const repos = createRepositories(db);

      // Spend in EUR
      repos.paymentRequests.insert({
        id: 'req-eur',
        agent_id: 'agent-1',
        idempotency_key: 'key-eur',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(3000),
        currency: 'EUR',
        purpose: 'Euro purchase',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      });

      repos.ledger.insert({
        id: 'led-eur',
        request_id: 'req-eur',
        kind: 'SPEND',
        amount_minor: toMinorUnits(3000),
        currency: 'EUR',
        created_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      });

      // Querying USD should yield 0
      const usdBudgets = getRollingBudgets(db, 'agent-1', 'USD', windowStartIso);
      expect(usdBudgets.agentSpendRolling24hMinor).toBe(0);
      expect(usdBudgets.globalSpendRolling24hMinor).toBe(0);

      // Querying EUR should yield 3000
      const eurBudgets = getRollingBudgets(db, 'agent-1', 'EUR', windowStartIso);
      expect(eurBudgets.agentSpendRolling24hMinor).toBe(3000);
      expect(eurBudgets.globalSpendRolling24hMinor).toBe(3000);
    });

    it('should distinguish agent-specific spend from global spend across multiple agents', () => {
      const repos = createRepositories(db);

      // Agent 1 spends $10.00
      repos.paymentRequests.insert({
        id: 'req-ag1',
        agent_id: 'agent-1',
        idempotency_key: 'k-ag1',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1000),
        currency: 'USD',
        purpose: 'Agent 1 task',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      });
      repos.ledger.insert({
        id: 'led-ag1',
        request_id: 'req-ag1',
        kind: 'SPEND',
        amount_minor: toMinorUnits(1000),
        currency: 'USD',
        created_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      });

      // Agent 2 spends $25.00
      repos.paymentRequests.insert({
        id: 'req-ag2',
        agent_id: 'agent-2',
        idempotency_key: 'k-ag2',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(2500),
        currency: 'USD',
        purpose: 'Agent 2 task',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      });
      repos.ledger.insert({
        id: 'led-ag2',
        request_id: 'req-ag2',
        kind: 'SPEND',
        amount_minor: toMinorUnits(2500),
        currency: 'USD',
        created_at: new Date(fixedNow.getTime() - 1 * 60 * 60 * 1000).toISOString(),
      });

      // For Agent 1: agent_spend is 1000, global is 3500
      const b1 = getRollingBudgets(db, 'agent-1', 'USD', windowStartIso);
      expect(b1.agentSpendRolling24hMinor).toBe(1000);
      expect(b1.globalSpendRolling24hMinor).toBe(3500);

      // For Agent 2: agent_spend is 2500, global is 3500
      const b2 = getRollingBudgets(db, 'agent-2', 'USD', windowStartIso);
      expect(b2.agentSpendRolling24hMinor).toBe(2500);
      expect(b2.globalSpendRolling24hMinor).toBe(3500);
    });
  });

  describe('Velocity Window Request Counting', () => {
    const fixedNow = new Date('2026-10-29T12:00:00.000Z');
    const velocityWindow10mStart = new Date(fixedNow.getTime() - 10 * 60 * 1000).toISOString();

    beforeEach(() => {
      const repos = createRepositories(db);
      repos.agents.insert({
        id: 'agent-1',
        name: 'Agent 1',
        api_key_hash: 'k1',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(10000),
        created_at: new Date().toISOString(),
      });
      repos.vendors.insert({
        id: 'vendor-1',
        name: 'Vendor 1',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'v1',
        created_at: new Date().toISOString(),
      });
    });

    it('should return 0 when no requests exist', () => {
      expect(getVelocityCount(db, 'agent-1', velocityWindow10mStart)).toBe(0);
    });

    it('should count requests created within the velocity window for the agent', () => {
      const repos = createRepositories(db);

      // Insert 3 requests within the 10 min window (at T-2m, T-4m, T-6m)
      for (let i = 1; i <= 3; i++) {
        repos.paymentRequests.insert({
          id: `req-vel-${i}`,
          agent_id: 'agent-1',
          idempotency_key: `key-vel-${i}`,
          vendor_id: 'vendor-1',
          amount_minor: toMinorUnits(1400),
          currency: 'USD',
          purpose: `Task ${i}`,
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
          created_at: new Date(fixedNow.getTime() - i * 2 * 60 * 1000).toISOString(),
          updated_at: new Date(fixedNow.getTime() - i * 2 * 60 * 1000).toISOString(),
        });
      }

      // Insert 1 request outside the window (at T-15m)
      repos.paymentRequests.insert({
        id: 'req-vel-old',
        agent_id: 'agent-1',
        idempotency_key: 'key-vel-old',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1400),
        currency: 'USD',
        purpose: 'Old Task',
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
        created_at: new Date(fixedNow.getTime() - 15 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 15 * 60 * 1000).toISOString(),
      });

      expect(getVelocityCount(db, 'agent-1', velocityWindow10mStart)).toBe(3);
    });

    it('should exclude currentRequestId when provided', () => {
      const repos = createRepositories(db);

      repos.paymentRequests.insert({
        id: 'req-current',
        agent_id: 'agent-1',
        idempotency_key: 'key-curr',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1400),
        currency: 'USD',
        purpose: 'Current Task',
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
        created_at: new Date(fixedNow.getTime() - 1 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 1 * 60 * 1000).toISOString(),
      });

      // Without exclusion, count is 1
      expect(getVelocityCount(db, 'agent-1', velocityWindow10mStart)).toBe(1);
      // With exclusion, count is 0
      expect(getVelocityCount(db, 'agent-1', velocityWindow10mStart, 'req-current')).toBe(0);
    });
  });

  describe('Duplicate Request Detection', () => {
    const fixedNow = new Date('2026-10-29T12:00:00.000Z');

    beforeEach(() => {
      const repos = createRepositories(db);
      repos.agents.insert({
        id: 'agent-1',
        name: 'Agent 1',
        api_key_hash: 'k1',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(10000),
        created_at: new Date().toISOString(),
      });
      repos.agents.insert({
        id: 'agent-2',
        name: 'Agent 2',
        api_key_hash: 'k2',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(10000),
        created_at: new Date().toISOString(),
      });
      repos.vendors.insert({
        id: 'vendor-1',
        name: 'Vendor 1',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'v1',
        created_at: new Date().toISOString(),
      });
      repos.vendors.insert({
        id: 'vendor-2',
        name: 'Vendor 2',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'v2',
        created_at: new Date().toISOString(),
      });
    });

    it('should detect duplicate when matching agent, vendor, amount, currency, purpose in window', () => {
      const repos = createRepositories(db);

      repos.paymentRequests.insert({
        id: 'req-prev',
        agent_id: 'agent-1',
        idempotency_key: 'key-prev',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        purpose: 'Server hosting monthly',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 20 * 60 * 1000).toISOString(), // 20m ago
        updated_at: new Date(fixedNow.getTime() - 20 * 60 * 1000).toISOString(),
      });

      const isDup = checkDuplicate(db, sampleRequest, 60, fixedNow);
      expect(isDup).toBe(true);
    });

    it('should return false if purpose differs', () => {
      const repos = createRepositories(db);

      repos.paymentRequests.insert({
        id: 'req-diff-purpose',
        agent_id: 'agent-1',
        idempotency_key: 'key-diff-p',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        purpose: 'Different purpose',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 20 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 20 * 60 * 1000).toISOString(),
      });

      expect(checkDuplicate(db, sampleRequest, 60, fixedNow)).toBe(false);
    });

    it('should return false if amount differs', () => {
      const repos = createRepositories(db);

      repos.paymentRequests.insert({
        id: 'req-diff-amount',
        agent_id: 'agent-1',
        idempotency_key: 'key-diff-a',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1300), // different amount
        currency: 'USD',
        purpose: 'Server hosting monthly',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 20 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 20 * 60 * 1000).toISOString(),
      });

      expect(checkDuplicate(db, sampleRequest, 60, fixedNow)).toBe(false);
    });

    it('should return false if outside duplicate window', () => {
      const repos = createRepositories(db);

      repos.paymentRequests.insert({
        id: 'req-outside-window',
        agent_id: 'agent-1',
        idempotency_key: 'key-outside',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        purpose: 'Server hosting monthly',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 65 * 60 * 1000).toISOString(), // 65m ago (outside 60m)
        updated_at: new Date(fixedNow.getTime() - 65 * 60 * 1000).toISOString(),
      });

      expect(checkDuplicate(db, sampleRequest, 60, fixedNow)).toBe(false);
    });

    it('should return false when duplicate_window_minutes is 0 (disabled)', () => {
      const repos = createRepositories(db);

      repos.paymentRequests.insert({
        id: 'req-disabled-win',
        agent_id: 'agent-1',
        idempotency_key: 'key-dis',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        purpose: 'Server hosting monthly',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 10 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 10 * 60 * 1000).toISOString(),
      });

      expect(checkDuplicate(db, sampleRequest, 0, fixedNow)).toBe(false);
    });

    it('should ignore self when currentRequestId is excluded', () => {
      const repos = createRepositories(db);

      repos.paymentRequests.insert({
        id: 'req-self',
        agent_id: 'agent-1',
        idempotency_key: 'key-self',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        purpose: 'Server hosting monthly',
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
        created_at: new Date(fixedNow.getTime() - 5 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 5 * 60 * 1000).toISOString(),
      });

      // Without exclusion matches itself
      expect(checkDuplicate(db, sampleRequest, 60, fixedNow)).toBe(true);
      // With exclusion ignores self
      expect(checkDuplicate(db, sampleRequest, 60, fixedNow, 'req-self')).toBe(false);
    });
  });

  describe('Full gatherFacts & Policy Engine Integration', () => {
    const fixedNow = new Date('2026-10-29T12:00:00.000Z');

    beforeEach(() => {
      const repos = createRepositories(db);
      repos.agents.insert({
        id: 'agent-1',
        name: 'Honest Agent',
        api_key_hash: 'k1',
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(10000),
        created_at: new Date(fixedNow.getTime() - 48 * 60 * 60 * 1000).toISOString(),
      });
      repos.vendors.insert({
        id: 'vendor-1',
        name: 'Acme Cloud',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'acme_cloud',
        created_at: new Date(fixedNow.getTime() - 48 * 60 * 60 * 1000).toISOString(),
      });
    });

    it('should gather facts and evaluate to ALLOW for standard valid request', () => {
      const facts = gatherFacts(db, sampleRequest, mockPolicy, { now: fixedNow });
      expect(facts.agentStatus).toBe('ACTIVE');
      expect(facts.vendorStatus).toBe('ACTIVE');
      expect(facts.agentSpendRolling24hMinor).toBe(0);
      expect(facts.agentReservedRolling24hMinor).toBe(0);
      expect(facts.recentRequestCountInVelocityWindow).toBe(0);
      expect(facts.hasDuplicateInWindow).toBe(false);

      const decision = evaluatePolicy(sampleRequest, facts, mockPolicy, { now: fixedNow });
      expect(decision.decision).toBe('ALLOW');
      expect(decision.reasons).toEqual([]);
    });

    it('should trigger AGENT_SUSPENDED when agent is missing', () => {
      const missingAgentRequest = { ...sampleRequest, agentId: 'nonexistent-agent' };
      const facts = gatherFacts(db, missingAgentRequest, mockPolicy, { now: fixedNow });
      expect(facts.agentStatus).toBe('SUSPENDED');

      const decision = evaluatePolicy(missingAgentRequest, facts, mockPolicy, { now: fixedNow });
      expect(decision.decision).toBe('DENY');
      expect(decision.reasons).toContain('AGENT_SUSPENDED');
    });

    it('should trigger VENDOR_UNKNOWN when vendor is missing', () => {
      const missingVendorRequest = { ...sampleRequest, vendorId: 'nonexistent-vendor' };
      const facts = gatherFacts(db, missingVendorRequest, mockPolicy, { now: fixedNow });
      expect(facts.vendorStatus).toBe('MISSING');

      const decision = evaluatePolicy(missingVendorRequest, facts, mockPolicy, { now: fixedNow });
      expect(decision.decision).toBe('DENY');
      expect(decision.reasons).toContain('VENDOR_UNKNOWN');
    });

    it('should trigger AGENT_BUDGET_EXCEEDED when rolling spend plus request exceeds budget', () => {
      const repos = createRepositories(db);

      // Insert prior spend of $45.00 (4500 cents) against budget of $50.00 (5000 cents)
      repos.paymentRequests.insert({
        id: 'req-prior-spend',
        agent_id: 'agent-1',
        idempotency_key: 'k-prior',
        vendor_id: 'vendor-1',
        amount_minor: toMinorUnits(4500),
        currency: 'USD',
        purpose: 'Prior big purchase',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      });
      repos.ledger.insert({
        id: 'led-prior-spend',
        request_id: 'req-prior-spend',
        kind: 'SPEND',
        amount_minor: toMinorUnits(4500),
        currency: 'USD',
        created_at: new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      });

      // Sample request is $12.00. 4500 + 1200 = 5700 > 5000 (exceeds daily budget)
      const facts = gatherFacts(db, sampleRequest, mockPolicy, { now: fixedNow });
      expect(facts.agentSpendRolling24hMinor).toBe(4500);

      const decision = evaluatePolicy(sampleRequest, facts, mockPolicy, { now: fixedNow });
      expect(decision.decision).toBe('HOLD');
      expect(decision.reasons).toContain('AGENT_BUDGET_EXCEEDED');
    });

    it('should trigger VELOCITY when recent request count meets or exceeds policy max_requests', () => {
      const repos = createRepositories(db);

      // Insert 5 requests in the last 10 minutes (policy max_requests: 5)
      for (let i = 1; i <= 5; i++) {
        repos.paymentRequests.insert({
          id: `req-rapid-${i}`,
          agent_id: 'agent-1',
          idempotency_key: `key-rapid-${i}`,
          vendor_id: 'vendor-1',
          amount_minor: toMinorUnits(100),
          currency: 'USD',
          purpose: `Rapid task ${i}`,
          category: 'cloud',
          source_context_excerpt: null,
          source_context_hash: null,
          status: 'CAPTURED',
          decision: 'ALLOW',
          reasons: null,
          policy_version_id: null,
          snapshot_hash: null,
          paypal_order_id: null,
          paypal_authorization_id: null,
          paypal_capture_id: null,
          expires_at: null,
          created_at: new Date(fixedNow.getTime() - i * 60 * 1000).toISOString(),
          updated_at: new Date(fixedNow.getTime() - i * 60 * 1000).toISOString(),
        });
      }

      const facts = gatherFacts(db, sampleRequest, mockPolicy, { now: fixedNow });
      expect(facts.recentRequestCountInVelocityWindow).toBe(5);

      const decision = evaluatePolicy(sampleRequest, facts, mockPolicy, { now: fixedNow });
      expect(decision.decision).toBe('HOLD');
      expect(decision.reasons).toContain('VELOCITY');
    });

    it('should trigger DUPLICATE when same vendor, amount, purpose occurs in duplicate window', () => {
      const repos = createRepositories(db);

      repos.paymentRequests.insert({
        id: 'req-dup-match',
        agent_id: 'agent-1',
        idempotency_key: 'key-dup-original',
        vendor_id: 'vendor-1',
        amount_minor: sampleRequest.amountMinor,
        currency: sampleRequest.currency,
        purpose: sampleRequest.purpose,
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: null,
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: new Date(fixedNow.getTime() - 15 * 60 * 1000).toISOString(),
        updated_at: new Date(fixedNow.getTime() - 15 * 60 * 1000).toISOString(),
      });

      const facts = gatherFacts(db, sampleRequest, mockPolicy, { now: fixedNow });
      expect(facts.hasDuplicateInWindow).toBe(true);

      const decision = evaluatePolicy(sampleRequest, facts, mockPolicy, { now: fixedNow });
      expect(decision.decision).toBe('HOLD');
      expect(decision.reasons).toContain('DUPLICATE');
    });
  });
});
