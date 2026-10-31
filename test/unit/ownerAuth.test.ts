/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T1 Unit & Security Tests: Owner Authentication, Sessions, CSRF & Rate Limiting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import {
  hashOwnerPassphrase,
  verifyOwnerPassphrase,
  hashSessionToken,
  OwnerSessionStore,
  LoginRateLimiter,
  createOwnerAuthMiddleware,
  OWNER_COOKIE_NAME,
  parseCookies,
  getSafeClientIp,
} from '../../src/auth/owner.js';
import { createAuthRouter } from '../../src/api/auth.js';
import { createPayGuardMcpServer } from '../../src/mcp/server.js';
import * as crypto from 'node:crypto';

describe('M4-T1: Owner Authentication, Sessions & CSRF Protection', () => {
  let db: Database;
  let repos: Repositories;
  const testPassphrase = 'correct-owner-passphrase-2026';
  let argon2Hash: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);

    argon2Hash = await hashOwnerPassphrase(testPassphrase);

    repos.owners.upsert({
      display_name: 'Primary Owner',
      passphrase_hash: argon2Hash,
      telegram_chat_id: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
  });

  // ============================================================================
  // 1. Password Hashing & Verification (Argon2id)
  // ============================================================================

  describe('Argon2id Password Hashing & Legacy Migration', () => {
    it('hashes passphrase with Argon2id PHC format and verifies successfully', async () => {
      const h = await hashOwnerPassphrase('secret-passphrase');
      expect(h).toMatch(/^\$argon2id\$v=19\$/);

      const res = await verifyOwnerPassphrase('secret-passphrase', h);
      expect(res.valid).toBe(true);
      expect(res.needsMigration).toBe(false);

      const badRes = await verifyOwnerPassphrase('wrong-passphrase', h);
      expect(badRes.valid).toBe(false);
      expect(badRes.needsMigration).toBe(false);
    });

    it('rejects empty or missing passphrase or hash safely without throwing', async () => {
      expect((await verifyOwnerPassphrase('', argon2Hash)).valid).toBe(false);
      expect((await verifyOwnerPassphrase(testPassphrase, '')).valid).toBe(false);
    });

    it('verifies legacy SHA-256 hash and flags needsMigration for immediate upgrade', async () => {
      const legacyRaw = 'legacy-demo-passphrase';
      const legacyHash = crypto.createHash('sha256').update(legacyRaw, 'utf8').digest('hex');

      const res = await verifyOwnerPassphrase(legacyRaw, legacyHash);
      expect(res.valid).toBe(true);
      expect(res.needsMigration).toBe(true);

      const badRes = await verifyOwnerPassphrase('wrong-attempt', legacyHash);
      expect(badRes.valid).toBe(false);
      expect(badRes.needsMigration).toBe(false);
    });
  });

  // ============================================================================
  // 2. Server-Side Session Store & Token Hashing
  // ============================================================================

  describe('OwnerSessionStore & Hashed Storage', () => {
    it('generates 32-byte session and CSRF tokens and stores only the SHA-256 hash in memory', () => {
      const store = new OwnerSessionStore();
      const { rawSessionToken, csrfToken, sessionRecord } = store.createSession({
        id: 'default',
        displayName: 'Primary Owner',
      });

      // Raw token is 64 hex characters (32 bytes)
      expect(rawSessionToken).toHaveLength(64);
      expect(csrfToken).toHaveLength(64);

      // Session record stores the hash, NOT the raw token
      expect(sessionRecord.sessionKey).toBe(hashSessionToken(rawSessionToken));
      expect(sessionRecord.sessionKey).not.toBe(rawSessionToken);

      // Resolves session using raw token
      const retrieved = store.getSession(rawSessionToken);
      expect(retrieved).toBeDefined();
      expect(retrieved?.displayName).toBe('Primary Owner');
      expect(retrieved?.csrfToken).toBe(csrfToken);
    });

    it('enforces idle timeout expiry', () => {
      const store = new OwnerSessionStore({ idleTimeoutMs: 1000, absoluteTimeoutMs: 10_000 });
      const now = Date.now();
      const { rawSessionToken } = store.createSession({ id: 'default', displayName: 'Owner' }, now);

      // Within idle timeout
      expect(store.getSession(rawSessionToken, now + 500)).toBeDefined();

      // Exceeded idle timeout
      expect(store.getSession(rawSessionToken, now + 1600)).toBeUndefined();
    });

    it('enforces absolute timeout expiry even with active access', () => {
      const store = new OwnerSessionStore({ idleTimeoutMs: 5000, absoluteTimeoutMs: 10_000 });
      const now = Date.now();
      const { rawSessionToken } = store.createSession({ id: 'default', displayName: 'Owner' }, now);

      // Keep touching session every 2 seconds
      expect(store.getSession(rawSessionToken, now + 2000)).toBeDefined();
      expect(store.getSession(rawSessionToken, now + 4000)).toBeDefined();
      expect(store.getSession(rawSessionToken, now + 8000)).toBeDefined();

      // Exceeded absolute timeout (10s)
      expect(store.getSession(rawSessionToken, now + 10_001)).toBeUndefined();
    });

    it('invalidates session on demand', () => {
      const store = new OwnerSessionStore();
      const { rawSessionToken } = store.createSession({ id: 'default', displayName: 'Owner' });

      expect(store.getSession(rawSessionToken)).toBeDefined();
      expect(store.invalidateSession(rawSessionToken)).toBe(true);
      expect(store.getSession(rawSessionToken)).toBeUndefined();
    });
  });

  // ============================================================================
  // 3. API Endpoints: /api/login, /api/logout, /api/session
  // ============================================================================

  describe('Owner Authentication API Integration', () => {
    let app: Express;
    let server: Server;
    let baseUrl: string;
    let sessionStore: OwnerSessionStore;
    let rateLimiter: LoginRateLimiter;

    beforeEach(async () => {
      sessionStore = new OwnerSessionStore();
      rateLimiter = new LoginRateLimiter(5, 60_000);

      app = express();
      app.use(express.json());

      const authRouter = createAuthRouter({
        db,
        repos,
        sessionStore,
        loginRateLimiter: rateLimiter,
        secureCookie: false, // false for local HTTP test runner
      });
      app.use('/api', authRouter);

      // Protected dummy route for testing middleware and CSRF
      const ownerAuth = createOwnerAuthMiddleware(sessionStore);
      app.get('/api/protected', ownerAuth, (req, res) => {
        res.json({ message: 'authorized', ownerId: req.ownerSession?.ownerId });
      });
      app.post('/api/protected-action', ownerAuth, (req, res) => {
        res.json({ message: 'action_completed', body: req.body });
      });

      await new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
          baseUrl = `http://localhost:${port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('POST /api/login succeeds with correct passphrase and sets secure cookies', async () => {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: testPassphrase }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as {
        ok: boolean;
        owner: { id: string; displayName: string };
        csrfToken: string;
      };

      expect(data.ok).toBe(true);
      expect(data.owner.displayName).toBe('Primary Owner');
      expect(data.csrfToken).toHaveLength(64);

      // Verify Set-Cookie header flags
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain(`${OWNER_COOKIE_NAME}=`);
      expect(setCookie?.toLowerCase()).toContain('httponly');
      expect(setCookie?.toLowerCase()).toContain('samesite=strict');
      expect(setCookie?.toLowerCase()).toContain('path=/');
    });

    it('POST /api/login rejects incorrect passphrase with generic 401 without leaking internal details', async () => {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: 'incorrect-passphrase' }),
      });

      expect(res.status).toBe(401);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('Invalid credentials');
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('POST /api/login rejects empty payload with 400 Bad Request', async () => {
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: '' }),
      });

      expect(res.status).toBe(400);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('Passphrase is required');
    });

    it('POST /api/login automatically migrates legacy SHA-256 hashes to Argon2id in the database', async () => {
      const legacyRaw = 'legacy-owner-passphrase';
      const legacyHash = crypto.createHash('sha256').update(legacyRaw, 'utf8').digest('hex');

      // Seed with legacy hash
      repos.owners.upsert({
        display_name: 'Migrated Owner',
        passphrase_hash: legacyHash,
        telegram_chat_id: null,
        created_at: new Date().toISOString(),
      });

      // Verify DB currently has SHA-256 hash
      expect(repos.owners.get()?.passphrase_hash).toBe(legacyHash);

      // Perform login
      const res = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: legacyRaw }),
      });

      expect(res.status).toBe(200);

      // Verify DB was automatically updated to modern Argon2id hash!
      const updatedOwner = repos.owners.get();
      expect(updatedOwner?.passphrase_hash).toMatch(/^\$argon2id\$v=19\$/);

      // Subsequent login authenticates directly against the new Argon2id hash
      const res2 = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: legacyRaw }),
      });
      expect(res2.status).toBe(200);
    });

    it('GET /api/session returns authenticated: false when logged out', async () => {
      const res = await fetch(`${baseUrl}/api/session`);
      expect(res.status).toBe(200);
      const data = await res.json() as { authenticated: boolean };
      expect(data.authenticated).toBe(false);
    });

    it('GET /api/session returns session data and CSRF token when logged in', async () => {
      // 1. Log in
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: testPassphrase }),
      });
      const cookieHeader = loginRes.headers.get('set-cookie')!;

      // 2. Query session
      const sessionRes = await fetch(`${baseUrl}/api/session`, {
        headers: { Cookie: cookieHeader },
      });
      expect(sessionRes.status).toBe(200);
      const data = await sessionRes.json() as {
        authenticated: boolean;
        owner: { id: string; displayName: string };
        csrfToken: string;
      };
      expect(data.authenticated).toBe(true);
      expect(data.owner.displayName).toBe('Primary Owner');
      expect(data.csrfToken).toHaveLength(64);
      // Ensure no internal hash or session key leaked
      expect(data).not.toHaveProperty('sessionKey');
      expect(data).not.toHaveProperty('passphrase_hash');
    });

    it('POST /api/logout invalidates session and clears cookie', async () => {
      // 1. Log in
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: testPassphrase }),
      });
      const loginData = await loginRes.json() as { csrfToken: string };
      const cookieHeader = loginRes.headers.get('set-cookie')!;

      // 2. Log out with valid CSRF header
      const logoutRes = await fetch(`${baseUrl}/api/logout`, {
        method: 'POST',
        headers: {
          Cookie: cookieHeader,
          'x-csrf-token': loginData.csrfToken,
        },
      });

      expect(logoutRes.status).toBe(200);
      const clearedCookie = logoutRes.headers.get('set-cookie');
      expect(clearedCookie).toContain(`${OWNER_COOKIE_NAME}=;`);

      // 3. Confirm session is no longer active
      const checkRes = await fetch(`${baseUrl}/api/session`, {
        headers: { Cookie: cookieHeader },
      });
      const checkData = await checkRes.json() as { authenticated: boolean };
      expect(checkData.authenticated).toBe(false);
    });

    it('enforces session fixation defense by invalidating existing session on fresh login', async () => {
      // 1. Login initial session
      const login1 = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: testPassphrase }),
      });
      const cookie1 = login1.headers.get('set-cookie')!;

      // 2. Perform second login with first cookie attached
      const login2 = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie1,
        },
        body: JSON.stringify({ passphrase: testPassphrase }),
      });
      const cookie2 = login2.headers.get('set-cookie')!;
      expect(cookie1).not.toBe(cookie2);

      // Old cookie is now invalidated
      const oldCheck = await fetch(`${baseUrl}/api/session`, {
        headers: { Cookie: cookie1 },
      });
      expect((await oldCheck.json() as { authenticated: boolean }).authenticated).toBe(false);

      // New cookie is valid
      const newCheck = await fetch(`${baseUrl}/api/session`, {
        headers: { Cookie: cookie2 },
      });
      expect((await newCheck.json() as { authenticated: boolean }).authenticated).toBe(true);
    });
  });

  // ============================================================================
  // 4. CSRF Protection
  // ============================================================================

  describe('CSRF Protection on State-Changing Owner Operations', () => {
    let app: Express;
    let server: Server;
    let baseUrl: string;
    let sessionStore: OwnerSessionStore;

    beforeEach(async () => {
      sessionStore = new OwnerSessionStore();
      app = express();
      app.use(express.json());

      const authRouter = createAuthRouter({
        db,
        repos,
        sessionStore,
        secureCookie: false,
      });
      app.use('/api', authRouter);

      const ownerAuth = createOwnerAuthMiddleware(sessionStore);
      app.post('/api/action', ownerAuth, (_req, res) => {
        res.json({ success: true });
      });

      await new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
          baseUrl = `http://localhost:${port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('rejects state-changing POST requests missing x-csrf-token header with 403 Forbidden', async () => {
      // 1. Log in
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: testPassphrase }),
      });
      const cookieHeader = loginRes.headers.get('set-cookie')!;

      // 2. Call POST without x-csrf-token
      const res = await fetch(`${baseUrl}/api/action`, {
        method: 'POST',
        headers: {
          Cookie: cookieHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ foo: 'bar' }),
      });

      expect(res.status).toBe(403);
      const data = await res.json() as { error: string };
      expect(data.error).toBe('CSRF token missing or invalid');
    });

    it('rejects state-changing POST requests with invalid x-csrf-token header with 403 Forbidden', async () => {
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: testPassphrase }),
      });
      const cookieHeader = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/action`, {
        method: 'POST',
        headers: {
          Cookie: cookieHeader,
          'Content-Type': 'application/json',
          'x-csrf-token': 'wrong-csrf-token-12345',
        },
        body: JSON.stringify({ foo: 'bar' }),
      });

      expect(res.status).toBe(403);
    });

    it('accepts state-changing POST requests with valid x-csrf-token header', async () => {
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: testPassphrase }),
      });
      const loginData = await loginRes.json() as { csrfToken: string };
      const cookieHeader = loginRes.headers.get('set-cookie')!;

      const res = await fetch(`${baseUrl}/api/action`, {
        method: 'POST',
        headers: {
          Cookie: cookieHeader,
          'Content-Type': 'application/json',
          'x-csrf-token': loginData.csrfToken,
        },
        body: JSON.stringify({ foo: 'bar' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json() as { success: boolean };
      expect(data.success).toBe(true);
    });

    it('does not accept CSRF token passed only in request body (strictly header-enforced)', async () => {
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: testPassphrase }),
      });
      const loginData = await loginRes.json() as { csrfToken: string };
      const cookieHeader = loginRes.headers.get('set-cookie')!;

      // Pass token in body without x-csrf-token header
      const res = await fetch(`${baseUrl}/api/action`, {
        method: 'POST',
        headers: {
          Cookie: cookieHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ csrf_token: loginData.csrfToken, payload: 'data' }),
      });

      expect(res.status).toBe(403);
    });
  });

  // ============================================================================
  // 5. Login Rate Limiting & Safe IP Extraction
  // ============================================================================

  describe('Login Rate Limiting & IP Extraction', () => {
    it('limits login attempts to approximately 5 per minute and returns HTTP 429', async () => {
      const limiter = new LoginRateLimiter(5, 60_000);
      const app = express();
      app.use(express.json());
      app.use(
        '/api',
        createAuthRouter({
          db,
          repos,
          loginRateLimiter: limiter,
          secureCookie: false,
        })
      );

      let server: Server;
      let baseUrl = '';
      await new Promise<void>((resolve) => {
        server = app.listen(0, () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
          baseUrl = `http://localhost:${port}`;
          resolve();
        });
      });

      try {
        // First 5 invalid attempts return 401
        for (let i = 0; i < 5; i++) {
          const res = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ passphrase: 'wrong-passphrase' }),
          });
          expect(res.status).toBe(401);
        }

        // 6th attempt is blocked by rate limiter with 429
        const blockedRes = await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: 'wrong-passphrase' }),
        });

        expect(blockedRes.status).toBe(429);
        expect(blockedRes.headers.get('retry-after')).toBeDefined();
        const data = await blockedRes.json() as { error: string };
        expect(data.error).toContain('Too many login attempts');

        // Even with the CORRECT passphrase, the 7th attempt is still blocked
        const blockedCorrectRes = await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: testPassphrase }),
        });
        expect(blockedCorrectRes.status).toBe(429);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('safely extracts client IP without trusting spoofed X-Forwarded-For when trust proxy is disabled', () => {
      const mockReqUntrusted = {
        app: { get: () => false },
        socket: { remoteAddress: '192.168.1.100' },
        headers: { 'x-forwarded-for': '10.0.0.1' },
      } as unknown as express.Request;

      expect(getSafeClientIp(mockReqUntrusted)).toBe('192.168.1.100');

      const mockReqTrusted = {
        app: { get: (k: string) => k === 'trust proxy' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '192.168.1.100' },
      } as unknown as express.Request;

      expect(getSafeClientIp(mockReqTrusted)).toBe('10.0.0.1');
    });
  });

  // ============================================================================
  // 6. Role & Tenant Isolation: Agent Bearer vs Owner Session
  // ============================================================================

  describe('Isolation between MCP Agent Auth and Owner Session Auth', () => {
    it('agent Bearer token cannot authenticate to owner routes', async () => {
      const serverInstance = createPayGuardMcpServer({
        db,
        repos,
        secureCookie: false,
      });
      const started = await serverInstance.start(0);

      try {
        // Attempt to call /api/session with an agent Bearer header
        const res = await fetch(`http://localhost:${started.port}/api/session`, {
          headers: {
            Authorization: 'Bearer test-agent-key-1234',
          },
        });
        const data = await res.json() as { authenticated: boolean };
        expect(data.authenticated).toBe(false);
      } finally {
        await serverInstance.close();
      }
    });

    it('owner session cookie cannot authenticate to /mcp endpoint', async () => {
      const serverInstance = createPayGuardMcpServer({
        db,
        repos,
        secureCookie: false,
      });
      const started = await serverInstance.start(0);

      try {
        // Log in as owner to get cookie
        const loginRes = await fetch(`http://localhost:${started.port}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: testPassphrase }),
        });
        const cookieHeader = loginRes.headers.get('set-cookie')!;

        // Attempt to call /mcp with owner session cookie (no Bearer token)
        const mcpRes = await fetch(`http://localhost:${started.port}/mcp`, {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/list',
            id: 1,
          }),
        });

        // /mcp requires Bearer token, rejects with 401 Unauthorized
        expect(mcpRes.status).toBe(401);
      } finally {
        await serverInstance.close();
      }
    });
  });

  // ============================================================================
  // 7. Cookie Parser & Utility Tests
  // ============================================================================

  describe('Cookie Parsing & Flags', () => {
    it('parses multi-cookie headers safely', () => {
      const header = 'pg_owner_session=sess-12345; other_cookie=val%201; flag=true';
      const parsed = parseCookies(header);
      expect(parsed['pg_owner_session']).toBe('sess-12345');
      expect(parsed['other_cookie']).toBe('val 1');
      expect(parsed['flag']).toBe('true');
    });

    it('handles missing or malformed cookie header gracefully', () => {
      expect(parseCookies(undefined)).toEqual({});
      expect(parseCookies('')).toEqual({});
      expect(parseCookies('invalid-no-equal')).toEqual({});
    });
  });
});
