/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T1: Owner Authentication, Server-Side Sessions & CSRF Protection
 *
 * Implements:
 * - Single-owner authentication against authoritative database record (owners.passphrase_hash).
 * - Modern Argon2id password hashing and verification (@node-rs/argon2).
 * - Automatic migration of legacy SHA-256 hashes upon successful authentication.
 * - Secure server-side sessions: stores SHA-256 digests of 32-byte tokens in memory,
 *   never persisting or logging raw session tokens.
 * - Dual session expiry: absolute (24h) and idle (60m) timeouts with session fixation defense.
 * - Header-only CSRF token verification (x-csrf-token) via constant-time comparison.
 * - Safe client IP extraction respecting Express proxy trust settings with login rate limiting (~5/min).
 * - Production cookie flags: HttpOnly, SameSite=Strict, Path=/, Secure (in production/HTTPS).
 *
 * Security Invariants:
 * - Hard Rule 1: Sandbox only. Never add code paths that use PayPal production.
 * - Hard Rule 2: Never log or persist plaintext credentials, session secrets, or raw keys.
 * - Fail closed: Missing owner, invalid credentials, or missing CSRF tokens reject immediately.
 * - Strict role separation: Agent Bearer auth (/mcp) and Owner session auth (/api) remain isolated.
 */

import * as crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { hash, verify } from '@node-rs/argon2';

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
  readonly idleTimeoutMs?: number;
  readonly absoluteTimeoutMs?: number;
}

export interface VerifyOwnerResult {
  readonly valid: boolean;
  readonly needsMigration: boolean;
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
 * Computes a SHA-256 digest of the raw session token for in-memory indexing.
 */
export function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * In-memory owner session registry.
 * Stores only SHA-256 digests of session tokens, mitigating memory-disclosure risks.
 */
export class OwnerSessionStore {
  private readonly sessions = new Map<string, OwnerSessionRecord>();
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;

  constructor(options?: SessionStoreOptions) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.absoluteTimeoutMs = options?.absoluteTimeoutMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS;
  }

  /**
   * Issues a fresh session, generating 32 cryptographically random bytes for the token
   * and 32 bytes for the CSRF secret. Stores only the SHA-256 digest.
   */
  public createSession(
    owner: { id: string; displayName: string },
    now = Date.now()
  ): {
    rawSessionToken: string;
    csrfToken: string;
    sessionRecord: OwnerSessionRecord;
  } {
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

    this.sessions.set(sessionKey, sessionRecord);
    return { rawSessionToken, csrfToken, sessionRecord };
  }

  /**
   * Retrieves an active session by its raw token, evaluating idle and absolute expiration.
   */
  public getSession(rawSessionToken: string, now = Date.now()): OwnerSessionRecord | undefined {
    if (!rawSessionToken) return undefined;
    const sessionKey = hashSessionToken(rawSessionToken);
    const session = this.sessions.get(sessionKey);
    if (!session) return undefined;

    // Evaluate absolute timeout
    if (now - session.createdAt > this.absoluteTimeoutMs) {
      this.sessions.delete(sessionKey);
      return undefined;
    }

    // Evaluate idle timeout
    if (now - session.lastAccessedAt > this.idleTimeoutMs) {
      this.sessions.delete(sessionKey);
      return undefined;
    }

    // Touch last accessed timestamp
    session.lastAccessedAt = now;
    return session;
  }

  /**
   * Invalidates a session by raw token.
   */
  public invalidateSession(rawSessionToken: string): boolean {
    if (!rawSessionToken) return false;
    const sessionKey = hashSessionToken(rawSessionToken);
    return this.sessions.delete(sessionKey);
  }

  /**
   * Purges all expired sessions from memory.
   */
  public cleanupExpired(now = Date.now()): number {
    let purged = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (
        now - session.createdAt > this.absoluteTimeoutMs ||
        now - session.lastAccessedAt > this.idleTimeoutMs
      ) {
        this.sessions.delete(key);
        purged++;
      }
    }
    return purged;
  }

  public get activeCount(): number {
    return this.sessions.size;
  }

  public clear(): void {
    this.sessions.clear();
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
 */
export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(maxAttempts = DEFAULT_LOGIN_RATE_LIMIT, windowMs = DEFAULT_LOGIN_WINDOW_MS) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  public check(ip: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    let history = this.attempts.get(ip);
    if (!history) {
      history = [];
      this.attempts.set(ip, history);
    }

    const cutoff = now - this.windowMs;
    history = history.filter((ts) => ts > cutoff);
    this.attempts.set(ip, history);

    if (history.length >= this.maxAttempts) {
      const oldest = history[0] ?? now;
      const resetMs = Math.max(1000, oldest + this.windowMs - now);
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(resetMs / 1000),
      };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  public recordAttempt(ip: string, now = Date.now()): void {
    let history = this.attempts.get(ip);
    if (!history) {
      history = [];
      this.attempts.set(ip, history);
    }
    history.push(now);
  }

  public reset(ip: string): void {
    this.attempts.delete(ip);
  }

  public clear(): void {
    this.attempts.clear();
  }
}

// ============================================================================
// Cookie Parser Helper
// ============================================================================

/**
 * Lightweight native cookie parser reading key-value pairs from Cookie header.
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      cookies[key] = decodeURIComponent(val);
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

/**
 * Express middleware requiring a valid owner session.
 * For state-changing methods (POST, PUT, DELETE, PATCH), enforces x-csrf-token header validation.
 */
export function createOwnerAuthMiddleware(sessionStore: OwnerSessionStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cookies = parseCookies(req.headers.cookie);
    const rawSessionToken = cookies[OWNER_COOKIE_NAME];

    if (!rawSessionToken) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const session = sessionStore.getSession(rawSessionToken);
    if (!session) {
      res.clearCookie(OWNER_COOKIE_NAME, { path: '/' });
      res.status(401).json({ error: 'Session expired or invalid' });
      return;
    }

    // Attach verified session record to request
    req.ownerSession = session;

    // Enforce header-only CSRF verification on state-changing methods
    const stateChangingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
    if (stateChangingMethods.includes(req.method.toUpperCase())) {
      const incomingCsrf = req.headers['x-csrf-token'];
      const csrfString = typeof incomingCsrf === 'string' ? incomingCsrf.trim() : undefined;

      if (!verifyCsrfToken(csrfString, session.csrfToken)) {
        res.status(403).json({ error: 'CSRF token missing or invalid' });
        return;
      }
    }

    next();
  };
}
