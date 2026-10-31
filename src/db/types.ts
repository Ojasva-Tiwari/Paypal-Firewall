/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T2: SQLite Database Types
 *
 * TypeScript types and interfaces for the SQLite database schema
 * per PAYGUARD_PLAN.md Section 8.
 */

import type { MinorUnits } from '../core/money.js';

export interface OwnerRow {
  readonly id: string;
  readonly display_name: string;
  readonly passphrase_hash: string;
  readonly telegram_chat_id: string | null;
  readonly created_at: string;
}

export interface AgentRow {
  readonly id: string;
  readonly name: string;
  readonly api_key_hash: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly daily_budget_minor: MinorUnits;
  readonly created_at: string;
}

export interface VendorRow {
  readonly id: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'UNVERIFIED' | 'BLOCKED';
  readonly categories: string; // JSON array of string
  readonly currencies: string; // JSON array of string
  readonly connector_key: string;
  readonly created_at: string;
}

export interface VendorVaultTokenRow {
  readonly id: string;
  readonly vendor_id: string;
  readonly paypal_customer_ref: string;
  readonly vault_token_id: string;
  readonly status: string;
  readonly created_at: string;
}

export interface PolicyVersionRow {
  readonly id: string;
  readonly version: number;
  readonly rules: string; // JSON PolicyDocument
  readonly author: 'owner' | 'ai_draft_confirmed';
  readonly active: 0 | 1;
  readonly created_at: string;
}

export type RemoteVoidStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

export interface PaymentRequestRow {
  readonly id: string;
  readonly agent_id: string;
  readonly idempotency_key: string;
  readonly vendor_id: string;
  readonly amount_minor: MinorUnits;
  readonly currency: string;
  readonly purpose: string;
  readonly category: string | null;
  readonly source_context_excerpt: string | null;
  readonly source_context_hash: string | null;
  readonly status: string;
  readonly decision: string | null;
  readonly reasons: string | null; // JSON array of ReasonCode
  readonly policy_version_id: string | null;
  readonly snapshot_hash: string | null;
  readonly paypal_order_id: string | null;
  readonly paypal_authorization_id: string | null;
  readonly paypal_capture_id: string | null;
  readonly expires_at: string | null;
  readonly remote_void_status?: RemoteVoidStatus | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface LedgerRow {
  readonly id: string;
  readonly request_id: string;
  readonly kind: 'RESERVE' | 'RELEASE' | 'SPEND';
  readonly amount_minor: MinorUnits;
  readonly currency: string;
  readonly created_at: string;
}

export interface ApprovalRow {
  readonly id: string;
  readonly request_id: string;
  readonly token_hash: string;
  readonly action: 'APPROVE' | 'VOID';
  readonly expires_at: string;
  readonly used_at: string | null;
  readonly channel: 'web' | 'telegram';
  readonly created_at: string;
}

export interface AuditLogRow {
  readonly id: string;
  readonly ts: string;
  readonly actor: 'agent' | 'owner' | 'system' | 'ai';
  readonly event: string;
  readonly request_id: string | null;
  readonly payload: string; // JSON
  readonly prev_hash: string | null;
  readonly hash: string;
}

export interface AiRunRow {
  readonly id: string;
  readonly kind: string;
  readonly request_id: string | null;
  readonly model: string;
  readonly input_hash: string;
  readonly output: string;
  readonly latency_ms: number;
  readonly status: string;
  readonly created_at: string;
}

export interface SchemaMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly applied_at: string;
}
