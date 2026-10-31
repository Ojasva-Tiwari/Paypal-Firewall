/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T1: Owner Authentication API Routes (/api/login, /api/logout, /api/session)
 *
 * Implements:
 * - POST /api/login: Rate-limited single-owner authentication against database record.
 *   Generates 32-byte cryptographically random session and CSRF tokens.
 *   Sets HttpOnly, SameSite=Strict, Secure (production) session cookie.
 *   Migrates legacy SHA-256 hashes to Argon2id immediately upon successful authentication.
 * - POST /api/logout: Requires active session + CSRF header; invalidates session and clears cookie.
 * - GET /api/session: Read-only authentication and CSRF token inspection for dashboard.
 *
 * Security Invariants:
 * - Hard Rule 1: Sandbox only. Never add code paths that use PayPal production.
 * - Hard Rule 2: Never log or persist plaintext credentials, session secrets, or raw keys.
 * - Generic error messages prevent credential enumeration or existence probing.
 * - Header-only CSRF verification enforces anti-CSRF protection across all state-changing endpoints.
 */

import { Router, type Request, type Response } from 'express';
import type { Database } from '../db/connection.js';
import type { Repositories } from '../db/repositories.js';
import {
  OWNER_COOKIE_NAME,
  DEFAULT_ABSOLUTE_TIMEOUT_MS,
  OwnerSessionStore,
  LoginRateLimiter,
  verifyOwnerPassphrase,
  hashOwnerPassphrase,
  getSafeClientIp,
  createOwnerAuthMiddleware,
  parseCookies,
} from '../auth/owner.js';

export interface AuthRouterOptions {
  readonly db: Database;
  readonly repos: Repositories;
  readonly sessionStore?: OwnerSessionStore;
  readonly loginRateLimiter?: LoginRateLimiter;
  readonly isProduction?: boolean;
  readonly secureCookie?: boolean;
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();
  const repos = options.repos;
  const sessionStore = options.sessionStore ?? new OwnerSessionStore();
  const loginRateLimiter = options.loginRateLimiter ?? new LoginRateLimiter();
  const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production';
  const secureCookie = options.secureCookie !== undefined ? options.secureCookie : isProduction;

  const ownerAuthMiddleware = createOwnerAuthMiddleware(sessionStore);

  // ==========================================================================
  // POST /login — Owner Login & Session Issuance
  // ==========================================================================
  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    const clientIp = getSafeClientIp(req);

    // 1. Enforce Login Rate Limiting (~5 attempts / minute)
    const rateCheck = loginRateLimiter.check(clientIp);
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfterSeconds));
      res.status(429).json({
        error: 'Too many login attempts. Please try again later.',
      });
      return;
    }

    // 2. Validate input payload
    const rawPassphrase = req.body?.passphrase;
    if (typeof rawPassphrase !== 'string' || rawPassphrase.trim().length === 0) {
      loginRateLimiter.recordAttempt(clientIp);
      res.status(400).json({ error: 'Passphrase is required' });
      return;
    }

    const passphrase = rawPassphrase;

    // 3. Retrieve Authoritative Owner Record from Database
    const owner = repos.owners.get();
    if (!owner || !owner.passphrase_hash) {
      // Dummy check to mitigate timing side-channels
      await verifyOwnerPassphrase(passphrase, '$argon2id$dummy-hash-for-timing-defense');
      loginRateLimiter.recordAttempt(clientIp);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // 4. Verify Passphrase (supports Argon2id and controlled legacy migration)
    const { valid, needsMigration } = await verifyOwnerPassphrase(passphrase, owner.passphrase_hash);
    if (!valid) {
      loginRateLimiter.recordAttempt(clientIp);
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // 5. Immediate Legacy Hash Migration: Rehash with Argon2id and persist to database
    if (needsMigration) {
      try {
        const modernArgon2Hash = await hashOwnerPassphrase(passphrase);
        repos.owners.upsert({
          id: 'default',
          display_name: owner.display_name,
          passphrase_hash: modernArgon2Hash,
          telegram_chat_id: owner.telegram_chat_id,
          created_at: owner.created_at,
        });
      } catch {
        // Non-fatal: login proceeds, migration will retry on next login
      }
    }

    // 6. Session Fixation Defense: Invalidate pre-existing incoming session token
    const existingCookies = parseCookies(req.headers.cookie);
    const existingToken = existingCookies[OWNER_COOKIE_NAME];
    if (existingToken) {
      sessionStore.invalidateSession(existingToken);
    }

    // 7. Issue Fresh Cryptographically Secure Session & CSRF Token
    const { rawSessionToken, csrfToken } = sessionStore.createSession({
      id: owner.id,
      displayName: owner.display_name,
    });

    // 8. Set HTTP-Only, SameSite=Strict Cookie
    res.cookie(OWNER_COOKIE_NAME, rawSessionToken, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: DEFAULT_ABSOLUTE_TIMEOUT_MS,
      secure: secureCookie,
    });

    // Reset rate limiter for successful login
    loginRateLimiter.reset(clientIp);

    // 9. Return Sanitized Response
    res.status(200).json({
      ok: true,
      owner: {
        id: owner.id,
        displayName: owner.display_name,
      },
      csrfToken,
    });
  });

  // ==========================================================================
  // POST /logout — Session Invalidation
  // ==========================================================================
  router.post('/logout', ownerAuthMiddleware, (req: Request, res: Response): void => {
    const cookies = parseCookies(req.headers.cookie);
    const rawSessionToken = cookies[OWNER_COOKIE_NAME];

    if (rawSessionToken) {
      sessionStore.invalidateSession(rawSessionToken);
    }

    res.clearCookie(OWNER_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      secure: secureCookie,
    });

    res.status(200).json({ ok: true });
  });

  // ==========================================================================
  // GET /session — Read-only Session & CSRF Check for Dashboard
  // ==========================================================================
  router.get('/session', (req: Request, res: Response): void => {
    const cookies = parseCookies(req.headers.cookie);
    const rawSessionToken = cookies[OWNER_COOKIE_NAME];

    if (!rawSessionToken) {
      res.status(200).json({ authenticated: false });
      return;
    }

    const session = sessionStore.getSession(rawSessionToken);
    if (!session) {
      res.clearCookie(OWNER_COOKIE_NAME, { path: '/' });
      res.status(200).json({ authenticated: false });
      return;
    }

    res.status(200).json({
      authenticated: true,
      owner: {
        id: session.ownerId,
        displayName: session.displayName,
      },
      csrfToken: session.csrfToken,
    });
  });

  return router;
}

