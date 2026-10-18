# PayGuard Spikes & Investigations

> **Status Notice**: At this foundation milestone (M0-T2), all sandbox and external integration spikes are pending. No PayPal integration has been verified at this stage. Real credentials must never be committed; all findings and payloads recorded here must have secrets and tokens redacted.

---

## Spike Tracker Overview

| Spike ID | Target Topic | Milestone | Status | Key Question / Investigation |
|---|---|---|---|---|
| **S1** | Sandbox Accounts Setup | M0-T1 | Pending | Create personal buyer, business vendor ("Acme Cloud"), REST app credentials; confirm Vault/Save Payment Methods is enabled. |
| **S2** | Vault Flow End-to-End | M0-T3 | Pending | Verify Vault v3 flow (`/v3/vault/setup-tokens` -> buyer approval -> `/v3/vault/payment-tokens`). |
| **S3** | AUTHORIZE with Vault ID | M0-T4 | Pending | Verify whether an order with `intent: AUTHORIZE` and `payment_source.paypal.vault_id` authorizes immediately or requires an explicit `/authorize` call; identify location of `authorization_id`. |
| **S4** | Authorization Capture & Void | M0-T5 | Pending | Verify `/v2/payments/authorizations/{id}/capture` and `/v2/payments/authorizations/{id}/void` status transitions and response formats. |
| **S5** | CAPTURE with Vault ID | M0-T6 | Pending | Verify whether an order with `intent: CAPTURE` and `payment_source.paypal.vault_id` completes without buyer redirect. |
| **S6** | Idempotency & Custom ID | M0-T7 | Pending | Verify `PayPal-Request-Id` idempotency header behavior and round-tripping of `custom_id` / `invoice_id`. |
| **S7** | Webhook Delivery (Optional) | M0/M2 | Pending | Test sandbox webhook delivery to a local tunneling tool. |
| **S8** | Gemini Structured Output | M0-T8 | Pending | Verify Gemini structured output and function-calling schemas via free-tier API. |
| **S9** | MCP TypeScript SDK HTTP | M0-T9 | Pending | Verify official `@modelcontextprotocol/sdk` HTTP transport at `/mcp` and client connection. |
| **S10** | Telegram Bot Buttons (P1) | M0/M5 | Pending | Verify Telegram inline keyboard callbacks, callback data byte limits (<= 64 bytes), and handler security. |

---

## Spike Logs & Detailed Entries

### Template for Completed Spikes

When a spike is executed, append an entry following this format:

```markdown
### Spike S<N>: <Title>
- **Date Executed**: YYYY-MM-DD
- **Executor**: <Human / Antigravity>
- **Documentation Relied Upon**: <Official doc URL>
- **Verified Findings**:
  - Finding 1
  - Finding 2
- **Sample Request / Response (Redacted)**:
  ```json
  // Secrets and tokens replaced with [REDACTED]
  ```
- **Architectural Impact / Plan Updates**:
  - Impact note
```
