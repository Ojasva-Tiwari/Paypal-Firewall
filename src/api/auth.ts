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
  SessionOwnerNotFoundError,
  LoginRateLimiter,
  verifyOwnerPassphrase,
  hashOwnerPassphrase,
  getSafeClientIp,
  createOwnerAuthMiddleware,
  parseCookies,
  resolveOwnerCookieSecureFlag,
  buildOwnerSessionCookieOptions,
} from '../auth/owner.js';

export interface AuthRouterOptions {
  readonly db: Database;
  readonly repos: Repositories;
  readonly sessionStore?: OwnerSessionStore;
  readonly loginRateLimiter?: LoginRateLimiter;
  readonly isProduction?: boolean;
  readonly secureCookie?: boolean;
  readonly logger?: {
    info?: (msg: string, ...args: unknown[]) => void;
    warn?: (msg: string, ...args: unknown[]) => void;
    error?: (msg: string, ...args: unknown[]) => void;
  };
}

export function createAuthRouter(options: AuthRouterOptions): Router {
  const router = Router();
  const db = options.db;
  const repos = options.repos;
  const sessionStore = options.sessionStore ?? new OwnerSessionStore({ db, repos });
  const loginRateLimiter = options.loginRateLimiter ?? new LoginRateLimiter();
  const secureCookie = resolveOwnerCookieSecureFlag({
    isProduction: options.isProduction,
    secureCookie: options.secureCookie,
  });
  const cookieBaseOptions = buildOwnerSessionCookieOptions(secureCookie);

  const ownerAuthMiddleware = createOwnerAuthMiddleware(sessionStore, {
    isProduction: options.isProduction,
    secureCookie,
  });

  // ==========================================================================
  // POST /login — Owner Login & Session Issuance
  // ==========================================================================
  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    const clientIp = getSafeClientIp(req);

    // 1. Atomically check & reserve login attempt slot BEFORE input checks / Argon2 verification (no TOCTOU race)
    const rateCheck = loginRateLimiter.consume(clientIp);
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
      res.status(400).json({ error: 'Passphrase is required' });
      return;
    }

    const passphrase = rawPassphrase;

    // 3. Retrieve Authoritative Owner Record from Database (fail closed 503 if storage unavailable)
    let owner: ReturnType<typeof repos.owners.get>;
    try {
      owner = repos.owners.get();
    } catch (err: unknown) {
      options.logger?.warn?.(
        `[Auth] Owner storage unavailable during login: ${err instanceof Error ? err.message : String(err)}`
      );
      res.status(503).json({
        error: 'Session storage unavailable. Please try again later.',
      });
      return;
    }

    if (!owner || !owner.passphrase_hash) {
      // Dummy check to mitigate timing side-channels
      await verifyOwnerPassphrase(passphrase, '$argon2id$dummy-hash-for-timing-defense');
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // 4. Verify Passphrase (supports Argon2id and controlled legacy migration)
    const { valid, needsMigration } = await verifyOwnerPassphrase(passphrase, owner.passphrase_hash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // 5. Immediate Legacy Hash Migration: Rehash with Argon2id and update passphrase_hash ONLY
    // Preserves telegram_chat_id, telegram_user_id, telegram_username, telegram_linked_at, and display_name
    if (needsMigration) {
      try {
        const modernArgon2Hash = await hashOwnerPassphrase(passphrase);
        repos.owners.updatePassphraseHash(modernArgon2Hash, owner.id);
      } catch {
        // Non-fatal: login proceeds if session storage works; migration retries on next login
      }
    }

    // 6. Session Fixation Defense & 7. Issue Fresh Durable Session
    const existingCookies = parseCookies(req.headers.cookie);
    const existingToken = existingCookies[OWNER_COOKIE_NAME];

    let rawSessionToken: string;
    let csrfToken: string;
    try {
      if (existingToken) {
        sessionStore.invalidateSession(existingToken);
      }
      const created = sessionStore.createSession({
        id: owner.id,
        displayName: owner.display_name,
      });
      rawSessionToken = created.rawSessionToken;
      csrfToken = created.csrfToken;
    } catch (err: unknown) {
      if (err instanceof SessionOwnerNotFoundError) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      options.logger?.warn?.(
        `[Auth] Session storage failure during login: ${err instanceof Error ? err.message : String(err)}`
      );
      res.status(503).json({
        error: 'Session storage unavailable. Please try again later.',
      });
      return;
    }

    // 8. Set HTTP-Only, SameSite=Strict Cookie
    res.cookie(OWNER_COOKIE_NAME, rawSessionToken, {
      ...cookieBaseOptions,
      maxAge: DEFAULT_ABSOLUTE_TIMEOUT_MS,
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
      try {
        sessionStore.invalidateSession(rawSessionToken);
      } catch (err: unknown) {
        options.logger?.warn?.(
          `[Auth] Session storage failure during logout: ${err instanceof Error ? err.message : String(err)}`
        );
        // Fail closed on storage failure without clearing the client's session cookie
        res.status(503).json({
          error: 'Session storage unavailable. Please try again later.',
        });
        return;
      }
    }

    res.clearCookie(OWNER_COOKIE_NAME, cookieBaseOptions);

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

    let session: ReturnType<typeof sessionStore.getSession>;
    try {
      session = sessionStore.getSession(rawSessionToken);
    } catch (err: unknown) {
      options.logger?.warn?.(
        `[Auth] Session storage failure during session check: ${err instanceof Error ? err.message : String(err)}`
      );
      // Fail closed on transient storage error without clearing the user's cookie
      res.status(503).json({
        error: 'Session storage unavailable. Please try again later.',
      });
      return;
    }

    if (!session) {
      res.clearCookie(OWNER_COOKIE_NAME, cookieBaseOptions);
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

