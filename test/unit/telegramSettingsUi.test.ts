/**
 * PayGuard — Telegram Settings UI Helpers & API Contract Tests
 *
 * Verifies:
 * 1. GET /api/telegram/status client integration & response typing
 * 2. POST /api/telegram/link-token with CSRF header and response contract
 * 3. POST /api/telegram/unlink with CSRF header and response contract
 * 4. extractTelegramStartCommand parsing from bot deep links
 * 5. resolveTelegramErrorMessage translations for disabled/auth/CSRF/server errors
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError, setCsrfToken } from '../../web/src/lib/api.js';
import {
  extractTelegramStartCommand,
  fetchTelegramStatus,
  generateTelegramLinkToken,
  resolveTelegramErrorMessage,
  unlinkTelegramAccount,
} from '../../web/src/lib/telegramSettings.js';

describe('Telegram Settings UI Helpers & API Integration', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setCsrfToken('csrf-token-telegram-test');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setCsrfToken(null);
    vi.restoreAllMocks();
  });

  describe('extractTelegramStartCommand', () => {
    it('extracts `/start <token>` from standard Telegram deep link', () => {
      expect(
        extractTelegramStartCommand('https://t.me/PayGuardBot?start=abcDEF123_-xyz')
      ).toBe('/start abcDEF123_-xyz');
    });

    it('returns null when deepLink lacks a start token or is empty', () => {
      expect(extractTelegramStartCommand('https://t.me/PayGuardBot')).toBeNull();
      expect(extractTelegramStartCommand('https://t.me/PayGuardBot?start=')).toBeNull();
      expect(extractTelegramStartCommand('')).toBeNull();
    });
  });

  describe('resolveTelegramErrorMessage', () => {
    it('translates TELEGRAM_DISABLED, 401, 403, and generic server messages cleanly', () => {
      expect(
        resolveTelegramErrorMessage(
          new ApiError('TELEGRAM_DISABLED', 400, {
            error: 'TELEGRAM_DISABLED',
            message: 'Telegram integration is disabled in server configuration',
          }),
          'fallback'
        )
      ).toBe('Telegram integration is disabled in server configuration');

      expect(
        resolveTelegramErrorMessage(new ApiError('Unauthorized', 401), 'fallback')
      ).toContain('session has expired');

      expect(
        resolveTelegramErrorMessage(new ApiError('Forbidden', 403), 'fallback')
      ).toContain('CSRF');

      expect(resolveTelegramErrorMessage(null, 'Default fallback')).toBe('Default fallback');
    });
  });

  describe('API Client Functions', () => {
    it('fetchTelegramStatus calls GET /api/telegram/status with credentials', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          configured: true,
          mode: 'webhook',
          botUsername: 'PayGuardBot',
          linked: true,
          chatId: '777111',
          username: 'alice_tg',
          linkedAt: '2026-11-10T10:00:00.000Z',
        }),
      });
      globalThis.fetch = mockFetch;

      const status = await fetchTelegramStatus();
      expect(status.configured).toBe(true);
      expect(status.linked).toBe(true);
      expect(status.chatId).toBe('777111');
      expect(status.username).toBe('alice_tg');

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/telegram/status');
      expect(init.method).toBe('GET');
      expect(init.credentials).toBe('include');
    });

    it('generateTelegramLinkToken calls POST /api/telegram/link-token with CSRF header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          deepLink: 'https://t.me/PayGuardBot?start=token123',
          expiresAt: '2026-11-10T10:10:00.000Z',
          ttlSeconds: 600,
        }),
      });
      globalThis.fetch = mockFetch;

      const res = await generateTelegramLinkToken();
      expect(res.success).toBe(true);
      expect(res.deepLink).toBe('https://t.me/PayGuardBot?start=token123');
      expect(res.ttlSeconds).toBe(600);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/telegram/link-token');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-token-telegram-test');
    });

    it('unlinkTelegramAccount calls POST /api/telegram/unlink with CSRF header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          success: true,
          message: 'Telegram account unlinked successfully',
        }),
      });
      globalThis.fetch = mockFetch;

      const res = await unlinkTelegramAccount();
      expect(res.success).toBe(true);
      expect(res.message).toBe('Telegram account unlinked successfully');

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/telegram/unlink');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('x-csrf-token')).toBe('csrf-token-telegram-test');
    });
  });
});

