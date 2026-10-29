/**
 * PayGuard — Milestone M0: Foundations & Spikes
 * Spike S3: Test PayPal AUTHORIZE with Vaulted Payment Token (Sandbox Only)
 *
 * Answers:
 * 1. Can an order be created successfully using the vaulted payment token?
 * 2. Does creating the AUTHORIZE order immediately create an authorization?
 * 3. If not, does the order require POST /v2/checkout/orders/{id}/authorize?
 * 4. Where exactly is the authorization ID returned?
 * 5. What are the resulting order and authorization statuses?
 * 6. What information is required later to capture or void the authorization?
 *
 * SAFETY RULES:
 * - Sandbox endpoints ONLY (https://api-m.sandbox.paypal.com).
 * - Minimum test amount ($1.00 USD).
 * - Never log or commit client secrets, access tokens, or sensitive buyer details.
 * - Do NOT capture or void the authorization in this spike (leaves it open for S4).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

// Attempt to load .env if present
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
} catch {
  // Ignore
}

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface AuthorizationDetails {
  id: string;
  status: string;
  amount: {
    currency_code: string;
    value: string;
  };
  seller_protection?: {
    status: string;
  };
  expiration_time?: string;
  links?: Array<{ href: string; rel: string; method: string }>;
}

interface OrderResponse {
  id: string;
  status: string;
  intent: string;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: {
      currency_code: string;
      value: string;
    };
    payments?: {
      authorizations?: AuthorizationDetails[];
    };
  }>;
  links?: Array<{ href: string; rel: string; method: string }>;
}

function getCredentials(): { clientId: string; clientSecret: string; vaultTokenId: string } {
  const clientId = process.env.CONNECTOR_ACME_CLIENT_ID || process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.CONNECTOR_ACME_CLIENT_SECRET || process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('\n[Error] Missing PayPal Sandbox credentials in .env.');
    process.exit(1);
  }

  // Check command line arg, env var, or fallback to verified US Personal S2 token
  const vaultTokenId = process.argv[2] || process.env.VAULT_TOKEN_ID || '69266860j82772632';

  return { clientId, clientSecret, vaultTokenId };
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
    const debugId = response.headers.get('paypal-debug-id') || 'N/A';
    throw new Error(`Failed to obtain OAuth token [${response.status}] (debug_id: ${debugId}): ${errorText}`);
  }

  const data = (await response.json()) as OAuthTokenResponse;
  return data.access_token;
}

async function createAuthorizeOrder(accessToken: string, vaultTokenId: string): Promise<OrderResponse> {
  const requestId = `payguard-order-${crypto.randomUUID()}`;
  const response = await fetch(`${SANDBOX_BASE_URL}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify({
      intent: 'AUTHORIZE',
      payment_source: {
        paypal: {
          vault_id: vaultTokenId,
        },
      },
      purchase_units: [
        {
          reference_id: 'default',
          custom_id: 'payguard-s3-test',
          description: 'PayGuard Spike S3 Sandbox Authorization Test',
          amount: {
            currency_code: 'USD',
            value: '1.00',
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const debugId = response.headers.get('paypal-debug-id') || 'N/A';
    throw new Error(`Failed to create AUTHORIZE order [${response.status}] (debug_id: ${debugId}): ${errorText}`);
  }

  return (await response.json()) as OrderResponse;
}

async function authorizeOrder(accessToken: string, orderId: string): Promise<OrderResponse> {
  const requestId = `payguard-auth-${crypto.randomUUID()}`;
  const response = await fetch(`${SANDBOX_BASE_URL}/v2/checkout/orders/${orderId}/authorize`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const debugId = response.headers.get('paypal-debug-id') || 'N/A';
    throw new Error(`Failed to authorize order [${response.status}] (debug_id: ${debugId}): ${errorText}`);
  }

  return (await response.json()) as OrderResponse;
}

async function main() {
  console.log('================================================================');
  console.log(' PayGuard Spike S3: PayPal AUTHORIZE with Vault ID (Sandbox)');
  console.log(' Target Endpoint Base: https://api-m.sandbox.paypal.com');
  console.log('================================================================\n');

  const { clientId, clientSecret, vaultTokenId } = getCredentials();

  console.log(`[Config] Using Vault Token ID: ${vaultTokenId}`);
  console.log('[1/3] Obtaining OAuth 2.0 access token from sandbox...');
  const accessToken = await getOAuthToken(clientId, clientSecret);
  console.log('      OAuth access token retrieved successfully [REDACTED].\n');

  console.log('[2/3] Creating Order (POST /v2/checkout/orders) with intent=AUTHORIZE & payment_source...');
  let orderResult: OrderResponse;
  try {
    orderResult = await createAuthorizeOrder(accessToken, vaultTokenId);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('INSTRUMENT_DECLINED')) {
      console.error('\n[Observed PayPal Response - HTTP 422]:');
      console.error(errorMsg);
      console.log('\n================================================================');
      console.log(' DIAGNOSTIC FINDING: INSTRUMENT_DECLINED from PayPal Sandbox');
      console.log('================================================================');
      console.log(' Confirmed Facts:');
      console.log(' - Endpoint reached: POST /v2/checkout/orders');
      console.log(' - Vault token accepted syntactically: YES');
      console.log(' - Failure returned: issue: "INSTRUMENT_DECLINED"');
      console.log('\nHypotheses Under Investigation:');
      console.log(' 1. Sandbox personal buyer account funding source / balance configuration.');
      console.log(' 2. Missing Risk Data Acquisition (RDA / PAYPAL-CLIENT-METADATA-ID).');
      console.log(' 3. Sandbox restrictions on merchant-initiated wallet holds.');
      console.log('================================================================\n');
      console.log('Payment attempts stopped. S3 status: BLOCKED / OPEN FINDING.\n');
      return;
    }
    throw err;
  }
  console.log(`      Order ID     : ${orderResult.id}`);
  console.log(`      Order Status : ${orderResult.status}`);

  let authorization: AuthorizationDetails | undefined = orderResult.purchase_units?.[0]?.payments?.authorizations?.[0];
  let explicitAuthorizeCallMade = false;

  if (authorization) {
    console.log('      Observation  : Authorization occurred IMMEDIATELY on order creation!\n');
  } else {
    console.log('      Observation  : Order created without immediate authorization.');
    console.log(`[3/3] Executing explicit authorization (POST /v2/checkout/orders/${orderResult.id}/authorize)...`);
    const authResult = await authorizeOrder(accessToken, orderResult.id);
    explicitAuthorizeCallMade = true;
    authorization = authResult.purchase_units?.[0]?.payments?.authorizations?.[0];
    console.log(`      Order Status after /authorize: ${authResult.status}\n`);
  }

  if (!authorization) {
    throw new Error(`No authorization object was found in the response! Raw Order Result: ${JSON.stringify(orderResult)}`);
  }

  const captureLink = authorization.links?.find((l) => l.rel === 'capture')?.href ?? 'N/A';
  const voidLink = authorization.links?.find((l) => l.rel === 'void')?.href ?? 'N/A';
  const selfLink = authorization.links?.find((l) => l.rel === 'self')?.href ?? 'N/A';

  console.log('================================================================');
  console.log(' SUCCESS: Authorization Hold Successfully Established');
  console.log('================================================================');
  console.log(` Authorization ID       : ${authorization.id}`);
  console.log(` Authorization Status   : ${authorization.status}`);
  console.log(` Authorized Amount      : ${authorization.amount.value} ${authorization.amount.currency_code}`);
  console.log(` Expiration Time        : ${authorization.expiration_time ?? 'N/A'}`);
  console.log(` Immediate vs Explicit  : ${explicitAuthorizeCallMade ? 'Required POST /authorize' : 'Immediate upon Order Creation'}`);
  console.log(` Self Link (GET)        : ${selfLink}`);
  console.log(` Capture Link (POST)    : ${captureLink}`);
  console.log(` Void Link (POST)       : ${voidLink}`);
  console.log('================================================================');
  console.log(' NOTE: This authorization is left OPEN to be captured or voided');
  console.log('       in the upcoming Spike S4.');
  console.log('================================================================\n');

  console.log('--- Spike S3 Answers ---');
  console.log('Q1. Can an order be created using the vaulted payment token?');
  console.log('    -> YES. POST /v2/checkout/orders accepted payment_source.paypal.vault_id without buyer redirect.');
  console.log('Q2. Does creating the AUTHORIZE order immediately create an authorization?');
  console.log(`    -> ${explicitAuthorizeCallMade ? 'NO (requires explicit /authorize)' : 'YES (authorizations array returned immediately)'}.`);
  console.log('Q3. If not, does the order require POST /v2/checkout/orders/{id}/authorize?');
  console.log(`    -> ${explicitAuthorizeCallMade ? 'YES, POST /v2/checkout/orders/{id}/authorize completed the hold.' : 'NO, immediate.'}`);
  console.log('Q4. Where exactly is the authorization ID returned?');
  console.log('    -> purchase_units[0].payments.authorizations[0].id');
  console.log('Q5. What are the resulting order and authorization statuses?');
  console.log(`    -> Order status: ${orderResult.status}, Authorization status: ${authorization.status}`);
  console.log('Q6. What information is required later to capture or void the authorization?');
  console.log(`    -> Authorization ID (${authorization.id}) and POST to /v2/payments/authorizations/{id}/capture or /void.\n`);
}

main().catch((err) => {
  console.error('\n[Spike S3 Error]:', err instanceof Error ? err.message : err);
  process.exit(1);
});
