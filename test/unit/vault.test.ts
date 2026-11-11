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
import {
  runOnboardingWorkflow,
  revokeLocalVendorVaultToken,
} from '../../demo/onboardVault.js';

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
          id: 'tok-sandbox-example-0001',
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

      expect(result.id).toBe('tok-sandbox-example-0001');
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
      expect(maskTokenId('tok-sandbox-example-0001')).toBe('********************0001');
      expect(maskTokenId('1234')).toBe('****');
      expect(maskTokenId('')).toBe('****');
    });

    it('10b. deletePaymentToken: encodes path parameter and succeeds on HTTP 204', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, {
          status: 204,
          headers: {
            'paypal-debug-id': 'dbg-del-204',
          },
        })
      );

      const result = await vaultService.deletePaymentToken('tok/with?special');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url.toString()).toBe('https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/tok%2Fwith%3Fspecial');
      expect(init?.method).toBe('DELETE');
      expect(result).toEqual({
        deleted: true,
        status: 204,
        debugId: 'dbg-del-204',
      });
    });

    it('10c. deletePaymentToken: preserves status and debugId on 404/error and rejects empty ID', async () => {
      await expect(vaultService.deletePaymentToken('   ')).rejects.toMatchObject({
        code: 'INVALID_PARAMETER',
      });

      mockFetch.mockResolvedValueOnce(
        createJsonResponse(
          {
            name: 'RESOURCE_NOT_FOUND',
            message: 'The specified resource does not exist.',
          },
          404,
          'dbg-del-404'
        )
      );

      let caughtError: VaultError | undefined;
      try {
        await vaultService.deletePaymentToken('tok-missing-999');
      } catch (err) {
        if (err instanceof VaultError) {
          caughtError = err;
        }
      }

      expect(caughtError).toBeDefined();
      expect(caughtError?.status).toBe(404);
      expect(caughtError?.debugId).toBe('dbg-del-404');
      expect(caughtError?.message).toContain('debug_id: dbg-del-404');
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

    it('20. revokeLocalVendorVaultToken marks active token REVOKED with audit entry and fails closed when absent', () => {
      seedVendor('ven-acme');

      const missing = revokeLocalVendorVaultToken(db, repos, {
        vendorId: 'ven-acme',
        reason: 'rotation_test',
      });
      expect(missing.success).toBe(false);
      expect(missing.error).toMatch(/No active vaulted token/);

      repos.vendorVaultTokens.insert({
        id: 'vtok-rev-1',
        vendor_id: 'ven-acme',
        paypal_customer_ref: 'cust-rev',
        vault_token_id: 'tok-sandbox-example-0001',
        status: 'VAULTED',
        created_at: new Date().toISOString(),
      });

      const revoked = revokeLocalVendorVaultToken(db, repos, {
        vendorId: 'ven-acme',
        reason: 'credential_exposure_remediation',
        actor: 'owner',
      });

      expect(revoked.success).toBe(true);
      expect(revoked.revokedRowId).toBe('vtok-rev-1');
      expect(revoked.maskedTokenId).toBe('********************0001');
      expect(repos.vendorVaultTokens.getByVendorId('ven-acme')).toBeUndefined();

      const allRows = repos.vendorVaultTokens.listByVendorId('ven-acme');
      expect(allRows).toHaveLength(1);
      expect(allRows[0]?.status).toBe('REVOKED');

      const lastAudit = repos.auditLog.getLastEntry();
      expect(lastAudit?.event).toBe('vault_token_revoked');
      const payload = JSON.parse(lastAudit?.payload ?? '{}');
      expect(payload.vault_token_id_masked).toBe('********************0001');
      expect(payload.reason).toBe('credential_exposure_remediation');
      expect(JSON.stringify(payload)).not.toContain('tok-sandbox-example-0001');
      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });

    it('21. --replace with --setup-only preserves existing active token while creating replacement setup token', async () => {
      seedVendor('ven-acme');
      repos.vendorVaultTokens.insert({
        id: 'vtok-orig-1',
        vendor_id: 'ven-acme',
        paypal_customer_ref: 'cust-orig',
        vault_token_id: 'tok-sandbox-example-0001',
        status: 'VAULTED',
        created_at: new Date().toISOString(),
      });

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'setup-replace-001',
          status: 'CREATED',
          links: [{ href: 'https://www.sandbox.paypal.com/approve-replace', rel: 'approve' }],
        }, 201)
      );

      const result = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'ven-acme',
        setupOnly: true,
        replaceExisting: true,
      });

      expect(result.success).toBe(true);
      expect(result.setupTokenId).toBe('setup-replace-001');
      expect(result.approvalUrl).toBe('https://www.sandbox.paypal.com/approve-replace');
      expect(repos.vendorVaultTokens.getByVendorId('ven-acme')?.id).toBe('vtok-orig-1');
      expect(repos.vendorVaultTokens.getByVendorId('ven-acme')?.status).toBe('VAULTED');
      expect(repos.auditLog.getLastEntry()).toBeUndefined();
    });

    it('22. --replace with --confirm atomically revokes prior token and stores replacement', async () => {
      seedVendor('ven-acme');
      repos.vendorVaultTokens.insert({
        id: 'vtok-old-1',
        vendor_id: 'ven-acme',
        paypal_customer_ref: 'cust-old',
        vault_token_id: 'tok-sandbox-example-0001',
        status: 'VAULTED',
        created_at: '2026-10-29T00:00:00.000Z',
      });

      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'tok-sandbox-replacement-9999',
          status: 'CREATED',
          customer: { id: 'cust-new' },
          payment_source: { paypal: { email_address: 'new-buyer@example.com' } },
        }, 201)
      );

      const result = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'ven-acme',
        confirmSetupTokenId: 'setup-replace-002',
        replaceExisting: true,
      });

      expect(result.success).toBe(true);
      expect(result.replacedRowId).toBe('vtok-old-1');
      expect(result.paymentTokenId).toBe('tok-sandbox-replacement-9999');

      const active = repos.vendorVaultTokens.getByVendorId('ven-acme');
      expect(active?.vault_token_id).toBe('tok-sandbox-replacement-9999');
      expect(active?.paypal_customer_ref).toBe('cust-new');

      const history = repos.vendorVaultTokens.listByVendorId('ven-acme');
      expect(history).toHaveLength(2);
      expect(history.find((t) => t.id === 'vtok-old-1')?.status).toBe('REVOKED');

      const audits = repos.auditLog.list({ limit: 10 });
      expect(audits.map((a) => a.event)).toEqual(['vault_token_created', 'vault_token_revoked']);
      const createdPayload = JSON.parse(audits[0]!.payload);
      expect(createdPayload.replaced_row_id).toBe('vtok-old-1');
      expect(verifyDatabaseAuditChain(db).valid).toBe(true);
    });

    it('23. --replace rejects reusing an existing or revoked token ID and rolls back DB failures cleanly', async () => {
      seedVendor('ven-acme');
      repos.vendorVaultTokens.insert({
        id: 'vtok-revoked-prior',
        vendor_id: 'ven-acme',
        paypal_customer_ref: 'cust-1',
        vault_token_id: 'tok-sandbox-example-0001',
        status: 'REVOKED',
        created_at: '2026-10-29T00:00:00.000Z',
      });
      repos.vendorVaultTokens.insert({
        id: 'vtok-active-now',
        vendor_id: 'ven-acme',
        paypal_customer_ref: 'cust-2',
        vault_token_id: 'tok-sandbox-example-0002',
        status: 'VAULTED',
        created_at: '2026-10-30T00:00:00.000Z',
      });

      // PayPal returns previously REVOKED token ID -> must fail closed and preserve active row
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'tok-sandbox-example-0001',
          status: 'VAULTED',
          customer: { id: 'cust-1' },
        }, 201)
      );

      const reuseResult = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'ven-acme',
        confirmSetupTokenId: 'setup-reuse',
        replaceExisting: true,
      });

      expect(reuseResult.success).toBe(false);
      expect(reuseResult.error).toMatch(/matches an existing or previously revoked token/);
      expect(repos.vendorVaultTokens.getByVendorId('ven-acme')?.id).toBe('vtok-active-now');
      expect(repos.auditLog.getLastEntry()).toBeUndefined();

      // DB insert failure during --replace must roll back the REVOKED update and audit entry
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 'tok-sandbox-fresh-0004',
          status: 'CREATED',
          customer: { id: 'cust-3' },
        }, 201)
      );
      const insertSpy = vi.spyOn(repos.vendorVaultTokens, 'insert').mockImplementationOnce(() => {
        throw new Error('Simulated Replacement Insert Error');
      });

      const failResult = await runOnboardingWorkflow({
        db,
        repos,
        vaultService,
        vendorId: 'ven-acme',
        confirmSetupTokenId: 'setup-rollback',
        replaceExisting: true,
      });

      insertSpy.mockRestore();

      expect(failResult.success).toBe(false);
      expect(failResult.error).toMatch(/Simulated Replacement Insert Error/);
      const activeAfterRollback = repos.vendorVaultTokens.getByVendorId('ven-acme');
      expect(activeAfterRollback?.id).toBe('vtok-active-now');
      expect(activeAfterRollback?.status).toBe('VAULTED');
      expect(repos.auditLog.getLastEntry()).toBeUndefined();
    });
  });
});
