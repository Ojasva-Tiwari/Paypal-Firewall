/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T3: Unit Tests for PayPal Vault Service & Sandbox Onboarding
 *
 * Verifies:
 * 1. Setup-token creation sends correct endpoint, headers, and request body.
 * 2. Setup-token response parsing extracts approval URL correctly.
 * 3. Missing required setup-token fields produce safe VaultError.
 * 4. Setup confirmation sends correct token-exchange request.
 * 5. Missing payment-token ID produces safe VaultError.
 * 6. Payment-token retrieval encodes path parameter and parses response.
 * 7. Token listing uses canonical customer_id query parameter.
 * 8. PayPal errors mapped safely into VaultError preserving debug_id.
 * 9. Secrets and credentials do not leak into exposed errors.
 * 10. Missing vendor parameter fails closed.
 * 11. Unknown vendor (not in DB) fails closed without auto-seeding.
 * 12. Existing Vault token prevents duplicate onboarding.
 * 13. Setup-only mode does not create DB record or claim completion.
 * 14. Successful confirmation persists token and audit row atomically.
 * 15. Database write failure triggers transaction rollback and reports failure.
 * 16. Repeated onboarding does not silently overwrite tokens.
 * 17. Sandbox restrictions and production refusal are enforced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PayPalVaultService,
  VaultError,
  maskTokenId,
} from '../../src/paypal/vault.js';
import {
  PayPalHttpClient,
} from '../../src/paypal/http.js';
import {
  TokenManager,
  type FetchFunction,
} from '../../src/paypal/tokenManager.js';
import {
  createDatabase,
  runMigrations,
  type Database,
} from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { verifyDatabaseAuditChain } from '../../src/core/stateMachine.js';
import { runOnboardingWorkflow } from '../../demo/onboardVault.js';

describe('M2-T3: PayPal Vault Service & Onboarding', () => {
  let mockFetch: ReturnType<typeof vi.fn<FetchFunction>>;
  let tokenManager: TokenManager;
  let client: PayPalHttpClient;
  let vaultService: PayPalVaultService;
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    mockFetch = vi.fn<FetchFunction>();

    tokenManager = new TokenManager({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      credentialResolver: () => ({
        clientId: 'mock-client-id',
        clientSecret: 'mock-client-secret',
      }),
      fetchFn: async () => {
        return new Response(
          JSON.stringify({
            access_token: 'mock-access-token-12345',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    client = new PayPalHttpClient({
      baseUrl: 'https://api-m.sandbox.paypal.com',
      tokenManager,
      fetchFn: mockFetch,
      defaultConnectorKey: 'acme_cloud',
      getRetryDelayMs: () => 0,
    });

    vaultService = new PayPalVaultService({
      client,
      defaultConnectorKey: 'acme_cloud',
    });

    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);
  });

  afterEach(() => {
    if (db.open) {
      db.close();
    }
  });

  function createJsonResponse(data: unknown, status = 200, debugId = 'dbg-vault-123') {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'paypal-debug-id': debugId,
      },
    });
  }

  // ==========================================================================
  // Part 1: PayPal Vault Service Unit Tests
  // ==========================================================================

  describe('PayPalVaultService', () => {
    it('1. createSetupToken: sends correct endpoint, headers, and request body', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'setup-tok-001',
          status: 'CREATED',
          customer: { id: 'cust-123' },
          links: [
            { href: 'https://www.sandbox.paypal.com/agreements/approve?ba_token=setup-tok-001', rel: 'approve', method: 'GET' },
          ],
        }, 201)
      );

      const result = await vaultService.createSetupToken({
        connectorKey: 'acme_cloud',
        idempotencyKey: 'idem-setup-1',
        description: 'Test Setup Description',
        brandName: 'Test Brand',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;

      expect(url.toString()).toBe('https://api-m.sandbox.paypal.com/v3/vault/setup-tokens');
      expect(init?.method).toBe('POST');

      const headers = init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer mock-access-token-12345');
      expect(headers['PayPal-Request-Id']).toBe('idem-setup-1');
      expect(headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(init?.body as string);
      expect(body.payment_source.paypal.description).toBe('Test Setup Description');
      expect(body.payment_source.paypal.experience_context.brand_name).toBe('Test Brand');
      expect(body.payment_source.paypal.usage_pattern).toBe('IMMEDIATE');
      expect(body.payment_source.paypal.usage_type).toBe('MERCHANT');

      expect(result.id).toBe('setup-tok-001');
      expect(result.status).toBe('CREATED');
      expect(result.approvalUrl).toBe('https://www.sandbox.paypal.com/agreements/approve?ba_token=setup-tok-001');
      expect(result.customerId).toBe('cust-123');
    });

    it('2. createSetupToken: extracts approval URL correctly from links', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'setup-tok-002',
          status: 'CREATED',
          links: [
            { href: 'https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/setup-tok-002', rel: 'self', method: 'GET' },
            { href: 'https://www.sandbox.paypal.com/approval-link-target', rel: 'approve', method: 'GET' },
          ],
        })
      );

      const result = await vaultService.createSetupToken();
      expect(result.approvalUrl).toBe('https://www.sandbox.paypal.com/approval-link-target');
    });

    it('3. createSetupToken: missing required setup-token fields produces safe VaultError', async () => {
      // Missing links array
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'setup-tok-no-links',
          status: 'CREATED',
        })
      );

      await expect(vaultService.createSetupToken()).rejects.toThrow(/approve link/);

      // Missing id
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          status: 'CREATED',
          links: [{ href: 'https://example.com/approve', rel: 'approve' }],
        })
      );

      await expect(vaultService.createSetupToken()).rejects.toThrow(/missing id/);
    });

    it('4. confirmSetup: sends correct token-exchange request body and idempotency key', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: '69266860j82772632',
          status: 'VAULTED',
          customer: { id: 'cust-xyz' },
          payment_source: {
            paypal: {
              email_address: 'buyer@example.com',
              account_id: 'ACC123',
              name: { given_name: 'John', surname: 'Doe' },
            },
          },
        }, 201)
      );

      const result = await vaultService.confirmSetup({
        setupTokenId: 'setup-tok-999',
        idempotencyKey: 'idem-confirm-1',
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;

      expect(url.toString()).toBe('https://api-m.sandbox.paypal.com/v3/vault/payment-tokens');
      expect(init?.method).toBe('POST');

      const headers = init?.headers as Record<string, string>;
      expect(headers['PayPal-Request-Id']).toBe('idem-confirm-1');

      const body = JSON.parse(init?.body as string);
      expect(body.payment_source.token.type).toBe('SETUP_TOKEN');
      expect(body.payment_source.token.id).toBe('setup-tok-999');

      expect(result.id).toBe('69266860j82772632');
      expect(result.status).toBe('VAULTED');
      expect(result.customerId).toBe('cust-xyz');
      expect(result.payerEmail).toBe('buyer@example.com');
      expect(result.payerAccountId).toBe('ACC123');
      expect(result.payerName?.givenName).toBe('John');
      expect(result.payerName?.surname).toBe('Doe');
    });

    it('5. confirmSetup: missing payment-token ID produces safe VaultError', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          status: 'CREATED',
          customer: { id: 'cust-xyz' },
        })
      );

      await expect(
        vaultService.confirmSetup({ setupTokenId: 'setup-123' })
      ).rejects.toThrow(/missing id/);
    });

    it('6. getPaymentToken: encodes path parameter and parses response', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'token-read-123',
          status: 'VAULTED',
          customer: { id: 'cust-abc' },
          payment_source: {
            paypal: { email_address: 'payer@example.com' },
          },
        })
      );

      const result = await vaultService.getPaymentToken('token/with-special-chars?');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0]!;
      expect(url.toString()).toContain('/v3/vault/payment-tokens/token%2Fwith-special-chars%3F');
      expect(result.id).toBe('token-read-123');
      expect(result.payerEmail).toBe('payer@example.com');
    });

    it('7. listTokens: uses canonical customer_id query parameter and validates response', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          total_items: 2,
          total_pages: 1,
          payment_tokens: [
            {
              id: 'tok-1',
              status: 'VAULTED',
              customer: { id: 'cust-99' },
            },
            {
              id: 'tok-2',
              status: 'VAULTED',
              customer: { id: 'cust-99' },
            },
          ],
        })
      );

      const result = await vaultService.listTokens({
        customerId: 'cust-99',
        pageSize: 10,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0]!;
      const parsedUrl = new URL(url.toString());
      expect(parsedUrl.pathname).toBe('/v3/vault/payment-tokens');
      expect(parsedUrl.searchParams.get('customer_id')).toBe('cust-99');
      expect(parsedUrl.searchParams.get('page_size')).toBe('10');

      expect(result.totalItems).toBe(2);
      expect(result.paymentTokens.length).toBe(2);
      expect(result.paymentTokens[0]?.id).toBe('tok-1');
      expect(result.paymentTokens[1]?.id).toBe('tok-2');
    });

    it('8. listTokens: missing customerId throws VaultError validation', async () => {
      await expect(
        vaultService.listTokens({ customerId: '' })
      ).rejects.toThrow(VaultError);
      await expect(
        vaultService.listTokens({ customerId: '   ' })
      ).rejects.toThrow(/customerId is required/);
    });

    it('9. PayPal errors are mapped safely into VaultError preserving debugId', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse(
          {
            name: 'INVALID_REQUEST',
            message: 'Mandatory field missing',
            details: [{ issue: 'INVALID_PARAMETER_VALUE', description: 'Invalid value' }],
          },
          400,
          'dbg-paypal-err-99'
        )
      );

      let caughtError: VaultError | undefined;
      try {
        await vaultService.createSetupToken();
      } catch (err) {
        if (err instanceof VaultError) {
          caughtError = err;
        }
      }

      expect(caughtError).toBeDefined();
      expect(caughtError?.debugId).toBe('dbg-paypal-err-99');
      expect(caughtError?.message).toContain('debug_id: dbg-paypal-err-99');
    });

    it('10. Secrets and credentials do not leak into exposed errors', async () => {
      mockFetch.mockRejectedValue(
        new Error('Network failure exposing Bearer mock-access-token-12345')
      );

      let caughtError: VaultError | undefined;
      try {
        await vaultService.createSetupToken();
      } catch (err) {
        if (err instanceof VaultError) {
          caughtError = err;
        }
      }

      expect(caughtError).toBeDefined();
      expect(caughtError?.message).not.toContain('mock-access-token-12345');
      expect(caughtError?.message).toContain('[REDACTED]');
    });

    it('maskTokenId correctly masks sensitive token identifiers', () => {
      expect(maskTokenId('69266860j82772632')).toBe('*************2632');
      expect(maskTokenId('1234')).toBe('****');
      expect(maskTokenId('')).toBe('****');
    });
  });

  // ==========================================================================
  // Part 2: Sandbox Onboarding Workflow Unit Tests
  // ==========================================================================

  describe('runOnboardingWorkflow', () => {
    function seedVendor(vendorId: string, name = 'Acme Cloud'): void {
      repos.vendors.insert({
        id: vendorId,
        name,
        status: 'ACTIVE',
        categories: JSON.stringify(['cloud', 'hosting']),
        currencies: JSON.stringify(['USD']),
        connector_key: 'acme_cloud',
        created_at: new Date().toISOString(),
      });
    }

    it('11. Missing vendor parameter fails closed with descriptive error', async () => {
      const result = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Vendor ID must be explicitly specified/);
    });

    it('12. Unknown vendor (not in DB) fails closed without auto-seeding', async () => {
      const result = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'non-existent-vendor',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Vendor 'non-existent-vendor' not found/);
      expect(repos.vendors.getById('non-existent-vendor')).toBeUndefined();
    });

    it('13. Existing Vault token prevents duplicate onboarding (does not overwrite)', async () => {
      seedVendor('ven-acme');
      repos.vendorVaultTokens.insert({
        id: 'vtok-existing-1',
        vendor_id: 'ven-acme',
        paypal_customer_ref: 'cust-1',
        vault_token_id: 'existing-vault-token-id',
        status: 'VAULTED',
        created_at: new Date().toISOString(),
      });

      const result = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'ven-acme',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already has a vaulted token/);
      expect(result.error).toMatch(/Token replacement is not supported/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('14. Setup-only mode does not create DB record or claim completion', async () => {
      seedVendor('ven-acme');

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'setup-tok-setup-only',
          status: 'CREATED',
          links: [{ href: 'https://www.sandbox.paypal.com/approve-setup', rel: 'approve' }],
        }, 201)
      );

      const result = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'ven-acme',
        setupOnly: true,
      });

      expect(result.success).toBe(true);
      expect(result.setupTokenId).toBe('setup-tok-setup-only');
      expect(result.approvalUrl).toBe('https://www.sandbox.paypal.com/approve-setup');
      expect(result.paymentTokenId).toBeUndefined();

      // Verify no DB row inserted in vendor_vault_tokens
      expect(repos.vendorVaultTokens.getByVendorId('ven-acme')).toBeUndefined();
    });

    it('15. Successful confirmation persists token and audit row atomically', async () => {
      seedVendor('ven-acme');

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'perm-token-987654',
          status: 'VAULTED',
          customer: { id: 'cust-verified' },
          payment_source: {
            paypal: { email_address: 'sb-buyer@example.com' },
          },
        }, 201)
      );

      const result = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'ven-acme',
        confirmSetupTokenId: 'setup-tok-already-approved',
      });

      expect(result.success).toBe(true);
      expect(result.paymentTokenId).toBe('perm-token-987654');

      // Verify DB record
      const row = repos.vendorVaultTokens.getByVendorId('ven-acme');
      expect(row).toBeDefined();
      expect(row?.vault_token_id).toBe('perm-token-987654');
      expect(row?.status).toBe('VAULTED');
      expect(row?.paypal_customer_ref).toBe('cust-verified');

      // Verify audit log entry
      const lastAudit = repos.auditLog.getLastEntry();
      expect(lastAudit).toBeDefined();
      expect(lastAudit?.event).toBe('vault_token_created');
      expect(lastAudit?.actor).toBe('owner');

      const payload = JSON.parse(lastAudit?.payload ?? '{}');
      expect(payload.vendor_id).toBe('ven-acme');
      expect(payload.vault_token_id_masked).toBe('*************7654');

      // Verify entire hash chain integrity
      const chainCheck = verifyDatabaseAuditChain(db);
      expect(chainCheck.valid).toBe(true);
    });

    it('16. Interactive flow prompts user and persists on confirmation', async () => {
      seedVendor('ven-acme');

      // 1. Setup token creation response
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'setup-interactive-123',
          status: 'CREATED',
          links: [{ href: 'https://sandbox.paypal.com/approve-link', rel: 'approve' }],
        }, 201)
      );

      // 2. Token confirmation response
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'interactive-token-id-555',
          status: 'VAULTED',
          customer: { id: 'cust-interactive' },
        }, 201)
      );

      let promptWasCalled = false;
      const mockPrompt = vi.fn().mockImplementation(async () => {
        promptWasCalled = true;
        return '';
      });

      const result = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'ven-acme',
        promptFn: mockPrompt,
      });

      expect(promptWasCalled).toBe(true);
      expect(result.success).toBe(true);
      expect(result.setupTokenId).toBe('setup-interactive-123');
      expect(result.paymentTokenId).toBe('interactive-token-id-555');

      const row = repos.vendorVaultTokens.getByVendorId('ven-acme');
      expect(row?.vault_token_id).toBe('interactive-token-id-555');
    });

    it('17. Database failure triggers rollback and reports failure without misleading success', async () => {
      seedVendor('ven-acme');

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'token-db-fail-999',
          status: 'VAULTED',
          customer: { id: 'cust-fail' },
        }, 201)
      );

      // Force repos.vendorVaultTokens.insert to throw inside the transaction
      const insertSpy = vi.spyOn(repos.vendorVaultTokens, 'insert').mockImplementationOnce(() => {
        throw new Error('Simulated SQLite Disk Failure');
      });

      const result = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'ven-acme',
        confirmSetupTokenId: 'setup-any',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Database persistence failed: Simulated SQLite Disk Failure/);

      // Verify no row was persisted
      expect(repos.vendorVaultTokens.getByVendorId('ven-acme')).toBeUndefined();

      // Verify no orphan audit row was left
      const lastAudit = repos.auditLog.getLastEntry();
      expect(lastAudit).toBeUndefined();

      insertSpy.mockRestore();
    });

    it('18. Repeated onboarding does not silently overwrite an existing token', async () => {
      seedVendor('ven-acme');

      repos.vendorVaultTokens.insert({
        id: 'row-tok-1',
        vendor_id: 'ven-acme',
        paypal_customer_ref: 'cust-1',
        vault_token_id: 'initial-token-111',
        status: 'VAULTED',
        created_at: new Date().toISOString(),
      });

      const result = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'ven-acme',
        confirmSetupTokenId: 'some-new-setup-token',
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already has a vaulted token/);

      // Original token remained intact
      const row = repos.vendorVaultTokens.getByVendorId('ven-acme');
      expect(row?.vault_token_id).toBe('initial-token-111');
    });

    it('19. Sandbox restrictions: refuses production URL without ALLOW_PRODUCTION=true', () => {
      expect(() => {
        new PayPalHttpClient({
          baseUrl: 'https://api-m.paypal.com', // Production URL
          tokenManager,
        });
      }).toThrow(/Production PayPal URL is strictly refused/);
    });
  });
});
