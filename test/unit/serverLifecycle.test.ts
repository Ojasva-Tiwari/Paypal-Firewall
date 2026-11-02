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
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, type RunningServer } from '../../src/server.js';
import { ConfigError } from '../../src/config/index.js';
import * as dbModule from '../../src/db/connection.js';

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
});
