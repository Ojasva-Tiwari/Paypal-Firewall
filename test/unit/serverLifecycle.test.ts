/**
 * PayGuard — Milestone M6: Full-System QA and Reliability
 * M6-T2: Server Entrypoint & Process Lifecycle Unit & Integration Tests
 *
 * Covers:
 * 1. Successful startup on dynamic port and /healthz reachability
 * 2. Invalid configuration rejection before database initialization
 * 3. Migration failure handling and resource cleanup
 * 4. HTTP bind failure (EADDRINUSE) and complete cleanup
 * 5. Single worker initialization and proper shutdown
 * 6. Graceful shutdown and SQLite WAL checkpointing
 * 7. Idempotent shutdown (multiple stop() calls)
 * 8. Express trust proxy configuration
 * 9. Signal handler registration and unregistration
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, type RunningServer } from '../../src/server.js';
import { ConfigError } from '../../src/config/index.js';
import * as dbModule from '../../src/db/connection.js';
import { PayPalAuthorizationsService } from '../../src/paypal/authorizations.js';
import { hashOwnerPassphrase, OwnerSessionStore, OWNER_COOKIE_NAME } from '../../src/auth/owner.js';
import { createRepositories } from '../../src/db/repositories.js';
import { createPayGuardMcpServer } from '../../src/mcp/server.js';
import { mintApprovalToken } from '../../src/approvals/tokens.js';
import { toMinorUnits } from '../../src/core/money.js';
import { computeSnapshotHash } from '../../src/core/service.js';

describe('M6-T2: Server Entrypoint & Process Lifecycle (src/server.ts)', () => {
  let activeServer: RunningServer | null = null;
  const tempDbPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    if (activeServer) {
      try {
        await activeServer.stop();
      } catch {
        // Ignore errors in cleanup
      }
      activeServer = null;
    }

    // Clean up temporary databases
    for (const p of tempDbPaths) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
        const walPath = `${p}-wal`;
        const shmPath = `${p}-shm`;
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
        if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      } catch {
        // Ignore cleanup errors
      }
    }
    tempDbPaths.length = 0;
  });

  describe('1. Successful Startup & Lifecycle', () => {
    it('starts successfully on dynamic port with in-memory database and responds to /healthz', async () => {
      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: ':memory:',
          NODE_ENV: 'test',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });

      expect(activeServer.port).toBeGreaterThan(0);
      expect(activeServer.db.open).toBe(true);

      // Verify health check responds
      const response = await fetch(`http://localhost:${activeServer.port}/healthz`);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toMatchObject({
        status: 'ok',
        service: 'payguard-mcp',
        tools: 4,
      });

      // Verify clean stop
      await activeServer.stop();
      expect(activeServer.db.open).toBe(false);
      activeServer = null;
    });
  });

  describe('2. Configuration Validation Before Service Initialization', () => {
    it('aborts startup and throws ConfigError on invalid PORT without touching database', async () => {
      const createDbSpy = vi.spyOn(dbModule, 'createDatabase');

      await expect(
        startServer({
          env: {
            PORT: '999999', // Invalid port number
            DATABASE_PATH: ':memory:',
          },
          registerSignalHandlers: false,
        })
      ).rejects.toThrow(ConfigError);

      expect(createDbSpy).not.toHaveBeenCalled();
    });

    it('aborts startup if PAYPAL_ENV=PRODUCTION without ALLOW_PRODUCTION=true', async () => {
      const createDbSpy = vi.spyOn(dbModule, 'createDatabase');

      await expect(
        startServer({
          env: {
            PAYPAL_ENV: 'PRODUCTION',
            ALLOW_PRODUCTION: 'false',
            DATABASE_PATH: ':memory:',
          },
          registerSignalHandlers: false,
        })
      ).rejects.toThrow(ConfigError);

      expect(createDbSpy).not.toHaveBeenCalled();
    });
  });

  describe('3. Partial Startup Failure & Resource Cleanup', () => {
    it('cleans up and closes database if runMigrations fails during startup', async () => {
      const runMigrationsSpy = vi
        .spyOn(dbModule, 'runMigrations')
        .mockImplementationOnce(() => {
          throw new Error('Simulated migration disk failure');
        });

      let capturedDb: dbModule.Database | null = null;
      const originalCreateDatabase = dbModule.createDatabase;
      vi.spyOn(dbModule, 'createDatabase').mockImplementation((opts) => {
        const db = originalCreateDatabase(opts);
        capturedDb = db;
        return db;
      });

      await expect(
        startServer({
          port: 0,
          env: {
            DATABASE_PATH: ':memory:',
            NODE_ENV: 'test',
            SESSION_SECRET: 'test-session-secret-min16chars',
          },
          registerSignalHandlers: false,
        })
      ).rejects.toThrow('Simulated migration disk failure');

      expect(runMigrationsSpy).toHaveBeenCalledTimes(1);
      expect(capturedDb).not.toBeNull();
      // Database must have been safely closed during cleanup
      expect(capturedDb!.open).toBe(false);
    });

    it('cleans up database and workers if HTTP listen fails (e.g. port collision)', async () => {
      // Create a blocking server on a chosen port
      const blockingServer = http.createServer();
      const occupiedPort = await new Promise<number>((resolve) => {
        blockingServer.listen(0, () => {
          const addr = blockingServer.address();
          resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
        });
      });

      let capturedDb: dbModule.Database | null = null;
      const originalCreateDatabase = dbModule.createDatabase;
      vi.spyOn(dbModule, 'createDatabase').mockImplementation((opts) => {
        const db = originalCreateDatabase(opts);
        capturedDb = db;
        return db;
      });

      try {
        await expect(
          startServer({
            port: occupiedPort,
            env: {
              DATABASE_PATH: ':memory:',
              NODE_ENV: 'test',
              SESSION_SECRET: 'test-session-secret-min16chars',
            },
            registerSignalHandlers: false,
          })
        ).rejects.toThrow();

        expect(capturedDb).not.toBeNull();
        expect(capturedDb!.open).toBe(false);
      } finally {
        await new Promise<void>((resolve) => blockingServer.close(() => resolve()));
      }
    });
  });

  describe('4. Worker Initialization & Single Lifecycle', () => {
    it('initializes and starts background workers exactly once', async () => {
      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: ':memory:',
          NODE_ENV: 'test',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });

      const { holdExpiryWorker, reconcilerWorker } = activeServer.mcpServer;

      // Workers should be running
      expect(holdExpiryWorker.isRunning()).toBe(true);
      expect(reconcilerWorker.isRunning()).toBe(true);

      // Stop server
      await activeServer.stop();

      // Workers should be stopped
      expect(holdExpiryWorker.isRunning()).toBe(false);
      expect(reconcilerWorker.isRunning()).toBe(false);

      activeServer = null;
    });
  });

  describe('5. Graceful Shutdown & WAL Checkpointing', () => {
    it('checkpoints WAL on a file-backed database during graceful stop', async () => {
      const dbPath = path.resolve(process.cwd(), `test_lifecycle_${Date.now()}.db`);
      tempDbPaths.push(dbPath);

      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: dbPath,
          NODE_ENV: 'test',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });

      expect(fs.existsSync(dbPath)).toBe(true);
      const pragmaSpy = vi.spyOn(activeServer.db, 'pragma');

      await activeServer.stop();

      // Verify WAL checkpoint was requested
      expect(pragmaSpy).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
      expect(activeServer.db.open).toBe(false);
      activeServer = null;
    });

    it('idempotently handles repeated stop() calls without throwing', async () => {
      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: ':memory:',
          NODE_ENV: 'test',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });

      // Concurrent stop calls
      const [res1, res2, res3] = await Promise.allSettled([
        activeServer.stop(),
        activeServer.stop(),
        activeServer.stop(),
      ]);

      expect(res1.status).toBe('fulfilled');
      expect(res2.status).toBe('fulfilled');
      expect(res3.status).toBe('fulfilled');
      expect(activeServer.db.open).toBe(false);

      activeServer = null;
    });
  });

  describe('6. Express Trust Proxy Configuration', () => {
    it('sets trust proxy to false by default', async () => {
      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: ':memory:',
          NODE_ENV: 'test',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });

      expect(activeServer.mcpServer.app.get('trust proxy')).toBe(false);
    });

    it('sets trust proxy to numeric hop count when TRUST_PROXY is an integer', async () => {
      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: ':memory:',
          NODE_ENV: 'test',
          TRUST_PROXY: '1',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });

      expect(activeServer.mcpServer.app.get('trust proxy')).toBe(1);
    });

    it('sets trust proxy to string when TRUST_PROXY is loopback or CIDR', async () => {
      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: ':memory:',
          NODE_ENV: 'test',
          TRUST_PROXY: 'loopback',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });

      expect(activeServer.mcpServer.app.get('trust proxy')).toBe('loopback');
    });
  });

  describe('7. Signal Handler Registration & Cleanup', () => {
    it('registers signal listeners when registerSignalHandlers=true and unregisters on stop', async () => {
      const initialSigint = process.listenerCount('SIGINT');
      const initialSigterm = process.listenerCount('SIGTERM');

      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: ':memory:',
          NODE_ENV: 'test',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: true,
      });

      expect(process.listenerCount('SIGINT')).toBe(initialSigint + 1);
      expect(process.listenerCount('SIGTERM')).toBe(initialSigterm + 1);

      await activeServer.stop();

      expect(process.listenerCount('SIGINT')).toBe(initialSigint);
      expect(process.listenerCount('SIGTERM')).toBe(initialSigterm);
      activeServer = null;
    });
  });

  describe('8. M6-T5 Worker Interval & Graceful Shutdown Drain Guarantees', () => {
    it('uses canonical 30-second interval for HoldExpiryWorker regardless of HOLD_TTL_MINUTES', async () => {
      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: ':memory:',
          NODE_ENV: 'test',
          HOLD_TTL_MINUTES: '1',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });
      expect(activeServer.mcpServer.holdExpiryWorker.getIntervalMs()).toBe(30_000);
      await activeServer.stop();
      activeServer = null;

      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: ':memory:',
          NODE_ENV: 'test',
          HOLD_TTL_MINUTES: '120',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });
      expect(activeServer.mcpServer.holdExpiryWorker.getIntervalMs()).toBe(30_000);
    });

    it('awaits pending worker PayPal HTTP calls before WAL checkpoint and SQLite close', async () => {
      const dbPath = path.resolve(process.cwd(), `test_graceful_worker_drain_${Date.now()}.db`);
      tempDbPaths.push(dbPath);

      let releaseVoid!: () => void;
      const voidStarted = new Promise<void>((resolve) => {
        vi.spyOn(PayPalAuthorizationsService.prototype, 'voidAuthorization').mockImplementation(
          async (input) => {
            resolve();
            await new Promise<void>((r) => {
              releaseVoid = r;
            });
            return {
              id: input.authorizationId,
              status: 'VOIDED',
              isVoided: true,
            };
          }
        );
      });

      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: dbPath,
          NODE_ENV: 'test',
          CONNECTOR_ACME_CLIENT_ID: 'sb-client-id-123',
          CONNECTOR_ACME_CLIENT_SECRET: 'sb-client-secret-123',
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });

      const nowIso = new Date().toISOString();
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      activeServer.repos.policyVersions.insert({
        id: 'pol-drain-1',
        version: 1,
        rules: JSON.stringify({ version: 1 }),
        author: 'owner',
        active: 1,
        created_at: nowIso,
      });
      activeServer.repos.vendors.insert({
        id: 'ven-drain-1',
        name: 'Drain Test Vendor',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'acme_cloud',
        created_at: nowIso,
      });
      activeServer.repos.agents.insert({
        id: 'agent-drain-1',
        name: 'Drain Test Agent',
        api_key_hash: crypto.createHash('sha256').update('secret-drain').digest('hex'),
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(10000),
        created_at: nowIso,
      });
      activeServer.repos.paymentRequests.insert({
        id: 'req-drain-worker-1',
        agent_id: 'agent-drain-1',
        idempotency_key: 'idem-drain-worker-1',
        vendor_id: 'ven-drain-1',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        purpose: 'Graceful shutdown drain test',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        policy_version_id: 'pol-drain-1',
        snapshot_hash: computeSnapshotHash({
          requestId: 'req-drain-worker-1',
          agentId: 'agent-drain-1',
          vendorId: 'ven-drain-1',
          amountMinor: toMinorUnits(1200),
          currency: 'USD',
          purpose: 'Graceful shutdown drain test',
          category: 'cloud',
        }),
        status: 'HELD',
        decision: 'HOLD',
        reasons: JSON.stringify(['REQUIRE_OWNER_APPROVAL']),
        paypal_order_id: 'ORD-DRAIN-1',
        paypal_authorization_id: 'AUTH-DRAIN-1',
        paypal_capture_id: null,
        remote_void_status: null,
        expires_at: pastIso,
        created_at: pastIso,
        updated_at: pastIso,
      });
      activeServer.repos.ledger.insert({
        id: 'led-drain-1',
        request_id: 'req-drain-worker-1',
        kind: 'RESERVE',
        amount_minor: toMinorUnits(1200),
        currency: 'USD',
        created_at: pastIso,
      });

      const pragmaSpy = vi.spyOn(activeServer.db, 'pragma');

      // Start an in-flight worker tick that blocks inside PayPal voidAuthorization HTTP call
      const tickPromise = activeServer.mcpServer.holdExpiryWorker.tick();
      await voidStarted;

      let stopSettled = false;
      const stopPromise = activeServer.stop().then(() => {
        stopSettled = true;
      });

      await new Promise((r) => setTimeout(r, 40));
      expect(stopSettled).toBe(false);
      expect(activeServer.db.open).toBe(true);
      expect(pragmaSpy).not.toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');

      // Release PayPal HTTP call and allow post-HTTP SQLite update + WAL checkpoint + close
      releaseVoid();
      await Promise.all([tickPromise, stopPromise]);

      expect(stopSettled).toBe(true);
      expect(pragmaSpy).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)');
      expect(activeServer.db.open).toBe(false);

      // Reopen file-backed SQLite DB to verify remote_void_status = CONFIRMED persisted safely
      const reopened = dbModule.createDatabase({ path: dbPath });
      try {
        const row = reopened
          .prepare('SELECT status, remote_void_status FROM payment_requests WHERE id = ?')
          .get('req-drain-worker-1') as { status: string; remote_void_status: string } | undefined;
        expect(row).toEqual({
          status: 'VOIDED',
          remote_void_status: 'CONFIRMED',
        });
      } finally {
        reopened.close();
      }
      activeServer = null;
    });

    it('tracks and awaits lazy hold expiry triggered by GET /a/:token before closing SQLite', async () => {
      const dbPath = path.resolve(process.cwd(), `test_graceful_lazy_drain_${Date.now()}.db`);
      tempDbPaths.push(dbPath);

      let releaseVoid!: () => void;
      const voidStarted = new Promise<void>((resolve) => {
        vi.spyOn(PayPalAuthorizationsService.prototype, 'voidAuthorization').mockImplementation(
          async (input) => {
            resolve();
            await new Promise<void>((r) => {
              releaseVoid = r;
            });
            return {
              id: input.authorizationId,
              status: 'VOIDED',
              isVoided: true,
            };
          }
        );
      });

      const ownerPassphrase = 'lazy-drain-owner-pass-2026';
      const hashedPass = await hashOwnerPassphrase(ownerPassphrase);

      activeServer = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: dbPath,
          NODE_ENV: 'test',
          CONNECTOR_ACME_CLIENT_ID: 'sb-client-id-123',
          CONNECTOR_ACME_CLIENT_SECRET: 'sb-client-secret-123',
          OWNER_PASSPHRASE_HASH: hashedPass,
          SESSION_SECRET: 'test-session-secret-min16chars',
        },
        registerSignalHandlers: false,
      });

      const nowIso = new Date().toISOString();
      const futureIso = new Date(Date.now() + 15 * 60_000).toISOString();
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      activeServer.repos.owners.upsert({
        id: 'default',
        display_name: 'Primary Owner',
        passphrase_hash: hashedPass,
        telegram_chat_id: null,
        created_at: nowIso,
      });
      activeServer.repos.policyVersions.insert({
        id: 'pol-lazy-1',
        version: 1,
        rules: JSON.stringify({ version: 1 }),
        author: 'owner',
        active: 1,
        created_at: nowIso,
      });
      activeServer.repos.vendors.insert({
        id: 'ven-lazy-1',
        name: 'Lazy Vendor',
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'acme_cloud',
        created_at: nowIso,
      });
      activeServer.repos.agents.insert({
        id: 'agent-lazy-1',
        name: 'Lazy Agent',
        api_key_hash: crypto.createHash('sha256').update('secret-lazy').digest('hex'),
        status: 'ACTIVE',
        daily_budget_minor: toMinorUnits(10000),
        created_at: nowIso,
      });
      activeServer.repos.paymentRequests.insert({
        id: 'req-lazy-drain-1',
        agent_id: 'agent-lazy-1',
        idempotency_key: 'idem-lazy-drain-1',
        vendor_id: 'ven-lazy-1',
        amount_minor: toMinorUnits(950),
        currency: 'USD',
        purpose: 'Lazy expiry shutdown drain test',
        category: 'cloud',
        source_context_excerpt: null,
        source_context_hash: null,
        policy_version_id: 'pol-lazy-1',
        snapshot_hash: computeSnapshotHash({
          requestId: 'req-lazy-drain-1',
          agentId: 'agent-lazy-1',
          vendorId: 'ven-lazy-1',
          amountMinor: toMinorUnits(950),
          currency: 'USD',
          purpose: 'Lazy expiry shutdown drain test',
          category: 'cloud',
        }),
        status: 'HELD',
        decision: 'HOLD',
        reasons: JSON.stringify(['REQUIRE_OWNER_APPROVAL']),
        paypal_order_id: 'ORD-LAZY-1',
        paypal_authorization_id: 'AUTH-LAZY-1',
        paypal_capture_id: null,
        remote_void_status: null,
        expires_at: futureIso,
        created_at: nowIso,
        updated_at: nowIso,
      });
      activeServer.repos.ledger.insert({
        id: 'led-lazy-1',
        request_id: 'req-lazy-drain-1',
        kind: 'RESERVE',
        amount_minor: toMinorUnits(950),
        currency: 'USD',
        created_at: nowIso,
      });

      const minted = mintApprovalToken(activeServer.db, activeServer.repos, {
        requestId: 'req-lazy-drain-1',
        action: 'APPROVE',
      });
      expect(minted.success).toBe(true);

      // Now expire the hold while leaving the approval token unexpired
      activeServer.db
        .prepare('UPDATE payment_requests SET expires_at = ? WHERE id = ?')
        .run(pastIso, 'req-lazy-drain-1');

      const session = activeServer.mcpServer.ownerSessionStore.createSession({
        id: 'default',
        displayName: 'Primary Owner',
      });

      const res = await fetch(`http://127.0.0.1:${activeServer.port}/a/${minted.rawToken!}`, {
        headers: {
          Cookie: `${OWNER_COOKIE_NAME}=${session.rawSessionToken}`,
        },
      });
      expect(res.status).toBe(410);

      await voidStarted;

      let stopSettled = false;
      const stopPromise = activeServer.stop().then(() => {
        stopSettled = true;
      });

      await new Promise((r) => setTimeout(r, 40));
      expect(stopSettled).toBe(false);
      expect(activeServer.db.open).toBe(true);

      releaseVoid();
      await stopPromise;

      expect(stopSettled).toBe(true);
      expect(activeServer.db.open).toBe(false);

      const reopened = dbModule.createDatabase({ path: dbPath });
      try {
        const row = reopened
          .prepare('SELECT status, remote_void_status FROM payment_requests WHERE id = ?')
          .get('req-lazy-drain-1') as { status: string; remote_void_status: string } | undefined;
        expect(row).toEqual({
          status: 'VOIDED',
          remote_void_status: 'CONFIRMED',
        });
      } finally {
        reopened.close();
      }
      activeServer = null;
    });
  });

  describe('10. Scheduled Owner Session Cleanup Lifecycle', () => {
    it('periodically purges expired owner sessions and stops cleanup cleanly on shutdown', async () => {
      const db = dbModule.createDatabase(':memory:');
      dbModule.runMigrations(db);
      const repos = createRepositories(db);
      repos.owners.upsert({
        id: 'default',
        display_name: 'Primary Owner',
        passphrase_hash: 'test-hash',
        telegram_chat_id: null,
        created_at: new Date().toISOString(),
      });

      const store = new OwnerSessionStore({
        db,
        repos,
        idleTimeoutMs: 40,
        absoluteTimeoutMs: 60_000,
      });
      const cleanupSpy = vi.spyOn(store, 'cleanupExpired');

      const warnings: string[] = [];
      const mcpServer = createPayGuardMcpServer({
        db,
        repos,
        ownerSessionStore: store,
        ownerSessionCleanupIntervalMs: 25,
        logger: {
          warn: (msg: string) => warnings.push(msg),
        },
      });

      await mcpServer.start(0);
      try {
        // Seed an expired session (idle > 40ms ago) and a future-touched session that remains active
        const now = Date.now();
        store.createSession({ id: 'default', displayName: 'Primary Owner' }, now - 200);
        const fresh = store.createSession({ id: 'default', displayName: 'Primary Owner' }, now + 1000);
        expect(store.activeCount).toBe(2);

        // Wait for scheduled cleanup ticks to execute
        await new Promise((r) => setTimeout(r, 110));
        expect(cleanupSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(store.activeCount).toBe(1);
        expect(store.getSession(fresh.rawSessionToken, now + 1010)).toBeDefined();
      } finally {
        await mcpServer.close();
      }

      // Close DB after server stop and verify no further cleanup calls run on closed DB
      db.close();
      const callsAtShutdown = cleanupSpy.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80));
      expect(cleanupSpy).toHaveBeenCalledTimes(callsAtShutdown);
      expect(mcpServer.cleanupExpiredOwnerSessions()).toBe(0);
      expect(warnings).toEqual([]);
    });

    it('gracefully skips cleanup if session storage fails while running', async () => {
      const db = dbModule.createDatabase(':memory:');
      dbModule.runMigrations(db);
      const repos = createRepositories(db);
      const store = new OwnerSessionStore({ db, repos });
      vi.spyOn(store, 'cleanupExpired').mockImplementation(() => {
        throw new Error('Transient SQLITE_BUSY during cleanup');
      });

      const warnings: string[] = [];
      const mcpServer = createPayGuardMcpServer({
        db,
        repos,
        ownerSessionStore: store,
        ownerSessionCleanupIntervalMs: 5000,
        logger: {
          warn: (msg: string) => warnings.push(msg),
        },
      });

      await mcpServer.start(0);
      try {
        expect(mcpServer.cleanupExpiredOwnerSessions()).toBe(0);
        expect(warnings.some((w) => w.includes('Owner session cleanup skipped'))).toBe(true);
      } finally {
        await mcpServer.close();
        db.close();
      }
    });
  });
});
