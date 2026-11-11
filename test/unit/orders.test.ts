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
      vaultTokenId: 'tok-sandbox-example-0001',
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
    expect(body.payment_source.paypal.vault_id).toBe('tok-sandbox-example-0001');
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
      vaultTokenId: 'tok-sandbox-example-0001',
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

  // ==========================================================================
  // Task C2 Regression Tests: Prefer Header, Reduced Responses, OrderId Recovery
  // ==========================================================================

  it('18. createOrder sends Prefer: return=representation header for both CAPTURE and AUTHORIZE', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-pref-cap',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-pref-cap',
            amount: { currency_code: 'USD', value: '5.00' },
            payments: {
              captures: [
                { id: 'cap-pref-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' } },
              ],
            },
          },
        ],
      }, 201)
    );
    await ordersService.createOrder({
      requestId: 'req-pref-cap',
      amountMinor: toMinorUnits(500),
      currency: 'USD',
      intent: 'CAPTURE',
      vaultTokenId: 'tok-pref',
    });

    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ord-pref-auth',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            custom_id: 'req-pref-auth',
            amount: { currency_code: 'USD', value: '16.00' },
            payments: {
              authorizations: [
                { id: 'auth-pref-1', status: 'CREATED', amount: { currency_code: 'USD', value: '16.00' } },
              ],
            },
          },
        ],
      }, 201)
    );
    await ordersService.createOrder({
      requestId: 'req-pref-auth',
      amountMinor: toMinorUnits(1600),
      currency: 'USD',
      intent: 'AUTHORIZE',
      vaultTokenId: 'tok-pref',
    });

    const capHeaders = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const authHeaders = mockFetch.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(capHeaders['Prefer']).toBe('return=representation');
    expect(authHeaders['Prefer']).toBe('return=representation');
  });

  it('19. createOrder parses reduced PayPal CAPTURE response recovering intent, amount, and custom_id from captures[0]', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: '1P305303VU528854A',
        status: 'COMPLETED',
        // intent omitted (return=minimal behavior)
        purchase_units: [
          {
            reference_id: 'default',
            // custom_id and amount omitted at purchase_unit level
            payments: {
              captures: [
                {
                  id: '3BH91280H60332216',
                  status: 'COMPLETED',
                  custom_id: 'req-minimal-cap',
                  amount: { currency_code: 'USD', value: '1.00' },
                  final_capture: true,
                },
              ],
            },
          },
        ],
      }, 201)
    );

    const result = await ordersService.createOrder({
      requestId: 'req-minimal-cap',
      amountMinor: toMinorUnits(100),
      currency: 'USD',
      intent: 'CAPTURE',
      vaultTokenId: 'tok-min',
    });

    expect(result.id).toBe('1P305303VU528854A');
    expect(result.intent).toBe('CAPTURE');
    expect(result.customId).toBe('req-minimal-cap');
    expect(result.amountMinor).toBe(toMinorUnits(100));
    expect(result.currency).toBe('USD');
    expect(result.isCaptured).toBe(true);
    expect(result.isAuthorized).toBe(false);
    expect(result.capture?.id).toBe('3BH91280H60332216');
  });

  it('20. createOrder parses reduced PayPal AUTHORIZE response recovering intent, amount, and custom_id from authorizations[0]', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: '5UP02354SE6008326',
        status: 'COMPLETED',
        purchase_units: [
          {
            reference_id: 'default',
            payments: {
              authorizations: [
                {
                  id: 'AUTH-MIN-1',
                  status: 'CREATED',
                  custom_id: 'req-minimal-auth',
                  amount: { currency_code: 'USD', value: '16.00' },
                },
              ],
            },
          },
        ],
      }, 201)
    );

    const result = await ordersService.createOrder({
      requestId: 'req-minimal-auth',
      amountMinor: toMinorUnits(1600),
      currency: 'USD',
      intent: 'AUTHORIZE',
      vaultTokenId: 'tok-min',
    });

    expect(result.id).toBe('5UP02354SE6008326');
    expect(result.intent).toBe('AUTHORIZE');
    expect(result.customId).toBe('req-minimal-auth');
    expect(result.amountMinor).toBe(toMinorUnits(1600));
    expect(result.currency).toBe('USD');
    expect(result.isAuthorized).toBe(true);
    expect(result.isCaptured).toBe(false);
    expect(result.authorization?.id).toBe('AUTH-MIN-1');
  });

  it('21. Reduced CAPTURE response with PENDING capture still reports isCaptured=false', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-MIN-PEND',
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: 'CAP-MIN-PEND',
                  status: 'PENDING',
                  custom_id: 'req-min-pend',
                  amount: { currency_code: 'USD', value: '5.00' },
                },
              ],
            },
          },
        ],
      }, 201)
    );

    const result = await ordersService.createOrder({
      requestId: 'req-min-pend',
      amountMinor: toMinorUnits(500),
      currency: 'USD',
      intent: 'CAPTURE',
      vaultTokenId: 'tok-min',
    });

    expect(result.intent).toBe('CAPTURE');
    expect(result.isCaptured).toBe(false);
    expect(result.capture?.status).toBe('PENDING');
  });

  it('22. Fails closed and attaches sanitized orderId when monetary fields are missing in both purchase_unit and payment object', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-NO-MONEY-1',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-no-money',
            // pu.amount omitted, and no payments.captures fallback
          },
        ],
      }, 201, 'dbg-no-money')
    );

    let caught: OrderError | undefined;
    try {
      await ordersService.createOrder({
        requestId: 'req-no-money',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      });
    } catch (err) {
      if (err instanceof OrderError) caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught?.code).toBe('INVALID_ORDER_RESPONSE');
    expect(caught?.orderId).toBe('ORD-NO-MONEY-1');
    expect(caught?.debugId).toBe('dbg-no-money');
  });

  it('23. Fails closed and preserves orderId on reduced response missing custom_id or mismatched monetary fields', async () => {
    // Missing custom_id everywhere on createOrder
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-NO-CUSTOM',
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                { id: 'cap-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' } },
              ],
            },
          },
        ],
      }, 201)
    );
    await expect(
      ordersService.createOrder({
        requestId: 'req-expected',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({
      code: 'CUSTOM_ID_MISMATCH',
      orderId: 'ORD-NO-CUSTOM',
    });

    // Monetary mismatch in recovered capture amount
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-MIN-MISMATCH',
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: 'cap-2',
                  status: 'COMPLETED',
                  custom_id: 'req-min-amt',
                  amount: { currency_code: 'USD', value: '9.99' },
                },
              ],
            },
          },
        ],
      }, 201)
    );
    await expect(
      ordersService.createOrder({
        requestId: 'req-min-amt',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({
      code: 'AMOUNT_MISMATCH',
      orderId: 'ORD-MIN-MISMATCH',
    });
  });

  it('24. Refuses ambiguous or mismatched intent structure on reduced responses and preserves orderId', async () => {
    // Explicit intent mismatch
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-EXPLICIT-MISMATCH',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        purchase_units: [{ custom_id: 'req-1', amount: { currency_code: 'USD', value: '5.00' } }],
      }, 201)
    );
    await expect(
      ordersService.createOrder({
        requestId: 'req-1',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({ code: 'INTENT_MISMATCH', orderId: 'ORD-EXPLICIT-MISMATCH' });

    // Reduced CAPTURE request receiving authorizations instead of captures
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-STRUCT-MISMATCH',
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              authorizations: [
                { id: 'auth-1', status: 'CREATED', custom_id: 'req-2', amount: { currency_code: 'USD', value: '5.00' } },
              ],
            },
          },
        ],
      }, 201)
    );
    await expect(
      ordersService.createOrder({
        requestId: 'req-2',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({ code: 'INTENT_MISMATCH', orderId: 'ORD-STRUCT-MISMATCH' });

    // Reduced response with omitted intent AND empty payments fails closed (never guesses)
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-NO-PAYMENTS',
        status: 'PAYER_ACTION_REQUIRED',
        purchase_units: [
          { custom_id: 'req-3', amount: { currency_code: 'USD', value: '5.00' } },
        ],
      }, 201)
    );
    await expect(
      ordersService.createOrder({
        requestId: 'req-3',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({ code: 'INVALID_ORDER_RESPONSE', orderId: 'ORD-NO-PAYMENTS' });

    // getOrder() must never infer omitted intent even if captures are present
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-GET-NO-INTENT',
        status: 'COMPLETED',
        purchase_units: [
          {
            custom_id: 'req-get',
            amount: { currency_code: 'USD', value: '5.00' },
            payments: {
              captures: [
                { id: 'cap-get', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' } },
              ],
            },
          },
        ],
      }, 200)
    );
    await expect(ordersService.getOrder('ORD-GET-NO-INTENT')).rejects.toMatchObject({
      code: 'INVALID_ORDER_RESPONSE',
      orderId: 'ORD-GET-NO-INTENT',
    });
  });

  it('25. Preserves sanitized orderId on 2xx validation failures and strips unsafe id values', async () => {
    // Missing purchase_units preserves sanitized orderId
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: '  ORD-PRESERVED-1  ',
        status: 'COMPLETED',
        intent: 'CAPTURE',
      }, 201, 'dbg-pres-1')
    );
    await expect(
      ordersService.createOrder({
        requestId: 'req-p1',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({
      code: 'INVALID_ORDER_RESPONSE',
      orderId: 'ORD-PRESERVED-1',
      debugId: 'dbg-pres-1',
    });

    // Malformed decimal string wraps MoneyError preserving orderId
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-BAD-DECIMAL',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          { custom_id: 'req-p2', amount: { currency_code: 'USD', value: 'NaN' } },
        ],
      }, 201)
    );
    await expect(
      ordersService.createOrder({
        requestId: 'req-p2',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({
      code: 'INVALID_ORDER_RESPONSE',
      orderId: 'ORD-BAD-DECIMAL',
    });

    // Tainted id containing whitespace / secret text is rejected without attaching unsafe orderId
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'Bearer super-secret-token',
        status: 'COMPLETED',
      }, 201)
    );
    let taintedErr: OrderError | undefined;
    try {
      await ordersService.createOrder({
        requestId: 'req-tainted',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      });
    } catch (err) {
      if (err instanceof OrderError) taintedErr = err;
    }
    expect(taintedErr).toBeDefined();
    expect(taintedErr?.code).toBe('INVALID_ORDER_RESPONSE');
    expect(taintedErr?.orderId).toBeUndefined();
    expect(taintedErr?.message).not.toContain('super-secret-token');
  });

  it('26. Parses full representation order missing optional top-level fields (links, timestamps, payer, payment_source)', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-OPT-OMITTED',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-opt-omitted',
            amount: { currency_code: 'USD', value: '7.25' },
            payments: {
              captures: [
                {
                  id: 'CAP-OPT-1',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '7.25' },
                },
              ],
            },
          },
        ],
      }, 201)
    );

    const created = await ordersService.createOrder({
      requestId: 'req-opt-omitted',
      amountMinor: toMinorUnits(725),
      currency: 'USD',
      intent: 'CAPTURE',
      vaultTokenId: 'tok-opt',
    });

    expect(created.id).toBe('ORD-OPT-OMITTED');
    expect(created.links).toEqual([]);
    expect(created.isCaptured).toBe(true);
    expect(created.capture?.id).toBe('CAP-OPT-1');

    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-OPT-OMITTED',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-opt-omitted',
            amount: { currency_code: 'USD', value: '7.25' },
            payments: {
              captures: [
                {
                  id: 'CAP-OPT-1',
                  status: 'COMPLETED',
                  amount: { currency_code: 'USD', value: '7.25' },
                },
              ],
            },
          },
        ],
      }, 200)
    );

    const fetched = await ordersService.getOrder('ORD-OPT-OMITTED');
    expect(fetched.links).toEqual([]);
    expect(fetched.amountMinor).toBe(toMinorUnits(725));
    expect(fetched.isCaptured).toBe(true);
  });

  it('27. Fails closed preserving orderId when purchase_unit.custom_id conflicts with payment custom_id', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-CUSTOM-CONFLICT',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-expected',
            amount: { currency_code: 'USD', value: '5.00' },
            payments: {
              captures: [
                {
                  id: 'CAP-CONFLICT',
                  status: 'COMPLETED',
                  custom_id: 'req-different',
                  amount: { currency_code: 'USD', value: '5.00' },
                },
              ],
            },
          },
        ],
      }, 201, 'dbg-custom-conflict')
    );

    await expect(
      ordersService.createOrder({
        requestId: 'req-expected',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({
      code: 'CUSTOM_ID_MISMATCH',
      orderId: 'ORD-CUSTOM-CONFLICT',
      debugId: 'dbg-custom-conflict',
    });
  });

  it('28. getOrder validates capture and authorization amounts against purchase_unit amount and allows captured AUTHORIZE order', async () => {
    // Capture amount differs from purchase_unit amount
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-GET-CAP-MISMATCH',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-get-1',
            amount: { currency_code: 'USD', value: '25.00' },
            payments: {
              captures: [
                { id: 'CAP-PARTIAL', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.00' } },
              ],
            },
          },
        ],
      }, 200)
    );
    await expect(ordersService.getOrder('ORD-GET-CAP-MISMATCH')).rejects.toMatchObject({
      code: 'CAPTURE_AMOUNT_MISMATCH',
      orderId: 'ORD-GET-CAP-MISMATCH',
    });

    // Authorization amount differs from purchase_unit amount
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-GET-AUTH-MISMATCH',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            custom_id: 'req-get-2',
            amount: { currency_code: 'USD', value: '25.00' },
            payments: {
              authorizations: [
                { id: 'AUTH-PARTIAL', status: 'CREATED', amount: { currency_code: 'USD', value: '10.00' } },
              ],
            },
          },
        ],
      }, 200)
    );
    await expect(ordersService.getOrder('ORD-GET-AUTH-MISMATCH')).rejects.toMatchObject({
      code: 'AUTHORIZATION_AMOUNT_MISMATCH',
      orderId: 'ORD-GET-AUTH-MISMATCH',
    });

    // Post-capture AUTHORIZE order with single authorization + single matching capture succeeds on getOrder()
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-GET-AUTH-CAPTURED',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            custom_id: 'req-get-3',
            amount: { currency_code: 'USD', value: '25.00' },
            payments: {
              authorizations: [
                { id: 'AUTH-CAP-1', status: 'CAPTURED', amount: { currency_code: 'USD', value: '25.00' } },
              ],
              captures: [
                { id: 'CAP-FROM-AUTH-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '25.00' } },
              ],
            },
          },
        ],
      }, 200)
    );
    const capturedAuthOrder = await ordersService.getOrder('ORD-GET-AUTH-CAPTURED');
    expect(capturedAuthOrder.intent).toBe('AUTHORIZE');
    expect(capturedAuthOrder.authorization?.id).toBe('AUTH-CAP-1');
    expect(capturedAuthOrder.capture?.id).toBe('CAP-FROM-AUTH-1');
    expect(capturedAuthOrder.isCaptured).toBe(false);
    expect(capturedAuthOrder.isAuthorized).toBe(false);
  });

  it('29. Fails closed preserving orderId when response contains multiple purchase_units, authorizations, or captures', async () => {
    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-MULTI-PU',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          { custom_id: 'req-m1', amount: { currency_code: 'USD', value: '5.00' } },
          { custom_id: 'req-m2', amount: { currency_code: 'USD', value: '5.00' } },
        ],
      }, 201)
    );
    await expect(
      ordersService.createOrder({
        requestId: 'req-m1',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({ code: 'INVALID_ORDER_RESPONSE', orderId: 'ORD-MULTI-PU' });

    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-MULTI-AUTH',
        status: 'COMPLETED',
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            custom_id: 'req-ma',
            amount: { currency_code: 'USD', value: '10.00' },
            payments: {
              authorizations: [
                { id: 'AUTH-1', status: 'CREATED', amount: { currency_code: 'USD', value: '10.00' } },
                { id: 'AUTH-2', status: 'CREATED', amount: { currency_code: 'USD', value: '10.00' } },
              ],
            },
          },
        ],
      }, 201)
    );
    await expect(
      ordersService.createOrder({
        requestId: 'req-ma',
        amountMinor: toMinorUnits(1000),
        currency: 'USD',
        intent: 'AUTHORIZE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({ code: 'INVALID_ORDER_RESPONSE', orderId: 'ORD-MULTI-AUTH' });

    mockFetch.mockResolvedValueOnce(
      createJsonResponse({
        id: 'ORD-MULTI-CAP',
        status: 'COMPLETED',
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: 'req-mc',
            amount: { currency_code: 'USD', value: '10.00' },
            payments: {
              captures: [
                { id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' } },
                { id: 'CAP-2', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.00' } },
              ],
            },
          },
        ],
      }, 201)
    );
    await expect(
      ordersService.createOrder({
        requestId: 'req-mc',
        amountMinor: toMinorUnits(1000),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({ code: 'INVALID_ORDER_RESPONSE', orderId: 'ORD-MULTI-CAP' });
  });

  it('30. Preserves sanitized orderId even when internal parsing throws an unexpected non-OrderError exception', async () => {
    const throwingPayload = {
      id: '  ORD-INTERNAL-CRASH  ',
      get status(): string {
        throw new TypeError('Simulated unexpected parser property error');
      },
    };
    const throwingResponse = {
      ok: true,
      status: 201,
      headers: new Headers({
        'content-type': 'application/json',
        'paypal-debug-id': 'dbg-internal-crash',
      }),
      json: async () => throwingPayload,
      text: async () => '',
    } as unknown as Response;

    mockFetch.mockResolvedValueOnce(throwingResponse);

    await expect(
      ordersService.createOrder({
        requestId: 'req-crash',
        amountMinor: toMinorUnits(500),
        currency: 'USD',
        intent: 'CAPTURE',
        vaultTokenId: 'tok-1',
      })
    ).rejects.toMatchObject({
      code: 'INVALID_ORDER_RESPONSE',
      orderId: 'ORD-INTERNAL-CRASH',
      debugId: 'dbg-internal-crash',
    });
  });
});
