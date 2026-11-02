/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T1: AI Provider Architecture — Barrel Exports & Factory
 *
 * Provides factory functions and single point of export for PayGuard AI modules.
 */

import type { PayGuardConfig } from '../config/index.js';
import type { Repositories } from '../db/repositories.js';
import {
  AiProvider,
  AiConfigurationError,
  RateLimiter,
  DEFAULT_GEMINI_MODEL,
} from './types.js';
import { MockAiProvider } from './mockProvider.js';
import { GeminiProvider } from './geminiProvider.js';
import { AiRateLimiter } from './rateLimiter.js';
import { AiService } from './service.js';

export * from './types.js';
export * from './cache.js';
export * from './rateLimiter.js';
export * from './mockProvider.js';
export * from './geminiProvider.js';
export * from './service.js';
export * from './riskExplainer.js';
export * from './injectionDetector.js';

/**
 * Creates an AiProvider instance based on validated PayGuard configuration.
 *
 * - When config.aiProvider === 'gemini', instantiates GeminiProvider (requires GEMINI_API_KEY).
 * - When config.aiProvider === 'mock' (default), instantiates MockAiProvider.
 */
export function createAiProvider(
  config: Pick<PayGuardConfig, 'aiProvider' | 'aiModel' | 'geminiApiKey'>
): AiProvider {
  if (config.aiProvider === 'gemini') {
    if (!config.geminiApiKey || config.geminiApiKey.trim().length === 0) {
      throw new AiConfigurationError(
        'GEMINI_API_KEY is required when AI_PROVIDER is set to "gemini"'
      );
    }
    return new GeminiProvider({
      apiKey: config.geminiApiKey.trim(),
      modelName: config.aiModel || DEFAULT_GEMINI_MODEL,
      timeoutMs: 10_000,
      maxRetries: 1,
    });
  }

  return new MockAiProvider({
    modelName: config.aiModel || 'mock-model-v1',
  });
}

export interface CreateAiServiceOptions {
  readonly config: Pick<PayGuardConfig, 'aiProvider' | 'aiModel' | 'geminiApiKey'>;
  readonly repos?: Repositories;
  readonly rateLimiter?: RateLimiter;
  readonly cacheTtlMs?: number;
}

/**
 * Convenience factory to create a fully wired AiService.
 */
export function createAiService(options: CreateAiServiceOptions): AiService {
  const provider = createAiProvider(options.config);
  const rateLimiter = options.rateLimiter ?? new AiRateLimiter();
  return new AiService({
    provider,
    rateLimiter,
    repos: options.repos,
    cacheTtlMs: options.cacheTtlMs,
  });
}

