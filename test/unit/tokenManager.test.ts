/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T1: Unit Tests for PayPal Token Manager
 *
 * Verifies:
 * 1. Fetching a token when the cache is empty
 * 2. Returning a valid cached token without another token request
 * 3. Refreshing at the five-minute early-refresh boundary
 * 4. Sharing a single in-flight token request among concurrent calls for the same connector
 * 5. Keeping different connectors' credentials and tokens isolated
 * 6. Invalidating a cached token and fetching a replacement
 * 7. Recovering correctly after a failed token request, without permanently retaining a rejected in-flight promise
 * 8. Handling malformed or unusable token responses safely
 * 9. Ensuring credential values do not appear in exposed errors
 * 10. Refusing production URLs without ALLOW_PRODUCTION=true (Hard Rule 1)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TokenManager,
  TokenManagerError,
  type FetchFunction,
  type CredentialResolver,
  type ConnectorCredentials,
} from '../../src/paypal/tokenManager.js';

describe('M2-T1: TokenManager', () => {
  let currentTime: number;
  let mockFetch: ReturnType<typeof vi.fn<FetchFunction>>;
  let credentialMap: Map<string, ConnectorCredentials>;
  let credentialResolver: CredentialResolver;

  beforeEach(() => {
    currentTime = 1_700_000_000_000; // Fixed base timestamp
    credentialMap = new Map([
      [
        'acme_cloud',
        {
          clientId: 'mock-acme-client-id',
          clientSecret: 'mock-acme-client-secret-XYZ789',
        },
      ],
      [
        'beta_vendor',
        {
          clientId: 'mock-beta-client-id',
          clientSecret: 'mock-beta-client-secret-ABC123',
        },
      ],
    ]);

    credentialResolver = (connectorKey: string) => {
      return credentialMap.get(connectorKey);
    };

    mockFetch = vi.fn<FetchFunction>();
  });

  function createManager(options: Partial<ConstructorParameters<typeof TokenManager>[0]> = {}) {
    return new TokenManager({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      credentialResolver,
      fetchFn: mockFetch,
      nowFn: () => currentTime,
      earlyRefreshBufferMs: 300_000,
      ...options,
    });
  }

  function createSuccessfulResponse(token = 'access-token-123', expiresIn = 3600) {
    return new Response(
      JSON.stringify({
        access_token: token,
        token_type: 'Bearer',
        expires_in: expiresIn,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // ==========================================================================
  // 1. Initial Fetch
  // ==========================================================================
  it('1. should fetch a token when cache is empty', async () => {
    mockFetch.mockResolvedValueOnce(createSuccessfulResponse('token-initial', 3600));
    const manager = createManager();

    const token = await manager.getAccessToken('acme_cloud');

    expect(token).toBe('token-initial');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('grant_type=client_credentials');

    // Verify Basic Auth header was built from credentials
    const expectedAuth = Buffer.from(
      'mock-acme-client-id:mock-acme-client-secret-XYZ789'
    ).toString('base64');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Basic ${expectedAuth}`);
  });

  // ==========================================================================
  // 2. Cache Hit
  // ==========================================================================
  it('2. should return a valid cached token without another token request', async () => {
    mockFetch.mockResolvedValueOnce(createSuccessfulResponse('token-cached', 3600));
    const manager = createManager();

    const token1 = await manager.getAccessToken('acme_cloud');
    expect(token1).toBe('token-cached');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance time by 30 minutes (well before the 55-minute early refresh mark)
    currentTime += 30 * 60 * 1000;

    const token2 = await manager.getAccessToken('acme_cloud');
    expect(token2).toBe('token-cached');
    // Fetch should NOT be called again
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(manager.hasValidToken('acme_cloud')).toBe(true);
  });

  // ==========================================================================
  // 3. Early Refresh at 5-Minute Boundary
  // ==========================================================================
  it('3. should refresh at the five-minute early-refresh boundary (300,000 ms)', async () => {
    // 3600 seconds = 3,600,000 ms
    // Early refresh buffer = 300,000 ms
    // Effective validity window = 3,300,000 ms
    mockFetch
      .mockResolvedValueOnce(createSuccessfulResponse('token-epoch-1', 3600))
      .mockResolvedValueOnce(createSuccessfulResponse('token-epoch-2', 3600));

    const manager = createManager();

    const token1 = await manager.getAccessToken('acme_cloud');
    expect(token1).toBe('token-epoch-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance to 3,299,999 ms (1 ms before early refresh boundary): still valid
    currentTime += 3_299_999;
    expect(manager.hasValidToken('acme_cloud')).toBe(true);
    const tokenStillValid = await manager.getAccessToken('acme_cloud');
    expect(tokenStillValid).toBe('token-epoch-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance 1 ms further to 3,300,000 ms (exact early refresh boundary: now >= expiresAt - 300_000)
    currentTime += 1;
    expect(manager.hasValidToken('acme_cloud')).toBe(false);
    const tokenRefreshed = await manager.getAccessToken('acme_cloud');
    expect(tokenRefreshed).toBe('token-epoch-2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ==========================================================================
  // 4. Single-Flight Deduplication
  // ==========================================================================
  it('4. should share a single in-flight token request among concurrent calls for the same connector', async () => {
    let resolveNetwork: (res: Response) => void;
    const networkPromise = new Promise<Response>((resolve) => {
      resolveNetwork = resolve;
    });

    mockFetch.mockReturnValueOnce(networkPromise);
    const manager = createManager();

    // Launch 5 concurrent calls
    const call1 = manager.getAccessToken('acme_cloud');
    const call2 = manager.getAccessToken('acme_cloud');
    const call3 = manager.getAccessToken('acme_cloud');
    const call4 = manager.getAccessToken('acme_cloud');
    const call5 = manager.getAccessToken('acme_cloud');
    // Allow microtask to resolve credentialResolver before asserting fetchFn call
    await Promise.resolve();

    // Only 1 network request should be initiated
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Resolve the deferred network response
    resolveNetwork!(createSuccessfulResponse('shared-single-flight-token', 3600));

    const [res1, res2, res3, res4, res5] = await Promise.all([
      call1,
      call2,
      call3,
      call4,
      call5,
    ]);

    expect(res1).toBe('shared-single-flight-token');
    expect(res2).toBe('shared-single-flight-token');
    expect(res3).toBe('shared-single-flight-token');
    expect(res4).toBe('shared-single-flight-token');
    expect(res5).toBe('shared-single-flight-token');

    // Fetch remains called exactly once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // 5. Credential & Token Isolation Across Connectors
  // ==========================================================================
  it('5. should keep different connectors credentials and tokens completely isolated', async () => {
    mockFetch
      .mockResolvedValueOnce(createSuccessfulResponse('token-acme', 3600))
      .mockResolvedValueOnce(createSuccessfulResponse('token-beta', 3600));

    const manager = createManager();

    const [tokenAcme, tokenBeta] = await Promise.all([
      manager.getAccessToken('acme_cloud'),
      manager.getAccessToken('beta_vendor'),
    ]);

    expect(tokenAcme).toBe('token-acme');
    expect(tokenBeta).toBe('token-beta');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify calls used different Basic auth headers
    const auth1 = (mockFetch.mock.calls[0]![1]?.headers as Record<string, string>)['Authorization'];
    const auth2 = (mockFetch.mock.calls[1]![1]?.headers as Record<string, string>)['Authorization'];
    expect(auth1).not.toBe(auth2);

    // Invalidating acme does not invalidate beta
    manager.invalidateToken('acme_cloud');
    expect(manager.hasValidToken('acme_cloud')).toBe(false);
    expect(manager.hasValidToken('beta_vendor')).toBe(true);
  });

  // ==========================================================================
  // 6. Token Invalidation
  // ==========================================================================
  it('6. should invalidate a cached token and fetch a replacement on next call', async () => {
    mockFetch
      .mockResolvedValueOnce(createSuccessfulResponse('token-original', 3600))
      .mockResolvedValueOnce(createSuccessfulResponse('token-replacement', 3600));

    const manager = createManager();

    const t1 = await manager.getAccessToken('acme_cloud');
    expect(t1).toBe('token-original');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Simulate 401 handler calling invalidateToken
    manager.invalidateToken('acme_cloud');
    expect(manager.hasValidToken('acme_cloud')).toBe(false);

    const t2 = await manager.getAccessToken('acme_cloud');
    expect(t2).toBe('token-replacement');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ==========================================================================
  // 7. Recovery After Failure (No Stale Rejected Promise)
  // ==========================================================================
  it('7. should recover correctly after a failed token request, without permanently retaining a rejected promise', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Temporary network socket hang up'))
      .mockResolvedValueOnce(createSuccessfulResponse('token-recovered', 3600));

    const manager = createManager();

    // First attempt fails
    await expect(manager.getAccessToken('acme_cloud')).rejects.toThrow(TokenManagerError);

    // Second attempt should not return a stale rejected promise; it must retry the fetch
    const recoveredToken = await manager.getAccessToken('acme_cloud');
    expect(recoveredToken).toBe('token-recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ==========================================================================
  // 8. Malformed Response Handling
  // ==========================================================================
  describe('8. Malformed & Unusable Response Handling', () => {
    it('should reject when OAuth response is missing access_token', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const manager = createManager();

      await expect(manager.getAccessToken('acme_cloud')).rejects.toThrowError(
        /OAuth response did not contain a valid access_token/
      );
    });

    it('should reject when OAuth response has invalid or negative expires_in', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: 'valid-token', expires_in: -10 }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );
      const manager = createManager();

      await expect(manager.getAccessToken('acme_cloud')).rejects.toThrowError(
        /positive expires_in number/
      );
    });

    it('should reject when OAuth response returns non-JSON body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('<html>Bad Gateway</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );
      const manager = createManager();

      await expect(manager.getAccessToken('acme_cloud')).rejects.toThrowError(
        /Failed to parse JSON/
      );
    });

    it('should reject with OAUTH_REQUEST_FAILED and debug ID on HTTP error status', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'invalid_client',
            error_description: 'Client Authentication failed',
          }),
          {
            status: 401,
            headers: {
              'Content-Type': 'application/json',
              'paypal-debug-id': 'dbg-test-999',
            },
          }
        )
      );
      const manager = createManager();

      const error = await manager.getAccessToken('acme_cloud').catch((e) => e);
      expect(error).toBeInstanceOf(TokenManagerError);
      expect(error.code).toBe('OAUTH_REQUEST_FAILED');
      expect(error.message).toContain('HTTP 401');
      expect(error.message).toContain('dbg-test-999');
    });
  });

  // ==========================================================================
  // 9. Zero Secret Leakage in Errors
  // ==========================================================================
  describe('9. Credential Security & Redaction', () => {
    it('should never expose client secret or basic auth headers in error messages', async () => {
      const sensitiveSecret = 'VERY_SECRET_SECRET_DO_NOT_LEAK_999';
      credentialMap.set('leak_test', {
        clientId: 'public-id',
        clientSecret: sensitiveSecret,
      });

      // Simulate a network failure that includes raw request headers in its message
      const rawBasicAuth = Buffer.from(`public-id:${sensitiveSecret}`).toString('base64');
      mockFetch.mockRejectedValueOnce(
        new Error(`Connection failed to server with header Basic ${rawBasicAuth}`)
      );

      const manager = createManager();

      let thrownError: Error | undefined;
      try {
        await manager.getAccessToken('leak_test');
      } catch (err) {
        thrownError = err as Error;
      }

      expect(thrownError).toBeDefined();
      expect(thrownError?.message).not.toContain(sensitiveSecret);
      expect(thrownError?.message).not.toContain(rawBasicAuth);
      expect(thrownError?.message).toContain('[REDACTED]');
    });

    it('should throw MISSING_CREDENTIALS safely when connector key is unknown', async () => {
      const manager = createManager();

      await expect(manager.getAccessToken('unknown_connector')).rejects.toThrow(
        /Missing credentials for connector "unknown_connector"/
      );
    });

    it('should throw INVALID_CONNECTOR_KEY when connector key is empty or invalid', async () => {
      const manager = createManager();

      await expect(manager.getAccessToken('')).rejects.toThrow(
        /Connector key must be a non-empty string/
      );
    });
  });

  // ==========================================================================
  // 10. Production Safety Guards (Hard Rule 1)
  // ==========================================================================
  describe('10. Production Safety Guards', () => {
    it('should refuse production PayPal URL without ALLOW_PRODUCTION=true', () => {
      const originalFlag = process.env.ALLOW_PRODUCTION;
      delete process.env.ALLOW_PRODUCTION;

      try {
        expect(() => {
          new TokenManager({
            baseUrl: 'https://api-m.paypal.com',
            credentialResolver,
          });
        }).toThrowError(/Production PayPal URL is strictly refused/);
      } finally {
        if (originalFlag !== undefined) {
          process.env.ALLOW_PRODUCTION = originalFlag;
        }
      }
    });

    it('should allow production URL only when ALLOW_PRODUCTION=true', () => {
      const originalFlag = process.env.ALLOW_PRODUCTION;
      process.env.ALLOW_PRODUCTION = 'true';

      try {
        const prodManager = new TokenManager({
          baseUrl: 'https://api-m.paypal.com',
          credentialResolver,
        });
        expect(prodManager).toBeDefined();
      } finally {
        if (originalFlag !== undefined) {
          process.env.ALLOW_PRODUCTION = originalFlag;
        } else {
          delete process.env.ALLOW_PRODUCTION;
        }
      }
    });
  });
});
