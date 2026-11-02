/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T1: Gemini AI Provider
 *
 * Implements:
 * - Direct REST API integration with Google Gemini via Node.js native fetch (Node 20+).
 * - Adheres strictly to Hard Rule 10: Zero external dependencies; avoids SDK version drift.
 * - Credentials Isolation: Passes GEMINI_API_KEY exclusively via x-goog-api-key header;
 *   never appends the key as a query parameter in URLs to prevent leakage in logs/proxies.
 * - Robust Lifecycle: Enforces strict 10s request timeout, structured JSON mode,
 *   single transient retry (HTTP 429/503), and sanitized error mapping.
 */

import { z } from 'zod';
import {
  AiProvider,
  AiProviderKind,
  AiPromptOptions,
  AiTimeoutError,
  AiProviderError,
  AiSchemaError,
  DEFAULT_GEMINI_MODEL,
} from './types.js';

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly modelName?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetchFn?: typeof fetch;
}

interface GeminiCandidate {
  content?: {
    parts?: Array<{
      text?: string;
    }>;
  };
}

interface GeminiApiResponse {
  candidates?: GeminiCandidate[];
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export class GeminiProvider implements AiProvider {
  public readonly kind: AiProviderKind = 'gemini';
  public readonly modelName: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new AiProviderError('GEMINI_API_KEY cannot be empty');
    }
    this.apiKey = options.apiKey.trim();
    this.modelName = options.modelName ?? DEFAULT_GEMINI_MODEL;
    this.baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  public async generateText(
    options: AiPromptOptions,
    signal?: AbortSignal
  ): Promise<{ text: string; latencyMs: number }> {
    const requestBody = this.buildRequestBody(options, false);
    const start = Date.now();
    const rawResponse = await this.executeWithRetry(requestBody, signal);
    const latencyMs = Date.now() - start;

    const candidate = rawResponse?.candidates?.[0];
    const textPart = candidate?.content?.parts?.[0]?.text;

    if (typeof textPart !== 'string') {
      throw new AiProviderError('Gemini response did not contain valid text content');
    }

    return { text: textPart, latencyMs };
  }

  public async generateStructured<T>(
    options: AiPromptOptions,
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<{ data: T; rawText: string; latencyMs: number }> {
    const requestBody = this.buildRequestBody(options, true);
    const start = Date.now();
    const rawResponse = await this.executeWithRetry(requestBody, signal);
    const latencyMs = Date.now() - start;

    const candidate = rawResponse?.candidates?.[0];
    const textPart = candidate?.content?.parts?.[0]?.text;

    if (typeof textPart !== 'string') {
      throw new AiProviderError('Gemini response did not contain valid text content');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(textPart);
    } catch (err: unknown) {
      throw new AiSchemaError(
        `Failed to parse Gemini output as JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const validation = schema.safeParse(parsedJson);
    if (!validation.success) {
      const issues = validation.error.issues.map(
        (i) => `${i.path.join('.') || 'root'}: ${i.message}`
      );
      throw new AiSchemaError(
        `Gemini output failed schema validation: ${issues.join(', ')}`,
        issues
      );
    }

    return { data: validation.data, rawText: textPart, latencyMs };
  }

  private buildRequestBody(options: AiPromptOptions, structured: boolean): Record<string, unknown> {
    const temperature = options.temperature ?? 0.0;
    const maxOutputTokens = Math.min(Math.max(options.maxOutputTokens ?? 1024, 1), 2048);

    const body: Record<string, unknown> = {
      contents: [
        {
          role: 'user',
          parts: [{ text: options.prompt }],
        },
      ],
      generationConfig: {
        temperature,
        maxOutputTokens,
      },
    };

    if (structured) {
      (body.generationConfig as Record<string, unknown>).responseMimeType = 'application/json';
    }

    if (options.systemInstruction && options.systemInstruction.trim().length > 0) {
      body.systemInstruction = {
        parts: [{ text: options.systemInstruction.trim() }],
      };
    }

    return body;
  }

  private async executeWithRetry(
    body: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<GeminiApiResponse> {
    const endpointUrl = `${this.baseUrl}/models/${encodeURIComponent(this.modelName)}:generateContent`;
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= this.maxRetries) {
      attempt++;
      try {
        return await this.executeSingleRequest(endpointUrl, body, externalSignal);
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        const isRetryable =
          (err instanceof AiProviderError && err.retryable) ||
          (err instanceof TypeError && err.message.includes('fetch'));

        if (!isRetryable || attempt > this.maxRetries) {
          throw this.sanitizeError(lastError);
        }

        // Brief backoff with jitter before single retry
        const backoffMs = 500 + Math.floor(Math.random() * 200);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }

    throw this.sanitizeError(lastError ?? new Error('Gemini request failed'));
  }

  private async executeSingleRequest(
    endpointUrl: string,
    body: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<GeminiApiResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    let externalAbortListener: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutId);
        throw new AiTimeoutError(this.timeoutMs);
      }
      externalAbortListener = () => controller.abort();
      externalSignal.addEventListener('abort', externalAbortListener, { once: true });
    }

    try {
      const response = await this.fetchFn(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const status = response.status;
        const retryable = status === 429 || status === 503;
        let responseSnippet = '';
        try {
          const errorJson = (await response.json()) as GeminiApiResponse;
          responseSnippet = errorJson?.error?.message ?? JSON.stringify(errorJson).slice(0, 200);
        } catch {
          responseSnippet = response.statusText;
        }

        throw new AiProviderError(
          `Gemini API returned HTTP ${status}: ${responseSnippet}`,
          status,
          retryable
        );
      }

      return (await response.json()) as GeminiApiResponse;
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        throw new AiTimeoutError(this.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal && externalAbortListener) {
        externalSignal.removeEventListener('abort', externalAbortListener);
      }
    }
  }

  private sanitizeError(err: Error): Error {
    if (err.message.includes(this.apiKey)) {
      err.message = err.message.replaceAll(this.apiKey, '[REDACTED_GEMINI_KEY]');
    }
    return err;
  }
}
