/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * Unit Tests: TelegramClient (M6-T3-A)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TelegramClient,
  TelegramApiError,
  MAX_TELEGRAM_RETRY_AFTER_MS,
} from '../../src/telegram/client.js';
import type { FetchFunction, TelegramApiResponse } from '../../src/telegram/types.js';

describe('TelegramClient', () => {
  const TEST_TOKEN = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_1234567';
  const REDACTED = '[REDACTED_BOT_TOKEN]';

  describe('Constructor & Configuration', () => {
    it('throws error when botToken is missing or empty', () => {
      expect(() => new TelegramClient({ botToken: '' })).toThrow(/requires a non-empty botToken/);
      expect(() => new TelegramClient({ botToken: '   ' })).toThrow(/requires a non-empty botToken/);
      // @ts-expect-error Testing invalid runtime input
      expect(() => new TelegramClient({})).toThrow(/requires a non-empty botToken/);
    });

    it('initializes with default options', () => {
      const client = new TelegramClient({ botToken: TEST_TOKEN });
      expect(client).toBeDefined();
    });

    it('strips trailing slashes from apiBaseUrl', async () => {
      let calledUrl = '';
      const mockFetch: FetchFunction = async (url) => {
        calledUrl = String(url);
        const body: TelegramApiResponse<{ id: number }> = { ok: true, result: { id: 100 } };
        return new Response(JSON.stringify(body), { status: 200 });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        apiBaseUrl: 'https://custom.api.telegram.org///',
        fetchFn: mockFetch,
      });

      await client.getMe();
      expect(calledUrl).toBe(`https://custom.api.telegram.org/bot${TEST_TOKEN}/getMe`);
    });
  });

  describe('Token Redaction', () => {
    it('redacts bot token from arbitrary text and URLs', () => {
      const client = new TelegramClient({ botToken: TEST_TOKEN });

      const textWithToken = `Error connecting to https://api.telegram.org/bot${TEST_TOKEN}/sendMessage: invalid call`;
      const sanitized = client.redactToken(textWithToken);

      expect(sanitized).not.toContain(TEST_TOKEN);
      expect(sanitized).toBe(`Error connecting to https://api.telegram.org/bot${REDACTED}/sendMessage: invalid call`);
    });

    it('redacts multiple occurrences of bot token', () => {
      const client = new TelegramClient({ botToken: TEST_TOKEN });
      const double = `${TEST_TOKEN} and again ${TEST_TOKEN}`;
      expect(client.redactToken(double)).toBe(`${REDACTED} and again ${REDACTED}`);
    });

    it('handles empty or clean strings gracefully', () => {
      const client = new TelegramClient({ botToken: TEST_TOKEN });
      expect(client.redactToken('')).toBe('');
      expect(client.redactToken('plain text without secrets')).toBe('plain text without secrets');
    });
  });

  describe('API Methods', () => {
    it('getMe: calls /getMe and returns user details', async () => {
      let capturedUrl = '';
      let capturedMethod = '';

      const mockFetch: FetchFunction = async (url, init) => {
        capturedUrl = String(url);
        capturedMethod = init?.method ?? '';
        const body: TelegramApiResponse<{ id: number; is_bot: boolean; first_name: string; username: string }> = {
          ok: true,
          result: {
            id: 987654321,
            is_bot: true,
            first_name: 'PayGuard Bot',
            username: 'payguard_bot',
          },
        };
        return new Response(JSON.stringify(body), { status: 200 });
      };

      const client = new TelegramClient({ botToken: TEST_TOKEN, fetchFn: mockFetch });
      const user = await client.getMe();

      expect(capturedUrl).toBe(`https://api.telegram.org/bot${TEST_TOKEN}/getMe`);
      expect(capturedMethod).toBe('POST');
      expect(user.id).toBe(987654321);
      expect(user.is_bot).toBe(true);
      expect(user.username).toBe('payguard_bot');
    });

    it('sendMessage: sends payload with chat_id and text', async () => {
      let capturedBody: unknown;

      const mockFetch: FetchFunction = async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        const body: TelegramApiResponse<{ message_id: number; chat: { id: number; type: string }; date: number }> = {
          ok: true,
          result: {
            message_id: 42,
            chat: { id: 12345, type: 'private' },
            date: 1700000000,
          },
        };
        return new Response(JSON.stringify(body), { status: 200 });
      };

      const client = new TelegramClient({ botToken: TEST_TOKEN, fetchFn: mockFetch });
      const msg = await client.sendMessage({
        chat_id: 12345,
        text: '*Payment Approval Request*',
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [[{ text: 'Approve', callback_data: 'app_123' }]],
        },
      });

      expect(capturedBody).toEqual({
        chat_id: 12345,
        text: '*Payment Approval Request*',
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [[{ text: 'Approve', callback_data: 'app_123' }]],
        },
      });
      expect(msg.message_id).toBe(42);
    });

    it('editMessageText: sends edit request', async () => {
      let capturedBody: unknown;

      const mockFetch: FetchFunction = async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        const body: TelegramApiResponse<boolean> = { ok: true, result: true };
        return new Response(JSON.stringify(body), { status: 200 });
      };

      const client = new TelegramClient({ botToken: TEST_TOKEN, fetchFn: mockFetch });
      const result = await client.editMessageText({
        chat_id: 12345,
        message_id: 42,
        text: 'Payment APPROVED',
      });

      expect(result).toBe(true);
      expect(capturedBody).toEqual({
        chat_id: 12345,
        message_id: 42,
        text: 'Payment APPROVED',
      });
    });

    it('editMessageReplyMarkup: updates inline keyboard', async () => {
      let capturedBody: unknown;

      const mockFetch: FetchFunction = async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        const body: TelegramApiResponse<boolean> = { ok: true, result: true };
        return new Response(JSON.stringify(body), { status: 200 });
      };

      const client = new TelegramClient({ botToken: TEST_TOKEN, fetchFn: mockFetch });
      const result = await client.editMessageReplyMarkup({
        chat_id: 12345,
        message_id: 42,
        reply_markup: { inline_keyboard: [] },
      });

      expect(result).toBe(true);
      expect(capturedBody).toEqual({
        chat_id: 12345,
        message_id: 42,
        reply_markup: { inline_keyboard: [] },
      });
    });

    it('answerCallbackQuery: notifies Telegram client that callback was handled', async () => {
      let capturedBody: unknown;

      const mockFetch: FetchFunction = async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        const body: TelegramApiResponse<boolean> = { ok: true, result: true };
        return new Response(JSON.stringify(body), { status: 200 });
      };

      const client = new TelegramClient({ botToken: TEST_TOKEN, fetchFn: mockFetch });
      const result = await client.answerCallbackQuery({
        callback_query_id: 'cbq_999',
        text: 'Payment approved successfully',
        show_alert: false,
      });

      expect(result).toBe(true);
      expect(capturedBody).toEqual({
        callback_query_id: 'cbq_999',
        text: 'Payment approved successfully',
        show_alert: false,
      });
    });

    it('setWebhook: configures webhook URL and secret_token', async () => {
      let capturedBody: unknown;

      const mockFetch: FetchFunction = async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        const body: TelegramApiResponse<boolean> = { ok: true, result: true };
        return new Response(JSON.stringify(body), { status: 200 });
      };

      const client = new TelegramClient({ botToken: TEST_TOKEN, fetchFn: mockFetch });
      const result = await client.setWebhook({
        url: 'https://payguard.example.com/api/telegram/webhook',
        secret_token: 'secret-12345-token',
        allowed_updates: ['message', 'callback_query'],
      });

      expect(result).toBe(true);
      expect(capturedBody).toEqual({
        url: 'https://payguard.example.com/api/telegram/webhook',
        secret_token: 'secret-12345-token',
        allowed_updates: ['message', 'callback_query'],
      });
    });

    it('getWebhookInfo: returns current webhook configuration', async () => {
      const mockFetch: FetchFunction = async () => {
        const body: TelegramApiResponse<{ url: string; has_custom_certificate: boolean; pending_update_count: number }> = {
          ok: true,
          result: {
            url: 'https://payguard.example.com/webhook',
            has_custom_certificate: false,
            pending_update_count: 0,
          },
        };
        return new Response(JSON.stringify(body), { status: 200 });
      };

      const client = new TelegramClient({ botToken: TEST_TOKEN, fetchFn: mockFetch });
      const info = await client.getWebhookInfo();

      expect(info.url).toBe('https://payguard.example.com/webhook');
      expect(info.pending_update_count).toBe(0);
    });

    it('deleteWebhook: removes webhook', async () => {
      let capturedBody: unknown;

      const mockFetch: FetchFunction = async (_url, init) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
        const body: TelegramApiResponse<boolean> = { ok: true, result: true };
        return new Response(JSON.stringify(body), { status: 200 });
      };

      const client = new TelegramClient({ botToken: TEST_TOKEN, fetchFn: mockFetch });
      const result = await client.deleteWebhook({ drop_pending_updates: true });

      expect(result).toBe(true);
      expect(capturedBody).toEqual({ drop_pending_updates: true });
    });
  });

  describe('Error Handling and Token Redaction in Thrown Errors', () => {
    it('throws non-transient TelegramApiError on 400 Bad Request with redacted URL', async () => {
      const mockFetch: FetchFunction = async () => {
        const body: TelegramApiResponse<never> = {
          ok: false,
          error_code: 400,
          description: 'Bad Request: chat not found',
        };
        return new Response(JSON.stringify(body), { status: 400 });
      };

      const client = new TelegramClient({ botToken: TEST_TOKEN, fetchFn: mockFetch });

      await expect(client.sendMessage({ chat_id: 99999, text: 'hello' })).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(TelegramApiError);
          const apiErr = err as TelegramApiError;
          expect(apiErr.code).toBe(400);
          expect(apiErr.description).toBe('Bad Request: chat not found');
          expect(apiErr.isTransient).toBe(false);
          expect(apiErr.message).not.toContain(TEST_TOKEN);
          expect(apiErr.message).toContain(REDACTED);
          return true;
        }
      );
    });

    it('throws non-transient TelegramApiError on 401 Unauthorized', async () => {
      const mockFetch: FetchFunction = async () => {
        const body: TelegramApiResponse<never> = {
          ok: false,
          error_code: 401,
          description: 'Unauthorized: invalid token',
        };
        return new Response(JSON.stringify(body), { status: 401 });
      };

      const client = new TelegramClient({ botToken: TEST_TOKEN, fetchFn: mockFetch });

      await expect(client.getMe()).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(TelegramApiError);
        const apiErr = err as TelegramApiError;
        expect(apiErr.code).toBe(401);
        expect(apiErr.isTransient).toBe(false);
        expect(apiErr.message).not.toContain(TEST_TOKEN);
        return true;
      });
    });

    it('handles non-JSON error response from Telegram proxy/gateway', async () => {
      const mockFetch: FetchFunction = async () => {
        return new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'Content-Type': 'text/html' },
        });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        maxRetries: 0,
      });

      await expect(client.getMe()).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(TelegramApiError);
        const apiErr = err as TelegramApiError;
        expect(apiErr.code).toBe(502);
        expect(apiErr.isTransient).toBe(true);
        expect(apiErr.message).not.toContain(TEST_TOKEN);
        expect(apiErr.message).toContain('HTTP 502 (Bad Gateway)');
        return true;
      });
    });
  });

  describe('Transient Retry & Rate Limiting Behavior', () => {
    it('retries on 429 Too Many Requests and succeeds on second attempt', async () => {
      let callCount = 0;
      const warnLogs: string[] = [];

      const mockFetch: FetchFunction = async () => {
        callCount++;
        if (callCount === 1) {
          const body: TelegramApiResponse<never> = {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests: retry after 1',
            parameters: { retry_after: 0.01 }, // 10ms for fast unit test
          };
          return new Response(JSON.stringify(body), { status: 429 });
        }
        const successBody: TelegramApiResponse<{ message_id: number }> = {
          ok: true,
          result: { message_id: 101 },
        };
        return new Response(JSON.stringify(successBody), { status: 200 });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        maxRetries: 1,
        logger: {
          warn: (msg) => warnLogs.push(msg),
        },
      });

      const res = await client.sendMessage({ chat_id: 123, text: 'retry test' });
      expect(callCount).toBe(2);
      expect(res.message_id).toBe(101);
      expect(warnLogs.length).toBe(1);
      expect(warnLogs[0]).toContain('Transient error 429');
      expect(warnLogs[0]).not.toContain(TEST_TOKEN);
      expect(warnLogs[0]).toContain(REDACTED);
    });

    it('throws TelegramApiError when maxRetries is exceeded on 429', async () => {
      let callCount = 0;

      const mockFetch: FetchFunction = async () => {
        callCount++;
        const body: TelegramApiResponse<never> = {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests',
          parameters: { retry_after: 0.01 },
        };
        return new Response(JSON.stringify(body), { status: 429 });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        maxRetries: 1,
      });

      await expect(client.sendMessage({ chat_id: 123, text: 'exhaust retries' })).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(TelegramApiError);
          const apiErr = err as TelegramApiError;
          expect(apiErr.code).toBe(429);
          expect(apiErr.isTransient).toBe(true);
          return true;
        }
      );
      expect(callCount).toBe(2); // 1 initial + 1 retry
    });

    it('retries on 503 Service Unavailable for idempotent methods and recovers', async () => {
      let callCount = 0;

      const mockFetch: FetchFunction = async () => {
        callCount++;
        if (callCount === 1) {
          const body: TelegramApiResponse<never> = {
            ok: false,
            error_code: 503,
            description: 'Service Unavailable',
          };
          return new Response(JSON.stringify(body), { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        maxRetries: 1,
      });

      const res = await client.deleteWebhook();
      expect(callCount).toBe(2);
      expect(res).toBe(true);
    });

    it('sendMessage does NOT retry on HTTP 5xx response (single attempt, fail-closed)', async () => {
      let callCount = 0;

      const mockFetch: FetchFunction = async () => {
        callCount++;
        const body: TelegramApiResponse<never> = {
          ok: false,
          error_code: 500,
          description: 'Internal Server Error',
        };
        return new Response(JSON.stringify(body), { status: 500 });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        maxRetries: 2, // Even with 2 retries configured, sendMessage must not retry
      });

      await expect(client.sendMessage({ chat_id: 123, text: 'hello' })).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(TelegramApiError);
          const apiErr = err as TelegramApiError;
          expect(apiErr.code).toBe(500);
          expect(apiErr.isTransient).toBe(true);
          return true;
        }
      );
      expect(callCount).toBe(1); // Crucial invariant: exactly 1 attempt
    });

    it('sendMessage does NOT retry on timeout / AbortError (single attempt, fail-closed)', async () => {
      let callCount = 0;

      const mockFetch: FetchFunction = async (_url, init) => {
        callCount++;
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          }
        });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        timeoutMs: 15,
        maxRetries: 2,
      });

      await expect(client.sendMessage({ chat_id: 123, text: 'hello' })).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(TelegramApiError);
          const apiErr = err as TelegramApiError;
          expect(apiErr.code).toBe(408);
          expect(apiErr.isTransient).toBe(true);
          return true;
        }
      );
      expect(callCount).toBe(1); // Crucial invariant: exactly 1 attempt
    });

    it('sendMessage does NOT retry on ambiguous network failure (single attempt, fail-closed)', async () => {
      let callCount = 0;

      const mockFetch: FetchFunction = async () => {
        callCount++;
        throw new TypeError('Failed to fetch');
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        maxRetries: 2,
      });

      await expect(client.sendMessage({ chat_id: 123, text: 'hello' })).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(TelegramApiError);
          const apiErr = err as TelegramApiError;
          expect(apiErr.code).toBe(0);
          expect(apiErr.isTransient).toBe(true);
          return true;
        }
      );
      expect(callCount).toBe(1); // Crucial invariant: exactly 1 attempt
    });

    it('caps excessive retry_after delays to MAX_TELEGRAM_RETRY_AFTER_MS (5000ms)', async () => {
      vi.useFakeTimers();
      try {
        const warnLogs: string[] = [];
        let callCount = 0;

        const mockFetch: FetchFunction = async () => {
          callCount++;
          if (callCount === 1) {
            const body: TelegramApiResponse<never> = {
              ok: false,
              error_code: 429,
              description: 'Too Many Requests',
              parameters: { retry_after: 99999 }, // 99,999 seconds requested by Telegram
            };
            return new Response(JSON.stringify(body), { status: 429 });
          }
          const successBody: TelegramApiResponse<{ id: number }> = {
            ok: true,
            result: { id: 100 },
          };
          return new Response(JSON.stringify(successBody), { status: 200 });
        };

        const client = new TelegramClient({
          botToken: TEST_TOKEN,
          fetchFn: mockFetch,
          maxRetries: 1,
          logger: { warn: (msg) => warnLogs.push(msg) },
        });

        const reqPromise = client.getMe();
        await vi.advanceTimersByTimeAsync(MAX_TELEGRAM_RETRY_AFTER_MS);
        const res = await reqPromise;

        expect(res.id).toBe(100);
        expect(callCount).toBe(2);
        expect(warnLogs.length).toBe(1);
        expect(warnLogs[0]).toContain(`retrying in ${MAX_TELEGRAM_RETRY_AFTER_MS}ms`);
      } finally {
        vi.useRealTimers();
      }
    });

    it('idempotent method (getMe) safely retries on timeout and recovers', async () => {
      let callCount = 0;

      const mockFetch: FetchFunction = async (_url, init) => {
        callCount++;
        if (callCount === 1) {
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                const abortErr = new Error('The operation was aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
              });
            }
          });
        }
        return new Response(
          JSON.stringify({ ok: true, result: { id: 999, is_bot: true, first_name: 'Bot' } }),
          { status: 200 }
        );
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        timeoutMs: 15,
        maxRetries: 1,
      });

      const user = await client.getMe();
      expect(callCount).toBe(2);
      expect(user.id).toBe(999);
    });
  });

  describe('Timeout Handling', () => {
    it('aborts request on timeout and redacts token from error', async () => {
      const mockFetch: FetchFunction = async (_url, init) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          }
        });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        timeoutMs: 25,
        maxRetries: 0,
      });

      await expect(client.getMe()).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(TelegramApiError);
        const apiErr = err as TelegramApiError;
        expect(apiErr.code).toBe(408);
        expect(apiErr.isTransient).toBe(true);
        expect(apiErr.message).toContain('timeout after 25ms');
        expect(apiErr.message).not.toContain(TEST_TOKEN);
        expect(apiErr.message).toContain(REDACTED);
        return true;
      });
    });

    it('redacts token when network error message contains raw token', async () => {
      const mockFetch: FetchFunction = async () => {
        throw new TypeError(`connect ECONNREFUSED https://api.telegram.org/bot${TEST_TOKEN}/getMe`);
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        maxRetries: 0,
      });

      await expect(client.getMe()).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(TelegramApiError);
        const apiErr = err as TelegramApiError;
        expect(apiErr.code).toBe(0);
        expect(apiErr.isTransient).toBe(true);
        expect(apiErr.message).not.toContain(TEST_TOKEN);
        expect(apiErr.message).toContain(REDACTED);
        return true;
      });
    });
  });

  describe('Per-Request TelegramRequestOptions (Subtask 3.4.1)', () => {
    it('overrides client timeoutMs on a per-request basis', async () => {
      const mockFetch: FetchFunction = async (_url, init) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          }
        });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        timeoutMs: 10000, // long default
        maxRetries: 0,
      });

      await expect(
        client.getMe({ timeoutMs: 25 })
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(TelegramApiError);
        const apiErr = err as TelegramApiError;
        expect(apiErr.code).toBe(408);
        expect(apiErr.message).toContain('timeout after 25ms');
        return true;
      });
    });

    it('overrides client maxRetries on a per-request basis', async () => {
      let callCount = 0;
      const mockFetch: FetchFunction = async () => {
        callCount++;
        return new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), {
          status: 502,
        });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        maxRetries: 3, // default allows 3 retries
      });

      // Override maxRetries to 0 for this request
      await expect(
        client.answerCallbackQuery(
          { callback_query_id: 'cbq_test' },
          { maxRetries: 0 }
        )
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(TelegramApiError);
        expect(callCount).toBe(1); // exactly 1 attempt, zero retries
        return true;
      });
    });

    it('passes AbortSignal to underlying fetch and aborts immediately when signal aborts', async () => {
      let fetchSignal: AbortSignal | null | undefined;
      const extController = new AbortController();

      const mockFetch: FetchFunction = async (_url, init) => {
        fetchSignal = init?.signal;
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const abortErr = new Error('Operation aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            });
          }
        });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        timeoutMs: 5000,
        maxRetries: 2,
      });

      const reqPromise = client.editMessageReplyMarkup(
        { chat_id: 123, message_id: 456, reply_markup: { inline_keyboard: [] } },
        { signal: extController.signal, timeoutMs: 5000, maxRetries: 0 }
      );

      // Verify signal reaches underlying fetch
      expect(fetchSignal).toBeDefined();
      expect(fetchSignal?.aborted).toBe(false);

      // Trigger external abort
      extController.abort('test reason');

      await expect(reqPromise).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(TelegramApiError);
        const apiErr = err as TelegramApiError;
        expect(apiErr.code).toBe(499);
        expect(apiErr.description).toBe('Client Closed Request');
        expect(fetchSignal?.aborted).toBe(true);
        return true;
      });
    });

    it('fails fast when external signal is pre-aborted', async () => {
      let called = false;
      const mockFetch: FetchFunction = async (_url, init) => {
        called = true;
        if (init?.signal?.aborted) {
          const abortErr = new Error('Pre-aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      };

      const client = new TelegramClient({
        botToken: TEST_TOKEN,
        fetchFn: mockFetch,
        maxRetries: 0,
      });

      const preAbortedSignal = AbortSignal.abort('already aborted');

      await expect(
        client.answerCallbackQuery(
          { callback_query_id: 'cbq_pre' },
          { signal: preAbortedSignal }
        )
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(TelegramApiError);
        const apiErr = err as TelegramApiError;
        expect(apiErr.code).toBe(499);
        return true;
      });
      expect(called).toBe(true);
    });
  });
});
