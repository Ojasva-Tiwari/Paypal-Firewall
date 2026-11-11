# PayGuard Architecture

PayGuard is an **MCP policy firewall** sitting between AI agents and PayPal Sandbox. Untrusted AI agents can only discover and request payments through four canonical MCP tools over Streamable HTTP (`/mcp`), while a deterministic policy engine evaluates rules to **ALLOW** (instant Orders v2 `CAPTURE`), **HOLD** (native Orders v2 `AUTHORIZE` hold requiring owner approval), or **DENY**.

> **Verification Boundary**: Core policy evaluation, SQLite transactional state machine, MCP isolation, owner auth/CSRF (API and browser `/a/:token`), AI strictness invariants, and Telegram webhook/callback security are **implemented and unit-tested** (`64` Vitest files, `1,428` tests). Live PayPal Sandbox end-to-end payment flows (`C1`/`C2`/`C3`), live Gemini `gemini-3.5-flash-lite` inference (`S8`/`C3`), and runtime `/healthz` + dashboard + 4-tool `/mcp` serving are **live-verified**. Docker container execution, live Telegram Bot API delivery, live interactive Playwright UI clicks, and `M5-T8` PayPal activity reporting are **not live-verified or deferred** (see [README.md](../README.md#implementation--verification-status)).

---

## 1. High-Level Diagram

```
  AI Agent (untrusted)                            Owner (trusted channel)
  Antigravity / Gemini / scripted client          Dashboard SPA, /a/:token browser form,
          |                                       or optional Telegram inline buttons
          | POST/GET/DELETE /mcp                             |
          | (Bearer API key, session-isolated)               | Cookie+CSRF / Signed Callback
          v                                                  v
  +-----------------------+     +------------------------------------------+
  |  MCP Gateway          | --> |  Core Service & State Machine            |
  |  src/mcp/             |     |  src/core/service.ts + stateMachine.ts   |
  |  - 4 canonical tools  |     |  - BEGIN IMMEDIATE txns + idempotency    |
  |  - 30 req/min, 64kb   |     |  - Rolling 24h ledger & SHA-256 audit    |
  +-----------+-----------+     +----+--------------------+----------------+
              |                      |                    ^
              v                      v                    |
  +-----------------------+  +---------------+  +---------+----------------+
  |  AI Services          |  | Policy Engine |  | ApprovalExecutionService |
  |  src/ai/              |  | src/policy/   |  | src/approvals/service.ts |
  |  - InjectionDetector  |  | Pure rules,   |  | Shared by /api, /a/:token|
  |  - RiskExplainer      |  | minor units   |  | Telegram & HoldExpiry    |
  |  - PolicyDrafter      |  +-------+-------+  +------------+-------------+
  |  (Stricter-only, I6)  |          |                       |
  +-----------------------+          +-----------+-----------+
                                                 |
                                    +------------+------------+
                                    |                         |
                                    v (Order/Capture)         v (Auth Void)
                         +--------------------+     +--------------------+
                         | executeDecision()  |     | Authorizations v2  |
                         | src/core/          |     | voidAuthorization  |
                         | (Single Order/     |     | (via Service /     |
                         |  Capture chokepoint|     |  Workers)          |
                         +---------+----------+     +---------+----------+
                                   |                          |
                                   +------------+-------------+
                                                v
                           +-----------------------------------------+
                           | PayPal Sandbox Gateway (src/paypal/)    |
                           | OAuth, Vault v3, Orders v2, Auth v2,    |
                           | Reconcile (api-m.sandbox.paypal.com)    |
                           +-----------------------------------------+
```

---

## 2. Component Responsibilities

| Component | Directory | Responsibility |
|---|---|---|
| **MCP Gateway** | [`src/mcp/`](../src/mcp) | Streamable HTTP transport (`/mcp`), SHA-256 Bearer auth, per-session agent isolation (`403`/`404`), 30 req/min limiter, `64kb` body cap, and strictly 4 tools (`request_payment`, `get_payment_status`, `get_budget`, `list_vendors`). (`stdio` transport deferred.) |
| **Core Lifecycle** | [`src/core/`](../src/core) | Idempotent request ingestion, deterministic state machine, atomic `RESERVE`/`SPEND`/`RELEASE` ledger reservations, SHA-256 chained `audit_log`. `executeDecision` is the **sole choke point** for PayPal order creation and authorization capture. |
| **Policy Engine** | [`src/policy/`](../src/policy) | Pure deterministic rules `(request, facts, policy, aiFlags, now) -> decision` using integer minor units (`MinorUnits`). Evaluates hard caps (`DENY`), rolling 24h global/agent budgets, velocity, duplicates, categories, and `AI_FLAG` escalations. |
| **PayPal Gateway** | [`src/paypal/`](../src/paypal) | Token manager with early refresh, Vault v3 client, Orders v2 client (`Prefer: return=representation` + reduced-response fallback + `OrderError.orderId` preservation), Authorizations v2 capture/void, and dual-attestation crash reconciler (`ReconcilerWorker`). |
| **Approval Service** | [`src/approvals/`](../src/approvals) | Single-use SHA-256 approval tokens bound to `snapshot_hash`, unified `ApprovalExecutionService`, browser `/a/:token` SSR HTML + scoped form `_csrf` router, and `HoldExpiryWorker` (30s interval + lazy expiry on reads/approvals). |
| **Telegram Channel** | [`src/telegram/`](../src/telegram) | Optional P1 integration (`TELEGRAM_MODE=disabled\|webhook`): constant-time webhook secret check, one-time `/start` linking with link-epoch fencing, AES-256-GCM inline callback buttons, and `NotificationOutboxWorker`. |
| **AI Services** | [`src/ai/`](../src/ai) | `GeminiProvider` (`gemini-3.5-flash-lite` over native `fetch` with `x-goog-api-key`) & `MockAiProvider`, 15-min `ai_runs` cache, `InjectionDetector` (`off\|advisory\|enforce`), `RiskExplainer`, and `PolicyDrafter` (bounded by `MAX_HARD_CAP_MINOR`). |
| **Dashboard & API** | [`src/api/`](../src/api), [`web/`](../web) | Owner REST API (`/api/*`, Argon2id passphrase auth, persistent SQLite `owner_sessions`, header CSRF) and React 19 / Vite 7 / Tailwind 4 SPA (`Overview`, `Payments`, `Approvals`, `Agents`, `Policies`, `Vendors`, `Audit`, `Settings`). (`GET /api/paypal/activity` reporting stub deferred.) |
| **Persistence** | [`src/db/`](../src/db) | SQLite (`better-sqlite3`, WAL mode, `foreign_keys = ON`, `BEGIN IMMEDIATE`), migrations `001`–`012`, append-only audit & immutable policy triggers. |
| **Configuration** | [`src/config/`](../src/config) | Strict Zod env validation, Sandbox URL lock (`ALLOW_PRODUCTION` guard), and `validateHardCapWithinCeiling()` (`MAX_HARD_CAP_MINOR`). |

---

## 3. Trust Boundaries

- **Untrusted**: The AI agent, all input parameters sent via MCP (including `purpose`, `source_context`, categories, and arbitrary payee strings).
- **Semi-trusted**: AI outputs (`RiskExplainer`, `InjectionDetector`, `PolicyDrafter`) — bounded with Zod schemas, capped in length, delimiter-escaped, unable to relax rules (`I6`), and never auto-activated.
- **Trusted**: The deterministic policy engine, SQLite database constraints/triggers, authenticated owner sessions (`owner_sessions` + CSRF), signed Telegram callbacks verified against active owner links/epochs, and verified PayPal Sandbox API responses.

---

## 4. State Transitions

```
RECEIVED -> DENIED                         (terminal; no ledger reservation)
RECEIVED -> AUTO_EXECUTING -> CAPTURED     (ALLOW -> Orders v2 CAPTURE -> SPEND)
RECEIVED -> AUTO_EXECUTING -> FAILED       (definitive pre-capture failure -> RELEASE)
RECEIVED -> HELD -> APPROVED -> CAPTURING -> CAPTURED | FAILED
HELD -> VOIDED                             (owner reject -> RELEASE + PayPal void)
HELD -> EXPIRED -> VOIDED                  (TTL elapsed -> RELEASE + PayPal void)
```

- Every state transition inserts an append-only SHA-256 hash-chained `audit_log` row within the same `BEGIN IMMEDIATE` transaction.
- Ambiguous network outcomes retain `AUTO_EXECUTING` / `CAPTURING` / `HELD` (preserving ledger reservations and recovered `paypal_order_id`) for `ReconcilerWorker` dual-attestation rather than failing open or double-charging.

---

## 5. Architectural Invariants (I1–I7)

1. **I1**: The agent-facing MCP surface exposes strictly `request_payment`, `get_payment_status`, `get_budget`, and `list_vendors` — never approve, capture, void, refund, policy-edit, vendor-edit, or credential access.
2. **I2**: Every payment request terminates in at most one terminal state; every state transition writes an `audit_log` row in the same `BEGIN IMMEDIATE` SQLite transaction.
3. **I3**: Order creation (`CAPTURE` / `AUTHORIZE`) and authorization captures run exclusively through `executeDecision` in [`src/core/executeDecision.ts`](../src/core/executeDecision.ts); owner/worker authorization voids execute cleanly via `ApprovalExecutionService` / `ReconcilerWorker` -> `PayPalAuthorizationsService.voidAuthorization`.
4. **I4**: Money is represented strictly as integer minor units (`MinorUnits`); decimal string conversion happens exclusively at the PayPal API and display boundaries.
5. **I5**: Approval and capture actions bind strictly to an immutable SHA-256 `snapshot_hash`; captured amounts are read from the stored DB snapshot, never from client request bodies.
6. **I6**: AI output can only add restrictions (e.g., escalate `ALLOW` to `HOLD` via `AI_FLAG`), never loosen restrictions or exceed `MAX_HARD_CAP_MINOR`.
7. **I7**: Secrets, OAuth tokens, raw API keys, and full vault token IDs are masked/omitted from logs, prompts, API responses, and version control.
