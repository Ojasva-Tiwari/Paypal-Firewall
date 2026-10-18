# PayGuard Architecture

PayGuard is an **MCP policy firewall** sitting between AI agents and PayPal. The agent can only request payments via MCP (`request_payment`), while a deterministic policy engine evaluates rules to **ALLOW** (instant capture), **HOLD** (native PayPal authorization hold requiring owner approval), or **DENY**.

> **Important**: This document reflects the foundational architecture plan. No PayPal integration or live endpoints have been claimed as verified at this initial skeleton stage.

---

## 1. High-Level Diagram

```
  AI Agent (untrusted)                        Owner (trusted channel)
  Antigravity / Claude / scripted agent       phone browser, Telegram, dashboard
          |  MCP over HTTP (agent API key)             |
          v                                            v
  +-------------------+     +-----------+      +---------------------+
  |  MCP Gateway      | --> |   Core    | <--  |  Approval service   |
  |  src/mcp          |     | lifecycle |      |  links, Telegram,   |
  +-------------------+     | + state   |      |  expiry worker      |
                            | machine   |      +---------------------+
                            +-----+-----+                 ^
                                  |                       |
                    +-------------+------------+    +-----+------+
                    |  Policy engine (pure)    |    | Dashboard  |
                    |  src/policy              |    | API + Web  |
                    +-------------+------------+    +------------+
                                  |
          +-----------------------+-----------------------+
          v                       v                       v
   +-------------+        +--------------+        +--------------+
   | PayPal gw   |        |  SQLite DB   |        |  AI services |
   | src/paypal  |        |  + audit log |        |  src/ai      |
   +------+------+        +--------------+        +--------------+
          v
   PayPal sandbox (OAuth, Vault v3, Orders v2, Payments v2)
```

---

## 2. Component Responsibilities

| Component | Directory | Responsibility |
|---|---|---|
| **MCP Gateway** | `src/mcp/` | HTTP transport (`/mcp`) & stdio fallback, agent bearer auth, tool schemas (`request_payment`, `get_payment_status`, `get_budget`, `list_vendors`). Strictly exposes agent-safe tools only. |
| **Core Lifecycle** | `src/core/` | Request lifecycle, state machine, transactional ledger reservations, idempotency. `executeDecision` is the **single choke point** for money-moving PayPal calls. |
| **Policy Engine** | `src/policy/` | Pure deterministic functions `(request, facts, policy) -> decision`. Injected clock (`now`). Evaluates hard limits, budgets, velocity, duplicate detection, and stricter-only AI flags. |
| **PayPal Gateway** | `src/paypal/` | Token manager with early refresh, Vault v3 client, Orders v2 client, Payments v2 authorization capture/void, idempotency headers, reconciler. |
| **Approval Service** | `src/approvals/` | Minting and verification of single-use cryptographically bound tokens, mobile web approval handler, expiry worker, and optional Telegram bot. |
| **AI Services** | `src/ai/` | Provider interface (Gemini first via free tier), risk explainer (structured output layered on top of deterministic reason codes), stricter-only injection flag. |
| **Dashboard & API** | `src/api/`, `web/` | Owner REST API (session + CSRF protected) and React/Vite dashboard for policy management, audit feed, pending approval triage. |
| **Persistence** | `src/db/` | SQLite (`better-sqlite3`), migrations, repositories, append-only `audit_log`. |
| **Configuration** | `src/config/` | Strict schema validation of environment variables; prevents production mode unless explicitly overridden. |

---

## 3. Trust Boundaries

- **Untrusted**: The AI agent, all input parameters sent via MCP (including `source_context`, invoices, descriptions, and arbitrary payee names).
- **Semi-trusted**: AI output (used only for display summaries, risk drafting, and stricter-only advisory flags; never permitted to expand spend authority).
- **Trusted**: The deterministic policy engine, the internal SQLite database, owner-authenticated sessions, and PayPal sandbox responses.

---

## 4. State Transitions

```
RECEIVED -> DENIED (terminal)
RECEIVED -> AUTO_EXECUTING -> CAPTURED | FAILED
RECEIVED -> HELD -> APPROVED -> CAPTURING -> CAPTURED | FAILED
HELD -> VOIDED               (owner rejects)
HELD -> EXPIRED -> VOIDED    (timeout; default deny)
```

---

## 5. Architectural Invariants (I1–I7)

1. **I1**: The agent-facing MCP surface never exposes approve, capture, void, refund, or credential access.
2. **I2**: Every payment request terminates in exactly one terminal state; every state transition writes an audit row in the same database transaction.
3. **I3**: No money-moving PayPal call occurs outside `src/core/executeDecision.ts`.
4. **I4**: Money is represented strictly as integer minor units (cents); conversion to decimal strings occurs exclusively at the PayPal API boundary.
5. **I5**: Approval and capture actions bind strictly to an immutable snapshot hash; captured amounts are read from the database, never from client request payloads.
6. **I6**: AI output can only add restrictions (e.g. escalate ALLOW to HOLD), never loosen restrictions.
7. **I7**: Secrets and tokens are never logged, committed to source control, or passed into agent prompts.
