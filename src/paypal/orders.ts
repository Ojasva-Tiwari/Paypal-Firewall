/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T4: PayPal Orders API Wrapper
 *
 * Implements:
 * - Orders v2 creation with CAPTURE and AUTHORIZE intents (POST /v2/checkout/orders)
 * - Order retrieval (GET /v2/checkout/orders/{id})
 * - Vaulted payment token integration via canonical payment_source.paypal.vault_id
 * - purchase_units[0].custom_id mapped to internal requestId
 * - Strict money conversion boundary using formatMinorUnitsToDecimal & parseDecimalToMinorUnits
 * - Returned amount and currency validation (fails on mismatch)
 * - Strict isCaptured & isAuthorized semantics derived from actual payment objects, never solely order status
 * - Stable caller-supplied idempotency key (or deterministic payguard-order-${requestId})
 * - Safe OrderError mapping with debug_id preservation and secret/token redaction
 *
 * Security & Invariants:
 * - Hard Rule 1: Sandbox only. Production refused unless ALLOW_PRODUCTION=true.
 * - Hard Rule 2 & I7: Never log or expose credentials, access tokens, or full token IDs.
 * - Hard Rule 5: Money is integer minor units; converted to decimal strings only at PayPal boundary.
 */

import type { PayPalHttpClient } from './http.js';
import { PayPalHttpError } from './http.js';
import {
  formatMinorUnitsToDecimal,
  parseDecimalToMinorUnits,
  validateCurrency,
  toMinorUnits,
  type MinorUnits,
} from '../core/money.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type OrderIntent = 'CAPTURE' | 'AUTHORIZE';

export interface CreateOrderParams {
  readonly requestId: string;
  readonly amountMinor: MinorUnits | number;
  readonly currency: string;
  readonly intent: OrderIntent;
  readonly vaultTokenId: string;
  readonly description?: string;
  readonly connectorKey?: string;
  readonly idempotencyKey?: string;
}

export interface AuthorizationSummary {
  readonly id: string;
  readonly status: string;
  readonly amountMinor: MinorUnits;
  readonly currency: string;
  readonly expirationTime?: string;
  readonly captureUrl?: string;
  readonly voidUrl?: string;
}

export interface CaptureSummary {
  readonly id: string;
  readonly status: string;
  readonly amountMinor: MinorUnits;
  readonly currency: string;
}

export interface PayPalOrderResult {
  readonly id: string;
  readonly status: string;
  readonly intent: OrderIntent;
  readonly customId?: string;
  readonly amountMinor: MinorUnits;
  readonly currency: string;
  readonly authorization?: AuthorizationSummary;
  readonly capture?: CaptureSummary;
  readonly isCaptured: boolean;
  readonly isAuthorized: boolean;
  readonly links?: readonly { href: string; rel: string; method?: string }[];
}

export interface PayPalOrdersServiceOptions {
  readonly client: PayPalHttpClient;
  readonly defaultConnectorKey?: string;
}

// ============================================================================
// Error Class
// ============================================================================

export class OrderError extends Error {
  public readonly code: string;
  public readonly debugId?: string;
  public readonly causeError?: unknown;

  constructor(
    code: string,
    message: string,
    options?: { debugId?: string; causeError?: unknown }
  ) {
    const debugSuffix = options?.debugId ? ` (debug_id: ${options.debugId})` : '';
    super(`[${code}] ${message}${debugSuffix}`);
    this.name = 'OrderError';
    this.code = code;
    this.debugId = options?.debugId;
    this.causeError = options?.causeError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// PayPal Orders Service
// ============================================================================

export class PayPalOrdersService {
  private readonly client: PayPalHttpClient;
  private readonly defaultConnectorKey: string;

  constructor(options: PayPalOrdersServiceOptions) {
    this.client = options.client;
    this.defaultConnectorKey = options.defaultConnectorKey ?? 'acme_cloud';
  }

  /**
   * Creates an order with CAPTURE or AUTHORIZE intent using a vaulted payment token
   * (POST /v2/checkout/orders).
   *
   * @param params - Order creation parameters including requestId, amountMinor, currency, intent, and vaultTokenId
   * @returns PayPalOrderResult with parsed payment details and verified amounts
   */
  public async createOrder(params: CreateOrderParams): Promise<PayPalOrderResult> {
    // 1. Validate inputs
    const requestId = params.requestId?.trim();
    if (!requestId) {
      throw new OrderError('INVALID_PARAMETER', 'requestId must be a non-empty string');
    }

    if (params.intent !== 'CAPTURE' && params.intent !== 'AUTHORIZE') {
      throw new OrderError(
        'INVALID_INTENT',
        `Unsupported order intent '${String(params.intent)}'. Must be 'CAPTURE' or 'AUTHORIZE'`
      );
    }

    const vaultTokenId = params.vaultTokenId?.trim();
    if (!vaultTokenId) {
      throw new OrderError('INVALID_PARAMETER', 'vaultTokenId must be a non-empty string');
    }

    const validatedCurrency = validateCurrency(params.currency);
    const validatedMinorUnits = toMinorUnits(params.amountMinor);
    const decimalAmount = formatMinorUnitsToDecimal(validatedMinorUnits);

    const connectorKey = params.connectorKey ?? this.defaultConnectorKey;

    // Stable idempotency key: prefer caller-supplied stable key; otherwise derive deterministically
    // from requestId + step per PLAN.md Section 9 line 441 ("derived from request_id + step")
    const idempotencyKey = params.idempotencyKey?.trim() || `payguard-order-${requestId}`;

    const payload: Record<string, unknown> = {
      intent: params.intent,
      payment_source: {
        paypal: {
          vault_id: vaultTokenId,
        },
      },
      purchase_units: [
        {
          reference_id: 'default',
          custom_id: requestId,
          description: params.description ?? `PayGuard ${params.intent} Order ${requestId}`,
          amount: {
            currency_code: validatedCurrency,
            value: decimalAmount,
          },
        },
      ],
    };

    try {
      const response = await this.client.post<Record<string, unknown>>(
        '/v2/checkout/orders',
        payload,
        {
          connectorKey,
          idempotencyKey,
        }
      );

      return this.parseOrderResponse(response.data, response.debugId, {
        expectedRequestId: requestId,
        expectedAmountMinor: validatedMinorUnits,
        expectedCurrency: validatedCurrency,
        expectedIntent: params.intent,
      });
    } catch (err) {
      this.handleError(err, 'CREATE_ORDER_FAILED', `Failed to create order for request '${requestId}'`);
    }
  }

  /**
   * Retrieves an existing order by ID (GET /v2/checkout/orders/{id}).
   *
   * @param orderId - The PayPal order ID
   * @param options - Optional connectorKey override
   */
  public async getOrder(
    orderId: string,
    options?: { connectorKey?: string }
  ): Promise<PayPalOrderResult> {
    const id = orderId?.trim();
    if (!id) {
      throw new OrderError('INVALID_PARAMETER', 'orderId must be a non-empty string');
    }

    const connectorKey = options?.connectorKey ?? this.defaultConnectorKey;
    const encodedId = encodeURIComponent(id);

    try {
      const response = await this.client.get<Record<string, unknown>>(
        `/v2/checkout/orders/${encodedId}`,
        { connectorKey }
      );

      return this.parseOrderResponse(response.data, response.debugId);
    } catch (err) {
      this.handleError(err, 'GET_ORDER_FAILED', `Failed to retrieve order '${id}'`);
    }
  }

  // ============================================================================
  // Private Response Parser & Validator
  // ============================================================================

  private parseOrderResponse(
    data: unknown,
    debugId?: string,
    expectations?: {
      readonly expectedRequestId?: string;
      readonly expectedAmountMinor?: MinorUnits;
      readonly expectedCurrency?: string;
      readonly expectedIntent?: OrderIntent;
    }
  ): PayPalOrderResult {
    if (!data || typeof data !== 'object') {
      throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response is empty or not an object', { debugId });
    }

    const obj = data as Record<string, unknown>;

    // 1. Validate required order ID
    const id = typeof obj.id === 'string' ? obj.id.trim() : undefined;
    if (!id || id.length === 0) {
      throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response missing id', { debugId });
    }

    // 2. Validate order status
    const status = typeof obj.status === 'string' ? obj.status.trim() : undefined;
    if (!status || status.length === 0) {
      throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response missing status', { debugId });
    }

    // 3. Validate intent
    const intentRaw = typeof obj.intent === 'string' ? obj.intent.trim() : undefined;
    if (intentRaw !== 'CAPTURE' && intentRaw !== 'AUTHORIZE') {
      throw new OrderError(
        'INVALID_ORDER_RESPONSE',
        `Order response contains invalid intent '${String(intentRaw)}'`,
        { debugId }
      );
    }
    const intent = intentRaw as OrderIntent;

    if (expectations?.expectedIntent && intent !== expectations.expectedIntent) {
      throw new OrderError(
        'INTENT_MISMATCH',
        `Returned order intent '${intent}' does not match requested intent '${expectations.expectedIntent}'`,
        { debugId }
      );
    }

    // 4. Validate purchase_units
    const purchaseUnits = Array.isArray(obj.purchase_units) ? obj.purchase_units : [];
    if (purchaseUnits.length === 0 || typeof purchaseUnits[0] !== 'object' || purchaseUnits[0] === null) {
      throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response missing purchase_units', { debugId });
    }

    const pu = purchaseUnits[0] as Record<string, unknown>;
    const customId = typeof pu.custom_id === 'string' ? pu.custom_id : undefined;

    if (expectations?.expectedRequestId && customId !== expectations.expectedRequestId) {
      throw new OrderError(
        'CUSTOM_ID_MISMATCH',
        `Returned custom_id '${String(customId)}' does not match requested requestId '${expectations.expectedRequestId}'`,
        { debugId }
      );
    }

    // 5. Validate Amount & Currency
    const amountObj = typeof pu.amount === 'object' && pu.amount !== null ? (pu.amount as Record<string, unknown>) : undefined;
    const currencyRaw = typeof amountObj?.currency_code === 'string' ? amountObj.currency_code : undefined;
    const valueRaw = typeof amountObj?.value === 'string' ? amountObj.value : undefined;

    if (!currencyRaw || !valueRaw) {
      throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response purchase_unit missing amount or currency', { debugId });
    }

    const returnedCurrency = validateCurrency(currencyRaw);
    const returnedAmountMinor = parseDecimalToMinorUnits(valueRaw);

    if (expectations?.expectedCurrency && returnedCurrency !== expectations.expectedCurrency) {
      throw new OrderError(
        'CURRENCY_MISMATCH',
        `Returned currency '${returnedCurrency}' does not match expected '${expectations.expectedCurrency}'`,
        { debugId }
      );
    }

    if (expectations?.expectedAmountMinor !== undefined && returnedAmountMinor !== expectations.expectedAmountMinor) {
      throw new OrderError(
        'AMOUNT_MISMATCH',
        `Returned amount (${returnedAmountMinor} minor units) does not match expected (${expectations.expectedAmountMinor} minor units)`,
        { debugId }
      );
    }

    // 6. Extract Payments: Authorizations & Captures
    const payments = typeof pu.payments === 'object' && pu.payments !== null ? (pu.payments as Record<string, unknown>) : undefined;

    let authorization: AuthorizationSummary | undefined;
    let capture: CaptureSummary | undefined;

    // A. Parse Authorization
    if (Array.isArray(payments?.authorizations) && payments.authorizations.length > 0) {
      const authRaw = payments.authorizations[0] as Record<string, unknown> | undefined;
      const authId = typeof authRaw?.id === 'string' ? authRaw.id : undefined;
      const authStatus = typeof authRaw?.status === 'string' ? authRaw.status : undefined;
      const authAmountObj = typeof authRaw?.amount === 'object' && authRaw?.amount !== null ? (authRaw.amount as Record<string, unknown>) : undefined;

      if (authRaw && authId && authStatus && typeof authAmountObj?.value === 'string' && typeof authAmountObj?.currency_code === 'string') {
        const authCurrency = validateCurrency(authAmountObj.currency_code);
        const authMinor = parseDecimalToMinorUnits(authAmountObj.value);

        if (expectations?.expectedCurrency && authCurrency !== expectations.expectedCurrency) {
          throw new OrderError(
            'AUTHORIZATION_CURRENCY_MISMATCH',
            `Authorization currency '${authCurrency}' does not match expected '${expectations.expectedCurrency}'`,
            { debugId }
          );
        }
        if (expectations?.expectedAmountMinor !== undefined && authMinor !== expectations.expectedAmountMinor) {
          throw new OrderError(
            'AUTHORIZATION_AMOUNT_MISMATCH',
            `Authorization amount (${authMinor}) does not match expected (${expectations.expectedAmountMinor})`,
            { debugId }
          );
        }

        let captureUrl: string | undefined;
        let voidUrl: string | undefined;

        if (Array.isArray(authRaw.links)) {
          for (const l of authRaw.links) {
            if (typeof l === 'object' && l !== null) {
              const linkObj = l as Record<string, unknown>;
              if (linkObj.rel === 'capture' && typeof linkObj.href === 'string') {
                captureUrl = linkObj.href;
              } else if (linkObj.rel === 'void' && typeof linkObj.href === 'string') {
                voidUrl = linkObj.href;
              }
            }
          }
        }

        authorization = {
          id: authId,
          status: authStatus,
          amountMinor: authMinor,
          currency: authCurrency,
          expirationTime: typeof authRaw.expiration_time === 'string' ? authRaw.expiration_time : undefined,
          captureUrl,
          voidUrl,
        };
      }
    }

    // B. Parse Capture
    if (Array.isArray(payments?.captures) && payments.captures.length > 0) {
      const capRaw = payments.captures[0] as Record<string, unknown> | undefined;
      const capId = typeof capRaw?.id === 'string' ? capRaw.id : undefined;
      const capStatus = typeof capRaw?.status === 'string' ? capRaw.status : undefined;
      const capAmountObj = typeof capRaw?.amount === 'object' && capRaw?.amount !== null ? (capRaw.amount as Record<string, unknown>) : undefined;

      if (capId && capStatus && typeof capAmountObj?.value === 'string' && typeof capAmountObj?.currency_code === 'string') {
        const capCurrency = validateCurrency(capAmountObj.currency_code);
        const capMinor = parseDecimalToMinorUnits(capAmountObj.value);

        if (expectations?.expectedCurrency && capCurrency !== expectations.expectedCurrency) {
          throw new OrderError(
            'CAPTURE_CURRENCY_MISMATCH',
            `Capture currency '${capCurrency}' does not match expected '${expectations.expectedCurrency}'`,
            { debugId }
          );
        }
        if (expectations?.expectedAmountMinor !== undefined && capMinor !== expectations.expectedAmountMinor) {
          throw new OrderError(
            'CAPTURE_AMOUNT_MISMATCH',
            `Capture amount (${capMinor}) does not match expected (${expectations.expectedAmountMinor})`,
            { debugId }
          );
        }

        capture = {
          id: capId,
          status: capStatus,
          amountMinor: capMinor,
          currency: capCurrency,
        };
      }
    }

    // 7. Explicit Invariant: isCaptured & isAuthorized derived strictly from payment object statuses
    // Never infer capture or authorization solely from order status (an AUTHORIZE order returns status COMPLETED!)
    const isAuthorized = Boolean(
      authorization && (authorization.status === 'CREATED' || authorization.status === 'PENDING')
    );
    const isCaptured = Boolean(
      intent === 'CAPTURE' && capture && capture.status === 'COMPLETED'
    );

    // 8. Extract Links
    const links: Array<{ href: string; rel: string; method?: string }> = [];
    if (Array.isArray(obj.links)) {
      for (const l of obj.links) {
        if (typeof l === 'object' && l !== null) {
          const lo = l as Record<string, unknown>;
          if (typeof lo.href === 'string' && typeof lo.rel === 'string') {
            links.push({
              href: lo.href,
              rel: lo.rel,
              method: typeof lo.method === 'string' ? lo.method : undefined,
            });
          }
        }
      }
    }

    return {
      id,
      status,
      intent,
      customId,
      amountMinor: returnedAmountMinor,
      currency: returnedCurrency,
      authorization,
      capture,
      isCaptured,
      isAuthorized,
      links,
    };
  }

  private handleError(err: unknown, defaultCode: string, defaultMessage: string): never {
    if (err instanceof OrderError) {
      throw err;
    }
    if (err instanceof PayPalHttpError) {
      throw new OrderError(err.code, err.message, {
        debugId: err.debugId,
        causeError: err,
      });
    }
    const msg = err instanceof Error ? err.message : defaultMessage;
    throw new OrderError(defaultCode, msg, { causeError: err });
  }
}
