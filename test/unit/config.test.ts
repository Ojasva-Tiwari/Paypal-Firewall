import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  getConfig,
  resetConfig,
  ConfigError,
  SANDBOX_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_MAX_HARD_CAP_MINOR,
  sanitizePublicBaseUrl,
  validateHardCapWithinCeiling,
} from '../../src/config/index.js';
import { MAX_MINOR_UNITS } from '../../src/core/money.js';

describe('Configuration & Environment Loader (M1-T1)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Preserve process.env for isolation
    originalEnv = { ...process.env };
    resetConfig();
  });

  afterEach(() => {
    // Restore process.env after each test
    process.env = originalEnv;
    resetConfig();
  });

  describe('Default Configuration Acceptance', () => {
    it('should load clean defaults when an empty environment is supplied', () => {
      const config = loadConfig({});

      expect(config.nodeEnv).toBe('development');
      expect(config.isDevelopment).toBe(true);
      expect(config.isProduction).toBe(false);
      expect(config.isTest).toBe(false);

      expect(config.port).toBe(3000);
      expect(config.publicBaseUrl).toBe('http://localhost:3000');
      expect(config.dbPath).toBe('./data/payguard.db');
      expect(config.databasePath).toBe('./data/payguard.db');

      expect(config.paypalEnv).toBe('SANDBOX');
      expect(config.allowProduction).toBe(false);
      expect(config.paypalBaseUrl).toBe(SANDBOX_BASE_URL);

      expect(config.holdTtlMinutes).toBe(15);
      expect(config.maxHardCapMinor).toBe(1000000);
      expect(config.reseedOnBoot).toBe(false);

      expect(config.aiProvider).toBe('mock');
      expect(config.aiModel).toBe('gemini-3.5-flash-lite');
      expect(config.aiModel).toBe(DEFAULT_AI_MODEL);
      expect(config.aiScanMode).toBe('advisory');

      expect(config.sessionSecret).toBe('payguard-default-dev-session-secret-min16');
      expect(config.connectorAcmeClientId).toBeUndefined();
      expect(config.connectorAcmeClientSecret).toBeUndefined();
      expect(config.ownerPassphraseHash).toBeUndefined();
      expect(config.demoAgentApiKey).toBeUndefined();
      expect(config.vaultTokenId).toBeUndefined();
      expect(config.geminiApiKey).toBeUndefined();
      expect(config.telegramMode).toBe('disabled');
      expect(config.telegramBotToken).toBeUndefined();
      expect(config.telegramBotUsername).toBeUndefined();
      expect(config.telegramWebhookSecret).toBeUndefined();
      expect(config.telegramOwnerChatId).toBeUndefined();
      expect(config.trustProxy).toBe(false);
    });

    it('should derive publicBaseUrl from custom PORT if PUBLIC_BASE_URL is omitted', () => {
      const config = loadConfig({ PORT: '8080' });
      expect(config.port).toBe(8080);
      expect(config.publicBaseUrl).toBe('http://localhost:8080');
    });

    it('should support explicit PUBLIC_BASE_URL override and normalize trailing slashes', () => {
      const config = loadConfig({
        PORT: '4000',
        PUBLIC_BASE_URL: 'https://payguard.example.com///',
      });
      expect(config.port).toBe(4000);
      expect(config.publicBaseUrl).toBe('https://payguard.example.com');
    });

    it('should return undefined publicBaseUrl in production when PUBLIC_BASE_URL is omitted (never localhost fallback)', () => {
      const config = loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'prod-session-secret-at-least-32-chars-long',
      });
      expect(config.isProduction).toBe(true);
      expect(config.publicBaseUrl).toBeUndefined();
    });

    it('should reject localhost/loopback PUBLIC_BASE_URL in production', () => {
      for (const badUrl of [
        'http://localhost:3000',
        'https://localhost/app',
        'http://127.0.0.1:8080',
        'http://[::1]:3000',
        'http://0.0.0.0:3000',
      ]) {
        expect(() =>
          loadConfig({
            NODE_ENV: 'production',
            SESSION_SECRET: 'prod-session-secret-at-least-32-chars-long',
            PUBLIC_BASE_URL: badUrl,
          })
        ).toThrow(ConfigError);
      }
    });

    it('should accept valid external HTTPS PUBLIC_BASE_URL in production', () => {
      const config = loadConfig({
        NODE_ENV: 'production',
        SESSION_SECRET: 'prod-session-secret-at-least-32-chars-long',
        PUBLIC_BASE_URL: 'https://guard.company.com/',
      });
      expect(config.publicBaseUrl).toBe('https://guard.company.com');
    });

    it('sanitizePublicBaseUrl strips trailing slashes and suppresses localhost in production', () => {
      expect(sanitizePublicBaseUrl('http://localhost:3000/', false)).toBe('http://localhost:3000');
      expect(sanitizePublicBaseUrl('http://localhost:3000/', true)).toBeUndefined();
      expect(sanitizePublicBaseUrl('http://127.0.0.1:3000', true)).toBeUndefined();
      expect(sanitizePublicBaseUrl('https://guard.company.com/', true)).toBe('https://guard.company.com');
      expect(sanitizePublicBaseUrl(undefined, true)).toBeUndefined();
    });

    it('should allow user-configurable AI_MODEL override while defaulting to gemini-3.5-flash-lite', () => {
      const defaultConfig = loadConfig({});
      expect(defaultConfig.aiModel).toBe('gemini-3.5-flash-lite');
      expect(defaultConfig.aiModel).toBe(DEFAULT_AI_MODEL);

      const customConfig = loadConfig({ AI_MODEL: 'gemini-3.8-pro' });
      expect(customConfig.aiModel).toBe('gemini-3.8-pro');
    });
  });

  describe('Database Path Resolution', () => {
    it('should use DB_PATH when provided', () => {
      const config = loadConfig({ DB_PATH: './custom/storage.db' });
      expect(config.dbPath).toBe('./custom/storage.db');
      expect(config.databasePath).toBe('./custom/storage.db');
    });

    it('should use DATABASE_PATH when provided', () => {
      const config = loadConfig({ DATABASE_PATH: './custom/database.sqlite' });
      expect(config.dbPath).toBe('./custom/database.sqlite');
      expect(config.databasePath).toBe('./custom/database.sqlite');
    });

    it('should prioritize DATABASE_PATH over DB_PATH when both are provided', () => {
      const config = loadConfig({
        DATABASE_PATH: './priority.db',
        DB_PATH: './secondary.db',
      });
      expect(config.dbPath).toBe('./priority.db');
      expect(config.databasePath).toBe('./priority.db');
    });

    it('should fallback to default when empty whitespace is passed', () => {
      const config = loadConfig({ DB_PATH: '   ' });
      expect(config.dbPath).toBe('./data/payguard.db');
    });
  });

  describe('Production Guard & Safety Invariants', () => {
    it('should refuse to start when PAYPAL_ENV=PRODUCTION without ALLOW_PRODUCTION', () => {
      expect(() => {
        loadConfig({ PAYPAL_ENV: 'PRODUCTION' });
      }).toThrow(ConfigError);

      expect(() => {
        loadConfig({ PAYPAL_ENV: 'PRODUCTION' });
      }).toThrowError(/Production PayPal environment is refused unless ALLOW_PRODUCTION=true/);
    });

    it('should refuse to start when PAYPAL_ENV=PRODUCTION with ALLOW_PRODUCTION=false', () => {
      expect(() => {
        loadConfig({
          PAYPAL_ENV: 'PRODUCTION',
          ALLOW_PRODUCTION: 'false',
        });
      }).toThrow(ConfigError);
    });

    it('should allow start when PAYPAL_ENV=PRODUCTION and ALLOW_PRODUCTION=true', () => {
      const config = loadConfig({
        PAYPAL_ENV: 'PRODUCTION',
        ALLOW_PRODUCTION: 'true',
      });
      expect(config.paypalEnv).toBe('PRODUCTION');
      expect(config.allowProduction).toBe(true);
      // Hard Rule 1: PayPal production URLs must never be accessible
      expect(config.paypalBaseUrl).toBe(SANDBOX_BASE_URL);
    });

    it('should accept SANDBOX when ALLOW_PRODUCTION is not set', () => {
      const config = loadConfig({ PAYPAL_ENV: 'SANDBOX' });
      expect(config.paypalEnv).toBe('SANDBOX');
      expect(config.allowProduction).toBe(false);
      expect(config.paypalBaseUrl).toBe(SANDBOX_BASE_URL);
    });

    it('should keep paypalBaseUrl pointing to Sandbox unconditionally', () => {
      const config = loadConfig({
        PAYPAL_ENV: 'SANDBOX',
        ALLOW_PRODUCTION: 'false',
      });
      expect(config.paypalBaseUrl).toBe('https://api-m.sandbox.paypal.com');
      expect(config.paypalBaseUrl).not.toContain('https://api-m.paypal.com');
    });
  });

  describe('PORT Validation and Bounds', () => {
    it('should parse valid port strings', () => {
      expect(loadConfig({ PORT: '1' }).port).toBe(1);
      expect(loadConfig({ PORT: '3000' }).port).toBe(3000);
      expect(loadConfig({ PORT: '65535' }).port).toBe(65535);
    });

    it('should reject invalid or out-of-bounds port numbers', () => {
      expect(() => loadConfig({ PORT: '0' })).toThrow(ConfigError);
      expect(() => loadConfig({ PORT: '-1' })).toThrow(ConfigError);
      expect(() => loadConfig({ PORT: '65536' })).toThrow(ConfigError);
      expect(() => loadConfig({ PORT: '99999' })).toThrow(ConfigError);
      expect(() => loadConfig({ PORT: '3000.5' })).toThrow(ConfigError);
      expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
      expect(() => loadConfig({ PORT: '1e3' })).toThrow(ConfigError);
    });
  });

  describe('Operational Limits & Policy Ceilings', () => {
    it('should parse valid HOLD_TTL_MINUTES', () => {
      expect(loadConfig({ HOLD_TTL_MINUTES: '1' }).holdTtlMinutes).toBe(1);
      expect(loadConfig({ HOLD_TTL_MINUTES: '60' }).holdTtlMinutes).toBe(60);
      expect(loadConfig({ HOLD_TTL_MINUTES: '1440' }).holdTtlMinutes).toBe(1440);
    });

    it('should reject non-positive or malformed HOLD_TTL_MINUTES', () => {
      expect(() => loadConfig({ HOLD_TTL_MINUTES: '0' })).toThrow(ConfigError);
      expect(() => loadConfig({ HOLD_TTL_MINUTES: '-10' })).toThrow(ConfigError);
      expect(() => loadConfig({ HOLD_TTL_MINUTES: '15.5' })).toThrow(ConfigError);
      expect(() => loadConfig({ HOLD_TTL_MINUTES: 'invalid' })).toThrow(ConfigError);
    });

    it('should parse valid MAX_HARD_CAP_MINOR', () => {
      expect(loadConfig({ MAX_HARD_CAP_MINOR: '100' }).maxHardCapMinor).toBe(100);
      expect(loadConfig({ MAX_HARD_CAP_MINOR: '10000' }).maxHardCapMinor).toBe(10000);
      expect(loadConfig({ MAX_HARD_CAP_MINOR: String(MAX_MINOR_UNITS) }).maxHardCapMinor).toBe(
        MAX_MINOR_UNITS
      );
    });

    it('should reject non-positive or excessive MAX_HARD_CAP_MINOR', () => {
      expect(() => loadConfig({ MAX_HARD_CAP_MINOR: '0' })).toThrow(ConfigError);
      expect(() => loadConfig({ MAX_HARD_CAP_MINOR: '-500' })).toThrow(ConfigError);
      expect(() => loadConfig({ MAX_HARD_CAP_MINOR: '1000000000' })).toThrow(ConfigError);
      expect(() => loadConfig({ MAX_HARD_CAP_MINOR: 'invalid' })).toThrow(ConfigError);
    });

    it('validateHardCapWithinCeiling enforces boundary and rejects values above MAX_HARD_CAP_MINOR', () => {
      expect(DEFAULT_MAX_HARD_CAP_MINOR).toBe(1_000_000);

      expect(validateHardCapWithinCeiling(50000, 50000 as never).valid).toBe(true);
      expect(validateHardCapWithinCeiling(49999, 50000 as never).valid).toBe(true);
      expect(validateHardCapWithinCeiling(0, 50000 as never).valid).toBe(true);

      const exceeded = validateHardCapWithinCeiling(50001, 50000 as never);
      expect(exceeded.valid).toBe(false);
      expect(exceeded.message).toContain('MAX_HARD_CAP_MINOR');

      expect(validateHardCapWithinCeiling(-1, 50000 as never).valid).toBe(false);
      expect(validateHardCapWithinCeiling(10.5, 50000 as never).valid).toBe(false);
      expect(validateHardCapWithinCeiling(100, 0 as never).valid).toBe(false);
      expect(validateHardCapWithinCeiling(100, (MAX_MINOR_UNITS + 1) as never).valid).toBe(false);

      process.env.MAX_HARD_CAP_MINOR = '25000';
      resetConfig();
      expect(validateHardCapWithinCeiling(25000).valid).toBe(true);
      expect(validateHardCapWithinCeiling(25001).valid).toBe(false);
    });
  });

  describe('Enums and Option Validation', () => {
    it('should validate NODE_ENV enum values', () => {
      expect(loadConfig({ NODE_ENV: 'development' }).nodeEnv).toBe('development');
      expect(loadConfig({ NODE_ENV: 'test' }).nodeEnv).toBe('test');
      expect(loadConfig({ NODE_ENV: 'production' }).nodeEnv).toBe('production');

      expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(ConfigError);
      expect(() => loadConfig({ NODE_ENV: 'local' })).toThrow(ConfigError);
    });

    it('should validate AI_PROVIDER enum values', () => {
      expect(loadConfig({ AI_PROVIDER: 'mock' }).aiProvider).toBe('mock');
      expect(loadConfig({ AI_PROVIDER: 'gemini' }).aiProvider).toBe('gemini');

      expect(() => loadConfig({ AI_PROVIDER: 'openai' })).toThrow(ConfigError);
      expect(() => loadConfig({ AI_PROVIDER: 'anthropic' })).toThrow(ConfigError);
    });

    it('should validate AI_SCAN_MODE enum values', () => {
      expect(loadConfig({ AI_SCAN_MODE: 'off' }).aiScanMode).toBe('off');
      expect(loadConfig({ AI_SCAN_MODE: 'advisory' }).aiScanMode).toBe('advisory');
      expect(loadConfig({ AI_SCAN_MODE: 'enforce' }).aiScanMode).toBe('enforce');

      expect(() => loadConfig({ AI_SCAN_MODE: 'strict' })).toThrow(ConfigError);
      expect(() => loadConfig({ AI_SCAN_MODE: 'invalid' })).toThrow(ConfigError);
    });

    it('should parse RESEED_ON_BOOT boolean flag', () => {
      expect(loadConfig({ RESEED_ON_BOOT: 'true' }).reseedOnBoot).toBe(true);
      expect(loadConfig({ RESEED_ON_BOOT: 'TRUE' }).reseedOnBoot).toBe(true);
      expect(loadConfig({ RESEED_ON_BOOT: 'false' }).reseedOnBoot).toBe(false);
      expect(loadConfig({ RESEED_ON_BOOT: 'random' }).reseedOnBoot).toBe(false);
      expect(loadConfig({}).reseedOnBoot).toBe(false);
    });
  });

  describe('Express Trust Proxy Configuration', () => {
    it('should default to false when TRUST_PROXY is omitted or empty', () => {
      expect(loadConfig({}).trustProxy).toBe(false);
      expect(loadConfig({ TRUST_PROXY: '' }).trustProxy).toBe(false);
      expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    });

    it('should parse boolean true when TRUST_PROXY is "true"', () => {
      expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
      expect(loadConfig({ TRUST_PROXY: ' TRUE ' }).trustProxy).toBe(true);
    });

    it('should parse numeric hop count when TRUST_PROXY is an integer', () => {
      expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
      expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    });

    it('should preserve custom string when TRUST_PROXY is a subnet or CIDR', () => {
      expect(loadConfig({ TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
      expect(loadConfig({ TRUST_PROXY: '10.0.0.0/8' }).trustProxy).toBe('10.0.0.0/8');
      expect(loadConfig({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toBe('loopback, 10.0.0.0/8');
    });
  });

  describe('Telegram Configuration Validation', () => {
    it('defaults to disabled mode with undefined credentials', () => {
      const config = loadConfig({});
      expect(config.telegramMode).toBe('disabled');
      expect(config.telegramBotToken).toBeUndefined();
    });

    it('requires TELEGRAM_BOT_TOKEN when TELEGRAM_MODE is webhook', () => {
      expect(() =>
        loadConfig({
          TELEGRAM_MODE: 'webhook',
        })
      ).toThrow(ConfigError);
    });

    it('accepts valid webhook configuration with token, secret and username', () => {
      const config = loadConfig({
        TELEGRAM_MODE: 'webhook',
        TELEGRAM_BOT_TOKEN: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        TELEGRAM_BOT_USERNAME: '@PayGuardBot',
        TELEGRAM_WEBHOOK_SECRET: 'secret_webhook_token_123',
      });

      expect(config.telegramMode).toBe('webhook');
      expect(config.telegramBotToken).toBe('123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11');
      expect(config.telegramBotUsername).toBe('PayGuardBot'); // Stripped leading @
      expect(config.telegramWebhookSecret).toBe('secret_webhook_token_123');
    });

    it('rejects unsupported polling mode', () => {
      expect(() =>
        loadConfig({
          TELEGRAM_MODE: 'polling',
          TELEGRAM_BOT_TOKEN: 'valid-token',
        })
      ).toThrow(ConfigError);
    });

    it('rejects invalid TELEGRAM_WEBHOOK_SECRET containing illegal characters', () => {
      expect(() =>
        loadConfig({
          TELEGRAM_MODE: 'webhook',
          TELEGRAM_BOT_TOKEN: 'valid-token',
          TELEGRAM_WEBHOOK_SECRET: 'illegal secret with spaces!',
        })
      ).toThrow(ConfigError);
    });
  });

  describe('Singleton and Process Environment Integration', () => {
    it('should load from process.env via getConfig()', () => {
      process.env.PORT = '9090';
      process.env.NODE_ENV = 'test';

      const config = getConfig();
      expect(config.port).toBe(9090);
      expect(config.nodeEnv).toBe('test');
      expect(config.isTest).toBe(true);
    });

    it('should cache configuration on subsequent getConfig() calls', () => {
      process.env.PORT = '5001';
      const first = getConfig();
      expect(first.port).toBe(5001);

      process.env.PORT = '5002';
      const second = getConfig();
      expect(second.port).toBe(5001); // Still cached
      expect(second).toBe(first);
    });

    it('should re-read process.env after resetConfig() is called', () => {
      process.env.PORT = '5001';
      const first = getConfig();
      expect(first.port).toBe(5001);

      resetConfig();
      process.env.PORT = '5002';
      const second = getConfig();
      expect(second.port).toBe(5002); // Re-loaded
    });
  });
});
