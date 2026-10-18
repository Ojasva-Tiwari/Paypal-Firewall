import { describe, it, expect } from 'vitest';
import { getProjectInfo, PAYGUARD_VERSION, PROJECT_NAME } from '../../src/index.js';

describe('PayGuard Smoke Test (Milestone M0)', () => {
  it('should verify project info without credentials or network calls', () => {
    const info = getProjectInfo();
    expect(info.name).toBe('PayGuard');
    expect(info.version).toBe('0.1.0');
    expect(info.milestone).toBe('M0');
  });

  it('should verify constant definitions are intact', () => {
    expect(PROJECT_NAME).toBe('PayGuard');
    expect(PAYGUARD_VERSION).toBe('0.1.0');
  });

  it('should run in a deterministic environment without network calls', () => {
    // Assert no PayPal or AI credentials are required for unit tests
    expect(process.env.PAYPAL_SECRET).toBeUndefined();
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
  });
});
