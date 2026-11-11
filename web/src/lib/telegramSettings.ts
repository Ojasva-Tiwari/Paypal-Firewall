/**
 * PayGuard — Telegram Settings API Client & Pure Helpers
 *
 * Wraps the owner Telegram linking endpoints:
 * - GET  /api/telegram/status
 * - POST /api/telegram/link-token
 * - POST /api/telegram/unlink
 */

import { apiClient, ApiError } from './api.js';
import type {
  TelegramLinkTokenResponse,
  TelegramStatusResponse,
  TelegramUnlinkResponse,
} from '../types/api.js';

export async function fetchTelegramStatus(): Promise<TelegramStatusResponse> {
  return apiClient.get<TelegramStatusResponse>('/api/telegram/status');
}

export async function generateTelegramLinkToken(): Promise<TelegramLinkTokenResponse> {
  return apiClient.post<TelegramLinkTokenResponse>('/api/telegram/link-token');
}

export async function unlinkTelegramAccount(): Promise<TelegramUnlinkResponse> {
  return apiClient.post<TelegramUnlinkResponse>('/api/telegram/unlink');
}

/**
 * Extracts a manual `/start <token>` command from a Telegram bot deep link.
 * Useful when the user prefers sending the command manually inside Telegram.
 */
export function extractTelegramStartCommand(deepLink: string): string | null {
  if (!deepLink || typeof deepLink !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(deepLink);
    const startParam = parsed.searchParams.get('start')?.trim();
    if (startParam) {
      return `/start ${startParam}`;
    }
  } catch {
    const match = /[?&]start=([^&\s]+)/i.exec(deepLink);
    if (match?.[1]) {
      try {
        const decoded = decodeURIComponent(match[1]).trim();
        return decoded ? `/start ${decoded}` : null;
      } catch {
        const raw = match[1].trim();
        return raw ? `/start ${raw}` : null;
      }
    }
  }

  return null;
}

/**
 * Translates Telegram API/network errors into clear, actionable UI messages.
 */
export function resolveTelegramErrorMessage(error: unknown, fallback: string): string {
  if (!error) {
    return fallback;
  }

  const errObj = error as {
    status?: number;
    data?: { error?: string; message?: string };
    message?: string;
  };
  const code = errObj.data?.error;
  const serverMessage = errObj.data?.message;

  if (code === 'TELEGRAM_DISABLED') {
    return serverMessage || 'Telegram integration is disabled in server configuration.';
  }

  if (code === 'MINT_FAILED') {
    return serverMessage || 'Failed to generate a Telegram link token. Please try again.';
  }

  if (error instanceof ApiError || typeof errObj.status === 'number') {
    if (errObj.status === 401) {
      return 'Your owner session has expired. Please sign in again.';
    }
    if (errObj.status === 403) {
      return 'Security validation failed (CSRF). Please refresh the page and try again.';
    }
  }

  if (typeof serverMessage === 'string' && serverMessage.trim().length > 0) {
    return serverMessage;
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof errObj.message === 'string' && errObj.message.trim().length > 0) {
    return errObj.message;
  }

  return fallback;
}

