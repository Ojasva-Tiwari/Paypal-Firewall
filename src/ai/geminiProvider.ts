/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T1: Gemini AI Provider
 *
 * Implements:
 * - Direct REST API integration with Google Gemini via Node.js native fetch (Node 20+).
 * - Adheres strictly to Hard Rule 10: Zero external dependencies; avoids SDK version drift.
 * - Credentials Isolation: Passes GEMINI_API_KEY exclusively via x-goog-api-key header;
 *   never appends the key as a query parameter in URLs to prevent leakage in logs/proxies.
 * - Robust Lifecycle: Enforces strict 25s default request timeout, schema-enforced structured JSON mode,
 *   single transient retry (HTTP 429/503) with prior error preservation, external cancellation isolation,
 *   and sanitized error mapping.
 */

import { z } from 'zod';
import {
  AiProvider,
  AiProviderKind,
  AiPromptOptions,
  AiTimeoutError,
  AiCancelledError,
  AiProviderError,
  AiSchemaError,
  DEFAULT_GEMINI_MODEL,
} from './types.js';

export const DEFAULT_GEMINI_TIMEOUT_MS = 25_000;

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
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
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
    const responseJsonSchema = this.toGeminiJsonSchema(schema);
    const requestBody = this.buildRequestBody(options, true, responseJsonSchema);
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

  private toGeminiJsonSchema<T>(schema: z.ZodType<T>): Record<string, unknown> {
    const jsonSchema: Record<string, unknown> = {
      ...z.toJSONSchema(schema, { unrepresentable: 'any' }),
    };
    delete jsonSchema.$schema;
    return jsonSchema;
  }

  private buildRequestBody(
    options: AiPromptOptions,
    structured: boolean,
    responseJsonSchema?: Record<string, unknown>
  ): Record<string, unknown> {
    const temperature = options.temperature ?? 0.0;
    const maxOutputTokens = Math.min(Math.max(options.maxOutputTokens ?? 1024, 1), 2048);

    const generationConfig: Record<string, unknown> = {
      temperature,
      maxOutputTokens,
    };

    if (structured) {
      generationConfig.responseMimeType = 'application/json';
      if (responseJsonSchema !== undefined) {
        generationConfig.responseJsonSchema = responseJsonSchema;
      }
    }

    const body: Record<string, unknown> = {
      contents: [
        {
          role: 'user',
          parts: [{ text: options.prompt }],
        },
      ],
      generationConfig,
    };

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
    if (externalSignal?.aborted) {
      throw new AiCancelledError();
    }

    const endpointUrl = `${this.baseUrl}/models/${encodeURIComponent(this.modelName)}:generateContent`;
    let attempt = 0;
    let firstAttemptError: Error | null = null;
    let lastError: Error | null = null;

    while (attempt <= this.maxRetries) {
      attempt++;
      try {
        return await this.executeSingleRequest(endpointUrl, body, externalSignal);
      } catch (err: unknown) {
        const sanitized = this.sanitizeError(
          err instanceof Error ? err : new Error(String(err))
        );
        lastError = sanitized;

        if (sanitized instanceof AiCancelledError) {
          throw sanitized;
        }

        if (!firstAttemptError) {
          firstAttemptError = sanitized;
        }

        const isRetryable =
          (sanitized instanceof AiProviderError && sanitized.retryable) ||
          (sanitized instanceof TypeError && sanitized.message.includes('fetch'));

        if (!isRetryable || attempt > this.maxRetries) {
          if (sanitized instanceof AiTimeoutError && attempt > 1 && firstAttemptError) {
            throw this.sanitizeError(
              new AiTimeoutError(sanitized.timeoutMs, firstAttemptError.message)
            );
          }
          throw sanitized;
        }

        // Brief backoff with jitter before retry
        const backoffMs = 500 + Math.floor(Math.random() * 200);
        await this.sleepWithAbort(backoffMs, externalSignal);
      }
    }

    throw this.sanitizeError(lastError ?? new Error('Gemini request failed'));
  }

  private sleepWithAbort(ms: number, externalSignal?: AbortSignal): Promise<void> {
    if (externalSignal?.aborted) {
      return Promise.reject(new AiCancelledError());
    }

    return new Promise((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const timer = setTimeout(() => {
        if (externalSignal && onAbort) {
          externalSignal.removeEventListener('abort', onAbort);
        }
        resolve();
      }, ms);

      if (externalSignal) {
        onAbort = () => {
          clearTimeout(timer);
          reject(new AiCancelledError());
        };
        externalSignal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  private async executeSingleRequest(
    endpointUrl: string,
    body: Record<string, unknown>,
    externalSignal?: AbortSignal
  ): Promise<GeminiApiResponse> {
    if (externalSignal?.aborted) {
      throw new AiCancelledError();
    }

    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;

    const timeoutId = setTimeout(() => {
      if (!externallyAborted) {
        timedOut = true;
        controller.abort();
      }
    }, this.timeoutMs);

    let externalAbortListener: (() => void) | undefined;
    if (externalSignal) {
      externalAbortListener = () => {
        if (!timedOut) {
          externallyAborted = true;
          controller.abort();
        }
      };
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
      if (externallyAborted || (externalSignal?.aborted && !timedOut)) {
        throw new AiCancelledError();
      }
      if (timedOut) {
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

  private redactSecrets(value: string): string {
    return this.apiKey ? value.replaceAll(this.apiKey, '[REDACTED_GEMINI_KEY]') : value;
  }

  private sanitizeError(err: Error): Error {
    err.message = this.redactSecrets(err.message);
    const errWithCause = err as Error & { cause?: unknown };
    if (errWithCause.cause instanceof Error) {
      errWithCause.cause.message = this.redactSecrets(errWithCause.cause.message);
      if (err instanceof TypeError && err.message.includes('fetch') && errWithCause.cause.message) {
        const code = (errWithCause.cause as Error & { code?: unknown }).code;
        const codeSuffix = typeof code === 'string' && code ? ` (${this.redactSecrets(code)})` : '';
        const detail = `${errWithCause.cause.message}${codeSuffix}`;
        if (!err.message.includes(detail)) {
          err.message = `${err.message}: ${detail}`;
        }
      }
    }
    return err;
  }
}
