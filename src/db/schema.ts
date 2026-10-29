/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T2: SQLite Database Schema & Migrations
 *
 * Implements the full Section 8 SQLite DDL:
 * - 10 canonical tables
 * - Column constraints and foreign keys
 * - Canonical indexes
 * - Partial unique index enforcing exactly one active policy version
 * - Triggers enforcing append-only immutability on audit_log
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    up: `
      -- 1. Owners (single-row table enforced by CHECK constraint)
      CREATE TABLE IF NOT EXISTS owners (
        id TEXT PRIMARY KEY CHECK (id = 'default'),
        display_name TEXT NOT NULL,
        passphrase_hash TEXT NOT NULL,
        telegram_chat_id TEXT,
        created_at TEXT NOT NULL
      );

      -- 2. Agents
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED')),
        daily_budget_minor INTEGER NOT NULL CHECK (daily_budget_minor >= 0),
        created_at TEXT NOT NULL
      );

      -- 3. Vendors
      CREATE TABLE IF NOT EXISTS vendors (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'UNVERIFIED', 'BLOCKED')),
        categories TEXT NOT NULL,
        currencies TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- 4. Vendor Vault Tokens
      CREATE TABLE IF NOT EXISTS vendor_vault_tokens (
        id TEXT PRIMARY KEY,
        vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
        paypal_customer_ref TEXT NOT NULL,
        vault_token_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- 5. Policy Versions
      CREATE TABLE IF NOT EXISTS policy_versions (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        rules TEXT NOT NULL,
        author TEXT NOT NULL CHECK (author IN ('owner', 'ai_draft_confirmed')),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL
      );

      -- Enforce exactly one active policy version across concurrent writes
      CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_versions_single_active
        ON policy_versions(active) WHERE active = 1;

      -- 6. Payment Requests
      CREATE TABLE IF NOT EXISTS payment_requests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL,
        vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        currency TEXT NOT NULL,
        purpose TEXT NOT NULL,
        category TEXT,
        source_context_excerpt TEXT,
        source_context_hash TEXT,
        status TEXT NOT NULL,
        decision TEXT,
        reasons TEXT,
        policy_version_id TEXT REFERENCES policy_versions(id) ON DELETE RESTRICT,
        snapshot_hash TEXT,
        paypal_order_id TEXT,
        paypal_authorization_id TEXT,
        paypal_capture_id TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (agent_id, idempotency_key)
      );

      -- Canonical indexes for payment_requests
      CREATE INDEX IF NOT EXISTS idx_payment_requests_status_expires
        ON payment_requests(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_payment_requests_agent_created
        ON payment_requests(agent_id, created_at);

      -- 7. Ledger
      CREATE TABLE IF NOT EXISTS ledger (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('RESERVE', 'RELEASE', 'SPEND')),
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        currency TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Canonical index for ledger
      CREATE INDEX IF NOT EXISTS idx_ledger_created_at
        ON ledger(created_at);

      -- 8. Approvals
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
        token_hash TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL CHECK (action IN ('APPROVE', 'VOID')),
        expires_at TEXT NOT NULL,
        used_at TEXT,
        channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
        created_at TEXT NOT NULL
      );

      -- 9. Audit Log (Append-only)
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN ('agent', 'owner', 'system', 'ai')),
        event TEXT NOT NULL,
        request_id TEXT,
        payload TEXT NOT NULL,
        prev_hash TEXT,
        hash TEXT NOT NULL
      );

      -- Canonical index for audit_log
      CREATE INDEX IF NOT EXISTS idx_audit_log_request_id
        ON audit_log(request_id);

      -- Enforce append-only immutability on audit_log at SQLite engine level
      CREATE TRIGGER IF NOT EXISTS audit_log_prevent_update
      BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE operations are strictly prohibited');
      END;

      CREATE TRIGGER IF NOT EXISTS audit_log_prevent_delete
      BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only: DELETE operations are strictly prohibited');
      END;

      -- 10. AI Runs
      CREATE TABLE IF NOT EXISTS ai_runs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        request_id TEXT REFERENCES payment_requests(id) ON DELETE SET NULL,
        model TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        output TEXT NOT NULL,
        latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: '002_policy_version_immutability',
    up: `
      -- Enforce uniqueness of policy version numbers
      CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_versions_version
        ON policy_versions(version);

      -- Enforce immutability of policy definition columns while allowing active switching
      CREATE TRIGGER IF NOT EXISTS policy_versions_prevent_update
      BEFORE UPDATE ON policy_versions
      FOR EACH ROW
      WHEN (
        OLD.id IS NOT NEW.id OR
        OLD.version IS NOT NEW.version OR
        OLD.rules IS NOT NEW.rules OR
        OLD.author IS NOT NEW.author OR
        OLD.created_at IS NOT NEW.created_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'policy_versions is immutable: only active status may be updated');
      END;

      CREATE TRIGGER IF NOT EXISTS policy_versions_prevent_delete
      BEFORE DELETE ON policy_versions
      BEGIN
        SELECT RAISE(ABORT, 'policy_versions is immutable: DELETE operations are strictly prohibited');
      END;
    `,
  },
];
