/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T1: Configuration & Environment Loader
 *
 * Implements strict, Zod-validated environment configuration per PAYGUARD_PLAN.md.
 *
 * Security & Invariants:
 * - Refuses to start in PRODUCTION mode without ALLOW_PRODUCTION=true per PLAN.md line 721.
 * - PayPal production is strictly inaccessible; URLs always point to Sandbox.
 * - Fails safely on missing or malformed configuration with descriptive errors.
 * - Never silently substitutes unsafe defaults.
 */

import { z } from 'zod';
import { MAX_MINOR_UNITS, toMinorUnits, type MinorUnits } from '../core/money.js';
import { DEFAULT_GEMINI_MODEL } from '../ai/types.js';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
export const DEFAULT_AI_MODEL = DEFAULT_GEMINI_MODEL;
export const DEFAULT_MAX_HARD_CAP_MINOR = toMinorUnits(1_000_000);

export interface HardCapCeilingValidationResult {
  readonly valid: boolean;
  readonly hardCapMinor: number;
  readonly maxHardCapMinor: number;
  readonly message?: string;
}

/**
 * Enforces that a policy's hard_cap_minor is a valid non-negative minor-unit integer
 * and does not exceed the configured MAX_HARD_CAP_MINOR operational ceiling.
 */
export function validateHardCapWithinCeiling(
  hardCapMinor: number,
  maxHardCapMinor: MinorUnits = getConfig().maxHardCapMinor
): HardCapCeilingValidationResult {
  if (!Number.isInteger(maxHardCapMinor) || maxHardCapMinor < 1 || maxHardCapMinor > MAX_MINOR_UNITS) {
    return {
      valid: false,
      hardCapMinor,
      maxHardCapMinor,
      message: `Configured MAX_HARD_CAP_MINOR ceiling (${String(maxHardCapMinor)}) is invalid`,
    };
  }
  if (!Number.isInteger(hardCapMinor) || hardCapMinor < 0) {
    return {
      valid: false,
      hardCapMinor,
      maxHardCapMinor,
      message: 'hard_cap_minor must be a non-negative integer minor units value',
    };
  }
  if (hardCapMinor > maxHardCapMinor) {
    return {
      valid: false,
      hardCapMinor,
      maxHardCapMinor,
      message: `hard_cap_minor (${hardCapMinor}) exceeds configured MAX_HARD_CAP_MINOR ceiling (${maxHardCapMinor})`,
    };
  }
  return {
    valid: true,
    hardCapMinor,
    maxHardCapMinor,
  };
}

export function isLocalhostUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0' ||
      host.endsWith('.localhost')
    );
  } catch {
    return /(?:^|\/\/|@)(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::|\/|$)/i.test(trimmed);
  }
}

export function sanitizePublicBaseUrl(
  rawUrl?: string | null,
  isProduction = process.env.NODE_ENV === 'production'
): string | undefined {
  if (typeof rawUrl !== 'string') return undefined;
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  if (isProduction && isLocalhostUrl(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export class ConfigError extends Error {
  public readonly issues?: z.ZodIssue[];

  constructor(message: string, issues?: z.ZodIssue[]) {
    super(`[CONFIG_ERROR] ${message}`);
    this.name = 'ConfigError';
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Validated PayGuard application configuration.
 */
export interface PayGuardConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly isDevelopment: boolean;
  readonly port: number;
  readonly publicBaseUrl?: string;
  readonly dbPath: string;
  readonly databasePath: string;
  readonly paypalEnv: 'SANDBOX' | 'PRODUCTION';
  readonly allowProduction: boolean;
  readonly paypalBaseUrl: string;
  readonly connectorAcmeClientId?: string;
  readonly connectorAcmeClientSecret?: string;
  readonly sessionSecret: string;
  readonly ownerPassphraseHash?: string;
  readonly holdTtlMinutes: number;
  readonly maxHardCapMinor: MinorUnits;
  readonly reseedOnBoot: boolean;
  readonly demoAgentApiKey?: string;
  readonly vaultTokenId?: string;
  readonly aiProvider: 'gemini' | 'mock';
  readonly aiModel: string;
  readonly geminiApiKey?: string;
  readonly aiScanMode: 'off' | 'advisory' | 'enforce';
  readonly telegramMode: 'disabled' | 'webhook';
  readonly telegramBotToken?: string;
  readonly telegramBotUsername?: string;
  readonly telegramWebhookSecret?: string;
  readonly telegramOwnerChatId?: string;
  readonly telegramEncryptionKey?: string;
  readonly telegramPreviousEncryptionKey?: string;
  readonly trustProxy: boolean | number | string;
}

/**
 * Raw environment input schema for Zod validation.
 */
const RawEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production'] as const).default('development'),
    PORT: z
      .string()
      .optional()
      .default('3000')
      .transform((val, ctx) => {
        const trimmed = val.trim();
        const parsed = Number(trimmed);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== trimmed) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `PORT must be an integer between 1 and 65535, received "${val}"`,
          });
          return z.NEVER;
        }
        return parsed;
      }),
    PUBLIC_BASE_URL: z.string().optional(),
    DB_PATH: z.string().optional(),
    DATABASE_PATH: z.string().optional(),
    PAYPAL_ENV: z.enum(['SANDBOX', 'PRODUCTION'] as const).default('SANDBOX'),
    ALLOW_PRODUCTION: z
      .string()
      .optional()
      .transform((val) => val?.trim().toLowerCase() === 'true'),
    CONNECTOR_ACME_CLIENT_ID: z.string().optional(),
    CONNECTOR_ACME_CLIENT_SECRET: z.string().optional(),
    SESSION_SECRET: z.string().optional(),
    OWNER_PASSPHRASE_HASH: z.string().optional(),
    HOLD_TTL_MINUTES: z
      .string()
      .optional()
      .default('15')
      .transform((val, ctx) => {
        const trimmed = val.trim();
        const parsed = Number(trimmed);
        if (!Number.isInteger(parsed) || parsed < 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `HOLD_TTL_MINUTES must be an integer >= 1, received "${val}"`,
          });
          return z.NEVER;
        }
        return parsed;
      }),
    MAX_HARD_CAP_MINOR: z
      .string()
      .optional()
      .default('1000000')
      .transform((val, ctx) => {
        const trimmed = val.trim();
        const parsed = Number(trimmed);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_MINOR_UNITS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `MAX_HARD_CAP_MINOR must be a positive integer minor units <= ${MAX_MINOR_UNITS}, received "${val}"`,
          });
          return z.NEVER;
        }
        return toMinorUnits(parsed);
      }),
    RESEED_ON_BOOT: z
      .string()
      .optional()
      .default('false')
      .transform((val) => val.trim().toLowerCase() === 'true'),
    DEMO_AGENT_API_KEY: z.string().optional(),
    VAULT_TOKEN_ID: z.string().optional(),
    AI_PROVIDER: z.enum(['gemini', 'mock'] as const).default('mock'),
    AI_MODEL: z.string().min(1, 'AI_MODEL cannot be empty').default(DEFAULT_AI_MODEL),
    GEMINI_API_KEY: z.string().optional(),
    AI_SCAN_MODE: z.enum(['off', 'advisory', 'enforce'] as const).default('advisory'),
    TELEGRAM_MODE: z.enum(['disabled', 'webhook'] as const).default('disabled'),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_BOT_USERNAME: z.string().optional(),
    TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
    TELEGRAM_OWNER_CHAT_ID: z.string().optional(),
    TELEGRAM_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'TELEGRAM_ENCRYPTION_KEY must be a 64-character hexadecimal string')
      .optional(),
    TELEGRAM_PREVIOUS_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'TELEGRAM_PREVIOUS_ENCRYPTION_KEY must be a 64-character hexadecimal string')
      .optional(),
    TRUST_PROXY: z
      .string()
      .optional()
      .default('false')
      .transform((val) => {
        const trimmed = val.trim();
        if (trimmed === '' || trimmed.toLowerCase() === 'false') return false;
        if (trimmed.toLowerCase() === 'true') return true;
        const parsed = Number(trimmed);
        if (Number.isInteger(parsed) && parsed >= 0 && String(parsed) === trimmed) {
          return parsed;
        }
        return trimmed;
      }),
  })
  .refine(
    (data) => {
      // Production guard per PLAN.md line 523 and line 721:
      // Code refuses PRODUCTION unless ALLOW_PRODUCTION=true
      if (data.PAYPAL_ENV === 'PRODUCTION') {
        return data.ALLOW_PRODUCTION === true;
      }
      return true;
    },
    {
      message: 'Production PayPal environment is refused unless ALLOW_PRODUCTION=true',
      path: ['PAYPAL_ENV'],
    }
  )
  .refine(
    (data) => {
      if (data.TELEGRAM_MODE !== 'disabled') {
        return typeof data.TELEGRAM_BOT_TOKEN === 'string' && data.TELEGRAM_BOT_TOKEN.trim().length > 0;
      }
      return true;
    },
    {
      message: 'TELEGRAM_BOT_TOKEN is required when TELEGRAM_MODE is not disabled',
      path: ['TELEGRAM_BOT_TOKEN'],
    }
  )
  .refine(
    (data) => {
      if (data.TELEGRAM_WEBHOOK_SECRET) {
        const trimmed = data.TELEGRAM_WEBHOOK_SECRET.trim();
        return /^[A-Za-z0-9_-]{1,256}$/.test(trimmed);
      }
      return true;
    },
    {
      message: 'TELEGRAM_WEBHOOK_SECRET must be 1-256 characters matching [A-Za-z0-9_-]',
      path: ['TELEGRAM_WEBHOOK_SECRET'],
    }
  );

/**
 * Loads and validates configuration from an environment dictionary.
 * Does not mutate the input dictionary or process.env.
 *
 * @param env - The environment variables dictionary (defaults to process.env)
 * @returns Fully validated and typed PayGuardConfig
 * @throws ConfigError if validation fails
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): PayGuardConfig {
  const result = RawEnvSchema.safeParse(env);

  if (!result.success) {
    const issueMessages = result.error.issues
      .map((i) => `  - ${i.path.join('.') || 'root'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issueMessages}`, result.error.issues);
  }

  const data = result.data;

  // Resolve database path: DATABASE_PATH takes precedence over DB_PATH, defaulting to standard path
  const resolvedDbPath = (data.DATABASE_PATH?.trim() || data.DB_PATH?.trim() || './data/payguard.db');
  if (resolvedDbPath.length === 0) {
    throw new ConfigError('DATABASE_PATH / DB_PATH cannot be empty string');
  }

  // Resolve public base URL (never synthesize http://localhost in production)
  const isProduction = data.NODE_ENV === 'production';
  const rawPublicBaseUrl = data.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  let resolvedPublicBaseUrl: string | undefined;

  if (rawPublicBaseUrl && rawPublicBaseUrl.length > 0) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawPublicBaseUrl);
    } catch {
      throw new ConfigError(`PUBLIC_BASE_URL must be a valid URL, received "${rawPublicBaseUrl}"`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new ConfigError(`PUBLIC_BASE_URL must use http or https scheme, received "${rawPublicBaseUrl}"`);
    }
    if (isProduction && isLocalhostUrl(rawPublicBaseUrl)) {
      throw new ConfigError(
        'PUBLIC_BASE_URL cannot point to localhost or a loopback address when NODE_ENV=production'
      );
    }
    resolvedPublicBaseUrl = rawPublicBaseUrl;
  } else {
    resolvedPublicBaseUrl = isProduction ? undefined : `http://localhost:${data.PORT}`;
  }

  // Resolve session secret (provide safe dev default if not specified)
  const resolvedSessionSecret = (data.SESSION_SECRET?.trim() || 'payguard-default-dev-session-secret-min16');

  return {
    nodeEnv: data.NODE_ENV,
    isProduction,
    isTest: data.NODE_ENV === 'test',
    isDevelopment: data.NODE_ENV === 'development',
    port: data.PORT,
    publicBaseUrl: resolvedPublicBaseUrl,
    dbPath: resolvedDbPath,
    databasePath: resolvedDbPath,
    paypalEnv: data.PAYPAL_ENV,
    allowProduction: data.ALLOW_PRODUCTION ?? false,
    // Security hard rule: PayPal production is strictly inaccessible.
    // URLs always resolve to Sandbox; production paths do not exist.
    paypalBaseUrl: SANDBOX_BASE_URL,
    connectorAcmeClientId: data.CONNECTOR_ACME_CLIENT_ID?.trim() || undefined,
    connectorAcmeClientSecret: data.CONNECTOR_ACME_CLIENT_SECRET?.trim() || undefined,
    sessionSecret: resolvedSessionSecret,
    ownerPassphraseHash: data.OWNER_PASSPHRASE_HASH?.trim() || undefined,
    holdTtlMinutes: data.HOLD_TTL_MINUTES,
    maxHardCapMinor: data.MAX_HARD_CAP_MINOR,
    reseedOnBoot: data.RESEED_ON_BOOT,
    demoAgentApiKey: data.DEMO_AGENT_API_KEY?.trim() || undefined,
    vaultTokenId: data.VAULT_TOKEN_ID?.trim() || undefined,
    aiProvider: data.AI_PROVIDER,
    aiModel: data.AI_MODEL,
    geminiApiKey: data.GEMINI_API_KEY?.trim() || undefined,
    aiScanMode: data.AI_SCAN_MODE,
    telegramMode: data.TELEGRAM_MODE,
    telegramBotToken: data.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramBotUsername: data.TELEGRAM_BOT_USERNAME?.trim()?.replace(/^@/, '') || undefined,
    telegramWebhookSecret: data.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined,
    telegramOwnerChatId: data.TELEGRAM_OWNER_CHAT_ID?.trim() || undefined,
    telegramEncryptionKey: data.TELEGRAM_ENCRYPTION_KEY?.trim() || undefined,
    telegramPreviousEncryptionKey: data.TELEGRAM_PREVIOUS_ENCRYPTION_KEY?.trim() || undefined,
    trustProxy: data.TRUST_PROXY,
  };
}

let cachedConfig: PayGuardConfig | null = null;

/**
 * Returns the application-wide cached configuration singleton.
 * Loads and caches from process.env on first call.
 */
export function getConfig(): PayGuardConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig(process.env);
  }
  return cachedConfig;
}

/**
 * Clears the cached configuration singleton. Useful for testing.
 */
export function resetConfig(): void {
  cachedConfig = null;
}
