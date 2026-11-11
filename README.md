# PayGuard

**MCP Policy Firewall for Autonomous AI Agent Payments on PayPal Sandbox**

PayGuard sits between AI agents and PayPal Sandbox. Autonomous agents authenticate to a restricted [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) Streamable HTTP endpoint exposing **strictly four canonical tools**, while a deterministic policy firewall, ACID SQLite ledger, human-approval workflows, and isolated execution choke point control whether any payment can authorize or capture funds.

---

## Key Features

- **Four-Tool Agent Surface (`I1`)**: Agents see only `request_payment`, `get_payment_status`, `get_budget`, and `list_vendors` — never approve, capture, void, refund, policy-edit, or credential access.
- **Deterministic Policy Engine (`src/policy/`)**: Integer minor-unit evaluation (`DENY > HOLD > ALLOW`), hard caps (`MAX_HARD_CAP_MINOR`), per-vendor allowlists, rolling 24-hour global and per-agent budgets, velocity/duplicate checks, and category restrictions.
- **Native PayPal Sandbox Flows (`src/paypal/`)**: Server-to-server Vault v3 wallet tokenization, Orders v2 `CAPTURE` (`ALLOW`) and `AUTHORIZE` (`HOLD`), Authorization v2 capture/void, `Prefer: return=representation`, `PayPal-Request-Id` idempotency, and dual-attestation crash reconciliation.
- **Multi-Channel Human Approvals (`src/approvals/`, `src/telegram/`)**: Shared `ApprovalExecutionService` backing the Owner SPA Dashboard (`/`), mobile-friendly Web Approval links (`/a/:token`), automatic hold expiry worker (`HoldExpiryWorker`), and optional Telegram Bot inline Approve/Void buttons (`TELEGRAM_MODE=webhook`, AES-256-GCM callbacks).
- **Tamper-Evident Persistence (`src/db/`)**: Embedded SQLite (`better-sqlite3`, WAL mode, `BEGIN IMMEDIATE`) with `RESERVE` / `SPEND` / `RELEASE` ledger accounting and trigger-protected SHA-256 hash-chained `audit_log`.
- **Stricter-Only AI Advisor (`src/ai/`)**: Google Gemini (`gemini-3.5-flash-lite`) `RiskExplainer`, two-stage `InjectionDetector` (`off | advisory | enforce`), and plain-English `PolicyDrafter` — strictly unable to loosen rules or bypass `MAX_HARD_CAP_MINOR` (`I6`).

---

## Architecture Overview

```text
  AI Agent (Untrusted)                            Owner (Trusted Channel)
  MCP client via Bearer API key                   Dashboard SPA, /a/:token, Telegram
             |                                                |
             | POST/GET/DELETE /mcp                           | Cookie + CSRF / Telegram Webhook
             v                                                v
  +-----------------------+     +------------------------------------------+
  | MCP Gateway (src/mcp) | --> | Core Service & State Machine (src/core)  |
  | - 4 canonical tools   |     | - Idempotency + BEGIN IMMEDIATE txns     |
  | - Per-session isolate |     | - Rolling 24h ledger (RESERVE/RELEASE/   |
  | - Rate & size limits  |     |   SPEND) + SHA-256 hash-chained audit    |
  +-----------+-----------+     +----+--------------------+----------------+
              |                      |                    |
              v                      v                    v
  +-----------------------+  +---------------+  +--------------------------+
  | AI Advisor (src/ai)   |  | Policy Engine |  | ApprovalExecutionService |
  | - InjectionDetector   |  | (src/policy)  |  | (src/approvals/service)  |
  | - RiskExplainer       |  | Pure rules,   |  | Shared by web dashboard, |
  | - PolicyDrafter       |  | minor units   |  | /a/:token, Telegram, &   |
  | (Stricter-only, I6)   |  |               |  | HoldExpiryWorker         |
  +-----------------------+  +-------+-------+  +------------+-------------+
                                     |                       |
                                     +-----------+-----------+
                                                 |
                                                 v
                                 +-------------------------------+
                                 | executeDecision() Choke Point |
                                 | (src/core/executeDecision.ts) |
                                 +---------------+---------------+
                                                 |
                                                 v
                       +---------------------------------------------------+
                       | PayPal Sandbox Gateway (src/paypal)               |
                       | Vault v3, Orders v2, Authorizations v2, Reconcile |
                       | Base URL locked to https://api-m.sandbox.paypal.com
                       +---------------------------------------------------+
```

### Payment State Machine & Background Workers

Payment requests follow a strict deterministic state machine ([`src/core/stateMachine.ts`](src/core/stateMachine.ts)):

```text
RECEIVED -> DENIED                         (terminal; no ledger reservation)
RECEIVED -> AUTO_EXECUTING -> CAPTURED     (ALLOW -> Orders v2 CAPTURE -> SPEND)
RECEIVED -> AUTO_EXECUTING -> FAILED       (definitive pre-capture failure -> RELEASE)
RECEIVED -> HELD -> APPROVED -> CAPTURING -> CAPTURED | FAILED
HELD -> VOIDED                             (owner void -> RELEASE + PayPal void)
HELD -> EXPIRED -> VOIDED                  (TTL elapsed -> RELEASE + PayPal void)
```

During server operation ([`src/mcp/server.ts`](src/mcp/server.ts) and [`src/server.ts`](src/server.ts)), PayGuard runs single-instance background loops that drain gracefully before closing SQLite with `wal_checkpoint(TRUNCATE)` on `SIGINT`/`SIGTERM`:

| Loop | Default Interval | Responsibility |
|---|---|---|
| `HoldExpiryWorker` | 30s | Voids expired `HELD` authorizations, writes `RELEASE`, audits as `system`, and voids remotely outside the SQLite transaction (also enforced lazily on reads/approvals). |
| `ReconcilerWorker` | 60s | Reconciles stuck `AUTO_EXECUTING`, `CAPTURING`, stale `HELD`, and unconfirmed remote voids with dual-attestation before releasing funds. |
| `NotificationOutboxWorker` | 2s (when Telegram active) | Delivers queued Telegram alerts and inline Approve/Void keyboards with bounded retries and dead-letter auditing. |
| Owner Session Cleanup | 60s | Purges idle-expired and absolute-expired rows from SQLite `owner_sessions`. |

---

## Security Model & Deterministic Policy Enforcement

PayGuard treats AI agents, invoice text (`purpose`, `source_context`), and LLM outputs as untrusted or semi-trusted inputs:

1. **Deterministic Policy Engine ([`src/policy/engine.ts`](src/policy/engine.ts))**: Evaluates `(request, facts, activePolicy, aiFlags, now)` deterministically and records **all** triggered reason codes:
   - **Hard `DENY`** (always overrides `HOLD`): `AGENT_SUSPENDED`, `VENDOR_UNKNOWN`, `VENDOR_BLOCKED`, `CURRENCY_NOT_ALLOWED`, `OVER_HARD_CAP`, `GLOBAL_BUDGET_EXCEEDED`.
   - **Soft `HOLD`** (triggers native PayPal `AUTHORIZE` hold and human review): `VENDOR_NEW` (for `UNVERIFIED` vendors), `OVER_AUTO_LIMIT`, `AGENT_BUDGET_EXCEEDED`, `VELOCITY`, `DUPLICATE`, `CATEGORY_MISMATCH`, `AI_FLAG`.
   - **`ALLOW`**: Granted only when all checks pass explicitly; unexpected errors or ambiguous states fail closed.
2. **Single Money-Moving Choke Point**: Only [`executeDecision`](src/core/executeDecision.ts) in `src/core` invokes money-moving PayPal order/capture calls (alongside owner/system authorization voids mediated via `ApprovalExecutionService` / `ReconcilerWorker`).
3. **Integer Minor Units**: Internal amounts are strictly integer minor units (`MinorUnits`), formatted into decimal strings only at the PayPal API and display boundaries.
4. **Snapshot-Locked Approvals**: Holds compute a `snapshot_hash` over canonical request terms (`requestId`, `vendorId`, `amountMinor`, `currency`, `purpose`). Approvals re-verify status, snapshot integrity, and single-use SHA-256 hashed tokens—never reading payment amounts from HTTP request bodies.
5. **Append-Only Hash-Chained Audit Log**: Every state transition writes a SHA-256 hash-chained `audit_log` row in the same SQLite `BEGIN IMMEDIATE` transaction; SQLite `BEFORE UPDATE` / `BEFORE DELETE` triggers block tampering.
6. **Hardened Owner Auth & Persistent Sessions**:
   - Passphrases verified with Argon2id (`@node-rs/argon2`; legacy SHA-256 hashes upgrade on login).
   - Server-side sessions stored as SHA-256 key digests in SQLite `owner_sessions` (`012_owner_sessions`), surviving restarts with 60-minute idle and 24-hour absolute expirations.
   - Cookies use `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` in production (`NODE_ENV=production`).
   - State-changing owner routes require constant-time verified `x-csrf-token` headers; `/api/login` applies IP-aware rate limiting (5 attempts/min).
   - Session storage errors fail closed with HTTP `503` without clearing client session cookies.
7. **Agent Transport Isolation**: MCP Bearer keys (32 random bytes, stored as SHA-256 hashes) bind to a single agent; `/mcp` enforces per-session agent ownership (`403` on mismatch), `404` on unknown/expired sessions, per-agent rate limiting (30 req/min), and a `64kb` JSON limit.

---

## Four Canonical MCP Tools

Exposed over Streamable HTTP at `/mcp` (`Accept: application/json, text/event-stream` with `Authorization: Bearer <agent_api_key>`). **Exactly four tools exist** ([`src/mcp/tools.ts`](src/mcp/tools.ts)):

| Tool | Inputs | Purpose & Security Guarantees |
|---|---|---|
| `request_payment` | `vendor_id`, `amount` (decimal string), `currency` (3-letter ISO), `purpose` (<=200 chars), `idempotency_key` (8–64 chars), optional `category`, optional `source_context` (<=2000 chars) | Evaluates deterministic policy, preserves idempotent replays, rejects payload mismatches with `IDEMPOTENCY_CONFLICT`, and executes `CAPTURE` (`ALLOW`) or `AUTHORIZE` (`HOLD`) if PayPal credentials are configured. |
| `get_payment_status` | `request_id` | Returns status, decision, policy reasons, and timestamps for requests owned by the caller agent (triggers lazy hold expiry if `expires_at` elapsed). **Never** exposes approval URLs or tokens. |
| `get_budget` | `{}` | Returns remaining rolling 24h daily budget and `allowed_currencies`. Exact thresholds/spend totals remain hidden unless active policy sets `expose_limits: true`. |
| `list_vendors` | `{}` | Lists `ACTIVE` and `UNVERIFIED` registered vendors only. `BLOCKED` vendors are omitted. |

No `approve`, `capture`, `void`, `refund`, policy-edit, vendor-edit, or credential tool is registered on `/mcp`.

---

## PayPal Sandbox-Only Operation

PayGuard strictly targets **PayPal Sandbox** (`https://api-m.sandbox.paypal.com`):

- [`src/config/index.ts`](src/config/index.ts) hard-binds `paypalBaseUrl` to `SANDBOX_BASE_URL` and refuses startup if `PAYPAL_ENV=PRODUCTION` without an explicit `ALLOW_PRODUCTION=true` override (which is unset by default).
- Payments use **Vault v3** (`/v3/vault/setup-tokens`, `/v3/vault/payment-tokens`), **Orders v2** (`POST /v2/checkout/orders` with `Prefer: return=representation`, `payment_source.paypal.vault_id`, and `PayPal-Request-Id` idempotency headers), and **Authorizations v2** (`POST /v2/payments/authorizations/{id}/capture`, `POST /v2/payments/authorizations/{id}/void`, `GET /v2/payments/authorizations/{id}`).
- If `CONNECTOR_ACME_CLIENT_ID` / `CONNECTOR_ACME_CLIENT_SECRET` are omitted, the server runs in **local evaluation mode**: `ALLOW` requests remain in `RECEIVED` (remote capture skipped) rather than fabricating captures.
- [`docs/SPIKES.md`](docs/SPIKES.md) records live PayPal Sandbox verification across **S1–S6** (`invoice_id` untested live), Task **C2** end-to-end Flows A/B/C/D + crash reconciler (`OrderError.orderId` preservation & `PayPal-Request-Id` replays), and Task **C3** persistent Vault v3 onboarding + controlled `$1.00 USD` live `CAPTURE`. See [Implementation & Verification Status](#implementation--verification-status) for remaining unverified/deferred items.

---

## Owner Dashboard, Approvals & Telegram Integration

### Owner Dashboard (`/`)

Built from `web/` into `dist/web/` and served directly by Express using hash routing (`#/overview`, `#/payments`, `#/requests/:id`, `#/approvals`, `#/agents`, `#/policies`, `#/vendors`, `#/audit`, `#/settings`):

- **Overview**: Rolling 24h budget utilization, 24h decision counts, and recent request activity.
- **Payments & Payment Detail**: Filterable request list, full policy rule explanations, visually separated non-authoritative AI risk explanation, raw escaped `source_context`, PayPal order/authorization/capture IDs, and audit timeline.
- **Pending Approvals**: Card list for `HELD` requests with expiry countdowns and Approve / Void controls routed through the shared [`ApprovalExecutionService`](src/approvals/service.ts).
- **Policies, Vendors, Agents & Audit**: Immutable policy version history + plain-English drafting workflow (`MAX_HARD_CAP_MINOR` enforced server-side), vendor creation/status management, agent API key generation (shown once) + suspension, and append-only audit inspection.
- **Settings**: Live Telegram linking status, one-time deep-link token generator, step-by-step linking instructions, and unlink action.

### Web Approval Links (`/a/:token`)

Single-use 32-byte approval tokens (stored as SHA-256 digests) render a browser-friendly review page at `GET /a/:token` with strict `default-src 'none'; frame-ancestors 'none'` CSP (no inline scripts), escaped output, currency-aware prefixes, HTML owner sign-in guidance when unauthenticated, and active owner session + scoped URL-encoded `_csrf` form enforcement on `POST /a/:token/approve` and `POST /a/:token/void`. API routes (`/api/*`) continue to require `x-csrf-token` headers exclusively.

### Optional Telegram Integration (`/api/telegram/*`)

Disabled by default (`TELEGRAM_MODE=disabled`). When enabled (`TELEGRAM_MODE=webhook` with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`):

1. Owner generates a one-time linking token in **Settings** (`POST /api/telegram/link-token`) and opens `https://t.me/<bot>?start=<token>`.
2. Webhook handler (`/api/telegram/webhook`, authenticated via `X-Telegram-Bot-Api-Secret-Token`) validates the token, extracts numeric `message.from.id`, and atomically binds `telegram_chat_id` + `telegram_user_id` + `telegram_linked_at` (link-epoch fencing invalidates prior tokens/callbacks on unlink/relink).
3. Held payment alerts queued in `notification_outbox` include encrypted inline Approve / Void callback buttons (`TELEGRAM_ENCRYPTION_KEY`, AES-256-GCM; supports rotation via `TELEGRAM_PREVIOUS_ENCRYPTION_KEY`) verified against chat ID, user ID, link epoch, snapshot hash, and terminal state before invoking `ApprovalExecutionService`.
4. Telegram failures never crash payment processing; delivery retries are bounded in `notification_outbox`.

---

## AI Policy Advisor & Restrictions

[`src/ai/`](src/ai) implements three assistive features behind `AiService` (`AI_PROVIDER=mock|gemini`, default `mock`, default Gemini model `gemini-3.5-flash-lite`, 20 req/min rate limiter, 25s request timeout, and 15-minute `ai_runs` cache):

| Component | Role & Hard Restrictions |
|---|---|
| `InjectionDetector` | Two-stage scan on `purpose`/`source_context` (`Stage A` deterministic regex/Unicode heuristics -> `Stage B` bounded structured AI classification). Three outcomes: `DETECTED`, `CLEAR`, `INDETERMINATE`. Under `AI_SCAN_MODE=enforce`, `DETECTED` adds `AI_FLAG` (escalating `ALLOW` -> `HOLD`); under `advisory` (default), results are audited without altering policy decisions; `off` disables scanning. AI errors resolve to `INDETERMINATE` and never weaken deterministic rules. |
| `RiskExplainer` | Always constructs deterministic template explanations from reason codes first. Optional AI summaries are capped, escaped, clearly marked non-authoritative, and fall back gracefully if AI fails or times out. |
| `PolicyDrafter` | Translates natural-language owner instructions (first scanned by `InjectionDetector` in `enforce` mode) into a strictly validated partial policy update, bounded by server code ceilings (`MAX_HARD_CAP_MINOR` validated across direct creation, AI drafting, and proposal activation). `analyzePolicyDiff` labels every changed field as `TIGHTENED`, `RELAXED`, or `UNCHANGED`, maps upstream AI failures (`429`/`504`/`502`), and persists an immutable `policy_proposals` row requiring explicit owner review and CSRF-authenticated activation (`author='ai_draft_confirmed'`). Drafts are never auto-activated. |

---

## Technology Stack

- **Runtime & Language**: Node.js >= 20 (verified locally on Node `v24.19.0`), TypeScript `5.7` (`strict: true`, ESM `NodeNext`)
- **HTTP & MCP**: Express `5.3`, `@modelcontextprotocol/sdk` (`1.32.x`, Streamable HTTP transport)
- **Validation & Security**: Zod `4.x`, `@node-rs/argon2` (Argon2id), Node `node:crypto` (SHA-256, AES-256-GCM)
- **Database**: SQLite via `better-sqlite3` (WAL mode, `foreign_keys = ON`, `BEGIN IMMEDIATE`)
- **Frontend**: React `19.3`, Vite `7.3`, Tailwind CSS `4.3`, `lucide-react`
- **Tooling**: Vitest `3.0`, ESLint `9.20`, `typescript-eslint`, `tsx`

---

## Installation & Local Setup

### Prerequisites

- **Node.js**: v20.0.0 or higher (developed/verified on v24.19.0)
- **npm**: v10.0.0 or higher
- **Build tools** (only needed if prebuilt binaries for `better-sqlite3` are unavailable for your platform)

### Setup Steps

1. **Install dependencies**:
   ```bash
   npm ci
   ```

2. **Create environment configuration**:
   ```bash
   cp .env.example .env
   ```
   Fill in your non-production values in `.env`. To generate an Argon2id hash for `OWNER_PASSPHRASE_HASH`:
   ```bash
   node --input-type=module -e "import { hash } from '@node-rs/argon2'; console.log(await hash(process.argv[1]));" "<your-owner-passphrase>"
   ```

3. **Build backend and dashboard**:
   ```bash
   npm run build
   ```

4. **Seed local demo state** (creates default owner if absent, vendor `ven-acme`, Policy v1 `$15 auto / $100 cap / $50 daily budget`, and demo agent `agent-demo-honest`):
   ```bash
   npm run demo:seed
   ```
   > **Note**: If `OWNER_PASSPHRASE_HASH` is unset on initial seed, `demo:seed` seeds a local fallback demo owner record (intended for local dev only; set `OWNER_PASSPHRASE_HASH` before running `demo:seed` in any shared or hosted environment).

5. **Optional — Onboard a PayPal Sandbox buyer wallet** (requires `CONNECTOR_ACME_CLIENT_ID`, `CONNECTOR_ACME_CLIENT_SECRET`, and an already-migrated SQLite database from Step 4 or server startup):
   ```bash
   node --env-file=.env --import tsx demo/onboardVault.ts --vendor ven-acme
   ```

6. **Start the server**:
   ```bash
   node --env-file=.env dist/src/server.js
   ```
   Open `http://localhost:3000` for the dashboard, `/healthz` for health status, or `/mcp` for MCP clients. *(Node 20 users can run `npm start` with environment variables exported by their shell/process manager if `--env-file` is omitted.)*

---

## Demo Instructions

Run scenarios against an initialized database (after `npm run demo:seed` or server startup):

1. **Honest Agent Flow (`$12.00 USD` compliant request)**:
   ```bash
   node --env-file=.env --import tsx demo/honestAgent.ts
   ```
   Connects over `/mcp`, calls `get_budget`, `list_vendors`, `request_payment`, and `get_payment_status`. Captures on PayPal Sandbox when connector credentials and a vaulted buyer token exist; otherwise reports `ALLOW` (`RECEIVED`) without fabricating captures.

2. **Adversarial Attack Suite (Prompt injection, structuring, currency/payee swaps, idempotency conflict, tenant isolation)**:
   ```bash
   npm run demo:attack
   ```
   Executes deterministic security scenarios across the real MCP + Policy + Core stack and verifies zero unauthorized spend.

3. **Live-Injection LLM Agent (Strict controller + `--execute-sandbox` safety guard)**:
   ```bash
   # Mock provider (offline):
   npm run demo:live -- --provider mock

   # Live Google Gemini (requires GEMINI_API_KEY; remote Sandbox capture disabled unless --execute-sandbox is passed):
   node --env-file=.env --import tsx demo/liveAgent.ts --provider gemini
   ```

4. **Create Additional Agents & Local Ephemeral Reset**:
   ```bash
   npm run agent:create -- "Smoke Test Agent" 50
   npm run demo:reset
   ```
   > **Note**: `demo:reset` clears local `payment_requests`, `ledger`, `approvals`, and `ai_runs` while preserving vendors, vault tokens, policies, and append-only `audit_log`; it does not issue PayPal void calls for open remote authorizations.

---

## Environment Variables

See [`.env.example`](.env.example) for the complete template (names only).

| Variable | Default | Required / Behavior |
|---|---|---|
| `NODE_ENV` | `development` | `development \| test \| production`. Enables `Secure` cookies and stricter `PUBLIC_BASE_URL` checks when `production`. |
| `PORT` | `3000` | HTTP listen port (`1`–`65535`). |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` (dev/test), `undefined` (prod) | Origin used in notification links. In `production`, localhost/loopback URLs are rejected; omitting it disables clickable notification links. |
| `DB_PATH` / `DATABASE_PATH` | `./data/payguard.db` | SQLite database path (`DATABASE_PATH` takes precedence over `DB_PATH`; supports `:memory:`). |
| `TRUST_PROXY` | `false` | Express `trust proxy` (`false`, `true`, hop count e.g. `1`, or CIDR/preset). Prefer an exact hop count/CIDR matching your reverse proxy; never leave `true` blindly in production. |
| `PAYPAL_ENV` | `SANDBOX` | Must stay `SANDBOX`. `PRODUCTION` is refused unless `ALLOW_PRODUCTION=true` (and `paypalBaseUrl` always resolves to Sandbox). |
| `ALLOW_PRODUCTION` | unset (`false`) | Keep unset/false; PayGuard is strictly Sandbox-only. |
| `CONNECTOR_ACME_CLIENT_ID` | unset | PayPal Sandbox REST app Client ID for vendor `ven-acme` (`acme_cloud`). |
| `CONNECTOR_ACME_CLIENT_SECRET` | unset | PayPal Sandbox REST app Client Secret for `acme_cloud`. |
| `SESSION_SECRET` | dev fallback string | Cryptographic secret (`>=16` chars). **Set a strong random secret in any deployed environment.** |
| `OWNER_PASSPHRASE_HASH` | unset | Argon2id (preferred) hash for the single owner account when seeding. |
| `HOLD_TTL_MINUTES` | `15` | Default hold expiry ceiling (`>=1`). Does not alter the 30s `HoldExpiryWorker` interval. |
| `MAX_HARD_CAP_MINOR` | `1000000` | Ceiling (integer minor units; default `$10,000.00`) enforced server-side on policy creation, AI policy drafts, and proposal activation. |
| `RESEED_ON_BOOT` | `false` | If `true`, invokes `seedDemoDatabase()` on boot (useful only for ephemeral/disposable demos). |
| `DEMO_AGENT_API_KEY` | unset | Optional stable raw API key applied when `demo:seed` or `RESEED_ON_BOOT=true` runs. |
| `VAULT_TOKEN_ID` | unset | Optional pre-onboarded PayPal Sandbox vault token ID seeded onto `ven-acme`. |
| `AI_PROVIDER` | `mock` | `mock \| gemini`. If `gemini` lacks a valid `GEMINI_API_KEY`, server warns and disables AI cleanly without faking mock output. |
| `AI_MODEL` | `gemini-3.5-flash-lite` | Model name passed to `GeminiProvider`. |
| `GEMINI_API_KEY` | unset | Google AI Studio API key (`x-goog-api-key` header) used when `AI_PROVIDER=gemini`. |
| `AI_SCAN_MODE` | `advisory` | `off \| advisory \| enforce`. Controls whether detected prompt injection escalates `ALLOW` -> `HOLD`. |
| `TELEGRAM_MODE` | `disabled` | `disabled \| webhook`. Requires `TELEGRAM_BOT_TOKEN` when `webhook`. |
| `TELEGRAM_BOT_TOKEN` | unset | Telegram Bot API token from `@BotFather`. |
| `TELEGRAM_BOT_USERNAME` | unset | Bot handle (without `@`) used to format `https://t.me/<bot>?start=<token>` links. |
| `TELEGRAM_WEBHOOK_SECRET` | unset | Required by `/api/telegram/webhook` (`1–256` chars `[A-Za-z0-9_-]`, verified via `X-Telegram-Bot-Api-Secret-Token`). |
| `TELEGRAM_OWNER_CHAT_ID` | unset | Optional default chat ID seeded when owner record is created. |
| `TELEGRAM_ENCRYPTION_KEY` | unset | 64 hex chars (32 bytes) AES-256-GCM key required to encrypt inline Approve/Void Telegram callback buttons. |
| `TELEGRAM_PREVIOUS_ENCRYPTION_KEY` | unset | Optional 64 hex chars previous key for zero-downtime key rotation when decrypting callbacks. |

---

## Database Initialization & Migrations

No manual migration CLI is needed. Both `src/server.ts` (`startServer`) and `demo/seed.ts` automatically:

1. Create parent directories for file-backed SQLite paths.
2. Open SQLite with `foreign_keys = ON`, `journal_mode = WAL`, and `synchronous = NORMAL`.
3. Execute pending migrations in `BEGIN IMMEDIATE` transactions tracked in `schema_migrations` ([`src/db/schema.ts`](src/db/schema.ts)):
   - `001_initial_schema` — Core tables (`owners`, `agents`, `vendors`, `vendor_vault_tokens`, `policy_versions`, `payment_requests`, `ledger`, `approvals`, `audit_log`, `ai_runs`), append-only audit triggers, single-active-policy index.
   - `002_policy_version_immutability` — Version uniqueness & update/delete triggers on `policy_versions`.
   - `003_remote_void_tracking` — `remote_void_status` tracking and index on `payment_requests`.
   - `004_ai_runs_cache_index` — Compound index on `ai_runs(input_hash, status, created_at DESC)`.
   - `005_policy_proposals` & `006_harden_proposal_triggers` — `policy_proposals` table and tamper-proof state/timestamp triggers.
   - `007_telegram_link_tokens` & `008_telegram_chat_id_unique` — Single-use Telegram linking tokens and unique chat binding index.
   - `009_notification_outbox` — Persistent outbox queue with dedup keys and claim locking.
   - `010_telegram_approval_callbacks` & `011_telegram_callbacks_linked_at` — Encrypted inline keyboard storage, hash-only callback tokens, `telegram_user_id`, and link epoch binding.
   - `012_owner_sessions` — SQLite-backed persistent owner sessions (`owner_sessions`) with access/creation expiry indexes.

---

## Commands

| Command | Description |
|---|---|
| `npm run typecheck` | Run strict TypeScript type-checking across backend, demo, scripts, tests, and `web/`. |
| `npm run lint` | Run ESLint 9 flat rules across the repository. |
| `npm run test:unit` / `npm test` | Run the Vitest test suite. |
| `npm run build:server` | Compile backend TypeScript (`src`, `demo`, `scripts`, `test`) to `dist/`. |
| `npm run build:web` | Build the React/Tailwind frontend bundle into `dist/web/`. |
| `npm run build` | Run both `build:server` and `build:web`. |
| `npm start` | Start the compiled production server (`node dist/src/server.js`). |
| `npm run dev:web` | Start Vite dev server on port `5173` proxying `/api`, `/a`, `/healthz` to `localhost:3000`. |
| `npm run agent:create` | Create a new agent (`npm run agent:create "<Name>" [dailyBudgetUSD]`); prints Bearer API key once. |
| `npm run demo:seed` | Idempotently seed default owner, `ven-acme`, Policy v1, and `agent-demo-honest`. |
| `npm run demo:reset` | Reset ephemeral request/ledger/approval/AI rows while preserving vendors, vault tokens, policies, and audit log. |
| `npm run demo:honest` | Run scripted MCP honest agent flow (`$12.00` request; local eval or sandbox if credentials exist). |
| `npm run demo:attack` | Run deterministic adversarial security regression suite. |
| `npm run demo:live` | Run live-injection LLM agent controller (`--execute-sandbox` required to allow remote sandbox calls). |
| `npm run vault:onboard` | Interactive / two-step PayPal Sandbox Vault v3 buyer token onboarding (`--vendor <id>`). |

---

## Deployment Instructions

### Option A: Docker

> **Verification Note**: [`Dockerfile`](Dockerfile) and [`.dockerignore`](.dockerignore) are provided and code-reviewed, but `docker build` / `docker run` were **not** live-verified on the final submission host because the Docker Desktop daemon (`//./pipe/dockerDesktopLinuxEngine`) was unavailable.

The multi-stage [`Dockerfile`](Dockerfile) builds backend + frontend assets in intermediate stages, installs production-only dependencies, drops build toolchains, runs as non-root user `payguard` (UID `1001`), and persists SQLite under `/app/data`:

1. **Build the image**:
   ```bash
   docker build -t payguard:latest .
   ```

2. **Prepare an external runtime env file** (never bake `.env` into the image):
   Provide strong values for `SESSION_SECRET`, `OWNER_PASSPHRASE_HASH`, and `PUBLIC_BASE_URL` (non-localhost `https://...` in `NODE_ENV=production`), plus PayPal Sandbox / Gemini / Telegram variables as needed.

3. **Run with a persistent named volume**:
   ```bash
   docker run -d \
     --name payguard \
     --restart unless-stopped \
     -p 3000:3000 \
     -v payguard-data:/app/data \
     -e NODE_ENV=production \
     -e PORT=3000 \
     -e DB_PATH=/app/data/payguard.db \
     -e TRUST_PROXY=1 \
     -e PUBLIC_BASE_URL=https://payguard.example.com \
     -e SESSION_SECRET=<random-secret-at-least-32-chars> \
     -e OWNER_PASSPHRASE_HASH=<argon2id-hash> \
     payguard:latest
   ```
   - For ephemeral/demo deployments without an already-seeded DB, set `-e RESEED_ON_BOOT=true` and optionally `-e DEMO_AGENT_API_KEY=<key>` / `-e VAULT_TOKEN_ID=<token>`.
   - If testing locally over plain HTTP (without TLS termination), set `-e NODE_ENV=development` so browser login cookies do not require HTTPS, and do not set `PUBLIC_BASE_URL` to localhost under `NODE_ENV=production`.
   - If mounting a host directory instead of a Docker named volume (`-v /path/on/host:/app/data`), ensure UID `1001` has write permissions on that directory.

4. **Verify container health & graceful shutdown**:
   ```bash
   docker ps
   curl -fsS http://127.0.0.1:3000/healthz
   docker stop payguard
   ```

### Option B: Bare Node.js Behind a Reverse Proxy

1. Build artifacts on target/CI: `npm ci && npm run build`.
2. Provision production environment variables (including `NODE_ENV=production`, strong `SESSION_SECRET`, non-localhost `https://` `PUBLIC_BASE_URL`, `TRUST_PROXY=1`, and a writable `DB_PATH`).
3. Put Nginx/Caddy/Traefik in front terminating TLS (`X-Forwarded-Proto: https`, `X-Forwarded-For` forwarded reliably for login rate limiting).
4. Start with `npm start` (`node dist/src/server.js`) and send `SIGTERM`/`SIGINT` for clean HTTP drain, worker drain, and SQLite `wal_checkpoint(TRUNCATE)`.

---

## Implementation & Verification Status

### 1. Implemented & Unit-Tested

- `npm run typecheck`: **PASS** (strict TypeScript check across `tsconfig.json` and `web/tsconfig.json`).
- `npm run lint`: **PASS** (`eslint .`).
- `npm run build`: **PASS** (`tsc` backend build + Vite 7 frontend bundle in `dist/web/`).
- `npm run test:unit`: **PASS** (**`64/64` test files, `1,434/1,434` tests, `0` failures**) covering policy evaluation, integer minor-unit math, concurrency (`BEGIN IMMEDIATE` race tests), SQLite migrations `001`–`012` & audit hash chains, PayPal HTTP retries/reconciler recovery, explicit Vault v3 token revocation/replacement, MCP auth/4-tool `I1` invariant & session isolation, owner sessions/CSRF (API + `/a/:token` browser form flow), `MAX_HARD_CAP_MINOR` enforcement, Gemini/AI strictness invariants (`I6`), and Telegram webhook/AES-256-GCM/outbox logic using mocked HTTP/AI/Telegram transports and isolated SQLite databases.

### 2. Implemented & Live-Verified

- **PayPal Sandbox Integration (`S1`–`S6` partial, `C1`/`C2`/`C3`)**: Vault v3 buyer token onboarding on `ven-acme` (US buyer `XAKLTFN3YBU3W`, `[SANDBOX VAULT TOKEN REDACTED]` persisted in `./data/payguard.db`), Flows A/B/C/D (`CAPTURE`, `AUTHORIZE`, authorization capture/void), `Prefer: return=representation`, crash-recovery `reconcilePaymentRequest` (`C2-T5A`/`C2-T5B`), `PayPal-Request-Id` idempotent replays (`C2-T6`), and controlled C3 `$1.00 USD` live `CAPTURE` (`Order 42X89954AW8709130`, `Capture 0GD719587L321405N`). See [`docs/SPIKES.md`](docs/SPIKES.md).
- **Google Gemini Integration (`S8`, `C3`)**: Verified `gemini-3.5-flash-lite` structured JSON output (`responseJsonSchema`) via `demo/liveAgent.ts --provider gemini` against poisoned fixtures, live C3 `RiskExplainer` generation, and live C3 `InjectionDetector` execution persisted to `ai_runs` without mock fallback.
- **Refreshed Production Runtime (`dist/src/server.js`)**: Verified `GET /healthz` (`200`, `tools: 4`), rebuilt SPA dashboard (`/` and `index-*.js`/`.css`), read-only authenticated `/mcp` discovery of the exact 4 canonical tools + `get_budget` + `list_vendors`, fail-closed unauthenticated `401` guards, intact `./data/payguard.db` (`40/40` valid post-rotation audit rows), and healthy `TELEGRAM_MODE=disabled` startup with zero errors or secret leakage.

### 3. Implemented — Not Live-Verified

- **Docker Build & Container Startup ([`Dockerfile`](Dockerfile), [`.dockerignore`](.dockerignore))**: Docker CLI `29.7.2` is installed, but the Docker Desktop Linux engine daemon was unavailable on the verification host (`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`). Container image build, `/healthz` inside Docker, volume persistence, and container `SIGTERM` checkpointing have **not** been executed.
- **Live Telegram Bot API (`S7` / `S10`)**: Webhook secret check, `/start` deep links, AES-256-GCM encrypted inline buttons, link-epoch fencing, and `notification_outbox` retries are unit-tested offline only; live delivery against a real `@BotFather` bot over public HTTPS is **not** live-verified.
- **Interactive Browser Playwright E2E on `/a/:token`**: Browser GET/POST HTML/form CSRF flows on `/a/:token` are verified by HTTP integration tests (`approvalFlow.test.ts`), not executed interactively in a headless Playwright browser session.
- **Live Gemini `PolicyDrafter` & `Stage B InjectionDetector` Dashboard Round-Trip**: Validated in unit/integration tests and schema-checked against `z.toJSONSchema()`; manual live dashboard triggers with `AI_PROVIDER=gemini` were not re-executed after the `MAX_HARD_CAP_MINOR` and error-code fixes.
- **PayPal `invoice_id` Field Round-Trip (`S6`)**: PayGuard tracks correlation via `purchase_units[0].custom_id = requestId`; `invoice_id` remains untested live.

### 4. Deferred & Known Limitations

- **Deferred `M5-T8` PayPal Activity Endpoint**: `GET /api/paypal/activity` returns `{ enabled: false, transactions: [] }`; `@paypal/agent-toolkit` reporting is not integrated.
- **Deferred Local `stdio` MCP Transport**: Streamable HTTP (`/mcp`) is the sole supported MCP transport (see [`docs/DECISIONS.md`](docs/DECISIONS.md) D22).
- **Single-Owner / Single-Connector Scope**: Designed for one owner account (`owners.id = 'default'`) and one PayPal vendor connector (`acme_cloud` via `CONNECTOR_ACME_CLIENT_ID` / `CONNECTOR_ACME_CLIENT_SECRET`).
- **Local Evaluation Without Sandbox Credentials**: Without PayPal Sandbox credentials and a vaulted buyer token, `request_payment` evaluates policy rules locally (`ALLOW` stays `RECEIVED`) without executing remote captures/holds.
- **Structured Logging Scope**: Uses native Node console logging with targeted secret redaction/masking rather than `pino` (`D23`).
- **Operational & UI Polish Notes**: `/healthz` returns static health without querying `SELECT 1` on SQLite; malformed-JSON middleware emits JSON-RPC error envelopes globally rather than scoping to `/mcp`; `demo/onboardVault.ts` assumes an already-migrated DB (run `demo:seed` or start the server first); a few secondary Overview dashboard cards (`AgentCardStack`, `PendingApprovalsCard`) display static USD/`15m` copy and minor ARIA/keyboard polish items remain open; and `dev:web` (`vite.config.ts`) proxies `/api`, `/a`, `/healthz` (connect MCP clients directly to port `3000`).
- **Publication Hygiene & External Verification**: Audited repository source, tests, Docker definitions, and sanitized documentation exclude secrets (`.env`), vault credentials, and local SQLite files (`*.db*`, `payguard.sqlite`) via `.gitignore`; independent clean-machine clone/setup verification and demo video publication remain external verification items.

---

## License

Open-source under the [MIT License](LICENSE).
