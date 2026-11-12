/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T1: Mock AI Provider
 *
 * Implements:
 * - Deterministic, zero-network AI provider for unit testing, CI pipelines, and offline dev.
 * - Supports programmable failure scenarios (timeouts, rate limits, schema mismatches, HTTP errors).
 * - Generates valid structured data matching input Zod schemas or user-configured test fixtures.
 */

import { z } from 'zod';
import {
  AiProvider,
  AiProviderKind,
  AiPromptOptions,
  AiTimeoutError,
  AiRateLimitError,
  AiProviderError,
  AiSchemaError,
} from './types.js';

export interface MockAiProviderOptions {
  readonly modelName?: string;
  readonly defaultText?: string;
  readonly defaultStructured?: Record<string, unknown>;
  readonly simulatedLatencyMs?: number;
}

function parseAmountMinorFromCapture(rawAmount: string): number {
  const [wholePart = '0', fracPart = ''] = rawAmount.split('.');
  const whole = Number.parseInt(wholePart, 10);
  const cents = Number.parseInt(fracPart.padEnd(2, '0').slice(0, 2), 10);
  return whole * 100 + cents;
}

function buildMockPolicyDraft(prompt: string): Record<string, unknown> {
  const startMarker = '<<<UNTRUSTED_POLICY_PROMPT>>>';
  const endMarker = '<<<END_UNTRUSTED_POLICY_PROMPT>>>';
  const startIdx = prompt.indexOf(startMarker);
  const endIdx = prompt.indexOf(endMarker);

  const userRequest =
    startIdx !== -1 && endIdx > startIdx
      ? prompt.slice(startIdx + startMarker.length, endIdx).trim()
      : prompt.trim();

  const proposedRules: Record<string, unknown> = {};
  const changedDescriptions: string[] = [];

  // 1. Auto-approval threshold
  const autoMatch =
    userRequest.match(
      /auto[-\s]*(?:approve|approval)(?:\s+limit)?[^.\n]*?\b(?:to|at|of|under|up\s+to|=)\s*(?:\$|usd\s*)?(\d+(?:\.\d{1,2})?)\b/i
    ) ??
    userRequest.match(
      /auto[-\s]*approve\s+payments?\s+(?:up\s+to|under|below)\s*(?:\$|usd\s*)?(\d+(?:\.\d{1,2})?)\b/i
    ) ??
    userRequest.match(
      /(?:require|need|without)\s+(?:my\s+|human\s+)?approval\s+(?:for\s+)?(?:anything\s+|payments?\s+)?(?:over|above|more\s+than)\s*(?:\$|usd\s*)?(\d+(?:\.\d{1,2})?)\b/i
    ) ??
    userRequest.match(
      /payments?\s+(?:up\s+to|under|below|more\s+than|over)\s*(?:\$|usd\s*)?(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)?\s*(?:without|with\s+no)\s+(?:my\s+|human\s+)?approval/i
    );

  if (autoMatch?.[1]) {
    const minor = parseAmountMinorFromCapture(autoMatch[1]);
    proposedRules.auto_limit_minor = minor;
    changedDescriptions.push(`auto-approval limit to ${minor} minor units`);
  }

  // 2. Hard cap threshold
  const hardCapMatch = userRequest.match(
    /hard\s*cap(?:\s+(?:ceiling|limit))?\s*(?:to|at|of|=)\s*(?:\$|usd\s*)?(\d+(?:\.\d{1,2})?)\b/i
  );
  if (hardCapMatch?.[1]) {
    const minor = parseAmountMinorFromCapture(hardCapMatch[1]);
    proposedRules.hard_cap_minor = minor;
    changedDescriptions.push(`hard cap to ${minor} minor units`);
  }

  // 3. Daily budgets
  const agentBudgetMatch = userRequest.match(
    /agent\s+daily\s+(?:budget|limit)\s*(?:to|at|of|=)\s*(?:\$|usd\s*)?(\d+(?:\.\d{1,2})?)\b/i
  );
  if (agentBudgetMatch?.[1]) {
    const minor = parseAmountMinorFromCapture(agentBudgetMatch[1]);
    proposedRules.agent_daily_budget_minor = minor;
    changedDescriptions.push(`agent daily budget to ${minor} minor units`);
  }

  const globalBudgetMatch = userRequest.match(
    /global\s+daily\s+(?:budget|limit)\s*(?:to|at|of|=)\s*(?:\$|usd\s*)?(\d+(?:\.\d{1,2})?)\b/i
  );
  if (globalBudgetMatch?.[1]) {
    const minor = parseAmountMinorFromCapture(globalBudgetMatch[1]);
    proposedRules.global_daily_budget_minor = minor;
    changedDescriptions.push(`global daily budget to ${minor} minor units`);
  }

  // 4. Velocity limits
  const velocityMatch = userRequest.match(
    /(\d+)\s+requests?\s+(?:per|every|in)\s+(\d+)\s+minutes?\b/i
  );
  if (velocityMatch?.[1] && velocityMatch?.[2]) {
    const maxRequests = Math.max(1, Number.parseInt(velocityMatch[1], 10));
    const windowMinutes = Math.max(1, Number.parseInt(velocityMatch[2], 10));
    proposedRules.velocity = {
      max_requests: maxRequests,
      window_minutes: windowMinutes,
    };
    changedDescriptions.push(`velocity to ${maxRequests} requests / ${windowMinutes}m`);
  }

  // 5. Hold review TTL
  const holdTtlMatch = userRequest.match(
    /hold(?:\s+review)?\s+ttl\s*(?:to|at|of|=)\s*(\d+)\s+minutes?\b/i
  );
  if (holdTtlMatch?.[1]) {
    const holdTtl = Math.max(1, Number.parseInt(holdTtlMatch[1], 10));
    proposedRules.hold_ttl_minutes = holdTtl;
    changedDescriptions.push(`hold TTL to ${holdTtl} minutes`);
  }

  // 6. Duplicate detection window
  const dupMatch = userRequest.match(
    /duplicate(?:\s+(?:detection|suppression))?\s+window\s*(?:to|at|of|=)\s*(\d+)\s+minutes?\b/i
  );
  if (dupMatch?.[1]) {
    const dupWindow = Math.max(0, Number.parseInt(dupMatch[1], 10));
    proposedRules.duplicate_window_minutes = dupWindow;
    changedDescriptions.push(`duplicate window to ${dupWindow} minutes`);
  }

  // 7. New / unverified vendor action
  if (/\bdeny\b[^.\n]{0,40}\b(?:new|unverified)\s+vendors?\b/i.test(userRequest)) {
    proposedRules.new_vendor_action = 'DENY';
    changedDescriptions.push('new vendor action to DENY');
  } else if (/\bhold\b[^.\n]{0,40}\b(?:new|unverified)\s+vendors?\b/i.test(userRequest)) {
    proposedRules.new_vendor_action = 'HOLD';
    changedDescriptions.push('new vendor action to HOLD');
  }

  // 8. Currency allowlist
  if (
    /\bcurrenc(?:y|ies)\b/i.test(userRequest) ||
    /\ballow(?:ed)?\s+(?:only\s+)?(?:USD|EUR|GBP|INR|JPY|CAD|AUD|CHF|SGD)\b/i.test(userRequest)
  ) {
    const matches = userRequest.match(/\b(USD|EUR|GBP|INR|JPY|CAD|AUD|CHF|SGD)\b/g);
    if (matches && matches.length > 0) {
      const uniqueCurrencies = Array.from(new Set(matches));
      proposedRules.currency_allowlist = uniqueCurrencies;
      changedDescriptions.push(`currency allowlist to ${uniqueCurrencies.join(', ')}`);
    }
  }

  const explanation =
    changedDescriptions.length > 0
      ? `Mock AI policy draft: updated ${changedDescriptions.join('; ')}.`
      : 'Mock AI policy draft: evaluated prompt with active policy settings preserved.';

  return {
    proposed_rules: proposedRules,
    explanation: explanation.slice(0, 1000),
    unsupported_requests: [],
  };
}

export class MockAiProvider implements AiProvider {
  public readonly kind: AiProviderKind = 'mock';
  public readonly modelName: string;

  // Programmable test hooks
  public shouldTimeout: boolean = false;
  public simulateRateLimit: boolean = false;
  public simulateHttpError: { statusCode: number; message: string; retryable?: boolean } | null = null;
  public returnMalformedJson: boolean = false;
  public customTextResponse?: string | ((prompt: string) => string);
  public customStructuredResponse?: unknown | ((prompt: string, options?: AiPromptOptions) => unknown);
  public simulatedLatencyMs: number;
  private readonly defaultStructured?: Record<string, unknown>;

  constructor(options?: MockAiProviderOptions) {
    this.modelName = options?.modelName ?? 'mock-model-v1';
    this.simulatedLatencyMs = options?.simulatedLatencyMs ?? 5;
    this.defaultStructured = options?.defaultStructured;
  }

  public async generateText(
    options: AiPromptOptions,
    signal?: AbortSignal
  ): Promise<{ text: string; latencyMs: number }> {
    this.checkSimulatedFailures(signal);

    if (this.simulatedLatencyMs > 0) {
      await this.sleep(this.simulatedLatencyMs, signal);
    }

    let text: string;
    if (typeof this.customTextResponse === 'function') {
      text = this.customTextResponse(options.prompt);
    } else if (typeof this.customTextResponse === 'string') {
      text = this.customTextResponse;
    } else {
      text = `Mock AI response for prompt: "${options.prompt.slice(0, 50)}"`;
    }

    return { text, latencyMs: this.simulatedLatencyMs };
  }

  public async generateStructured<T>(
    options: AiPromptOptions,
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<{ data: T; rawText: string; latencyMs: number }> {
    this.checkSimulatedFailures(signal);

    if (this.simulatedLatencyMs > 0) {
      await this.sleep(this.simulatedLatencyMs, signal);
    }

    if (this.returnMalformedJson) {
      throw new AiSchemaError('Failed to parse model output as JSON: Unexpected end of JSON input');
    }

    let rawData: unknown;
    if (typeof this.customStructuredResponse === 'function') {
      const custom = this.customStructuredResponse(options.prompt, options);
      if (custom !== undefined) {
        rawData = custom;
      }
    } else if (this.customStructuredResponse !== undefined) {
      rawData = this.customStructuredResponse;
    }

    if (rawData === undefined) {
      if (this.defaultStructured !== undefined) {
        rawData = this.defaultStructured;
      } else if (options.kind === 'injection_detection') {
        rawData = {
          is_injection: false,
          confidence: 'HIGH',
          attack_categories: [],
          explanation: 'Mock AI injection detection: content is clean.',
        };
      } else if (options.kind === 'policy_drafter') {
        rawData = buildMockPolicyDraft(options.prompt);
      } else {
        // Create a mock payload based on common PayGuard structured output expectations
        rawData = {
          summary: `Mock AI risk summary for ${options.kind}.`,
          suspicious_phrases: [],
          risk_level: 'LOW',
          risk_score: 0,
        };
      }
    }

    const parseResult = schema.safeParse(rawData);
    if (!parseResult.success) {
      const issues = parseResult.error.issues.map(
        (i) => `${i.path.join('.') || 'root'}: ${i.message}`
      );
      throw new AiSchemaError(
        `Mock output failed schema validation: ${issues.join(', ')}`,
        issues
      );
    }

    const rawText = JSON.stringify(parseResult.data);
    return { data: parseResult.data, rawText, latencyMs: this.simulatedLatencyMs };
  }

  private checkSimulatedFailures(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new AiTimeoutError(10_000);
    }
    if (this.shouldTimeout) {
      throw new AiTimeoutError(10_000);
    }
    if (this.simulateRateLimit) {
      throw new AiRateLimitError(30_000);
    }
    if (this.simulateHttpError) {
      throw new AiProviderError(
        this.simulateHttpError.message,
        this.simulateHttpError.statusCode,
        this.simulateHttpError.retryable ?? false
      );
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new AiTimeoutError(10_000));
          },
          { once: true }
        );
      }
    });
  }
}
