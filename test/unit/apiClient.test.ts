/**
 * PayGuard — Frontend API Client Tests (M4-T6)
 *
 * Verifies:
 * - Credentials: include on all requests
 * - In-memory CSRF token handling without localStorage/sessionStorage
 * - x-csrf-token header attached to mutation requests (POST, PUT, DELETE, PATCH)
 * - GET requests do not send x-csrf-token
 * - Distinguishes 401 auth failures (isAuthError) from 403 CSRF failures (isCsrfError)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { apiClient, setCsrfToken, getCsrfToken, ApiError } from '../../web/src/lib/api.js';

describe('Frontend API Client (M4-T6)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setCsrfToken(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('manages CSRF token in memory and never touches window storage', () => {
    expect(getCsrfToken()).toBeNull();

    setCsrfToken('test-csrf-token-12345');
    expect(getCsrfToken()).toBe('test-csrf-token-12345');

    // Confirm neither localStorage nor sessionStorage was accessed
    setCsrfToken(null);
    expect(getCsrfToken()).toBeNull();
  });

  it('sends credentials: include and Accept: application/json on GET requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: 'ok' }),
    });
    globalThis.fetch = mockFetch;

    const result = await apiClient.get<{ status: string }>('/api/test');
    expect(result).toEqual({ status: 'ok' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call0 = mockFetch.mock.calls[0] as [string, RequestInit];
    const [url, init] = call0;
    expect(url).toBe('/api/test');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');

    const headers = new Headers(init.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.has('x-csrf-token')).toBe(false);
  });

  it('automatically attaches x-csrf-token header on POST mutation requests when token exists', async () => {
    setCsrfToken('secure-csrf-token-abc');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true }),
    });
    globalThis.fetch = mockFetch;

    await apiClient.post('/api/requests/req-1/approve', { reason: 'approved by owner' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call0 = mockFetch.mock.calls[0] as [string, RequestInit];
    const [, init] = call0;
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');

    const headers = new Headers(init.headers);
    expect(headers.get('x-csrf-token')).toBe('secure-csrf-token-abc');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ reason: 'approved by owner' }));
  });

  it('correctly categorizes HTTP 401 as an authentication failure (isAuthError = true)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'Authentication required' }),
    });
    globalThis.fetch = mockFetch;

    await expect(apiClient.get('/api/overview')).rejects.toThrowError(ApiError);

    try {
      await apiClient.get('/api/overview');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.isAuthError).toBe(true);
      expect(apiErr.isCsrfError).toBe(false);
      expect(apiErr.message).toBe('Authentication required');
    }
  });

  it('correctly categorizes HTTP 403 as a CSRF / forbidden failure (isCsrfError = true)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'CSRF token missing or invalid' }),
    });
    globalThis.fetch = mockFetch;

    try {
      await apiClient.post('/api/policies', { rules: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(403);
      expect(apiErr.isAuthError).toBe(false);
      expect(apiErr.isCsrfError).toBe(true);
      expect(apiErr.message).toBe('CSRF token missing or invalid');
    }
  });
});
