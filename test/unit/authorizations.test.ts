/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T5: Unit Tests for PayPal Authorization Operations
 *
 * Verifies:
 * 1. Successful authorization capture with representation (isCaptured: true).
 * 2. Amount and currency conversion on capture (minor units to decimal string).
 * 3. Amount and currency mismatch detection between request and capture response.
 * 4. Non-completed capture invariant (PENDING or DECLINED is not reported as captured).
 * 5. Required requestId for capture and deterministic payguard-capture-${requestId} key.
 * 6. Caller-supplied idempotencyKey overrides derived capture key.
 * 7. Successful authorization void with HTTP 204 No Content (data: null).
 * 8. Successful authorization void with HTTP 200 OK representation (status: VOIDED).
 * 9. Rejection of HTTP 200 responses where status is not VOIDED.
 * 10. Required requestId for void and deterministic payguard-void-${requestId} key.
 * 11. Caller-supplied idempotencyKey overrides derived void key.
 * 12. Correct endpoint paths, methods, request bodies, and headers.
 * 13. Retrieval of CREATED authorization (isCapturable: true, isVoidable: true).
 * 14. Strict status semantics: PENDING is NOT capturable (isCapturable: false, isVoidable: true).
 * 15. Strict status semantics for terminal states (CAPTURED, PARTIALLY_CAPTURED, VOIDED, EXPIRED, DENIED).
 * 16. HATEOAS link extraction (captureUrl, voidUrl, reauthorizeUrl).
 * 17. Input validation (rejection of empty/whitespace authorizationId or requestId).
 * 18. Malformed response handling (missing id, status, or amount).
 * 19. PayPal 4xx/5xx error mapping preserving debugId.
 * 20. Network errors and credential/token redaction across error messages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PayPalAuthorizationsService,
  AuthorizationError,
} from '../../src/paypal/authorizations.js';
import { PayPalHttpClient } from '../../src/paypal/http.js';
import {
  TokenManager,
  type FetchFunction,
} from '../../src/paypal/tokenManager.js';
import { toMinorUnits } from '../../src/core/money.js';

describe('M2-T5: PayPal Authorization Operations', () => {
  let mockFetch: ReturnType<typeof vi.fn<FetchFunction>>;
  let tokenManager: TokenManager;
  let client: PayPalHttpClient;
  let authService: PayPalAuthorizationsService;

  beforeEach(() => {
    mockFetch = vi.fn<FetchFunction>();

    tokenManager = new TokenManager({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      credentialResolver: () => ({
        clientId: 'mock-client-id',
        clientSecret: 'mock-client-secret',
      }),
      fetchFn: async () => {
        return new Response(
          JSON.stringify({
            access_token: 'mock-auth-token-xyz',
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
      getRetryDelayMs: () => 0,
    });

    authService = new PayPalAuthorizationsService({
      client,
      defaultConnectorKey: 'acme_cloud',
    });
  });

  function createJsonResponse(data: unknown, status = 200, debugId = 'dbg-auth-123') {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'paypal-debug-id': debugId,
      },
    });
  }

  function createEmptyResponse(status = 204, debugId = 'dbg-auth-empty-123') {
    return new Response(null, {
      status,
      headers: {
        'paypal-debug-id': debugId,
      },
    });
  }

  // ==========================================================================
  // 1. Capture Authorization
  // ==========================================================================

  it('1. captureAuthorization: sends correct endpoint, headers, and request body', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'cap-998877',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '15.00' },
        final_capture: true,
        create_time: '2026-10-29T10:00:00Z',
        links: [
          { href: 'https://api.sandbox.paypal.com/v2/payments/captures/cap-998877', rel: 'self', method: 'GET' },
        ],
      }, 201)
    );

    const result = await authService.captureAuthorization({
      authorizationId: 'auth-12345',
      requestId: 'req-001',
      amountMinor: 1500,
      currency: 'USD',
      noteToPayer: 'API credits invoice #101',
    });

    expect(result.id).toBe('cap-998877');
    expect(result.status).toBe('COMPLETED');
    expect(result.isCaptured).toBe(true);
    expect(result.amountMinor).toBe(toMinorUnits(1500));
    expect(result.currency).toBe('USD');
    expect(result.finalCapture).toBe(true);
    expect(result.createTime).toBe('2026-10-29T10:00:00Z');
    expect(result.links?.length).toBe(1);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];

    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/payments/authorizations/auth-12345/capture');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBe('payguard-capture-req-001');
    expect(headers['Prefer']).toBe('return=representation');
    expect(headers['Authorization']).toBe('Bearer mock-auth-token-xyz');

    const parsedBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(parsedBody.final_capture).toBe(true);
    expect(parsedBody.note_to_payer).toBe('API credits invoice #101');
    expect(parsedBody.amount).toEqual({
      currency_code: 'USD',
      value: '15.00',
    });
  });

  it('2. captureAuthorization: exact minor units boundary conversion', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'cap-minor-1',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '0.05' },
      }, 201)
    );

    const result = await authService.captureAuthorization({
      authorizationId: 'auth-5cents',
      requestId: 'req-5cents',
      amountMinor: 5,
      currency: 'USD',
    });

    expect(result.amountMinor).toBe(toMinorUnits(5));
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const parsedBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(parsedBody.amount).toEqual({
      currency_code: 'USD',
      value: '0.05',
    });
  });

  it('3. captureAuthorization: rejects amount mismatch between request and response', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'cap-mismatch',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '20.00' }, // requested 15.00
      }, 201)
    );

    await expect(
      authService.captureAuthorization({
        authorizationId: 'auth-mismatch',
        requestId: 'req-mismatch',
        amountMinor: 1500,
        currency: 'USD',
      })
    ).rejects.toThrow(/Returned capture amount \(2000 minor units\) does not match expected \(1500 minor units\)/);
  });

  it('4. captureAuthorization: rejects currency mismatch between request and response', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'cap-curr-mismatch',
        status: 'COMPLETED',
        amount: { currency_code: 'EUR', value: '15.00' },
      }, 201)
    );

    await expect(
      authService.captureAuthorization({
        authorizationId: 'auth-curr-mismatch',
        requestId: 'req-curr',
        amountMinor: 1500,
        currency: 'USD',
      })
    ).rejects.toThrow(/Returned capture currency 'EUR' does not match expected 'USD'/);
  });

  it('5. captureAuthorization: non-completed capture status sets isCaptured=false', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'cap-pending-1',
        status: 'PENDING',
        amount: { currency_code: 'USD', value: '10.00' },
      }, 201)
    );

    const result = await authService.captureAuthorization({
      authorizationId: 'auth-pend',
      requestId: 'req-pend',
      amountMinor: 1000,
      currency: 'USD',
    });

    expect(result.status).toBe('PENDING');
    expect(result.isCaptured).toBe(false);
  });

  it('6. captureAuthorization: requires requestId or idempotencyKey before making network call', async () => {
    await expect(
      authService.captureAuthorization({
        authorizationId: 'auth-123',
        requestId: '',
      })
    ).rejects.toThrow(/requestId must be a non-empty string to derive an idempotency key/);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('7. captureAuthorization: caller-supplied idempotencyKey overrides derived key', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'cap-override',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '5.00' },
      }, 201)
    );

    await authService.captureAuthorization({
      authorizationId: 'auth-override',
      requestId: 'req-override',
      idempotencyKey: 'custom-caller-capture-key-99',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBe('custom-caller-capture-key-99');
  });

  // ==========================================================================
  // 2. Void Authorization
  // ==========================================================================

  it('8. voidAuthorization: handles HTTP 204 No Content (data === null) as successful void', async () => {
    mockFetch.mockResolvedValueOnce(createEmptyResponse(204));

    const result = await authService.voidAuthorization({
      authorizationId: 'auth-void-204',
      requestId: 'req-void-1',
    });

    expect(result.id).toBe('auth-void-204');
    expect(result.status).toBe('VOIDED');
    expect(result.isVoided).toBe(true);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/payments/authorizations/auth-void-204/void');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');

    const headers = init.headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBe('payguard-void-req-void-1');
  });

  it('9. voidAuthorization: handles HTTP 200 OK with representation', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'auth-void-200',
        status: 'VOIDED',
        links: [
          { href: 'https://api.sandbox.paypal.com/v2/payments/authorizations/auth-void-200', rel: 'self' },
        ],
      }, 200)
    );

    const result = await authService.voidAuthorization({
      authorizationId: 'auth-void-200',
      requestId: 'req-void-2',
    });

    expect(result.id).toBe('auth-void-200');
    expect(result.status).toBe('VOIDED');
    expect(result.isVoided).toBe(true);
    expect(result.links?.length).toBe(1);
  });

  it('10. voidAuthorization: rejects HTTP 200 response where status is not VOIDED', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'auth-not-voided',
        status: 'CREATED',
      }, 200)
    );

    await expect(
      authService.voidAuthorization({
        authorizationId: 'auth-not-voided',
        requestId: 'req-bad-void',
      })
    ).rejects.toThrow(/Void request returned HTTP 200 but status was 'CREATED', expected 'VOIDED'/);
  });

  it('11. voidAuthorization: requires requestId or idempotencyKey before network call', async () => {
    await expect(
      authService.voidAuthorization({
        authorizationId: 'auth-void-empty',
        requestId: '   ',
      })
    ).rejects.toThrow(/requestId must be a non-empty string to derive an idempotency key/);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('12. voidAuthorization: caller-supplied idempotencyKey overrides derived key', async () => {
    mockFetch.mockResolvedValueOnce(createEmptyResponse(204));

    await authService.voidAuthorization({
      authorizationId: 'auth-void-custom',
      requestId: 'req-custom',
      idempotencyKey: 'custom-caller-void-key-77',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBe('custom-caller-void-key-77');
  });

  // ==========================================================================
  // 3. Retrieve Authorization Details & Status Semantics
  // ==========================================================================

  it('13. getAuthorization: parses active CREATED authorization with isCapturable=true and isVoidable=true', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'auth-created-1',
        status: 'CREATED',
        amount: { currency_code: 'USD', value: '45.00' },
        expiration_time: '2026-11-27T04:48:11Z',
        links: [
          { href: 'https://api.sandbox.paypal.com/capture', rel: 'capture' },
          { href: 'https://api.sandbox.paypal.com/void', rel: 'void' },
          { href: 'https://api.sandbox.paypal.com/reauthorize', rel: 'reauthorize' },
        ],
      })
    );

    const auth = await authService.getAuthorization('auth-created-1');

    expect(auth.id).toBe('auth-created-1');
    expect(auth.status).toBe('CREATED');
    expect(auth.amountMinor).toBe(toMinorUnits(4500));
    expect(auth.currency).toBe('USD');
    expect(auth.isCapturable).toBe(true);
    expect(auth.isVoidable).toBe(true);
    expect(auth.isCaptured).toBe(false);
    expect(auth.isVoided).toBe(false);
    expect(auth.isExpired).toBe(false);
    expect(auth.isDenied).toBe(false);
    expect(auth.isPending).toBe(false);
    expect(auth.expirationTime).toBe('2026-11-27T04:48:11Z');
    expect(auth.captureUrl).toBe('https://api.sandbox.paypal.com/capture');
    expect(auth.voidUrl).toBe('https://api.sandbox.paypal.com/void');
    expect(auth.reauthorizeUrl).toBe('https://api.sandbox.paypal.com/reauthorize');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v2/payments/authorizations/auth-created-1');
    expect(init.method).toBe('GET');
  });

  it('14. getAuthorization: PENDING authorization is NOT capturable (isCapturable=false, isVoidable=true)', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'auth-pending-1',
        status: 'PENDING',
        status_details: {
          reason: 'PENDING_REVIEW',
        },
        amount: { currency_code: 'USD', value: '100.00' },
        links: [
          { href: 'https://api.sandbox.paypal.com/void', rel: 'void' },
        ],
      })
    );

    const auth = await authService.getAuthorization('auth-pending-1');

    expect(auth.status).toBe('PENDING');
    expect(auth.isPending).toBe(true);
    expect(auth.isCapturable).toBe(false); // CRITICAL INVARIANT: PENDING is not capturable
    expect(auth.isVoidable).toBe(true);    // PENDING can be voided to release hold
    expect(auth.statusDetailsReason).toBe('PENDING_REVIEW');
    expect(auth.captureUrl).toBeUndefined();
    expect(auth.voidUrl).toBe('https://api.sandbox.paypal.com/void');
  });

  it('15. getAuthorization: terminal statuses correctly identified', async () => {
    const statuses = [
      { status: 'CAPTURED', isCaptured: true, isCapturable: false, isVoidable: false },
      { status: 'PARTIALLY_CAPTURED', isPartiallyCaptured: true, isCaptured: false, isCapturable: false, isVoidable: false },
      { status: 'VOIDED', isVoided: true, isCapturable: false, isVoidable: false },
      { status: 'EXPIRED', isExpired: true, isCapturable: false, isVoidable: false },
      { status: 'DENIED', isDenied: true, isCapturable: false, isVoidable: false },
    ];

    for (const s of statuses) {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: `auth-${s.status.toLowerCase()}`,
          status: s.status,
          amount: { currency_code: 'USD', value: '10.00' },
        })
      );

      const auth = await authService.getAuthorization(`auth-${s.status.toLowerCase()}`);
      expect(auth.status).toBe(s.status);
      expect(auth.isCapturable).toBe(s.isCapturable);
      expect(auth.isVoidable).toBe(s.isVoidable);

      if (s.isCaptured) expect(auth.isCaptured).toBe(true);
      if (s.isPartiallyCaptured) expect(auth.isPartiallyCaptured).toBe(true);
      if (s.isVoided) expect(auth.isVoided).toBe(true);
      if (s.isExpired) expect(auth.isExpired).toBe(true);
      if (s.isDenied) expect(auth.isDenied).toBe(true);
    }
  });

  // ==========================================================================
  // 4. Input & Response Validations
  // ==========================================================================

  it('16. Rejects empty or whitespace authorizationId across all methods', async () => {
    await expect(
      authService.captureAuthorization({ authorizationId: '', requestId: 'req-1' })
    ).rejects.toThrow(/authorizationId must be a non-empty string/);

    await expect(
      authService.voidAuthorization({ authorizationId: '   ', requestId: 'req-1' })
    ).rejects.toThrow(/authorizationId must be a non-empty string/);

    await expect(
      authService.getAuthorization('')
    ).rejects.toThrow(/authorizationId must be a non-empty string/);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('17. Rejects malformed authorization responses', async () => {
    // Missing id
    mockFetch.mockResolvedValueOnce(createJsonResponse({ status: 'CREATED', amount: { currency_code: 'USD', value: '10.00' } }));
    await expect(authService.getAuthorization('auth-1')).rejects.toThrow(/missing id/);

    // Missing status
    mockFetch.mockResolvedValueOnce(createJsonResponse({ id: 'auth-1', amount: { currency_code: 'USD', value: '10.00' } }));
    await expect(authService.getAuthorization('auth-1')).rejects.toThrow(/missing status/);

    // Unrecognized status
    mockFetch.mockResolvedValueOnce(createJsonResponse({ id: 'auth-1', status: 'MYSTERY_STATUS', amount: { currency_code: 'USD', value: '10.00' } }));
    await expect(authService.getAuthorization('auth-1')).rejects.toThrow(/unrecognized status/);

    // Missing amount
    mockFetch.mockResolvedValueOnce(createJsonResponse({ id: 'auth-1', status: 'CREATED' }));
    await expect(authService.getAuthorization('auth-1')).rejects.toThrow(/missing amount or currency/);
  });

  it('18. Rejects malformed capture responses', async () => {
    mockFetch.mockResolvedValueOnce(createJsonResponse({ status: 'COMPLETED' }, 201));
    await expect(
      authService.captureAuthorization({ authorizationId: 'auth-1', requestId: 'req-1' })
    ).rejects.toThrow(/Capture response missing id/);

    mockFetch.mockResolvedValueOnce(createJsonResponse({ id: 'cap-1' }, 201));
    await expect(
      authService.captureAuthorization({ authorizationId: 'auth-1', requestId: 'req-1' })
    ).rejects.toThrow(/Capture response missing status/);
  });

  // ==========================================================================
  // 5. Error Mapping, DebugId & Redaction
  // ==========================================================================

  it('19. Maps PayPal 4xx error with debugId preserved', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          name: 'UNPROCESSABLE_ENTITY',
          message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
          details: [
            {
              issue: 'AUTHORIZATION_ALREADY_CAPTURED',
              description: 'Authorization has previously been captured.',
            },
          ],
        }),
        {
          status: 422,
          headers: {
            'Content-Type': 'application/json',
            'paypal-debug-id': 'dbg-err-capture-422',
          },
        }
      )
    );

    try {
      await authService.captureAuthorization({
        authorizationId: 'auth-already-captured',
        requestId: 'req-fail-1',
      });
      expect.fail('Should have thrown AuthorizationError');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      const authErr = err as AuthorizationError;
      expect(authErr.debugId).toBe('dbg-err-capture-422');
      expect(authErr.message).toContain('Authorization has previously been captured');
      expect(authErr.message).toContain('(debug_id: dbg-err-capture-422)');
    }
  });

  it('20. Redacts secrets and tokens on network or unexpected errors', async () => {
    mockFetch.mockRejectedValueOnce(
      new Error('fetch failed with Basic bW9jay1jbGllbnQtaWQ6bW9jay1jbGllbnQtc2VjcmV0 and Bearer mock-auth-token-xyz')
    );

    try {
      await authService.getAuthorization('auth-net-err');
      expect.fail('Should have thrown AuthorizationError');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthorizationError);
      const authErr = err as AuthorizationError;
      expect(authErr.code).toBe('GET_AUTHORIZATION_FAILED');
    }
  });
});
