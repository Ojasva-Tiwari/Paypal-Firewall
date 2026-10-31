/**
 * PayGuard — Milestone M3: MCP Integration
 * M3-T7: Scripted Honest Agent (`demo/honestAgent.ts`)
 *
 * Implements:
 * - End-to-end execution of a compliant commercial agent using PayGuard MCP:
 *     1. Authenticates using the seeded demo agent's Bearer API key
 *     2. Connects through the Streamable HTTP transport at `/mcp`
 *     3. Discovers available tools via `client.listTools()`
 *     4. Queries remaining spend budget via `get_budget`
 *     5. Inspects allowed vendors via `list_vendors`
 *     6. Submits a compliant $12.00 payment request for approved vendor 'ven-acme'
 *     7. Verifies deterministic policy evaluation returns `decision: 'ALLOW'`
 *     8. Validates execution outcome:
 *        - With Sandbox credentials & onboarded vault token: verifies `CAPTURED` status
 *        - Without credentials/vault token: reports policy `ALLOW` and provides
 *          clear onboarding instructions without fabricating fake capture
 *     9. Retrieves authoritative payment status via `get_payment_status`
 *     10. Prints a clear, human-readable terminal audit summary
 *
 * Security & Invariants:
 * - Hard Rule 1: Sandbox only. Production endpoints are strictly prohibited.
 * - Hard Rule 2: Never print API keys, access tokens, or raw secrets to terminal/logs.
 * - Hard Rule 3: Only canonical MCP tools are invoked (`request_payment`, `get_payment_status`, `get_budget`, `list_vendors`).
 * - Hard Rule 4: Money-moving PayPal calls happen ONLY inside `executeDecision`.
 * - Hard Rule 5: Monetary amounts are represented as integer minor units in Core.
 * - Hard Rule 8: Fail-closed on missing credentials or ambiguous execution outcomes.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Database } from '../src/db/connection.js';
import { createDatabase, runMigrations } from '../src/db/connection.js';
import { Repositories } from '../src/db/repositories.js';
import { getConfig } from '../src/config/index.js';
import { TokenManager } from '../src/paypal/tokenManager.js';
import { PayPalHttpClient } from '../src/paypal/http.js';
import { PayPalOrdersService } from '../src/paypal/orders.js';
import { PayPalAuthorizationsService } from '../src/paypal/authorizations.js';
import {
  createPayGuardMcpServer,
  type PayGuardMcpServerInstance,
} from '../src/mcp/server.js';
import {
  seedDemoDatabase,
  DEMO_HONEST_AGENT_ID,
  DEMO_VENDOR_ID,
} from './seed.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface HonestAgentOptions {
  readonly db?: Database;
  readonly repos?: Repositories;
  readonly mcpServerUrl?: string;
  readonly rawApiKey?: string;
  readonly ordersService?: PayPalOrdersService;
  readonly authorizationsService?: PayPalAuthorizationsService;
  readonly defaultVaultTokenId?: string;
  readonly amount?: string;
  readonly purpose?: string;
  readonly vendorId?: string;
  readonly currency?: string;
  readonly category?: string;
  readonly idempotencyKey?: string;
  readonly logger?: {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

export interface HonestAgentResult {
  readonly success: boolean;
  readonly agentId: string;
  readonly toolsDiscovered: readonly string[];
  readonly initialBudget: {
    readonly currency: string;
    readonly remainingBudget: string;
    readonly dailyLimit?: string;
  };
  readonly vendorVerified: boolean;
  readonly paymentRequestId: string;
  readonly policyDecision: string;
  readonly executionStatus: string;
  readonly isCaptured: boolean;
  readonly hasSandboxExecution: boolean;
  readonly statusVerified: boolean;
  readonly message: string;
}

// ============================================================================
// Core Honest Agent Workflow
// ============================================================================

/**
 * Runs the scripted honest agent against the PayGuard MCP policy firewall.
 */
export async function runHonestAgent(
  options?: HonestAgentOptions
): Promise<HonestAgentResult> {
  const logger = options?.logger ?? console;
  const config = getConfig();

  // 1. Database and Repositories Initialization
  let localDb: Database | undefined;
  const db = options?.db ?? (() => {
    localDb = createDatabase(config.databasePath);
    runMigrations(localDb);
    return localDb;
  })();

  const repos = options?.repos ?? new Repositories(db);

  // 2. Resolve Agent Key and Seed if necessary
  let rawApiKey = options?.rawApiKey?.trim() || process.env.DEMO_AGENT_API_KEY?.trim() || '';
  if (!rawApiKey) {
    const seedResult = seedDemoDatabase(db, { repos, logger });
    rawApiKey = seedResult.rawApiKey;
  }

  // 3. MCP Server Resolution: reuse existing server or launch managed in-process instance
  let managedServer: PayGuardMcpServerInstance | null = null;
  let targetMcpUrl = options?.mcpServerUrl?.trim() || process.env.MCP_SERVER_URL?.trim();

  if (!targetMcpUrl) {
    // Check if an MCP server is already listening at default localhost:3000
    const defaultUrl = 'http://localhost:3000/mcp';
    let isDefaultRunning = false;
    try {
      const probeRes = await fetch('http://localhost:3000/healthz', {
        signal: AbortSignal.timeout(600),
      });
      if (probeRes.ok) {
        isDefaultRunning = true;
        targetMcpUrl = defaultUrl;
      }
    } catch {
      isDefaultRunning = false;
    }

    if (!isDefaultRunning) {
      // Configure PayPal services if sandbox credentials exist or were provided
      let ordersService = options?.ordersService;
      let authorizationsService = options?.authorizationsService;

      if (!ordersService && config.connectorAcmeClientId && config.connectorAcmeClientSecret) {
        const tokenManager = new TokenManager({
          baseUrl: config.paypalBaseUrl,
          credentialResolver: () => ({
            clientId: config.connectorAcmeClientId!,
            clientSecret: config.connectorAcmeClientSecret!,
          }),
        });

        const httpClient = new PayPalHttpClient({
          baseUrl: config.paypalBaseUrl,
          tokenManager,
          defaultConnectorKey: 'acme_cloud',
        });

        ordersService = new PayPalOrdersService({ client: httpClient });
        authorizationsService = new PayPalAuthorizationsService({ client: httpClient });
      }

      managedServer = createPayGuardMcpServer({
        db,
        repos,
        ordersService,
        authorizationsService,
        defaultVaultTokenId: options?.defaultVaultTokenId,
      });

      const started = await managedServer.start(0);
      targetMcpUrl = `http://localhost:${started.port}/mcp`;
    }
  }

  if (!targetMcpUrl) {
    throw new Error('Failed to resolve or start PayGuard MCP server.');
  }

  // 4. Connect MCP Client over Streamable HTTP Transport
  logger.log(`\n[HonestAgent] Connecting to PayGuard MCP Server at ${targetMcpUrl}...`);
  const transport = new StreamableHTTPClientTransport(new URL(targetMcpUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${rawApiKey}`,
      },
    },
  });

  const client = new Client({ name: 'payguard-honest-agent', version: '1.0.0' });

  try {
    await client.connect(transport);
    logger.log(' [✓] Authenticated MCP session established successfully.');

    // Step 1: Discover Tools
    logger.log('\n[HonestAgent] Step 1: Discovering registered firewall tools...');
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);
    logger.log(` [✓] Registered tools discovered (${toolNames.length}): ${toolNames.join(', ')}`);

    // Verify canonical 4 tools
    const expectedTools = ['request_payment', 'get_payment_status', 'get_budget', 'list_vendors'];
    for (const tool of expectedTools) {
      if (!toolNames.includes(tool)) {
        throw new Error(`Invariant violation: Required tool '${tool}' is missing from MCP server.`);
      }
    }

    // Step 2: Query Budget
    logger.log('\n[HonestAgent] Step 2: Querying agent spend budget (get_budget)...');
    const budgetCall = await client.callTool({
      name: 'get_budget',
      arguments: {},
    });

    if (budgetCall.isError) {
      const errText = (budgetCall.content as Array<{ text: string }>)?.[0]?.text;
      throw new Error(`get_budget failed: ${errText}`);
    }

    const budgetData = JSON.parse((budgetCall.content as Array<{ text: string }>)[0]!.text) as {
      currency: string;
      remaining_daily_budget: string;
      remaining_daily_budget_minor?: number;
      allowed_currencies?: string[];
      daily_limit?: string;
      spent_24h?: string;
      reserved?: string;
    };

    logger.log(` [✓] Budget query successful:`);
    logger.log(`     Remaining Budget : $${budgetData.remaining_daily_budget} ${budgetData.currency}`);
    if (budgetData.daily_limit) {
      logger.log(`     Daily Limit      : $${budgetData.daily_limit} ${budgetData.currency}`);
      logger.log(`     Spent (24h)      : $${budgetData.spent_24h} ${budgetData.currency}`);
      logger.log(`     Reserved (24h)   : $${budgetData.reserved} ${budgetData.currency}`);
    }

    // Step 3: List Approved Vendors
    logger.log('\n[HonestAgent] Step 3: Inspecting approved merchant registry (list_vendors)...');
    const vendorsCall = await client.callTool({
      name: 'list_vendors',
      arguments: {},
    });

    if (vendorsCall.isError) {
      const errText = (vendorsCall.content as Array<{ text: string }>)?.[0]?.text;
      throw new Error(`list_vendors failed: ${errText}`);
    }

    const vendorsData = JSON.parse((vendorsCall.content as Array<{ text: string }>)[0]!.text) as {
      vendors: Array<{
        vendor_id: string;
        name: string;
        status: string;
        categories: string[];
        verification_status: string;
        safety_notice: string;
      }>;
    };

    const targetVendorId = options?.vendorId ?? DEMO_VENDOR_ID;
    const targetVendor = vendorsData.vendors.find((v) => v.vendor_id === targetVendorId);
    if (!targetVendor || targetVendor.status !== 'ACTIVE') {
      throw new Error(`Approved vendor '${targetVendorId}' not found or not active in registry.`);
    }

    logger.log(` [✓] Approved vendor verified: ${targetVendor.name} (id: ${targetVendor.vendor_id}, status: ${targetVendor.status})`);

    // Step 4: Submit Legitimate Commercial Payment Request ($12.00)
    const paymentAmount = options?.amount ?? '12.00';
    const paymentVendorId = options?.vendorId ?? DEMO_VENDOR_ID;
    const paymentCurrency = options?.currency ?? 'USD';
    const paymentPurpose = options?.purpose ?? 'Acme Cloud compute infrastructure credits (Q4)';
    const paymentCategory = options?.category ?? 'cloud';
    const paymentIdempotencyKey = options?.idempotencyKey ?? `idem-honest-${Date.now()}`;

    logger.log(`\n[HonestAgent] Step 4: Submitting commercial payment request ($${paymentAmount} to ${paymentVendorId})...`);
    logger.log(`     Purpose          : ${paymentPurpose}`);
    logger.log(`     Idempotency Key  : ${paymentIdempotencyKey}`);

    const paymentRequestCall = await client.callTool({
      name: 'request_payment',
      arguments: {
        vendor_id: paymentVendorId,
        amount: paymentAmount,
        currency: paymentCurrency,
        purpose: paymentPurpose,
        category: paymentCategory,
        idempotency_key: paymentIdempotencyKey,
      },
    });

    if (paymentRequestCall.isError) {
      const errText = (paymentRequestCall.content as Array<{ text: string }>)?.[0]?.text;
      throw new Error(`request_payment failed: ${errText}`);
    }

    const paymentResponse = JSON.parse((paymentRequestCall.content as Array<{ text: string }>)[0]!.text) as {
      request_id: string;
      status: string;
      decision: string;
      reasons: string[];
      message: string;
      next_step: string;
    };

    logger.log(` [✓] Firewall Policy Evaluation:`);
    logger.log(`     Request ID       : ${paymentResponse.request_id}`);
    logger.log(`     Policy Decision  : ${paymentResponse.decision}`);
    logger.log(`     Status           : ${paymentResponse.status}`);
    logger.log(`     Reasons          : ${paymentResponse.reasons.join(', ') || 'None (Fully compliant)'}`);
    logger.log(`     Message          : ${paymentResponse.message}`);

    // Verify policy decision is ALLOW
    if (paymentResponse.decision !== 'ALLOW') {
      throw new Error(
        `Expected policy decision 'ALLOW' for $12.00 commercial payment, got '${paymentResponse.decision}'. Reasons: ${paymentResponse.reasons.join(', ')}`
      );
    }

    // Step 5: Validate Execution Result
    const isCaptured = paymentResponse.status === 'CAPTURED';
    let hasSandboxExecution = false;

    if (isCaptured) {
      hasSandboxExecution = true;
      logger.log('\n [✓] PayPal Sandbox Execution Confirmed: Payment successfully CAPTURED.');
    } else {
      logger.log('\n [i] Payment was approved by policy firewall (ALLOW), but stopped before remote capture:');
      logger.log(`     Status           : ${paymentResponse.status}`);
      logger.log(`     Next Step        : ${paymentResponse.next_step}`);
      logger.log('     Note: Remote capture requires active PayPal Sandbox credentials and an onboarded buyer wallet.');
      logger.log("     Run 'npm run vault:onboard -- --vendor ven-acme' to onboard a PayPal Sandbox wallet.");
    }

    // Step 6: Query Payment Status via get_payment_status
    logger.log('\n[HonestAgent] Step 6: Confirming payment record (get_payment_status)...');
    const statusCall = await client.callTool({
      name: 'get_payment_status',
      arguments: {
        request_id: paymentResponse.request_id,
      },
    });

    if (statusCall.isError) {
      const errText = (statusCall.content as Array<{ text: string }>)?.[0]?.text;
      throw new Error(`get_payment_status failed: ${errText}`);
    }

    const statusData = JSON.parse((statusCall.content as Array<{ text: string }>)[0]!.text) as {
      request_id: string;
      status: string;
      decision: string;
      created_at: string;
    };

    logger.log(` [✓] Payment status verified via MCP:`);
    logger.log(`     Request ID       : ${statusData.request_id}`);
    logger.log(`     Persisted Status : ${statusData.status}`);
    logger.log(`     Recorded Decision: ${statusData.decision}`);
    logger.log(`     Created At       : ${statusData.created_at}`);

    const statusVerified = statusData.request_id === paymentResponse.request_id &&
      statusData.status === paymentResponse.status;

    return {
      success: true,
      agentId: DEMO_HONEST_AGENT_ID,
      toolsDiscovered: toolNames,
      initialBudget: {
        currency: budgetData.currency,
        remainingBudget: budgetData.remaining_daily_budget,
        dailyLimit: budgetData.daily_limit,
      },
      vendorVerified: true,
      paymentRequestId: paymentResponse.request_id,
      policyDecision: paymentResponse.decision,
      executionStatus: paymentResponse.status,
      isCaptured,
      hasSandboxExecution,
      statusVerified,
      message: paymentResponse.message,
    };
  } finally {
    try {
      await client.close();
    } catch {
      // client close cleanup
    }
    if (managedServer) {
      try {
        await managedServer.close();
      } catch {
        // server close cleanup
      }
    }
    if (localDb) {
      localDb.close();
    }
  }
}

// ============================================================================
// CLI Execution Runner
// ============================================================================

export async function runCli(): Promise<void> {
  console.log('\n================================================================');
  console.log(' PayGuard: Running Scripted Honest Agent Demo (M3-T7)');
  console.log('================================================================');

  try {
    const result = await runHonestAgent();

    console.log('\n================================================================');
    console.log(' PayGuard Honest Agent: Demonstration Summary');
    console.log('================================================================');
    console.log(` Agent ID            : ${result.agentId}`);
    console.log(` Discovered Tools    : ${result.toolsDiscovered.join(', ')}`);
    console.log(` Vendor Verified     : ${result.vendorVerified ? 'YES (ven-acme)' : 'NO'}`);
    console.log(` Payment Request ID  : ${result.paymentRequestId}`);
    console.log(` Policy Decision     : ${result.policyDecision} (Compliant commercial spend)`);
    console.log(` Execution Status    : ${result.executionStatus}`);
    console.log(` PayPal Capture      : ${result.isCaptured ? 'CAPTURED (Live Sandbox)' : 'SKIPPED / PENDING (Requires Vault Onboarding)'}`);
    console.log(` Status Query Check  : ${result.statusVerified ? 'PASSED' : 'FAILED'}`);
    console.log('================================================================\n');
  } catch (err) {
    console.error('\n[HonestAgent Error]:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('honestAgent.ts') || process.argv[1]?.endsWith('honestAgent.js')) {
  runCli().catch((err) => {
    console.error('[HonestAgent Fatal]:', err);
    process.exit(1);
  });
}
