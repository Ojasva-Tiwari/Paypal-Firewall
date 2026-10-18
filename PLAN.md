# PayGuard (AgentAllowance) — Master Plan

> Single source of truth for building PayGuard for the **PayPal AI Hackathon**.
> To be followed by **ChatGPT** (planner / prompt writer) and **Antigravity** (executor), with the human as reviewer and operator.
> Prepared 17 Oct 2026. Deadline: **12 Nov 2026, 12:00pm PST** (about 1:30 AM IST on 13 Nov). Solo build.

---

## 0. READ THIS FIRST (rules for ChatGPT and Antigravity)

### 0.1 Who does what

| Actor | Role | Must never |
|---|---|---|
| **Human (owner of the project)** | Creates PayPal sandbox accounts, approves vault in a browser, reviews every diff touching money paths, records the video, submits | — |
| **ChatGPT** | Reads this plan, turns ONE milestone at a time into small task prompts (template in Appendix B), helps debug results the human pastes back | Invent PayPal endpoints, fields, tool names, or library APIs. Guess. |
| **Antigravity** | Executes one task prompt at a time: plan first, wait for approval, then code + tests | Touch production PayPal, print or request real credentials, add tools to the MCP surface, skip tests |

### 0.2 Fact discipline (anti-hallucination protocol)

- **[VERIFIED]** = checked against PayPal / Devpost / MCP documentation on 17 Oct 2026.
- **[VERIFY]** = from general knowledge. The executing agent MUST confirm it against the official docs (browse them) **before** relying on it, and record the result in `docs/SPIKES.md` with the doc URL.
- If an official doc and this plan disagree, **the doc wins**. Update this plan and note it in `docs/DECISIONS.md`.
- ChatGPT: use **only** the endpoints in Appendix A. If you need something not listed, say so and ask the human to look it up.
- Anything uncertain must be flagged as uncertain. "I think" is acceptable; silent guessing is not.

### 0.3 The loop (every task)

1. Human gives ChatGPT: this file + current milestone ID + repo tree + latest `docs/SPIKES.md`.
2. ChatGPT outputs ≤ 5 task prompts using the template (Appendix B).
3. Human pastes ONE prompt into Antigravity. Antigravity writes a **plan first** and waits.
4. Human approves the plan. Antigravity codes, writes tests, runs `npm run typecheck && npm run lint && npm run test:unit`.
5. Human reviews the diff (money-path checklist, section 19.4), commits small.
6. Human pastes surprises (failed spike, doc mismatch) back to ChatGPT **before** the next prompt.

### 0.4 Hard rules (also in `AGENTS.md`, Appendix C)

1. Sandbox only. No production code paths.
2. No secrets in the repo, logs, tests, fixtures, or prompts. `.env` is gitignored; `.env.example` has names only.
3. The agent-facing MCP tools are **exactly** `request_payment`, `get_payment_status`, `get_budget`, `list_vendors`.
4. Only `executeDecision` in `src/core` may call a money-moving PayPal function.
5. Money = integer minor units internally; convert to PayPal decimal strings only at the PayPal boundary.
6. AI output may only make a decision **stricter**, never looser.
7. Every state transition writes an `audit_log` row in the same DB transaction.
8. Fail closed: on any error or ambiguity, no money moves; request becomes FAILED or stays HELD; audit it.

### 0.5 Zero-spend rules (the owner will not spend any money on this project)

1. **Never enter a payment card anywhere.** If any sign-up, upgrade or "enable billing" step asks for one, stop and skip that feature.
2. **Gemini:** free-tier API key from AI Studio only. Never link a Cloud Billing account or click "Set up Billing". Without billing the project stays on the free tier with rate limits [VERIFIED]. The design already tolerates this: template explanations first, caching, a global AI rate limit, graceful fallback.
3. **PayPal:** sandbox only (free). No real money anywhere.
4. **Hosting is optional and must be free.** The candidate is a Render free web service. It spins down after 15 minutes idle (about a minute to wake) and has an ephemeral filesystem, so local SQLite files are lost on restart [VERIFIED]. Therefore:
   - SQLite only; **no Postgres** (one third-party source says free Postgres expires after 30 days [VERIFY]).
   - `RESEED_ON_BOOT=true`: policy v1, vendor rows and the demo agent are re-created on every boot.
   - The vault token id, vendor sandbox credentials and the demo agent key come from **environment variables**, not the database.
   - Run the expiry check lazily on every read/approve request, because timers stop while the service sleeps.
   - README warns "first load may take about a minute"; the demo runbook never leaves holds open.
   - **Before signing up, confirm no card is required [VERIFY].** If a card is asked for, skip hosting: judges run it locally from the README (Docker or npm), and say so in the submission.
5. **Coding tools:** use only what you already have. If Antigravity or ChatGPT hits a limit: wait for it to refresh, shrink the task, use a lighter model, or let Gemini act as the planner in place of ChatGPT. Do not buy upgrades.
6. **No domain, no paid APIs, no paid CI.** Use the free subdomain the host provides. Add CI only if GitHub Actions is free for public repos [VERIFY]; otherwise skip it.
7. **Video:** built-in screen recorder or OBS (free); YouTube auto-captions.
8. **Telegram (P1):** believed free [VERIFY]. If unsure, pick plain-English policy authoring as the P1 feature instead (it uses the Gemini free tier).

---

## 1. Mission and win conditions

**Mission:** ship a working, polished, honest, open-source project that wins the PayPal AI Hackathon, ideally the **Best Use of Agentic Commerce** prize.

**Hackathon facts [VERIFIED from the Devpost page]**

- Deadline 12 Nov 2026, 12:00pm PST.
- Must meaningfully use the PayPal developer platform (free sandbox) **and** AI; must be a working prototype judges can run (repo instructions or hosted URL). Mockups do not count.
- Public repo (GitHub / GitLab / Bitbucket) with all source + instructions; open-source license visible in the repo's About section.
- Demo video **under 3 minutes**, public on YouTube, shows the project working, no third-party trademarks or copyrighted music.
- Submission also needs a text description and a statement of which AI tools/models were used and how.
- Judging criteria: **technological implementation, design, potential impact, innovation/idea, presentation.**
- The project gallery was not published when checked, so competing entries are unknown. Roughly 15,900 participants had registered.

**How this plan maps to the criteria**

| Criterion | What we do about it |
|---|---|
| Technological implementation | Real PayPal primitives: Vault v3, Orders v2 (CAPTURE + AUTHORIZE), authorization capture/void; reconciler; idempotency; transactional budgets; tested invariants |
| Design | Coherent dashboard + mobile approval page; no placeholder screens; accessible status labels |
| Potential impact | Solves the real blocker to delegating spending to AI agents: trust |
| Innovation | Enforceable spend policy + native PayPal hold + stricter-only AI + visible attack suite |
| Presentation | Tight <3 min video, README a stranger can follow in 10 minutes, honest limitations |

---

## 2. What we are building

### 2.1 One paragraph

PayGuard is an **MCP server** that sits between an **AI agent** and **PayPal**. The agent can only *ask* for payments via `request_payment`. A **deterministic policy engine** then decides: **ALLOW** (capture immediately), **HOLD** (a PayPal AUTHORIZE hold that the owner approves or voids from their phone), or **DENY**. The agent never holds PayPal credentials and has no tool to approve, capture, or void. AI is used where it is safe: it *is* the agent being protected, it explains why something was held, and (optionally) it drafts policies from plain English. **AI proposes, rules dispose.**

### 2.2 The problem

Nobody trusts an LLM with a raw payment API key, because prompt injection can talk an agent into paying anyone. Agentic commerce is blocked by trust, not capability.

### 2.3 Users and stories

- **Owner** (person delegating spending to an agent)
  - I set rules once (budgets, allowed vendors, auto-approve limit).
  - I get a phone prompt only when something is outside the rules.
  - I can approve or void with one tap, and everything is logged.
- **Agent** (any MCP-capable AI agent)
  - I can discover vendors and my remaining budget, ask for a payment, and poll its status.
  - I cannot approve, move money, or see credentials.
- **Judge**
  - I can run it from the README in minutes (or open a hosted URL) and see an attack blocked and a hold approved.

### 2.4 Scope

**P0 — must ship**
1. Owner's sandbox PayPal wallet vaulted against one sandbox vendor.
2. Policy engine: vendor registry, auto-approve limit, hard cap, budgets, velocity, currency, duplicate detection.
3. MCP tools: `request_payment`, `get_payment_status`, `get_budget`, `list_vendors`.
4. ALLOW path (Orders intent CAPTURE with vaulted token) and HOLD path (intent AUTHORIZE → capture on approval / void on rejection or timeout).
5. Approval via signed web link + pending list in dashboard.
6. Audit log + dashboard (overview, pending, request detail, policy view, audit).
7. Demo agent (LLM) + deterministic hijack simulator + attack test suite.
8. AI feature: risk explainer on every held/denied request (template text first, AI summary on top).

**P1 — should ship (cut from the bottom up)**
- Telegram approval with inline buttons.
- Plain-English policy authoring (LLM drafts → schema validates → owner confirms → new immutable version).
- Second vendor connector.

**P2 — only if ahead**
- Hash-chained tamper-evident audit log.
- PayPal webhooks instead of polling.
- Stretch rail using the Payouts API.

**Non-goals:** multi-tenant SaaS, production money, real vendor onboarding, native mobile app, KYC/compliance.

### 2.5 Known simplification (state it openly in README and video)

A PayPal order is created by the **merchant**. In this demo, PayGuard holds **sandbox** credentials for a demo vendor ("connector"). A production version would integrate through merchants' own agentic-checkout channels instead of holding vendor secrets.

---

## 3. Approach and key decisions

### 3.1 Approach in five moves

1. **De-risk PayPal first (M0).** The riskiest unknown is whether an AUTHORIZE order with a vaulted token works without a buyer redirect. Find out on day 1–3, not day 20.
2. **Build the brain before the plumbing (M1).** Pure policy engine + state machine + audit, fully tested with a fake gateway.
3. **Wire real money movement in the sandbox (M2).** One choke point (`executeDecision`).
4. **Expose it to agents (M3).** MCP server, then immediately a demo + attack suite. From here the build is **always demo-able**.
5. **Make it human (M4–M5).** Approvals, dashboard, AI explanations, hardening, then ship prep and video.

### 3.2 Two PayPal rails, one recommendation

PayPal's AUTHORIZE hold is a **seller-side** concept; a payer cannot place a hold on their own outgoing payment to an arbitrary vendor. The toolkit is merchant-oriented too: its payment tools are `create_order`, `get_order`, `pay_order`, refunds [VERIFIED], with **no** authorize/capture-authorization/void tools, so those are called via REST directly.

| Rail | What | Pros | Cons |
|---|---|---|---|
| **A: Vault + Orders (CHOSEN)** | Owner vaults wallet; PayGuard creates orders with `payment_source.paypal.vault_id`; intent CAPTURE (auto) or AUTHORIZE (hold) | Real native PayPal hold visible in sandbox; best demo; uses real primitives | Vendor is a merchant whose sandbox credentials PayGuard holds (demo simplification) |
| B: Payouts (stretch) | Outgoing payments to PayPal recipients | Natural "agent pays vendor" semantics | No native hold (own DB hold); access must be requested; only unclaimed payouts can be cancelled |

**Fallbacks if spike S3 fails** (AUTHORIZE with a vaulted token needs buyer approval):
- **F1:** owner taps PayPal's approve link (the human tap), PayGuard authorizes, owner then taps Capture or Void in PayGuard.
- **F2:** PayGuard-managed hold in the DB; a CAPTURE order is created only after approval. Loses the native hold; last resort.

### 3.3 Decision log (seed; extend in `docs/DECISIONS.md`)

| ID | Decision | Why |
|---|---|---|
| D1 | TypeScript (strict), Node 20+ | Toolkit is TypeScript-first and needs Node 18+ [VERIFIED]; one language end to end |
| D2 | SQLite (better-sqlite3) only; no Postgres. On free hosting the DB is ephemeral and re-seeded on boot (section 0.5) | Zero cost, zero setup; transactions via `BEGIN IMMEDIATE`; free hosts lose local files on restart [VERIFIED for Render free] |
| D3 | Rail A (vault + Orders) | Real native hold; see 3.2 |
| D4 | Deterministic policy at runtime; AI only drafts/explains/flags (stricter-only) | Safety must not depend on an LLM |
| D5 | Vendors referenced by registry id only, never by free-text name | Kills typosquat / injected-payee attacks |
| D6 | Budgets over a rolling 24h window from a ledger | Avoids timezone bugs; reservation on hold prevents overspend |
| D7 | Ambiguity resolves to HOLD, never ALLOW | Fail closed |
| D8 | Approvals require owner login **and** a valid single-use token | A leaked link alone is useless |
| D9 | MCP over HTTP at `/mcp` (stdio for local dev) | One hosted server for demo and judges [VERIFY SDK API] |
| D10 | LLM behind an interface; Gemini first | User has Gemini; note: a Google AI Pro subscription does **not** cover Gemini API calls — use a free-tier key or enabled billing with a budget alert |
| D11 | Single owner / single tenant | Scope control |
| D12 | Hold TTL default 15 min for demo; hard max far below PayPal's 3-day honor period | Demo-friendly; default on timeout is void |

---

## 4. How it works

### 4.1 Cast

- **Owner:** the human; phone + dashboard.
- **Agent:** an LLM agent (Antigravity, Claude, or the scripted demo agent) using MCP.
- **Vendor:** "Acme Cloud", a sandbox business account selling API credits.
- **PayPal sandbox:** OAuth, Vault v3, Orders v2, Payments v2.

### 4.2 Demo policy (v1)

```yaml
version: 1
currency_allowlist: [USD]
auto_limit_minor: 1500          # $15.00 auto-approve
hard_cap_minor: 10000           # $100.00 absolute max
agent_daily_budget_minor: 5000  # $50.00 per agent per rolling 24h
global_daily_budget_minor: 20000
velocity: { max_requests: 5, window_minutes: 10 }   # exceed => HOLD
duplicate_window_minutes: 60
new_vendor_action: HOLD
hold_ttl_minutes: 15
```

### 4.3 Scenario 1 — Normal purchase (ALLOW)

1. Agent reads a legitimate invoice: Acme, **$12.00**, API credits.
2. Agent calls `request_payment(vendor_id=acme, amount="12.00", currency="USD", purpose="API credits", idempotency_key=..., source_context="invoice #1041")`.
3. PayGuard validates, then in one DB transaction: stores request, computes facts, runs policy → **ALLOW**, reserves $12 in the ledger, audits.
4. `executeDecision` creates an Order (intent CAPTURE, vaulted token, `custom_id` = request id). Success → SPEND ledger row, status **CAPTURED**.
5. Agent polls `get_payment_status` → `CAPTURED`. Sandbox shows the payment.

### 4.4 Scenario 2 — Prompt-injection attack (DENY)

1. Agent reads a *poisoned* invoice: looks like Acme's, but hidden/footer text tells an AI assistant to send **$500** to payee `attacker-001`.
2. A hijacked agent calls `request_payment(vendor_id="attacker-001", amount="500.00", ...)`.
3. Policy: vendor not in registry → **DENY `VENDOR_UNKNOWN`** (also `OVER_HARD_CAP`). No PayPal call. No ledger row.
4. Agent gets the decision + reason codes. Dashboard shows a red DENIED row with an audit entry. The injected text appears (escaped) in the source excerpt.

### 4.5 Scenario 3 — Larger legitimate purchase (HOLD → approve)

1. Agent requests **$40.00** from Acme. Policy: `OVER_AUTO_LIMIT` → **HOLD**.
2. Ledger reserves $40. `executeDecision` creates an Order with intent **AUTHORIZE** using the vaulted token. Status **HELD**; `expires_at` = now + 15 min.
3. Approval service mints single-use APPROVE/VOID tokens; AI explainer (cached) writes a short summary; owner gets a phone notification with a link.
4. Owner opens the mobile approval page, sees amount, vendor, reason codes (authoritative), AI summary (labelled), raw excerpt; taps **Approve**.
5. Server verifies token + owner session + snapshot hash, sets APPROVED → CAPTURING, **captures the authorization** (amount from the stored snapshot), status **CAPTURED**, SPEND row.
6. Variants: owner taps **Void** → authorization voided, RELEASE row, **VOIDED**. Nobody responds → expiry worker voids (**EXPIRED → VOIDED**).

### 4.6 Scenario 4 — Structuring attempt

Six $14 requests in 10 minutes: early ones ALLOW; later ones HOLD (`VELOCITY`, possibly `AGENT_BUDGET_EXCEEDED`). The attack suite prints this as a table.

### 4.7 Honest limits (also go in README)

- PayGuard cannot know whether a request to an *allowed* vendor matches the owner's true intent; a hijacked agent can still spend inside the caps.
- Holds depend on owner attention; the default on timeout is void.
- Demo simplification in 2.5. Hackathon prototype, not a compliance product.

---

## 5. How it will look

### 5.1 Design principles

- Calm, trustworthy fintech feel: neutral surfaces, one accent colour, generous spacing, defined once as design tokens (Tailwind config).
- **Status always shown with text + colour** (ALLOWED / HELD / DENIED / CAPTURED / VOIDED), never colour alone.
- **Authoritative vs AI content is visually separated:** policy reason codes on top; AI text below in a labelled "AI summary (not authoritative)" box; raw agent-supplied text shown escaped in a monospace block.
- Mobile-first approval page (tap targets ≥ 44px, one decision per screen). Dashboard responsive.
- Empty states, error states, loading states on every screen. No placeholder screens in the submitted build.
- Plain, concrete copy: "Held because the amount is over your $15 auto-approve limit."

### 5.2 Mobile approval page

```
┌────────────────────────────────┐
│ PayGuard                ⏱ 11:42│
├────────────────────────────────┤
│ Approval needed                │
│ $40.00 USD  →  Acme Cloud      │
│ Purpose: API credits (Oct)     │
│ Agent: honest-agent            │
│                                │
│ WHY IT WAS HELD (policy)       │
│  • OVER_AUTO_LIMIT  (limit $15)│
│                                │
│ AI SUMMARY (not authoritative) │
│  "Routine credit top-up, no    │
│   unusual instructions found." │
│                                │
│ SOURCE EXCERPT (raw, escaped)  │
│  invoice #1042 ...             │
│                                │
│ [   Approve and capture   ]    │
│ [   Void this hold        ]    │
└────────────────────────────────┘
```

### 5.3 Dashboard — Overview

```
┌──────────────────────────────────────────────────────────────┐
│ PayGuard   Overview | Pending (1) | Policies | Vendors | Audit │
├──────────────────────────────────────────────────────────────┤
│ Daily budget   ████████░░░░░░  $26 of $50 (spent + reserved)  │
│ Last 24h:   Allowed 4   Held 2   Denied 3                      │
├──────────────────────────────────────────────────────────────┤
│ LIVE FEED                                                      │
│ 10:41  CAPTURED   Acme Cloud     $12.00   honest-agent         │
│ 10:43  DENIED     attacker-001  $500.00   VENDOR_UNKNOWN       │
│ 10:45  HELD       Acme Cloud     $40.00   OVER_AUTO_LIMIT  [→] │
└──────────────────────────────────────────────────────────────┘
```

### 5.4 Dashboard — Request detail

```
Request 7f3a…  Status: CAPTURED
Timeline:  RECEIVED → EVALUATED(HOLD) → HELD → APPROVED → CAPTURED
Policy reasons:  OVER_AUTO_LIMIT
AI summary (not authoritative): …
Source excerpt (raw): …
PayPal:  order …  authorization …  capture …
Audit rows: (actor, event, time)
```

### 5.5 Other screens

- **Policies:** current rules as a form, version history, (P1) plain-English box with a diff preview and a Confirm button.
- **Vendors / Agents:** registry, status chips, per-agent budget, create key (shown once), suspend.
- **Audit:** filterable table.
- **PayPal activity:** read-only panel backed by the official toolkit's `list_transactions` [VERIFIED tool name; confirm it works with the vendor sandbox creds: VERIFY].

---

## 6. Architecture

### 6.1 Diagram

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

### 6.2 Trust boundaries

- **Untrusted:** the agent; everything the agent sends (including free text and invoice contents); any document the agent read.
- **Semi-trusted:** LLM output (display, drafting, stricter-only flags only).
- **Trusted:** policy engine, database, owner-authenticated channels, PayPal responses.

### 6.3 Components

| Component | Folder | Responsibility |
|---|---|---|
| MCP gateway | `src/mcp` | HTTP transport (stdio for local dev) [VERIFY SDK], agent auth from bearer key, tool schemas, validation, calls Core. Only agent-safe tools. |
| Core | `src/core` | Request lifecycle, state machine, DB transactions. `executeDecision` is the **only** caller of money-moving PayPal functions. |
| Policy engine | `src/policy` | Pure functions `(request, facts, policy) → decision`. No network; clock injected as `now`. |
| PayPal gateway | `src/paypal` | Token manager, vault, orders, authorizations, retries, idempotency, error mapping, reconcile. |
| Approval service | `src/approvals` | Mint/verify single-use tokens, web approval endpoints, Telegram bot (P1), expiry worker, reconciler. |
| AI services | `src/ai` | Provider interface, risk explainer, injection flag, policy authoring (P1). |
| Dashboard API + web | `src/api`, `web/` | Owner-only REST API and React UI. |
| Persistence | `src/db` | SQLite, migrations, repositories. |
| Demo harness | `demo/` | Seed/reset, scripted + LLM agents, attack suite, fixtures. |

### 6.4 Invariants (each one needs a test)

- **I1** The agent tool surface never includes approve, capture, void, refund, or credential access.
- **I2** Every payment request ends in exactly one terminal state; every transition writes an audit row.
- **I3** No money-moving PayPal call happens outside `executeDecision`.
- **I4** Money is integer minor units; currency is fixed per request.
- **I5** Approval/capture act only on an immutable snapshot hash; amounts are read from the DB, never from a request body.
- **I6** AI output can only add restrictions, never remove them.
- **I7** Secrets never reach logs, the repo, or agent prompts.

---

## 7. Tech stack

| Layer | Choice | Note |
|---|---|---|
| Language / runtime | TypeScript (strict), Node 20+ | Toolkit needs Node 18+ [VERIFIED] |
| HTTP | Express | Confirm against MCP SDK HTTP examples [VERIFY] |
| MCP | Official `@modelcontextprotocol/sdk` | Confirm package name + current API [VERIFY] |
| Validation | zod | One schema per tool input and per policy document |
| Database | SQLite via better-sqlite3 | No Postgres (zero-spend rule). Ephemeral on free hosting; re-seed on boot (section 0.5) |
| Logging | pino with redaction | Never log secrets or tokens |
| Tests | vitest | Unit, integration (sandbox), e2e |
| Web | React + Vite + Tailwind | Mobile-first approval page |
| LLM | Gemini via official SDK behind an interface | Swap provider via env var [VERIFY SDK; verify structured-output support: spike S8] |
| Telegram (P1) | grammY or node-telegram-bot-api | [VERIFY] |
| Packaging | Dockerfile + npm scripts | One-command setup for judges |
| PayPal | Direct REST + `@paypal/agent-toolkit` read-only | Toolkit has no authorize/capture/void tools [VERIFIED] |

---

## 8. Data model (SQLite)

| Table | Columns |
|---|---|
| `owners` | id, display_name, passphrase_hash, telegram_chat_id (nullable), created_at. Single row. |
| `agents` | id, name, api_key_hash, status (ACTIVE/SUSPENDED), daily_budget_minor, created_at |
| `vendors` | id, name, status (ACTIVE/UNVERIFIED/BLOCKED), categories (json), currencies (json), connector_key, created_at |
| `vendor_vault_tokens` | id, vendor_id, paypal_customer_ref, vault_token_id, status, created_at |
| `policy_versions` | id, version, rules (json), author (owner / ai_draft_confirmed), active (bool), created_at. Immutable; exactly one active. |
| `payment_requests` | id, agent_id, idempotency_key, vendor_id, amount_minor, currency, purpose, category, source_context_excerpt, source_context_hash, status, decision, reasons (json), policy_version_id, snapshot_hash, paypal_order_id, paypal_authorization_id, paypal_capture_id, expires_at, created_at, updated_at. **Unique (agent_id, idempotency_key).** |
| `ledger` | id, request_id, kind (RESERVE/RELEASE/SPEND), amount_minor, currency, created_at. Budgets computed from this. |
| `approvals` | id, request_id, token_hash, action (APPROVE/VOID), expires_at, used_at, channel (web/telegram), created_at |
| `audit_log` | id, ts, actor (agent/owner/system/ai), event, request_id, payload (json), prev_hash, hash. Append-only. |
| `ai_runs` | id, kind, request_id, model, input_hash, output, latency_ms, status, created_at |

Indexes: `payment_requests(status, expires_at)`, `payment_requests(agent_id, created_at)`, `ledger(created_at)`, `audit_log(request_id)`.

---

## 9. State machine and flows

```
RECEIVED -> DENIED (terminal)
RECEIVED -> AUTO_EXECUTING -> CAPTURED | FAILED
RECEIVED -> HELD -> APPROVED -> CAPTURING -> CAPTURED | FAILED
HELD -> VOIDED               (owner rejects)
HELD -> EXPIRED -> VOIDED    (timeout; default deny)
```

**Flow A — ALLOW:** authenticate agent → zod validate → open transaction (`BEGIN IMMEDIATE`) → idempotency lookup (return original if found) → insert request → gather facts → policy → insert RESERVE → audit → commit → `executeDecision` creates order with intent CAPTURE + vaulted token + `custom_id` = request id [VERIFY field] → SPEND row, CAPTURED, audit.

**Flow B — HOLD:** same through decision; keep reservation; compute `snapshot_hash`; set `expires_at`; `executeDecision` creates order with intent AUTHORIZE (+ authorize call if spike S3 shows it is needed); store authorization id; status HELD; mint APPROVE/VOID tokens (hashed); run explainer async; notify owner.

**Flow C — Approve:** verify token (unused, unexpired, bound to snapshot hash) + owner session + CSRF → re-check state is HELD → mark token used → APPROVED → capture authorization (amount from snapshot) → CAPTURED + SPEND row.

**Flow D — Void/expire:** owner Void or expiry worker (every 30s) → void authorization → RELEASE row → VOIDED → audit (actor `system` for expiry).

**Flow E — DENY:** store request + reasons; no ledger row; no PayPal call; return decision to agent.

**Flow F — Failures:** PayPal error before any hold/capture → FAILED + RELEASE + audit. Timeout/unknown → **reconcile before retrying** (look up by stored order id / `custom_id`). Reconciler job every 60s compares HELD / AUTO_EXECUTING / CAPTURING requests with PayPal state. Every PayPal POST carries an idempotency header derived from `request_id` + step [VERIFY header name: `PayPal-Request-Id`].

---

## 10. Policy engine specification

**Input:** normalized request (agent id, vendor id, amount_minor, currency, category, purpose, idempotency key); facts (agent + global spend and reserved over rolling 24h, request count in velocity window, duplicate matches); active policy; optional `aiFlags[]`; injected `now`.
**Output:** `{ decision: ALLOW | HOLD | DENY, reasons: ReasonCode[], ruleIds: string[] }` — **all** triggered reasons, not just the first.

**Evaluation order**
1. Shape errors are rejected before the engine (errors, not decisions).
2. Agent not ACTIVE → DENY `AGENT_SUSPENDED`.
3. Vendor missing → DENY `VENDOR_UNKNOWN`; BLOCKED → DENY `VENDOR_BLOCKED`.
4. Hard DENY: `CURRENCY_NOT_ALLOWED`, `OVER_HARD_CAP` (also amount ≤ 0), `GLOBAL_BUDGET_EXCEEDED`.
5. Soft HOLD: `VENDOR_NEW` (UNVERIFIED vendor), `OVER_AUTO_LIMIT`, `AGENT_BUDGET_EXCEEDED`, `VELOCITY`, `DUPLICATE` (same vendor+amount+purpose in window), `CATEGORY_MISMATCH`, `AI_FLAG`.
6. Any DENY beats HOLD. No DENY and no HOLD → ALLOW. **ALLOW requires every condition to pass; anything unclear becomes HOLD.**

**Stricter-only AI rule (I6):** the function accepts `aiFlags` and may only add HOLD reasons. No code path lets AI remove a reason or upgrade HOLD to ALLOW.

**Windows:** rolling 24h for budgets; velocity and duplicate windows in minutes, set by policy.

**Worked examples**

| Request | Decision | Reasons |
|---|---|---|
| $12 to active vendor, category matches | ALLOW | — |
| $40 to same vendor | HOLD | OVER_AUTO_LIMIT |
| $500 to id not in registry | DENY | VENDOR_UNKNOWN (+ OVER_HARD_CAP) |
| $150 to active vendor (cap $100) | DENY | OVER_HARD_CAP |
| EUR when only USD allowed | DENY | CURRENCY_NOT_ALLOWED |
| Six $14 in 10 min | early ALLOW, later HOLD | VELOCITY, maybe AGENT_BUDGET_EXCEEDED |
| Same vendor/amount/purpose in 60 min, new key | HOLD | DUPLICATE |
| Same key + same payload | original result | n/a |
| Same key + different payload | rejected | IDEMPOTENCY_CONFLICT |

---

## 11. MCP server specification

**Transport/auth:** HTTP at `/mcp` (stdio for local dev) [VERIFY SDK]. Header `Authorization: Bearer <agent key>`. Keys: 32 random bytes, shown once by `npm run agent:create`, stored only as SHA-256 hash. Suspended agent → DENY everything. Per-agent rate limit (e.g. 30/min) and body-size limit.

**Tools (complete list)**

| Tool | Input | Output |
|---|---|---|
| `request_payment` | `vendor_id` (from `list_vendors`); `amount` (decimal string matching `^\d{1,7}(\.\d{1,2})?$`, parsed to minor units); `currency` (3 uppercase letters); `purpose` (≤200 chars); `category` (optional); `idempotency_key` (8–64 chars, required); `source_context` (optional, ≤2000 chars: what triggered the request) | `request_id`, `status`, `decision`, `reasons[]`, `message`, `next_step` |
| `get_payment_status` | `request_id` | `status`, `decision`, `reasons[]`, timestamps. **Never** returns approval links/tokens. |
| `get_budget` | none | Remaining daily budget + allowed currencies. Thresholds hidden unless `expose_limits: true` (a compromised agent shouldn't get a map of the limits). |
| `list_vendors` | none | `vendor_id`, `name`, `categories`, `currencies`, `status` for ACTIVE and UNVERIFIED vendors |

**Never exposed:** approve, capture, void, refund, policy/vendor edits, credentials, any PayPal pass-through.

**Behaviour rules**
- `source_context` is untrusted: stored for audit/explainer only; never influences a decision except via stricter-only AI flags.
- Same key + same payload → original result; same key + different payload → `IDEMPOTENCY_CONFLICT`.
- Validation errors return zod issue paths only (no stack traces/internals).
- Tool descriptions are neutral; include one line: "DENIED and HELD results are final for that request; do not retry with altered details" (helps honest agents; not a security control).
- Test with an MCP client early (spike S9) [VERIFY: the official MCP Inspector].

---

## 12. PayPal gateway specification

### 12.1 Verified facts and open items

| Fact | Status |
|---|---|
| Token: `POST https://api-m.sandbox.paypal.com/v1/oauth2/token`, basic auth client_id:secret, `grant_type=client_credentials`; response has `access_token`, `expires_in`. Sandbox tokens last 3–8 hours; production 8 hours (agent-toolkit README). Refresh before expiry; never a static token. | VERIFIED |
| Orders v2 intents: CAPTURE and AUTHORIZE. To authorize/capture, the buyer must approve the order **or** a valid `payment_source` must be provided. | VERIFIED |
| `POST /v2/checkout/orders/{id}/authorize`; `POST /v2/checkout/orders/{id}/capture` | VERIFIED |
| Authorization holds funds for 29 days; capture within the 3-day honor period; response carries `capture`, `void`, `reauthorize` links. Capture: `POST /v2/payments/authorizations/{authorization_id}/capture`. Void: `/v2/payments/authorizations/{authorization_id}/void`. | VERIFIED (HTTP method of void = POST: VERIFY) |
| Vault v3: `POST /v3/vault/setup-tokens`, then `POST /v3/vault/payment-tokens`; `GET /v3/vault/payment-tokens?customer_id=...`. Then create order with `payment_source.paypal.vault_id`. A saved token can create an order on the payer's behalf when the payer is not present. Sandbox business account must be set up to save payment methods. | VERIFIED |
| Vault webhooks: `VAULT.PAYMENT-TOKEN.CREATED`, `.DELETED`, `.DELETION-INITIATED` | VERIFIED |
| Order statuses include CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED | VERIFIED |
| `@paypal/agent-toolkit` (Node 18+); payment tools `create_order`, `get_order`, `pay_order`, `create_refund`, `get_refund`; reporting `list_transactions`, `get_merchant_insights`; no authorize/capture-authorization/void tool | VERIFIED |
| PayPal's local MCP server: `npx -y @paypal/mcp --tools=all`, env `PAYPAL_ACCESS_TOKEN`, `PAYPAL_ENVIRONMENT`, stdio | VERIFIED (third-party listing) |
| MCP elicitation exists but clients must declare the capability — don't depend on it for approvals | VERIFIED |
| `PayPal-Request-Id` idempotency header; `custom_id` / `invoice_id` on purchase units | VERIFY |
| Authorization/capture webhook event names | VERIFY |

### 12.2 Modules

- **Config/safety:** base URL from `PAYPAL_ENV`: sandbox `https://api-m.sandbox.paypal.com`, production `https://api-m.paypal.com` [VERIFIED]. Default SANDBOX. Code **refuses PRODUCTION** unless `ALLOW_PRODUCTION=true`; that flag is never set in repo or docs.
- **tokenManager:** one cached token per connector; refresh 5 min before expiry; single-flight; on 401 refresh once and retry once.
- **vault:** `createSetupToken`, `confirmSetup` (creates payment token), `listTokens`. Onboarding script prints the approval URL, owner approves with the sandbox buyer account, script stores the token id.
- **orders:** `create({ requestId, amount, currency, intent, vaultTokenId, description })`; one purchase unit; `custom_id` = request id [VERIFY]; `payment_source.paypal.vault_id` [VERIFIED].
- **authorizations:** `capture(authId)`, `void(authId)`, `get(authId)` [VERIFY body fields, methods, GET endpoint].
- **reconcile:** reads order/authorization status → internal state.
- **Retry policy:** GETs retry (max 3, backoff). POSTs retry only on network error/5xx, max 2, only with idempotency header. Never retry a 4xx. After any ambiguous outcome, reconcile first.
- **Error mapping:** `VAULT_INVALID`, `DECLINED`, `INVALID_REQUEST`, `AUTH_EXPIRED`, `NETWORK`, `UNKNOWN`; keep PayPal's debug id [VERIFY field name] in the audit row. PAYER_ACTION_REQUIRED → FAILED with `VAULT_INVALID` + dashboard banner.
- **Optional toolkit use:** read-only `list_transactions` / `get_order` in the dashboard's PayPal activity panel [VERIFY with vendor creds].

### 12.3 Spikes (Day 0–2; each writes samples with secrets redacted + a conclusion to `docs/SPIKES.md`)

- **S1** Create sandbox accounts: one personal buyer, one business vendor, REST app credentials.
- **S2** Vault flow end to end (setup token → buyer approval → payment token).
- **S3** Create an AUTHORIZE order with `vault_id`: authorization immediately, or separate `/authorize` call? Where is the authorization id?
- **S4** Capture one authorization; void another; read statuses.
- **S5** CAPTURE order with `vault_id` completes with no buyer redirect.
- **S6** Idempotency header double-send; `custom_id` round-trips.
- **S7** (optional) webhook delivery to a local tunnel.
- **S8** Gemini structured output + function calling.
- **S9** MCP TypeScript SDK HTTP hello-world, connected from Antigravity's MCP config.
- **S10** Telegram bot inline buttons + callbacks; confirm callback-data size limit (believed 64 bytes).

---

## 13. Approval service specification

**Token design:** 32 random bytes, base64url; store only SHA-256 hash; bound to `request_id`, `action`, `snapshot_hash`; expires no later than hold expiry; single use; constant-time compare. Link: `PUBLIC_BASE_URL/a/<token>`.

**Web approval page (mobile-first)**
- `GET /a/:token` renders from the DB snapshot only: vendor, amount, currency, purpose, policy reason codes (authoritative), AI summary (labelled, escaped plain text), raw source excerpt (escaped), countdown.
- Approve/Void are POSTs with CSRF token and **require a valid owner session** (show login first if absent). A leaked link alone cannot approve.
- Headers: strict CSP, `frame-ancestors 'none'`, no inline script, never render HTML from agents or LLMs.

**Telegram (P1):** messages only to the owner's chat id; buttons Review (URL), Approve, Void (callback). Callback data is a short opaque id mapped to an approval row (limit believed 64 bytes) [VERIFY]. The handler checks: sender chat id = owner, request still HELD, snapshot unchanged, token unused. Message text built from the DB, never from callback data.

**Background jobs:** expiry worker (30s) voids stale HELD requests, writes RELEASE, audits as `system`; reconciler (60s) repairs/marks FAILED, always audited. **The same expiry check also runs lazily on every read/approve request**, because free hosts sleep and background timers stop while asleep.

**Owner auth:** single owner; passphrase hashed with argon2id or bcrypt [VERIFY library]; httpOnly, SameSite=Strict session cookie (Secure over HTTPS); login rate limit (~5/min); CSRF token on every state-changing request. For judges: sandbox-only demo credentials go in the submission's testing instructions; the hosted instance only ever runs against the sandbox.

---

## 14. AI services specification

**Provider interface** (`src/ai/provider.ts`): `generateText`, `generateStructured(schema)`, plus a tool-calling loop used only by the demo agent. Env: `AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY`. Timeout 10s, one retry, then degrade gracefully. **Baseline safety never depends on the AI provider being up.**

- **a) Demo agent (`demo/agent`)** — an LLM agent that connects as an MCP client, reads an invoice, requests payments. Modes: **honest**; **hijack-simulated** (deterministic script issuing the calls a hijacked agent would — use for tests and the video); **live-injection** (real LLM reads the poisoned invoice; best effort, non-deterministic, never the only evidence).
- **b) Risk explainer** — input: structured facts (decision, reason codes, vendor, amount, stats) + untrusted source excerpt inside a delimited data block. Output (structured): `summary` (≤3 sentences, plain text) and `suspicious_phrases[]`. No tools. It can only mislead the *display*, so the UI always shows policy reason codes above the AI text and the raw excerpt beside it. **Build template-based explanations from reason codes FIRST;** AI summary is an enhancement. Cache per request in `ai_runs`.
- **c) Injection signal (P1)** — `AI_SCAN_MODE` = `off` / `advisory` / `enforce`. A positive flag adds `AI_FLAG` (forces HOLD). Can never lower a restriction. On timeout/error: no flag; deterministic result stands.
- **d) Plain-English policy authoring (P1)** — owner types a sentence → LLM drafts a policy in structured output → server validates with zod **and** code-level ceilings (e.g. `MAX_HARD_CAP_MINOR`) that no draft can exceed → UI shows a human-readable diff → only explicit owner confirmation creates a new immutable version (audit `policy_activated`, author `ai_draft_confirmed`). Never auto-activated.
- **Ops limits:** global AI rate limit (~20/min), per-request cache, template fallback text. Tests use a mock provider so CI never needs an API key.

---

## 15. Dashboard and API specification

**Owner API (session + CSRF required)**

| Method and path | Purpose |
|---|---|
| POST `/api/login`, POST `/api/logout` | Session |
| GET `/api/overview` | Budget used (spent + reserved) vs daily budget, counts by decision, recent activity |
| GET `/api/requests?status=&limit=` | List requests |
| GET `/api/requests/:id` | Detail + audit timeline |
| POST `/api/requests/:id/approve`, `/void` | Owner actions (same server path as approval links) |
| GET/POST `/api/policies` | Version list; create new version from a validated document |
| POST `/api/policies/draft` | P1: plain-English draft |
| GET/POST `/api/vendors` | Vendor registry |
| GET/POST `/api/agents`, POST `/api/agents/:id/suspend` | Agent keys (shown once), suspension |
| GET `/api/audit?limit=` | Audit log |
| GET `/api/paypal/activity` | Toolkit-backed read-only activity |
| GET `/healthz` | Public health check (no data) |

Public routes: `/mcp` (agent key); `GET /a/:token` + its POSTs (token + owner session).

**Screens:** 1 Login · 2 Overview (budget gauge, 24h counts, live feed polled every 2s) · 3 Pending approvals (cards with countdown + Approve/Void) · 4 Request detail · 5 Policies (+ P1 plain-English box) · 6 Vendors and Agents · 7 Audit · 8 PayPal activity.

---

## 16. Security design

| Threat | Mitigation | Test |
|---|---|---|
| Prompt injection → agent asks for attacker payment | Registry by id; DENY unknown/blocked; hard cap; budgets; HOLD for unusual | Attack suite |
| Structuring (many small payments) | Velocity, budget, duplicate rules | 6 × $14 test |
| Stolen agent key | Per-agent budget, suspension, rate limit, keys hashed | Suspend then call |
| Leaked approval link | Owner login required, single use, short TTL, snapshot-bound | Replay + wrong-session tests |
| Request changed between hold and approve (TOCTOU) | Snapshot hash verified before capture; amount read from DB | Tamper test |
| Race on budget | Evaluate-and-reserve in one `BEGIN IMMEDIATE` transaction | Concurrency test |
| Replay / double submit | Idempotency keys at API and PayPal; single-use tokens | Replay tests |
| XSS from agent/LLM text | Escape everything; CSP; never render HTML | Payload tests |
| CSRF | CSRF tokens + SameSite=Strict | Automated + manual |
| Secret leakage | `.env` gitignored; `.env.example` only; pino redaction; secret-scanning pre-commit hook [VERIFY tool, e.g. gitleaks] | Scan before every push |
| Accidental production use | Code refuses production without explicit flag | Config test |
| LLM outage/manipulation | Baseline never depends on AI; AI stricter-only | Provider-down test |
| Audit tampering | Append-only table; optional hash chain (P2) | Verify test |
| Endpoint abuse | Rate limits, body size limit | Load smoke test |

---

## 17. Repository layout, configuration, scripts

```
payguard/
  AGENTS.md              # rules for coding agents (Appendix C)
  PLAN.md                # this file (copy of PAYGUARD_PLAN.md)
  README.md  LICENSE  .env.example  Dockerfile  .dockerignore  .gitignore
  docs/ARCHITECTURE.md  docs/SPIKES.md  docs/DECISIONS.md
  src/
    mcp/  core/  policy/  paypal/  approvals/  ai/  api/  db/  config/
  web/                   # React + Vite dashboard and approval page
  demo/                  # seed, reset, agents, fixtures, attack suite
  scripts/spikes/        # one script per spike
  test/                  # unit, integration, e2e
```

**Environment variables** (documented in `.env.example`, no real values)

| Variable | Purpose |
|---|---|
| `NODE_ENV`, `PORT`, `PUBLIC_BASE_URL`, `DB_PATH` | Basics |
| `PAYPAL_ENV` (default SANDBOX), `ALLOW_PRODUCTION` (unset) | Environment guard |
| `CONNECTOR_ACME_CLIENT_ID`, `CONNECTOR_ACME_CLIENT_SECRET` | Demo vendor sandbox credentials |
| `SESSION_SECRET`, `OWNER_PASSPHRASE_HASH` | Owner auth |
| `HOLD_TTL_MINUTES`, `MAX_HARD_CAP_MINOR` | Operational ceilings |
| `RESEED_ON_BOOT`, `DEMO_AGENT_API_KEY`, `VAULT_TOKEN_ID` | Zero-spend hosting: re-create demo data on boot; the stable demo agent key and vault token id come from env, not the DB |
| `AI_PROVIDER`, `AI_MODEL`, `GEMINI_API_KEY`, `AI_SCAN_MODE` | AI services |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | P1 notifications |

**npm scripts:** `dev`, `build`, `start`, `typecheck`, `lint`, `test`, `test:unit`, `test:integration` (needs sandbox creds), `seed`, `reset`, `agent:create`, `demo:honest`, `demo:attack`, `demo:live`.

**License:** MIT is fine; any OSI-approved license works and must be visible in the repo's About section [VERIFIED requirement].

---

## 18. Testing strategy

- **Policy unit tests (≥ 40 table-driven cases):** boundaries (exactly the auto limit, +1 minor unit), currency, budget edges, velocity/duplicate windows, multiple reasons, DENY beats HOLD.
- **Money parsing:** accept `12`, `12.5`, `12.50`; reject `12.001`, `-1`, `0`, `0.00`, `1e3`, spaces, non-ASCII digits, absurd sizes.
- **State machine:** illegal transitions rejected; every terminal state reachable; audit row per transition in the same transaction (I2).
- **Invariants I1–I7**, including a test that fails if any MCP tool other than the four allowed exists.
- **Concurrency:** ~20 parallel requests when the budget fits 3; exactly the allowed number pass.
- **Idempotency:** same key + payload → original; different payload → `IDEMPOTENCY_CONFLICT`; PayPal calls carry the derived header.
- **Approvals:** wrong action, expired, reused, snapshot mismatch, no session, wrong Telegram chat id.
- **Attack suite (`npm run demo:attack`)** prints a pass/fail table (also usable in the video). Every case must end DENIED or HELD, never captured: unknown payee; lookalike ids; just over the limit; structuring; currency swap; zero/negative/huge/scientific amounts; non-ASCII digits; duplicate; key reuse with different payload; `source_context` containing instructions (decision must not change); XSS strings in `purpose`/`source_context` (render escaped); oversized inputs; suspended agent.
- **Sandbox integration** (auto-skipped without creds): vaulted token works; CAPTURE flow; AUTHORIZE→capture; AUTHORIZE→void; expiry worker voids a stale hold; reconciler repairs a simulated crash between the PayPal call and the DB write.
- **E2E:** scripted honest + attack flows through a real MCP client; manual phone-viewport checklist. Antigravity's browser agent may click through the dashboard, but treat its report as a hint.
- **Targets:** ≥ 90% line coverage on `src/policy` and `src/core`. Optional CI runs unit tests only, no secrets.

---

## 19. Milestones and stages

### 19.1 Overview (solo, 17 Oct → 12 Nov)

| Milestone | Dates | Theme | Gate (Definition of Done) |
|---|---|---|---|
| **M0** | 17–19 Oct | Foundations + spikes | `docs/SPIKES.md` answers S1–S6, S8, S9; Rail/fallback decision recorded |
| **M1** | 20–24 Oct | Core brain | 40+ policy tests green; I2 and I4 tested; evaluate-and-reserve is transactional |
| **M2** | 25–28 Oct | PayPal gateway | Sandbox integration tests pass (CAPTURE, AUTHORIZE→capture, AUTHORIZE→void) |
| **M3** | 29 Oct–1 Nov | MCP + demo agent | `demo:honest` and `demo:attack` run end to end. **Build is always demo-able from here.** |
| **M4** | 2–5 Nov | Approvals + dashboard | Hold→approve→captured and hold→expire→voided both work from a phone browser |
| **M5** | 6–8 Nov | AI + hardening | I1–I7 tests green; explainer live; one P1 feature shipped |
| **M6** | 9–10 Nov | Ship prep | A stranger completes README in <10 min; video public and works logged out |
| **M7** | 11 Nov | Submit (12 Nov = buffer only) | Confirmation page saved |

**Cut order if behind:** plain-English policy authoring → Telegram → second vendor → hash-chained audit → webhooks → Payouts rail.
**Never cut:** the attack suite, the hold→approve→capture flow, the README, the video.

### 19.2 Milestone details

Each task has an ID. ChatGPT: turn these into task prompts (Appendix B). Antigravity: do one task at a time.

#### M0 — Foundations and spikes (17–19 Oct)

**Goal:** know exactly what PayPal's sandbox lets us do, and have a clean repo.

| ID | Task | Who | Acceptance |
|---|---|---|---|
| M0-T1 | Create sandbox accounts (S1): personal buyer, business vendor "Acme Cloud", REST app creds; confirm vault/save-payment-methods is enabled for the vendor | **Human** | Creds in local `.env` only |
| M0-T2 | Repo skeleton: TS strict, eslint, vitest, folder layout (section 17), `.gitignore` (incl. `.env`), `.env.example`, MIT `LICENSE`, `AGENTS.md`, `PLAN.md`, README stub, `docs/{SPIKES,DECISIONS}.md` | Antigravity | `npm run typecheck && npm run lint && npm run test:unit` pass on empty suite |
| M0-T3 | Spike S2 script: vault flow end to end | Antigravity + Human (browser approval) | Payment token id obtained; findings in SPIKES.md |
| M0-T4 | Spike S3 script: AUTHORIZE order with `vault_id` | Antigravity | Documented: immediate authorization vs separate authorize call; where the authorization id lives |
| M0-T5 | Spike S4: capture one authorization, void another, read statuses | Antigravity | Findings + sample responses (secrets redacted) |
| M0-T6 | Spike S5: CAPTURE order with `vault_id`, no redirect | Antigravity | Confirmed or fallback noted |
| M0-T7 | Spike S6: idempotency header + `custom_id` round trip | Antigravity | Findings |
| M0-T8 | Spike S8: Gemini structured output + function calling | Antigravity | Findings; chosen SDK noted |
| M0-T9 | Spike S9: MCP SDK HTTP hello-world; connect from Antigravity MCP config | Antigravity + Human | Tool call visible in Antigravity |
| M0-T10 | Record decision in `docs/DECISIONS.md`: Rail A confirmed, or F1/F2 chosen | Human + ChatGPT | Entry written |

**ChatGPT seed:** "Read PLAN.md sections 0, 4, 11, 12. Produce task prompts for M0-T2 through M0-T9. Flag every VERIFY item each spike must resolve."

#### M1 — Core brain (20–24 Oct)

**Goal:** a fully tested policy engine and state machine against a fake gateway.

| ID | Task | Acceptance |
|---|---|---|
| M1-T1 | `src/config`: env loader with zod; refuses PRODUCTION without `ALLOW_PRODUCTION=true` | Config tests |
| M1-T2 | `src/db`: schema + migrations for all section 8 tables; repositories | Migrations run from empty; repo tests |
| M1-T3 | `src/core/money.ts`: parse decimal string → minor units; format back; strict validation | Money-parsing tests (section 18) |
| M1-T4 | `src/policy/types.ts` + zod schema for the policy document | Invalid docs rejected |
| M1-T5 | `src/policy/engine.ts`: pure evaluation per section 10 | ≥ 40 table-driven tests; stricter-only AI-flag test |
| M1-T6 | `src/core/facts.ts`: budgets from ledger (rolling 24h), velocity, duplicates | Fact-query tests |
| M1-T7 | `src/core/stateMachine.ts` + audit writer (reserve `prev_hash`/`hash` columns) | Illegal transitions rejected; audit row per transition (I2) |
| M1-T8 | `src/core/service.ts`: evaluate-and-reserve transaction (`BEGIN IMMEDIATE`) with idempotency, using a fake `Gateway` interface | Concurrency + idempotency tests |

**Gate:** all tests green; I2 and I4 covered.
**ChatGPT seed:** "Read PLAN.md sections 6–10 and 18. Produce prompts for M1-T3 through M1-T8, tests first."

#### M2 — PayPal gateway (25–28 Oct)

**Goal:** real sandbox money movement behind one choke point.

| ID | Task | Acceptance |
|---|---|---|
| M2-T1 | `src/paypal/tokenManager.ts`: per-connector cache, early refresh, single-flight, one retry on 401 | Unit tests with a mocked HTTP layer |
| M2-T2 | `src/paypal/http.ts`: request wrapper (retry policy, idempotency header, redaction, error mapping) | Unit tests; no secrets in logs |
| M2-T3 | `src/paypal/vault.ts` + `demo/onboardVault.ts` script | Vault token stored from the sandbox buyer |
| M2-T4 | `src/paypal/orders.ts`: create order (CAPTURE / AUTHORIZE) from vaulted token | Integration test |
| M2-T5 | `src/paypal/authorizations.ts`: capture, void, get | Integration tests |
| M2-T6 | `src/core/executeDecision.ts`: the only money-moving caller; ALLOW and HOLD paths; ledger transitions | Tests with fake + sandbox gateway; I3 test (no other callers) |
| M2-T7 | `src/paypal/reconcile.ts` + reconciler job | Simulated crash is repaired |

**Gate:** sandbox integration tests pass: CAPTURE, AUTHORIZE→capture, AUTHORIZE→void.
**ChatGPT seed:** "Read PLAN.md sections 9 and 12 and docs/SPIKES.md. Produce prompts for M2-T1 to M2-T7. Do not use any endpoint not in Appendix A."

#### M3 — MCP server and demo agent (29 Oct–1 Nov)

**Goal:** an agent can request payments; attacks are visibly stopped. **Always demo-able from here.**

| ID | Task | Acceptance |
|---|---|---|
| M3-T1 | Agent keys: `npm run agent:create` (shown once, stored hashed); bearer auth middleware | Auth tests; suspended agent denied |
| M3-T2 | MCP server skeleton over HTTP at `/mcp` | Connects from an MCP client |
| M3-T3 | Four tools with zod schemas, calling Core | Schema tests |
| M3-T4 | Idempotency + `IDEMPOTENCY_CONFLICT`; per-agent rate limit; body-size limit | Tests |
| M3-T5 | Tool-surface invariant test (I1) | Fails if any extra tool is registered |
| M3-T6 | `demo/seed.ts` and `demo/reset.ts` | Fresh clone → seeded demo in minutes |
| M3-T7 | Scripted honest agent (`demo:honest`) | $12 captured |
| M3-T8 | Hijack simulator + poisoned-invoice fixture (`demo:attack` core) | $500 → DENIED |
| M3-T9 | Attack suite v1 with printed pass/fail table | All rows end DENIED/HELD |

**Gate:** `demo:honest` and `demo:attack` pass end to end. Record a rough demo take now (fallback clip).
**ChatGPT seed:** "Read PLAN.md sections 11, 14, 16, 18. Produce prompts for M3-T1 to M3-T9."

#### M4 — Approvals and dashboard (2–5 Nov)

**Goal:** the human half: approve or void from a phone; see everything.

| ID | Task | Acceptance |
|---|---|---|
| M4-T1 | Owner auth: passphrase hash, session cookie, CSRF, login rate limit | Auth tests |
| M4-T2 | Approval tokens: mint/verify, hashed, single use, snapshot-bound | Approval tests (section 18) |
| M4-T3 | `GET /a/:token` page + POST approve/void; capture/void via Core | Hold→approve→captured and hold→void→voided |
| M4-T4 | Expiry worker (30s) | Stale hold voided and audited |
| M4-T5 | Owner REST API (section 15) | API tests |
| M4-T6 | `web/` scaffold: Vite + React + Tailwind, design tokens, shared components | Builds and serves from the Node server |
| M4-T7 | Overview screen (budget gauge, counts, live feed) | Matches wireframe in 5.3 |
| M4-T8 | Pending approvals screen | Approve/Void work |
| M4-T9 | Request detail screen (timeline, reasons, excerpt, PayPal ids) | Matches 5.4 |
| M4-T10 | Policies (read-only view + version history), Vendors, Agents, Audit screens | Functional, with empty/error states |

**Gate:** hold→approve→captured and hold→expire→voided from a phone browser. Record a second rough take.
**ChatGPT seed:** "Read PLAN.md sections 5, 13, 15. Produce prompts for M4-T1 to M4-T10; UI prompts must reference the wireframes in section 5."

#### M5 — AI and hardening (6–8 Nov)

**Goal:** meaningful AI that cannot weaken safety; security tests green.

| ID | Task | Acceptance |
|---|---|---|
| M5-T1 | `src/ai`: provider interface, Gemini implementation, mock provider, rate limit, cache (`ai_runs`) | Mock-provider tests; no key needed in CI |
| M5-T2 | Template explanations from reason codes | Always shown, even if AI is down |
| M5-T3 | AI risk explainer (structured output) layered on top, clearly labelled | Escaped rendering; fallback test |
| M5-T4 | Live-injection LLM agent (`demo:live`) | Runs; documented as best-effort |
| M5-T5 | Injection flag in `advisory` mode; `enforce` behind env (stricter-only) | I6 test passes |
| M5-T6 | **One** P1 feature: Telegram approvals **or** plain-English policy authoring (pick whichever is more demo-visible) | Works end to end |
| M5-T7 | Security pass: every row of section 16 has a passing test | I1–I7 green |
| M5-T8 | Toolkit read-only PayPal activity panel (if it works with vendor creds) | Panel shows transactions |

**ChatGPT seed:** "Read PLAN.md sections 14, 16, 18. Produce prompts for M5-T1 to M5-T8. Remind Antigravity that AI output can only make decisions stricter."

#### M6 — Ship prep (9–10 Nov)

| ID | Task | Who |
|---|---|---|
| M6-T1 | Final README: what/why, honest limitations, 7-step quickstart, architecture diagram, env table, demo credentials note | Antigravity + Human review |
| M6-T2 | Dockerfile, `.dockerignore`; hosted demo **only on a free host that needs no card** (section 0.5), re-seeded on boot, sandbox only, demo credentials; AI rate limit + fallbacks protect quota | Antigravity + Human |
| M6-T3 | **Clean-machine test:** fresh clone, README only, working demo in <10 minutes | Human |
| M6-T4 | Record the demo video (section 20) | Human |
| M6-T5 | Upload to YouTube as **public**; test the link while logged out | Human |
| M6-T6 | Draft the submission text (section 21 pitch outline) and tools statement | Human + ChatGPT |

#### M7 — Submit (11 Nov; 12 Nov buffer)

- Re-read the official Rules page [VERIFY] for anything missing.
- Submit a full day early; save the confirmation page.
- 12 Nov (12:00pm PST) is buffer only. Do not plan work for it.

### 19.3 Habits

- Commit daily; keep `main` runnable; write the README as you go.
- One task per Antigravity conversation; commit before each task so a bad run is one `git checkout` away.
- Use the strongest available model for `policy`, `core`, `paypal`, `approvals`; a lighter model for `web`, docs, boilerplate. Point the agent at files by path instead of pasting long text.
- If a spike fails or a doc disagrees with this plan: stop, update `docs/DECISIONS.md`, tell ChatGPT, then continue.

### 19.4 Money-path review checklist (human, by reading — not by trusting)

1. Amounts stay integer minor units until the PayPal boundary.
2. No money-moving call exists outside `executeDecision`.
3. Every state change writes an audit row in the same transaction.
4. Every PayPal POST sends an idempotency header.
5. No secret or token appears in logs, tests, fixtures, or commits.
6. Approval and capture read amount and vendor from the stored snapshot, never from a request body.
7. Errors fail closed (no money moves; state FAILED or HELD; audited).
8. Every new branch has a test.

---

## 20. Demo environment and video

**Sandbox setup:** one personal buyer, one business vendor (Acme Cloud) with REST app credentials, optional second vendor. The attacker needs no PayPal account: it's just a payee id absent from the registry (optionally a lookalike registered as BLOCKED).

**Scripts**
- `npm run seed`: creates owner, policy v1, honest agent + key, vendor row; walks through vaulting the buyer wallet (prints the approval URL, waits).
- `npm run reset`: clears requests, ledger, audit; voids open authorizations; keeps vendors, vault tokens, policy.

**Fixtures (`demo/fixtures`):** a legitimate $12 Acme invoice, and a poisoned invoice that looks like a normal Acme invoice but carries hidden/footer text telling an AI assistant to send $500 to payee id `attacker-001`. Harmless text files used only for this defence demo.

**Video storyboard (target 2:50; hard limit 3:00)**

| Time | Beat |
|---|---|
| 0:00–0:15 | Problem: agents holding payment keys can be talked into paying anyone |
| 0:15–0:40 | PayGuard in one sentence; agent connected over MCP; agent has no approve tool |
| 0:40–1:05 | $12 invoice auto-approved and captured; show it in the PayPal sandbox |
| 1:05–1:40 | Poisoned invoice: agent requests $500 to an unregistered payee → DENIED with reason codes and an audit row (show the attack-suite table) |
| 1:40–2:20 | $40 request HELD (AUTHORIZED in sandbox); one tap on the phone captures it; show final state |
| 2:20–2:40 | Change policy in plain English (if built) or show the budget guard |
| 2:40–2:55 | Recap: sandbox only, open-source repo, AI tools used |

Record at 1080p with captions; no music unless royalty-free and licensed for this use; no third-party logos beyond what is on screen in the product. Check the official Rules page for exact trademark wording before recording [VERIFY]. Upload public to YouTube; test the link while logged out. Use the **hijack-simulated** mode for the attack beat (deterministic); show live-injection only as a bonus.

---

## 21. Submission checklist [VERIFIED requirements]

- [ ] Uses the PayPal sandbox and AI meaningfully; working prototype
- [ ] Text description: features, functionality, who it's for
- [ ] Tools statement: which AI models/services were used and how (e.g. Gemini for the demo agent, risk explainer, policy drafting)
- [ ] Functional demo: run instructions in the repo and/or hosted URL, plus demo credentials
- [ ] Public repo with all source, assets, instructions; license visible in About
- [ ] Demo video < 3 min, public on YouTube, shows it working, no third-party trademarks or copyrighted music
- [ ] Re-read the official Rules page the day before [VERIFY]
- [ ] Submitted on 11 Nov; confirmation saved

**Pitch outline:** problem (agents with payment keys can be talked into paying anyone) → solution (agents ask, rules decide, owner approves holds) → how it uses PayPal (Vault v3, Orders CAPTURE + AUTHORIZE, authorization capture/void, toolkit read-only reporting) → how it uses AI (the agent, risk explainer, plain-English policy) → impact (safe delegation of spending to agents) → what's next (alignment with agent-mandate standards such as the intent-mandate idea in PayPal's AP2 write-up) → honest limitations.

---

## 22. Risks and mitigations

| Risk | Mitigation |
|---|---|
| AUTHORIZE with a vaulted token needs buyer approval (S3) | Decide by day 3; use F1, or F2 as a last resort |
| Sandbox business account can't save payment methods | Re-check the vault setup step in the docs; ask PayPal developer channels; fall back to F2 |
| Sandbox flakiness during recording | Record several takes early; keep the M3 and M4 clips |
| Token expiry mid-demo | Token manager with early refresh + test |
| Gemini quota exhausted | Templates first, caching, global rate limit, graceful fallback |
| Scope creep | P0/P1/P2 and the cut order |
| Agent drift / bad generated code | Small tasks, plan before edits, tests, review checklist, frequent commits |
| Solo time pressure | Fixed schedule, buffer days, always-demoable build from M3 |
| Similar entries from other participants (gallery unpublished) | Differentiate: real PayPal primitives, visible attack suite, honest threat model, polish |
| Overclaiming security | Keep honest limitations in README and say them in the video |
| Free host sleeps / loses data | Re-seed on boot, config in env vars, lazy expiry, README warning; record the video locally, not on the hosted instance |
| A sign-up asks for a card | Skip it (rule 0.5.1); fall back to local run via Docker/npm and say so in the submission |
| Gemini free-tier limits hit during judging | Template fallbacks, caching, rate limit; never enable billing |

---

## Appendix A — Endpoint cheat sheet (the only endpoints ChatGPT may use)

| Purpose | Call | Status |
|---|---|---|
| Access token | `POST /v1/oauth2/token` (basic auth, `grant_type=client_credentials`) | VERIFIED |
| Create order | `POST /v2/checkout/orders` with `intent` CAPTURE or AUTHORIZE | VERIFIED |
| Authorize order | `POST /v2/checkout/orders/{id}/authorize` | VERIFIED |
| Capture order | `POST /v2/checkout/orders/{id}/capture` | VERIFIED |
| Capture authorization | `POST /v2/payments/authorizations/{authorization_id}/capture` | VERIFIED |
| Void authorization | `/v2/payments/authorizations/{authorization_id}/void` (method POST) | VERIFIED path; VERIFY method |
| Reauthorize | `reauthorize` link in the authorization response | VERIFIED existence |
| Create vault setup token | `POST /v3/vault/setup-tokens` | VERIFIED |
| Confirm payment token | `POST /v3/vault/payment-tokens` | VERIFIED |
| List payment tokens | `GET /v3/vault/payment-tokens?customer_id=...` | VERIFIED |
| Order from vaulted token | body `payment_source.paypal.vault_id` | VERIFIED |
| Authorization details | `GET /v2/payments/authorizations/{id}` | VERIFY |
| Idempotency | `PayPal-Request-Id` header | VERIFY |
| Webhook events | `VAULT.PAYMENT-TOKEN.*` | VERIFIED; payment events VERIFY |

Base URLs: sandbox `https://api-m.sandbox.paypal.com`; production `https://api-m.paypal.com` (never used here).

---

## Appendix B — Prompts

### B.1 Task prompt template (ChatGPT writes these; Antigravity executes them)

```
Context: read AGENTS.md and PLAN.md sections <list>.
Task: <one sentence>  (milestone task id: <Mx-Ty>)
Acceptance criteria:
- <observable, testable statements>
Constraints: only touch <files or folders>; no new dependencies without a note in docs/DECISIONS.md; sandbox only.
Verification: run <commands>; expected result <what the human should see>.
Process: write a short plan first and WAIT for approval before editing files.
Report: files changed, tests added, decisions made, VERIFY items resolved (with doc links), open questions.
```

### B.2 Kickoff message for ChatGPT (paste once at the start of a session)

```
You are the planner for a solo hackathon project. I have attached PLAN.md; it is the single source of truth.
Rules:
1. Work on ONE milestone at a time, the one I name.
2. Output at most 5 task prompts using the template in PLAN.md Appendix B.1.
3. Use only the PayPal endpoints in PLAN.md Appendix A. Do not invent endpoints, fields, tool names or library APIs. If you need something not listed, tell me what to look up.
4. Mark anything uncertain as uncertain. Never guess silently.
5. Never ask for or use real credentials. Sandbox only.
6. Keep prompts small: one task, explicit acceptance criteria, explicit files.
7. If my pasted results contradict PLAN.md, stop and tell me which section to update before continuing.
Current milestone: <M0 | M1 | ...>. Repo tree and docs/SPIKES.md are below.
```

### B.3 Example first prompt (M0-T4, spike S3)

```
Context: read AGENTS.md and PLAN.md sections 4, 12.
Task: write scripts/spikes/s03-authorize-with-vault.ts that answers spike S3 (M0-T4).
Acceptance criteria:
- Using sandbox credentials from environment variables, create an order with intent AUTHORIZE and a vaulted payment token.
- Print whether the response already contains an authorization or whether a separate authorize call was needed, and where the authorization id appears in the response (redact secrets).
- Append the finding with a request/response sample to docs/SPIKES.md.
Constraints: only touch scripts/spikes and docs/SPIKES.md; no new dependencies; sandbox only.
Verification: run the script with sandbox credentials; the human will paste the output back to ChatGPT.
Process: write a short plan first and WAIT for approval before editing files.
Report: the finding, the exact PayPal documentation pages relied on, and any open questions.
```

---

## Appendix C — AGENTS.md (copy to the repo root; Antigravity reads it)

```
# AGENTS.md
Project: PayGuard, an MCP policy firewall for AI agent payments on the PayPal sandbox.
Read PLAN.md before any task. The sections named in the task are binding.

Hard rules
1. Sandbox only. Never add code paths that use PayPal production. Never ask for or print real credentials.
2. Never commit secrets. Use environment variables and update .env.example (names only).
3. The agent-facing MCP tools are exactly: request_payment, get_payment_status, get_budget, list_vendors. Never add approve, capture, void, refund or credential tools.
4. Only executeDecision in src/core may call money-moving PayPal functions.
5. Money is integer minor units. Convert to PayPal decimal strings only at the PayPal boundary.
6. AI output may only make decisions stricter. Never let it remove a restriction.
7. Every state transition writes an audit_log row in the same transaction.
8. Fail closed: on any error or ambiguity do not move money; mark the request FAILED or leave it HELD, and audit it.
9. Do not invent PayPal endpoints, fields or tool names. Anything marked VERIFY in PLAN.md must be checked against the official documentation, and the result recorded in docs/SPIKES.md, before you rely on it.
10. No new dependency without a one-line justification in docs/DECISIONS.md.

Workflow
- For every task, write a short plan first and wait for approval before editing files.
- Write or update tests with the code. Run npm run typecheck, npm run lint and npm run test:unit before reporting done.
- Keep changes small and touch only the files the task names. If you need others, stop and ask.
- When finished, report: files changed, tests added, decisions made, VERIFY items resolved, open questions.
```

---

## Appendix D — Glossary

- **MCP:** Model Context Protocol; how agents discover and call tools.
- **Vault:** PayPal's way to save a payer's payment method as a token for later orders.
- **Order intent CAPTURE / AUTHORIZE:** take payment now / place a hold to capture or void later.
- **Authorization hold:** funds reserved on the payer's PayPal account; valid 29 days, capture within a 3-day honor period [VERIFIED].
- **Snapshot hash:** SHA-256 of the canonical request fields, fixed when a hold is created; approvals act only on this.
- **Reservation (ledger):** amount counted against budgets while a request is held.
- **Stricter-only:** AI may add restrictions, never remove them.

---

## Appendix E — Progress tracker (tick as you go)

- [ ] M0 spikes done, decision recorded
- [ ] M1 policy + core green
- [ ] M2 sandbox money movement green
- [ ] M3 MCP + demo + attack suite (rough take recorded)
- [ ] M4 approvals + dashboard (second rough take recorded)
- [ ] M5 AI + hardening, I1–I7 green
- [ ] M6 README, hosting, clean-machine test, video uploaded
- [ ] M7 submitted on 11 Nov
