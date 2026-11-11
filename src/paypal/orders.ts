/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T4: PayPal Orders API Wrapper
 *
 * Implements:
 * - Orders v2 creation with CAPTURE and AUTHORIZE intents (POST /v2/checkout/orders, Prefer: return=representation)
 * - Order retrieval (GET /v2/checkout/orders/{id})
 * - Vaulted payment token integration via canonical payment_source.paypal.vault_id
 * - purchase_units[0].custom_id mapped to internal requestId (with payment-level recovery on reduced responses)
 * - Strict money conversion boundary using formatMinorUnitsToDecimal & parseDecimalToMinorUnits
 * - Returned amount and currency validation (fails on mismatch)
 * - Strict isCaptured & isAuthorized semantics derived from actual payment objects, never solely order status
 * - Stable caller-supplied idempotency key (or deterministic payguard-order-${requestId})
 * - Safe OrderError mapping with debug_id + sanitized orderId preservation and secret/token redaction
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

function sanitizeOrderId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export class OrderError extends Error {
  public readonly code: string;
  public readonly debugId?: string;
  public readonly orderId?: string;
  public readonly causeError?: unknown;

  constructor(
    code: string,
    message: string,
    options?: { debugId?: string; orderId?: string; causeError?: unknown }
  ) {
    const debugSuffix = options?.debugId ? ` (debug_id: ${options.debugId})` : '';
    super(`[${code}] ${message}${debugSuffix}`);
    this.name = 'OrderError';
    this.code = code;
    this.debugId = options?.debugId;
    this.orderId = sanitizeOrderId(options?.orderId);
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
          headers: {
            Prefer: 'return=representation',
          },
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

  private parseMoneyPair(
    amountObj: unknown,
    debugId: string | undefined,
    orderId: string,
    contextLabel: string
  ): { currency: string; amountMinor: MinorUnits } {
    if (!amountObj || typeof amountObj !== 'object' || Array.isArray(amountObj)) {
      throw new OrderError('INVALID_ORDER_RESPONSE', `${contextLabel} missing amount or currency`, {
        debugId,
        orderId,
      });
    }

    const rec = amountObj as Record<string, unknown>;
    const currencyRaw = typeof rec.currency_code === 'string' ? rec.currency_code : undefined;
    const valueRaw = typeof rec.value === 'string' ? rec.value : undefined;

    if (!currencyRaw || !valueRaw) {
      throw new OrderError('INVALID_ORDER_RESPONSE', `${contextLabel} missing amount or currency`, {
        debugId,
        orderId,
      });
    }

    try {
      const currency = validateCurrency(currencyRaw);
      const amountMinor = parseDecimalToMinorUnits(valueRaw);
      return { currency, amountMinor };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new OrderError(
        'INVALID_ORDER_RESPONSE',
        `${contextLabel} invalid amount or currency: ${msg}`,
        { debugId, orderId, causeError: err }
      );
    }
  }

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
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response is empty or not an object', { debugId });
    }

    const obj = data as Record<string, unknown>;

    // 1. Validate required order ID and sanitize immediately so subsequent failures preserve it
    const rawId = typeof obj.id === 'string' ? obj.id.trim() : undefined;
    if (!rawId || rawId.length === 0) {
      throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response missing id', { debugId });
    }
    const orderId = sanitizeOrderId(rawId);
    if (!orderId) {
      throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response contains invalid id', { debugId });
    }

    try {
      // 2. Validate order status
      const status = typeof obj.status === 'string' ? obj.status.trim() : undefined;
      if (!status || status.length === 0) {
        throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response missing status', { debugId, orderId });
      }

      // 3. Validate explicit intent first if present
      let explicitIntent: OrderIntent | undefined;
      if (obj.intent !== undefined) {
        const intentRaw = typeof obj.intent === 'string' ? obj.intent.trim() : undefined;
        if (intentRaw !== 'CAPTURE' && intentRaw !== 'AUTHORIZE') {
          throw new OrderError(
            'INVALID_ORDER_RESPONSE',
            `Order response contains invalid intent '${String(intentRaw)}'`,
            { debugId, orderId }
          );
        }
        explicitIntent = intentRaw;

        if (expectations?.expectedIntent && explicitIntent !== expectations.expectedIntent) {
          throw new OrderError(
            'INTENT_MISMATCH',
            `Returned order intent '${explicitIntent}' does not match requested intent '${expectations.expectedIntent}'`,
            { debugId, orderId }
          );
        }
      }

      // 4. Validate purchase_units
      const purchaseUnits = Array.isArray(obj.purchase_units) ? obj.purchase_units : [];
      if (purchaseUnits.length > 1) {
        throw new OrderError(
          'INVALID_ORDER_RESPONSE',
          'Order response contains multiple purchase_units',
          { debugId, orderId }
        );
      }
      if (
        purchaseUnits.length === 0 ||
        typeof purchaseUnits[0] !== 'object' ||
        purchaseUnits[0] === null ||
        Array.isArray(purchaseUnits[0])
      ) {
        throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response missing purchase_units', {
          debugId,
          orderId,
        });
      }

      const pu = purchaseUnits[0] as Record<string, unknown>;
      const payments =
        typeof pu.payments === 'object' && pu.payments !== null && !Array.isArray(pu.payments)
          ? (pu.payments as Record<string, unknown>)
          : undefined;
      const rawAuthorizations = Array.isArray(payments?.authorizations) ? payments.authorizations : [];
      const rawCaptures = Array.isArray(payments?.captures) ? payments.captures : [];
      if (rawAuthorizations.length > 1) {
        throw new OrderError(
          'INVALID_ORDER_RESPONSE',
          'Order response contains multiple authorizations',
          { debugId, orderId }
        );
      }
      if (rawCaptures.length > 1) {
        throw new OrderError(
          'INVALID_ORDER_RESPONSE',
          'Order response contains multiple captures',
          { debugId, orderId }
        );
      }
      const hasAuthorizations = rawAuthorizations.length > 0;
      const hasCaptures = rawCaptures.length > 0;

      // Guard against mismatched payment structures relative to expectedIntent (especially createOrder)
      if (expectations?.expectedIntent === 'CAPTURE' && hasAuthorizations) {
        if (hasCaptures) {
          throw new OrderError(
            'INVALID_ORDER_RESPONSE',
            'CAPTURE order response contains both captures and authorizations',
            { debugId, orderId }
          );
        }
        throw new OrderError(
          'INTENT_MISMATCH',
          'Expected CAPTURE order structure, but response contained authorizations',
          { debugId, orderId }
        );
      }

      if (expectations?.expectedIntent === 'AUTHORIZE' && hasCaptures) {
        if (hasAuthorizations) {
          throw new OrderError(
            'INVALID_ORDER_RESPONSE',
            'AUTHORIZE order response contains both authorizations and captures',
            { debugId, orderId }
          );
        }
        throw new OrderError(
          'INTENT_MISMATCH',
          'Expected AUTHORIZE order structure, but response contained captures',
          { debugId, orderId }
        );
      }

      // Resolve intent: only infer when top-level intent is omitted AND expectedIntent matches payment structure
      let intent: OrderIntent;
      if (explicitIntent) {
        intent = explicitIntent;
      } else {
        if (!expectations?.expectedIntent) {
          throw new OrderError(
            'INVALID_ORDER_RESPONSE',
            "Order response contains invalid intent 'undefined'",
            { debugId, orderId }
          );
        }

        if (expectations.expectedIntent === 'CAPTURE') {
          if (!hasCaptures) {
            throw new OrderError(
              'INVALID_ORDER_RESPONSE',
              "Order response missing intent 'undefined' without matching captures structure",
              { debugId, orderId }
            );
          }
          intent = 'CAPTURE';
        } else {
          if (!hasAuthorizations) {
            throw new OrderError(
              'INVALID_ORDER_RESPONSE',
              "Order response missing intent 'undefined' without matching authorizations structure",
              { debugId, orderId }
            );
          }
          intent = 'AUTHORIZE';
        }
      }

      // 5. Extract Payments (authorizations & captures) first so reduced responses can recover amount/custom_id
      let authorization: (AuthorizationSummary & { customId?: string }) | undefined;
      let capture: (CaptureSummary & { customId?: string }) | undefined;

      if (hasAuthorizations) {
        const authRaw = rawAuthorizations[0];
        if (!authRaw || typeof authRaw !== 'object' || Array.isArray(authRaw)) {
          throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response authorization entry is malformed', {
            debugId,
            orderId,
          });
        }
        const authRec = authRaw as Record<string, unknown>;
        const authId = typeof authRec.id === 'string' ? authRec.id.trim() : undefined;
        const authStatus = typeof authRec.status === 'string' ? authRec.status.trim() : undefined;
        if (!authId || !authStatus) {
          throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response authorization missing id or status', {
            debugId,
            orderId,
          });
        }

        const { currency: authCurrency, amountMinor: authMinor } = this.parseMoneyPair(
          authRec.amount,
          debugId,
          orderId,
          'Order response authorization'
        );

        let authCustomId: string | undefined;
        if (authRec.custom_id !== undefined) {
          if (typeof authRec.custom_id !== 'string') {
            throw new OrderError('CUSTOM_ID_MISMATCH', 'Order response authorization custom_id is not a string', {
              debugId,
              orderId,
            });
          }
          authCustomId = authRec.custom_id;
        }

        let captureUrl: string | undefined;
        let voidUrl: string | undefined;
        if (Array.isArray(authRec.links)) {
          for (const l of authRec.links) {
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
          expirationTime: typeof authRec.expiration_time === 'string' ? authRec.expiration_time : undefined,
          captureUrl,
          voidUrl,
          customId: authCustomId,
        };
      }

      if (hasCaptures) {
        const capRaw = rawCaptures[0];
        if (!capRaw || typeof capRaw !== 'object' || Array.isArray(capRaw)) {
          throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response capture entry is malformed', {
            debugId,
            orderId,
          });
        }
        const capRec = capRaw as Record<string, unknown>;
        const capId = typeof capRec.id === 'string' ? capRec.id.trim() : undefined;
        const capStatus = typeof capRec.status === 'string' ? capRec.status.trim() : undefined;
        if (!capId || !capStatus) {
          throw new OrderError('INVALID_ORDER_RESPONSE', 'Order response capture missing id or status', {
            debugId,
            orderId,
          });
        }

        const { currency: capCurrency, amountMinor: capMinor } = this.parseMoneyPair(
          capRec.amount,
          debugId,
          orderId,
          'Order response capture'
        );

        let capCustomId: string | undefined;
        if (capRec.custom_id !== undefined) {
          if (typeof capRec.custom_id !== 'string') {
            throw new OrderError('CUSTOM_ID_MISMATCH', 'Order response capture custom_id is not a string', {
              debugId,
              orderId,
            });
          }
          capCustomId = capRec.custom_id;
        }

        capture = {
          id: capId,
          status: capStatus,
          amountMinor: capMinor,
          currency: capCurrency,
          customId: capCustomId,
        };
      }

      // 6. Validate / recover custom_id from matching payment object when omitted at purchase_unit level
      if (pu.custom_id !== undefined && typeof pu.custom_id !== 'string') {
        throw new OrderError('CUSTOM_ID_MISMATCH', 'Order response purchase_unit custom_id is not a string', {
          debugId,
          orderId,
        });
      }
      const puCustomId = typeof pu.custom_id === 'string' ? pu.custom_id : undefined;
      const matchingPaymentCustomId = intent === 'CAPTURE' ? capture?.customId : authorization?.customId;

      if (puCustomId !== undefined && matchingPaymentCustomId !== undefined && puCustomId !== matchingPaymentCustomId) {
        throw new OrderError(
          'CUSTOM_ID_MISMATCH',
          `Purchase unit custom_id '${puCustomId}' conflicts with payment custom_id '${matchingPaymentCustomId}'`,
          { debugId, orderId }
        );
      }

      const customId = puCustomId ?? matchingPaymentCustomId;

      if (expectations?.expectedRequestId && customId !== expectations.expectedRequestId) {
        throw new OrderError(
          'CUSTOM_ID_MISMATCH',
          `Returned custom_id '${String(customId)}' does not match requested requestId '${expectations.expectedRequestId}'`,
          { debugId, orderId }
        );
      }

      // 7. Validate / recover amount & currency (from pu.amount, else matching payment summary)
      let returnedCurrency: string;
      let returnedAmountMinor: MinorUnits;

      if (pu.amount !== undefined) {
        ({ currency: returnedCurrency, amountMinor: returnedAmountMinor } = this.parseMoneyPair(
          pu.amount,
          debugId,
          orderId,
          'Order response purchase_unit'
        ));
      } else {
        const matchingPayment = intent === 'CAPTURE' ? capture : authorization;
        if (!matchingPayment) {
          throw new OrderError(
            'INVALID_ORDER_RESPONSE',
            'Order response purchase_unit missing amount or currency',
            { debugId, orderId }
          );
        }
        returnedCurrency = matchingPayment.currency;
        returnedAmountMinor = matchingPayment.amountMinor;
      }

      if (expectations?.expectedCurrency && returnedCurrency !== expectations.expectedCurrency) {
        throw new OrderError(
          'CURRENCY_MISMATCH',
          `Returned currency '${returnedCurrency}' does not match expected '${expectations.expectedCurrency}'`,
          { debugId, orderId }
        );
      }

      if (expectations?.expectedAmountMinor !== undefined && returnedAmountMinor !== expectations.expectedAmountMinor) {
        throw new OrderError(
          'AMOUNT_MISMATCH',
          `Returned amount (${returnedAmountMinor} minor units) does not match expected (${expectations.expectedAmountMinor} minor units)`,
          { debugId, orderId }
        );
      }

      // 8. Validate payment object monetary values against order values & expectations
      if (authorization) {
        if (authorization.currency !== returnedCurrency) {
          throw new OrderError(
            'AUTHORIZATION_CURRENCY_MISMATCH',
            `Authorization currency '${authorization.currency}' does not match order currency '${returnedCurrency}'`,
            { debugId, orderId }
          );
        }
        if (expectations?.expectedCurrency && authorization.currency !== expectations.expectedCurrency) {
          throw new OrderError(
            'AUTHORIZATION_CURRENCY_MISMATCH',
            `Authorization currency '${authorization.currency}' does not match expected '${expectations.expectedCurrency}'`,
            { debugId, orderId }
          );
        }
        if (expectations?.expectedAmountMinor !== undefined && authorization.amountMinor !== expectations.expectedAmountMinor) {
          throw new OrderError(
            'AUTHORIZATION_AMOUNT_MISMATCH',
            `Authorization amount (${authorization.amountMinor}) does not match expected (${expectations.expectedAmountMinor})`,
            { debugId, orderId }
          );
        }
        if (authorization.amountMinor !== returnedAmountMinor) {
          throw new OrderError(
            'AUTHORIZATION_AMOUNT_MISMATCH',
            `Authorization amount (${authorization.amountMinor}) does not match order amount (${returnedAmountMinor})`,
            { debugId, orderId }
          );
        }
      }

      if (capture) {
        if (capture.currency !== returnedCurrency) {
          throw new OrderError(
            'CAPTURE_CURRENCY_MISMATCH',
            `Capture currency '${capture.currency}' does not match order currency '${returnedCurrency}'`,
            { debugId, orderId }
          );
        }
        if (expectations?.expectedCurrency && capture.currency !== expectations.expectedCurrency) {
          throw new OrderError(
            'CAPTURE_CURRENCY_MISMATCH',
            `Capture currency '${capture.currency}' does not match expected '${expectations.expectedCurrency}'`,
            { debugId, orderId }
          );
        }
        if (expectations?.expectedAmountMinor !== undefined && capture.amountMinor !== expectations.expectedAmountMinor) {
          throw new OrderError(
            'CAPTURE_AMOUNT_MISMATCH',
            `Capture amount (${capture.amountMinor}) does not match expected (${expectations.expectedAmountMinor})`,
            { debugId, orderId }
          );
        }
        if (capture.amountMinor !== returnedAmountMinor) {
          throw new OrderError(
            'CAPTURE_AMOUNT_MISMATCH',
            `Capture amount (${capture.amountMinor}) does not match order amount (${returnedAmountMinor})`,
            { debugId, orderId }
          );
        }
      }

      const publicAuthorization: AuthorizationSummary | undefined = authorization
        ? {
            id: authorization.id,
            status: authorization.status,
            amountMinor: authorization.amountMinor,
            currency: authorization.currency,
            expirationTime: authorization.expirationTime,
            captureUrl: authorization.captureUrl,
            voidUrl: authorization.voidUrl,
          }
        : undefined;

      const publicCapture: CaptureSummary | undefined = capture
        ? {
            id: capture.id,
            status: capture.status,
            amountMinor: capture.amountMinor,
            currency: capture.currency,
          }
        : undefined;

      // 9. Explicit Invariant: isCaptured & isAuthorized derived strictly from payment object statuses
      // Never infer capture or authorization solely from order status (an AUTHORIZE order returns status COMPLETED!)
      const isAuthorized = Boolean(
        publicAuthorization && (publicAuthorization.status === 'CREATED' || publicAuthorization.status === 'PENDING')
      );
      const isCaptured = Boolean(
        intent === 'CAPTURE' && publicCapture && publicCapture.status === 'COMPLETED'
      );

      // 10. Extract Links
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
        id: orderId,
        status,
        intent,
        customId,
        amountMinor: returnedAmountMinor,
        currency: returnedCurrency,
        authorization: publicAuthorization,
        capture: publicCapture,
        isCaptured,
        isAuthorized,
        links,
      };
    } catch (err) {
      if (err instanceof OrderError) {
        if (!err.orderId) {
          throw new OrderError(err.code, err.message, {
            debugId: err.debugId ?? debugId,
            orderId,
            causeError: err.causeError,
          });
        }
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new OrderError('INVALID_ORDER_RESPONSE', msg, { debugId, orderId, causeError: err });
    }
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
