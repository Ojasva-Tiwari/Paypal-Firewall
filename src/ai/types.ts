/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T1: AI Provider Architecture — Types & Interfaces
 *
 * Core abstractions, request/response DTOs, and error classes for AI operations.
 *
 * Security Invariants:
 * - AI output may only make decisions stricter; never looser (Hard Rule 6).
 * - Provider errors must sanitize credentials and never expose raw API keys (Hard Rule 2).
 * - AI failures must fail closed in ENFORCE mode and fail safely in ADVISORY mode (Hard Rule 8).
 */

import { z } from 'zod';

// ============================================================================
// Standardized AI Error Hierarchy
// ============================================================================

export class AiError extends Error {
  public readonly code: string;

  constructor(message: string, code: string) {
    super(`[AI_ERROR:${code}] ${message}`);
    this.name = 'AiError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AiConfigurationError extends AiError {
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR');
    this.name = 'AiConfigurationError';
  }
}

export class AiTimeoutError extends AiError {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`AI provider request timed out after ${timeoutMs}ms`, 'TIMEOUT');
    this.name = 'AiTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class AiRateLimitError extends AiError {
  public readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `Global AI rate limit exceeded. Retry after ${Math.ceil(retryAfterMs / 1000)}s`,
      'RATE_LIMITED'
    );
    this.name = 'AiRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AiProviderError extends AiError {
  public readonly statusCode?: number;
  public readonly retryable: boolean;

  constructor(message: string, statusCode?: number, retryable: boolean = false) {
    super(message, 'PROVIDER_ERROR');
    this.name = 'AiProviderError';
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export class AiSchemaError extends AiError {
  public readonly validationIssues?: readonly string[];

  constructor(message: string, validationIssues?: readonly string[]) {
    super(message, 'SCHEMA_VALIDATION_ERROR');
    this.name = 'AiSchemaError';
    this.validationIssues = validationIssues;
  }
}

// ============================================================================
// Provider & Request DTOs
// ============================================================================

export type AiProviderKind = 'gemini' | 'mock';
export type AiRunStatus = 'SUCCESS' | 'RATE_LIMITED' | 'TIMEOUT' | 'ERROR';

/**
 * Canonical default Gemini model.
 * Note: gemini-1.5-flash was decommissioned by Google on September 29, 2025.
 * PayGuard defaults to the modern gemini-3.8-flash for fast, structured risk scanning.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/**
 * Options passed to generateText or generateStructured.
 */
export interface AiPromptOptions {
  /** Functional category, e.g. 'risk_explainer', 'policy_draft', 'test' */
  readonly kind: string;
  /** Primary user or data prompt */
  readonly prompt: string;
  /** Delimited system instructions separated from untrusted data */
  readonly systemInstruction?: string;
  /** Explicit prompt/template version string for deterministic cache keying */
  readonly promptVersion?: string;
  /** Temperature between 0.0 and 1.0 (defaults to 0.0 for deterministic evaluation) */
  readonly temperature?: number;
  /** Maximum generated tokens (defaults to 1024, hard ceiling 2048) */
  readonly maxOutputTokens?: number;
  /** Unique schema identifier/version for structured outputs (e.g. 'risk_v1') */
  readonly schemaId?: string;
  /** Optional link to associated payment_requests row */
  readonly requestId?: string;
}

/**
 * Metadata recorded for every AI execution attempt.
 */
export interface AiRunMetadata {
  readonly id: string;
  readonly kind: string;
  readonly model: string;
  readonly inputHash: string;
  readonly latencyMs: number;
  readonly status: AiRunStatus;
  readonly cached: boolean;
}

/**
 * Result of unstructured text generation.
 */
export interface AiTextResult {
  readonly text: string;
  readonly metadata: AiRunMetadata;
}

/**
 * Result of structured JSON generation validated by Zod.
 */
export interface AiStructuredResult<T> {
  readonly data: T;
  readonly rawText: string;
  readonly metadata: AiRunMetadata;
}

/**
 * Low-level model provider interface.
 */
export interface AiProvider {
  readonly kind: AiProviderKind;
  readonly modelName: string;

  /**
   * Generates raw text from the model.
   */
  generateText(
    options: AiPromptOptions,
    signal?: AbortSignal
  ): Promise<{ text: string; latencyMs: number }>;

  /**
   * Generates structured output validated against a Zod schema.
   */
  generateStructured<T>(
    options: AiPromptOptions,
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<{ data: T; rawText: string; latencyMs: number }>;
}

/**
 * Modular Rate Limiter interface.
 * Allows process-local sliding window to be replaced by distributed limiters without altering AiService.
 */
export interface RateLimiter {
  /**
   * Attempts to consume one request quota.
   * @param now Current timestamp in epoch ms (defaults to Date.now())
   * @returns allowed status and retryAfterMs if limit was reached
   */
  consume(now?: number): { allowed: boolean; retryAfterMs: number };

  /**
   * Resets rate limiter counters (useful for unit testing).
   */
  reset(): void;
}

