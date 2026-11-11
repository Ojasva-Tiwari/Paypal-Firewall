/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3-B: Telegram Webhook Authentication & Concurrency Middleware
 *
 * Implements:
 * - Constant-time Telegram webhook secret verification middleware (before JSON body parsing)
 * - Three-state in-memory UpdateDeduplicator (UNKNOWN / IN_PROGRESS / COMPLETED)
 *
 * Note on Deduplication Semantics:
 * The UpdateDeduplicator is a best-effort in-memory optimization to absorb duplicate
 * deliveries and handle concurrent in-flight webhook requests. It is explicitly
 * non-durable across process restarts. Authoritative security controls (atomic CAS and
 * database uniqueness) remain strictly enforced in SQLite.
 */

import * as crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

// ============================================================================
// Constant-Time Webhook Secret Verification
// ============================================================================

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Constant-time comparison between incoming secret token and configured secret.
 */
export function verifyWebhookSecretToken(
  incomingHeader: string | undefined,
  expectedSecret: string
): boolean {
  if (!incomingHeader || typeof incomingHeader !== 'string') return false;
  if (!expectedSecret || typeof expectedSecret !== 'string') return false;

  const incomingBuf = Buffer.from(incomingHeader.trim(), 'utf8');
  const expectedBuf = Buffer.from(expectedSecret.trim(), 'utf8');

  if (incomingBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(incomingBuf, expectedBuf);
}

/**
 * Express middleware verifying Telegram webhook secret before body parsing.
 * Responds with HTTP 403 Forbidden immediately on mismatch without parsing body.
 */
export function createTelegramWebhookAuthMiddleware(expectedSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incomingSecret = req.headers[TELEGRAM_SECRET_HEADER] as string | undefined;

    if (!verifyWebhookSecretToken(incomingSecret, expectedSecret)) {
      res.status(403).json({ error: 'Unauthorized: Invalid or missing Telegram webhook secret' });
      return;
    }

    next();
  };
}

// ============================================================================
// Three-State Update Deduplicator
// ============================================================================

export type UpdateProcessingState = 'IN_PROGRESS' | 'COMPLETED';

export interface UpdateRecord {
  readonly state: UpdateProcessingState;
  readonly timestamp: number;
}

export interface UpdateDeduplicatorOptions {
  readonly ttlMs?: number;
  readonly maxCapacity?: number;
}

export class UpdateDeduplicator {
  private readonly records = new Map<number | string, UpdateRecord>();
  private readonly ttlMs: number;
  private readonly maxCapacity: number;

  constructor(options: UpdateDeduplicatorOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000; // 10 minutes default
    this.maxCapacity = options.maxCapacity ?? 10_000;
  }

  /**
   * Checks the status of an update_id.
   * Evicts expired records on access.
   */
  public get(updateId: number | string): UpdateProcessingState | null {
    this.prune();
    const record = this.records.get(updateId);
    if (!record) return null;

    if (Date.now() - record.timestamp > this.ttlMs) {
      this.records.delete(updateId);
      return null;
    }

    return record.state;
  }

  /**
   * Marks an update as currently executing.
   */
  public markInProgress(updateId: number | string): void {
    this.prune();
    if (this.records.size >= this.maxCapacity) {
      // Evict oldest record
      const oldestKey = this.records.keys().next().value;
      if (oldestKey !== undefined) this.records.delete(oldestKey);
    }
    this.records.set(updateId, { state: 'IN_PROGRESS', timestamp: Date.now() });
  }

  /**
   * Marks an update as successfully processed.
   */
  public markCompleted(updateId: number | string): void {
    this.prune();
    if (!this.records.has(updateId) && this.records.size >= this.maxCapacity) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey !== undefined) this.records.delete(oldestKey);
    }
    this.records.set(updateId, { state: 'COMPLETED', timestamp: Date.now() });
  }

  /**
   * Clears an in-progress update record on transient failure so Telegram retries can proceed.
   */
  public clear(updateId: number | string): void {
    this.records.delete(updateId);
  }

  /**
   * Total active tracked records (used for test assertions).
   */
  public size(): number {
    return this.records.size;
  }

  /**
   * Removes expired records.
   */
  private prune(): void {
    const now = Date.now();
    for (const [id, record] of this.records.entries()) {
      if (now - record.timestamp > this.ttlMs) {
        this.records.delete(id);
      }
    }
  }

  /**
   * Clears all entries.
   */
  public reset(): void {
    this.records.clear();
  }
}
