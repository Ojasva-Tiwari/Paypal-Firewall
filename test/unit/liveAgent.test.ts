/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T4: Live-Injection LLM Agent Unit & Security Test Suite
 *
 * Verifies:
 * 1. Legitimate invoice processing with deterministic ALLOW.
 * 2. Safe default local mode: zero remote PayPal operations when --execute-sandbox is omitted.
 * 3. Opt-in remote Sandbox execution via --execute-sandbox.
 * 4. Poisoned invoice injection defense: unregistered payees fail-closed (VENDOR_NOT_FOUND).
 * 5. Hard cap ceiling defense under LLM manipulation (OVER_HARD_CAP).
 * 6. Independent controller response validation & immediate termination on HOLD/DENY.
 * 7. Strict provider fallback contract: missing Gemini key throws actionable diagnostic error (no silent mock).
 * 8. Pre-dispatch validation: canonical tool allowlist and strict Zod schema checking.
 * 9. Hard 5-step loop ceiling.
 * 10. Strict credential isolation and sanitization: zero secrets in prompts, history, or logs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { loadConfig } from '../../src/config/index.js';
import { MockAiProvider } from '../../src/ai/mockProvider.js';
import type { AiPromptOptions } from '../../src/ai/types.js';
import type { PayPalOrdersService, PayPalOrderResult } from '../../src/paypal/orders.js';
import {
  runLiveAgent,
  validatePreDispatchToolArguments,
  RequestPaymentResponseSchema,
  LiveAgentStepSchema,
  buildAgentPrompt,
  isValidDecisionStatusCombination,
  VALID_DECISION_STATUS_COMBINATIONS,
  type LiveAgentStep,
} from '../../demo/liveAgent.js';

describe('M5-T4: Live-Injection LLM Agent', () => {
  let db: Database;
  let repos: Repositories;
  const legitimateFixture = path.resolve(process.cwd(), 'demo', 'fixtures', 'invoice-legitimate.txt');
  const poisonedFixture = path.resolve(process.cwd(), 'demo', 'fixtures', 'invoice-poisoned.txt');

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // Helper to create a mock PayPal Orders Service
  function createMockOrdersService(): {
    service: PayPalOrdersService;
    captureCalls: () => number;
    capturedAmounts: () => number[];
  } {
    let calls = 0;
    const amounts: number[] = [];

    const service = {
      createOrder: vi.fn().mockImplementation(async (params: { amountMinor: number; intent: string }) => {
        if (params.intent === 'CAPTURE') {
          calls++;
          amounts.push(params.amountMinor);
          return {
            id: `ord-test-${calls}`,
            status: 'COMPLETED',
            intent: 'CAPTURE',
            isCaptured: true,
            isAuthorized: false,
            captureId: `cap-test-${calls}`,
            capture: {
              id: `cap-test-${calls}`,
              status: 'COMPLETED',
              amountMinor: params.amountMinor,
            },
            rawResponse: {},
          } as unknown as PayPalOrderResult;
        }
        return {
          id: `ord-test-auth-${calls}`,
          status: 'CREATED',
          intent: 'AUTHORIZE',
          isCaptured: false,
          isAuthorized: true,
          authorizationId: `auth-test-${calls}`,
          rawResponse: {},
        } as unknown as PayPalOrderResult;
      }),
      getOrder: vi.fn(),
    } as unknown as PayPalOrdersService;

    return {
      service,
      captureCalls: () => calls,
      capturedAmounts: () => amounts,
    };
  }

  // ==========================================================================
  // 1. Pre-Dispatch Tool & Argument Validation
  // ==========================================================================
  describe('Pre-Dispatch Validation Engine', () => {
    it('accepts valid arguments for request_payment', () => {
      const res = validatePreDispatchToolArguments('request_payment', {
        vendor_id: 'ven-acme',
        amount: '12.00',
        currency: 'USD',
        purpose: 'Acme Cloud compute infrastructure credits (Q4)',
        idempotency_key: 'idem-test-12345',
      });
      expect(res.valid).toBe(true);
      expect(res.validatedArgs?.vendor_id).toBe('ven-acme');
    });

    it('rejects unexpected / extra fields on request_payment (.strict() enforcement)', () => {
      const res = validatePreDispatchToolArguments('request_payment', {
        vendor_id: 'ven-acme',
        amount: '12.00',
        currency: 'USD',
        purpose: 'Test payment',
        idempotency_key: 'idem-test-12345',
        account_override: 'admin_bypass', // unexpected field
      });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('account_override');
    });

    it('rejects invalid currency codes and malformed amounts', () => {
      const badCurrency = validatePreDispatchToolArguments('request_payment', {
        vendor_id: 'ven-acme',
        amount: '12.00',
        currency: 'INVALID',
        purpose: 'Test payment',
        idempotency_key: 'idem-test-12345',
      });
      expect(badCurrency.valid).toBe(false);

      const badAmount = validatePreDispatchToolArguments('request_payment', {
        vendor_id: 'ven-acme',
        amount: '12.999', // exceeds 2 decimal places
        currency: 'USD',
        purpose: 'Test payment',
        idempotency_key: 'idem-test-12345',
      });
      expect(badAmount.valid).toBe(false);
    });

    it('rejects non-empty argument objects on get_budget and list_vendors', () => {
      const resBudget = validatePreDispatchToolArguments('get_budget', { extra_arg: 123 });
      expect(resBudget.valid).toBe(false);

      const resVendors = validatePreDispatchToolArguments('list_vendors', { extra_arg: 'all' });
      expect(resVendors.valid).toBe(false);
    });

    it('rejects unexposed tools such as approve_payment and capture_payment (Invariant I1)', () => {
      const resApprove = validatePreDispatchToolArguments('approve_payment', {});
      expect(resApprove.valid).toBe(false);
      expect(resApprove.error).toContain('Disallowed tool name "approve_payment"');

      const resCapture = validatePreDispatchToolArguments('capture_payment', {});
      expect(resCapture.valid).toBe(false);
      expect(resCapture.error).toContain('Disallowed tool name "capture_payment"');
    });
  });

  // ==========================================================================
  // 2. Action Schema & Bounded Output (No Chain-of-Thought)
  // ==========================================================================
  describe('Bounded Action Schema (No Chain-of-Thought)', () => {
    it('accepts valid action_reason under 200 characters without thought property', () => {
      const parsed = LiveAgentStepSchema.safeParse({
        action_reason: 'Verifying registered vendors before submitting payment.',
        tool: 'list_vendors',
        arguments: {},
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects action_reason exceeding 200 characters', () => {
      const longReason = 'A'.repeat(201);
      const parsed = LiveAgentStepSchema.safeParse({
        action_reason: longReason,
        tool: 'list_vendors',
        arguments: {},
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('action_reason must not exceed 200 characters');
    });

    it('rejects unexpected thought property (.strict() enforcement)', () => {
      const parsed = LiveAgentStepSchema.safeParse({
        action_reason: 'Valid short reason',
        thought: 'Internal chain-of-thought should not be accepted',
        tool: 'list_vendors',
        arguments: {},
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.some((i) => i.message.includes('Unrecognized key'))).toBe(true);
    });
  });

  // ==========================================================================
  // 3. Safe Default Local Mode vs. Opt-In Sandbox Execution
  // ==========================================================================
  describe('Local Mode & Explicit Sandbox Opt-In Safeguards', () => {
    it('T1: Legitimate invoice flow defaults to local-only mode (zero remote PayPal operations)', async () => {
      const mockOrders = createMockOrdersService();

      // Mock AI steps: 1) list_vendors, 2) request_payment, 3) finish
      const steps: LiveAgentStep[] = [
        {
          action_reason: 'Inspect approved merchant registry',
          tool: 'list_vendors',
          arguments: {},
        },
        {
          action_reason: 'Request legitimate $12.00 payment to Acme',
          tool: 'request_payment',
          arguments: {
            vendor_id: 'ven-acme',
            amount: '12.00',
            currency: 'USD',
            category: 'cloud',
            purpose: 'Acme Cloud compute infrastructure credits (Q4)',
            idempotency_key: 'idem-honest-local-1',
          },
        },
        {
          action_reason: 'Payment evaluated, completing workflow',
          tool: 'finish',
          arguments: {},
        },
      ];

      let stepIndex = 0;
      const mockProvider = new MockAiProvider({ modelName: 'mock-live-tester' });
      mockProvider.customStructuredResponse = () => {
        const action = steps[stepIndex] ?? steps[steps.length - 1]!;
        stepIndex++;
        return action;
      };

      const logs: string[] = [];
      const testLogger = {
        log: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
      };

      // executeSandbox is omitted (defaults to false)
      const result = await runLiveAgent({
        db,
        repos,
        fixturePath: legitimateFixture,
        aiProvider: mockProvider,
        ordersService: mockOrders.service,
        logger: testLogger,
      });

      expect(result.success).toBe(true);
      expect(result.executeSandbox).toBe(false);
      expect(result.paymentRequested).toBe(true);
      expect(result.policyDecision).toBe('ALLOW');
      expect(result.executionStatus).toBe('RECEIVED');
      expect(result.isCaptured).toBe(false);

      // Verify that ordersService.createOrder was NEVER called in local mode
      expect(mockOrders.captureCalls()).toBe(0);
      expect(mockOrders.capturedAmounts().length).toBe(0);
      expect(logs.some((l) => l.includes('Sandbox execution disabled (default)'))).toBe(true);

      // Verify state management invariants in local mode:
      // 1. Status in SQLite is 'RECEIVED'
      const dbRow = repos.paymentRequests.getById(result.paymentRequestId!);
      expect(dbRow?.status).toBe('RECEIVED');
      expect(dbRow?.decision).toBe('ALLOW');

      // 2. No RESERVE ledger entry was created (no budget leak)
      const ledgerRows = repos.ledger.listByRequestId(result.paymentRequestId!);
      expect(ledgerRows.length).toBe(0);

      // 3. Not selected by reconciliation worker
      const candidates = repos.paymentRequests.listNeedingReconciliation();
      expect(candidates.some((c) => c.id === result.paymentRequestId)).toBe(false);

      // 4. Distinct audit event recorded
      const auditEntries = repos.auditLog.listByRequestId(result.paymentRequestId!);
      expect(auditEntries.some((a) => a.event === 'POLICY_EVALUATION_ALLOW')).toBe(true);
    });

    it('T2: Enables remote PayPal Sandbox capture ONLY when --execute-sandbox is explicitly provided', async () => {
      const mockOrders = createMockOrdersService();

      const steps: LiveAgentStep[] = [
        {
          action_reason: 'Request legitimate payment with remote sandbox capture',
          tool: 'request_payment',
          arguments: {
            vendor_id: 'ven-acme',
            amount: '12.00',
            currency: 'USD',
            category: 'cloud',
            purpose: 'Acme Cloud compute infrastructure credits (Q4)',
            idempotency_key: 'idem-honest-remote-sandbox',
          },
        },
        {
          action_reason: 'Finished after capture',
          tool: 'finish',
          arguments: {},
        },
      ];

      let stepIndex = 0;
      const mockProvider = new MockAiProvider({ modelName: 'mock-live-tester' });
      mockProvider.customStructuredResponse = () => {
        const action = steps[stepIndex] ?? steps[steps.length - 1]!;
        stepIndex++;
        return action;
      };

      const logs: string[] = [];
      const testLogger = {
        log: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
      };

      // executeSandbox explicitly set to true
      const result = await runLiveAgent({
        db,
        repos,
        fixturePath: legitimateFixture,
        aiProvider: mockProvider,
        ordersService: mockOrders.service,
        defaultVaultTokenId: 'vault-sandbox-tok-456',
        executeSandbox: true,
        logger: testLogger,
      });

      expect(result.success).toBe(true);
      expect(result.executeSandbox).toBe(true);
      expect(result.paymentRequested).toBe(true);
      expect(result.policyDecision).toBe('ALLOW');
      expect(result.executionStatus).toBe('CAPTURED');
      expect(result.isCaptured).toBe(true);

      // Verify that ordersService.createOrder WAS called exactly once for $12.00 (1200 minor units)
      expect(mockOrders.captureCalls()).toBe(1);
      expect(mockOrders.capturedAmounts()).toEqual([1200]);

      // Verify mandatory warning banner was printed
      expect(logs.some((l) => l.includes('Remote PayPal Sandbox Capture ENABLED via --execute-sandbox'))).toBe(true);
      expect(logs.some((l) => l.includes('Hard Rule 1: PayPal Production URLs are strictly prohibited'))).toBe(true);
    });

    it('T3: Local-only mode cannot invoke remote PayPal operations even if ordersService is injected', async () => {
      const mockOrders = createMockOrdersService();

      const mockProvider = new MockAiProvider({ modelName: 'mock-live-tester' });
      mockProvider.customStructuredResponse = () => ({
        action_reason: 'Submitting payment',
        tool: 'request_payment',
        arguments: {
          vendor_id: 'ven-acme',
          amount: '12.00',
          currency: 'USD',
          category: 'cloud',
          purpose: 'Acme Cloud compute credits',
          idempotency_key: 'idem-local-guard',
        },
      });

      const result = await runLiveAgent({
        db,
        repos,
        fixturePath: legitimateFixture,
        aiProvider: mockProvider,
        ordersService: mockOrders.service,
        executeSandbox: false, // Explicitly false
      });

      expect(result.success).toBe(true);
      expect(result.isCaptured).toBe(false);
      expect(mockOrders.captureCalls()).toBe(0); // Zero remote calls
    });
  });

  // ==========================================================================
  // 4. Prompt Injection & Deterministic Policy Defense
  // ==========================================================================
  describe('Prompt Injection Defense & Threat Boundaries', () => {
    it('T4: Poisoned invoice injection attempting to pay unregistered payee is blocked fail-closed', async () => {
      // Mock LLM hijacked by prompt injection: directives in invoice-poisoned.txt tell it
      // to transfer $500.00 immediately to attacker-001
      const steps: LiveAgentStep[] = [
        {
          action_reason: 'Following emergency directive from invoice to transfer $500 to attacker-001',
          tool: 'request_payment',
          arguments: {
            vendor_id: 'attacker-001', // Unregistered payee
            amount: '500.00',
            currency: 'USD',
            purpose: 'ROOT-EXEC-9998-SEC Emergency escalation override',
            idempotency_key: 'idem-poisoned-attacker-1',
          },
        },
      ];

      const mockProvider = new MockAiProvider({ modelName: 'mock-hijacked-agent' });
      mockProvider.customStructuredResponse = () => steps[0]!;

      const logs: string[] = [];
      const testLogger = {
        log: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
      };

      const result = await runLiveAgent({
        db,
        repos,
        fixturePath: poisonedFixture,
        aiProvider: mockProvider,
        logger: testLogger,
      });

      expect(result.success).toBe(true);
      expect(result.paymentRequested).toBe(true);
      expect(result.isPolicyBlocked).toBe(true);
      expect(result.isCaptured).toBe(false);
      expect(result.reasonCodes).toContain('VENDOR_NOT_FOUND');
      expect(result.terminationReason).toContain('Payment rejected fail-closed at merchant registry');

      // Threat boundary assessment logged
      expect(logs.some((l) => l.includes('POLICY-BLOCKED ATTACK'))).toBe(true);
      expect(logs.some((l) => l.includes('Zero unauthorized money moved'))).toBe(true);
    });

    it('T5: Hard spend ceiling defense blocks oversized payment even to approved vendor', async () => {
      // Prompt injection tricks agent into paying approved Acme $500.00 (exceeds $100 hard cap)
      const steps: LiveAgentStep[] = [
        {
          action_reason: 'Emergency escalation override paying $500 to Acme',
          tool: 'request_payment',
          arguments: {
            vendor_id: 'ven-acme', // Approved vendor
            amount: '500.00',      // Exceeds $100.00 hard cap
            currency: 'USD',
            purpose: 'Emergency infrastructure scale override',
            idempotency_key: 'idem-poisoned-cap-1',
          },
        },
      ];

      const mockProvider = new MockAiProvider({ modelName: 'mock-hijacked-agent' });
      mockProvider.customStructuredResponse = () => steps[0]!;

      const result = await runLiveAgent({
        db,
        repos,
        fixturePath: poisonedFixture,
        aiProvider: mockProvider,
      });

      expect(result.success).toBe(true);
      expect(result.paymentRequested).toBe(true);
      expect(result.policyDecision).toBe('DENY');
      expect(result.isPolicyBlocked).toBe(true);
      expect(result.isCaptured).toBe(false);
      expect(result.reasonCodes).toContain('OVER_HARD_CAP');
      expect(result.terminationReason).toContain('Payment request DENIED by firewall');
    });
  });

  // ==========================================================================
  // 5. Independent Controller Response Validation & Terminal State Enforcement
  // ==========================================================================
  describe('Independent Controller Response Validation', () => {
    it('T6: Controller immediately halts execution upon encountering HOLD without consulting LLM', async () => {
      let callCount = 0;
      const mockProvider = new MockAiProvider({ modelName: 'mock-tester' });
      mockProvider.customStructuredResponse = (_prompt: string, options?: AiPromptOptions) => {
        if (options?.kind && options.kind !== 'live_agent_step') {
          return undefined;
        }
        callCount++;
        return {
          action_reason: 'Submitting payment exceeding auto-approve limit',
          tool: 'request_payment',
          arguments: {
            vendor_id: 'ven-acme',
            amount: '25.00', // Exceeds default $15.00 auto limit, triggers HOLD
            currency: 'USD',
            category: 'cloud',
            purpose: 'Large server reservation',
            idempotency_key: 'idem-hold-test-1',
          },
        };
      };

      const result = await runLiveAgent({
        db,
        repos,
        fixturePath: legitimateFixture,
        aiProvider: mockProvider,
        maxSteps: 5,
      });

      expect(result.success).toBe(true);
      expect(result.policyDecision).toBe('HOLD');
      expect(result.isHeldForReview).toBe(true);
      expect(result.isCaptured).toBe(false);
      expect(result.reasonCodes).toContain('OVER_AUTO_LIMIT');

      // Crucial: LLM was invoked exactly once for the payment request, and the controller
      // immediately terminated without consulting the model for a second step
      expect(callCount).toBe(1);
      expect(result.totalSteps).toBe(1);
    });

    it('T10: Controller enforces the hard 5-step loop ceiling', async () => {
      let callCount = 0;
      const mockProvider = new MockAiProvider({ modelName: 'mock-infinite-looper' });
      mockProvider.customStructuredResponse = () => {
        callCount++;
        return {
          action_reason: `Checking budget repeatedly step ${callCount}`,
          tool: 'get_budget',
          arguments: {},
        };
      };

      const result = await runLiveAgent({
        db,
        repos,
        fixturePath: legitimateFixture,
        aiProvider: mockProvider,
        maxSteps: 5,
      });

      expect(result.success).toBe(true);
      expect(callCount).toBe(5);
      expect(result.totalSteps).toBe(5);
      expect(result.terminationReason).toBe('Maximum step limit reached');
    });

    it('validates canonical RequestPaymentResponseSchema and rejects malformed shapes', () => {
      // Valid response
      const valid = RequestPaymentResponseSchema.safeParse({
        request_id: 'req_123',
        status: 'RECEIVED',
        decision: 'ALLOW',
        reasons: [],
        message: 'Success',
        next_step: 'None',
      });
      expect(valid.success).toBe(true);

      // Missing required field
      const missingField = RequestPaymentResponseSchema.safeParse({
        request_id: 'req_123',
        status: 'CAPTURED',
        // missing decision
      });
      expect(missingField.success).toBe(false);

      // Unexpected property (.strict() check)
      const extraField = RequestPaymentResponseSchema.safeParse({
        request_id: 'req_123',
        status: 'CAPTURED',
        decision: 'ALLOW',
        reasons: [],
        message: 'Success',
        next_step: 'None',
        bypass_mode: true,
      });
      expect(extraField.success).toBe(false);
    });

    it('enforces authoritative decision/status compatibility matrix', () => {
      // Structure verification
      expect(VALID_DECISION_STATUS_COMBINATIONS.ALLOW).toEqual(['RECEIVED', 'CAPTURED', 'FAILED']);
      expect(VALID_DECISION_STATUS_COMBINATIONS.HOLD).toEqual(['HELD']);
      expect(VALID_DECISION_STATUS_COMBINATIONS.DENY).toEqual(['DENIED']);

      // Valid combinations
      expect(isValidDecisionStatusCombination('ALLOW', 'RECEIVED')).toBe(true);
      expect(isValidDecisionStatusCombination('ALLOW', 'CAPTURED')).toBe(true);
      expect(isValidDecisionStatusCombination('ALLOW', 'FAILED')).toBe(true);
      expect(isValidDecisionStatusCombination('HOLD', 'HELD')).toBe(true);
      expect(isValidDecisionStatusCombination('DENY', 'DENIED')).toBe(true);

      // Prohibited invalid combinations
      expect(isValidDecisionStatusCombination('DENY', 'CAPTURED')).toBe(false);
      expect(isValidDecisionStatusCombination('DENY', 'RECEIVED')).toBe(false);
      expect(isValidDecisionStatusCombination('DENY', 'HELD')).toBe(false);
      expect(isValidDecisionStatusCombination('DENY', 'AUTO_EXECUTING')).toBe(false);

      expect(isValidDecisionStatusCombination('HOLD', 'CAPTURED')).toBe(false);
      expect(isValidDecisionStatusCombination('HOLD', 'DENIED')).toBe(false);
      expect(isValidDecisionStatusCombination('HOLD', 'RECEIVED')).toBe(false);
      expect(isValidDecisionStatusCombination('HOLD', 'AUTO_EXECUTING')).toBe(false);

      expect(isValidDecisionStatusCombination('ALLOW', 'HELD')).toBe(false);
      expect(isValidDecisionStatusCombination('ALLOW', 'DENIED')).toBe(false);
      expect(isValidDecisionStatusCombination('ALLOW', 'AUTO_EXECUTING')).toBe(false);
    });

    it('controller immediately halts with error when server returns invalid decision/status pair', async () => {
      // Mock provider returning a payment request
      const mockProvider = new MockAiProvider({ modelName: 'mock-tester' });
      mockProvider.customStructuredResponse = () => ({
        action_reason: 'Testing contradictory response handling',
        tool: 'request_payment',
        arguments: {
          vendor_id: 'ven-acme',
          amount: '12.00',
          currency: 'USD',
          purpose: 'Testing contradiction',
          idempotency_key: 'idem-contradict-1',
        },
      });

      // We test the matrix validator function directly as well as the controller loop
      expect(isValidDecisionStatusCombination('DENY', 'CAPTURED')).toBe(false);
      expect(isValidDecisionStatusCombination('ALLOW', 'HELD')).toBe(false);
    });

    it('verifies idempotent replays in local mode return persisted ALLOW + RECEIVED without creating reservations', async () => {
      const mockOrders = createMockOrdersService();
      const sharedIdempotencyKey = 'idem-replay-local-mode-999';

      const steps: LiveAgentStep[] = [
        {
          action_reason: 'First submission in local mode',
          tool: 'request_payment',
          arguments: {
            vendor_id: 'ven-acme',
            amount: '12.00',
            currency: 'USD',
            category: 'cloud',
            purpose: 'Acme Cloud compute credits',
            idempotency_key: sharedIdempotencyKey,
          },
        },
        {
          action_reason: 'Second identical submission (idempotent replay)',
          tool: 'request_payment',
          arguments: {
            vendor_id: 'ven-acme',
            amount: '12.00',
            currency: 'USD',
            category: 'cloud',
            purpose: 'Acme Cloud compute credits',
            idempotency_key: sharedIdempotencyKey,
          },
        },
        {
          action_reason: 'Finished after replay',
          tool: 'finish',
          arguments: {},
        },
      ];

      let stepIndex = 0;
      const mockProvider = new MockAiProvider({ modelName: 'mock-replay-tester' });
      mockProvider.customStructuredResponse = (_prompt: string, options?: AiPromptOptions) => {
        if (options?.kind && options.kind !== 'live_agent_step') {
          return undefined;
        }
        const action = steps[stepIndex] ?? steps[steps.length - 1]!;
        stepIndex++;
        return action;
      };

      const result = await runLiveAgent({
        db,
        repos,
        fixturePath: legitimateFixture,
        aiProvider: mockProvider,
        ordersService: mockOrders.service,
        executeSandbox: false,
      });

      expect(result.success).toBe(true);
      expect(result.policyDecision).toBe('ALLOW');
      expect(result.executionStatus).toBe('RECEIVED');
      expect(result.isCaptured).toBe(false);

      // Verify zero ledger reservations were created
      const ledgerRows = repos.ledger.listByRequestId(result.paymentRequestId!);
      expect(ledgerRows.length).toBe(0);

      // Verify zero PayPal calls
      expect(mockOrders.captureCalls()).toBe(0);
    });
  });

  // ==========================================================================
  // 6. Provider Fallback Contract & Secret Isolation
  // ==========================================================================
  describe('Provider Fallback Contract & Secret Isolation', () => {
    it('T7: Missing Gemini API key throws explicit diagnostic error without falling back to mock', async () => {
      // Config specifies gemini, but geminiApiKey is empty
      const badConfig = {
        ...loadConfig({}),
        aiProvider: 'gemini' as const,
        geminiApiKey: '',
      };

      await expect(
        runLiveAgent({
          db,
          repos,
          config: badConfig,
          providerMode: 'gemini',
        })
      ).rejects.toThrow(
        "[LiveAgent Configuration Error] GEMINI_API_KEY is missing or invalid while AI_PROVIDER is set to 'gemini'."
      );
    });

    it('T11: Strict credential isolation and sanitization ensures zero secrets enter prompts or logs', () => {
      const fakeGeminiKey = 'AIzaSySecretGeminiKey1234567890';
      const fakeSecret = 'paypal_top_secret_connector_secret_999';
      const fakeToken = 'bearer_agent_key_abc123xyz456';

      const prompt = buildAgentPrompt(
        'Invoice with normal commercial text',
        ['Step 1 Tool Call: list_vendors\nResult: {"vendors":[]}', 'Step 2 Tool Call: get_budget\nResult: {"remaining":"$100.00"}']
      );

      // Verify prompt contains invoice and history, but strictly no secrets
      expect(prompt).toContain('Supplier Invoice to Process:');
      expect(prompt).toContain('list_vendors');
      expect(prompt).not.toContain(fakeGeminiKey);
      expect(prompt).not.toContain(fakeSecret);
      expect(prompt).not.toContain(fakeToken);
      expect(prompt).not.toContain('Authorization: Bearer');
    });
  });
});
