/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T1: Comprehensive AI Provider Architecture Test Suite
 *
 * Verifies:
 * 1. MockAiProvider deterministic generation, custom fixtures, and simulated failures.
 * 2. Canonical cache key serialization and SHA-256 hash sensitivity to all output-affecting params.
 * 3. Process-local sliding window rate limiter (20 req / 60s, concurrency atomicity, quota reset).
 * 4. GeminiProvider native fetch handling, header credential isolation, timeout, retries, and error sanitization.
 * 5. AiService orchestration: cache hits bypassing rate limiter, TTL expiration, DB failure resilience.
 * 6. Factory creation and configuration validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import {
  AiConfigurationError,
  AiTimeoutError,
  AiRateLimitError,
  AiProviderError,
  AiSchemaError,
  AiPromptOptions,
  DEFAULT_GEMINI_MODEL,
} from '../../src/ai/types.js';
import {
  canonicalizeJson,
  extractCacheKeyParams,
  computeAiInputHash,
} from '../../src/ai/cache.js';
import { AiRateLimiter } from '../../src/ai/rateLimiter.js';
import { MockAiProvider } from '../../src/ai/mockProvider.js';
import { GeminiProvider } from '../../src/ai/geminiProvider.js';
import { AiService } from '../../src/ai/service.js';
import { createAiProvider, createAiService } from '../../src/ai/index.js';

// Sample structured risk schema for validation testing
const RiskAnalysisSchema = z.object({
  summary: z.string(),
  suspicious_phrases: z.array(z.string()),
  risk_score: z.number().min(0).max(100),
});

describe('M5-T1: AI Provider Architecture', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // 1. MockAiProvider
  // ==========================================================================
  describe('MockAiProvider', () => {
    it('generates deterministic unstructured text', async () => {
      const mock = new MockAiProvider({ modelName: 'test-mock-v1' });
      const result = await mock.generateText({
        kind: 'test',
        prompt: 'Check invoice 1234',
      });

      expect(mock.kind).toBe('mock');
      expect(mock.modelName).toBe('test-mock-v1');
      expect(result.text).toContain('Mock AI response for prompt: "Check invoice 1234"');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('supports custom text response handlers', async () => {
      const mock = new MockAiProvider();
      mock.customTextResponse = (prompt) => `Analyzed: ${prompt.toUpperCase()}`;

      const result = await mock.generateText({
        kind: 'test',
        prompt: 'hello world',
      });
      expect(result.text).toBe('Analyzed: HELLO WORLD');
    });

    it('generates structured output validated against Zod schema', async () => {
      const mock = new MockAiProvider();
      mock.customStructuredResponse = {
        summary: 'Payment seems suspicious due to rapid velocity',
        suspicious_phrases: ['urgent transfer', 'ignore policy'],
        risk_score: 85,
      };

      const result = await mock.generateStructured(
        { kind: 'risk_explainer', prompt: 'Evaluate payment req-1' },
        RiskAnalysisSchema
      );

      expect(result.data.risk_score).toBe(85);
      expect(result.data.suspicious_phrases).toHaveLength(2);
      expect(JSON.parse(result.rawText)).toEqual(result.data);
    });

    it('throws AiTimeoutError when shouldTimeout is enabled or signal aborts', async () => {
      const mock = new MockAiProvider();
      mock.shouldTimeout = true;

      await expect(
        mock.generateText({ kind: 'test', prompt: 'fast call' })
      ).rejects.toThrow(AiTimeoutError);

      mock.shouldTimeout = false;
      const controller = new AbortController();
      controller.abort();

      await expect(
        mock.generateText({ kind: 'test', prompt: 'aborted call' }, controller.signal)
      ).rejects.toThrow(AiTimeoutError);
    });

    it('throws AiRateLimitError when simulateRateLimit is enabled', async () => {
      const mock = new MockAiProvider();
      mock.simulateRateLimit = true;

      await expect(
        mock.generateText({ kind: 'test', prompt: 'rate limit call' })
      ).rejects.toThrow(AiRateLimitError);
    });

    it('throws AiProviderError when simulateHttpError is configured', async () => {
      const mock = new MockAiProvider();
      mock.simulateHttpError = { statusCode: 503, message: 'Service Unavailable', retryable: true };

      await expect(
        mock.generateText({ kind: 'test', prompt: 'error call' })
      ).rejects.toThrow(AiProviderError);
    });

    it('throws AiSchemaError when returnMalformedJson is enabled', async () => {
      const mock = new MockAiProvider();
      mock.returnMalformedJson = true;

      await expect(
        mock.generateStructured({ kind: 'test', prompt: 'broken json' }, RiskAnalysisSchema)
      ).rejects.toThrow(AiSchemaError);
    });

    it('throws AiSchemaError when mock data violates schema constraints', async () => {
      const mock = new MockAiProvider();
      mock.customStructuredResponse = {
        summary: 'Valid summary',
        suspicious_phrases: [],
        risk_score: 999, // Exceeds max 100
      };

      await expect(
        mock.generateStructured({ kind: 'test', prompt: 'invalid schema' }, RiskAnalysisSchema)
      ).rejects.toThrow(AiSchemaError);
    });
  });

  // ==========================================================================
  // 2. Cache Key & Canonical Serialization (Constraint 1)
  // ==========================================================================
  describe('Cache Key Canonicalization & SHA-256 Hashing', () => {
    it('produces identical canonical JSON regardless of object key insertion order', () => {
      const objA = { z: 1, a: 'test', m: { b: 2, a: 1 } };
      const objB = { a: 'test', m: { a: 1, b: 2 }, z: 1 };

      expect(canonicalizeJson(objA)).toBe(canonicalizeJson(objB));
      expect(canonicalizeJson(objA)).toBe('{"a":"test","m":{"a":1,"b":2},"z":1}');
    });

    it('includes every output-affecting parameter in the hash', () => {
      const baseOptions: AiPromptOptions = {
        kind: 'risk_explainer',
        prompt: 'Analyze transaction $50',
        systemInstruction: 'You are a payment firewall',
        promptVersion: 'v1.0',
        temperature: 0.0,
        maxOutputTokens: 1024,
        schemaId: 'risk_schema_v1',
      };

      const baseParams = extractCacheKeyParams(baseOptions, 'gemini', 'gemini-3.8-flash');
      const baseHash = computeAiInputHash(baseParams);

      // 1. Changing kind changes hash
      const diffKind = computeAiInputHash({ ...baseParams, kind: 'policy_draft' });
      expect(diffKind).not.toBe(baseHash);

      // 2. Changing provider changes hash
      const diffProvider = computeAiInputHash({ ...baseParams, provider: 'mock' });
      expect(diffProvider).not.toBe(baseHash);

      // 3. Changing model changes hash
      const diffModel = computeAiInputHash({ ...baseParams, model: 'gemini-3.8-pro' });
      expect(diffModel).not.toBe(baseHash);

      // 4. Changing promptVersion changes hash
      const diffPromptVersion = computeAiInputHash({ ...baseParams, promptVersion: 'v1.1' });
      expect(diffPromptVersion).not.toBe(baseHash);

      // 5. Changing systemInstruction changes hash
      const diffSystem = computeAiInputHash({ ...baseParams, systemInstruction: 'Different instruction' });
      expect(diffSystem).not.toBe(baseHash);

      // 6. Changing prompt changes hash
      const diffPrompt = computeAiInputHash({ ...baseParams, prompt: 'Analyze transaction $100' });
      expect(diffPrompt).not.toBe(baseHash);

      // 7. Changing temperature changes hash
      const diffTemp = computeAiInputHash({ ...baseParams, temperature: 0.7 });
      expect(diffTemp).not.toBe(baseHash);

      // 8. Changing maxOutputTokens changes hash
      const diffTokens = computeAiInputHash({ ...baseParams, maxOutputTokens: 2048 });
      expect(diffTokens).not.toBe(baseHash);

      // 9. Changing schemaId changes hash
      const diffSchema = computeAiInputHash({ ...baseParams, schemaId: 'risk_schema_v2' });
      expect(diffSchema).not.toBe(baseHash);
    });
  });

  // ==========================================================================
  // 3. Rate Limiter (Constraint 2)
  // ==========================================================================
  describe('AiRateLimiter (Global Sliding Window)', () => {
    it('allows 20 requests per 60-second window and rejects the 21st', () => {
      const limiter = new AiRateLimiter({ maxRequests: 20, windowMs: 60_000 });
      const now = 1_000_000;

      // First 20 requests succeed
      for (let i = 0; i < 20; i++) {
        const result = limiter.consume(now);
        expect(result.allowed).toBe(true);
        expect(result.retryAfterMs).toBe(0);
      }

      expect(limiter.getActiveCount(now)).toBe(20);

      // 21st request is blocked
      const blocked = limiter.consume(now);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterMs).toBe(60_000);
    });

    it('resets quota when window expires', () => {
      const limiter = new AiRateLimiter({ maxRequests: 20, windowMs: 60_000 });
      let now = 1_000_000;

      for (let i = 0; i < 20; i++) {
        limiter.consume(now);
      }
      expect(limiter.consume(now).allowed).toBe(false);

      // Advance time by 60,001 ms
      now += 60_001;
      const nextRequest = limiter.consume(now);
      expect(nextRequest.allowed).toBe(true);
    });

    it('handles concurrent synchronous checks atomically without race conditions', () => {
      const limiter = new AiRateLimiter({ maxRequests: 20, windowMs: 60_000 });
      const results: boolean[] = [];

      // 25 calls in the exact same event tick
      for (let i = 0; i < 25; i++) {
        results.push(limiter.consume().allowed);
      }

      const allowedCount = results.filter((r) => r === true).length;
      const blockedCount = results.filter((r) => r === false).length;

      expect(allowedCount).toBe(20);
      expect(blockedCount).toBe(5);
    });
  });

  // ==========================================================================
  // 4. GeminiProvider (Native Fetch & Security)
  // ==========================================================================
  describe('GeminiProvider', () => {
    it('sends API key via x-goog-api-key header and NEVER in query string', async () => {
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};

      const mockFetch: typeof fetch = vi.fn().mockImplementation(async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers as Record<string, string>;

        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'Gemini evaluated response' }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const gemini = new GeminiProvider({
        apiKey: 'SECRET_GEMINI_KEY_123',
        modelName: 'gemini-3.8-flash',
        fetchFn: mockFetch,
      });

      const result = await gemini.generateText({
        kind: 'test',
        prompt: 'Hello Gemini',
      });

      expect(result.text).toBe('Gemini evaluated response');
      expect(capturedUrl).not.toContain('SECRET_GEMINI_KEY_123');
      expect(capturedUrl).not.toContain('key=');
      expect(capturedHeaders['x-goog-api-key']).toBe('SECRET_GEMINI_KEY_123');
    });

    it('enforces structured JSON mode and validates with Zod', async () => {
      const mockPayload = {
        summary: 'Safe vendor payment',
        suspicious_phrases: [],
        risk_score: 5,
      };

      const mockFetch: typeof fetch = vi.fn().mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(mockPayload) }],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const gemini = new GeminiProvider({
        apiKey: 'test-key',
        fetchFn: mockFetch,
      });

      const result = await gemini.generateStructured(
        { kind: 'risk_explainer', prompt: 'Review req' },
        RiskAnalysisSchema
      );

      expect(result.data.risk_score).toBe(5);
      expect(result.data.summary).toBe('Safe vendor payment');
    });

    it('retries once on transient HTTP 503 and recovers if second attempt succeeds', async () => {
      let attemptCount = 0;

      const mockFetch: typeof fetch = vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount === 1) {
          return new Response(JSON.stringify({ error: { message: 'Service Unavailable' } }), {
            status: 503,
          });
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Recovered after 503' }] } }],
          }),
          { status: 200 }
        );
      });

      const gemini = new GeminiProvider({
        apiKey: 'test-key',
        maxRetries: 1,
        fetchFn: mockFetch,
      });

      const result = await gemini.generateText({ kind: 'test', prompt: 'retry test' });
      expect(result.text).toBe('Recovered after 503');
      expect(attemptCount).toBe(2);
    });

    it('fails fast on HTTP 400 Bad Request without retrying', async () => {
      let attemptCount = 0;

      const mockFetch: typeof fetch = vi.fn().mockImplementation(async () => {
        attemptCount++;
        return new Response(JSON.stringify({ error: { message: 'Invalid argument' } }), {
          status: 400,
        });
      });

      const gemini = new GeminiProvider({
        apiKey: 'test-key',
        maxRetries: 1,
        fetchFn: mockFetch,
      });

      await expect(
        gemini.generateText({ kind: 'test', prompt: 'bad request' })
      ).rejects.toThrow(AiProviderError);

      expect(attemptCount).toBe(1); // Never retried
    });

    it('redacts API key if it appears in error messages', async () => {
      const apiKey = 'super-secret-gemini-key-xyz';

      const mockFetch: typeof fetch = vi.fn().mockImplementation(async () => {
        throw new Error(`Connection failed for key ${apiKey} at endpoint`);
      });

      const gemini = new GeminiProvider({
        apiKey,
        fetchFn: mockFetch,
        maxRetries: 0,
      });

      let caughtError: Error | null = null;
      try {
        await gemini.generateText({ kind: 'test', prompt: 'leak test' });
      } catch (err: unknown) {
        caughtError = err as Error;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError!.message).not.toContain(apiKey);
      expect(caughtError!.message).toContain('[REDACTED_GEMINI_KEY]');
    });
  });

  // ==========================================================================
  // 5. AiService (Caching, Rate Limiting & Audit Safety)
  // ==========================================================================
  describe('AiService Orchestration', () => {
    it('returns cached result on duplicate input and skips rate limiter consumption', async () => {
      const mockProvider = new MockAiProvider();
      const rateLimiter = new AiRateLimiter({ maxRequests: 20, windowMs: 60_000 });
      const service = new AiService({
        provider: mockProvider,
        rateLimiter,
        repos,
        cacheTtlMs: 15 * 60 * 1000,
      });

      const promptOptions: AiPromptOptions = {
        kind: 'risk_explainer',
        prompt: 'Check vendor payment $15',
        promptVersion: 'v1.0',
        schemaId: 'risk_v1',
      };

      // Call 1: Cache miss -> invokes provider, consumes rate limit token, stores row
      const firstResult = await service.generateStructured(promptOptions, RiskAnalysisSchema);
      expect(firstResult.metadata.cached).toBe(false);
      expect(rateLimiter.getActiveCount()).toBe(1);

      // Verify row persisted in ai_runs
      const runs = db.prepare('SELECT * FROM ai_runs WHERE input_hash = ?').all(firstResult.metadata.inputHash);
      expect(runs).toHaveLength(1);

      // Call 2: Cache hit -> returns cached data, rate limit count remains 1
      const secondResult = await service.generateStructured(promptOptions, RiskAnalysisSchema);
      expect(secondResult.metadata.cached).toBe(true);
      expect(secondResult.metadata.latencyMs).toBe(0);
      expect(secondResult.data).toEqual(firstResult.data);
      expect(rateLimiter.getActiveCount()).toBe(1); // Unchanged!
    });

    it('bypasses cache when cache entry exceeds TTL', async () => {
      const mockProvider = new MockAiProvider();
      const service = new AiService({
        provider: mockProvider,
        repos,
        cacheTtlMs: 1000, // 1 second TTL
      });

      const promptOptions: AiPromptOptions = {
        kind: 'test',
        prompt: 'TTL test prompt',
      };

      const result1 = await service.generateText(promptOptions);
      expect(result1.metadata.cached).toBe(false);

      // Manually backdate the created_at timestamp in ai_runs by 2 seconds
      const expiredDate = new Date(Date.now() - 2000).toISOString();
      db.prepare('UPDATE ai_runs SET created_at = ? WHERE id = ?').run(
        expiredDate,
        result1.metadata.id
      );

      // Next call should be a cache miss
      const result2 = await service.generateText(promptOptions);
      expect(result2.metadata.cached).toBe(false);
    });

    it('does not cache failed runs or return errors as cache hits', async () => {
      const mockProvider = new MockAiProvider();
      const service = new AiService({
        provider: mockProvider,
        repos,
      });

      mockProvider.shouldTimeout = true;

      const promptOptions: AiPromptOptions = {
        kind: 'test',
        prompt: 'failure test prompt',
      };

      // Fails with timeout
      await expect(service.generateText(promptOptions)).rejects.toThrow(AiTimeoutError);

      // Verify error recorded in ai_runs with status TIMEOUT
      const runs = db.prepare('SELECT * FROM ai_runs WHERE status = ?').all('TIMEOUT');
      expect(runs).toHaveLength(1);

      // Recover provider
      mockProvider.shouldTimeout = false;

      // Next call must NOT hit cache from failed run
      const result = await service.generateText(promptOptions);
      expect(result.metadata.cached).toBe(false);
      expect(result.metadata.status).toBe('SUCCESS');
    });

    it('survives SQLite ai_runs write failures without crashing the process', async () => {
      const mockProvider = new MockAiProvider();
      const service = new AiService({
        provider: mockProvider,
        repos,
      });

      // Mock repos.aiRuns.insert to throw an error (simulating disk full or locked table)
      vi.spyOn(repos.aiRuns, 'insert').mockImplementation(() => {
        throw new Error('SQLite disk I/O error');
      });

      // Warning spy to ensure diagnostic message was emitted
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await service.generateText({
        kind: 'test',
        prompt: 'DB failure resilience test',
      });

      expect(result.text).toContain('Mock AI response');
      expect(warnSpy).toHaveBeenCalledWith(
        '[AI_RUN_RECORD_WARNING]',
        'SQLite disk I/O error'
      );
    });
  });

  // ==========================================================================
  // 6. Provider Factory & Config Validation
  // ==========================================================================
  describe('Provider Factory (createAiProvider & createAiService)', () => {
    it('creates MockAiProvider when aiProvider is mock and does not require an API key or Gemini model', () => {
      const provider = createAiProvider({
        aiProvider: 'mock',
        aiModel: '', // omitted / empty
        geminiApiKey: undefined,
      });

      expect(provider.kind).toBe('mock');
      expect(provider.modelName).toBe('mock-model-v1');
    });

    it('creates MockAiProvider with user-configured custom model name when provided', () => {
      const provider = createAiProvider({
        aiProvider: 'mock',
        aiModel: 'custom-mock-v2',
      });

      expect(provider.kind).toBe('mock');
      expect(provider.modelName).toBe('custom-mock-v2');
    });

    it('throws AiConfigurationError when aiProvider is gemini without GEMINI_API_KEY', () => {
      expect(() => {
        createAiProvider({
          aiProvider: 'gemini',
          aiModel: 'gemini-3.8-flash',
          geminiApiKey: '',
        });
      }).toThrow(AiConfigurationError);
    });

    it('creates GeminiProvider with canonical default model (gemini-3.8-flash) when aiModel is omitted', () => {
      const provider = createAiProvider({
        aiProvider: 'gemini',
        aiModel: '',
        geminiApiKey: 'valid-test-key',
      });

      expect(provider.kind).toBe('gemini');
      expect(provider.modelName).toBe('gemini-3.8-flash');
      expect(provider.modelName).toBe(DEFAULT_GEMINI_MODEL);
    });

    it('creates GeminiProvider when aiProvider is gemini with user-configured custom model', () => {
      const provider = createAiProvider({
        aiProvider: 'gemini',
        aiModel: 'gemini-3.8-pro',
        geminiApiKey: 'valid-test-key',
      });

      expect(provider.kind).toBe('gemini');
      expect(provider.modelName).toBe('gemini-3.8-pro');
    });

    it('GeminiProvider defaults to DEFAULT_GEMINI_MODEL when constructor options omit modelName', () => {
      const provider = new GeminiProvider({
        apiKey: 'test-key',
      });

      expect(provider.modelName).toBe('gemini-3.8-flash');
      expect(provider.modelName).toBe(DEFAULT_GEMINI_MODEL);
    });

    it('createAiService wires provider, rate limiter, and repos cleanly', async () => {
      const service = createAiService({
        config: {
          aiProvider: 'mock',
          aiModel: 'mock-model-v1',
        },
        repos,
      });

      const res = await service.generateText({ kind: 'test', prompt: 'wired test' });
      expect(res.metadata.status).toBe('SUCCESS');
    });
  });
});
