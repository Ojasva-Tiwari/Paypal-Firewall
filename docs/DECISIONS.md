# PayGuard Architecture & Engineering Decisions (ADR)

This document records the foundational decisions made for PayGuard. As spikes are completed and new dependencies or architectural shifts arise, they must be recorded here.

---

## Architectural Decision Records

### D1: TypeScript (Strict Mode) & Node.js 20+
- **Date**: 2026-10-18
- **Context**: PayGuard requires strong typing for financial data and policy invariants. The PayPal agent toolkit requires Node.js 18+.
- **Decision**: Standardize on TypeScript with strict compiler settings (`strict: true`) on Node.js 20+.
- **Consequences**: Type safety across MCP schemas, policy rules, and PayPal payloads. Single language across frontend, backend, and scripts.

### D2: SQLite (better-sqlite3) Local Embedded Storage
- **Date**: 2026-10-18
- **Context**: Zero-spend requirement precludes managed hosted databases (e.g. RDS/PostgreSQL). Free hosting tiers have ephemeral disks.
- **Decision**: Use embedded SQLite via `better-sqlite3`. Execute state transitions in `BEGIN IMMEDIATE` transactions. On ephemeral free hosting, re-seed basic configuration on boot (`RESEED_ON_BOOT=true`).
- **Consequences**: Zero recurring cost, simple local testing, atomic ACID transactions for ledger reservations.

### D3: Payment Rail A (Vault v3 + Orders v2)
- **Date**: 2026-10-18
- **Context**: An AI agent cannot unilaterally execute holds without pre-authorization.
- **Decision**: Choose Rail A: Owner vaults PayPal wallet against a demo vendor sandbox account. PayGuard creates Orders with `payment_source.paypal.vault_id` using intent `CAPTURE` (for ALLOW) or `AUTHORIZE` (for HOLD).
- **Consequences**: Real native PayPal hold visible in sandbox without buyer redirect; pending validation in Spikes S2-S6.

### D4: Deterministic Policy Engine at Runtime; AI Stricter-Only
- **Date**: 2026-10-18
- **Context**: LLMs are vulnerable to jailbreaking and prompt injection. Financial authorization cannot rely on non-deterministic LLM safety.
- **Decision**: The runtime policy engine is 100% pure deterministic code. AI is used solely for display explanations, drafting policies, and advisory stricter-only flags (`AI_FLAG` can only convert ALLOW to HOLD, never the reverse).
- **Consequences**: Invariant I6 guaranteed by code architecture.

### D5: Vendors Referenced Strictly by Registry ID
- **Date**: 2026-10-18
- **Context**: Attackers use lookalike payee names or typosquatting in invoice text.
- **Decision**: Vendors must be looked up by canonical registry ID (`vendor_id`). Free-text payee names are rejected with `VENDOR_UNKNOWN`.
- **Consequences**: Prevents injected payee attacks.

### D6: Rolling 24-Hour Budget Window via Ledger Entries
- **Date**: 2026-10-18
- **Context**: Calendar-day budgets suffer from timezone edge cases and reset exploitation.
- **Decision**: Calculate remaining daily budgets dynamically over a rolling 24-hour window from immutable ledger rows (`RESERVE`, `RELEASE`, `SPEND`).
- **Consequences**: Timezone-agnostic, auditable budget accounting.

### D7: Ambiguity Resolves to HOLD, Never ALLOW
- **Date**: 2026-10-18
- **Context**: Unexpected errors, novel categories, or boundary cases might slip through permissive defaults.
- **Decision**: Fail closed. Every condition must explicitly pass for an ALLOW decision. Any unexpected error or unverified condition produces a HOLD or DENY.
- **Consequences**: Eliminates fail-open security bypasses.

### D8: Approvals Require Owner Session and Single-Use Tokens
- **Date**: 2026-10-18
- **Context**: Leaked approval URLs could be triggered by unintended parties.
- **Decision**: Approval links require both an unexpired, single-use cryptographically random token AND an active owner session cookie.
- **Consequences**: A leaked link alone cannot authorize funds release.

### D9: MCP Server Exposed Over HTTP (`/mcp`)
- **Date**: 2026-10-18
- **Context**: Need standard connectivity for both remote and local AI agents.
- **Decision**: Serve MCP over HTTP at `/mcp` with Bearer token authentication, supporting stdio for local development. *(Updated by [D22](#d22-streamable-http-mcp-sole-supported-mcp-transport-deferring-stdio): `/mcp` Streamable HTTP is the sole active transport; local `stdio` is deferred.)*
- **Consequences**: Unified transport for hackathon demonstration.

### D10: Pluggable AI Interface (Gemini First via Free Tier)
- **Date**: 2026-10-18
- **Context**: Zero-spend policy requires avoiding paid LLM billing.
- **Decision**: Wrap AI operations behind a provider interface ([`src/ai/types.ts`](../src/ai/types.ts), [`src/ai/service.ts`](../src/ai/service.ts), [`src/ai/geminiProvider.ts`](../src/ai/geminiProvider.ts), and [`src/ai/mockProvider.ts`](../src/ai/mockProvider.ts)). Implement Gemini using free-tier API keys from Google AI Studio, with deterministic template fallback when AI is unavailable.
- **Consequences**: No credit card or paid billing required; system remains functional if AI rate limits are reached.

### D11: Single Owner / Single Tenant Scope
- **Date**: 2026-10-18
- **Context**: Project is built for the PayPal AI Hackathon under strict time limits.
- **Decision**: Restrict scope to a single owner and single-tenant deployment. Multi-tenancy and complex organization management are out of scope.
- **Consequences**: Keeps architecture clean, verifiable, and focused on core agentic safety.

### D12: Hold Expiry Default of 15 Minutes
- **Date**: 2026-10-18
- **Context**: PayPal authorization holds last up to 29 days, which is impractical for real-time agent workflows.
- **Decision**: Set default hold TTL to 15 minutes for demo purposes. On expiration, the hold is automatically voided.
- **Consequences**: Predictable lifecycle for automated testing and live demos.

### D13: Expiry Worker Deferred to Canonical Milestone M4 (M4-T4)
- **Date**: 2026-10-29
- **Context**: In M2-T6, `executeDecision` was verified to fail closed on `EXPIRED` requests by treating them as `NO_OP`, intentionally avoiding local release of the ledger `RESERVE` entry without an automated PayPal void operation.
- **Decision**: Keep expiry handling strictly within the canonical milestone boundary: automated voiding and single `RELEASE` row generation remain scheduled for Milestone M4 (Task M4-T4: Expiry Worker and lazy expiry check on approval). `executeDecision` continues to treat expired requests as non-executable NO_OP, keeping budget reservations intact until explicitly voided via PayPal.
- **Consequences**: No premature release of held funds; fail-closed budget protection is preserved across M2 and M3 without pulling M4 approval/worker scope forward.

### D14: Owner Passphrase Hashing via Argon2id (@node-rs/argon2)
- **Date**: 2026-10-30
- **Context**: PLAN.md Section 13 mandates secure password hashing for owner credentials (preferring Argon2id). Standard C++ `argon2` bindings require `node-gyp` and native build tools on Windows, introducing environment fragility.
- **Decision**: Adopt `@node-rs/argon2` providing precompiled native Rust N-API binaries for standard Argon2id hashing and verification (`$argon2id$...`), with automatic migration of legacy SHA-256 hashes upon successful authentication.
- **Consequences**: Zero C++ compilation dependency, high security against GPU/ASIC brute force attacks, seamless hash upgrades.

### D15: Native Fetch for Gemini AI Provider (Zero Added Dependencies)
- **Date**: 2026-11-01
- **Context**: Milestone M5 (M5-T1) implements production Gemini API communication. We evaluated using `@google/genai` SDK vs native `fetch`.
- **Decision**: Use Node.js 20+ native `fetch` with `AbortSignal` for Gemini REST API v1beta communication. Credentials passed strictly via `x-goog-api-key` header.
- **Consequences**: Zero new dependencies added (Hard Rule 10). Direct control over request timeouts, single transient retry, and response payload validation via existing `zod`. Eliminates SDK version drift.

### D16: Live-Injection LLM Agent Architecture & Pre-Dispatch Validation
- **Date**: 2026-11-01
- **Context**: Milestone M5 (M5-T4) demonstrates an autonomous LLM billing agent processing invoices with potential prompt injection against the PayGuard MCP firewall.
- **Decision**: 
  1. The LLM interacts exclusively through a structured action loop exposing the 4 canonical MCP tools.
  2. The local controller enforces pre-dispatch Zod schema validation matching the server's `.strict()` input schemas, a hard 5-step ceiling, and an allowlist of permitted tools.
  3. Action schemas omit internal chain-of-thought, requiring only a bounded `action_reason` (max 200 chars).
  4. The local controller independently validates MCP server responses and terminates immediately on `HOLD` or `DENY`, preventing model-generated workarounds.
  5. Strict provider fallback contract is preserved: missing Gemini credentials fail safely with an explicit diagnostic error rather than silently masquerading synthetic mock data as live Gemini reasoning.
  6. Remote PayPal Sandbox execution is disabled by default and enabled exclusively via explicit `--execute-sandbox` opt-in.
  7. Strict credential isolation and sanitization guarantees zero secrets enter prompts, model-visible tool outputs, or logs.
- **Consequences**: Bounded agentic risk, fail-closed protection against prompt injection, zero unauthorized money moved.

### D17: Prompt-Injection Hardening & Dual-Stage AI Scan Modes
- **Date**: 2026-11-01
- **Context**: Milestone M5 (M5-T5) hardens PayGuard against prompt injection in untrusted commercial transaction text (invoice context and payment purpose) without weakening safety or relying on AI for baseline enforcement.
- **Decision**:
  1. Implement a two-stage prompt injection detector (`InjectionDetector`):
     - Stage A: High-confidence deterministic regex heuristics evaluating instruction overrides, system impersonation, payment-control bypasses, credential exfiltration, delimiter manipulation, and zero-width Unicode obfuscation over normalized text. Conclusive matches immediately return `DETECTED` without invoking AI.
     - Stage B: Structured AI classification (via `AiService`) executed only when heuristics are inconclusive. Output is strictly validated with Zod, and all fields/arrays are bounded.
  2. Implement an explicit three-outcome contract: `DETECTED`, `CLEAR`, and `INDETERMINATE`. Model timeouts, rate limits, schema mismatches, and provider errors produce `INDETERMINATE`, never `CLEAR`.
  3. Support three operational scan modes via canonical `AI_SCAN_MODE=off|advisory|enforce`:
     - `off`: Injection scanning is skipped.
     - `advisory` (default): Injection detection runs and reports findings in metadata, but never alters deterministic policy evaluation.
     - `enforce`: High-confidence `DETECTED` injection passes `PROMPT_INJECTION_DETECTED` via `aiFlags` to the policy engine, triggering `AI_FLAG` and escalating `ALLOW` to `HOLD`. Hard `DENY` and existing `HOLD` decisions are strictly preserved.
  4. Invariant I6 is strictly preserved: AI scanning can only add restrictions, never lower them or upgrade `DENY`/`HOLD` to `ALLOW`.
  5. Baseline safety never depends on AI: on `INDETERMINATE` results, the deterministic policy baseline stands.
  6. Scanning runs before database write transactions to avoid holding SQLite locks during external AI provider calls.
- **Consequences**: Zero new dependencies added (Hard Rule 10). Guaranteed deterministic safety baseline, fail-safe degradation on AI outages, and strict protection against prompt-injection payment tampering.

### D18: Shared `ApprovalExecutionService` & Order/Capture vs. Void Boundary
- **Date**: 2026-11-11
- **Context**: Three owner/system approval channels (Dashboard REST `/api/requests/:id/*`, Web approval links `/a/:token/*`, and Telegram inline buttons) plus `HoldExpiryWorker` needed identical transactional single-use token invalidation, snapshot hash checks, and idempotent remote settlement without duplicating money-path logic.
- **Decision**: Centralize approval/void orchestration in `src/approvals/service.ts` (`ApprovalExecutionService`). All payment captures delegate through `executeDecision` (`src/core/executeDecision.ts`), which remains the sole call site for PayPal `createOrder` and `captureAuthorization`. Authorization voids (non-money-disbursing releases of holds) route through `ApprovalExecutionService` / `HoldExpiryWorker` / `ReconcilerWorker` -> `PayPalAuthorizationsService.voidAuthorization`.
- **Consequences**: Zero duplicated approval security logic across channels; cross-channel replay attacks and concurrent double-captures are blocked atomically.

### D19: PayPal `Prefer: return=representation` & Remote `orderId` Preservation (Task C2)
- **Date**: 2026-11-11
- **Context**: Live Sandbox testing (Task C1) revealed that omitting `Prefer: return=representation` on `POST /v2/checkout/orders` causes PayPal to return a minimal payload lacking top-level `intent`, `purchase_units[0].amount`, and `custom_id`, and throwing before persisting `order.id` left local rows stuck in `EXECUTION_AMBIGUOUS` with `paypal_order_id = null`.
- **Decision**:
  1. Send `Prefer: return=representation` on `PayPalOrdersService.createOrder`.
  2. Support full and reduced PayPal order representations in `parseOrderResponse` while failing closed if financial identity/amount cannot be established reliably.
  3. Attach sanitized `OrderError.orderId` whenever PayPal returns an HTTP success response containing an `id`, so `executeDecision` persists `paypal_order_id` on `AUTO_EXECUTING` / `HELD` and `ReconcilerWorker` can recover state cleanly (`C2-T5A`/`C2-T5B`).
- **Consequences**: Prevents unrecoverable orphaned remote orders/holds while preserving fail-closed money safety.

### D20: Persistent `owner_sessions` (`012`) & Scoped Browser Form CSRF on `/a/:token`
- **Date**: 2026-11-11
- **Context**: In-memory owner sessions do not survive restarts, and browser GET/form-POST flows on `/a/:token` failed due to `*/*` Accept negotiation, missing `express.urlencoded()` parsing, header-only CSRF enforcement, and CSP-blocked inline JS.
- **Decision**:
  1. Store owner sessions as SHA-256 key digests in SQLite `owner_sessions` (`012_owner_sessions`) with fail-closed `503` handling on DB errors.
  2. Scope `express.urlencoded({ extended: false, limit: '16kb' })`, `htmlErrorResponses: true`, and `allowFormBodyCsrf: true` strictly to the `/a` browser approval router (accepting hidden `_csrf` form fields only for `application/x-www-form-urlencoded` requests when `x-csrf-token` header is absent), remove inline JS `onsubmit`, and format currency symbols explicitly from `currency`. Keep `/api/*` strictly header-CSRF (`x-csrf-token`).
- **Consequences**: Standard browser GET/POST approvals on `/a/:token` function under `default-src 'none'` CSP without relaxing CSRF protections on `/api/*`.

### D21: Server-Side `MAX_HARD_CAP_MINOR` Ceiling Enforcement
- **Date**: 2026-11-11
- **Context**: `MAX_HARD_CAP_MINOR` was parsed into config but left unenforced during manual policy creation and AI policy drafting/activation.
- **Decision**: Enforce `validateHardCapWithinCeiling()` (`src/config/index.ts`) across `POST /api/policies`, `POST /api/policies/draft`, and proposal activation/reject endpoints (`src/api/owner.ts` & `src/ai/policyDrafter.ts`), ensuring `hard_cap_minor` never exceeds `config.maxHardCapMinor` even when inherited from base rules.
- **Consequences**: Aligns runtime enforcement with configuration docs and prevents AI-drafted or manual policy escalation past operational bounds.

### D22: Streamable HTTP (`/mcp`) Sole Supported MCP Transport (Deferring `stdio`)
- **Date**: 2026-11-11
- **Context**: Decision D9 initially envisioned both Streamable HTTP (`/mcp`) and local `stdio` transports. PayGuard's production server and demos standardize on HTTP bearer authentication and session-to-agent binding.
- **Decision**: Defer local `stdio` transport post-submission and operate `/mcp` Streamable HTTP as the canonical supported MCP transport (`POST`/`GET`/`DELETE /mcp`), enforced by SHA-256 agent bearer tokens and per-session `agentId` checks.
- **Consequences**: Eliminates unauthenticated local transport surface; any future `stdio` wrapper must explicitly bind an agent identity before activation.

### D23: Deferred PayPal Toolkit Panel (`M5-T8`) & Targeted Console Masking
- **Date**: 2026-11-11
- **Context**: PLAN.md listed optional `@paypal/agent-toolkit` read-only reporting (`M5-T8` / `GET /api/paypal/activity`) and `pino` structured logging (`PLAN.md` §16).
- **Decision**:
  1. Defer `@paypal/agent-toolkit` integration to keep dependencies minimal (Hard Rule 10); `GET /api/paypal/activity` returns a safe `{ enabled: false, transactions: [] }` payload.
  2. Standardize on native Node console logging with strict secret masking in HTTP/AI/MCP/audit layers rather than adding `pino` as a new dependency.
- **Consequences**: Zero unnecessary dependencies added before submission; documented transparently as deferred/known limitations.

---

## Dependency Justification Log

Per AGENTS.md rule 10, every external package dependency must have an explicit justification recorded here:

| Package | Type | Justification |
|---|---|---|
| `typescript` | devDependency | Static type checker required for strict mode TypeScript runtime. |
| `@types/node` | devDependency | TypeScript type definitions for standard Node.js APIs. |
| `vitest` | devDependency | Fast, deterministic unit test runner compatible with modern ESM TypeScript. |
| `eslint` | devDependency | Linter for enforcing code quality and preventing runtime errors. |
| `@eslint/js` | devDependency | Official ESLint JavaScript core recommended rules for ESLint 9 flat configuration. |
| `typescript-eslint` | devDependency | Tooling enabling ESLint to analyze TypeScript codebases. |
| `tsx` | devDependency | Node.js execution engine for TypeScript scripts, test helpers, and spikes. |
| `zod` | dependency | Schema validation for policy documents, environment configuration, and MCP tool input payloads per PLAN.md Section 7. |
| `better-sqlite3` | dependency | Embedded synchronous SQLite3 database driver for atomic transactions and local storage per PLAN.md Section 7 and Decision D2. |
| `@types/better-sqlite3` | devDependency | TypeScript type definitions for better-sqlite3. |
| `@modelcontextprotocol/sdk` | dependency | Official Model Context Protocol TypeScript SDK for server and transport implementation per PLAN.md Section 7. |
| `express` | dependency | Minimal HTTP server for serving MCP over HTTP at /mcp per PLAN.md Section 7 and Decision D9. |
| `@types/express` | devDependency | TypeScript type definitions for Express. |
| `@node-rs/argon2` | dependency | Precompiled Argon2id password hashing and verification for owner authentication per PLAN.md Section 13 and Decision D14. |
| `react` | dependency | Declarative component framework for owner dashboard and approval UI per PLAN.md Section 7. |
| `react-dom` | dependency | DOM renderer for React in the web dashboard per PLAN.md Section 7. |
| `lucide-react` | dependency | Clean icon system for financial navigation and status badges per UI requirements. |
| `clsx` | dependency | Class composition utility for UI styling without overhead. |
| `vite` | devDependency | Frontend build tool and local dev server per PLAN.md Section 7. |
| `@vitejs/plugin-react` | devDependency | Vite plugin for React JSX compilation and fast refresh. |
| `@tailwindcss/vite` | devDependency | Official Vite plugin for Tailwind CSS v4 pipeline integration. |
| `tailwindcss` | devDependency | Utility-first CSS engine for responsive styling and design tokens per PLAN.md Section 7. |
| `postcss` | devDependency | CSS processing pipeline required for Tailwind. |
| `autoprefixer` | devDependency | Automatic CSS vendor prefixing for modern browser compatibility. |
| `@types/react` | devDependency | TypeScript definitions for React. |
| `@types/react-dom` | devDependency | TypeScript definitions for React DOM. |
