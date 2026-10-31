/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T2: Typed Repository API
 *
 * Implements the minimal, focused typed repository interfaces
 * corresponding to the Section 8 data model.
 */

import type { Database } from 'better-sqlite3';
import type {
  OwnerRow,
  AgentRow,
  VendorRow,
  VendorVaultTokenRow,
  PolicyVersionRow,
  PaymentRequestRow,
  LedgerRow,
  ApprovalRow,
  AuditLogRow,
  AiRunRow,
} from './types.js';

export class Repositories {
  constructor(private readonly db: Database) {}

  public readonly owners = {
    get: (): OwnerRow | undefined => {
      return this.db.prepare('SELECT * FROM owners WHERE id = ?').get('default') as OwnerRow | undefined;
    },
    upsert: (owner: Omit<OwnerRow, 'id'> & { id?: 'default' }): void => {
      this.db.prepare(`
        INSERT INTO owners (id, display_name, passphrase_hash, telegram_chat_id, created_at)
        VALUES ('default', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          passphrase_hash = excluded.passphrase_hash,
          telegram_chat_id = excluded.telegram_chat_id
      `).run(
        owner.display_name,
        owner.passphrase_hash,
        owner.telegram_chat_id,
        owner.created_at
      );
    },
  };

  public readonly agents = {
    getById: (id: string): AgentRow | undefined => {
      return this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    },
    getByApiKeyHash: (apiKeyHash: string): AgentRow | undefined => {
      return this.db.prepare('SELECT * FROM agents WHERE api_key_hash = ?').get(apiKeyHash) as AgentRow | undefined;
    },
    listActive: (): AgentRow[] => {
      return this.db.prepare("SELECT * FROM agents WHERE status = 'ACTIVE' ORDER BY created_at ASC").all() as AgentRow[];
    },
    listAll: (): AgentRow[] => {
      return this.db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as AgentRow[];
    },
    insert: (agent: AgentRow): void => {
      this.db.prepare(`
        INSERT INTO agents (id, name, api_key_hash, status, daily_budget_minor, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        agent.id,
        agent.name,
        agent.api_key_hash,
        agent.status,
        agent.daily_budget_minor,
        agent.created_at
      );
    },
    updateStatus: (id: string, status: 'ACTIVE' | 'SUSPENDED'): void => {
      this.db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
    },
  };

  public readonly vendors = {
    getById: (id: string): VendorRow | undefined => {
      return this.db.prepare('SELECT * FROM vendors WHERE id = ?').get(id) as VendorRow | undefined;
    },
    listAll: (): VendorRow[] => {
      return this.db.prepare('SELECT * FROM vendors ORDER BY created_at ASC').all() as VendorRow[];
    },
    insert: (vendor: VendorRow): void => {
      this.db.prepare(`
        INSERT INTO vendors (id, name, status, categories, currencies, connector_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        vendor.id,
        vendor.name,
        vendor.status,
        vendor.categories,
        vendor.currencies,
        vendor.connector_key,
        vendor.created_at
      );
    },
    updateStatus: (id: string, status: 'ACTIVE' | 'UNVERIFIED' | 'BLOCKED'): void => {
      this.db.prepare('UPDATE vendors SET status = ? WHERE id = ?').run(status, id);
    },
  };

  public readonly vendorVaultTokens = {
    getByVendorId: (vendorId: string): VendorVaultTokenRow | undefined => {
      return this.db.prepare('SELECT * FROM vendor_vault_tokens WHERE vendor_id = ?').get(vendorId) as VendorVaultTokenRow | undefined;
    },
    insert: (token: VendorVaultTokenRow): void => {
      this.db.prepare(`
        INSERT INTO vendor_vault_tokens (id, vendor_id, paypal_customer_ref, vault_token_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        token.id,
        token.vendor_id,
        token.paypal_customer_ref,
        token.vault_token_id,
        token.status,
        token.created_at
      );
    },
    updateStatus: (id: string, status: string): void => {
      this.db.prepare('UPDATE vendor_vault_tokens SET status = ? WHERE id = ?').run(status, id);
    },
  };

  public readonly policyVersions = {
    getActive: (): PolicyVersionRow | undefined => {
      return this.db.prepare('SELECT * FROM policy_versions WHERE active = 1').get() as PolicyVersionRow | undefined;
    },
    getByVersion: (version: number): PolicyVersionRow | undefined => {
      return this.db.prepare('SELECT * FROM policy_versions WHERE version = ?').get(version) as PolicyVersionRow | undefined;
    },
    listAll: (): PolicyVersionRow[] => {
      return this.db.prepare('SELECT * FROM policy_versions ORDER BY version DESC').all() as PolicyVersionRow[];
    },
    getNextVersion: (): number => {
      const row = this.db.prepare('SELECT MAX(version) as max_v FROM policy_versions').get() as { max_v: number | null } | undefined;
      return (row?.max_v ?? 0) + 1;
    },
    insert: (policy: PolicyVersionRow): void => {
      this.db.prepare(`
        INSERT INTO policy_versions (id, version, rules, author, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        policy.id,
        policy.version,
        policy.rules,
        policy.author,
        policy.active,
        policy.created_at
      );
    },
    setActive: (id: string): void => {
      // Transactional single-active switch protected by idx_policy_versions_single_active
      const tx = this.db.transaction(() => {
        this.db.prepare('UPDATE policy_versions SET active = 0 WHERE active = 1').run();
        const res = this.db.prepare('UPDATE policy_versions SET active = 1 WHERE id = ?').run(id);
        if (res.changes === 0) {
          throw new Error(`Policy version with id ${id} not found`);
        }
      });
      tx.immediate();
    },
  };

  public readonly paymentRequests = {
    getById: (id: string): PaymentRequestRow | undefined => {
      return this.db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id) as PaymentRequestRow | undefined;
    },
    getByAgentAndIdempotencyKey: (agentId: string, idempotencyKey: string): PaymentRequestRow | undefined => {
      return this.db.prepare('SELECT * FROM payment_requests WHERE agent_id = ? AND idempotency_key = ?').get(
        agentId,
        idempotencyKey
      ) as PaymentRequestRow | undefined;
    },
    insert: (request: PaymentRequestRow): void => {
      this.db.prepare(`
        INSERT INTO payment_requests (
          id, agent_id, idempotency_key, vendor_id, amount_minor, currency,
          purpose, category, source_context_excerpt, source_context_hash,
          status, decision, reasons, policy_version_id, snapshot_hash,
          paypal_order_id, paypal_authorization_id, paypal_capture_id,
          expires_at, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.id,
        request.agent_id,
        request.idempotency_key,
        request.vendor_id,
        request.amount_minor,
        request.currency,
        request.purpose,
        request.category,
        request.source_context_excerpt,
        request.source_context_hash,
        request.status,
        request.decision,
        request.reasons,
        request.policy_version_id,
        request.snapshot_hash,
        request.paypal_order_id,
        request.paypal_authorization_id,
        request.paypal_capture_id,
        request.expires_at,
        request.created_at,
        request.updated_at
      );
    },
    updateStatusAndDecision: (
      id: string,
      updates: {
        status: string;
        decision?: string | null;
        reasons?: string | null;
        snapshotHash?: string | null;
        expiresAt?: string | null;
        updatedAt?: string;
      }
    ): void => {
      const updatedAt = updates.updatedAt || new Date().toISOString();
      this.db.prepare(`
        UPDATE payment_requests
        SET status = ?,
            decision = COALESCE(?, decision),
            reasons = COALESCE(?, reasons),
            snapshot_hash = COALESCE(?, snapshot_hash),
            expires_at = COALESCE(?, expires_at),
            updated_at = ?
        WHERE id = ?
      `).run(
        updates.status,
        updates.decision ?? null,
        updates.reasons ?? null,
        updates.snapshotHash ?? null,
        updates.expiresAt ?? null,
        updatedAt,
        id
      );
    },
    updatePayPalIds: (
      id: string,
      ids: {
        orderId?: string | null;
        authorizationId?: string | null;
        captureId?: string | null;
        updatedAt?: string;
      }
    ): void => {
      const updatedAt = ids.updatedAt || new Date().toISOString();
      this.db.prepare(`
        UPDATE payment_requests
        SET paypal_order_id = COALESCE(?, paypal_order_id),
            paypal_authorization_id = COALESCE(?, paypal_authorization_id),
            paypal_capture_id = COALESCE(?, paypal_capture_id),
            updated_at = ?
        WHERE id = ?
      `).run(
        ids.orderId ?? null,
        ids.authorizationId ?? null,
        ids.captureId ?? null,
        updatedAt,
        id
      );
    },
    updateRemoteVoidStatus: (
      id: string,
      status: 'PENDING' | 'CONFIRMED' | 'FAILED',
      updatedAt?: string
    ): void => {
      const now = updatedAt || new Date().toISOString();
      this.db.prepare(`
        UPDATE payment_requests
        SET remote_void_status = ?,
            updated_at = ?
        WHERE id = ?
      `).run(status, now, id);
    },
    listNeedingReconciliation: (): PaymentRequestRow[] => {
      return this.db
        .prepare(`
          SELECT * FROM payment_requests
          WHERE status IN ('AUTO_EXECUTING', 'CAPTURING', 'HELD', 'APPROVED')
             OR remote_void_status IN ('PENDING', 'FAILED')
          ORDER BY created_at ASC
        `)
        .all() as PaymentRequestRow[];
    },
    listExpiredHeld: (nowIso?: string): PaymentRequestRow[] => {
      const cutoff = nowIso || new Date().toISOString();
      return this.db
        .prepare(`
          SELECT * FROM payment_requests
          WHERE status = 'HELD'
            AND expires_at IS NOT NULL
            AND expires_at <= ?
          ORDER BY expires_at ASC
        `)
        .all(cutoff) as PaymentRequestRow[];
    },
    list: (options?: { status?: string; limit?: number; offset?: number }): PaymentRequestRow[] => {
      const limit = Math.min(Math.max(1, options?.limit ?? 50), 100);
      const offset = Math.max(0, options?.offset ?? 0);
      if (options?.status) {
        return this.db
          .prepare(
            'SELECT * FROM payment_requests WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?'
          )
          .all(options.status, limit, offset) as PaymentRequestRow[];
      }
      return this.db
        .prepare(
          'SELECT * FROM payment_requests ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?'
        )
        .all(limit, offset) as PaymentRequestRow[];
    },
    count: (options?: { status?: string }): number => {
      if (options?.status) {
        const row = this.db.prepare('SELECT COUNT(*) as c FROM payment_requests WHERE status = ?').get(options.status) as { c: number } | undefined;
        return row?.c ?? 0;
      }
      const row = this.db.prepare('SELECT COUNT(*) as c FROM payment_requests').get() as { c: number } | undefined;
      return row?.c ?? 0;
    },
    count24hByDecision: (windowStartIso: string): { total: number; allowed: number; held: number; denied: number } => {
      const query = `
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN decision = 'ALLOW' THEN 1 ELSE 0 END) as allowed,
          SUM(CASE WHEN decision = 'HOLD' THEN 1 ELSE 0 END) as held,
          SUM(CASE WHEN decision = 'DENY' THEN 1 ELSE 0 END) as denied
        FROM payment_requests
        WHERE created_at >= ?
      `;
      const row = this.db.prepare(query).get(windowStartIso) as {
        total: number;
        allowed: number | null;
        held: number | null;
        denied: number | null;
      } | undefined;
      return {
        total: row?.total ?? 0,
        allowed: row?.allowed ?? 0,
        held: row?.held ?? 0,
        denied: row?.denied ?? 0,
      };
    },
    listRecent: (limit = 10): PaymentRequestRow[] => {
      const clampedLimit = Math.min(Math.max(1, limit), 50);
      return this.db
        .prepare('SELECT * FROM payment_requests ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(clampedLimit) as PaymentRequestRow[];
    },
  };

  public readonly ledger = {
    insert: (entry: LedgerRow): void => {
      this.db.prepare(`
        INSERT INTO ledger (id, request_id, kind, amount_minor, currency, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.request_id,
        entry.kind,
        entry.amount_minor,
        entry.currency,
        entry.created_at
      );
    },
    listByRequestId: (requestId: string): LedgerRow[] => {
      return this.db.prepare('SELECT * FROM ledger WHERE request_id = ? ORDER BY created_at ASC').all(requestId) as LedgerRow[];
    },
  };

  public readonly approvals = {
    getById: (id: string): ApprovalRow | undefined => {
      return this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
    },
    getByTokenHash: (tokenHash: string): ApprovalRow | undefined => {
      return this.db.prepare('SELECT * FROM approvals WHERE token_hash = ?').get(tokenHash) as ApprovalRow | undefined;
    },
    insert: (approval: ApprovalRow): void => {
      this.db.prepare(`
        INSERT INTO approvals (id, request_id, token_hash, action, expires_at, used_at, channel, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        approval.id,
        approval.request_id,
        approval.token_hash,
        approval.action,
        approval.expires_at,
        approval.used_at,
        approval.channel,
        approval.created_at
      );
    },
    markUsed: (tokenHash: string, usedAtIso?: string): boolean => {
      const usedAt = usedAtIso || new Date().toISOString();
      const res = this.db.prepare('UPDATE approvals SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(
        usedAt,
        tokenHash
      );
      return res.changes > 0;
    },
    listByRequestId: (requestId: string): ApprovalRow[] => {
      return this.db
        .prepare('SELECT * FROM approvals WHERE request_id = ? ORDER BY created_at ASC')
        .all(requestId) as ApprovalRow[];
    },
    invalidateForRequest: (requestId: string, usedAtIso?: string): number => {
      const usedAt = usedAtIso || new Date().toISOString();
      const res = this.db
        .prepare('UPDATE approvals SET used_at = ? WHERE request_id = ? AND used_at IS NULL')
        .run(usedAt, requestId);
      return res.changes;
    },
  };

  public readonly auditLog = {
    insert: (entry: AuditLogRow): void => {
      this.db.prepare(`
        INSERT INTO audit_log (id, ts, actor, event, request_id, payload, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.ts,
        entry.actor,
        entry.event,
        entry.request_id,
        entry.payload,
        entry.prev_hash,
        entry.hash
      );
    },
    listByRequestId: (requestId: string): AuditLogRow[] => {
      return this.db.prepare('SELECT * FROM audit_log WHERE request_id = ? ORDER BY ts ASC').all(requestId) as AuditLogRow[];
    },
    getLastEntry: (): AuditLogRow | undefined => {
      return this.db.prepare('SELECT * FROM audit_log ORDER BY rowid DESC LIMIT 1').get() as AuditLogRow | undefined;
    },
    list: (options?: { actor?: string; event?: string; requestId?: string; limit?: number; offset?: number }): AuditLogRow[] => {
      const limit = Math.min(Math.max(1, options?.limit ?? 50), 100);
      const offset = Math.max(0, options?.offset ?? 0);
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options?.actor) {
        conditions.push('actor = ?');
        params.push(options.actor);
      }
      if (options?.event) {
        conditions.push('event = ?');
        params.push(options.event);
      }
      if (options?.requestId) {
        conditions.push('request_id = ?');
        params.push(options.requestId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT * FROM audit_log ${whereClause} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);
      return this.db.prepare(sql).all(...params) as AuditLogRow[];
    },
    count: (options?: { actor?: string; event?: string; requestId?: string }): number => {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (options?.actor) {
        conditions.push('actor = ?');
        params.push(options.actor);
      }
      if (options?.event) {
        conditions.push('event = ?');
        params.push(options.event);
      }
      if (options?.requestId) {
        conditions.push('request_id = ?');
        params.push(options.requestId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT COUNT(*) as c FROM audit_log ${whereClause}`;
      const row = this.db.prepare(sql).get(...params) as { c: number } | undefined;
      return row?.c ?? 0;
    },
  };

  public readonly aiRuns = {
    getById: (id: string): AiRunRow | undefined => {
      return this.db.prepare('SELECT * FROM ai_runs WHERE id = ?').get(id) as AiRunRow | undefined;
    },
    insert: (run: AiRunRow): void => {
      this.db.prepare(`
        INSERT INTO ai_runs (id, kind, request_id, model, input_hash, output, latency_ms, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.kind,
        run.request_id,
        run.model,
        run.input_hash,
        run.output,
        run.latency_ms,
        run.status,
        run.created_at
      );
    },
  };
}

export function createRepositories(db: Database): Repositories {
  return new Repositories(db);
}
