/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T1 Unit & Security Tests: Owner Authentication, Sessions, CSRF & Rate Limiting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import {
  hashOwnerPassphrase,
  verifyOwnerPassphrase,
  hashSessionToken,
  OwnerSessionStore,
  SessionStorageError,
  SessionOwnerNotFoundError,
  LoginRateLimiter,
  createOwnerAuthMiddleware,
  OWNER_COOKIE_NAME,
  parseCookies,
  getSafeClientIp,
} from '../../src/auth/owner.js';
import { createAuthRouter } from '../../src/api/auth.js';
import { createPayGuardMcpServer } from '../../src/mcp/server.js';
import { loadConfig } from '../../src/config/index.js';
import { startServer } from '../../src/server.js';
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
    it('generates 32-byte session and CSRF tokens and stores only the SHA-256 hash in SQLite', () => {
      const store = new OwnerSessionStore({ db, repos });
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

      // Verify SQLite row stores only digest and excludes secrets/raw tokens
      const row = db
        .prepare('SELECT * FROM owner_sessions WHERE session_key = ?')
        .get(sessionRecord.sessionKey) as { session_key: string; owner_id: string } | undefined;
      expect(row?.session_key).toBe(sessionRecord.sessionKey);
      expect(row?.owner_id).toBe('default');

      // Resolves session using raw token
      const retrieved = store.getSession(rawSessionToken);
      expect(retrieved).toBeDefined();
      expect(retrieved?.displayName).toBe('Primary Owner');
      expect(retrieved?.csrfToken).toBe(csrfToken);
    });

    it('enforces idle timeout expiry', () => {
      const store = new OwnerSessionStore({ db, repos, idleTimeoutMs: 1000, absoluteTimeoutMs: 10_000 });
      const now = Date.now();
      const { rawSessionToken } = store.createSession({ id: 'default', displayName: 'Owner' }, now);

      // Within idle timeout
      expect(store.getSession(rawSessionToken, now + 500)).toBeDefined();

      // Exceeded idle timeout
      expect(store.getSession(rawSessionToken, now + 1600)).toBeUndefined();
    });

    it('enforces absolute timeout expiry even with active access', () => {
      const store = new OwnerSessionStore({ db, repos, idleTimeoutMs: 5000, absoluteTimeoutMs: 10_000 });
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
      const store = new OwnerSessionStore({ db, repos });
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
      sessionStore = new OwnerSessionStore({ db, repos });
      rateLimiter = new LoginRateLimiter(5, 60_000);

      app = express();
      app.use(express.json());
      app.use(express.urlencoded({ extended: false }));

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
      sessionStore = new OwnerSessionStore({ db, repos });
      app = express();
      app.use(express.json());
      app.use(express.urlencoded({ extended: false }));

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

    it('rejects URL-encoded _csrf body on /api routes when header-only CSRF is enforced', async () => {
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
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ _csrf: loginData.csrfToken }).toString(),
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

    it('skips malformed percent-encoded cookie pairs without throwing URIError and preserves valid cookies', () => {
      const parsed = parseCookies('bad=%ZZ; pg_owner_session=valid_tok_123; truncated=%E0%A4%A; flag=ok%20value');
      expect(parsed).toEqual({
        pg_owner_session: 'valid_tok_123',
        flag: 'ok value',
      });
      expect(parseCookies(`${OWNER_COOKIE_NAME}=%ZZ`)).toEqual({});
    });

    it('ignores prototype-pollution cookie keys safely', () => {
      const parsed = parseCookies('__proto__=polluted; constructor=evil; prototype=bad; pg_owner_session=safe');
      expect(parsed).toEqual({ pg_owner_session: 'safe' });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  // ============================================================================
  // 8. M6-T5 Phase 2: Session Persistence & Authentication Hardening
  // ============================================================================

  describe('M6-T5 Phase 2: Persistent Sessions & Authentication Hardening', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
      vi.restoreAllMocks();
      for (const dir of tempDirs) {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      tempDirs.length = 0;
    });

    it('persists sessions across OwnerSessionStore reconstruction and full server restarts', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payguard-session-restart-'));
      tempDirs.push(tmpDir);
      const dbPath = path.join(tmpDir, 'payguard-sessions.db');

      // Phase A: Store-level persistence check with idle touch persistence
      const db1 = createDatabase({ path: dbPath });
      runMigrations(db1);
      const repos1 = new Repositories(db1);
      repos1.owners.upsert({
        display_name: 'Restart Owner',
        passphrase_hash: argon2Hash,
        telegram_chat_id: null,
        created_at: '2026-10-01T00:00:00.000Z',
      });

      const store1 = new OwnerSessionStore({ db: db1, repos: repos1, idleTimeoutMs: 5000, absoluteTimeoutMs: 60_000 });
      const t0 = 1_700_000_000_000;
      const issued = store1.createSession({ id: 'default', displayName: 'Restart Owner' }, t0);
      db1.close();

      // Reopen DB in a fresh store instance (simulates process restart)
      const db2 = createDatabase({ path: dbPath });
      const store2 = new OwnerSessionStore({ db: db2, idleTimeoutMs: 5000, absoluteTimeoutMs: 60_000 });
      const recovered = store2.getSession(issued.rawSessionToken, t0 + 3000);
      expect(recovered).toBeDefined();
      expect(recovered?.ownerId).toBe('default');
      expect(recovered?.csrfToken).toBe(issued.csrfToken);
      expect(recovered?.lastAccessedAt).toBe(t0 + 3000);
      db2.close();

      // Verify updated last_accessed_at survived across restart too
      const db3 = createDatabase({ path: dbPath });
      const store3 = new OwnerSessionStore({ db: db3, idleTimeoutMs: 5000, absoluteTimeoutMs: 60_000 });
      expect(store3.getSession(issued.rawSessionToken, t0 + 7000)).toBeDefined();
      expect(store3.getSession(issued.rawSessionToken, t0 + 13_000)).toBeUndefined();
      db3.close();

      // Phase B: Full HTTP startServer() restart persistence
      const srv1 = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: dbPath,
          NODE_ENV: 'test',
          SESSION_SECRET: 'test-session-secret-min-16-chars',
        },
        registerSignalHandlers: false,
      });

      let cookieHeader = '';
      let csrfToken = '';
      try {
        const loginRes = await fetch(`http://127.0.0.1:${srv1.port}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: testPassphrase }),
        });
        expect(loginRes.status).toBe(200);
        const loginBody = (await loginRes.json()) as { csrfToken: string };
        csrfToken = loginBody.csrfToken;
        cookieHeader = loginRes.headers.get('set-cookie')!.split(';')[0]!;
      } finally {
        await srv1.stop();
      }

      // Restart server cleanly on the same file-backed DB
      const srv2 = await startServer({
        port: 0,
        env: {
          DATABASE_PATH: dbPath,
          NODE_ENV: 'test',
          SESSION_SECRET: 'test-session-secret-min-16-chars',
        },
        registerSignalHandlers: false,
      });

      try {
        const sessionRes = await fetch(`http://127.0.0.1:${srv2.port}/api/session`, {
          headers: { Cookie: cookieHeader },
        });
        expect(sessionRes.status).toBe(200);
        const sessionData = (await sessionRes.json()) as {
          authenticated: boolean;
          owner: { id: string; displayName: string };
          csrfToken: string;
        };
        expect(sessionData.authenticated).toBe(true);
        expect(sessionData.owner.id).toBe('default');
        expect(sessionData.owner.displayName).toBe('Restart Owner');
        expect(sessionData.csrfToken).toBe(csrfToken);

        const overviewRes = await fetch(`http://127.0.0.1:${srv2.port}/api/overview`, {
          headers: { Cookie: cookieHeader },
        });
        expect(overviewRes.status).toBe(200);

        const logoutRes = await fetch(`http://127.0.0.1:${srv2.port}/api/logout`, {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            'x-csrf-token': csrfToken,
          },
        });
        expect(logoutRes.status).toBe(200);

        const afterLogoutRes = await fetch(`http://127.0.0.1:${srv2.port}/api/session`, {
          headers: { Cookie: cookieHeader },
        });
        expect(((await afterLogoutRes.json()) as { authenticated: boolean }).authenticated).toBe(false);
      } finally {
        await srv2.stop();
      }
    });

    it('purges expired sessions via cleanupExpired without removing active sessions', () => {
      const store = new OwnerSessionStore({
        db,
        repos,
        idleTimeoutMs: 5000,
        absoluteTimeoutMs: 20_000,
      });

      const base = 1_000_000;
      const sOldIdle = store.createSession({ id: 'default', displayName: 'Owner' }, base);
      const sOldAbs = store.createSession({ id: 'default', displayName: 'Owner' }, base);
      // Touch sOldAbs within 5s idle intervals until just before 20s absolute timeout
      expect(store.getSession(sOldAbs.rawSessionToken, base + 4000)).toBeDefined();
      expect(store.getSession(sOldAbs.rawSessionToken, base + 8000)).toBeDefined();
      expect(store.getSession(sOldAbs.rawSessionToken, base + 12_000)).toBeDefined();
      expect(store.getSession(sOldAbs.rawSessionToken, base + 16_000)).toBeDefined();
      expect(store.getSession(sOldAbs.rawSessionToken, base + 18_000)).toBeDefined();

      // Create fresh session near now
      const sActive = store.createSession({ id: 'default', displayName: 'Owner' }, base + 19_000);
      expect(store.activeCount).toBe(3);

      // At base + 21_000:
      // - sOldIdle: expired on both idle & absolute
      // - sOldAbs: touched recently (21_000 - 18_000 <= 5000), but exceeded absolute (21_000 - 0 > 20_000)
      // - sActive: active (within 2s idle and 2s absolute)
      const purged = store.cleanupExpired(base + 21_000);
      expect(purged).toBe(2);
      expect(store.activeCount).toBe(1);
      expect(store.getSession(sOldIdle.rawSessionToken, base + 21_000)).toBeUndefined();
      expect(store.getSession(sOldAbs.rawSessionToken, base + 21_000)).toBeUndefined();
      expect(store.getSession(sActive.rawSessionToken, base + 21_000)).toBeDefined();
    });

    it('enforces owner isolation across sessions and rejects unknown or deleted owners', () => {
      const store = new OwnerSessionStore({ db, repos });

      // Cannot create a session for an unknown owner
      expect(() => {
        store.createSession({ id: 'nonexistent-owner', displayName: 'Attacker' });
      }).toThrowError(SessionOwnerNotFoundError);
      expect(store.activeCount).toBe(0);

      // Valid owner session gets removed automatically when owner is deleted (ON DELETE CASCADE)
      const created = store.createSession({ id: 'default', displayName: 'Primary Owner' });
      expect(store.activeCount).toBe(1);

      db.prepare('DELETE FROM owners WHERE id = ?').run('default');
      expect(store.activeCount).toBe(0);
      expect(store.getSession(created.rawSessionToken)).toBeUndefined();

      // Defense-in-depth: even if an orphaned row exists without FKs, INNER JOIN owners rejects it
      db.pragma('foreign_keys = OFF');
      db.prepare(`
        INSERT INTO owner_sessions (
          session_key, owner_id, display_name, csrf_token, created_at, last_accessed_at
        ) VALUES (?, 'orphan-owner', 'Ghost', 'csrf-ghost', ?, ?)
      `).run(hashSessionToken('raw-orphan-token'), Date.now(), Date.now());
      db.pragma('foreign_keys = ON');

      expect(store.getSession('raw-orphan-token')).toBeUndefined();
    });

    it('serves /api/session and protected routes safely when receiving malformed %ZZ cookie headers', async () => {
      const store = new OwnerSessionStore({ db, repos });
      const app = express();
      app.use(express.json());
      app.use(
        '/api',
        createAuthRouter({
          db,
          repos,
          sessionStore: store,
          secureCookie: false,
        })
      );
      app.get('/api/protected', createOwnerAuthMiddleware(store, { secureCookie: false }), (_req, res) => {
        res.json({ ok: true });
      });

      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        // Malformed %ZZ session cookie on /api/session should not throw 500
        const badSessionRes = await fetch(`${baseUrl}/api/session`, {
          headers: { Cookie: `${OWNER_COOKIE_NAME}=%ZZ` },
        });
        expect(badSessionRes.status).toBe(200);
        expect(await badSessionRes.json()).toEqual({ authenticated: false });

        // Malformed %ZZ session cookie on protected route rejects cleanly with 401
        const badProtectedRes = await fetch(`${baseUrl}/api/protected`, {
          headers: { Cookie: `${OWNER_COOKIE_NAME}=%ZZ` },
        });
        expect(badProtectedRes.status).toBe(401);

        // Valid session cookie alongside malformed sibling cookie works
        const issued = store.createSession({ id: 'default', displayName: 'Primary Owner' });
        const mixedRes = await fetch(`${baseUrl}/api/session`, {
          headers: {
            Cookie: `broken=%ZZ; ${OWNER_COOKIE_NAME}=${issued.rawSessionToken}; trailing=%E0%A4%A`,
          },
        });
        expect(mixedRes.status).toBe(200);
        const mixedData = (await mixedRes.json()) as { authenticated: boolean; owner: { id: string } };
        expect(mixedData.authenticated).toBe(true);
        expect(mixedData.owner.id).toBe('default');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('prevents concurrent login TOCTOU bypasses in LoginRateLimiter and prunes stale IP entries', async () => {
      // Part 1: Concurrent burst of 10 simultaneous invalid requests against limit=5
      const limiter = new LoginRateLimiter(5, 60_000);
      const getOwnerSpy = vi.spyOn(repos.owners, 'get');
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

      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const responses = await Promise.all(
          Array.from({ length: 10 }, () =>
            fetch(`${baseUrl}/api/login`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ passphrase: 'wrong-concurrent-passphrase' }),
            })
          )
        );

        const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
        expect(statuses.filter((s) => s === 401)).toHaveLength(5);
        expect(statuses.filter((s) => s === 429)).toHaveLength(5);

        // Atomicity check: rate limiter rejected 5 requests BEFORE DB/Argon2 even executed
        expect(getOwnerSpy).toHaveBeenCalledTimes(5);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      // Part 2: Stale IP pruning prevents unbounded Map growth
      const pruneLimiter = new LoginRateLimiter(5, 60_000, 100);
      const t0 = 10_000;
      for (let i = 0; i < 25; i++) {
        pruneLimiter.consume(`192.0.2.${i}`, t0 + i * 10);
      }
      expect(pruneLimiter.trackedIpCount).toBe(25);

      // Window elapses; new request automatically triggers pruning of expired IP entries
      pruneLimiter.consume('198.51.100.1', t0 + 65_000);
      expect(pruneLimiter.trackedIpCount).toBe(1);
    });

    it('preserves telegram_user_id, telegram_username, and telegram_linked_at during legacy SHA-256 password migration', async () => {
      const legacyRaw = 'legacy-telegram-owner-passphrase';
      const legacyHash = crypto.createHash('sha256').update(legacyRaw, 'utf8').digest('hex');

      repos.owners.upsert({
        id: 'default',
        display_name: 'Telegram Linked Owner',
        passphrase_hash: legacyHash,
        telegram_chat_id: '777123456',
        telegram_user_id: '888999000',
        telegram_username: 'linked_owner_handle',
        telegram_linked_at: '2026-10-15T08:30:00.000Z',
        created_at: new Date().toISOString(),
      });
      const expectedCreatedAt = repos.owners.get()?.created_at;

      const app = express();
      app.use(express.json());
      app.use(
        '/api',
        createAuthRouter({
          db,
          repos,
          secureCookie: false,
        })
      );

      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = (server.address() as { port: number }).port;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: legacyRaw }),
        });
        expect(res.status).toBe(200);

        const updated = repos.owners.get();
        expect(updated?.passphrase_hash).toMatch(/^\$argon2id\$v=19\$/);
        expect(updated?.display_name).toBe('Telegram Linked Owner');
        expect(updated?.telegram_chat_id).toBe('777123456');
        expect(updated?.telegram_user_id).toBe('888999000');
        expect(updated?.telegram_username).toBe('linked_owner_handle');
        expect(updated?.telegram_linked_at).toBe('2026-10-15T08:30:00.000Z');
        expect(updated?.created_at).toBe(expectedCreatedAt);

        // Subsequent login authenticates cleanly via upgraded Argon2id hash
        const res2 = await fetch(`http://127.0.0.1:${port}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: legacyRaw }),
        });
        expect(res2.status).toBe(200);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('fails closed with HTTP 503 on session database outage without clearing client cookies', async () => {
      const store = new OwnerSessionStore({ db, repos });
      const app = express();
      app.use(express.json());
      app.use(
        '/api',
        createAuthRouter({
          db,
          repos,
          sessionStore: store,
          secureCookie: false,
        })
      );
      app.get('/api/protected', createOwnerAuthMiddleware(store, { secureCookie: false }), (_req, res) => {
        res.json({ ok: true });
      });

      const server = await new Promise<Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = (server.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        // Issue valid session while storage is healthy
        const loginRes = await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: testPassphrase }),
        });
        expect(loginRes.status).toBe(200);
        const loginData = (await loginRes.json()) as { csrfToken: string };
        const cookieHeader = loginRes.headers.get('set-cookie')!.split(';')[0]!;

        // 1. Transient failure in invalidateSession during /api/logout -> 503 & cookie NOT cleared
        const invalidateSpy = vi
          .spyOn(store, 'invalidateSession')
          .mockImplementationOnce(() => {
            throw new SessionStorageError('Transient SQLITE_BUSY write error');
          });
        const logoutFailRes = await fetch(`${baseUrl}/api/logout`, {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            'x-csrf-token': loginData.csrfToken,
          },
        });
        expect(logoutFailRes.status).toBe(503);
        expect(logoutFailRes.headers.get('set-cookie')).toBeNull();
        expect(invalidateSpy).toHaveBeenCalledTimes(1);

        // 2. Simulate full SQLite outage by closing database
        db.close();

        const protectedRes = await fetch(`${baseUrl}/api/protected`, {
          headers: { Cookie: cookieHeader },
        });
        expect(protectedRes.status).toBe(503);
        expect(protectedRes.headers.get('set-cookie')).toBeNull();

        const sessionRes = await fetch(`${baseUrl}/api/session`, {
          headers: { Cookie: cookieHeader },
        });
        expect(sessionRes.status).toBe(503);
        expect(sessionRes.headers.get('set-cookie')).toBeNull();

        const logoutClosedRes = await fetch(`${baseUrl}/api/logout`, {
          method: 'POST',
          headers: {
            Cookie: cookieHeader,
            'x-csrf-token': loginData.csrfToken,
          },
        });
        expect(logoutClosedRes.status).toBe(503);
        expect(logoutClosedRes.headers.get('set-cookie')).toBeNull();

        const loginClosedRes = await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: testPassphrase }),
        });
        expect(loginClosedRes.status).toBe(503);
        expect(loginClosedRes.headers.get('set-cookie')).toBeNull();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('wires config.isProduction into cookie creation and clearing attributes and aligns clearCookie flags on expired sessions', async () => {
      // Simulate NODE_ENV='test' in process.env while server config specifies production
      const prodConfig = loadConfig({
        NODE_ENV: 'production',
        DATABASE_PATH: ':memory:',
        SESSION_SECRET: 'prod-session-secret-min-16-chars',
      });

      const serverInstance = createPayGuardMcpServer({
        db,
        repos,
        config: prodConfig,
      });
      const started = await serverInstance.start(0);
      const baseUrl = `http://127.0.0.1:${started.port}`;

      try {
        // 1. Login cookie has Secure, HttpOnly, SameSite=Strict, Path=/ when config.isProduction=true
        const loginRes = await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passphrase: testPassphrase }),
        });
        expect(loginRes.status).toBe(200);
        const loginSetCookie = loginRes.headers.get('set-cookie')?.toLowerCase() ?? '';
        expect(loginSetCookie).toContain(`${OWNER_COOKIE_NAME}=`);
        expect(loginSetCookie).toContain('httponly');
        expect(loginSetCookie).toContain('samesite=strict');
        expect(loginSetCookie).toContain('path=/');
        expect(loginSetCookie).toContain('secure');

        // 2. Definitively invalid/expired session while storage is healthy clears cookie with matching Secure/SameSite/HttpOnly flags
        const expiredSessionRes = await fetch(`${baseUrl}/api/session`, {
          headers: { Cookie: `${OWNER_COOKIE_NAME}=definitely-nonexistent-session-token` },
        });
        expect(expiredSessionRes.status).toBe(200);
        expect(await expiredSessionRes.json()).toEqual({ authenticated: false });
        const clearedSessionCookie = expiredSessionRes.headers.get('set-cookie')?.toLowerCase() ?? '';
        expect(clearedSessionCookie).toContain(`${OWNER_COOKIE_NAME}=;`);
        expect(clearedSessionCookie).toContain('httponly');
        expect(clearedSessionCookie).toContain('samesite=strict');
        expect(clearedSessionCookie).toContain('path=/');
        expect(clearedSessionCookie).toContain('secure');

        const expiredProtectedRes = await fetch(`${baseUrl}/api/overview`, {
          headers: { Cookie: `${OWNER_COOKIE_NAME}=definitely-nonexistent-session-token` },
        });
        expect(expiredProtectedRes.status).toBe(401);
        const clearedProtectedCookie = expiredProtectedRes.headers.get('set-cookie')?.toLowerCase() ?? '';
        expect(clearedProtectedCookie).toContain(`${OWNER_COOKIE_NAME}=;`);
        expect(clearedProtectedCookie).toContain('httponly');
        expect(clearedProtectedCookie).toContain('samesite=strict');
        expect(clearedProtectedCookie).toContain('path=/');
        expect(clearedProtectedCookie).toContain('secure');
      } finally {
        await serverInstance.close();
      }
    });
  });
});
