/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3-A: Telegram Bot API HTTP Client
 *
 * Implements:
 * - Zero-dependency Telegram Bot API client powered by native Node.js fetch
 * - Strict bot token redaction from all URLs, logs, and thrown error messages
 * - Configurable request timeout via AbortController (default: 5000ms)
 * - Safe transient error retry behavior (HTTP 429 / 5xx) with bounded retries
 * - Method-aware retry safety: sendMessage never retries on ambiguous timeouts,
 *   network drops, or 5xx responses (at-most-once delivery on ambiguity)
 * - Typed methods: getMe, sendMessage, editMessageText, editMessageReplyMarkup,
 *   answerCallbackQuery, setWebhook, getWebhookInfo, deleteWebhook
 *
 * Note on Delivery Semantics:
 * The Telegram Bot API does not support idempotency keys for sendMessage.
 * Delivery is at-most-once (fail-fast on ambiguity) or at-least-once (if retried).
 * Exactly-once delivery is NOT supported by the Telegram Bot API.
 */

import type {
  TelegramClientOptions,
  TelegramUser,
  TelegramMessage,
  TelegramWebhookInfo,
  TelegramApiResponse,
  SendMessageParams,
  EditMessageTextParams,
  EditMessageReplyMarkupParams,
  AnswerCallbackQueryParams,
  SetWebhookParams,
  DeleteWebhookParams,
  FetchFunction,
  TelegramClientLogger,
  TelegramRequestOptions,
} from './types.js';

export const MAX_TELEGRAM_RETRY_AFTER_MS = 5000;

export class TelegramApiError extends Error {
  public readonly code: number;
  public readonly description: string;
  public readonly retryAfter?: number;
  public readonly isTransient: boolean;

  constructor(params: {
    message: string;
    code: number;
    description: string;
    retryAfter?: number;
    isTransient?: boolean;
  }) {
    super(params.message);
    this.name = 'TelegramApiError';
    this.code = params.code;
    this.description = params.description;
    this.retryAfter = params.retryAfter;
    this.isTransient = params.isTransient ?? false;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Lightweight, zero-dependency Telegram Bot API HTTP client.
 */
export class TelegramClient {
  private readonly botToken: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger?: TelegramClientLogger;
  private readonly fetchFn: FetchFunction;

  constructor(options: TelegramClientOptions) {
    if (!options.botToken || typeof options.botToken !== 'string' || options.botToken.trim() === '') {
      throw new Error('TelegramClient requires a non-empty botToken');
    }
    this.botToken = options.botToken.trim();
    this.apiBaseUrl = (options.apiBaseUrl || 'https://api.telegram.org').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxRetries = options.maxRetries ?? 1;
    this.logger = options.logger;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Sanitizes strings (URLs, error messages) by replacing the bot token with a placeholder.
   */
  public redactToken(text: string): string {
    if (!this.botToken || text.length === 0) return text;
    return text.replaceAll(this.botToken, '[REDACTED_BOT_TOKEN]');
  }

  /**
   * Internal HTTP execution wrapper with AbortController timeout and safe retries.
   */
  private async request<T>(
    method: string,
    payload?: Record<string, unknown>,
    options?: TelegramRequestOptions
  ): Promise<T> {
    const rawUrl = `${this.apiBaseUrl}/bot${this.botToken}/${method}`;
    const sanitizedUrl = `${this.apiBaseUrl}/bot[REDACTED_BOT_TOKEN]/${method}`;

    const effectiveTimeoutMs =
      options?.timeoutMs !== undefined ? Math.max(0, options.timeoutMs) : this.timeoutMs;
    const effectiveMaxRetries =
      options?.maxRetries !== undefined ? Math.max(0, options.maxRetries) : this.maxRetries;

    let attempts = 0;
    const maxAttempts = 1 + effectiveMaxRetries;
    const isSendMessage = method === 'sendMessage';

    while (attempts < maxAttempts) {
      attempts++;
      const controller = new AbortController();
      let timeoutId: NodeJS.Timeout | undefined;
      if (effectiveTimeoutMs > 0 && Number.isFinite(effectiveTimeoutMs)) {
        timeoutId = setTimeout(() => controller.abort(), effectiveTimeoutMs);
      }

      let externalAbortHandler: (() => void) | undefined;
      if (options?.signal) {
        if (options.signal.aborted) {
          controller.abort(options.signal.reason);
        } else {
          externalAbortHandler = () => controller.abort(options?.signal?.reason);
          options.signal.addEventListener('abort', externalAbortHandler, { once: true });
        }
      }

      try {
        const response = await this.fetchFn(rawUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: payload ? JSON.stringify(payload) : undefined,
          signal: controller.signal,
        });

        if (timeoutId) clearTimeout(timeoutId);
        if (options?.signal && externalAbortHandler) {
          options.signal.removeEventListener('abort', externalAbortHandler);
        }

        let data: TelegramApiResponse<T>;
        try {
          data = (await response.json()) as TelegramApiResponse<T>;
        } catch {
          const statusText = response.statusText || 'Unknown';
          const isTransient = response.status >= 500 || response.status === 429;
          const isRateLimit = response.status === 429;

          // Non-idempotent methods (sendMessage) MUST NOT retry on ambiguous 5xx responses.
          // Only explicit HTTP 429 may be retried.
          const canRetry = isTransient && attempts < maxAttempts && (!isSendMessage || isRateLimit);

          if (canRetry) {
            const delayMs = Math.min(250 * Math.pow(2, attempts - 1), MAX_TELEGRAM_RETRY_AFTER_MS);
            this.logger?.warn?.(
              `[TelegramClient] Transient HTTP ${response.status} at ${sanitizedUrl}, retrying in ${delayMs}ms (attempt ${attempts}/${maxAttempts})`
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          throw new TelegramApiError({
            message: `Telegram HTTP ${response.status} (${statusText}) at ${sanitizedUrl}`,
            code: response.status,
            description: statusText,
            isTransient,
          });
        }

        if (!response.ok || !data.ok) {
          const errCode = data.error_code ?? response.status;
          const desc = data.description ?? 'Unknown Telegram error';
          const retryAfter = data.parameters?.retry_after;
          const isRateLimit = response.status === 429 || errCode === 429;
          const isServerErr = response.status >= 500 || errCode >= 500;
          const isTransient = isRateLimit || isServerErr;

          // Non-idempotent methods (sendMessage) MUST NOT retry on ambiguous 5xx.
          // An explicit HTTP 429 response may be retried because Telegram has rejected that request.
          const canRetry = isTransient && attempts < maxAttempts && (!isSendMessage || isRateLimit);

          if (canRetry) {
            const rawDelayMs = retryAfter !== undefined ? retryAfter * 1000 : 250 * Math.pow(2, attempts - 1);
            // Cap all retry_after delays to a maximum of 5 seconds (5000ms)
            const delayMs = Math.min(Math.max(0, rawDelayMs), MAX_TELEGRAM_RETRY_AFTER_MS);
            this.logger?.warn?.(
              `[TelegramClient] Transient error ${errCode} at ${sanitizedUrl}, retrying in ${delayMs}ms (attempt ${attempts}/${maxAttempts})`
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          throw new TelegramApiError({
            message: `Telegram API error [${errCode}]: ${desc} at ${sanitizedUrl}`,
            code: errCode,
            description: desc,
            retryAfter,
            isTransient,
          });
        }

        return data.result as T;
      } catch (err: unknown) {
        if (timeoutId) clearTimeout(timeoutId);
        if (options?.signal && externalAbortHandler) {
          options.signal.removeEventListener('abort', externalAbortHandler);
        }

        if (err instanceof TelegramApiError) {
          throw err;
        }

        const isExternalAbort = Boolean(options?.signal?.aborted);
        const isAbort =
          (err as { name?: string })?.name === 'AbortError' ||
          controller.signal.aborted ||
          isExternalAbort;
        const rawMsg = err instanceof Error ? err.message : String(err);
        const safeMsg = this.redactToken(rawMsg);

        if (isAbort) {
          // If options.signal was explicitly aborted from outside, fail immediately without retry
          if (isExternalAbort) {
            throw new TelegramApiError({
              message: `Telegram request aborted: ${safeMsg}`,
              code: 499,
              description: 'Client Closed Request',
              isTransient: false,
            });
          }

          // sendMessage MUST NOT retry after an ambiguous timeout / AbortError
          if (!isSendMessage && attempts < maxAttempts) {
            this.logger?.warn?.(
              `[TelegramClient] Request timeout after ${effectiveTimeoutMs}ms at ${sanitizedUrl}, retrying (attempt ${attempts}/${maxAttempts})`
            );
            continue;
          }
          throw new TelegramApiError({
            message: `Telegram request timeout after ${effectiveTimeoutMs}ms at ${sanitizedUrl}`,
            code: 408,
            description: 'Request Timeout',
            isTransient: true,
          });
        }

        // sendMessage MUST NOT retry after an ambiguous network failure
        if (!isSendMessage && attempts < maxAttempts) {
          const delayMs = Math.min(250 * Math.pow(2, attempts - 1), MAX_TELEGRAM_RETRY_AFTER_MS);
          this.logger?.warn?.(
            `[TelegramClient] Network error at ${sanitizedUrl}: ${safeMsg}, retrying in ${delayMs}ms (attempt ${attempts}/${maxAttempts})`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        throw new TelegramApiError({
          message: `Telegram network error at ${sanitizedUrl}: ${safeMsg}`,
          code: 0,
          description: safeMsg,
          isTransient: true,
        });
      }
    }

    throw new TelegramApiError({
      message: `Telegram request failed after ${maxAttempts} attempts at ${sanitizedUrl}`,
      code: 0,
      description: 'Maximum retry attempts exceeded',
      isTransient: true,
    });
  }

  /**
   * Retrieves bot information (id, name, username).
   */
  public async getMe(options?: TelegramRequestOptions): Promise<TelegramUser> {
    return await this.request<TelegramUser>('getMe', undefined, options);
  }

  /**
   * Sends a message to a Telegram chat.
   */
  public async sendMessage(
    params: SendMessageParams,
    options?: TelegramRequestOptions
  ): Promise<TelegramMessage> {
    return await this.request<TelegramMessage>(
      'sendMessage',
      params as unknown as Record<string, unknown>,
      options
    );
  }

  /**
   * Edits the text of an existing message.
   */
  public async editMessageText(
    params: EditMessageTextParams,
    options?: TelegramRequestOptions
  ): Promise<TelegramMessage | boolean> {
    return await this.request<TelegramMessage | boolean>(
      'editMessageText',
      params as unknown as Record<string, unknown>,
      options
    );
  }

  /**
   * Edits the reply markup (inline keyboard) of an existing message.
   */
  public async editMessageReplyMarkup(
    params: EditMessageReplyMarkupParams,
    options?: TelegramRequestOptions
  ): Promise<TelegramMessage | boolean> {
    return await this.request<TelegramMessage | boolean>(
      'editMessageReplyMarkup',
      params as unknown as Record<string, unknown>,
      options
    );
  }

  /**
   * Sends an answer to a callback query generated by an inline keyboard button.
   */
  public async answerCallbackQuery(
    params: AnswerCallbackQueryParams,
    options?: TelegramRequestOptions
  ): Promise<boolean> {
    return await this.request<boolean>(
      'answerCallbackQuery',
      params as unknown as Record<string, unknown>,
      options
    );
  }

  /**
   * Configures a webhook URL for receiving Telegram updates.
   */
  public async setWebhook(
    params: SetWebhookParams,
    options?: TelegramRequestOptions
  ): Promise<boolean> {
    return await this.request<boolean>(
      'setWebhook',
      params as unknown as Record<string, unknown>,
      options
    );
  }

  /**
   * Retrieves current webhook status.
   */
  public async getWebhookInfo(options?: TelegramRequestOptions): Promise<TelegramWebhookInfo> {
    return await this.request<TelegramWebhookInfo>('getWebhookInfo', undefined, options);
  }

  /**
   * Removes webhook integration, allowing polling or disabling updates.
   */
  public async deleteWebhook(
    params?: DeleteWebhookParams,
    options?: TelegramRequestOptions
  ): Promise<boolean> {
    return await this.request<boolean>(
      'deleteWebhook',
      params as unknown as Record<string, unknown>,
      options
    );
  }
}

