/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T5: PayPal Authorization Operations
 *
 * Implements:
 * - Authorization capture (POST /v2/payments/authorizations/{authorization_id}/capture)
 * - Authorization void (POST /v2/payments/authorizations/{authorization_id}/void)
 * - Authorization retrieval (GET /v2/payments/authorizations/{authorization_id})
 * - Strict status semantics (PENDING is explicitly non-capturable)
 * - Operation-specific idempotency keys following canonical request_id + step:
 *     payguard-capture-${requestId} and payguard-void-${requestId}
 * - HTTP 204 No Content handling (data: null per PayPalHttpClient contract)
 * - Typed AuthorizationError with debugId preservation and secret redaction
 * - Integer minor units conversion boundary using formatMinorUnitsToDecimal & parseDecimalToMinorUnits
 *
 * Security & Invariants:
 * - Hard Rule 1: Sandbox only. Production refused unless ALLOW_PRODUCTION=true.
 * - Hard Rule 2 & I7: Never log or expose credentials, access tokens, or full token IDs.
 * - Hard Rule 5: Money is integer minor units; converted to decimal strings only at PayPal boundary.
 * - Hard Rule 8: Fail closed on malformed responses, unexpected statuses, or missing request IDs.
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

export type AuthorizationStatus =
  | 'CREATED'
  | 'CAPTURED'
  | 'PARTIALLY_CAPTURED'
  | 'DENIED'
  | 'EXPIRED'
  | 'VOIDED'
  | 'PENDING';

export interface CaptureAuthorizationParams {
  readonly authorizationId: string;
  readonly requestId: string;
  readonly amountMinor?: MinorUnits | number;
  readonly currency?: string;
  readonly finalCapture?: boolean;
  readonly noteToPayer?: string;
  readonly invoiceId?: string;
  readonly connectorKey?: string;
  readonly idempotencyKey?: string;
}

export interface VoidAuthorizationParams {
  readonly authorizationId: string;
  readonly requestId: string;
  readonly connectorKey?: string;
  readonly idempotencyKey?: string;
}

export interface PayPalCaptureResult {
  readonly id: string;
  readonly status: string;
  readonly isCaptured: boolean;
  readonly amountMinor: MinorUnits;
  readonly currency: string;
  readonly finalCapture: boolean;
  readonly createTime?: string;
  readonly updateTime?: string;
  readonly links?: readonly { href: string; rel: string; method?: string }[];
}

export interface PayPalVoidResult {
  readonly id: string;
  readonly status: string;
  readonly isVoided: boolean;
  readonly links?: readonly { href: string; rel: string; method?: string }[];
}

export interface PayPalAuthorizationDetails {
  readonly id: string;
  readonly status: AuthorizationStatus;
  readonly amountMinor: MinorUnits;
  readonly currency: string;
  readonly isCapturable: boolean;
  readonly isVoidable: boolean;
  readonly isCaptured: boolean;
  readonly isPartiallyCaptured: boolean;
  readonly isVoided: boolean;
  readonly isExpired: boolean;
  readonly isDenied: boolean;
  readonly isPending: boolean;
  readonly statusDetailsReason?: string;
  readonly expirationTime?: string;
  readonly captureUrl?: string;
  readonly voidUrl?: string;
  readonly reauthorizeUrl?: string;
  readonly links?: readonly { href: string; rel: string; method?: string }[];
}

export interface PayPalAuthorizationsServiceOptions {
  readonly client: PayPalHttpClient;
  readonly defaultConnectorKey?: string;
}

// ============================================================================
// Error Class
// ============================================================================

export class AuthorizationError extends Error {
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
    this.name = 'AuthorizationError';
    this.code = code;
    this.debugId = options?.debugId;
    this.causeError = options?.causeError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// PayPal Authorizations Service
// ============================================================================

export class PayPalAuthorizationsService {
  private readonly client: PayPalHttpClient;
  private readonly defaultConnectorKey: string;

  constructor(options: PayPalAuthorizationsServiceOptions) {
    this.client = options.client;
    this.defaultConnectorKey = options.defaultConnectorKey ?? 'acme_cloud';
  }

  /**
   * Captures an authorized payment (POST /v2/payments/authorizations/{authorization_id}/capture).
   *
   * @param params - Capture parameters including authorizationId, requestId, optional amount, and idempotency override
   * @returns PayPalCaptureResult with parsed capture details
   */
  public async captureAuthorization(
    params: CaptureAuthorizationParams
  ): Promise<PayPalCaptureResult> {
    const authId = params.authorizationId?.trim();
    if (!authId) {
      throw new AuthorizationError('INVALID_PARAMETER', 'authorizationId must be a non-empty string');
    }

    const requestId = params.requestId?.trim();
    const callerKey = params.idempotencyKey?.trim();

    if (!requestId && !callerKey) {
      throw new AuthorizationError(
        'INVALID_PARAMETER',
        'requestId must be a non-empty string to derive an idempotency key, or idempotencyKey must be explicitly provided'
      );
    }

    // Stable idempotency key: caller-supplied key overrides derived canonical key (request_id + step)
    const idempotencyKey = callerKey || `payguard-capture-${requestId}`;
    const connectorKey = params.connectorKey ?? this.defaultConnectorKey;

    let payload: Record<string, unknown> = {
      final_capture: params.finalCapture ?? true,
    };

    let expectedAmountMinor: MinorUnits | undefined;
    let expectedCurrency: string | undefined;

    if (params.amountMinor !== undefined || params.currency !== undefined) {
      if (params.amountMinor === undefined || params.currency === undefined) {
        throw new AuthorizationError(
          'INVALID_PARAMETER',
          'Both amountMinor and currency must be provided when capturing a specific amount'
        );
      }
      expectedCurrency = validateCurrency(params.currency);
      expectedAmountMinor = toMinorUnits(params.amountMinor);
      const decimalValue = formatMinorUnitsToDecimal(expectedAmountMinor);

      payload = {
        ...payload,
        amount: {
          currency_code: expectedCurrency,
          value: decimalValue,
        },
      };
    }

    if (params.noteToPayer?.trim()) {
      payload.note_to_payer = params.noteToPayer.trim();
    }
    if (params.invoiceId?.trim()) {
      payload.invoice_id = params.invoiceId.trim();
    }

    const encodedAuthId = encodeURIComponent(authId);

    try {
      const response = await this.client.post<Record<string, unknown>>(
        `/v2/payments/authorizations/${encodedAuthId}/capture`,
        payload,
        {
          connectorKey,
          idempotencyKey,
          headers: {
            Prefer: 'return=representation',
          },
        }
      );

      return this.parseCaptureResponse(response.data, response.debugId, {
        expectedAmountMinor,
        expectedCurrency,
      });
    } catch (err) {
      this.handleError(err, 'CAPTURE_FAILED', `Failed to capture authorization '${authId}'`);
    }
  }

  /**
   * Voids an authorized payment (POST /v2/payments/authorizations/{authorization_id}/void).
   *
   * @param params - Void parameters including authorizationId, requestId, and optional connectorKey
   * @returns PayPalVoidResult with void status verification
   */
  public async voidAuthorization(
    params: VoidAuthorizationParams
  ): Promise<PayPalVoidResult> {
    const authId = params.authorizationId?.trim();
    if (!authId) {
      throw new AuthorizationError('INVALID_PARAMETER', 'authorizationId must be a non-empty string');
    }

    const requestId = params.requestId?.trim();
    const callerKey = params.idempotencyKey?.trim();

    if (!requestId && !callerKey) {
      throw new AuthorizationError(
        'INVALID_PARAMETER',
        'requestId must be a non-empty string to derive an idempotency key, or idempotencyKey must be explicitly provided'
      );
    }

    // Stable idempotency key: caller-supplied key overrides derived canonical key (request_id + step)
    const idempotencyKey = callerKey || `payguard-void-${requestId}`;
    const connectorKey = params.connectorKey ?? this.defaultConnectorKey;
    const encodedAuthId = encodeURIComponent(authId);

    try {
      const response = await this.client.post<Record<string, unknown> | null>(
        `/v2/payments/authorizations/${encodedAuthId}/void`,
        {},
        {
          connectorKey,
          idempotencyKey,
          headers: {
            Prefer: 'return=representation',
          },
        }
      );

      // Handle HTTP 204 No Content (data === null per PayPalHttpClient contract)
      if (response.status === 204) {
        return {
          id: authId,
          status: 'VOIDED',
          isVoided: true,
        };
      }

      // Handle HTTP 200 OK with representation
      if (response.status === 200 && response.data && typeof response.data === 'object') {
        const obj = response.data;
        const status = typeof obj.status === 'string' ? obj.status.trim() : undefined;

        if (status !== 'VOIDED') {
          throw new AuthorizationError(
            'VOID_FAILED',
            `Void request returned HTTP 200 but status was '${String(status)}', expected 'VOIDED'`,
            { debugId: response.debugId }
          );
        }

        const returnedId = typeof obj.id === 'string' ? obj.id.trim() : authId;
        return {
          id: returnedId,
          status: 'VOIDED',
          isVoided: true,
          links: this.extractLinks(obj.links),
        };
      }

      // Any unexpected 2xx status or malformed response fails closed
      throw new AuthorizationError(
        'VOID_FAILED',
        `Unexpected response status ${response.status} for authorization void`,
        { debugId: response.debugId }
      );
    } catch (err) {
      this.handleError(err, 'VOID_FAILED', `Failed to void authorization '${authId}'`);
    }
  }

  /**
   * Retrieves authorization details (GET /v2/payments/authorizations/{authorization_id}).
   *
   * @param authorizationId - The PayPal authorization ID
   * @param options - Optional connectorKey override
   * @returns PayPalAuthorizationDetails with parsed status flags and links
   */
  public async getAuthorization(
    authorizationId: string,
    options?: { connectorKey?: string }
  ): Promise<PayPalAuthorizationDetails> {
    const authId = authorizationId?.trim();
    if (!authId) {
      throw new AuthorizationError('INVALID_PARAMETER', 'authorizationId must be a non-empty string');
    }

    const connectorKey = options?.connectorKey ?? this.defaultConnectorKey;
    const encodedAuthId = encodeURIComponent(authId);

    try {
      const response = await this.client.get<Record<string, unknown>>(
        `/v2/payments/authorizations/${encodedAuthId}`,
        { connectorKey }
      );

      return this.parseAuthorizationDetails(response.data, response.debugId);
    } catch (err) {
      this.handleError(err, 'GET_AUTHORIZATION_FAILED', `Failed to retrieve authorization '${authId}'`);
    }
  }

  // ============================================================================
  // Response Parsers & Validators
  // ============================================================================

  private parseCaptureResponse(
    data: unknown,
    debugId?: string,
    expectations?: {
      readonly expectedAmountMinor?: MinorUnits;
      readonly expectedCurrency?: string;
    }
  ): PayPalCaptureResult {
    if (!data || typeof data !== 'object') {
      throw new AuthorizationError(
        'INVALID_CAPTURE_RESPONSE',
        'Capture response is empty or not an object',
        { debugId }
      );
    }

    const obj = data as Record<string, unknown>;

    // 1. Capture ID
    const id = typeof obj.id === 'string' ? obj.id.trim() : undefined;
    if (!id || id.length === 0) {
      throw new AuthorizationError(
        'INVALID_CAPTURE_RESPONSE',
        'Capture response missing id',
        { debugId }
      );
    }

    // 2. Capture Status
    const status = typeof obj.status === 'string' ? obj.status.trim() : undefined;
    if (!status || status.length === 0) {
      throw new AuthorizationError(
        'INVALID_CAPTURE_RESPONSE',
        'Capture response missing status',
        { debugId }
      );
    }

    // 3. Amount & Currency
    const amountObj = typeof obj.amount === 'object' && obj.amount !== null
      ? (obj.amount as Record<string, unknown>)
      : undefined;

    const currencyRaw = typeof amountObj?.currency_code === 'string' ? amountObj.currency_code : undefined;
    const valueRaw = typeof amountObj?.value === 'string' ? amountObj.value : undefined;

    if (!currencyRaw || !valueRaw) {
      throw new AuthorizationError(
        'INVALID_CAPTURE_RESPONSE',
        'Capture response missing amount or currency',
        { debugId }
      );
    }

    const returnedCurrency = validateCurrency(currencyRaw);
    const returnedAmountMinor = parseDecimalToMinorUnits(valueRaw);

    if (expectations?.expectedCurrency && returnedCurrency !== expectations.expectedCurrency) {
      throw new AuthorizationError(
        'CURRENCY_MISMATCH',
        `Returned capture currency '${returnedCurrency}' does not match expected '${expectations.expectedCurrency}'`,
        { debugId }
      );
    }

    if (
      expectations?.expectedAmountMinor !== undefined &&
      returnedAmountMinor !== expectations.expectedAmountMinor
    ) {
      throw new AuthorizationError(
        'AMOUNT_MISMATCH',
        `Returned capture amount (${returnedAmountMinor} minor units) does not match expected (${expectations.expectedAmountMinor} minor units)`,
        { debugId }
      );
    }

    // 4. Strict isCaptured semantics: must be COMPLETED
    const isCaptured = status === 'COMPLETED';

    const finalCapture = typeof obj.final_capture === 'boolean' ? obj.final_capture : true;
    const createTime = typeof obj.create_time === 'string' ? obj.create_time : undefined;
    const updateTime = typeof obj.update_time === 'string' ? obj.update_time : undefined;

    return {
      id,
      status,
      isCaptured,
      amountMinor: returnedAmountMinor,
      currency: returnedCurrency,
      finalCapture,
      createTime,
      updateTime,
      links: this.extractLinks(obj.links),
    };
  }

  private parseAuthorizationDetails(
    data: unknown,
    debugId?: string
  ): PayPalAuthorizationDetails {
    if (!data || typeof data !== 'object') {
      throw new AuthorizationError(
        'INVALID_AUTHORIZATION_RESPONSE',
        'Authorization response is empty or not an object',
        { debugId }
      );
    }

    const obj = data as Record<string, unknown>;

    // 1. Authorization ID
    const id = typeof obj.id === 'string' ? obj.id.trim() : undefined;
    if (!id || id.length === 0) {
      throw new AuthorizationError(
        'INVALID_AUTHORIZATION_RESPONSE',
        'Authorization response missing id',
        { debugId }
      );
    }

    // 2. Authorization Status
    const rawStatus = typeof obj.status === 'string' ? obj.status.trim() : undefined;
    if (!rawStatus || rawStatus.length === 0) {
      throw new AuthorizationError(
        'INVALID_AUTHORIZATION_RESPONSE',
        'Authorization response missing status',
        { debugId }
      );
    }

    const validStatuses: readonly string[] = [
      'CREATED',
      'CAPTURED',
      'PARTIALLY_CAPTURED',
      'DENIED',
      'EXPIRED',
      'VOIDED',
      'PENDING',
    ];

    if (!validStatuses.includes(rawStatus)) {
      throw new AuthorizationError(
        'INVALID_AUTHORIZATION_RESPONSE',
        `Authorization response contains unrecognized status '${rawStatus}'`,
        { debugId }
      );
    }

    const status = rawStatus as AuthorizationStatus;

    // 3. Amount & Currency
    const amountObj = typeof obj.amount === 'object' && obj.amount !== null
      ? (obj.amount as Record<string, unknown>)
      : undefined;

    const currencyRaw = typeof amountObj?.currency_code === 'string' ? amountObj.currency_code : undefined;
    const valueRaw = typeof amountObj?.value === 'string' ? amountObj.value : undefined;

    if (!currencyRaw || !valueRaw) {
      throw new AuthorizationError(
        'INVALID_AUTHORIZATION_RESPONSE',
        'Authorization response missing amount or currency',
        { debugId }
      );
    }

    const amountMinor = parseDecimalToMinorUnits(valueRaw);
    const currency = validateCurrency(currencyRaw);

    // 4. Strict status flags
    // INVARIANT: PENDING is NOT capturable. Funds are held in manual/risk review.
    const isCapturable = status === 'CREATED';
    const isVoidable = status === 'CREATED' || status === 'PENDING';
    const isCaptured = status === 'CAPTURED';
    const isPartiallyCaptured = status === 'PARTIALLY_CAPTURED';
    const isVoided = status === 'VOIDED';
    const isExpired = status === 'EXPIRED';
    const isDenied = status === 'DENIED';
    const isPending = status === 'PENDING';

    // 5. Status Details Reason
    const statusDetailsObj = typeof obj.status_details === 'object' && obj.status_details !== null
      ? (obj.status_details as Record<string, unknown>)
      : undefined;
    const statusDetailsReason = typeof statusDetailsObj?.reason === 'string'
      ? statusDetailsObj.reason
      : undefined;

    // 6. Action Links
    const links = this.extractLinks(obj.links);
    let captureUrl: string | undefined;
    let voidUrl: string | undefined;
    let reauthorizeUrl: string | undefined;

    for (const l of links) {
      if (l.rel === 'capture') {
        captureUrl = l.href;
      } else if (l.rel === 'void') {
        voidUrl = l.href;
      } else if (l.rel === 'reauthorize') {
        reauthorizeUrl = l.href;
      }
    }

    const expirationTime = typeof obj.expiration_time === 'string' ? obj.expiration_time : undefined;

    return {
      id,
      status,
      amountMinor,
      currency,
      isCapturable,
      isVoidable,
      isCaptured,
      isPartiallyCaptured,
      isVoided,
      isExpired,
      isDenied,
      isPending,
      statusDetailsReason,
      expirationTime,
      captureUrl,
      voidUrl,
      reauthorizeUrl,
      links,
    };
  }

  private extractLinks(rawLinks: unknown): readonly { href: string; rel: string; method?: string }[] {
    const result: Array<{ href: string; rel: string; method?: string }> = [];
    if (Array.isArray(rawLinks)) {
      for (const l of rawLinks) {
        if (typeof l === 'object' && l !== null) {
          const lo = l as Record<string, unknown>;
          if (typeof lo.href === 'string' && typeof lo.rel === 'string') {
            result.push({
              href: lo.href,
              rel: lo.rel,
              method: typeof lo.method === 'string' ? lo.method : undefined,
            });
          }
        }
      }
    }
    return result;
  }

  private handleError(err: unknown, defaultCode: string, defaultMessage: string): never {
    if (err instanceof AuthorizationError) {
      throw err;
    }
    if (err instanceof PayPalHttpError) {
      throw new AuthorizationError(err.code, err.message, {
        debugId: err.debugId,
        causeError: err,
      });
    }
    const msg = err instanceof Error ? err.message : defaultMessage;
    throw new AuthorizationError(defaultCode, msg, { causeError: err });
  }
}
