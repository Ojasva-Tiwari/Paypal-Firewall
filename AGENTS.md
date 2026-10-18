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
