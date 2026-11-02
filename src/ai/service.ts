/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T1: High-Level AI Service
 *
 * Implements:
 * - Central orchestration for all AI capabilities across PayGuard.
 * - Hash-based cache lookup (input_hash) against SQLite ai_runs table.
 * - Strict Invariants:
 *   - Cache hits DO NOT consume rate limit tokens.
 *   - Only successful AI generations (status = 'SUCCESS') are returned as cache hits.
 *   - Deterministic payment decisions are NEVER cached.
 *   - Database audit write failures NEVER crash the host process or abort execution.
 *   - Global sliding window rate limiting (20 req / 60s).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import type { AiRunRow } from '../db/types.js';
import {
  AiProvider,
  AiPromptOptions,
  AiRunMetadata,
  AiRunStatus,
  AiTextResult,
  AiStructuredResult,
  AiRateLimitError,
  AiTimeoutError,
  RateLimiter,
} from './types.js';
import { extractCacheKeyParams, computeAiInputHash } from './cache.js';
import { AiRateLimiter } from './rateLimiter.js';

export interface AiServiceOptions {
  readonly provider: AiProvider;
  readonly rateLimiter?: RateLimiter;
  readonly repos?: Repositories;
  /** Cache time-to-live in milliseconds (default: 15 minutes / 900,000 ms) */
  readonly cacheTtlMs?: number;
}

export class AiService {
  private readonly provider: AiProvider;
  private readonly rateLimiter: RateLimiter;
  private readonly repos?: Repositories;
  private readonly cacheTtlMs: number;

  constructor(options: AiServiceOptions) {
    this.provider = options.provider;
    this.rateLimiter = options.rateLimiter ?? new AiRateLimiter();
    this.repos = options.repos;
    this.cacheTtlMs = options.cacheTtlMs ?? 15 * 60 * 1000; // 15 minutes
  }

  public get providerKind(): string {
    return this.provider.kind;
  }

  public get modelName(): string {
    return this.provider.modelName;
  }

  /**
   * Generates unstructured text with caching, rate limiting, and execution auditing.
   */
  public async generateText(
    options: AiPromptOptions,
    signal?: AbortSignal
  ): Promise<AiTextResult> {
    const cacheParams = extractCacheKeyParams(options, this.provider.kind, this.provider.modelName);
    const inputHash = computeAiInputHash(cacheParams);

    // 1. Cache lookup: check if an identical successful run exists within TTL
    if (this.repos && this.cacheTtlMs > 0) {
      const minCreatedAt = new Date(Date.now() - this.cacheTtlMs).toISOString();
      const cachedRow = this.safeFindCache(inputHash, minCreatedAt);

      if (cachedRow && cachedRow.status === 'SUCCESS') {
        const metadata: AiRunMetadata = {
          id: cachedRow.id,
          kind: cachedRow.kind,
          model: cachedRow.model,
          inputHash: cachedRow.input_hash,
          latencyMs: 0,
          status: 'SUCCESS',
          cached: true,
        };
        return { text: cachedRow.output, metadata };
      }
    }

    // 2. Rate limit consumption: cache hits bypassed rate limiting; miss consumes quota
    const quota = this.rateLimiter.consume();
    if (!quota.allowed) {
      const runId = `airun-${randomUUID()}`;
      this.safeRecordRun({
        id: runId,
        kind: cacheParams.kind,
        request_id: options.requestId ?? null,
        model: this.provider.modelName,
        input_hash: inputHash,
        output: JSON.stringify({ error: 'RATE_LIMITED', retryAfterMs: quota.retryAfterMs }),
        latency_ms: 0,
        status: 'RATE_LIMITED',
        created_at: new Date().toISOString(),
      });
      throw new AiRateLimitError(quota.retryAfterMs);
    }

    // 3. Provider invocation with performance tracking
    const runId = `airun-${randomUUID()}`;
    const start = Date.now();

    try {
      const { text, latencyMs } = await this.provider.generateText(options, signal);

      const metadata: AiRunMetadata = {
        id: runId,
        kind: cacheParams.kind,
        model: this.provider.modelName,
        inputHash,
        latencyMs,
        status: 'SUCCESS',
        cached: false,
      };

      this.safeRecordRun({
        id: runId,
        kind: cacheParams.kind,
        request_id: options.requestId ?? null,
        model: this.provider.modelName,
        input_hash: inputHash,
        output: text,
        latency_ms: latencyMs,
        status: 'SUCCESS',
        created_at: new Date().toISOString(),
      });

      return { text, metadata };
    } catch (err: unknown) {
      const elapsed = Date.now() - start;
      const status: AiRunStatus =
        err instanceof AiTimeoutError
          ? 'TIMEOUT'
          : err instanceof AiRateLimitError
            ? 'RATE_LIMITED'
            : 'ERROR';

      this.safeRecordRun({
        id: runId,
        kind: cacheParams.kind,
        request_id: options.requestId ?? null,
        model: this.provider.modelName,
        input_hash: inputHash,
        output: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        latency_ms: elapsed,
        status,
        created_at: new Date().toISOString(),
      });

      throw err;
    }
  }

  /**
   * Generates structured output validated against a Zod schema with caching and rate limiting.
   */
  public async generateStructured<T>(
    options: AiPromptOptions,
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<AiStructuredResult<T>> {
    const cacheParams = extractCacheKeyParams(options, this.provider.kind, this.provider.modelName);
    const inputHash = computeAiInputHash(cacheParams);

    // 1. Cache lookup
    if (this.repos && this.cacheTtlMs > 0) {
      const minCreatedAt = new Date(Date.now() - this.cacheTtlMs).toISOString();
      const cachedRow = this.safeFindCache(inputHash, minCreatedAt);

      if (cachedRow && cachedRow.status === 'SUCCESS') {
        try {
          const parsed = JSON.parse(cachedRow.output);
          const validation = schema.safeParse(parsed);
          if (validation.success) {
            const metadata: AiRunMetadata = {
              id: cachedRow.id,
              kind: cachedRow.kind,
              model: cachedRow.model,
              inputHash: cachedRow.input_hash,
              latencyMs: 0,
              status: 'SUCCESS',
              cached: true,
            };
            return {
              data: validation.data,
              rawText: cachedRow.output,
              metadata,
            };
          }
        } catch {
          // If cached output is corrupt or does not match current schema, treat as cache miss
        }
      }
    }

    // 2. Rate limit consumption
    const quota = this.rateLimiter.consume();
    if (!quota.allowed) {
      const runId = `airun-${randomUUID()}`;
      this.safeRecordRun({
        id: runId,
        kind: cacheParams.kind,
        request_id: options.requestId ?? null,
        model: this.provider.modelName,
        input_hash: inputHash,
        output: JSON.stringify({ error: 'RATE_LIMITED', retryAfterMs: quota.retryAfterMs }),
        latency_ms: 0,
        status: 'RATE_LIMITED',
        created_at: new Date().toISOString(),
      });
      throw new AiRateLimitError(quota.retryAfterMs);
    }

    // 3. Provider invocation
    const runId = `airun-${randomUUID()}`;
    const start = Date.now();

    try {
      const { data, rawText, latencyMs } = await this.provider.generateStructured(
        options,
        schema,
        signal
      );

      const metadata: AiRunMetadata = {
        id: runId,
        kind: cacheParams.kind,
        model: this.provider.modelName,
        inputHash,
        latencyMs,
        status: 'SUCCESS',
        cached: false,
      };

      this.safeRecordRun({
        id: runId,
        kind: cacheParams.kind,
        request_id: options.requestId ?? null,
        model: this.provider.modelName,
        input_hash: inputHash,
        output: rawText,
        latency_ms: latencyMs,
        status: 'SUCCESS',
        created_at: new Date().toISOString(),
      });

      return { data, rawText, metadata };
    } catch (err: unknown) {
      const elapsed = Date.now() - start;
      const status: AiRunStatus =
        err instanceof AiTimeoutError
          ? 'TIMEOUT'
          : err instanceof AiRateLimitError
            ? 'RATE_LIMITED'
            : 'ERROR';

      this.safeRecordRun({
        id: runId,
        kind: cacheParams.kind,
        request_id: options.requestId ?? null,
        model: this.provider.modelName,
        input_hash: inputHash,
        output: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        latency_ms: elapsed,
        status,
        created_at: new Date().toISOString(),
      });

      throw err;
    }
  }

  /**
   * Safely queries the cache without letting DB errors crash the process.
   */
  private safeFindCache(inputHash: string, minCreatedAt: string): AiRunRow | undefined {
    try {
      return this.repos?.aiRuns.findLatestValidCache(inputHash, minCreatedAt);
    } catch (err: unknown) {
      // Diagnostic warning: DB lookup failure must not abort evaluation
      console.warn('[AI_CACHE_LOOKUP_WARNING]', err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  /**
   * Safely records an AI run to the SQLite ai_runs table.
   * Hard Rule Guarantee: SQLite write failures NEVER crash the host process or abort caller execution.
   */
  private safeRecordRun(run: AiRunRow): void {
    if (!this.repos) return;
    try {
      this.repos.aiRuns.insert(run);
    } catch (err: unknown) {
      console.warn('[AI_RUN_RECORD_WARNING]', err instanceof Error ? err.message : String(err));
    }
  }
}
