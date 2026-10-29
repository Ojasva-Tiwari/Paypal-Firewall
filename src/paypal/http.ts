/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T2: PayPal HTTP Request Wrapper
 *
 * Implements:
 * - Authenticated PayPal API client powered by TokenManager
 * - Canonical retry policy (GET max 3, POST max 2 with idempotency header, never retry 4xx)
 * - 401 token invalidation and single retry
 * - PayPal-Request-Id idempotency header support
 * - Safe error mapping into canonical codes (VAULT_INVALID, DECLINED, INVALID_REQUEST, AUTH_EXPIRED, NETWORK, UNKNOWN)
 * - Redaction of access tokens and credentials from logs and errors
 *
 * Security & Invariants:
 * - Hard Rule 1: Sandbox only. Production is strictly refused unless ALLOW_PRODUCTION=true.
 * - Hard Rule 2 & I7: Never log or expose credentials or access tokens.
 * - PLAN.md Section 12.2: Deterministic error mapping with paypal-debug-id preservation.
 */

import type { TokenManager, FetchFunction } from './tokenManager.js';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

// ============================================================================
// Types & Interfaces
// ============================================================================

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export type PayPalErrorCode =
  | 'VAULT_INVALID'
  | 'DECLINED'
  | 'INVALID_REQUEST'
  | 'AUTH_EXPIRED'
  | 'NETWORK'
  | 'UNKNOWN';

export interface PayPalRequestOptions {
  readonly connectorKey?: string;
  readonly idempotencyKey?: string;
  readonly headers?: Record<string, string>;
  readonly params?: Record<string, string | number | boolean | undefined>;
}

export interface PayPalResponse<T = unknown> {
  readonly status: number;
  readonly data: T;
  readonly headers: Headers;
  readonly debugId?: string;
}

export interface PayPalHttpClientOptions {
  /**
   * Base URL for the PayPal API (e.g. 'https://api-m.sandbox.paypal.com').
   * Defaults to 'https://api-m.sandbox.paypal.com'.
   */
  readonly baseUrl?: string;
  /**
   * TokenManager instance responsible for OAuth token acquisition and caching.
   */
  readonly tokenManager: TokenManager;
  /**
   * Injectable fetch function (defaults to globalThis.fetch).
   */
  readonly fetchFn?: FetchFunction;
  /**
   * Default connector key to use when none is specified in request options.
   * Defaults to 'acme_cloud'.
   */
  readonly defaultConnectorKey?: string;
  /**
   * Custom delay calculation for retries in milliseconds.
   * Set to `() => 0` in unit tests for zero delay.
   */
  readonly getRetryDelayMs?: (attempt: number) => number;
}

// ============================================================================
// Error Class (Redacted & Typed)
// ============================================================================

export interface PayPalHttpErrorParams {
  readonly message: string;
  readonly code: PayPalErrorCode;
  readonly status?: number;
  readonly debugId?: string;
  readonly issue?: string;
  readonly rawDetails?: unknown;
}

export class PayPalHttpError extends Error {
  public readonly code: PayPalErrorCode;
  public readonly status?: number;
  public readonly debugId?: string;
  public readonly issue?: string;
  public readonly rawDetails?: unknown;

  constructor(params: PayPalHttpErrorParams) {
    const debugSuffix = params.debugId ? ` (debug_id: ${params.debugId})` : '';
    super(`[${params.code}] ${params.message}${debugSuffix}`);
    this.name = 'PayPalHttpError';
    this.code = params.code;
    this.status = params.status;
    this.debugId = params.debugId;
    this.issue = params.issue;
    this.rawDetails = params.rawDetails;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// Error Mapping Logic (PLAN.md Section 12.2 line 530)
// ============================================================================

/**
 * Maps PayPal HTTP status codes and error responses to canonical error categories:
 * VAULT_INVALID, DECLINED, INVALID_REQUEST, AUTH_EXPIRED, NETWORK, UNKNOWN.
 */
export function mapPayPalError(
  status: number | undefined,
  body: unknown,
  _debugId?: string | undefined
): { code: PayPalErrorCode; message: string; issue?: string } {
  if (status === undefined) {
    return {
      code: 'NETWORK',
      message: 'Network error communicating with PayPal API',
    };
  }

  const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;

  // Extract issue and description from details array if present
  let issue: string | undefined;
  let description: string | undefined;
  if (Array.isArray(obj?.details) && obj.details.length > 0) {
    const firstDetail = obj.details[0] as Record<string, unknown> | undefined;
    if (typeof firstDetail?.issue === 'string') {
      issue = firstDetail.issue;
    }
    if (typeof firstDetail?.description === 'string') {
      description = firstDetail.description;
    }
  }

  // Fallback to name or error property
  if (!issue) {
    if (typeof obj?.name === 'string') {
      issue = obj.name;
    } else if (typeof obj?.error === 'string') {
      issue = obj.error;
    }
  }

  const msg =
    description ||
    (typeof obj?.message === 'string' ? obj.message : undefined) ||
    (typeof obj?.error_description === 'string' ? obj.error_description : undefined) ||
    `PayPal HTTP error ${status}`;

  // 1. VAULT_INVALID (PAYER_ACTION_REQUIRED per Section 12.2 line 530)
  if (
    issue === 'PAYER_ACTION_REQUIRED' ||
    issue === 'VAULT_TOKEN_INVALID' ||
    issue === 'INVALID_VAULT_ID' ||
    issue === 'PAYMENT_SOURCE_CANNOT_BE_USED' ||
    issue === 'PAYMENT_SOURCE_INFO_CANNOT_BE_VERIFIED'
  ) {
    return { code: 'VAULT_INVALID', message: msg, issue };
  }

  // 2. DECLINED
  if (
    issue === 'INSTRUMENT_DECLINED' ||
    issue === 'TRANSACTION_REFUSED' ||
    issue === 'PAYER_ACCOUNT_RESTRICTED'
  ) {
    return { code: 'DECLINED', message: msg, issue };
  }

  // 3. AUTH_EXPIRED
  if (
    status === 401 ||
    issue === 'AUTHENTICATION_FAILURE' ||
    issue === 'invalid_token' ||
    issue === 'AUTHORIZATION_EXPIRED' ||
    issue === 'CAPTURE_WINDOW_EXPIRED'
  ) {
    return { code: 'AUTH_EXPIRED', message: msg, issue };
  }

  // 4. INVALID_REQUEST
  if (
    status === 400 ||
    status === 422 ||
    issue === 'MALFORMED_REQUEST' ||
    issue === 'INVALID_REQUEST' ||
    issue === 'INVALID_PARAMETER_VALUE' ||
    issue === 'MISSING_REQUIRED_PARAMETER'
  ) {
    return { code: 'INVALID_REQUEST', message: msg, issue };
  }

  // 5. UNKNOWN (5xx or unclassified)
  return { code: 'UNKNOWN', message: msg, issue };
}

// ============================================================================
// PayPal HTTP Client Class
// ============================================================================

export class PayPalHttpClient {
  private readonly baseUrl: string;
  private readonly tokenManager: TokenManager;
  private readonly fetchFn: FetchFunction;
  private readonly defaultConnectorKey: string;
  private readonly getRetryDelayMs: (attempt: number) => number;

  constructor(options: PayPalHttpClientOptions) {
    const rawBaseUrl = options.baseUrl || SANDBOX_BASE_URL;

    // Safety check: Refuse PayPal production URLs unless explicitly allowed (Hard Rule 1)
    if (
      !rawBaseUrl.includes('sandbox') &&
      process.env.ALLOW_PRODUCTION !== 'true'
    ) {
      throw new Error(
        'Production PayPal URL is strictly refused without ALLOW_PRODUCTION=true'
      );
    }

    this.baseUrl = rawBaseUrl.replace(/\/+$/, '');
    this.tokenManager = options.tokenManager;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.defaultConnectorKey = options.defaultConnectorKey ?? 'acme_cloud';
    this.getRetryDelayMs =
      options.getRetryDelayMs ??
      ((attempt: number) => Math.min(100 * Math.pow(2, attempt - 1), 1000));
  }

  /**
   * Sends an authenticated HTTP request to PayPal with canonical retries and error mapping.
   *
   * Canonical Retry Policy (PLAN.md Section 12.2 line 529):
   * - GETs retry: max 3 attempts total on network error or 5xx with backoff.
   * - POSTs retry: only on network error or 5xx, max 2 attempts total, ONLY when PayPal-Request-Id is present.
   * - Never retry a 4xx (except a single token refresh & retry on 401).
   *
   * @param method - HTTP verb
   * @param path - Relative endpoint path (e.g. '/v2/checkout/orders') or full URL
   * @param body - Optional request payload (will be serialized to JSON)
   * @param options - Request options including idempotencyKey, headers, and params
   */
  public async request<T = unknown>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    options?: PayPalRequestOptions
  ): Promise<PayPalResponse<T>> {
    const connectorKey = options?.connectorKey ?? this.defaultConnectorKey;
    const isGet = method === 'GET';
    const isPost = method === 'POST';
    const hasIdempotencyKey = Boolean(options?.idempotencyKey);

    // Canonical attempt limits:
    // GET: max 3 attempts total
    // POST with idempotency header: max 2 attempts total
    // POST without idempotency header / other methods: max 1 attempt (never retry)
    const maxAttempts = isGet ? 3 : isPost && hasIdempotencyKey ? 2 : 1;

    let attempt = 0;
    let hasRetried401 = false;

    while (attempt < maxAttempts) {
      attempt++;

      // 1. Acquire access token for connector
      const accessToken = await this.tokenManager.getAccessToken(connectorKey);

      // 2. Build headers
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(options?.headers ?? {}),
      };

      let serializedBody: string | undefined;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        serializedBody = typeof body === 'string' ? body : JSON.stringify(body);
      }

      if (options?.idempotencyKey) {
        headers['PayPal-Request-Id'] = options.idempotencyKey;
      }

      const url = this.buildUrl(path, options?.params);

      // 3. Dispatch HTTP request
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method,
          headers,
          body: serializedBody,
        });
      } catch (networkError: unknown) {
        const isLastAttempt = attempt >= maxAttempts;
        if (!isLastAttempt) {
          await this.delay(attempt);
          continue;
        }

        const rawMessage =
          networkError instanceof Error ? networkError.message : 'Network error';
        // Redact any access tokens or sensitive values that may have slipped into network error text
        const safeMessage = rawMessage.replace(accessToken, '[REDACTED]');

        throw new PayPalHttpError({
          code: 'NETWORK',
          message: `Network request to PayPal failed: ${safeMessage}`,
        });
      }

      const debugId = response.headers.get('paypal-debug-id') ?? undefined;

      // 4. Handle 401 Unauthorized: Invalidate cached token and retry exactly once
      if (response.status === 401 && !hasRetried401) {
        hasRetried401 = true;
        this.tokenManager.invalidateToken(connectorKey);
        // Decrement attempt so 401 token refresh does not consume a network/5xx retry slot
        attempt--;
        continue;
      }

      // 5. Handle 2xx Success
      if (response.ok) {
        let data: T;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            data = (await response.json()) as T;
          } catch {
            data = null as unknown as T;
          }
        } else {
          const text = await response.text();
          data = (text.length > 0 ? text : null) as unknown as T;
        }

        return {
          status: response.status,
          data,
          headers: response.headers,
          debugId,
        };
      }

      // 6. Handle Non-2xx Responses
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        try {
          errorBody = await response.text();
        } catch {
          errorBody = undefined;
        }
      }

      const is5xx = response.status >= 500 && response.status <= 599;
      const isRetryable = is5xx && attempt < maxAttempts;

      // Never retry 4xx (handled 401 above)
      if (isRetryable) {
        await this.delay(attempt);
        continue;
      }

      // Map and throw safe error
      const mapped = mapPayPalError(response.status, errorBody, debugId);
      throw new PayPalHttpError({
        code: mapped.code,
        message: mapped.message,
        status: response.status,
        debugId,
        issue: mapped.issue,
        rawDetails: typeof errorBody === 'object' ? errorBody : undefined,
      });
    }

    throw new PayPalHttpError({
      code: 'UNKNOWN',
      message: 'PayPal request loop terminated unexpectedly',
    });
  }

  // ============================================================================
  // Convenience Methods
  // ============================================================================

  public async get<T = unknown>(
    path: string,
    options?: PayPalRequestOptions
  ): Promise<PayPalResponse<T>> {
    return this.request<T>('GET', path, undefined, options);
  }

  public async post<T = unknown>(
    path: string,
    body?: unknown,
    options?: PayPalRequestOptions
  ): Promise<PayPalResponse<T>> {
    return this.request<T>('POST', path, body, options);
  }

  public async put<T = unknown>(
    path: string,
    body?: unknown,
    options?: PayPalRequestOptions
  ): Promise<PayPalResponse<T>> {
    return this.request<T>('PUT', path, body, options);
  }

  public async delete<T = unknown>(
    path: string,
    options?: PayPalRequestOptions
  ): Promise<PayPalResponse<T>> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  public async patch<T = unknown>(
    path: string,
    body?: unknown,
    options?: PayPalRequestOptions
  ): Promise<PayPalResponse<T>> {
    return this.request<T>('PATCH', path, body, options);
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private buildUrl(
    pathOrUrl: string,
    params?: Record<string, string | number | boolean | undefined>
  ): string {
    let url: URL;
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
      url = new URL(pathOrUrl);
    } else {
      const normalizedPath = pathOrUrl.startsWith('/')
        ? pathOrUrl
        : `/${pathOrUrl}`;
      url = new URL(`${this.baseUrl}${normalizedPath}`);
    }

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  private async delay(attempt: number): Promise<void> {
    const ms = this.getRetryDelayMs(attempt);
    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }
}
