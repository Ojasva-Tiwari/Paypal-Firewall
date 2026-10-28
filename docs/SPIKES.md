# PayGuard Spikes & Investigations

> **Status Notice**: At this foundation milestone (M0-T2), all sandbox and external integration spikes are pending. No PayPal integration has been verified at this stage. Real credentials must never be committed; all findings and payloads recorded here must have secrets and tokens redacted.

---

## Spike Tracker Overview

| Spike ID | Target Topic | Milestone | Status | Key Question / Investigation |
|---|---|---|---|---|
| **S1** | Sandbox Accounts Setup | M0-T1 | Pending | Create personal buyer, business vendor ("Acme Cloud"), REST app credentials; confirm Vault/Save Payment Methods is enabled. |
| **S2** | Vault Flow End-to-End | M0-T3 | Verified (Complete) | Verify Vault v3 flow (`/v3/vault/setup-tokens` -> buyer approval -> `/v3/vault/payment-tokens`). |
| **S3** | AUTHORIZE with Vault ID | M0-T4 | Blocked / Open Finding | Verify whether an order with `intent: AUTHORIZE` and `payment_source.paypal.vault_id` authorizes immediately or requires an explicit `/authorize` call; identify location of `authorization_id`. |
| **S4** | Authorization Capture & Void | M0-T5 | Pending | Verify `/v2/payments/authorizations/{id}/capture` and `/v2/payments/authorizations/{id}/void` status transitions and response formats. |
| **S5** | CAPTURE with Vault ID | M0-T6 | Pending | Verify whether an order with `intent: CAPTURE` and `payment_source.paypal.vault_id` completes without buyer redirect. |
| **S6** | Idempotency & Custom ID | M0-T7 | Pending | Verify `PayPal-Request-Id` idempotency header behavior and round-tripping of `custom_id` / `invoice_id`. |
| **S7** | Webhook Delivery (Optional) | M0/M2 | Pending | Test sandbox webhook delivery to a local tunneling tool. |
| **S8** | Gemini Structured Output | M0-T8 | Pending | Verify Gemini structured output and function-calling schemas via free-tier API. |
| **S9** | MCP TypeScript SDK HTTP | M0-T9 | Pending | Verify official `@modelcontextprotocol/sdk` HTTP transport at `/mcp` and client connection. |
| **S10** | Telegram Bot Buttons (P1) | M0/M5 | Pending | Verify Telegram inline keyboard callbacks, callback data byte limits (<= 64 bytes), and handler security. |

---

## Spike Logs & Detailed Entries

### Spike S2: Vault Flow End-to-End
- **Date Executed**: 2026-10-18
- **Executor**: Antigravity + Human
- **Documentation Relied Upon**:
  - PayPal Developer: [Create Setup Token (v3/vault/setup-tokens)](https://developer.paypal.com/docs/api/vault/v3/#setup-tokens_create)
  - PayPal Developer: [Create Payment Token (v3/vault/payment-tokens)](https://developer.paypal.com/docs/api/vault/v3/#payment-tokens_create)
- **Exact PayPal Endpoints Used**:
  - `POST https://api-m.sandbox.paypal.com/v1/oauth2/token`
  - `POST https://api-m.sandbox.paypal.com/v3/vault/setup-tokens`
  - `POST https://api-m.sandbox.paypal.com/v3/vault/payment-tokens`
- **Required Headers**:
  - OAuth: `Authorization: Basic <base64(client_id:client_secret)>`, `Content-Type: application/x-www-form-urlencoded`
  - Setup Token: `Authorization: Bearer <access_token>`, `Content-Type: application/json`, `PayPal-Request-Id: <uuid>`
  - Payment Token: `Authorization: Bearer <access_token>`, `Content-Type: application/json`, `PayPal-Request-Id: <uuid>`
- **Relevant Request Fields**:
  - Setup Token body:
    ```json
    {
      "payment_source": {
        "paypal": {
          "description": "PayGuard Vault Sandbox Authorization",
          "usage_pattern": "IMMEDIATE",
          "usage_type": "MERCHANT",
          "experience_context": {
            "brand_name": "PayGuard Demo",
            "locale": "en-US",
            "return_url": "https://example.com/return",
            "cancel_url": "https://example.com/cancel",
            "user_action": "CONTINUE"
          }
        }
      }
    }
    ```
  - Payment Token exchange body:
    ```json
    {
      "payment_source": {
        "token": {
          "type": "SETUP_TOKEN",
          "id": "<SETUP_TOKEN_ID>"
        }
      }
    }
    ```
- **Relevant Response Fields**:
  - Setup Token response (HTTP 201 Created):
    - `id`: `<SETUP_TOKEN_ID>`
    - `status`: `PAYER_ACTION_REQUIRED`
    - `links`: Array with `rel: "approve"`, `href: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=<SETUP_TOKEN_ID>"`
  - Payment Token response (HTTP 201 Created):
    - `id`: Permanent vault payment token ID (e.g. `2m430894bj31...`)
    - `customer.id`: PayPal customer ID mapping
    - `payment_source.paypal`: Payer profile (`email_address`, `account_id`)
- **Approval Flow Observed**:
  1. Business app requests setup token and receives URL with `approval_session_id`.
  2. Human opens approval URL in browser.
  3. Logged in with sandbox buyer account (subsequently verified via read-only token query as payer country `IN`; not established as a US buyer account), reviewed billing agreement permissions, and clicked "Agree and Continue".
  4. PayPal redirected back to the configured `return_url`.
  5. Script exchanged approved setup token via `POST /v3/vault/payment-tokens` and received a reusable payment token ID.
- **Result**:
  - Vault token creation flow succeeded end-to-end in Sandbox.
  - Payment Token ID was successfully generated (`2m430894bj312712d`).
  - Zero money was moved.
  - **Important Distinction**: S2 verified only the creation and retrieval of a vaulted payment token. Generating a payment token does not execute, prove, or guarantee successful downstream payment authorization or capture. Authorization and capture capabilities are investigated in S3/S4/S5 and are currently an open finding in S3 (`INSTRUMENT_DECLINED`).
- **Architectural Impact / Plan Updates**:
  - Confirmed Rail A Vault v3 tokenization mechanism as documented in PLAN.md Section 12.1.
  - Verified that `payment_source.paypal.vault_id` token creation succeeds via `/v3/vault/setup-tokens` and `/v3/vault/payment-tokens`. Subsequent payment authorization and capture under this token are investigated in S3/S4/S5.
- **Unresolved VERIFY Items**: None for S2 token generation. S3 investigates order creation with `intent: AUTHORIZE`.

---

### Spike S3: AUTHORIZE with Vault ID
- **Date Executed**: 2026-10-18
- **Status**: **BLOCKED / OPEN FINDING** (`INSTRUMENT_DECLINED`)
- **Executor**: Antigravity + Human
- **Documentation Relied Upon**:
  - PayPal Developer: [Orders v2 — Create Order](https://developer.paypal.com/docs/api/orders/v2/#orders_create)
  - PayPal Developer: [Orders v2 Error Messages — INSTRUMENT_DECLINED](https://developer.paypal.com/api/rest/reference/orders/v2/errors/#INSTRUMENT_DECLINED)
  - PayPal Developer: [Orders v2 — Authorize Payment for Order](https://developer.paypal.com/docs/api/orders/v2/#orders_authorize)
  - PayPal Developer: [Payment Method Tokens — Use Token](https://developer.paypal.com/docs/api/vault/v3/#payment-tokens_get)
  - PayPal Developer: [Risk Data Acquisition & FraudNet](https://developer.paypal.com/docs/business/risk/fraudnet/)
  - PayPal Developer: [Orders v2 — Stored Credentials & Merchant-Initiated Transactions](https://developer.paypal.com/docs/api/orders/v2/#orders_create)
- **Exact PayPal Endpoints Tested**:
  - `POST https://api-m.sandbox.paypal.com/v2/checkout/orders`
- **Request Payloads Tested**:
  - Primary AUTHORIZE test A: `payment_source: { paypal: { vault_id: "<VAULT_TOKEN_ID>" } }` with `intent: "AUTHORIZE"`, amount `$1.00 USD`.
  - Primary AUTHORIZE test B: `payment_source: { token: { id: "<VAULT_TOKEN_ID>", type: "PAYMENT_METHOD_TOKEN" } }` with `intent: "AUTHORIZE"`, amount `$1.00 USD`.
  - Diagnostic CAPTURE probe: `payment_source: { token: { id: "<VAULT_TOKEN_ID>", type: "PAYMENT_METHOD_TOKEN" } }` with `intent: "CAPTURE"`, amount `$1.00 USD`.
- **Confirmed Facts**:
  1. **OAuth 2.0 Token**: Obtained successfully using business sandbox credentials without exposing secrets.
  2. **Payment Token Acceptance**: The vaulted payment token (`2m430894bj312712d`) produced by S2 was successfully accepted by PayPal Sandbox in both `payment_source.paypal.vault_id` and `payment_source.token` formats without semantic or schema errors.
  3. **Observed Error**: Both AUTHORIZE requests and the diagnostic CAPTURE probe returned HTTP `422 Unprocessable Entity` with:
     ```json
     {
       "name": "UNPROCESSABLE_ENTITY",
       "details": [
         {
           "issue": "INSTRUMENT_DECLINED",
           "description": "The instrument presented  was either declined by the processor or bank, or it can't be used for this payment."
         }
       ],
       "message": "The requested action could not be performed, semantically incorrect, or failed business validation.",
       "debug_id": "f1955234c7fbd",
       "links": [
         {
           "href": "https://developer.paypal.com/api/rest/reference/orders/v2/errors/#INSTRUMENT_DECLINED",
           "rel": "information_link",
           "method": "GET"
         }
       ]
     }
      ```
   4. **Diagnostic CAPTURE Probe**: A single diagnostic probe using `intent: "CAPTURE"` was attempted during diagnosis to determine if the decline was specific to the AUTHORIZE intent; it returned the identical `INSTRUMENT_DECLINED` response.
   5. **Halt on Payment Attempts**: Following the diagnostic probe, all payment attempts were completely stopped in adherence to the fail-closed invariant. Zero further money-moving orders, captures, or authorizations have been attempted.
   6. **Token Preservation**: The vaulted payment token from S2 remains preserved and active; no new tokens were created.
   7. **Payer Profile Jurisdiction**: As verified via read-only `GET /v3/vault/payment-tokens/2m430894bj312712d`, the existing S2 token is associated with email `tojasva@gmail.com` (Payer ID `842WHVTN64TAY`) with address `country_code: "IN"` (Bengaluru, India) and phone `country_code: "IN"`.

- **Hypotheses Under Investigation**:
  1. *Hypothesis 1 — Buyer Wallet Funding Source / Balance in Sandbox* [UNPROVEN HYPOTHESIS]:
     - In PayPal Sandbox, when an order references a vaulted PayPal Wallet token, PayPal attempts to fund the hold from the underlying payment methods linked to that wallet (balance or test card).
     - If the sandbox buyer account has a $0.00 balance and lacks an active, confirmed test card capable of an authorization hold, the simulated processor returns `INSTRUMENT_DECLINED`.
  2. *Hypothesis 2 — Risk Data Acquisition (RDA / FraudNet) Requirement* [UNPROVEN HYPOTHESIS]:
     - Official PayPal documentation specifies that Risk Data Acquisition (RDA) is mandatory for customer-initiated transactions (CIT) utilizing PayPal/Venmo Payment Tokens.
     - According to PayPal docs: *"Payment attempts missing RDA data run a high risk of being declined due to insufficient risk identifiers."*
     - If PayPal's automated risk engine classifies the unannotated request as requiring client-side risk telemetry, its omission may trigger automated risk declines.
  3. *Hypothesis 3 — Business Account Reference Transactions Feature* [UNPROVEN HYPOTHESIS]:
     - While the Business App OAuth token has scopes for `billing-agreements` and `futurepayments`, backend Reference Transactions enablement on the merchant account may be required to process off-session automated wallet charges.
  4. *Hypothesis 4 — Geographic / Cross-Border Account Handling in Sandbox* [UNPROVEN HYPOTHESIS]:
     - Whether the Indian address/country code (`country_code: "IN"`) on the payer profile causes the simulated processor to reject automated USD authorization holds without interactive 3D-Secure authentication. This is strictly an unproven hypothesis and is not established as fact.

- **Current Status**: **BLOCKED / OPEN FINDING**.
- **Action Taken**:
  - Payment attempts completely stopped.
  - S2 Vault token preserved.
  - No changes made to PayGuard core architecture.
  - Awaiting operator review and direction before any further steps.

---

### S3.1 — RDA Feasibility (Documentation & Feasibility Investigation)

#### 1. Context & Objective
Investigate whether the `INSTRUMENT_DECLINED` response observed during Spike S3 can plausibly be explained by missing **Risk Data Acquisition (RDA)**, how PayPal expects RDA to be collected, and whether this affects PayGuard's server-side autonomous agent payment model.

---

#### 2. Verified Facts (from Official PayPal Documentation)
- **Fact 1: RDA Mandatory for Customer-Initiated Transactions (CIT)**:
  - *Source*: [PayPal Developer — Risk Data Acquisition & FraudNet](https://developer.paypal.com/docs/business/risk/fraudnet/) & [Payment Method Tokens v3](https://developer.paypal.com/docs/api/vault/v3/)
  - *Detail*: PayPal explicitly mandates RDA for all **Customer-Initiated Transactions (CIT)** that utilize PayPal and Venmo Payment Tokens.
  - *Quotation*: *"PayPal requires Risk Data Acquisition for all customer-initiated transactions (CIT) that utilize PayPal and Venmo Payment Tokens. Payment attempts missing RDA data run a high risk of being declined due to insufficient risk identifiers."*
- **Fact 2: Collection Mechanism (FraudNet & Magnes)**:
  - *Source*: [PayPal FraudNet Integration Guide](https://developer.paypal.com/docs/multiparty/fraud-net/)
  - *Detail*: RDA data is strictly client-side telemetry gathered in real-time via proprietary PayPal client-side libraries:
    - **FraudNet** (JavaScript library `https://c.paypal.com/da/r/fb.js` executed inside a web browser).
    - **Magnes** (native library for mobile applications).
    - Collects browser canvas fingerprinting, WebGL capabilities, screen dimensions, plugins, audio context, network timing, and device headers.
- **Fact 3: Header Transmission (`PAYPAL-CLIENT-METADATA-ID`)**:
  - *Source*: [PayPal Orders v2 Headers](https://developer.paypal.com/docs/api/orders/v2/)
  - *Detail*: The client metadata/session identifier generated by FraudNet (`f` parameter) is transmitted to PayPal API endpoints via the `PAYPAL-CLIENT-METADATA-ID` HTTP request header. Sending a synthetic or random GUID without a real browser session that posted telemetry to `c.paypal.com` does not provide valid RDA data.
- **Fact 4: Headless Server Backend Cannot Generate FraudNet Telemetry**:
  - *Detail*: A server-to-server daemon (e.g. Node.js backend) has no browser context and cannot execute client-side FraudNet telemetry scripts on behalf of an absent user.
- **Fact 5: Buyer-Not-Present / Merchant-Initiated Transactions (MIT)**:
  - *Source*: [PayPal Orders v2 API Specification](https://developer.paypal.com/docs/api/orders/v2/#orders_create) & [Save Payment Methods Guide](https://developer.paypal.com/docs/checkout/save-payment-methods/)
  - *Detail*: PayPal documents that payers do not need to be present when charged using stored payment tokens.
  - *Schema Note on Stored Credentials*: In Orders v2, `stored_credential` is defined **exclusively under `payment_source.card`** (`card_stored_credential`) and requires a `previous_transaction_reference`. It is **not** part of the schema for `payment_source.paypal` or `payment_source.token`. For vaulted PayPal Wallets, PayPal specifies passing `payment_source.paypal.vault_id` directly.

---

#### 3. Inferences & Architectural Analysis
- **Inference 1: Default Transaction Classification in S3**:
  In Spike S3, `POST /v2/checkout/orders` was sent without a `PAYPAL-CLIENT-METADATA-ID` header. If PayPal defaults unannotated API requests with vaulted tokens to Customer-Initiated Transactions (CIT), PayPal's automated risk engine expects client-side FraudNet telemetry. In its absence, the risk engine may issue an automated decline.
- **Inference 2: Plausibility vs. Proof**:
  - *Plausible*: Yes. PayPal's documentation directly warns of automated declines due to missing risk identifiers when tokenized CIT requests lack RDA.
  - *Not Proven*: PayPal's explicit definition of `INSTRUMENT_DECLINED` states: *"The instrument presented was either declined by the processor or bank, or it can't be used for this payment."* This error code is specifically associated with card issuer, bank, or wallet balance insufficiency, rather than a dedicated risk metadata error.
- **Inference 3: PayGuard Classification (MIT, not CIT)**:
  PayGuard's spend model is fundamentally an off-session, **Merchant-Initiated Transaction (MIT)**:
  1. The human owner vaults the wallet during initial onboarding (CIT step with browser presence).
  2. The autonomous AI agent requests payments later via MCP.
  3. PayGuard evaluates policy rules deterministically and executes payments server-to-server without the human present at checkout.
  Therefore, requiring real-time browser presence for autonomous agent payments contradicts the design of an autonomous payment firewall.

---

#### 4. Explicit Answers to Key Questions
- **A. Is missing RDA a plausible explanation for S3?**
  **Yes**. It is plausible because PayPal documentation warns that tokenized CIT requests without RDA telemetry risk automated decline.
- **B. Is it proven?**
  **No**. It is an unproven hypothesis. `INSTRUMENT_DECLINED` is fundamentally a funding source/processor decline and also occurs when a sandbox wallet has insufficient simulated balance or inactive sandbox funding instruments.
- **C. Can we fix it without requiring the owner to be present for every agent payment?**
  **Yes**. By ensuring the business account has active Reference Transactions enablement, passing `payment_source.paypal.vault_id`, and ensuring the underlying sandbox wallet has an active, verified funding instrument.
- **D. Does this requirement fundamentally affect PayGuard's architecture?**
  **No**. PayGuard was designed from day one around a two-phase model:
  1. *Phase 1 (Onboarding / CIT)*: Human owner connects and vaults their PayPal wallet once in a browser.
  2. *Phase 2 (Agent Execution / MIT)*: Server-side engine processes autonomous payments under the vaulted agreement without requiring active human browser participation.

---

#### 5. Open Questions
1. Does the personal sandbox buyer account (associated with the token, country code `IN`) have an active, non-zero balance and a confirmed test card listed in the PayPal Developer Dashboard under **Testing Tools -> Sandbox Accounts -> Funding**?
2. Does the buyer profile's Indian country code (`country_code: "IN"`) trigger specific simulated cross-border processing declines in Sandbox?

---

### S3.2 — Pre-Flight Sandbox Account & Capability Verification (Task M0-T4c Step 1)
- **Date Executed**: 2026-10-18
- **Status**: **PRE-FLIGHT VERIFIED — DISCREPANCY IDENTIFIED**
- **Read-Only Verification Results**:
  1. **Vault Token Details (`GET /v3/vault/payment-tokens/2m430894bj312712d`)**:
     - Status: `200 OK`
     - Payer Email: `tojasva@gmail.com`
     - Payer ID: `842WHVTN64TAY`
     - Customer ID: `MBptWqJEyH`
     - Payer Jurisdiction: `country_code: "IN"`, address Bengaluru, India.
     - Confirmed Discrepancy: Payer profile country code is `IN` rather than `US`.
  2. **Business App Capabilities (`APP-1WX70857TL4253920`)**:
     - Status: `200 OK`
     - Scopes Granted:
       * `https://uri.paypal.com/services/vault/payment-tokens/read`
       * `https://uri.paypal.com/services/vault/payment-tokens/readwrite`
       * `Braintree:Vault`
       * `https://api.paypal.com/v1/vault/credit-card`
       * `https://uri.paypal.com/services/billing-agreements`
       * `https://uri.paypal.com/services/payments/futurepayments`
       * `https://uri.paypal.com/services/payments/payment/authcapture`
       * `https://uri.paypal.com/services/checkout/one-click-with-merchant-issued-token`
  3. **Payment Call Status**: Zero payment calls executed. Vault token preserved. S3 status remains BLOCKED / OPEN FINDING pending resolution of the sandbox buyer funding instrument.
