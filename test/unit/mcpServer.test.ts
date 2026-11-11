/**
 * PayGuard — Milestone M3: MCP Integration
 * Unit Tests: M3-T2 MCP Server Skeleton over Streamable HTTP (/mcp) & Per-Session Security
 *
 * Covers:
 * - Basic HTTP endpoint behavior (/healthz, /mcp authentication)
 * - SDK Client connection and tool listing
 * - 10 Session Isolation & Security Regression Tests:
 *   1. Agent A establishes a session successfully.
 *   2. Agent B independently establishes another session successfully.
 *   3. Both agents can use their own sessions concurrently.
 *   4. Agent B cannot use Agent A's session ID (returns HTTP 403 Forbidden).
 *   5. Agent A cannot use Agent B's session ID (returns HTTP 403 Forbidden).
 *   6. Invalid credentials cannot use an established session (returns HTTP 401 Unauthorized).
 *   7. Suspending an agent blocks subsequent requests even with its existing session (returns HTTP 403 Forbidden).
 *   8. Closing a session (DELETE / terminateSession) cleans up its registry entry.
 *   9. Unknown session IDs are rejected (returns HTTP 404 Not Found).
 *   10. Idle session eviction cleans up expired sessions without resource leaks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { createPayGuardMcpServer, type PayGuardMcpServerInstance } from '../../src/mcp/server.js';
import { generateAgentKey } from '../../src/mcp/auth.js';
import { toMinorUnits } from '../../src/core/money.js';
import { loadConfig } from '../../src/config/index.js';
import { decryptReplyMarkup } from '../../src/telegram/crypto.js';
import type { TelegramClient } from '../../src/telegram/client.js';
import type { AgentRow } from '../../src/db/types.js';

describe('M3-T2: MCP Server Skeleton & Per-Session Security Isolation', () => {
  let db: Database;
  let repos: Repositories;
  let mcpServer: PayGuardMcpServerInstance;
  let serverPort = 0;
  let serverClose: () => Promise<void>;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);

    mcpServer = createPayGuardMcpServer({ db, repos });
    const started = await mcpServer.start(0); // Port 0 binds to dynamic free port
    serverPort = started.port;
    serverClose = started.close;
  });

  afterEach(async () => {
    if (serverClose) {
      await serverClose();
    }
    db.close();
  });

  function seedAgent(overrides?: Partial<AgentRow>): { agent: AgentRow; rawKey: string } {
    const { rawKey, keyHash } = generateAgentKey();
    const agent: AgentRow = {
      id: overrides?.id ?? `agent-${crypto.randomUUID()}`,
      name: overrides?.name ?? 'Test Agent',
      api_key_hash: overrides?.api_key_hash ?? keyHash,
      status: overrides?.status ?? 'ACTIVE',
      daily_budget_minor: overrides?.daily_budget_minor ?? toMinorUnits(5000),
      created_at: new Date().toISOString(),
      ...overrides,
    };
    repos.agents.insert(agent);
    return { agent, rawKey };
  }

  async function createConnectedClient(rawKey: string): Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport;
  }> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${serverPort}/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${rawKey}`,
          },
        },
      }
    );
    const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
    await client.connect(transport);
    return { client, transport };
  }

  // ============================================================================
  // Baseline Endpoint Tests
  // ============================================================================

  it('Baseline: Public health check /healthz responds with service metadata without credentials', async () => {
    const res = await fetch(`http://localhost:${serverPort}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string; tools: number };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('payguard-mcp');
    expect(body.tools).toBe(4);
  });

  it('Baseline: Unauthenticated request to /mcp returns 401 Unauthorized', async () => {
    const res = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Unauthorized');
  });

  it('Baseline: Suspended agent request to /mcp returns 403 Forbidden', async () => {
    const { rawKey } = seedAgent({ status: 'SUSPENDED' });

    const res = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${rawKey}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('suspended');
  });

  // ============================================================================
  // 10 Security & Session Isolation Regression Tests
  // ============================================================================

  it('Test 1: Agent A establishes a session successfully', async () => {
    const { agent: agentA, rawKey: rawKeyA } = seedAgent({ name: 'Agent A' });
    const { client, transport } = await createConnectedClient(rawKeyA);

    const sessionIdA = transport.sessionId;
    expect(sessionIdA).toBeDefined();
    expect(typeof sessionIdA).toBe('string');
    expect(sessionIdA!.length).toBeGreaterThan(0);

    // Verify session registered in server
    expect(mcpServer.getActiveSessionCount()).toBe(1);
    const sessionRecord = mcpServer.getSession(sessionIdA!);
    expect(sessionRecord).toBeDefined();
    expect(sessionRecord?.agentId).toBe(agentA.id);

    // Verify basic operation
    const serverVersion = client.getServerVersion();
    expect(serverVersion?.name).toBe('payguard');

    await client.close();
  });

  it('Test 2: Agent B independently establishes another session successfully', async () => {
    const { agent: agentA, rawKey: rawKeyA } = seedAgent({ name: 'Agent A' });
    const { agent: agentB, rawKey: rawKeyB } = seedAgent({ name: 'Agent B' });

    const { client: clientA, transport: transportA } = await createConnectedClient(rawKeyA);
    const { client: clientB, transport: transportB } = await createConnectedClient(rawKeyB);

    const sessionA = transportA.sessionId;
    const sessionB = transportB.sessionId;

    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    expect(sessionA).not.toBe(sessionB);

    expect(mcpServer.getActiveSessionCount()).toBe(2);
    expect(mcpServer.getSession(sessionA!)?.agentId).toBe(agentA.id);
    expect(mcpServer.getSession(sessionB!)?.agentId).toBe(agentB.id);

    await clientA.close();
    await clientB.close();
  });

  it('Test 3: Both agents can use their own sessions concurrently', async () => {
    const { rawKey: rawKeyA } = seedAgent({ name: 'Agent A' });
    const { rawKey: rawKeyB } = seedAgent({ name: 'Agent B' });

    const { client: clientA } = await createConnectedClient(rawKeyA);
    const { client: clientB } = await createConnectedClient(rawKeyB);

    // Concurrent tool listing
    const [toolsA, toolsB] = await Promise.all([clientA.listTools(), clientB.listTools()]);

    expect(toolsA.tools.length).toBe(4);
    expect(toolsB.tools.length).toBe(4);

    // Concurrent tool execution
    const [callA, callB] = await Promise.all([
      clientA.callTool({ name: 'list_vendors', arguments: {} }),
      clientB.callTool({ name: 'list_vendors', arguments: {} }),
    ]);

    expect(callA.content).toBeDefined();
    expect(callB.content).toBeDefined();
    const textA = (callA.content as Array<{ text: string }>)[0]?.text;
    const textB = (callB.content as Array<{ text: string }>)[0]?.text;
    expect(textA).toContain('vendors');
    expect(textB).toContain('vendors');

    await clientA.close();
    await clientB.close();
  });

  it("Test 4: Agent B cannot use Agent A's session ID (returns HTTP 403 Forbidden)", async () => {
    const { rawKey: rawKeyA } = seedAgent({ name: 'Agent A' });
    const { rawKey: rawKeyB } = seedAgent({ name: 'Agent B' });

    const { client: clientA, transport: transportA } = await createConnectedClient(rawKeyA);
    const sessionA = transportA.sessionId!;

    // Agent B tries to access Agent A's session ID
    const res = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${rawKeyB}`,
        'mcp-session-id': sessionA,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32003);
    expect(body.error.message).toContain('Forbidden: Session belongs to another agent');

    await clientA.close();
  });

  it("Test 5: Agent A cannot use Agent B's session ID (returns HTTP 403 Forbidden)", async () => {
    const { rawKey: rawKeyA } = seedAgent({ name: 'Agent A' });
    const { rawKey: rawKeyB } = seedAgent({ name: 'Agent B' });

    const { client: clientB, transport: transportB } = await createConnectedClient(rawKeyB);
    const sessionB = transportB.sessionId!;

    // Agent A tries to access Agent B's session ID
    const res = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${rawKeyA}`,
        'mcp-session-id': sessionB,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32003);
    expect(body.error.message).toContain('Forbidden: Session belongs to another agent');

    await clientB.close();
  });

  it('Test 6: Invalid credentials cannot use an established session (returns HTTP 401 Unauthorized)', async () => {
    const { rawKey: rawKeyA } = seedAgent({ name: 'Agent A' });
    const { client: clientA, transport: transportA } = await createConnectedClient(rawKeyA);
    const sessionA = transportA.sessionId!;

    // 1. Invalid bearer token with valid session ID
    const res1 = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer invalid-token-forged-key',
        'mcp-session-id': sessionA,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res1.status).toBe(401);
    const body1 = (await res1.json()) as { error: { message: string } };
    expect(body1.error.message).toContain('Unauthorized');

    // 2. Missing authorization header with valid session ID
    const res2 = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionA,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 104,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res2.status).toBe(401);
    const body2 = (await res2.json()) as { error: { message: string } };
    expect(body2.error.message).toContain('Missing Authorization header');

    await clientA.close();
  });

  it('Test 7: Suspending an agent blocks subsequent requests even with its existing session (returns HTTP 403 Forbidden)', async () => {
    const { agent: agentA, rawKey: rawKeyA } = seedAgent({ name: 'Agent A' });
    const { client: clientA, transport: transportA } = await createConnectedClient(rawKeyA);
    const sessionA = transportA.sessionId!;

    // Verify session is initially operational
    const toolsBefore = await clientA.listTools();
    expect(toolsBefore.tools.length).toBe(4);

    // Admin suspends the agent in SQLite
    repos.agents.updateStatus(agentA.id, 'SUSPENDED');

    // Subsequent request using existing session must be rejected with 403 Forbidden
    const res = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${rawKeyA}`,
        'mcp-session-id': sessionA,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 105,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Agent account is suspended');

    await clientA.close();
  });

  it('Test 8: Closing a session (DELETE / terminateSession) cleans up its registry entry', async () => {
    const { rawKey: rawKeyA } = seedAgent({ name: 'Agent A' });
    const { client: clientA, transport: transportA } = await createConnectedClient(rawKeyA);
    const sessionA = transportA.sessionId!;

    expect(mcpServer.getActiveSessionCount()).toBe(1);

    // Client explicitly terminates session via HTTP DELETE
    await transportA.terminateSession();

    // Registry entry must be cleaned up
    expect(mcpServer.getActiveSessionCount()).toBe(0);
    expect(mcpServer.getSession(sessionA)).toBeUndefined();

    // Subsequent request with the closed session ID returns 404
    const res = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${rawKeyA}`,
        'mcp-session-id': sessionA,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 106,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('Session not found or expired');

    await clientA.close();
  });

  it('Test 9: Unknown session IDs are rejected (returns HTTP 404 Not Found)', async () => {
    const { rawKey: rawKeyA } = seedAgent({ name: 'Agent A' });
    const forgedSessionId = crypto.randomUUID();

    const res = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${rawKeyA}`,
        'mcp-session-id': forgedSessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 107,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain('Not Found: Session not found or expired');
  });

  it('Test 10: Idle session eviction cleans up expired sessions without resource leaks', async () => {
    const { rawKey: rawKeyA } = seedAgent({ name: 'Agent A' });
    const { client: clientA, transport: transportA } = await createConnectedClient(rawKeyA);
    const sessionA = transportA.sessionId!;

    expect(mcpServer.getActiveSessionCount()).toBe(1);

    // Fast-forward or trigger cleanup with maxIdleAgeMs = 0 (immediately expired)
    mcpServer.cleanupExpiredSessions(0);

    // Active session count should drop to 0
    expect(mcpServer.getActiveSessionCount()).toBe(0);
    expect(mcpServer.getSession(sessionA)).toBeUndefined();

    // Subsequent request with expired session returns 404
    const res = await fetch(`http://localhost:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${rawKeyA}`,
        'mcp-session-id': sessionA,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 108,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(res.status).toBe(404);
    await clientA.close();
  });

  // ============================================================================
  // M4-T4 Runtime Worker Lifecycle Integration Tests
  // ============================================================================

  describe('M4-T4: Runtime Worker Lifecycle Integration', () => {
    it('1. Workers start automatically when server starts and stop when server closes', async () => {
      // In beforeEach, mcpServer was already started
      expect(mcpServer.holdExpiryWorker).toBeDefined();
      expect(mcpServer.reconcilerWorker).toBeDefined();
      expect(mcpServer.holdExpiryWorker.isRunning()).toBe(true);
      expect(mcpServer.reconcilerWorker.isRunning()).toBe(true);

      // Close server
      await serverClose();

      expect(mcpServer.holdExpiryWorker.isRunning()).toBe(false);
      expect(mcpServer.reconcilerWorker.isRunning()).toBe(false);
    });

    it('2. Repeated start() calls do not create duplicate workers or throw errors', async () => {
      expect(mcpServer.holdExpiryWorker.isRunning()).toBe(true);
      expect(mcpServer.reconcilerWorker.isRunning()).toBe(true);

      const secondStart = await mcpServer.start(serverPort);
      expect(secondStart.port).toBe(serverPort);
      expect(mcpServer.holdExpiryWorker.isRunning()).toBe(true);
      expect(mcpServer.reconcilerWorker.isRunning()).toBe(true);

      // Both should stop cleanly on close
      await mcpServer.close();
      expect(mcpServer.holdExpiryWorker.isRunning()).toBe(false);
      expect(mcpServer.reconcilerWorker.isRunning()).toBe(false);
    });

    it('3. Repeated close() calls are idempotent and safe', async () => {
      await mcpServer.close();
      expect(mcpServer.holdExpiryWorker.isRunning()).toBe(false);
      expect(mcpServer.reconcilerWorker.isRunning()).toBe(false);

      // Second close call must not throw
      await expect(mcpServer.close()).resolves.toBeUndefined();
      expect(mcpServer.holdExpiryWorker.isRunning()).toBe(false);
      expect(mcpServer.reconcilerWorker.isRunning()).toBe(false);
    });

    it('4. Startup failure (e.g. port conflict) cleans up workers and does not leave orphaned timers', async () => {
      // Create a second server trying to bind to the exact same port
      const duplicateServer = createPayGuardMcpServer({ db, repos });

      await expect(duplicateServer.start(serverPort)).rejects.toThrow();

      // Workers on the failed server instance should be stopped
      expect(duplicateServer.holdExpiryWorker.isRunning()).toBe(false);
      expect(duplicateServer.reconcilerWorker.isRunning()).toBe(false);
    });

    it('5. Worker interval options and logger are passed to worker instances', async () => {
      const logs: string[] = [];
      const testLogger = {
        info: (msg: string) => { logs.push(msg); },
        warn: (msg: string) => { logs.push(msg); },
        error: (msg: string) => { logs.push(msg); },
      };

      const customServer = createPayGuardMcpServer({
        db,
        repos,
        holdExpiryWorkerIntervalMs: 5_000,
        reconcilerWorkerIntervalMs: 10_000,
        logger: testLogger,
      });

      const started = await customServer.start(0);
      try {
        expect(customServer.holdExpiryWorker.isRunning()).toBe(true);
        expect(customServer.reconcilerWorker.isRunning()).toBe(true);
        expect(logs.some((l) => l.includes('5000ms'))).toBe(true);
        expect(logs.some((l) => l.includes('10000ms'))).toBe(true);
      } finally {
        await started.close();
      }

      expect(customServer.holdExpiryWorker.isRunning()).toBe(false);
      expect(customServer.reconcilerWorker.isRunning()).toBe(false);
    });

    it('6. Passes db to NotificationOutboxWorker so exhausted/invalid terminal re-attestation persists audit log', async () => {
      const nowIso = new Date().toISOString();
      const linkedAt = nowIso;

      repos.owners.upsert({
        id: 'default',
        display_name: 'Owner',
        passphrase_hash: 'hash',
        telegram_chat_id: '11223344',
        telegram_user_id: '11223344',
        telegram_linked_at: linkedAt,
        created_at: nowIso,
      });

      const { agent } = seedAgent({ id: 'agent-outbox-audit' });
      repos.vendors.insert({
        id: 'ven-outbox-audit',
        name: 'Audit Vendor',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'audit_vendor',
        created_at: nowIso,
      });
      repos.policyVersions.insert({
        id: 'pol-outbox-audit',
        version: 1,
        rules: JSON.stringify({
          version: 1,
          currency_allowlist: ['USD'],
          auto_limit_minor: toMinorUnits(2500),
          hard_cap_minor: toMinorUnits(10000),
          agent_daily_budget_minor: toMinorUnits(10000),
          global_daily_budget_minor: toMinorUnits(50000),
          velocity: { max_requests: 5, window_minutes: 10 },
          duplicate_window_minutes: 60,
          new_vendor_action: 'HOLD',
          hold_ttl_minutes: 15,
        }),
        author: 'owner',
        active: 1,
        created_at: nowIso,
      });
      repos.paymentRequests.insert({
        id: 'req-reattest-audit',
        agent_id: agent.id,
        idempotency_key: 'idem-reattest-audit',
        vendor_id: 'ven-outbox-audit',
        amount_minor: toMinorUnits(1500),
        currency: 'USD',
        purpose: 'Test outbox db wiring',
        category: null,
        source_context_excerpt: null,
        source_context_hash: null,
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: null,
        policy_version_id: 'pol-outbox-audit',
        snapshot_hash: null,
        paypal_order_id: null,
        paypal_authorization_id: null,
        paypal_capture_id: null,
        expires_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      });

      // Terminal re-attestation row without valid telegram_message_id triggers immediate exhaustion & audit log
      repos.notifications.enqueue({
        id: 'out-reattest-missing-msgid',
        owner_id: 'default',
        request_id: 'req-reattest-audit',
        event_type: 'PAYMENT_CAPTURED',
        dedup_key: 'terminal_reattest:req-reattest-audit:p1',
        recipient_chat_id: '11223344',
        linked_at: linkedAt,
        message_text: 'Terminal re-attestation',
        parse_mode: 'HTML',
        reply_markup_enc: null,
        telegram_message_id: null,
        max_attempts: 3,
        next_attempt_at: nowIso,
        created_at: nowIso,
      });

      const mockTgClient = {
        sendMessage: vi.fn(),
        editMessageText: vi.fn(),
      } as unknown as TelegramClient;

      const tgConfig = loadConfig({
        NODE_ENV: 'test',
        SESSION_SECRET: 'test-secret-at-least-32-chars-long-1234',
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_BOT_TOKEN: '123456:ABC',
      });

      const tgServer = createPayGuardMcpServer({
        db,
        repos,
        config: tgConfig,
        telegramClient: mockTgClient,
        notificationOutboxWorkerIntervalMs: 60_000,
      });

      expect(tgServer.notificationOutboxWorker).toBeDefined();
      const processed = await tgServer.notificationOutboxWorker!.tick();
      expect(processed).toBe(1);

      const updatedOutbox = repos.notifications.getById('out-reattest-missing-msgid');
      expect(updatedOutbox?.status).toBe('DEAD');

      const exhaustedAudit = repos.auditLog
        .list()
        .find((a) => a.event === 'TELEGRAM_TERMINAL_RE_ATTESTATION_EXHAUSTED');
      expect(exhaustedAudit).toBeDefined();
      expect(exhaustedAudit?.request_id).toBe('req-reattest-audit');

      await tgServer.close();
    });

    it('7. MCP request_payment forwards config publicBaseUrl, isProduction, and telegramEncryptionKey', async () => {
      const nowIso = new Date().toISOString();
      const encKey = crypto.randomBytes(32).toString('hex');

      repos.owners.upsert({
        id: 'default',
        display_name: 'Owner',
        passphrase_hash: 'hash',
        telegram_chat_id: '99112233',
        telegram_user_id: '99112233',
        telegram_linked_at: nowIso,
        created_at: nowIso,
      });

      const { rawKey } = seedAgent({
        id: 'agent-mcp-cfg',
        daily_budget_minor: toMinorUnits(20000),
      });

      repos.vendors.insert({
        id: 'ven-mcp-cfg',
        name: 'Unverified MCP Vendor',
        status: 'UNVERIFIED',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'unverified_mcp_vendor',
        created_at: nowIso,
      });

      repos.policyVersions.insert({
        id: 'pol-mcp-cfg',
        version: 1,
        rules: JSON.stringify({
          version: 1,
          currency_allowlist: ['USD'],
          auto_limit_minor: toMinorUnits(2500),
          hard_cap_minor: toMinorUnits(10000),
          agent_daily_budget_minor: toMinorUnits(20000),
          global_daily_budget_minor: toMinorUnits(50000),
          velocity: { max_requests: 10, window_minutes: 10 },
          duplicate_window_minutes: 60,
          new_vendor_action: 'HOLD',
          hold_ttl_minutes: 15,
        }),
        author: 'owner',
        active: 1,
        created_at: nowIso,
      });

      const prodCfg = loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'prod-secret-at-least-32-chars-long-1234',
        PUBLIC_BASE_URL: 'https://guard.prod.example/',
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_BOT_TOKEN: '123456:ABC',
        TELEGRAM_ENCRYPTION_KEY: encKey,
      });

      const cfgServer = createPayGuardMcpServer({
        db,
        repos,
        config: prodCfg,
        telegramClient: { sendMessage: vi.fn() } as unknown as TelegramClient,
        secureCookie: false,
      });

      const started = await cfgServer.start(0);
      try {
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://localhost:${started.port}/mcp`),
          {
            requestInit: {
              headers: {
                Authorization: `Bearer ${rawKey}`,
              },
            },
          }
        );
        const client = new Client({ name: 'test-cfg-client', version: '1.0.0' });
        await client.connect(transport);

        const toolRes = await client.callTool({
          name: 'request_payment',
          arguments: {
            vendor_id: 'ven-mcp-cfg',
            amount: '30.00',
            currency: 'USD',
            purpose: 'Config forwarding over MCP',
            idempotency_key: 'idem-mcp-cfg-1',
          },
        });

        const parsed = JSON.parse(
          (toolRes.content as Array<{ text: string }>)[0]!.text
        ) as { request_id: string; status: string };
        expect(parsed.status).toBe('HELD');

        const outboxRow = repos.notifications.getByDedupKey(`payment_held:${parsed.request_id}`)!;
        expect(outboxRow).toBeDefined();
        expect(outboxRow.message_text).toContain(
          `href="https://guard.prod.example/#/requests/${parsed.request_id}"`
        );
        expect(outboxRow.reply_markup_enc).toBeTruthy();

        const decrypted = decryptReplyMarkup(
          outboxRow.reply_markup_enc!,
          {
            outboxId: outboxRow.id,
            ownerId: outboxRow.owner_id,
            requestId: parsed.request_id,
            recipientChatId: outboxRow.recipient_chat_id,
            linkedAt: outboxRow.linked_at,
          },
          encKey
        );
        expect(decrypted.inline_keyboard[0]).toHaveLength(2);

        await client.close();
      } finally {
        await started.close();
      }
    });
  });
});
