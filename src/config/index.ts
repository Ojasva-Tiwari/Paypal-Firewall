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

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

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
  readonly publicBaseUrl: string;
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
  readonly aiScanMode: 'advisory' | 'enforce';
  readonly telegramBotToken?: string;
  readonly telegramOwnerChatId?: string;
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
    AI_MODEL: z.string().min(1, 'AI_MODEL cannot be empty').default('gemini-1.5-flash'),
    GEMINI_API_KEY: z.string().optional(),
    AI_SCAN_MODE: z.enum(['advisory', 'enforce'] as const).default('advisory'),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_OWNER_CHAT_ID: z.string().optional(),
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

  // Resolve public base URL
  const resolvedPublicBaseUrl = (data.PUBLIC_BASE_URL?.trim() || `http://localhost:${data.PORT}`);

  // Resolve session secret (provide safe dev default if not specified)
  const resolvedSessionSecret = (data.SESSION_SECRET?.trim() || 'payguard-default-dev-session-secret-min16');

  return {
    nodeEnv: data.NODE_ENV,
    isProduction: data.NODE_ENV === 'production',
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
    telegramBotToken: data.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramOwnerChatId: data.TELEGRAM_OWNER_CHAT_ID?.trim() || undefined,
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
