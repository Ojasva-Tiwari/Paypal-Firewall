/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T2: Unit Tests for PayPal HTTP Request Wrapper
 *
 * Verifies:
 * 1. Successful authenticated request (URL, headers, method, body)
 * 2. Stable PayPal-Request-Id header for POST with idempotencyKey
 * 3. Behavior when no idempotencyKey is supplied (no header, no retries on POST)
 * 4. Canonical retry policy (GET max 3 on network/5xx, POST max 2 with idempotencyKey, never retry 4xx)
 * 5. HTTP 401 token invalidation, single refresh, and single retry
 * 6. Second 401 aborts without infinite loop
 * 7. Canonical error mapping (VAULT_INVALID, DECLINED, INVALID_REQUEST, AUTH_EXPIRED, NETWORK, UNKNOWN)
 * 8. Redaction of access tokens and credentials from errors
 * 9. Production URL guard enforcement (Hard Rule 1)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PayPalHttpClient,
  PayPalHttpError,
  mapPayPalError,
} from '../../src/paypal/http.js';
import {
  TokenManager,
  type FetchFunction,
} from '../../src/paypal/tokenManager.js';

describe('M2-T2: PayPalHttpClient', () => {
  let mockFetch: ReturnType<typeof vi.fn<FetchFunction>>;
  let tokenManager: TokenManager;
  let client: PayPalHttpClient;
  let tokenCounter: number;

  beforeEach(() => {
    tokenCounter = 1;
    mockFetch = vi.fn<FetchFunction>();

    // Mock TokenManager that returns rotating tokens on refresh
    tokenManager = new TokenManager({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      credentialResolver: () => ({
        clientId: 'mock-client-id',
        clientSecret: 'mock-client-secret',
      }),
      fetchFn: async () => {
        return new Response(
          JSON.stringify({
            access_token: `token-v${tokenCounter++}`,
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    client = new PayPalHttpClient({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      tokenManager,
      fetchFn: mockFetch,
      defaultConnectorKey: 'acme_cloud',
      getRetryDelayMs: () => 0, // Zero delay for instant deterministic unit tests
    });
  });

  function createJsonResponse(data: unknown, status = 200, debugId?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (debugId) {
      headers['paypal-debug-id'] = debugId;
    }
    return new Response(JSON.stringify(data), { status, headers });
  }

  // ==========================================================================
  // 1. Successful Authenticated Requests
  // ==========================================================================
  it('1. should make a successful authenticated GET request with correct URL and headers', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({ id: 'ORD-123', status: 'COMPLETED' }, 200, 'dbg-get-1')
    );

    const response = await client.get('/v2/checkout/orders/ORD-123', {
      params: { fields: 'details' },
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ id: 'ORD-123', status: 'COMPLETED' });
    expect(response.debugId).toBe('dbg-get-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/ORD-123?fields=details');
    expect(init?.method).toBe('GET');

    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token-v1');
    expect(headers['Accept']).toBe('application/json');
  });

  it('2. should make a successful POST request with serialized body and Content-Type header', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({ id: 'ORD-POST-1', status: 'CREATED' }, 201)
    );

    const requestBody = { intent: 'AUTHORIZE', purchase_units: [] };
    const response = await client.post('/v2/checkout/orders', requestBody);

    expect(response.status).toBe(201);
    expect(response.data).toEqual({ id: 'ORD-POST-1', status: 'CREATED' });

    const [, init] = mockFetch.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify(requestBody));

    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe('Bearer token-v1');
  });

  // ==========================================================================
  // 3 & 4. Idempotency Key Handling
  // ==========================================================================
  it('3. should attach stable PayPal-Request-Id header when idempotencyKey is supplied', async () => {
    mockFetch.mockResolvedValueOnce(createJsonResponse({ status: 'CREATED' }, 201));

    await client.post(
      '/v2/checkout/orders',
      { amount: '10.00' },
      { idempotencyKey: 'idem-stable-key-123' }
    );

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBe('idem-stable-key-123');
  });

  it('4. should omit PayPal-Request-Id header when no idempotencyKey is supplied', async () => {
    mockFetch.mockResolvedValueOnce(createJsonResponse({ status: 'CREATED' }, 201));

    await client.post('/v2/checkout/orders', { amount: '10.00' });

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBeUndefined();
  });

  // ==========================================================================
  // 5. Canonical Retry Policy
  // ==========================================================================
  describe('Canonical Retry Policy', () => {
    it('GET: should retry up to 3 total attempts on 5xx and succeed if subsequent attempt passes', async () => {
      mockFetch
        .mockResolvedValueOnce(createJsonResponse({ message: 'Internal Server Error' }, 500))
        .mockResolvedValueOnce(createJsonResponse({ message: 'Bad Gateway' }, 502))
        .mockResolvedValueOnce(createJsonResponse({ id: 'recovered' }, 200));

      const res = await client.get('/v2/checkout/orders/123');
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ id: 'recovered' });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('GET: should fail after exhausting max 3 attempts on persistent 5xx', async () => {
      mockFetch
        .mockResolvedValueOnce(createJsonResponse({ message: 'Internal Error 1' }, 500))
        .mockResolvedValueOnce(createJsonResponse({ message: 'Internal Error 2' }, 500))
        .mockResolvedValueOnce(createJsonResponse({ message: 'Internal Error 3' }, 500));

      await expect(client.get('/v2/checkout/orders/123')).rejects.toThrowError(
        PayPalHttpError
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('GET: should retry on network errors up to 3 attempts', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Connection reset by peer'))
        .mockResolvedValueOnce(createJsonResponse({ ok: true }, 200));

      const res = await client.get('/v2/checkout/orders/123');
      expect(res.data).toEqual({ ok: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('POST with idempotencyKey: should retry once on 5xx (max 2 attempts total)', async () => {
      mockFetch
        .mockResolvedValueOnce(createJsonResponse({ message: 'Server error' }, 503))
        .mockResolvedValueOnce(createJsonResponse({ id: 'order-recovered' }, 201));

      const res = await client.post(
        '/v2/checkout/orders',
        { amount: '10.00' },
        { idempotencyKey: 'idem-post-retry' }
      );

      expect(res.status).toBe(201);
      expect(res.data).toEqual({ id: 'order-recovered' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('POST with idempotencyKey: should fail after max 2 attempts on persistent 5xx', async () => {
      mockFetch
        .mockResolvedValueOnce(createJsonResponse({ message: 'Error 1' }, 500))
        .mockResolvedValueOnce(createJsonResponse({ message: 'Error 2' }, 500));

      await expect(
        client.post(
          '/v2/checkout/orders',
          { amount: '10.00' },
          { idempotencyKey: 'idem-fail-post' }
        )
      ).rejects.toThrowError(PayPalHttpError);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('POST without idempotencyKey: should NEVER retry on 5xx or network error (max 1 attempt)', async () => {
      mockFetch.mockResolvedValueOnce(createJsonResponse({ message: 'Server error' }, 500));

      // No idempotencyKey provided
      await expect(
        client.post('/v2/checkout/orders', { amount: '10.00' })
      ).rejects.toThrowError(PayPalHttpError);

      // Must NOT be retried
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('Never retry 4xx: 400 Bad Request or 422 Unprocessable must fail immediately without retries', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse(
          {
            name: 'INVALID_REQUEST',
            message: 'Invalid parameter',
            details: [{ issue: 'INVALID_PARAMETER_VALUE' }],
          },
          400
        )
      );

      await expect(
        client.post(
          '/v2/checkout/orders',
          { amount: 'invalid' },
          { idempotencyKey: 'idem-400' }
        )
      ).rejects.toThrowError(PayPalHttpError);

      // Even with idempotencyKey, 4xx is never retried
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // 6 & 7. 401 Unauthorized Token Invalidation & Single Retry
  // ==========================================================================
  describe('HTTP 401 Token Refresh & Retry', () => {
    it('6. should invalidate cached token, refresh once, and retry once on HTTP 401', async () => {
      const invalidateSpy = vi.spyOn(tokenManager, 'invalidateToken');

      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({ error: 'invalid_token' }, 401, 'dbg-401-first')
        )
        .mockResolvedValueOnce(
          createJsonResponse({ id: 'success-after-token-refresh' }, 200)
        );

      const res = await client.get('/v2/checkout/orders/123');

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ id: 'success-after-token-refresh' });
      expect(invalidateSpy).toHaveBeenCalledWith('acme_cloud');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // First call used token-v1, second call used refreshed token-v2
      const firstHeaders = mockFetch.mock.calls[0]![1]?.headers as Record<string, string>;
      const secondHeaders = mockFetch.mock.calls[1]![1]?.headers as Record<string, string>;
      expect(firstHeaders['Authorization']).toBe('Bearer token-v1');
      expect(secondHeaders['Authorization']).toBe('Bearer token-v2');
    });

    it('7. should abort without infinite loop if second attempt also returns 401', async () => {
      const invalidateSpy = vi.spyOn(tokenManager, 'invalidateToken');

      mockFetch
        .mockResolvedValueOnce(
          createJsonResponse({ error: 'invalid_token' }, 401, 'dbg-401-1')
        )
        .mockResolvedValueOnce(
          createJsonResponse({ error: 'invalid_token' }, 401, 'dbg-401-2')
        );

      let caughtError: PayPalHttpError | undefined;
      try {
        await client.get('/v2/checkout/orders/123');
      } catch (err) {
        caughtError = err as PayPalHttpError;
      }

      expect(caughtError).toBeInstanceOf(PayPalHttpError);
      expect(caughtError?.code).toBe('AUTH_EXPIRED');
      expect(caughtError?.status).toBe(401);
      expect(caughtError?.debugId).toBe('dbg-401-2');

      // Exactly 1 initial call + 1 retry = 2 attempts total
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // 8. Canonical Error Mapping
  // ==========================================================================
  describe('8. Canonical Error Mapping', () => {
    it('should map PAYER_ACTION_REQUIRED to VAULT_INVALID (Section 12.2)', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse(
          {
            name: 'UNPROCESSABLE_ENTITY',
            message: 'Payer action required',
            details: [{ issue: 'PAYER_ACTION_REQUIRED' }],
          },
          422,
          'dbg-payer-action'
        )
      );

      const err = await client.post('/v2/checkout/orders').catch((e) => e);
      expect(err).toBeInstanceOf(PayPalHttpError);
      expect(err.code).toBe('VAULT_INVALID');
      expect(err.issue).toBe('PAYER_ACTION_REQUIRED');
      expect(err.debugId).toBe('dbg-payer-action');
    });

    it('should map INSTRUMENT_DECLINED to DECLINED', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse(
          {
            name: 'UNPROCESSABLE_ENTITY',
            message: 'Instrument was declined',
            details: [
              {
                issue: 'INSTRUMENT_DECLINED',
                description: 'The instrument presented was declined by processor',
              },
            ],
          },
          422,
          'dbg-declined'
        )
      );

      const err = await client.post('/v2/checkout/orders').catch((e) => e);
      expect(err).toBeInstanceOf(PayPalHttpError);
      expect(err.code).toBe('DECLINED');
      expect(err.issue).toBe('INSTRUMENT_DECLINED');
      expect(err.message).toContain('declined by processor');
      expect(err.debugId).toBe('dbg-declined');
    });

    it('should map INVALID_PARAMETER_VALUE to INVALID_REQUEST', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse(
          {
            name: 'INVALID_REQUEST',
            message: 'Request is not well-formed',
            details: [{ issue: 'INVALID_PARAMETER_VALUE' }],
          },
          400,
          'dbg-invalid'
        )
      );

      const err = await client.post('/v2/checkout/orders').catch((e) => e);
      expect(err).toBeInstanceOf(PayPalHttpError);
      expect(err.code).toBe('INVALID_REQUEST');
      expect(err.issue).toBe('INVALID_PARAMETER_VALUE');
    });

    it('should map AUTHORIZATION_EXPIRED to AUTH_EXPIRED', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse(
          {
            name: 'UNPROCESSABLE_ENTITY',
            details: [{ issue: 'AUTHORIZATION_EXPIRED' }],
          },
          422
        )
      );

      const err = await client.post('/v2/payments/authorizations/123/capture').catch((e) => e);
      expect(err).toBeInstanceOf(PayPalHttpError);
      expect(err.code).toBe('AUTH_EXPIRED');
      expect(err.issue).toBe('AUTHORIZATION_EXPIRED');
    });

    it('should map unclassified 500 error to UNKNOWN', async () => {
      mockFetch
        .mockResolvedValueOnce(createJsonResponse({ message: 'Internal error' }, 500))
        .mockResolvedValueOnce(createJsonResponse({ message: 'Internal error' }, 500))
        .mockResolvedValueOnce(createJsonResponse({ message: 'Internal error' }, 500));

      const err = await client.get('/v2/checkout/orders/123').catch((e) => e);
      expect(err).toBeInstanceOf(PayPalHttpError);
      expect(err.code).toBe('UNKNOWN');
      expect(err.status).toBe(500);
    });

    it('should handle pure mapPayPalError helper with undefined status as NETWORK', () => {
      const mapped = mapPayPalError(undefined, undefined, undefined);
      expect(mapped.code).toBe('NETWORK');
    });
  });

  // ==========================================================================
  // 9 & 10. Network Errors & Secret Redaction
  // ==========================================================================
  describe('9 & 10. Network Errors & Secret Redaction', () => {
    it('should map network failure to NETWORK error and scrub Bearer token', async () => {
      mockFetch.mockRejectedValue(
        new Error('Network socket disconnected during request with Bearer token-v1')
      );

      let thrownError: PayPalHttpError | undefined;
      try {
        await client.post('/v2/checkout/orders', { amount: '10.00' });
      } catch (err) {
        thrownError = err as PayPalHttpError;
      }

      expect(thrownError).toBeInstanceOf(PayPalHttpError);
      expect(thrownError?.code).toBe('NETWORK');
      expect(thrownError?.message).not.toContain('token-v1');
      expect(thrownError?.message).toContain('[REDACTED]');
    });
  });

  // ==========================================================================
  // 11. Production Safeguards (Hard Rule 1)
  // ==========================================================================
  describe('11. Production Safety Guards', () => {
    it('should refuse production PayPal URL without ALLOW_PRODUCTION=true', () => {
      const originalFlag = process.env.ALLOW_PRODUCTION;
      delete process.env.ALLOW_PRODUCTION;

      try {
        expect(() => {
          new PayPalHttpClient({
            baseUrl: 'https://api-m.paypal.com',
            tokenManager,
          });
        }).toThrowError(/Production PayPal URL is strictly refused/);
      } finally {
        if (originalFlag !== undefined) {
          process.env.ALLOW_PRODUCTION = originalFlag;
        }
      }
    });
  });
});
