/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T3: PayPal Vault Service
 *
 * Implements:
 * - Setup token creation (POST /v3/vault/setup-tokens)
 * - Setup confirmation / token exchange (POST /v3/vault/payment-tokens)
 * - Single payment token retrieval (GET /v3/vault/payment-tokens/{id})
 * - Payment token listing by customer_id (GET /v3/vault/payment-tokens?customer_id=...)
 * - Safe typed VaultError mapping and debug_id preservation
 * - Strict credential and access token redaction
 *
 * Security & Invariants:
 * - Hard Rule 1: Sandbox only. Production is strictly refused unless ALLOW_PRODUCTION=true.
 * - Hard Rule 2 & I7: Never log or expose credentials or access tokens.
 * - PLAN.md Section 12.1 & 12.2: Deterministic error mapping and canonical Vault v3 API flows.
 */

import * as crypto from 'node:crypto';
import type { PayPalHttpClient } from './http.js';
import { PayPalHttpError } from './http.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface CreateSetupTokenParams {
  readonly connectorKey?: string;
  readonly idempotencyKey?: string;
  readonly customerId?: string;
  readonly description?: string;
  readonly brandName?: string;
  readonly locale?: string;
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
  readonly userAction?: 'CONTINUE' | 'PAY_NOW';
  readonly usagePattern?: 'IMMEDIATE' | 'DEFERRED' | 'RECURRING_PREPAID' | 'RECURRING_POSTPAID' | 'THRESHOLD';
  readonly usageType?: 'MERCHANT' | 'CONSUMER';
}

export interface VaultSetupTokenResult {
  readonly id: string;
  readonly status: string;
  readonly approvalUrl: string;
  readonly customerId?: string;
}

export interface ConfirmSetupParams {
  readonly setupTokenId: string;
  readonly connectorKey?: string;
  readonly idempotencyKey?: string;
  readonly customerId?: string;
}

export interface VaultPaymentTokenResult {
  readonly id: string;
  readonly status: string;
  readonly customerId?: string;
  readonly payerEmail?: string;
  readonly payerAccountId?: string;
  readonly payerName?: {
    readonly givenName?: string;
    readonly surname?: string;
  };
}

export interface ListTokensParams {
  readonly customerId: string;
  readonly connectorKey?: string;
  readonly pageSize?: number;
  readonly page?: number;
  readonly totalRequired?: boolean;
}

export interface VaultPaymentTokenListResult {
  readonly totalItems?: number;
  readonly totalPages?: number;
  readonly paymentTokens: readonly VaultPaymentTokenResult[];
}

export interface PayPalVaultServiceOptions {
  readonly client: PayPalHttpClient;
  readonly defaultConnectorKey?: string;
}

// ============================================================================
// Error Class & Helpers
// ============================================================================

export class VaultError extends Error {
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
    this.name = 'VaultError';
    this.code = code;
    this.debugId = options?.debugId;
    this.causeError = options?.causeError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Safely masks a token ID for display/logging without exposing sensitive characters.
 * E.g. '69266860j82772632' -> '*************2632'
 */
export function maskTokenId(tokenId: string): string {
  if (!tokenId || tokenId.length <= 4) {
    return '****';
  }
  return `${'*'.repeat(tokenId.length - 4)}${tokenId.slice(-4)}`;
}

// ============================================================================
// PayPal Vault Service
// ============================================================================

export class PayPalVaultService {
  private readonly client: PayPalHttpClient;
  private readonly defaultConnectorKey: string;

  constructor(options: PayPalVaultServiceOptions) {
    this.client = options.client;
    this.defaultConnectorKey = options.defaultConnectorKey ?? 'acme_cloud';
  }

  /**
   * Creates a Vault setup-token (POST /v3/vault/setup-tokens).
   * Generates a PayPal buyer approval link for onboarding payment sources.
   *
   * @param params - Configuration parameters for setup token creation
   * @returns VaultSetupTokenResult containing the setupTokenId and browser approvalUrl
   */
  public async createSetupToken(
    params?: CreateSetupTokenParams
  ): Promise<VaultSetupTokenResult> {
    const connectorKey = params?.connectorKey ?? this.defaultConnectorKey;
    const idempotencyKey =
      params?.idempotencyKey ?? `payguard-setup-${crypto.randomUUID()}`;

    const payload: Record<string, unknown> = {
      payment_source: {
        paypal: {
          description:
            params?.description ?? 'PayGuard Vault Sandbox Authorization',
          usage_pattern: params?.usagePattern ?? 'IMMEDIATE',
          usage_type: params?.usageType ?? 'MERCHANT',
          experience_context: {
            brand_name: params?.brandName ?? 'PayGuard Demo',
            locale: params?.locale ?? 'en-US',
            return_url: params?.returnUrl ?? 'https://example.com/return',
            cancel_url: params?.cancelUrl ?? 'https://example.com/cancel',
            user_action: params?.userAction ?? 'CONTINUE',
          },
        },
      },
    };

    if (params?.customerId) {
      payload.customer = { id: params.customerId };
    }

    try {
      const response = await this.client.post<Record<string, unknown>>(
        '/v3/vault/setup-tokens',
        payload,
        {
          connectorKey,
          idempotencyKey,
        }
      );

      const data = response.data;
      if (!data || typeof data !== 'object') {
        throw new VaultError(
          'INVALID_SETUP_TOKEN_RESPONSE',
          'Setup token response is empty or not an object',
          { debugId: response.debugId }
        );
      }

      const id = typeof data.id === 'string' ? data.id : undefined;
      const status = typeof data.status === 'string' ? data.status : 'CREATED';

      if (!id || id.trim().length === 0) {
        throw new VaultError(
          'INVALID_SETUP_TOKEN_RESPONSE',
          'Setup token response missing id',
          { debugId: response.debugId }
        );
      }

      let approvalUrl: string | undefined;
      if (Array.isArray(data.links)) {
        const approveLink = data.links.find(
          (l: unknown) =>
            typeof l === 'object' &&
            l !== null &&
            (l as Record<string, unknown>).rel === 'approve'
        ) as Record<string, unknown> | undefined;

        if (typeof approveLink?.href === 'string' && approveLink.href.length > 0) {
          approvalUrl = approveLink.href;
        }
      }

      if (!approvalUrl) {
        throw new VaultError(
          'INVALID_SETUP_TOKEN_RESPONSE',
          'Setup token response does not contain an approve link',
          { debugId: response.debugId }
        );
      }

      const customerObj =
        typeof data.customer === 'object' && data.customer !== null
          ? (data.customer as Record<string, unknown>)
          : undefined;
      const customerId =
        typeof customerObj?.id === 'string' ? customerObj.id : undefined;

      return {
        id,
        status,
        approvalUrl,
        customerId,
      };
    } catch (err) {
      this.handleError(
        err,
        'SETUP_TOKEN_FAILED',
        'Failed to create Vault setup token'
      );
    }
  }

  /**
   * Confirms setup by exchanging an approved setup-token for a permanent payment-token
   * (POST /v3/vault/payment-tokens).
   *
   * @param params - Contains setupTokenId and optional idempotencyKey
   * @returns VaultPaymentTokenResult containing permanent payment-token ID and metadata
   */
  public async confirmSetup(
    params: ConfirmSetupParams
  ): Promise<VaultPaymentTokenResult> {
    if (!params?.setupTokenId || params.setupTokenId.trim().length === 0) {
      throw new VaultError(
        'INVALID_PARAMETER',
        'setupTokenId must be a non-empty string'
      );
    }

    const connectorKey = params.connectorKey ?? this.defaultConnectorKey;
    const idempotencyKey =
      params.idempotencyKey ?? `payguard-payment-token-${crypto.randomUUID()}`;

    const payload: Record<string, unknown> = {
      payment_source: {
        token: {
          type: 'SETUP_TOKEN',
          id: params.setupTokenId,
        },
      },
    };

    if (params.customerId) {
      payload.customer = { id: params.customerId };
    }

    try {
      const response = await this.client.post<Record<string, unknown>>(
        '/v3/vault/payment-tokens',
        payload,
        {
          connectorKey,
          idempotencyKey,
        }
      );

      return this.parsePaymentTokenResponse(response.data, response.debugId);
    } catch (err) {
      this.handleError(
        err,
        'CONFIRM_SETUP_FAILED',
        'Failed to confirm Vault setup token'
      );
    }
  }

  /**
   * Retrieves details of an existing vaulted payment-token (GET /v3/vault/payment-tokens/{id}).
   *
   * @param tokenId - The permanent payment token ID
   * @param options - Optional connectorKey override
   */
  public async getPaymentToken(
    tokenId: string,
    options?: { connectorKey?: string }
  ): Promise<VaultPaymentTokenResult> {
    if (!tokenId || tokenId.trim().length === 0) {
      throw new VaultError(
        'INVALID_PARAMETER',
        'tokenId must be a non-empty string'
      );
    }

    const connectorKey = options?.connectorKey ?? this.defaultConnectorKey;
    const encodedId = encodeURIComponent(tokenId.trim());

    try {
      const response = await this.client.get<Record<string, unknown>>(
        `/v3/vault/payment-tokens/${encodedId}`,
        { connectorKey }
      );

      return this.parsePaymentTokenResponse(response.data, response.debugId);
    } catch (err) {
      this.handleError(
        err,
        'GET_PAYMENT_TOKEN_FAILED',
        'Failed to retrieve Vault payment token'
      );
    }
  }

  /**
   * Lists vaulted payment-tokens for a given customer (GET /v3/vault/payment-tokens?customer_id=...).
   *
   * @param params - Contains mandatory customerId and optional pagination params
   */
  public async listTokens(
    params: ListTokensParams
  ): Promise<VaultPaymentTokenListResult> {
    if (!params?.customerId || params.customerId.trim().length === 0) {
      throw new VaultError(
        'INVALID_PARAMETER',
        'customerId is required to list payment tokens'
      );
    }

    const connectorKey = params.connectorKey ?? this.defaultConnectorKey;
    const queryParams: Record<string, string | number | boolean | undefined> = {
      customer_id: params.customerId.trim(),
      page_size: params.pageSize,
      page: params.page,
      total_required: params.totalRequired,
    };

    try {
      const response = await this.client.get<Record<string, unknown>>(
        '/v3/vault/payment-tokens',
        {
          connectorKey,
          params: queryParams,
        }
      );

      const data = response.data;
      if (!data || typeof data !== 'object') {
        throw new VaultError(
          'INVALID_LIST_TOKENS_RESPONSE',
          'List payment tokens response is empty or not an object',
          { debugId: response.debugId }
        );
      }

      const totalItems =
        typeof data.total_items === 'number' ? data.total_items : undefined;
      const totalPages =
        typeof data.total_pages === 'number' ? data.total_pages : undefined;

      const tokensRaw = Array.isArray(data.payment_tokens)
        ? data.payment_tokens
        : [];

      const paymentTokens: VaultPaymentTokenResult[] = [];
      for (const item of tokensRaw) {
        if (typeof item === 'object' && item !== null) {
          try {
            const parsed = this.parsePaymentTokenResponse(
              item as Record<string, unknown>,
              response.debugId
            );
            paymentTokens.push(parsed);
          } catch {
            // Skip malformed entries in the list
          }
        }
      }

      return {
        totalItems,
        totalPages,
        paymentTokens,
      };
    } catch (err) {
      this.handleError(
        err,
        'LIST_PAYMENT_TOKENS_FAILED',
        'Failed to list Vault payment tokens'
      );
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private parsePaymentTokenResponse(
    data: unknown,
    debugId?: string
  ): VaultPaymentTokenResult {
    if (!data || typeof data !== 'object') {
      throw new VaultError(
        'INVALID_PAYMENT_TOKEN_RESPONSE',
        'Payment token response is empty or not an object',
        { debugId }
      );
    }

    const obj = data as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : undefined;
    if (!id || id.trim().length === 0) {
      throw new VaultError(
        'INVALID_PAYMENT_TOKEN_RESPONSE',
        'Payment token response missing id',
        { debugId }
      );
    }

    const status = typeof obj.status === 'string' ? obj.status : 'CREATED';

    const customerObj =
      typeof obj.customer === 'object' && obj.customer !== null
        ? (obj.customer as Record<string, unknown>)
        : undefined;
    const customerId =
      typeof customerObj?.id === 'string' ? customerObj.id : undefined;

    let payerEmail: string | undefined;
    let payerAccountId: string | undefined;
    let payerName: { givenName?: string; surname?: string } | undefined;

    const paymentSource =
      typeof obj.payment_source === 'object' && obj.payment_source !== null
        ? (obj.payment_source as Record<string, unknown>)
        : undefined;

    const paypal =
      typeof paymentSource?.paypal === 'object' && paymentSource.paypal !== null
        ? (paymentSource.paypal as Record<string, unknown>)
        : undefined;

    if (paypal) {
      if (typeof paypal.email_address === 'string') {
        payerEmail = paypal.email_address;
      }
      if (typeof paypal.account_id === 'string') {
        payerAccountId = paypal.account_id;
      }
      if (typeof paypal.name === 'object' && paypal.name !== null) {
        const nameObj = paypal.name as Record<string, unknown>;
        payerName = {
          givenName:
            typeof nameObj.given_name === 'string'
              ? nameObj.given_name
              : undefined,
          surname:
            typeof nameObj.surname === 'string' ? nameObj.surname : undefined,
        };
      }
    }

    return {
      id,
      status,
      customerId,
      payerEmail,
      payerAccountId,
      payerName,
    };
  }

  private handleError(
    err: unknown,
    defaultCode: string,
    defaultMessage: string
  ): never {
    if (err instanceof VaultError) {
      throw err;
    }
    if (err instanceof PayPalHttpError) {
      throw new VaultError(err.code, err.message, {
        debugId: err.debugId,
        causeError: err,
      });
    }
    const msg = err instanceof Error ? err.message : defaultMessage;
    throw new VaultError(defaultCode, msg, { causeError: err });
  }
}
