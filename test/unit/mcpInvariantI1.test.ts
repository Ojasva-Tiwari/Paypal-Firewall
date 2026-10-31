/**
 * PayGuard — Milestone M3: MCP Integration
 * Unit Tests: M3-T5 Tool Surface Invariant Test (Invariant I1)
 *
 * Enforces Invariant I1:
 * "The agent tool surface never includes approve, capture, void, refund, or credential access."
 * "The agent-facing MCP tools are exactly: request_payment, get_payment_status, get_budget, list_vendors."
 *
 * This test suite fails if ANY extra, administrative, or money-moving tool is registered.
 */

import { describe, it, expect } from 'vitest';
import {
  CANONICAL_TOOL_NAMES,
  FORBIDDEN_TOOL_KEYWORDS,
  TOOL_DEFINITIONS,
  createPayGuardMcpServer,
} from '../../src/mcp/server.js';
import { createDatabase, runMigrations } from '../../src/db/connection.js';

describe('M3-T5: Invariant I1 — Strict Tool Surface Enforcement', () => {
  it('1. Registered tool count is strictly and exactly 4', () => {
    expect(TOOL_DEFINITIONS.length).toBe(4);
    expect(CANONICAL_TOOL_NAMES.length).toBe(4);
  });

  it('2. Registered tool names match canonical list exactly', () => {
    const definedNames = TOOL_DEFINITIONS.map((t) => t.name).sort();
    const expectedNames = [
      'get_budget',
      'get_payment_status',
      'list_vendors',
      'request_payment',
    ].sort();

    expect(definedNames).toEqual(expectedNames);
  });

  it('3. Invariant I1: Tool names do not contain forbidden keywords (approve, capture, void, refund, credential)', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const lowerName = tool.name.toLowerCase();
      for (const keyword of FORBIDDEN_TOOL_KEYWORDS) {
        expect(
          lowerName.includes(keyword),
          `Invariant I1 Violation: Tool "${tool.name}" contains forbidden keyword "${keyword}"`
        ).toBe(false);
      }
    }
  });

  it('4. Server instance dynamically returns strictly the 4 canonical tools on listTools', async () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const mcpServer = createPayGuardMcpServer({ db });

    const registered = mcpServer.getRegisteredTools();
    expect(registered.length).toBe(4);
    expect(registered.map((t) => t.name)).toEqual([
      'request_payment',
      'get_payment_status',
      'get_budget',
      'list_vendors',
    ]);

    db.close();
  });

  it('5. Tool input schemas do not accept agent_id (agent identity derived strictly from auth)', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(
        properties.agent_id,
        `Security Violation: Tool "${tool.name}" accepts client-supplied agent_id`
      ).toBeUndefined();
      expect(
        properties.agentId,
        `Security Violation: Tool "${tool.name}" accepts client-supplied agentId`
      ).toBeUndefined();
    }
  });

  it('6. Tool input schemas do not accept credentials or tokens', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(properties.token).toBeUndefined();
      expect(properties.vault_token_id).toBeUndefined();
      expect(properties.client_secret).toBeUndefined();
      expect(properties.password).toBeUndefined();
    }
  });
});

