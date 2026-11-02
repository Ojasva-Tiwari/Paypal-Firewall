/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T1: Mock AI Provider
 *
 * Implements:
 * - Deterministic, zero-network AI provider for unit testing, CI pipelines, and offline dev.
 * - Supports programmable failure scenarios (timeouts, rate limits, schema mismatches, HTTP errors).
 * - Generates valid structured data matching input Zod schemas or user-configured test fixtures.
 */

import { z } from 'zod';
import {
  AiProvider,
  AiProviderKind,
  AiPromptOptions,
  AiTimeoutError,
  AiRateLimitError,
  AiProviderError,
  AiSchemaError,
} from './types.js';

export interface MockAiProviderOptions {
  readonly modelName?: string;
  readonly defaultText?: string;
  readonly defaultStructured?: Record<string, unknown>;
  readonly simulatedLatencyMs?: number;
}

export class MockAiProvider implements AiProvider {
  public readonly kind: AiProviderKind = 'mock';
  public readonly modelName: string;

  // Programmable test hooks
  public shouldTimeout: boolean = false;
  public simulateRateLimit: boolean = false;
  public simulateHttpError: { statusCode: number; message: string; retryable?: boolean } | null = null;
  public returnMalformedJson: boolean = false;
  public customTextResponse?: string | ((prompt: string) => string);
  public customStructuredResponse?: unknown | ((prompt: string, options?: AiPromptOptions) => unknown);
  public simulatedLatencyMs: number;
  private readonly defaultStructured?: Record<string, unknown>;

  constructor(options?: MockAiProviderOptions) {
    this.modelName = options?.modelName ?? 'mock-model-v1';
    this.simulatedLatencyMs = options?.simulatedLatencyMs ?? 5;
    this.defaultStructured = options?.defaultStructured;
  }

  public async generateText(
    options: AiPromptOptions,
    signal?: AbortSignal
  ): Promise<{ text: string; latencyMs: number }> {
    this.checkSimulatedFailures(signal);

    if (this.simulatedLatencyMs > 0) {
      await this.sleep(this.simulatedLatencyMs, signal);
    }

    let text: string;
    if (typeof this.customTextResponse === 'function') {
      text = this.customTextResponse(options.prompt);
    } else if (typeof this.customTextResponse === 'string') {
      text = this.customTextResponse;
    } else {
      text = `Mock AI response for prompt: "${options.prompt.slice(0, 50)}"`;
    }

    return { text, latencyMs: this.simulatedLatencyMs };
  }

  public async generateStructured<T>(
    options: AiPromptOptions,
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<{ data: T; rawText: string; latencyMs: number }> {
    this.checkSimulatedFailures(signal);

    if (this.simulatedLatencyMs > 0) {
      await this.sleep(this.simulatedLatencyMs, signal);
    }

    if (this.returnMalformedJson) {
      throw new AiSchemaError('Failed to parse model output as JSON: Unexpected end of JSON input');
    }

    let rawData: unknown;
    if (typeof this.customStructuredResponse === 'function') {
      const custom = this.customStructuredResponse(options.prompt, options);
      if (custom !== undefined) {
        rawData = custom;
      }
    } else if (this.customStructuredResponse !== undefined) {
      rawData = this.customStructuredResponse;
    }

    if (rawData === undefined) {
      if (this.defaultStructured !== undefined) {
        rawData = this.defaultStructured;
      } else if (options.kind === 'injection_detection') {
        rawData = {
          is_injection: false,
          confidence: 'HIGH',
          attack_categories: [],
          explanation: 'Mock AI injection detection: content is clean.',
        };
      } else {
        // Create a mock payload based on common PayGuard structured output expectations
        rawData = {
          summary: `Mock AI risk summary for ${options.kind}.`,
          suspicious_phrases: [],
          risk_level: 'LOW',
          risk_score: 0,
        };
      }
    }

    const parseResult = schema.safeParse(rawData);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map(
        (i) => `${i.path.join('.') || 'root'}: ${i.message}`
      );
      throw new AiSchemaError(
        `Mock output failed schema validation: ${issues.join(', ')}`,
        issues
      );
    }

    const rawText = JSON.stringify(parseResult.data);
    return { data: parseResult.data, rawText, latencyMs: this.simulatedLatencyMs };
  }

  private checkSimulatedFailures(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new AiTimeoutError(10_000);
    }
    if (this.shouldTimeout) {
      throw new AiTimeoutError(10_000);
    }
    if (this.simulateRateLimit) {
      throw new AiRateLimitError(30_000);
    }
    if (this.simulateHttpError) {
      throw new AiProviderError(
        this.simulateHttpError.message,
        this.simulateHttpError.statusCode,
        this.simulateHttpError.retryable ?? false
      );
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new AiTimeoutError(10_000));
          },
          { once: true }
        );
      }
    });
  }
}
