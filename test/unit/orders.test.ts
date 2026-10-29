/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T4: Unit Tests for PayPal Orders API Wrapper
 *
 * Verifies:
 * 1. Successful order creation with CAPTURE intent.
 * 2. Successful order creation with AUTHORIZE intent.
 * 3. Correct vaulted-token request structure (payment_source.paypal.vault_id).
 * 4. Correct custom_id mapping from internal requestId.
 * 5. Correct amount and currency handling (minor units to decimal conversion).
 * 6. Stable idempotency key forwarding (caller-supplied vs deterministic fallback).
 * 7. Missing or malformed required response fields.
 * 8. PayPal 4xx and 5xx error mapping.
 * 9. Network failure handling and safe error messages.
 * 10. Secret and token redaction.
 * 11. An order response is not incorrectly reported as a completed capture (isCaptured is false for AUTHORIZE even when order is COMPLETED).
 * 12. Prevention of unsupported intents or malformed requests.
 * 13. Amount and currency mismatch detection between request and response.
 * 14. Authorization amount/currency mismatch detection.
 * 15. getOrder retrieval sends correct GET request and parses response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PayPalOrdersService,
  OrderError,
} from '../../src/paypal/orders.js';
import { PayPalHttpClient } from '../../src/paypal/http.js';
import {
  TokenManager,
  type FetchFunction,
} from '../../src/paypal/tokenManager.js';
import { toMinorUnits } from '../../src/core/money.js';

describe('M2-T4: PayPal Orders API Wrapper', () => {
  let mockFetch: ReturnType<typeof vi.fn<FetchFunction>>;
  let tokenManager: TokenManager;
  let client: PayPalHttpClient;
  let ordersService: PayPalOrdersService;

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
            access_token: 'mock-orders-token-xyz',
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

    ordersService = new PayPalOrdersService({
      client,
      defaultConnectorKey: 'acme_cloud',
    });
  });

  function createJsonResponse(data: unknown, status = 200, debugId = 'dbg-order-123') {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'paypal-debug-id': debugId,
      },
    });
  }

  // ==========================================================================
  // 1. Order Creation with CAPTURE Intent
  // ==========================================================================

  it('1. createOrder (CAPTURE): sends correct endpoint, headers, and request body', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-cap-123',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: 'default',
            custom_id: 'req-001',
            amount: { currency_code: 'USD', value: '12.50' },
            payments: {
              captures: [
                {
                  id: 'cap-999',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '12.50' },
                },
              ],
            },
          },
        ],
      }, 201)
    );

    const result = await ordersService.createOrder({
      requestId: 'req-001',
      amountMinor: toMinorUnits(1250),
      currency: 'USD',
      intent: 'CAPTURE',
      vaultTokenId: '69266860j82772632',
      description: 'API Credits Order',
      idempotencyKey: 'idem-stable-key-1',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;

    expect(url.toString()).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer mock-orders-token-xyz');
    expect(headers['PayPal-Request-Id']).toBe('idem-stable-key-1');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init?.body as string);
    expect(body.intent).toBe('CAPTURE');
    expect(body.payment_source.paypal.vault_id).toBe('69266860j82772632');
    expect(body.purchase_units[0].custom_id).toBe('req-001');
    expect(body.purchase_units[0].description).toBe('API Credits Order');
    expect(body.purchase_units[0].amount.currency_code).toBe('USD');
    expect(body.purchase_units[0].amount.value).toBe('12.50');

    expect(result.id).toBe('ord-cap-123');
    expect(result.status).toBe('COMPLETED');
    expect(result.intent).toBe('CAPTURE');
    expect(result.customId).toBe('req-001');
    expect(result.amountMinor).toBe(toMinorUnits(1250));
    expect(result.currency).toBe('USD');
    expect(result.isCaptured).toBe(true);
    expect(result.isAuthorized).toBe(false);
    expect(result.capture?.id).toBe('cap-999');
    expect(result.capture?.status).toBe('COMPLETED');
  });

  // ==========================================================================
  // 2. Order Creation with AUTHORIZE Intent
  // ==========================================================================

  it('2. createOrder (AUTHORIZE): sends correct endpoint and payload for authorization holds', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: '8HA52206RU194812P',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            reference_id: 'default',
            custom_id: 'req-auth-002',
            amount: { currency_code: 'USD', value: '1.00' },
            payments: {
              authorizations: [
                {
                  id: '0VV72942FA945182R',
                  status: 'CREATED',
                  amount: { currency_code: 'USD', value: '1.00' },
                  expiration_time: '2026-11-27T04:48:11Z',
                  links: [
                    { href: 'https://api-m.sandbox.paypal.com/v2/payments/authorizations/0VV/capture', rel: 'capture' },
                    { href: 'https://api-m.sandbox.paypal.com/v2/payments/authorizations/0VV/void', rel: 'void' },
                  ],
                },
              ],
            },
          },
        ],
      }, 201)
    );

    const result = await ordersService.createOrder({
      requestId: 'req-auth-002',
      amountMinor: toMinorUnits(100),
      currency: 'USD',
      intent: 'AUTHORIZE',
      vaultTokenId: '69266860j82772632',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body.intent).toBe('AUTHORIZE');
    expect(body.purchase_units[0].custom_id).toBe('req-auth-002');
    expect(body.purchase_units[0].amount.value).toBe('1.00');

    // Deterministic fallback idempotency key
    const headers = init?.headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBe('payguard-order-req-auth-002');

    expect(result.id).toBe('8HA52206RU194812P');
    expect(result.status).toBe('COMPLETED');
    expect(result.intent).toBe('AUTHORIZE');
    expect(result.customId).toBe('req-auth-002');
    expect(result.amountMinor).toBe(toMinorUnits(100));
    expect(result.currency).toBe('USD');
  });

  // ==========================================================================
  // 3. Authorization Details Extraction
  // ==========================================================================

  it('3. Extracts authorization ID, status, amount, and action links', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-auth-333',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            custom_id: 'req-003',
            amount: { currency_code: 'USD', value: '40.00' },
            payments: {
              authorizations: [
                {
                  id: 'auth-444',
                  status: 'CREATED',
                  amount: { currency_code: 'USD', value: '40.00' },
                  expiration_time: '2026-11-15T12:00:00Z',
                  links: [
                    { href: 'https://api.sandbox.paypal.com/v2/auth/capture', rel: 'capture' },
                    { href: 'https://api.sandbox.paypal.com/v2/auth/void', rel: 'void' },
                  ],
                },
              ],
            },
          },
        ],
      })
    );

    const result = await ordersService.createOrder({
      requestId: 'req-003',
      amountMinor: toMinorUnits(4000),
      currency: 'USD',
      intent: 'AUTHORIZE',
      vaultTokenId: 'token-abc',
    });

    expect(result.authorization).toBeDefined();
    expect(result.authorization?.id).toBe('auth-444');
    expect(result.authorization?.status).toBe('CREATED');
    expect(result.authorization?.amountMinor).toBe(toMinorUnits(4000));
    expect(result.authorization?.currency).toBe('USD');
    expect(result.authorization?.expirationTime).toBe('2026-11-15T12:00:00Z');
    expect(result.authorization?.captureUrl).toBe('https://api.sandbox.paypal.com/v2/auth/capture');
    expect(result.authorization?.voidUrl).toBe('https://api.sandbox.paypal.com/v2/auth/void');
  });

  // ==========================================================================
  // 4. Capture vs Authorization Distinction (Crucial Invariant)
  // ==========================================================================

  it('4. An AUTHORIZE order with status COMPLETED is NOT marked as captured', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-hold-completed',
        status: 'COMPLETED', // PayPal returns COMPLETED on the order when AUTHORIZE succeeds!
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            custom_id: 'req-004',
            amount: { currency_code: 'USD', value: '10.00' },
            payments: {
              authorizations: [
                {
                  id: 'auth-hold-1',
                  status: 'CREATED',
                  amount: { currency_code: 'USD', value: '10.00' },
                },
              ],
            },
          },
        ],
      })
    );

    const result = await ordersService.createOrder({
      requestId: 'req-004',
      amountMinor: toMinorUnits(1000),
      currency: 'USD',
      intent: 'AUTHORIZE',
      vaultTokenId: 'tok-1',
    });

    // Invariant: isCaptured MUST be false; isAuthorized MUST be true
    expect(result.isCaptured).toBe(false);
    expect(result.isAuthorized).toBe(true);
  });

  it('5. CAPTURE order with capture status COMPLETED correctly sets isCaptured to true', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-cap-ok',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-005',
            amount: { currency_code: 'USD', value: '5.00' },
            payments: {
              captures: [
                {
                  id: 'cap-ok-1',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '5.00' },
                },
              ],
            },
          },
        ],
      })
    );

    const result = await ordersService.createOrder({
      requestId: 'req-005',
      amountMinor: toMinorUnits(500),
      currency: 'USD',
      intent: 'CAPTURE',
      vaultTokenId: 'tok-1',
    });

    expect(result.isCaptured).toBe(true);
    expect(result.isAuthorized).toBe(false);
  });

  it('6. CAPTURE order with pending or declined capture sets isCaptured to false', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-cap-pending',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-006',
            amount: { currency_code: 'USD', value: '5.00' },
            payments: {
              captures: [
                {
                  id: 'cap-pending-1',
                  status: 'PENDING',
                  amount: { currency_code: 'USD', value: '5.00' },
                },
              ],
            },
          },
        ],
      })
    );

    const result = await ordersService.createOrder({
      requestId: 'req-006',
      amountMinor: toMinorUnits(500),
      currency: 'USD',
      intent: 'CAPTURE',
      vaultTokenId: 'tok-1',
    });

    expect(result.isCaptured).toBe(false);
  });

  // ==========================================================================
  // 5. Money & Currency Conversion
  // ==========================================================================

  it('7. Converts integer minor units to exact decimal string at the boundary', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-cents',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-cents',
            amount: { currency_code: 'USD', value: '0.01' },
          },
        ],
      })
    );

    await ordersService.createOrder({
      requestId: 'req-cents',
      amountMinor: toMinorUnits(1), // 1 cent
      currency: 'USD',
      intent: 'CAPTURE',
      vaultTokenId: 'tok-cents',
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body.purchase_units[0].amount.value).toBe('0.01');
  });

  it('8. Rejects invalid or negative amounts and unsupported currencies before dispatch', async () => {
    await expect(
      ordersService.createOrder({
        requestId: 'req-bad',
        amountMinor: -50 as unknown as number,
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok',
      })
    ).rejects.toThrow();

    await expect(
      ordersService.createOrder({
        requestId: 'req-bad',
        amountMinor: toMinorUnits(100),
        currency: 'INVALID_CURRENCY',
        intent: 'CAPTURE',
        vaultTokenId: 'tok',
      })
    ).rejects.toThrow();
  });

  // ==========================================================================
  // 6. Idempotency Key Handling
  // ==========================================================================

  it('9. Caller-supplied idempotency key takes precedence and remains stable', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-idem',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-idem',
            amount: { currency_code: 'USD', value: '1.00' },
          },
        ],
      })
    );

    await ordersService.createOrder({
      requestId: 'req-idem',
      amountMinor: toMinorUnits(100),
      currency: 'USD',
      intent: 'CAPTURE',
      vaultTokenId: 'tok',
      idempotencyKey: 'stable-caller-key-xyz',
    });

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers['PayPal-Request-Id']).toBe('stable-caller-key-xyz');
  });

  // ==========================================================================
  // 7. Amount & Currency Mismatch Rejection
  // ==========================================================================

  it('10. Rejects when returned currency does not match requested currency', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-bad-curr',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-curr',
            amount: { currency_code: 'EUR', value: '10.00' }, // Returned EUR instead of USD!
          },
        ],
      })
    );

    await expect(
      ordersService.createOrder({
        requestId: 'req-curr',
        amountMinor: toMinorUnits(1000),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok',
      })
    ).rejects.toThrow(/Returned currency 'EUR' does not match expected 'USD'/);
  });

  it('11. Rejects when returned amount does not match requested amount', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-bad-amt',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-amt',
            amount: { currency_code: 'USD', value: '50.00' }, // Returned $50 instead of $10!
          },
        ],
      })
    );

    await expect(
      ordersService.createOrder({
        requestId: 'req-amt',
        amountMinor: toMinorUnits(1000),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok',
      })
    ).rejects.toThrow(/Returned amount \(5000 minor units\) does not match expected \(1000 minor units\)/);
  });

  it('12. Rejects when authorization amount does not match order amount', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-bad-auth-amt',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            custom_id: 'req-auth-amt',
            amount: { currency_code: 'USD', value: '10.00' },
            payments: {
              authorizations: [
                {
                  id: 'auth-mismatch',
                  status: 'CREATED',
                  amount: { currency_code: 'USD', value: '9.00' }, // Mismatch!
                },
              ],
            },
          },
        ],
      })
    );

    await expect(
      ordersService.createOrder({
        requestId: 'req-auth-amt',
        amountMinor: toMinorUnits(1000),
        currency: 'USD',
        intent: 'AUTHORIZE',
        vaultTokenId: 'tok',
      })
    ).rejects.toThrow(/Authorization amount \(900\) does not match expected \(1000\)/);
  });

  // ==========================================================================
  // 8. Missing Required Fields & Malformed Response
  // ==========================================================================

  it('13. Rejects response missing id, status, or purchase_units', async () => {
    mockFetch.mockResolvedValueOnce(createJsonResponse({ status: 'COMPLETED' })); // missing id
    await expect(
      ordersService.createOrder({
        requestId: 'req-err',
        amountMinor: toMinorUnits(100),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok',
      })
    ).rejects.toThrow(/missing id/);

    mockFetch.mockResolvedValueOnce(createJsonResponse({ id: 'ord-no-status' })); // missing status
    await expect(
      ordersService.createOrder({
        requestId: 'req-err',
        amountMinor: toMinorUnits(100),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok',
      })
    ).rejects.toThrow(/missing status/);

    mockFetch.mockResolvedValueOnce(createJsonResponse({ id: 'ord-no-pu', status: 'COMPLETED', intent: 'CAPTURE' })); // missing purchase_units
    await expect(
      ordersService.createOrder({
        requestId: 'req-err',
        amountMinor: toMinorUnits(100),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok',
      })
    ).rejects.toThrow(/missing purchase_units/);
  });

  it('14. Rejects unsupported order intents before calling network', async () => {
    await expect(
      ordersService.createOrder({
        requestId: 'req-unsupported',
        amountMinor: toMinorUnits(100),
        currency: 'USD',
        intent: 'VOID' as unknown as 'CAPTURE',
        vaultTokenId: 'tok',
      })
    ).rejects.toThrow(/Unsupported order intent 'VOID'/);
  });

  // ==========================================================================
  // 9. Error Mapping & Redaction
  // ==========================================================================

  it('15. PayPal errors are mapped to OrderError preserving debugId', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse(
        {
          name: 'UNPROCESSABLE_ENTITY',
          message: 'Instrument declined by processor',
          details: [{ issue: 'INSTRUMENT_DECLINED', description: 'Simulated decline' }],
        },
        422,
        'dbg-order-decline-123'
      )
    );

    let caughtError: OrderError | undefined;
    try {
      await ordersService.createOrder({
        requestId: 'req-declined',
        amountMinor: toMinorUnits(100),
        currency: 'USD',
        intent: 'AUTHORIZE',
        vaultTokenId: 'tok',
      });
    } catch (err) {
      if (err instanceof OrderError) {
        caughtError = err;
      }
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.code).toBe('DECLINED');
    expect(caughtError?.debugId).toBe('dbg-order-decline-123');
    expect(caughtError?.message).toContain('debug_id: dbg-order-decline-123');
  });

  it('16. Network errors are handled safely and redact sensitive tokens', async () => {
    mockFetch.mockRejectedValue(
      new Error('Network drop exposing Bearer mock-orders-token-xyz')
    );

    let caughtError: OrderError | undefined;
    try {
      await ordersService.createOrder({
        requestId: 'req-net',
        amountMinor: toMinorUnits(100),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok',
      });
    } catch (err) {
      if (err instanceof OrderError) {
        caughtError = err;
      }
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.code).toBe('NETWORK');
    expect(caughtError?.message).not.toContain('mock-orders-token-xyz');
    expect(caughtError?.message).toContain('[REDACTED]');
  });

  // ==========================================================================
  // 10. getOrder Retrieval
  // ==========================================================================

  it('17. getOrder sends GET request to /v2/checkout/orders/{id} and parses result', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-get-999',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            custom_id: 'req-get-999',
            amount: { currency_code: 'USD', value: '25.00' },
            payments: {
              authorizations: [
                {
                  id: 'auth-get-999',
                  status: 'CREATED',
                  amount: { currency_code: 'USD', value: '25.00' },
                },
              ],
            },
          },
        ],
      })
    );

    const result = await ordersService.getOrder('ord-get-999');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url.toString()).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/ord-get-999');
    expect(init?.method).toBe('GET');

    expect(result.id).toBe('ord-get-999');
    expect(result.status).toBe('COMPLETED');
    expect(result.amountMinor).toBe(toMinorUnits(2500));
    expect(result.isAuthorized).toBe(true);
    expect(result.isCaptured).toBe(false);
  });
});
