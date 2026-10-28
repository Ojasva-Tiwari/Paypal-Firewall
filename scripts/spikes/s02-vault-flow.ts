/**
 * PayGuard — Milestone M0: Foundations & Spikes
 * Spike S2: Validate PayPal Vault Flow End-to-End (Sandbox Only)
 *
 * Verifies that:
 * 1. Sandbox OAuth access token can be retrieved.
 * 2. Vault setup token can be created for payment_source.paypal.
 * 3. Human can approve the setup token using personal sandbox buyer account (payer country IN).
 * 4. Approved setup token can be exchanged for a permanent vault payment-token ID.
 *
 * SAFETY RULES:
 * - Sandbox endpoints ONLY (https://api-m.sandbox.paypal.com).
 * - Never log or commit client secrets, access tokens, or sensitive buyer details.
 * - No money is moved in this spike.
 */

import * as readline from 'node:readline';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

// Attempt to load .env if present using Node's built-in loader
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
} catch {
  // Ignore if .env is missing or cannot be loaded
}

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface VaultSetupTokenResponse {
  id: string;
  status: string;
  customer?: { id: string };
  links?: Array<{ href: string; rel: string; method: string }>;
}

interface VaultPaymentTokenResponse {
  id: string;
  customer?: { id: string };
  status: string;
  payment_source?: {
    paypal?: {
      email_address?: string;
      account_id?: string;
      name?: { given_name?: string; surname?: string };
    };
  };
  links?: Array<{ href: string; rel: string; method: string }>;
}

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.CONNECTOR_ACME_CLIENT_ID || process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.CONNECTOR_ACME_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('\n[Error] Missing PayPal Sandbox credentials.');
    console.error('Please configure CONNECTOR_ACME_CLIENT_ID and CONNECTOR_ACME_CLIENT_SECRET in .env (or environment).');
    console.error('Refer to .env.example for required variable names.\n');
    process.exit(1);
  }

  return { clientId, clientSecret };
}

async function getOAuthToken(clientId: string, clientSecret: string): Promise<string> {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${SANDBOX_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to obtain OAuth token [${response.status}]: ${errorText}`);
  }

  const data = (await response.json()) as OAuthTokenResponse;
  if (!data.access_token) {
    throw new Error('OAuth response did not contain access_token');
  }

  return data.access_token;
}

async function createSetupToken(accessToken: string): Promise<{ setupTokenId: string; approvalUrl: string; status: string }> {
  const requestId = `payguard-setup-${crypto.randomUUID()}`;
  const response = await fetch(`${SANDBOX_BASE_URL}/v3/vault/setup-tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify({
      payment_source: {
        paypal: {
          description: 'PayGuard Vault Sandbox Authorization',
          usage_pattern: 'IMMEDIATE',
          usage_type: 'MERCHANT',
          experience_context: {
            brand_name: 'PayGuard Demo',
            locale: 'en-US',
            return_url: 'https://example.com/return',
            cancel_url: 'https://example.com/cancel',
            user_action: 'CONTINUE',
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create Vault setup token [${response.status}]: ${errorText}`);
  }

  const data = (await response.json()) as VaultSetupTokenResponse;
  const approveLink = data.links?.find((l) => l.rel === 'approve');

  if (!approveLink || !approveLink.href) {
    throw new Error(`Setup token response did not contain an 'approve' link. Response: ${JSON.stringify(data)}`);
  }

  return {
    setupTokenId: data.id,
    approvalUrl: approveLink.href,
    status: data.status,
  };
}

async function exchangeSetupTokenForPaymentToken(accessToken: string, setupTokenId: string): Promise<VaultPaymentTokenResponse> {
  const requestId = `payguard-payment-token-${crypto.randomUUID()}`;
  const response = await fetch(`${SANDBOX_BASE_URL}/v3/vault/payment-tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify({
      payment_source: {
        token: {
          type: 'SETUP_TOKEN',
          id: setupTokenId,
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to exchange setup token for payment token [${response.status}]: ${errorText}`);
  }

  const data = (await response.json()) as VaultPaymentTokenResponse;
  return data;
}

function promptUser(query: string): Promise<string> {
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

async function main() {
  console.log('================================================================');
  console.log(' PayGuard Spike S2: PayPal Vault Flow (Sandbox Only)');
  console.log(' Target Endpoint Base: https://api-m.sandbox.paypal.com');
  console.log('================================================================\n');

  const args = process.argv.slice(2);
  const confirmArgIndex = args.indexOf('--confirm');
  const setupOnly = args.includes('--setup');

  const { clientId, clientSecret } = getCredentials();

  console.log('[1/4] Requesting OAuth 2.0 access token from sandbox...');
  const accessToken = await getOAuthToken(clientId, clientSecret);
  console.log('      OAuth access token retrieved successfully [REDACTED].\n');

  // If user passed --confirm <setupTokenId>, execute only the exchange step
  if (confirmArgIndex !== -1 && args[confirmArgIndex + 1]) {
    const setupTokenId = args[confirmArgIndex + 1]!;
    console.log(`[Exchange] Exchanging existing setup token ID: ${setupTokenId}...`);
    const paymentTokenData = await exchangeSetupTokenForPaymentToken(accessToken, setupTokenId);
    console.log('\n================================================================');
    console.log(' SUCCESS: Permanent Payment Token Obtained');
    console.log('================================================================');
    console.log(` Payment Token ID : ${paymentTokenData.id}`);
    console.log(` Status           : ${paymentTokenData.status ?? 'VAULTED / CREATED'}`);
    console.log(` Customer ID      : ${paymentTokenData.customer?.id ?? 'N/A'}`);
    console.log(` Payer Email      : ${paymentTokenData.payment_source?.paypal?.email_address ?? 'N/A'}`);
    console.log('================================================================\n');
    return;
  }

  console.log('[2/4] Creating Vault setup token (POST /v3/vault/setup-tokens)...');
  const { setupTokenId, approvalUrl, status } = await createSetupToken(accessToken);
  console.log(`      Setup Token ID : ${setupTokenId}`);
  console.log(`      Status         : ${status}\n`);

  console.log('[3/4] ACTION REQUIRED: Payer Approval via Browser');
  console.log('      Open the following PayPal Sandbox approval link in your browser:');
  console.log('      ------------------------------------------------------------');
  console.log(`      ${approvalUrl}`);
  console.log('      ------------------------------------------------------------');
  console.log('      Instructions:');
  console.log('      1. Log in with your personal sandbox buyer account (payer country IN).');
  console.log('      2. Review and approve saving PayPal as your payment method.');
  console.log('      3. Wait until redirected back to the return URL.\n');

  if (setupOnly) {
    console.log('(--setup flag detected. Run again with --confirm <setupTokenId> after approving.)');
    return;
  }

  await promptUser('Press [Enter] after completing buyer approval in the browser to continue... ');

  console.log('\n[4/4] Exchanging setup token for permanent payment token (POST /v3/vault/payment-tokens)...');
  const paymentTokenData = await exchangeSetupTokenForPaymentToken(accessToken, setupTokenId);

  console.log('\n================================================================');
  console.log(' SUCCESS: Permanent Payment Token Obtained');
  console.log('================================================================');
  console.log(` Payment Token ID : ${paymentTokenData.id}`);
  console.log(` Status           : ${paymentTokenData.status ?? 'VAULTED / CREATED'}`);
  console.log(` Customer ID      : ${paymentTokenData.customer?.id ?? 'N/A'}`);
  console.log(` Payer Email      : ${paymentTokenData.payment_source?.paypal?.email_address ?? 'N/A'}`);
  console.log('================================================================\n');
  console.log('Copy the Payment Token ID above to save as VAULT_TOKEN_ID in .env for subsequent spikes.\n');
}

main().catch((err) => {
  console.error('\n[Spike S2 Error]:', err instanceof Error ? err.message : err);
  process.exit(1);
});
