/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T1: Global AI Rate Limiter
 *
 * Implements:
 * - In-memory rolling sliding-window rate limiter enforcing PLAN.md Section 14 limit:
 *   20 calls per 60 seconds across all AI operations.
 * - Single-process local implementation, perfectly suited for PayGuard's single-process
 *   architecture (Node.js runtime on Render/local).
 * - Implements the generic RateLimiter interface, keeping the design cleanly replaceable
 *   with a distributed backend (e.g. Redis, Cloudflare KV) if scaled horizontally later.
 * - Thread-safe within the Node.js event loop: synchronous timestamp pruning and atomic
 *   quota consumption prevent concurrency race conditions between asynchronous AI calls.
 */

import type { RateLimiter } from './types.js';

export interface AiRateLimiterOptions {
  /** Maximum number of allowed requests in the rolling window (default: 20 per PLAN.md Section 14) */
  readonly maxRequests?: number;
  /** Window duration in milliseconds (default: 60,000 ms / 1 minute) */
  readonly windowMs?: number;
}

/**
 * Process-local rolling sliding-window rate limiter.
 */
export class AiRateLimiter implements RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(options?: AiRateLimiterOptions) {
    this.maxRequests = options?.maxRequests ?? 20;
    this.windowMs = options?.windowMs ?? 60_000;
  }

  /**
   * Atomically checks and consumes quota for a single AI request.
   *
   * Synchronization:
   * Pruning and appending happen synchronously in the JavaScript thread before
   * any async provider dispatch occurs, eliminating race conditions under concurrency.
   *
   * @param now Current timestamp in epoch ms (injected or Date.now())
   * @returns { allowed: true, retryAfterMs: 0 } or { allowed: false, retryAfterMs: number }
   */
  public consume(now: number = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const cutoff = now - this.windowMs;

    // Prune timestamps outside the rolling window
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);

    if (this.timestamps.length >= this.maxRequests) {
      const oldest = this.timestamps[0] ?? now;
      // Time until the oldest timestamp falls out of the window
      const retryAfterMs = Math.max(1000, oldest + this.windowMs - now);
      return { allowed: false, retryAfterMs };
    }

    this.timestamps.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  /**
   * Resets the rate limiter history (for testing).
   */
  public reset(): void {
    this.timestamps = [];
  }

  /**
   * Returns current active request count within the window.
   */
  public getActiveCount(now: number = Date.now()): number {
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
    return this.timestamps.length;
  }
}
