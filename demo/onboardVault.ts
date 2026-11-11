/**
 * PayGuard — Milestone M2: PayPal Gateway
 * M2-T3: Sandbox Vault Onboarding Workflow
 *
 * Implements:
 * - A testable, headless-capable and interactive onboarding workflow
 * - Strict requirement for an explicitly supplied, already-existing vendor
 * - Prevention of duplicate or silent token replacement
 * - Atomic persistence of vendor_vault_tokens and hash-chained audit_log entries via runInTransaction
 * - Support for --setup-only and --confirm <setupTokenId> modes
 * - Strict credential and access token redaction (masked token IDs)
 * - Hard Rule 1: Sandbox only. Production is strictly refused unless ALLOW_PRODUCTION=true.
 */

import * as crypto from 'node:crypto';
import * as readline from 'node:readline';
import type { Database } from '../src/db/connection.js';
import { runInTransaction, createDatabase } from '../src/db/connection.js';
import { Repositories } from '../src/db/repositories.js';
import type { VendorVaultTokenRow } from '../src/db/types.js';
import { writeAuditLogEntry } from '../src/core/stateMachine.js';
import { PayPalVaultService, maskTokenId } from '../src/paypal/vault.js';
import { TokenManager } from '../src/paypal/tokenManager.js';
import { PayPalHttpClient } from '../src/paypal/http.js';
import { getConfig } from '../src/config/index.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface OnboardWorkflowOptions {
  readonly db: Database;
  readonly repos: Repositories;
  readonly vaultService: PayPalVaultService;
  readonly vendorId: string;
  readonly connectorKey?: string;
  readonly setupOnly?: boolean;
  readonly confirmSetupTokenId?: string;
  readonly replaceExisting?: boolean;
  readonly promptFn?: (query: string) => Promise<string>;
  readonly logger?: {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface OnboardWorkflowResult {
  readonly success: boolean;
  readonly setupTokenId?: string;
  readonly approvalUrl?: string;
  readonly paymentTokenId?: string;
  readonly vaultTokenRowId?: string;
  readonly replacedRowId?: string;
  readonly error?: string;
}

export interface RevokeLocalTokenResult {
  readonly success: boolean;
  readonly revokedRowId?: string;
  readonly maskedTokenId?: string;
  readonly error?: string;
}

// ============================================================================
// Core Workflow Function
// ============================================================================

/**
 * Executes the canonical Sandbox Vault onboarding workflow.
 *
 * Invariants:
 * 1. Vendor must explicitly exist in the database; will not auto-create or seed.
 * 2. If vendor already has a vault token, stops without replacement (replacement semantics are undefined).
 * 3. In setup-only mode, returns setupTokenId and approvalUrl without persisting payment tokens.
 * 4. In confirmation mode, exchanges setup-token, inserts vendor_vault_tokens, and writes audit_log atomically.
 * 5. Fails safely on any error, rolling back the transaction.
 */
export async function runOnboardingWorkflow(
  options: OnboardWorkflowOptions
): Promise<OnboardWorkflowResult> {
  const logger = options.logger ?? console;
  const vendorId = options.vendorId?.trim();

  // 1. Validate required explicit vendor ID
  if (!vendorId) {
    const errorMsg = 'Vendor ID must be explicitly specified';
    logger.error(`[OnboardVault] Error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  // 2. Confirm vendor exists in repository (fail closed if missing)
  const vendor = options.repos.vendors.getById(vendorId);
  if (!vendor) {
    const errorMsg = `Vendor '${vendorId}' not found in registry. Vendors must be created explicitly before onboarding.`;
    logger.error(`[OnboardVault] Error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  // 3. Check if vendor already has an active Vault token (prevent duplicate / silent replacement)
  const existingToken = options.repos.vendorVaultTokens.getByVendorId(vendorId);
  if (existingToken && !options.replaceExisting) {
    const errorMsg = `Vendor '${vendorId}' already has a vaulted token (row: ${existingToken.id}, token: ${maskTokenId(existingToken.vault_token_id)}). Token replacement is not supported by default; pass --replace to revoke and replace.`;
    logger.warn(`[OnboardVault] Warning: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  const connectorKey = options.connectorKey ?? vendor.connector_key;

  // 4. Branch: Confirmation mode with existing setupTokenId
  if (options.confirmSetupTokenId) {
    const setupTokenId = options.confirmSetupTokenId.trim();
    logger.log(`[OnboardVault] Exchanging setup token ${maskTokenId(setupTokenId)} for permanent payment token...`);

    let paymentToken;
    try {
      paymentToken = await options.vaultService.confirmSetup({
        setupTokenId,
        connectorKey,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[OnboardVault] Token exchange failed: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }

    return persistPaymentToken(options, vendorId, paymentToken);
  }

  // 5. Normal / Setup Flow: Create setup token
  logger.log(`[OnboardVault] Creating Vault setup token for vendor '${vendorId}' (connector: '${connectorKey}')...`);
  let setupResult;
  try {
    setupResult = await options.vaultService.createSetupToken({
      connectorKey,
      description: `PayGuard Vault Onboarding for Vendor ${vendor.name}`,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[OnboardVault] Setup token creation failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  logger.log('\n================================================================');
  logger.log(' PayGuard Vault Sandbox Onboarding');
  logger.log('================================================================');
  logger.log(` Setup Token ID : ${maskTokenId(setupResult.id)}`);
  logger.log(` Status         : ${setupResult.status}`);
  logger.log(' Action Required: Open the approval link below in your browser');
  logger.log(' ------------------------------------------------------------');
  logger.log(` ${setupResult.approvalUrl}`);
  logger.log(' ------------------------------------------------------------\n');

  // If setup-only mode, return now without persisting or pretending payment token exists
  if (options.setupOnly) {
    logger.log('[OnboardVault] Setup-only mode: Setup token created. Re-run with --confirm <setupTokenId> after approval.');
    return {
      success: true,
      setupTokenId: setupResult.id,
      approvalUrl: setupResult.approvalUrl,
    };
  }

  // 6. Interactive approval prompt
  const promptFn = options.promptFn ?? defaultPromptUser;
  await promptFn('Press [Enter] after completing buyer approval in the browser to continue... ');

  // 7. Confirm setup
  logger.log(`\n[OnboardVault] Confirming setup token ${maskTokenId(setupResult.id)}...`);
  let paymentToken;
  try {
    paymentToken = await options.vaultService.confirmSetup({
      setupTokenId: setupResult.id,
      connectorKey,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[OnboardVault] Setup confirmation failed: ${errorMsg}`);
    return {
      success: false,
      setupTokenId: setupResult.id,
      approvalUrl: setupResult.approvalUrl,
      error: errorMsg,
    };
  }

  return persistPaymentToken(options, vendorId, paymentToken, setupResult.id, setupResult.approvalUrl);
}

/**
 * Atomically marks the active vault token for a vendor as REVOKED and appends a hash-chained audit entry.
 * Fails closed if no active token exists.
 */
export function revokeLocalVendorVaultToken(
  db: Database,
  repos: Repositories,
  params: {
    readonly vendorId: string;
    readonly reason: string;
    readonly actor?: 'owner' | 'system';
  }
): RevokeLocalTokenResult {
  const vendorId = params.vendorId.trim();
  if (!vendorId) {
    return { success: false, error: 'Vendor ID must be explicitly specified' };
  }

  return runInTransaction(db, () => {
    const activeToken = repos.vendorVaultTokens.getByVendorId(vendorId);
    if (!activeToken) {
      return {
        success: false,
        error: `No active vaulted token found for vendor '${vendorId}'`,
      };
    }

    repos.vendorVaultTokens.updateStatus(activeToken.id, 'REVOKED');
    const maskedTokenId = maskTokenId(activeToken.vault_token_id);

    writeAuditLogEntry(db, repos, {
      actor: params.actor ?? 'owner',
      event: 'vault_token_revoked',
      requestId: null,
      payload: {
        vendor_id: vendorId,
        vault_token_row_id: activeToken.id,
        paypal_customer_ref: activeToken.paypal_customer_ref,
        vault_token_id_masked: maskedTokenId,
        reason: params.reason,
      },
    });

    return {
      success: true,
      revokedRowId: activeToken.id,
      maskedTokenId,
    };
  });
}

// ============================================================================
// Atomic Persistence Helper
// ============================================================================

function persistPaymentToken(
  options: OnboardWorkflowOptions,
  vendorId: string,
  paymentToken: {
    readonly id: string;
    readonly status: string;
    readonly customerId?: string;
    readonly payerEmail?: string;
  },
  setupTokenId?: string,
  approvalUrl?: string
): OnboardWorkflowResult {
  const logger = options.logger ?? console;
  const tokenRowId = `vtok-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const customerRef = paymentToken.customerId ?? paymentToken.payerEmail ?? 'sandbox-buyer';
  let replacedRowId: string | undefined;

  try {
    // Run DB revocation (if --replace), insert, and audit log(s) in one transaction
    runInTransaction(options.db, () => {
      // Re-verify vendor still exists
      const currentVendor = options.repos.vendors.getById(vendorId);
      if (!currentVendor) {
        throw new Error(`Vendor '${vendorId}' no longer exists in database`);
      }

      // Reject reusing any previously vaulted/revoked token ID for this vendor
      const priorTokens = options.repos.vendorVaultTokens.listByVendorId(vendorId);
      if (priorTokens.some((t) => t.vault_token_id === paymentToken.id)) {
        throw new Error(
          `Replacement token matches an existing or previously revoked token (${maskTokenId(paymentToken.id)}) for vendor '${vendorId}'`
        );
      }

      // Re-verify active token status inside transaction
      const currentToken = options.repos.vendorVaultTokens.getByVendorId(vendorId);
      if (currentToken) {
        if (!options.replaceExisting) {
          throw new Error(`Vendor '${vendorId}' already has a vaulted token`);
        }

        options.repos.vendorVaultTokens.updateStatus(currentToken.id, 'REVOKED');
        replacedRowId = currentToken.id;

        writeAuditLogEntry(options.db, options.repos, {
          actor: 'owner',
          event: 'vault_token_revoked',
          requestId: null,
          payload: {
            vendor_id: vendorId,
            vault_token_row_id: currentToken.id,
            paypal_customer_ref: currentToken.paypal_customer_ref,
            vault_token_id_masked: maskTokenId(currentToken.vault_token_id),
            reason: 'replaced_via_onboard_vault',
          },
        });
      }

      const tokenRow: VendorVaultTokenRow = {
        id: tokenRowId,
        vendor_id: vendorId,
        paypal_customer_ref: customerRef,
        vault_token_id: paymentToken.id,
        status: paymentToken.status ?? 'VAULTED',
        created_at: now,
      };

      options.repos.vendorVaultTokens.insert(tokenRow);

      // Audit log entry within same transaction
      writeAuditLogEntry(options.db, options.repos, {
        actor: 'owner',
        event: 'vault_token_created',
        requestId: null,
        payload: {
          vendor_id: vendorId,
          vault_token_row_id: tokenRowId,
          paypal_customer_ref: customerRef,
          vault_token_id_masked: maskTokenId(paymentToken.id),
          ...(replacedRowId ? { replaced_row_id: replacedRowId } : {}),
        },
      });
    });

    logger.log('\n================================================================');
    logger.log(' SUCCESS: Permanent Payment Token Vaulted and Persisted');
    logger.log('================================================================');
    logger.log(` Vendor ID        : ${vendorId}`);
    logger.log(` Payment Token    : ${maskTokenId(paymentToken.id)}`);
    logger.log(` Status           : ${paymentToken.status ?? 'VAULTED'}`);
    logger.log(` Customer Ref     : ${customerRef}`);
    logger.log(` Database Row ID  : ${tokenRowId}`);
    if (replacedRowId) {
      logger.log(` Replaced Row ID  : ${replacedRowId}`);
    }
    logger.log('================================================================\n');

    return {
      success: true,
      setupTokenId,
      approvalUrl,
      paymentTokenId: paymentToken.id,
      vaultTokenRowId: tokenRowId,
      replacedRowId,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[OnboardVault] Database persistence failed: ${errorMsg}`);
    return {
      success: false,
      setupTokenId,
      approvalUrl,
      error: `Database persistence failed: ${errorMsg}`,
    };
  }
}

// ============================================================================
// CLI Utilities
// ============================================================================

function defaultPromptUser(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * CLI Entrypoint
 */
async function main(): Promise<void> {
  const config = getConfig();

  // Safety Hard Rule 1: Refuse production
  if (config.paypalEnv === 'PRODUCTION' && !config.allowProduction) {
    console.error('[Error] Production PayPal environment is refused without ALLOW_PRODUCTION=true');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  let vendorId = '';
  let connectorKey: string | undefined;
  let confirmSetupTokenId: string | undefined;
  let setupOnly = false;
  let replaceExisting = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--vendor' && args[i + 1]) {
      vendorId = args[++i]!;
    } else if (arg === '--connector' && args[i + 1]) {
      connectorKey = args[++i]!;
    } else if (arg === '--confirm' && args[i + 1]) {
      confirmSetupTokenId = args[++i]!;
    } else if (arg === '--setup-only') {
      setupOnly = true;
    } else if (arg === '--replace') {
      replaceExisting = true;
    }
  }

  if (!vendorId) {
    console.error('\n[Error] Missing required --vendor <vendorId> parameter.');
    console.error('Usage:');
    console.error('  npx tsx demo/onboardVault.ts --vendor <vendorId> [--connector <connectorKey>] [--setup-only] [--confirm <setupTokenId>] [--replace]\n');
    process.exit(1);
  }

  const db = createDatabase();
  const repos = new Repositories(db);

  const tokenManager = new TokenManager({
    baseUrl: config.paypalBaseUrl,
    credentialResolver: () => {
      const clientId = config.connectorAcmeClientId;
      const clientSecret = config.connectorAcmeClientSecret;
      if (!clientId || !clientSecret) {
        throw new Error('Missing PayPal Sandbox credentials in environment (.env)');
      }
      return { clientId, clientSecret };
    },
  });

  const client = new PayPalHttpClient({
    baseUrl: config.paypalBaseUrl,
    tokenManager,
    defaultConnectorKey: connectorKey ?? 'acme_cloud',
  });

  const vaultService = new PayPalVaultService({
    client,
    defaultConnectorKey: connectorKey ?? 'acme_cloud',
  });

  const result = await runOnboardingWorkflow({
    db,
    repos,
    vaultService,
    vendorId,
    connectorKey,
    setupOnly,
    confirmSetupTokenId,
    replaceExisting,
  });

  if (!result.success) {
    process.exit(1);
  }
}

// Only invoke CLI runner if executed directly
if (process.argv[1] && process.argv[1].endsWith('onboardVault.ts')) {
  main().catch((err) => {
    console.error('[OnboardVault CLI Error]:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
