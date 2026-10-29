/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T1: PayPal Token Manager
 *
 * Implements:
 * - Per-connector OAuth access token caching
 * - Single-flight deduplication of concurrent token fetches
 * - 5-minute early refresh before token expiry
 * - Token invalidation for 401 recovery (M2-T2)
 * - Safe credential isolation with zero secret leakage in errors or logs
 *
 * Safety & Invariants:
 * - Hard Rule 1: Sandbox only. Production is strictly refused unless ALLOW_PRODUCTION=true.
 * - Hard Rule 2 & I7: Never log or expose credentials or access tokens.
 */

export const SANDBOX_OAUTH_URL = 'https://api-m.sandbox.paypal.com/v1/oauth2/token';
export const DEFAULT_EARLY_REFRESH_BUFFER_MS = 300_000; // 5 minutes (Section 12.2)

export interface ConnectorCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export type CredentialResolver = (
  connectorKey: string
) => Promise<ConnectorCredentials | undefined> | ConnectorCredentials | undefined;

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type?: string;
  readonly expires_in: number;
}

export interface CachedToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

export type FetchFunction = (
  input: string | URL | globalThis.Request,
  init?: RequestInit
) => Promise<Response>;

export interface TokenManagerOptions {
  /**
   * Base URL for the PayPal API (e.g. 'https://api-m.sandbox.paypal.com').
   * Defaults to 'https://api-m.sandbox.paypal.com'.
   */
  readonly baseUrl?: string;
  /**
   * Resolver function mapping connectorKey to credentials.
   */
  readonly credentialResolver: CredentialResolver;
  /**
   * Injectable fetch function (defaults to globalThis.fetch).
   */
  readonly fetchFn?: FetchFunction;
  /**
   * Injectable clock function returning epoch milliseconds (defaults to Date.now).
   */
  readonly nowFn?: () => number;
  /**
   * Milliseconds before token expiry at which the token is considered expired.
   * Defaults to 300,000 ms (5 minutes per canonical plan).
   */
  readonly earlyRefreshBufferMs?: number;
}

// ============================================================================
// Error Class (Credentials strictly redacted)
// ============================================================================

export class TokenManagerError extends Error {
  public readonly code: string;
  public readonly connectorKey: string;

  constructor(code: string, message: string, connectorKey: string) {
    super(`[${code}] ${message}`);
    this.name = 'TokenManagerError';
    this.code = code;
    this.connectorKey = connectorKey;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// Token Manager Class
// ============================================================================

export class TokenManager {
  private readonly baseUrl: string;
  private readonly credentialResolver: CredentialResolver;
  private readonly fetchFn: FetchFunction;
  private readonly nowFn: () => number;
  private readonly earlyRefreshBufferMs: number;

  private readonly cache: Map<string, CachedToken> = new Map();
  private readonly inFlightRequests: Map<string, Promise<string>> = new Map();

  constructor(options: TokenManagerOptions) {
    const rawBaseUrl = options.baseUrl || 'https://api-m.sandbox.paypal.com';

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
    this.credentialResolver = options.credentialResolver;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.earlyRefreshBufferMs =
      options.earlyRefreshBufferMs ?? DEFAULT_EARLY_REFRESH_BUFFER_MS;
  }

  /**
   * Retrieves a valid cached OAuth access token for the given connectorKey,
   * refreshing early if within 5 minutes of expiry, and deduplicating concurrent
   * fetches for the same connectorKey via single-flight.
   *
   * @param connectorKey - The unique key identifying the connector (e.g. 'acme_cloud')
   * @returns Promise resolving to the bearer access token string
   */
  public async getAccessToken(connectorKey: string): Promise<string> {
    if (!connectorKey || typeof connectorKey !== 'string') {
      throw new TokenManagerError(
        'INVALID_CONNECTOR_KEY',
        'Connector key must be a non-empty string',
        String(connectorKey)
      );
    }

    const now = this.nowFn();
    const cached = this.cache.get(connectorKey);

    // 1. Check cache validity (must have more than earlyRefreshBufferMs remaining)
    if (cached && now < cached.expiresAtMs - this.earlyRefreshBufferMs) {
      return cached.accessToken;
    }

    // 2. Check for in-flight single-flight fetch
    const existingInFlight = this.inFlightRequests.get(connectorKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    // 3. Initiate new fetch with single-flight tracking
    const inFlightPromise = (async (): Promise<string> => {
      try {
        const token = await this.fetchNewToken(connectorKey);
        return token;
      } finally {
        // Always clean up in-flight request when complete or failed
        this.inFlightRequests.delete(connectorKey);
      }
    })();

    this.inFlightRequests.set(connectorKey, inFlightPromise);
    return inFlightPromise;
  }

  /**
   * Invalidates any cached token for the specified connector.
   * Called by HTTP client layers on HTTP 401 unauthorized responses.
   *
   * @param connectorKey - The connector key whose token should be purged
   */
  public invalidateToken(connectorKey: string): void {
    this.cache.delete(connectorKey);
  }

  /**
   * Clears all cached tokens and in-flight promises across all connectors.
   */
  public clearAll(): void {
    this.cache.clear();
    this.inFlightRequests.clear();
  }

  /**
   * Returns true if a cached token exists and has not crossed the early-refresh boundary.
   */
  public hasValidToken(connectorKey: string): boolean {
    const cached = this.cache.get(connectorKey);
    if (!cached) {
      return false;
    }
    return this.nowFn() < cached.expiresAtMs - this.earlyRefreshBufferMs;
  }

  /**
   * Returns the expiry timestamp in epoch milliseconds of the cached token, if any.
   */
  public getTokenExpiry(connectorKey: string): number | undefined {
    return this.cache.get(connectorKey)?.expiresAtMs;
  }

  // ============================================================================
  // Private Helper: Fetch and cache new token
  // ============================================================================

  private async fetchNewToken(connectorKey: string): Promise<string> {
    // 1. Resolve credentials
    let credentials: ConnectorCredentials | undefined;
    try {
      credentials = await this.credentialResolver(connectorKey);
    } catch {
      throw new TokenManagerError(
        'CREDENTIAL_RESOLVER_FAILED',
        `Failed to resolve credentials for connector "${connectorKey}"`,
        connectorKey
      );
    }

    if (!credentials?.clientId || !credentials?.clientSecret) {
      throw new TokenManagerError(
        'MISSING_CREDENTIALS',
        `Missing credentials for connector "${connectorKey}"`,
        connectorKey
      );
    }

    // 2. Perform OAuth token request
    const basicAuth = Buffer.from(
      `${credentials.clientId}:${credentials.clientSecret}`
    ).toString('base64');

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
    } catch (networkError: unknown) {
      // Redact any network error details that might contain the Authorization header or URL credentials
      const safeMessage =
        networkError instanceof Error
          ? networkError.message.replace(basicAuth, '[REDACTED]')
          : 'Network error';
      throw new TokenManagerError(
        'OAUTH_NETWORK_ERROR',
        `Network request to OAuth endpoint failed: ${safeMessage}`,
        connectorKey
      );
    }

    // 3. Validate HTTP status
    if (!response.ok) {
      const debugId = response.headers.get('paypal-debug-id') || 'none';
      // Never include response body in error message if it might contain sensitive info
      throw new TokenManagerError(
        'OAUTH_REQUEST_FAILED',
        `OAuth token request failed with HTTP ${response.status} (debug_id: ${debugId})`,
        connectorKey
      );
    }

    // 4. Parse and validate JSON response
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new TokenManagerError(
        'INVALID_OAUTH_RESPONSE',
        'Failed to parse JSON from OAuth response',
        connectorKey
      );
    }

    const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
    const accessToken = typeof obj?.['access_token'] === 'string' ? obj['access_token'] : undefined;
    const expiresIn = typeof obj?.['expires_in'] === 'number' ? obj['expires_in'] : undefined;

    if (
      !accessToken ||
      accessToken.length === 0 ||
      expiresIn === undefined ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new TokenManagerError(
        'INVALID_OAUTH_RESPONSE',
        'OAuth response did not contain a valid access_token and positive expires_in number',
        connectorKey
      );
    }

    const tokenResponse = data as TokenResponse;
    const now = this.nowFn();
    const expiresAtMs = now + tokenResponse.expires_in * 1000;

    // 5. Store in cache
    this.cache.set(connectorKey, {
      accessToken: tokenResponse.access_token,
      expiresAtMs,
    });

    return tokenResponse.access_token;
  }
}
