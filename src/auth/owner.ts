/**
 * PayGuard — Milestone M4 / M6-T5: Owner Authentication, Persistent Sessions & CSRF Protection
 *
 * Implements:
 * - Single-owner authentication against authoritative database record (owners.passphrase_hash).
 * - Modern Argon2id password hashing and verification (@node-rs/argon2).
 * - Automatic migration of legacy SHA-256 hashes upon successful authentication.
 * - Persistent server-side sessions backed by SQLite (owner_sessions): stores SHA-256 digests
 *   of 32-byte tokens, never persisting or logging raw session tokens or passwords.
 * - Fail-closed session storage error handling (SessionStorageError -> HTTP 503 without clearing cookies).
 * - Dual session expiry: absolute (24h) and idle (60m) timeouts with session fixation defense.
 * - Header-only CSRF token verification (x-csrf-token) via constant-time comparison.
 * - Safe client IP extraction respecting Express proxy trust settings with atomic sliding-window rate limiting.
 * - Production cookie flags: HttpOnly, SameSite=Strict, Path=/, Secure (in production/HTTPS).
 *
 * Security Invariants:
 * - Hard Rule 1: Sandbox only. Never add code paths that use PayPal production.
 * - Hard Rule 2: Never log or persist plaintext credentials, session secrets, or raw keys.
 * - Fail closed: Missing owner, invalid credentials, missing CSRF tokens, or unavailable session storage reject immediately.
 * - Strict role separation: Agent Bearer auth (/mcp) and Owner session auth (/api) remain isolated.
 */

import * as crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { hash, verify } from '@node-rs/argon2';
import { runInTransaction, type Database } from '../db/connection.js';
import { Repositories } from '../db/repositories.js';

// ============================================================================
// Constants & Configuration
// ============================================================================

export const OWNER_COOKIE_NAME = 'pg_owner_session';
export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
export const DEFAULT_ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_LOGIN_RATE_LIMIT = 5; // 5 attempts
export const DEFAULT_LOGIN_WINDOW_MS = 60 * 1000; // 1 minute

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface OwnerSessionRecord {
  readonly sessionKey: string; // SHA-256 digest of raw session token
  readonly ownerId: string;    // 'default'
  readonly displayName: string;
  readonly csrfToken: string;  // 32-byte hex token
  readonly createdAt: number;  // epoch ms
  lastAccessedAt: number;     // epoch ms
}

export interface SessionStoreOptions {
  readonly db: Database;
  readonly repos?: Repositories;
  readonly idleTimeoutMs?: number;
  readonly absoluteTimeoutMs?: number;
}

export interface OwnerCookieOptionsConfig {
  readonly isProduction?: boolean;
  readonly secureCookie?: boolean;
}

export interface OwnerAuthMiddlewareConfig extends OwnerCookieOptionsConfig {
  /**
   * When true, allows _csrf token verification from application/x-www-form-urlencoded POST bodies
   * if the x-csrf-token header is absent. Used exclusively for browser HTML form submissions (/a/:token/*).
   */
  readonly allowFormBodyCsrf?: boolean;
  /**
   * When true, renders sanitized HTML error/sign-in responses when the request prefers text/html.
   */
  readonly htmlErrorResponses?: boolean;
}

export interface VerifyOwnerResult {
  readonly valid: boolean;
  readonly needsMigration: boolean;
}

export class SessionStorageError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SessionStorageError';
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SessionOwnerNotFoundError extends Error {
  public readonly ownerId: string;

  constructor(ownerId: string) {
    super(`Owner account '${ownerId}' does not exist for session creation`);
    this.name = 'SessionOwnerNotFoundError';
    this.ownerId = ownerId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const STORAGE_SQLITE_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_ERROR',
  'SQLITE_CORRUPT',
  'SQLITE_NOTADB',
  'SQLITE_IOERR',
  'SQLITE_CANTOPEN',
  'SQLITE_READONLY',
  'SQLITE_FULL',
  'SQLITE_PERM',
  'SQLITE_ABORT',
  'SQLITE_NOLFS',
  'SQLITE_AUTH',
  'SQLITE_PROTOCOL',
]);

export function isSessionStorageError(err: unknown): boolean {
  if (err instanceof SessionStorageError) {
    return true;
  }
  if (!err || typeof err !== 'object') {
    return false;
  }
  const maybeCode = (err as { code?: unknown }).code;
  if (typeof maybeCode === 'string') {
    if (
      STORAGE_SQLITE_CODES.has(maybeCode) ||
      maybeCode.startsWith('SQLITE_IOERR_') ||
      maybeCode.startsWith('SQLITE_BUSY_')
    ) {
      return true;
    }
  }
  const maybeMessage = (err as { message?: unknown }).message;
  if (typeof maybeMessage === 'string') {
    const lower = maybeMessage.toLowerCase();
    if (
      lower.includes('database connection is not open') ||
      lower.includes('no such table') ||
      lower.includes('database is locked') ||
      lower.includes('disk i/o error') ||
      lower.includes('database disk image is malformed') ||
      lower.includes('readonly database')
    ) {
      return true;
    }
  }
  return false;
}

export function resolveOwnerCookieSecureFlag(options?: OwnerCookieOptionsConfig): boolean {
  if (options?.secureCookie !== undefined) {
    return options.secureCookie;
  }
  return options?.isProduction ?? process.env.NODE_ENV === 'production';
}

export function buildOwnerSessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure,
  };
}

// ============================================================================
// Passphrase Hashing & Verification
// ============================================================================

/**
 * Computes an Argon2id password hash for the owner passphrase using standard PHC string format.
 */
export async function hashOwnerPassphrase(passphrase: string): Promise<string> {
  return await hash(passphrase);
}

/**
 * Verifies an owner passphrase against the stored hash.
 * Supports Argon2id directly, and detects legacy SHA-256 hashes for immediate rehashing.
 */
export async function verifyOwnerPassphrase(
  passphrase: string,
  storedHash: string
): Promise<VerifyOwnerResult> {
  if (!passphrase || !storedHash) {
    return { valid: false, needsMigration: false };
  }

  // Modern Argon2id verification
  if (storedHash.startsWith('$argon2')) {
    try {
      const isValid = await verify(storedHash, passphrase);
      return { valid: isValid, needsMigration: false };
    } catch {
      return { valid: false, needsMigration: false };
    }
  }

  // Controlled legacy fallback: 64-character SHA-256 hex string (from early demo seeds)
  if (/^[0-9a-f]{64}$/i.test(storedHash)) {
    const computed = crypto.createHash('sha256').update(passphrase, 'utf8').digest('hex');
    const computedBuf = Buffer.from(computed, 'utf8');
    const storedBuf = Buffer.from(storedHash, 'utf8');
    const isLegacyValid =
      computedBuf.length === storedBuf.length && crypto.timingSafeEqual(computedBuf, storedBuf);

    if (isLegacyValid) {
      // Valid legacy credential: flag for immediate Argon2id rehashing and database update
      return { valid: true, needsMigration: true };
    }
  }

  return { valid: false, needsMigration: false };
}

// ============================================================================
// Session Token Hashing & Session Store
// ============================================================================

/**
 * Computes a SHA-256 digest of the raw session token for indexed lookup.
 */
export function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * SQLite-backed owner session store.
 * Persists only SHA-256 digests of session tokens and CSRF secrets, never raw tokens or passwords.
 */
export class OwnerSessionStore {
  private readonly db: Database;
  private readonly repos: Repositories;
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;

  constructor(options: SessionStoreOptions) {
    this.db = options.db;
    this.repos = options.repos ?? new Repositories(options.db);
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.absoluteTimeoutMs = options.absoluteTimeoutMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS;
  }

  private ensureOpenDb(): void {
    if (!this.db || !this.db.open) {
      throw new SessionStorageError('Session database is closed or unavailable');
    }
  }

  /**
   * Issues a fresh durable session, generating 32 cryptographically random bytes for the token
   * and 32 bytes for the CSRF secret. Persists only the SHA-256 digest in SQLite.
   */
  public createSession(
    owner: { id: string; displayName: string },
    now = Date.now()
  ): {
    rawSessionToken: string;
    csrfToken: string;
    sessionRecord: OwnerSessionRecord;
  } {
    if (!owner?.id || typeof owner.id !== 'string' || owner.id.trim().length === 0) {
      throw new SessionOwnerNotFoundError(String(owner?.id ?? ''));
    }

    this.ensureOpenDb();

    const rawSessionToken = crypto.randomBytes(32).toString('hex');
    const sessionKey = hashSessionToken(rawSessionToken);
    const csrfToken = crypto.randomBytes(32).toString('hex');

    const sessionRecord: OwnerSessionRecord = {
      sessionKey,
      ownerId: owner.id,
      displayName: owner.displayName,
      csrfToken,
      createdAt: now,
      lastAccessedAt: now,
    };

    try {
      runInTransaction(this.db, () => {
        const ownerRow = this.repos.owners.get(owner.id);
        if (!ownerRow) {
          throw new SessionOwnerNotFoundError(owner.id);
        }

        this.repos.ownerSessions.insert({
          session_key: sessionKey,
          owner_id: owner.id,
          display_name: owner.displayName,
          csrf_token: csrfToken,
          created_at: now,
          last_accessed_at: now,
        });
      });
    } catch (err: unknown) {
      if (err instanceof SessionOwnerNotFoundError || err instanceof SessionStorageError) {
        throw err;
      }
      const maybeCode = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
      if (maybeCode === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        throw new SessionOwnerNotFoundError(owner.id);
      }
      throw new SessionStorageError('Failed to persist owner session in SQLite storage', err);
    }

    return { rawSessionToken, csrfToken, sessionRecord };
  }

  /**
   * Retrieves an active session by its raw token, evaluating idle and absolute expiration.
   * Fails closed with SessionStorageError when the underlying SQLite store is unavailable.
   */
  public getSession(rawSessionToken: string, now = Date.now()): OwnerSessionRecord | undefined {
    if (!rawSessionToken) return undefined;
    this.ensureOpenDb();

    const sessionKey = hashSessionToken(rawSessionToken);

    try {
      return runInTransaction(this.db, () => {
        const row = this.repos.ownerSessions.getBySessionKey(sessionKey);
        if (!row) {
          return undefined;
        }

        // Evaluate absolute timeout
        if (now - row.created_at > this.absoluteTimeoutMs) {
          this.repos.ownerSessions.deleteBySessionKey(sessionKey);
          return undefined;
        }

        // Evaluate idle timeout
        if (now - row.last_accessed_at > this.idleTimeoutMs) {
          this.repos.ownerSessions.deleteBySessionKey(sessionKey);
          return undefined;
        }

        // Touch last accessed timestamp durably
        const updated = this.repos.ownerSessions.touchLastAccessed(sessionKey, now);
        if (!updated) {
          return undefined;
        }

        return {
          sessionKey: row.session_key,
          ownerId: row.owner_id,
          displayName: row.display_name,
          csrfToken: row.csrf_token,
          createdAt: row.created_at,
          lastAccessedAt: now,
        };
      });
    } catch (err: unknown) {
      if (err instanceof SessionStorageError) {
        throw err;
      }
      throw new SessionStorageError('Failed to retrieve owner session from SQLite storage', err);
    }
  }

  /**
   * Invalidates a session by raw token.
   */
  public invalidateSession(rawSessionToken: string): boolean {
    if (!rawSessionToken) return false;
    this.ensureOpenDb();

    const sessionKey = hashSessionToken(rawSessionToken);
    try {
      return this.repos.ownerSessions.deleteBySessionKey(sessionKey);
    } catch (err: unknown) {
      throw new SessionStorageError('Failed to invalidate owner session in SQLite storage', err);
    }
  }

  /**
   * Invalidates all sessions bound to the specified owner ID.
   */
  public invalidateOwnerSessions(ownerId: string): number {
    if (!ownerId) return 0;
    this.ensureOpenDb();

    try {
      return this.repos.ownerSessions.deleteByOwnerId(ownerId);
    } catch (err: unknown) {
      throw new SessionStorageError('Failed to invalidate owner sessions in SQLite storage', err);
    }
  }

  /**
   * Purges all expired sessions from SQLite storage.
   */
  public cleanupExpired(now = Date.now()): number {
    this.ensureOpenDb();

    const idleCutoff = now - this.idleTimeoutMs;
    const absoluteCutoff = now - this.absoluteTimeoutMs;
    try {
      return this.repos.ownerSessions.deleteExpired(idleCutoff, absoluteCutoff);
    } catch (err: unknown) {
      throw new SessionStorageError('Failed to clean up expired owner sessions', err);
    }
  }

  public get activeCount(): number {
    this.ensureOpenDb();
    try {
      return this.repos.ownerSessions.count();
    } catch (err: unknown) {
      throw new SessionStorageError('Failed to count owner sessions in SQLite storage', err);
    }
  }

  public clear(): void {
    this.ensureOpenDb();
    try {
      this.repos.ownerSessions.clear();
    } catch (err: unknown) {
      throw new SessionStorageError('Failed to clear owner sessions in SQLite storage', err);
    }
  }
}

// ============================================================================
// CSRF Validation
// ============================================================================

/**
 * Validates an incoming CSRF token against the session CSRF token using constant-time comparison.
 */
export function verifyCsrfToken(incoming: string | undefined, expected: string): boolean {
  if (!incoming || typeof incoming !== 'string') {
    return false;
  }
  const expectedBuf = Buffer.from(expected, 'utf8');
  const incomingBuf = Buffer.from(incoming.trim(), 'utf8');
  if (expectedBuf.length !== incomingBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, incomingBuf);
}

// ============================================================================
// Safe Client IP Extraction & Login Rate Limiter
// ============================================================================

/**
 * Extracts client IP safely based on Express trust proxy configuration.
 * Avoids trusting arbitrary X-Forwarded-For headers when trust proxy is false.
 */
export function getSafeClientIp(req: Request): string {
  const trustProxy = req.app.get('trust proxy');
  if (trustProxy) {
    return req.ip || req.socket.remoteAddress || '127.0.0.1';
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

/**
 * In-memory sliding window rate limiter for login attempts per client IP.
 * Supports atomic synchronous reservation (`consume`) prior to asynchronous Argon2 verification
 * and periodic pruning of expired IP entries to prevent unbounded memory growth.
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly pruneThreshold: number;
  private lastPruneAt: number | null = null;

  constructor(
    maxAttempts = DEFAULT_LOGIN_RATE_LIMIT,
    windowMs = DEFAULT_LOGIN_WINDOW_MS,
    pruneThreshold = 1000
  ) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.pruneThreshold = pruneThreshold;
  }

  private maybePruneExpired(now: number): void {
    if (this.attempts.size === 0) {
      return;
    }
    if (
      this.lastPruneAt === null ||
      now - this.lastPruneAt >= this.windowMs ||
      this.attempts.size >= this.pruneThreshold
    ) {
      this.pruneExpired(now);
    }
  }

  /**
   * Atomically evaluates the rate limit and reserves an attempt slot if allowed.
   * Must be called synchronously before any async credential verification to prevent TOCTOU races.
   */
  public consume(ip: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    this.maybePruneExpired(now);
    if (this.lastPruneAt === null) {
      this.lastPruneAt = now;
    }

    const cutoff = now - this.windowMs;
    const existing = this.attempts.get(ip);
    const active = existing ? existing.filter((ts) => ts > cutoff) : [];

    if (active.length >= this.maxAttempts) {
      if (active.length > 0) {
        this.attempts.set(ip, active);
      } else {
        this.attempts.delete(ip);
      }
      const oldest = active[0] ?? now;
      const resetMs = Math.max(1000, oldest + this.windowMs - now);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(resetMs / 1000),
      };
    }

    active.push(now);
    this.attempts.set(ip, active);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  public check(ip: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    this.maybePruneExpired(now);

    const existing = this.attempts.get(ip);
    if (!existing) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const cutoff = now - this.windowMs;
    const active = existing.filter((ts) => ts > cutoff);
    if (active.length === 0) {
      this.attempts.delete(ip);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    this.attempts.set(ip, active);

    if (active.length >= this.maxAttempts) {
      const oldest = active[0] ?? now;
      const resetMs = Math.max(1000, oldest + this.windowMs - now);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(resetMs / 1000),
      };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  public recordAttempt(ip: string, now = Date.now()): void {
    this.maybePruneExpired(now);
    if (this.lastPruneAt === null) {
      this.lastPruneAt = now;
    }

    const cutoff = now - this.windowMs;
    const existing = this.attempts.get(ip);
    const active = existing ? existing.filter((ts) => ts > cutoff) : [];
    active.push(now);
    this.attempts.set(ip, active);
  }

  public pruneExpired(now = Date.now()): number {
    const cutoff = now - this.windowMs;
    let removed = 0;
    for (const [key, timestamps] of this.attempts.entries()) {
      const active = timestamps.filter((ts) => ts > cutoff);
      if (active.length === 0) {
        this.attempts.delete(key);
        removed++;
      } else if (active.length !== timestamps.length) {
        this.attempts.set(key, active);
      }
    }
    this.lastPruneAt = now;
    return removed;
  }

  public get trackedIpCount(): number {
    return this.attempts.size;
  }

  public reset(ip: string): void {
    this.attempts.delete(ip);
  }

  public clear(): void {
    this.attempts.clear();
    this.lastPruneAt = null;
  }
}

// ============================================================================
// Cookie Parser Helper
// ============================================================================

/**
 * Lightweight native cookie parser reading key-value pairs from Cookie header.
 * Safely skips malformed percent-encoded pairs and unsafe prototype keys without throwing.
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader || typeof cookieHeader !== 'string') return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      // Malformed percent encoding (e.g. %ZZ): skip this cookie pair safely and continue
      continue;
    }
  }
  return cookies;
}

// ============================================================================
// Express Owner Authentication Middleware
// ============================================================================

declare module 'express-serve-static-core' {
  interface Request {
    ownerSession?: OwnerSessionRecord;
  }
}

export interface OwnerAuthMiddlewareOptions {
  readonly sessionStore: OwnerSessionStore;
}

function prefersHtmlResponse(req: Request): boolean {
  return req.accepts(['json', 'html']) === 'html';
}

function escapeAuthHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderOwnerAuthHtmlPage(params: {
  readonly badge: string;
  readonly title: string;
  readonly message: string;
  readonly includeRetryLink?: boolean;
}): string {
  const retryHtml = params.includeRetryLink
    ? `<a class="btn btn-secondary" href="">Continue to Approval Review</a>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PayGuard — ${escapeAuthHtml(params.title)}</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; }
    body { margin: 0; padding: 1.5rem; display: flex; justify-content: center; align-items: center; min-height: 90vh; }
    .card { background: #1e293b; border-radius: 1rem; border: 1px solid #334155; padding: 1.5rem; max-width: 440px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
    .badge { display: inline-block; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; background: #7f1d1d; color: #fecaca; }
    h1 { font-size: 1.35rem; margin: 1rem 0 0.75rem; color: #f8fafc; }
    p { font-size: 0.95rem; color: #cbd5e1; line-height: 1.5; margin: 0 0 1.25rem; }
    .btn { display: block; width: 100%; box-sizing: border-box; padding: 0.85rem; border-radius: 0.5rem; border: none; font-size: 1rem; font-weight: 600; cursor: pointer; color: #ffffff; background: #0284c7; text-align: center; text-decoration: none; margin-top: 0.75rem; }
    .btn:hover { opacity: 0.92; }
    .btn-secondary { background: transparent; border: 1px solid #475569; color: #cbd5e1; }
  </style>
</head>
<body>
  <div class="card">
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <span style="font-weight: 700; font-size: 0.9rem; letter-spacing: 0.05em; color: #38bdf8;">PAYGUARD FIREWALL</span>
      <span class="badge">${escapeAuthHtml(params.badge)}</span>
    </div>
    <h1>${escapeAuthHtml(params.title)}</h1>
    <p>${escapeAuthHtml(params.message)}</p>
    <a class="btn" href="/">Open PayGuard Sign-In</a>
    ${retryHtml}
  </div>
</body>
</html>`;
}

/**
 * Express middleware requiring a valid owner session.
 * For state-changing methods (POST, PUT, DELETE, PATCH), enforces header CSRF validation
 * (and optionally URL-encoded form `_csrf` body validation when `allowFormBodyCsrf` is true).
 * Fails closed with HTTP 503 when session storage is unavailable without clearing client cookies.
 */
export function createOwnerAuthMiddleware(
  sessionStore: OwnerSessionStore,
  cookieConfig?: OwnerAuthMiddlewareConfig
) {
  const secureCookie = resolveOwnerCookieSecureFlag(cookieConfig);
  const allowFormBodyCsrf = cookieConfig?.allowFormBodyCsrf === true;
  const htmlErrorResponses = cookieConfig?.htmlErrorResponses === true;

  const sendAuthFailure = (
    req: Request,
    res: Response,
    status: number,
    error: string,
    htmlDetails: {
      readonly badge: string;
      readonly title: string;
      readonly message: string;
      readonly includeRetryLink?: boolean;
    }
  ): void => {
    if (htmlErrorResponses && prefersHtmlResponse(req)) {
      res.status(status);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderOwnerAuthHtmlPage(htmlDetails));
      return;
    }
    res.status(status).json({ error });
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    const cookies = parseCookies(req.headers.cookie);
    const rawSessionToken = cookies[OWNER_COOKIE_NAME];

    if (!rawSessionToken) {
      sendAuthFailure(req, res, 401, 'Authentication required', {
        badge: 'Sign-In Required',
        title: 'Owner Sign-In Required',
        message:
          'You must be signed in to PayGuard as the owner to review or act on payment approval requests. If you are already signed in, continue below to load this page with your session.',
        includeRetryLink: req.method.toUpperCase() === 'GET',
      });
      return;
    }

    let session: OwnerSessionRecord | undefined;
    try {
      session = sessionStore.getSession(rawSessionToken);
    } catch {
      // Fail closed with 503 on storage failure; do NOT clear the user's session cookie
      sendAuthFailure(req, res, 503, 'Session storage unavailable. Please try again later.', {
        badge: 'Service Unavailable',
        title: 'Session Storage Unavailable',
        message: 'PayGuard could not verify your owner session right now. Please try again shortly.',
      });
      return;
    }

    if (!session) {
      res.clearCookie(OWNER_COOKIE_NAME, buildOwnerSessionCookieOptions(secureCookie));
      sendAuthFailure(req, res, 401, 'Session expired or invalid', {
        badge: 'Session Expired',
        title: 'Owner Session Expired or Invalid',
        message: 'Your owner session has expired or is invalid. Please sign in again to continue.',
        includeRetryLink: req.method.toUpperCase() === 'GET',
      });
      return;
    }

    // Attach verified session record to request
    req.ownerSession = session;

    // Enforce CSRF verification on state-changing methods
    const stateChangingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
    if (stateChangingMethods.includes(req.method.toUpperCase())) {
      const headerCsrf = req.headers['x-csrf-token'];
      let csrfString: string | undefined;

      if (headerCsrf !== undefined) {
        csrfString = typeof headerCsrf === 'string' ? headerCsrf.trim() : undefined;
      } else if (
        allowFormBodyCsrf &&
        req.is('application/x-www-form-urlencoded') &&
        req.body &&
        typeof req.body === 'object' &&
        !Array.isArray(req.body)
      ) {
        const bodyCsrf = (req.body as Record<string, unknown>)._csrf;
        csrfString = typeof bodyCsrf === 'string' ? bodyCsrf.trim() : undefined;
      }

      if (!verifyCsrfToken(csrfString, session.csrfToken)) {
        sendAuthFailure(req, res, 403, 'CSRF token missing or invalid', {
          badge: 'Forbidden',
          title: 'Security Verification Failed',
          message: 'Your approval form submission could not be verified (CSRF token missing or invalid). Please reload the approval link and try again.',
        });
        return;
      }
    }

    next();
  };
}
