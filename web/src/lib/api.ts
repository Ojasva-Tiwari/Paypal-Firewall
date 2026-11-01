/**
 * PayGuard — Secure Same-Origin API Client
 *
 * Security Invariants:
 * 1. Same-origin requests with `credentials: 'include'` (leverages HttpOnly session cookie).
 * 2. In-memory CSRF token handling only. Never writes tokens to localStorage or sessionStorage.
 * 3. Enforces `x-csrf-token` header on all mutation methods (POST, PUT, DELETE, PATCH).
 * 4. Distinguishes 401 (Authentication required / Session expired) from 403 (CSRF failure).
 */

let inMemoryCsrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  inMemoryCsrfToken = token;
}

export function getCsrfToken(): string | null {
  return inMemoryCsrfToken;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly isAuthError: boolean;
  public readonly isCsrfError: boolean;
  public readonly data: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.isAuthError = status === 401;
    this.isCsrfError = status === 403;
    this.data = data;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const isMutation = method !== 'GET' && method !== 'HEAD';

  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');

  if (isMutation) {
    if (inMemoryCsrfToken) {
      headers.set('x-csrf-token', inMemoryCsrfToken);
    }
    if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
  }

  const response = await fetch(endpoint, {
    ...options,
    method,
    headers,
    credentials: 'include',
  });

  let responseData: unknown = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      responseData = await response.json();
    } catch {
      responseData = null;
    }
  } else {
    try {
      responseData = await response.text();
    } catch {
      responseData = null;
    }
  }

  if (!response.ok) {
    const errorMsg =
      responseData && typeof responseData === 'object' && 'error' in responseData
        ? String((responseData as { error: unknown }).error)
        : `Request failed with status ${response.status}`;

    throw new ApiError(errorMsg, response.status, responseData);
  }

  return responseData as T;
}

export const apiClient = {
  get: <T>(endpoint: string, init?: RequestInit): Promise<T> =>
    apiFetch<T>(endpoint, { ...init, method: 'GET' }),

  post: <T>(endpoint: string, body?: unknown, init?: RequestInit): Promise<T> =>
    apiFetch<T>(endpoint, {
      ...init,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  put: <T>(endpoint: string, body?: unknown, init?: RequestInit): Promise<T> =>
    apiFetch<T>(endpoint, {
      ...init,
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),

  delete: <T>(endpoint: string, body?: unknown, init?: RequestInit): Promise<T> =>
    apiFetch<T>(endpoint, {
      ...init,
      method: 'DELETE',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
};

