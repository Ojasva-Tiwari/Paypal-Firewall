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
- **Decision**: Serve MCP over HTTP at `/mcp` with Bearer token authentication, supporting stdio for local development.
- **Consequences**: Unified transport for hackathon demonstration.

### D10: Pluggable AI Interface (Gemini First via Free Tier)
- **Date**: 2026-10-18
- **Context**: Zero-spend policy requires avoiding paid LLM billing.
- **Decision**: Wrap AI operations behind an interface (`src/ai/provider.ts`). Implement Gemini using free-tier API keys from Google AI Studio, with template fallback when AI is unavailable.
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
