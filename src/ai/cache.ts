/**
 * PayGuard — Milestone M5: AI Integration & Hardening
 * M5-T1: Canonical AI Cache Key Generator & Hash Computation
 *
 * Implements:
 * - Deterministic, canonical serialization of all output-affecting parameters.
 * - SHA-256 hashing to generate unique input_hash.
 * - Strict isolation: Only successful AI responses are cached; deterministic payment
 *   decisions are NEVER cached.
 */

import { createHash } from 'node:crypto';
import type { AiPromptOptions } from './types.js';

export interface CacheKeyParams {
  readonly kind: string;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly systemInstruction: string;
  readonly prompt: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly schemaId: string;
}

/**
 * Recursively produces a canonical JSON string with object keys sorted lexicographically.
 * Guarantees that equivalent objects always produce byte-for-byte identical strings.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJson(item));
    return `[${items.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`
  );
  return `{${entries.join(',')}}`;
}

/**
 * Normalizes input prompt options and provider attributes into CacheKeyParams.
 */
export function extractCacheKeyParams(
  options: AiPromptOptions,
  providerKind: string,
  modelName: string
): CacheKeyParams {
  return {
    kind: options.kind.trim(),
    provider: providerKind.trim(),
    model: modelName.trim(),
    promptVersion: (options.promptVersion ?? 'v1').trim(),
    systemInstruction: (options.systemInstruction ?? '').trim(),
    prompt: options.prompt.trim(),
    temperature: options.temperature ?? 0.0,
    maxOutputTokens: Math.min(Math.max(options.maxOutputTokens ?? 1024, 1), 2048),
    schemaId: (options.schemaId ?? 'unstructured_text').trim(),
  };
}

/**
 * Computes deterministic SHA-256 hex digest across all output-affecting parameters.
 */
export function computeAiInputHash(params: CacheKeyParams): string {
  const canonicalString = canonicalizeJson(params);
  return createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}

