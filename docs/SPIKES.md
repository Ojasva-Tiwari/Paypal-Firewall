# PayGuard Spikes & Investigations

> **Status Notice**: Integration spikes **S1, S2, S3, S4, S5, S6 (partial: `PayPal-Request-Id` & `custom_id`), S8, and S9** have been verified live across PayPal Sandbox, Google Gemini (`gemini-3.5-flash-lite`), and `/mcp` Streamable HTTP. Following Task C2 fixes (`Prefer: return=representation`, reduced-response fallback, `OrderError.orderId` preservation, and Flow B link repair), full end-to-end Sandbox tests (`C2`) and persistent runtime onboarding + controlled `$1.00 USD` live capture (`C3`) passed. **Not live-verified**: optional PayPal webhook delivery (**S7**), live Telegram Bot API inline buttons (**S10**, implemented and unit-tested offline), and `invoice_id` round-tripping (**S6**). Real credentials, secrets, bearer tokens, session cookies, unmasked active tokens, and buyer PII must never be committed.

---

## Spike Tracker Overview

| Spike ID | Target Topic | Milestone | Status | Key Question / Investigation |
|---|---|---|---|---|
| **S1** | Sandbox Accounts Setup | M0-T1 | **Verified (Complete — C1/C2/C3 Live)** | Personal US Sandbox buyer (`XAKLTFN3YBU3W`), Business vendor ("Acme Cloud"), and REST app credentials verified active for Vault v3 & Orders/Authorizations v2. |
| **S2** | Vault Flow End-to-End | M0-T3 | **Verified (Complete — S2/C3 Live)** | Verify Vault v3 flow (`/v3/vault/setup-tokens` -> buyer approval -> `/v3/vault/payment-tokens`). Fresh C3 buyer approval onboarded onto `ven-acme` in `./data/payguard.db`. |
| **S3** | AUTHORIZE with Vault ID | M0-T4 | **Verified (Complete — S3/C2 Live)** | Order with `intent: AUTHORIZE` and `payment_source.paypal.vault_id` creates authorization immediately (`purchase_units[0].payments.authorizations[0]`). Full app `createOrder` & Flow B recovery verified live in C2. |
| **S4** | Authorization Capture & Void | M0-T5 | **Verified (Complete — C1/C2 Live)** | Verify `/v2/payments/authorizations/{id}/capture` (`201 COMPLETED`) and `/v2/payments/authorizations/{id}/void` (`204` minimal / `200 VOIDED` with `Prefer: return=representation`). |
| **S5** | CAPTURE with Vault ID | M0-T6 | **Verified (Complete — C2/C3 Live)** | Live PayPal Sandbox completes `intent: CAPTURE` + `payment_source.paypal.vault_id` without redirect (`201 COMPLETED`). Verified end-to-end in C2 (`62E231133J473710X`) and C3 `./data/payguard.db` (`42X89954AW8709130`). |
| **S6** | Idempotency & Custom ID | M0-T7 | **Verified (Partial — C1/C2 Live)** | Verify `PayPal-Request-Id` idempotent replay (`200 OK` same order/capture IDs) and round-tripping of `purchase_units[0].custom_id` (`invoice_id` not tested live). |
| **S7** | Webhook Delivery (Optional) | M0/M2 | **Pending (Not Live-Verified)** | Optional webhook delivery to a local tunneling tool; not live-tested (`ReconcilerWorker` polls authoritative PayPal state directly). |
| **S8** | Gemini Structured Output | M0-T8 | **Verified (Complete — S8/C3 Live)** | Verify Gemini structured output via Gemini REST API (`gemini-3.5-flash-lite`, `responseJsonSchema`) in `demo/liveAgent.ts`, C3 `RiskExplainer`, and C3 `InjectionDetector`. |
| **S9** | MCP TypeScript SDK HTTP | M0-T9 | **Verified (Complete — C2/C3 Live)** | Verify official `@modelcontextprotocol/sdk` Streamable HTTP transport (`/mcp`), Bearer auth, per-session isolation, and exact 4 canonical tools (`local stdio` deferred). |
| **S10** | Telegram Bot Buttons (P1) | M0/M5 | **Implemented (Unit-Tested; Not Live-Verified)** | Webhook auth, `/start` deep links, AES-256-GCM inline callbacks (`<=64 bytes`), and `notification_outbox` verified offline via mocked HTTP tests; live Telegram Bot API untested. |

---

## Spike Logs & Detailed Entries

### Spike S1: Sandbox Accounts Setup
- **Date Executed**: 2026-10-18 / 2026-10-29 / 2026-11-11 (C3 Vault Onboarding)
- **Status**: **VERIFIED (COMPLETE)**
- **Confirmed Facts**:
  - PayPal Sandbox Business app credentials (`CONNECTOR_ACME_CLIENT_ID` / `CONNECTOR_ACME_CLIENT_SECRET`, strict Sandbox endpoint `https://api-m.sandbox.paypal.com`) have active `vault/payment-tokens/readwrite`, `billing-agreements`, `futurepayments`, and `authcapture` permissions.
  - Verified US Personal Sandbox buyer profiles (historically customer `jzlgElvWWa`, US buyer account `XAKLTFN3YBU3W` in C3) successfully approved Vault v3 billing agreements and funded both `CAPTURE` (`ALLOW`) and `AUTHORIZE` (`HOLD`) Sandbox transactions.
  - No credentials, emails, or full active vault tokens are logged or committed.

---

### Spike S2: Vault Flow End-to-End
- **Date Executed**: 2026-10-18 (Initial sandbox token) / 2026-10-29 (US Personal sandbox token verified)
- **Executor**: Antigravity + Human
- **Documentation Relied Upon**:
  - PayPal Developer: [Create Setup Token (v3/vault/setup-tokens)](https://developer.paypal.com/docs/api/vault/v3/#setup-tokens_create)
  - PayPal Developer: [Retrieve Setup Token (`GET /v3/vault/setup-tokens/{id}`)](https://developer.paypal.com/docs/api/vault/v3/#setup-tokens_get) — Verified against official docs: returns setup token state including `status: "APPROVED"` prior to permanent token exchange via `POST /v3/vault/payment-tokens`.
  - PayPal Developer: [Create Payment Token (v3/vault/payment-tokens)](https://developer.paypal.com/docs/api/vault/v3/#payment-tokens_create)
  - PayPal Developer: [Delete Payment Token (`DELETE /v3/vault/payment-tokens/{id}`)](https://developer.paypal.com/docs/api/vault/v3/#payment-tokens_delete) — Verified against official docs: requires scope `https://uri.paypal.com/services/vault/payment-tokens/readwrite`, returns `HTTP 204 No Content` on success; implemented in `PayPalVaultService.deletePaymentToken` (`src/paypal/vault.ts`) and `demo/onboardVault.ts` (`--replace`).
- **Exact PayPal Endpoints Used**:
  - `POST https://api-m.sandbox.paypal.com/v1/oauth2/token`
  - `POST https://api-m.sandbox.paypal.com/v3/vault/setup-tokens`
  - `GET https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/{id}`
  - `POST https://api-m.sandbox.paypal.com/v3/vault/payment-tokens`
  - `GET https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/{id}`
  - `DELETE https://api-m.sandbox.paypal.com/v3/vault/payment-tokens/{id}`
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
    - `id`: Permanent vault payment token ID (e.g. `[SANDBOX VAULT TOKEN REDACTED]`)
    - `customer.id`: PayPal customer ID mapping
    - `payment_source.paypal`: Payer profile (`email_address`, `account_id`)
- **Approval Flow Observed**:
  1. Business app requests setup token and receives URL with `approval_session_id`.
  2. Human opens approval URL in browser.
  3. Logged in with sandbox buyer account, reviewed billing agreement permissions, and clicked "Agree and Continue".
  4. PayPal redirected back to the configured `return_url`.
  5. Script exchanged approved setup token via `POST /v3/vault/payment-tokens` and received a reusable payment token ID.
- **Tokens Generated**:
  - Initial token (2026-10-18): `[SANDBOX VAULT TOKEN REDACTED]` (sandbox buyer profile with `country_code: "IN"`).
  - Verified US token (2026-10-29): Setup token `9YY5004675232974B` -> Payment token `[SANDBOX VAULT TOKEN REDACTED]` (verified US Personal Sandbox buyer account, `country_code: "US"`, customer `jzlgElvWWa`).
- **Result**:
  - Vault token creation flow succeeded end-to-end in Sandbox.
  - Payment Token IDs successfully generated (`[SANDBOX VAULT TOKEN REDACTED]` [IN] and `[SANDBOX VAULT TOKEN REDACTED]` [US]).
  - Zero money was moved.
- **Architectural Impact / Plan Updates**:
  - Confirmed Rail A Vault v3 tokenization mechanism as documented in PLAN.md Section 12.1.
  - Verified that `payment_source.paypal.vault_id` token creation succeeds via `/v3/vault/setup-tokens` and `/v3/vault/payment-tokens`. Subsequent payment authorization under this token was verified in S3.
- **Unresolved VERIFY Items**: None for S2 token generation.

---

### Spike S3: AUTHORIZE with Vault ID
- **Date Executed**: 2026-10-18 (Phase 1: Initial Investigation) / 2026-10-29 (Phase 2: Successful Verification)
- **Status**: **VERIFIED (COMPLETE)**
- **Executor**: Antigravity + Human
- **Documentation Relied Upon**:
  - PayPal Developer: [Orders v2 — Create Order](https://developer.paypal.com/docs/api/orders/v2/#orders_create)
  - PayPal Developer: [Orders v2 Error Messages — INSTRUMENT_DECLINED](https://developer.paypal.com/api/rest/reference/orders/v2/errors/#INSTRUMENT_DECLINED)
  - PayPal Developer: [Orders v2 — Authorize Payment for Order](https://developer.paypal.com/docs/api/orders/v2/#orders_authorize)
  - PayPal Developer: [Payment Method Tokens — Use Token](https://developer.paypal.com/docs/api/vault/v3/#payment-tokens_get)
  - PayPal Developer: [Risk Data Acquisition & FraudNet](https://developer.paypal.com/docs/business/risk/fraudnet/)
  - PayPal Developer: [Orders v2 — Stored Credentials & Merchant-Initiated Transactions](https://developer.paypal.com/docs/api/orders/v2/#orders_create)

#### Phase 1: Initial Investigation & INSTRUMENT_DECLINED Error (2026-10-18)
- **Historical Context**:
  The initial spike tested an authorization order using the initial vaulted payment token (`[SANDBOX VAULT TOKEN REDACTED]`).
- **Exact PayPal Endpoints Tested**:
  - `POST https://api-m.sandbox.paypal.com/v2/checkout/orders`
- **Request Payloads Tested**:
  - Primary AUTHORIZE test A: `payment_source: { paypal: { vault_id: "<VAULT_TOKEN_ID>" } }` with `intent: "AUTHORIZE"`, amount `$1.00 USD`.
  - Primary AUTHORIZE test B: `payment_source: { token: { id: "<VAULT_TOKEN_ID>", type: "PAYMENT_METHOD_TOKEN" } }` with `intent: "AUTHORIZE"`, amount `$1.00 USD`.
  - Diagnostic CAPTURE probe: `payment_source: { token: { id: "<VAULT_TOKEN_ID>", type: "PAYMENT_METHOD_TOKEN" } }` with `intent: "CAPTURE"`, amount `$1.00 USD`.
- **Confirmed Facts & Observations (Historical)**:
  1. **OAuth 2.0 Token**: Obtained successfully using business sandbox credentials without exposing secrets.
  2. **Payment Token Acceptance**: The vaulted payment token (`[SANDBOX VAULT TOKEN REDACTED]`) produced by S2 was successfully accepted by PayPal Sandbox in both `payment_source.paypal.vault_id` and `payment_source.token` formats without semantic or schema errors.
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
  5. **Halt on Payment Attempts**: Following the diagnostic probe, all payment attempts were completely stopped in adherence to the fail-closed invariant. Zero further money-moving orders, captures, or authorizations were attempted.
  6. **Token Preservation**: The vaulted payment token from S2 remained preserved and active; no new tokens were created.
  7. **Payer Profile Jurisdiction**: As verified via read-only `GET /v3/vault/payment-tokens/[SANDBOX VAULT TOKEN REDACTED]`, the existing S2 token was associated with a buyer profile (Payer ID `842WHVTN64TAY`, Customer ID `MBptWqJEyH`) with address `country_code: "IN"` and phone `country_code: "IN"`. (Sensitive personal email and street address redacted).
- **Hypotheses Under Investigation (Historical Observations)**:
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
     - Whether the Indian address/country code (`country_code: "IN"`) on the payer profile causes the simulated processor to reject automated USD authorization holds without interactive 3D-Secure authentication. This was strictly an unproven hypothesis and was not established as fact.
- **Fail-Closed Action Taken at Phase 1**:
  - Payment attempts completely stopped.
  - S2 Vault token preserved.
  - No changes made to PayGuard core architecture.
  - Awaiting operator review and direction before any further steps.

#### Phase 2: Successful Verification (2026-10-29)
- **Exact PayPal Endpoints Tested**:
  - `POST https://api-m.sandbox.paypal.com/v2/checkout/orders`
  - `GET https://api-m.sandbox.paypal.com/v2/checkout/orders/8HA52206RU194812P` (read-only verification)
  - `GET https://api-m.sandbox.paypal.com/v2/payments/authorizations/0VV72942FA945182R` (read-only verification)
- **Request Payload**:
  ```json
  {
    "intent": "AUTHORIZE",
    "payment_source": {
      "paypal": {
        "vault_id": "[SANDBOX VAULT TOKEN REDACTED]"
      }
    },
    "purchase_units": [
      {
        "reference_id": "default",
        "custom_id": "payguard-s3-test",
        "description": "PayGuard Spike S3 Sandbox Authorization Test",
        "amount": {
          "currency_code": "USD",
          "value": "1.00"
        }
      }
    ]
  }
  ```
- **Confirmed Facts & Results**:
  1. **HTTP Status**: `201 Created`
  2. **Order ID**: `8HA52206RU194812P`
  3. **Order Status**: `COMPLETED`
  4. **Authorization ID**: `0VV72942FA945182R`
  5. **Authorization Status**: `CREATED`
  6. **Authorized Amount**: `1.00 USD`
  7. **Seller Protection**: `ELIGIBLE`
  8. **Expiration Time**: `2026-11-27T04:48:11Z` (29-day hold honor window)
  9. **Timing of Authorization**: The authorization was created **immediately upon order creation** in the `purchase_units[0].payments.authorizations` array. A secondary call to `/v2/checkout/orders/{id}/authorize` was **not required**.
  10. **Zero Captures Executed**: Authorization `0VV72942FA945182R` remains in `CREATED` status (open hold) ready for S4 capture/void testing.

#### Analysis: Observed Facts vs. Inferred Explanations
- **Observed Facts**:
  1. Testing with a newly vaulted US Personal Sandbox buyer account (`[SANDBOX VAULT TOKEN REDACTED]`, country `US`) with confirmed sandbox funding instruments succeeded immediately on the first attempt using canonical `payment_source.paypal.vault_id`.
  2. The server-to-server `POST /v2/checkout/orders` request succeeded without passing client-side FraudNet telemetry headers (`PAYPAL-CLIENT-METADATA-ID`).
  3. The merchant REST app credentials have the necessary permissions to process vaulted authorization holds.
- **Inferred Explanations (Qualified)**:
  1. *Account Profile / Funding Instruments*: While switching to a verified US Personal Sandbox buyer account with active funding instruments correlated directly with the successful authorization, the precise internal processor reason for the initial `INSTRUMENT_DECLINED` cannot be definitively proven without PayPal internal processor logs. Potential contributing factors include simulated processor rules for international accounts in Sandbox, differing funding instrument setups on the test buyer profiles, or simulated wallet balance handling. It is an observed correlation, not a conclusively established singular root cause.
  2. *FraudNet / RDA*: Client-side FraudNet was confirmed not to be a hard blocking requirement for server-to-server vaulted orders in this sandbox test configuration, even though PayPal documentation specifies RDA for customer-initiated transactions.
  3. *Merchant Configuration*: The sandbox business application's granted scopes (`vault/payment-tokens`, `billing-agreements`, `futurepayments`, `authcapture`) are sufficient for off-session server-side authorization holds.

#### Key Spike S3 Answers
- **Q1. Can an order be created using the vaulted payment token?** YES (`POST /v2/checkout/orders` with `payment_source.paypal.vault_id`).
- **Q2. Does creating the AUTHORIZE order immediately create an authorization?** YES (`purchase_units[0].payments.authorizations[0]`).
- **Q3. Does the order require `POST /v2/checkout/orders/{id}/authorize`?** NO.
- **Q4. Where exactly is the authorization ID returned?** `purchase_units[0].payments.authorizations[0].id`.
- **Q5. What are the resulting order and authorization statuses?** Order: `COMPLETED`, Authorization: `CREATED`.
- **Q6. What information is required later to capture or void the authorization?** Authorization ID (`0VV72942FA945182R`) and `POST /v2/payments/authorizations/{id}/capture` or `/void`.

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
1. Does the personal sandbox buyer account (associated with the initial token, country code `IN`) have an active, non-zero balance and a confirmed test card listed in the PayPal Developer Dashboard under **Testing Tools -> Sandbox Accounts -> Funding**?
2. Does the buyer profile's Indian country code (`country_code: "IN"`) trigger specific simulated cross-border processing declines in Sandbox?

---

### S3.2 — Pre-Flight Sandbox Account & Capability Verification (Task M0-T4c Step 1)
- **Date Executed**: 2026-10-18
- **Status**: **PRE-FLIGHT VERIFIED — DISCREPANCY IDENTIFIED**
- **Read-Only Verification Results**:
  1. **Vault Token Details (`GET /v3/vault/payment-tokens/[SANDBOX VAULT TOKEN REDACTED]`)**:
     - Status: `200 OK`
     - Payer Email: `[REDACTED_BUYER_EMAIL]`
     - Payer ID: `842WHVTN64TAY`
     - Customer ID: `MBptWqJEyH`
     - Payer Jurisdiction: `country_code: "IN"`.
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

---

### Spike S8: Gemini Structured Output
- **Date Executed**: 2026-11-11
- **Status**: **VERIFIED (COMPLETE)**
- **Executor**: Antigravity
- **Documentation Relied Upon**:
  - Google Gemini REST API (`v1beta` `models.generateContent`, `generationConfig.responseMimeType`, `generationConfig.responseJsonSchema`, `x-goog-api-key` authentication)
  - Zod v4 `z.toJSONSchema()` (`zod@^4.6.7`)
- **Exact Endpoints Verified**:
  - `GET https://generativelanguage.googleapis.com/v1beta/models` (`HTTP 200 OK`)
  - `GET https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite` (`HTTP 200 OK`)
  - `POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent` (`HTTP 200 OK`, structured JSON verified)
- **Required Headers & Request Fields**:
  - Headers: `Content-Type: application/json`, `x-goog-api-key: <REDACTED_GEMINI_KEY>` (never sent as a URL query parameter)
  - `generationConfig`:
    - `temperature: 0`
    - `maxOutputTokens` (bounded to `1..2048`)
    - `responseMimeType: "application/json"` (structured mode)
    - `responseJsonSchema`: Derived from the target Zod schema via `z.toJSONSchema(schema, { unrepresentable: 'any' })` with `$schema` removed
- **Diagnostic Root-Cause Summary & Fix Verified**:
  1. Live diagnostics confirmed `gemini-3.8-flash` suffered repeated `HTTP 503 UNAVAILABLE` responses and tail latency exceeding `10s` (`~14.5s`), causing timeouts under the previous `10,000ms` timeout ceiling.
  2. Switching default model `DEFAULT_GEMINI_MODEL` to `gemini-3.5-flash-lite` reduced normal structured inference latency to `~1.2s–2.7s` warm (`~10s` cold outlier), and raising the bounded default timeout to `25,000ms` handles cold-start/retry latency without unbounded hangs.
  3. Without `generationConfig.responseJsonSchema`, `gemini-3.5-flash-lite` produced incorrect JSON keys (e.g. `tool_name` instead of `tool`) that failed `LiveAgentStepSchema`. Passing Zod-derived `responseJsonSchema` produced `HTTP 200` schema-valid JSON on every verified step.
  4. Verified clean Zod-to-JSON-Schema generation for all four PayGuard schemas: `LiveAgentStepSchema`, `AiRiskExplanationSchema`, `AiInjectionClassificationSchema`, and `AiPolicyDraftOutputSchema`.
- **Live Verification Evidence (`demo/liveAgent.ts`)**:
  - Command executed: `node --env-file=.env --import tsx demo/liveAgent.ts --provider gemini` (`--execute-sandbox` omitted)
  - Observed result:
    - Provider: `gemini`, Model: `gemini-3.5-flash-lite`
    - Ephemeral MCP session authenticated and discovered canonical 4 tools (`request_payment`, `get_payment_status`, `get_budget`, `list_vendors`)
    - Completed 3 consecutive live Gemini structured inferences (`list_vendors` -> `get_budget` -> `request_payment`) passing `LiveAgentStepSchema` and strict pre-dispatch Zod argument validation
    - On fixture `invoice-poisoned.txt`, Gemini ignored the injected `attacker-001` `$500.00` override and proposed `$12.00 USD` to `ven-acme`, which PayGuard deterministically placed on local `HOLD` (`HELD`, `CATEGORY_MISMATCH`)
    - Zero remote PayPal calls executed (`Remote Capture: None (Local / Blocked)`), zero secrets logged, exit code `0`
- **Remaining Follow-Up**:
  - `RiskExplainer`, Stage B `InjectionDetector`, and `PolicyDrafter` schemas are confirmed compatible with `z.toJSONSchema()` and covered by offline unit tests; live interactive dashboard execution of those three endpoints can be exercised manually against a running server with `AI_PROVIDER=gemini`.

---

### Spike S4: Authorization Capture & Void
- **Date Executed**: 2026-11-11 (Task C1 Live Sandbox Verification)
- **Status**: **VERIFIED (COMPLETE — LIVE SANDBOX)**
- **Executor**: Antigravity
- **Exact PayPal Endpoints Verified**:
  - `POST https://api-m.sandbox.paypal.com/v2/payments/authorizations/{authorization_id}/capture`
  - `POST https://api-m.sandbox.paypal.com/v2/payments/authorizations/{authorization_id}/void`
  - `GET https://api-m.sandbox.paypal.com/v2/payments/authorizations/{authorization_id}`
- **Required Headers Observed**:
  - `Authorization: Bearer <REDACTED_OAUTH_TOKEN>`
  - `Content-Type: application/json`
  - `PayPal-Request-Id: payguard-capture-{requestId}` / `payguard-void-{requestId}`
  - `Prefer: return=representation` (used by `PayPalAuthorizationsService.captureAuthorization` and `PayPalAuthorizationsService.voidAuthorization`)
- **Confirmed Response Semantics**:
  1. **Capture (`captureAuthorization` / `executeDecision` Flow C)**:
     - With `Prefer: return=representation`, `POST .../capture` returned `HTTP 201 Created` (`debug_id: ca58af387fdcc`, capture ID `54N2477319008361U`, `status: "COMPLETED"`, `final_capture: true`, `amount: { currency_code: "USD", value: "16.01" }`).
     - Subsequent `GET /v2/payments/authorizations/8MX425738Y713501H` returned `HTTP 200 OK` (`debug_id: ca58af39548f7`) with `status: "CAPTURED"`.
  2. **Void (`voidAuthorization`)**:
     - **Without `Prefer: return=representation`** (diagnostic test `9WE19151XR999192D`), `POST .../void` returned `HTTP 204 No Content` (`debug_id: f39469592be86`, empty body).
     - **With `Prefer: return=representation`** (`5PJ73502A3093513S`, `8MM27573XM049591K`, `5UP02354SE6008326`), `POST .../void` returned `HTTP 200 OK` (`debug_id: ca58af3a5cfc0`, `ca58af3e62995`, `ca58af4171eaa`) with JSON body containing `id` and `status: "VOIDED"`.
     - `PayPalAuthorizationsService.voidAuthorization` handles both `HTTP 204` and `HTTP 200` (`status: "VOIDED"`).
     - Subsequent `GET /v2/payments/authorizations/5PJ73502A3093513S` returned `HTTP 200 OK` (`debug_id: ca58af3ac293a`) with `status: "VOIDED"`.
- **Execution Note**:
  - In Task C1, live S4 capture and void operated on `HELD` records seeded with live `AUTHORIZE` orders because unmodified `PayPalOrdersService.createOrder` lacked `Prefer: return=representation`. In Task C2, upstream Flow B `HELD` creation, Flow C capture, and remote void were all verified end-to-end starting from MCP `request_payment`.

---

### Spike S5: CAPTURE with Vault ID
- **Date Executed**: 2026-11-11 (Task C1 Initial Diagnosis; Task C2 Fix & Full Live Verification)
- **Status**: **VERIFIED (COMPLETE — LIVE SANDBOX)**
- **Executor**: Antigravity
- **Exact PayPal Endpoints Tested**:
  - `POST https://api-m.sandbox.paypal.com/v2/checkout/orders` (`intent: "CAPTURE"`, `Prefer: return=representation`, `payment_source.paypal.vault_id: "[SANDBOX VAULT TOKEN REDACTED]"`)
  - `GET https://api-m.sandbox.paypal.com/v2/checkout/orders/{order_id}`
- **Task C1 Findings (Root Cause Diagnosis)**:
  1. **PayPal API completes off-session `CAPTURE` without redirect**: Sending `intent: "CAPTURE"` with `payment_source.paypal.vault_id` immediately returned `HTTP 201 Created`, order `status: "COMPLETED"`, and completed capture under `purchase_units[0].payments.captures[0]` (`status: "COMPLETED"`).
  2. **Blocker #1 (Fixed in C2)**: `PayPalOrdersService.createOrder` previously omitted `Prefer: return=representation`, causing PayPal Sandbox to return a minimal response without top-level `intent`, `purchase_units[0].amount`, or `purchase_units[0].custom_id` and triggering `INVALID_ORDER_RESPONSE` (`intent 'undefined'`) after capturing `$1.00 USD` (order `1P305303VU528854A`, capture `3BH91280H60332216`, `debug_id: f590807457cde`) and authorizing `$16.00 USD` (auth `5UP02354SE6008326`, `debug_id: ca58af34cce64`).
  3. **Blocker #2 (Fixed in C2)**: Throwing before return dropped `order.id`, leaving `paypal_order_id = null` on `EXECUTION_AMBIGUOUS`.
- **Task C2 Resolution & End-to-End Live Verification**:
  1. Added `headers: { Prefer: 'return=representation' }` to `PayPalOrdersService.createOrder` (`src/paypal/orders.ts`) plus fail-closed reduced-response recovery and sanitized `OrderError.orderId` preservation.
  2. End-to-end unmodified MCP `request_payment` (`ALLOW`, `$1.00 USD`) -> `executeDecision` -> `POST /v2/checkout/orders` returned `HTTP 201` (`debug_id: ca58b43385df2`, Order `62E231133J473710X`, Capture `9N118671PL225252E`), transitioning locally to `CAPTURED` with `RESERVE + SPEND`.
  3. Live fault injection stripping a `201` body to `{ id, status }` preserved `paypal_order_id: 90H693658N997090N` (`AUTO_EXECUTING` + `EXECUTION_AMBIGUOUS` audit), and `reconcilePaymentRequest` recovered via `GET /v2/checkout/orders/90H693658N997090N` (`HTTP 200`, `debug_id: ca58b43a3ff21`, Capture `9FA829409F055333T`) to `CAPTURED + SPEND`.

---

### Spike S6: Idempotency & Custom ID
- **Date Executed**: 2026-11-11 (Task C1 & Task C2 Live Sandbox Verification)
- **Status**: **VERIFIED (PARTIAL — LIVE SANDBOX)**
- **Verified Live Behaviors**:
  1. **Order Creation Replay (`PayPal-Request-Id`)**:
     - Replaying `POST /v2/checkout/orders` with identical `PayPal-Request-Id` (`payguard-order-c1-cap-pref-9cdb4d64`, `payguard-order-req-c5e12ccf-2aaf-4ecc-8c34-5674fca4d673`, and `payguard-order-req-d4c3a680-8963-494a-8c5b-d98fab4654d0`) returned `HTTP 200 OK` (`debug_id: ca58af3bc9885`, `f38551271a8f7`, `ca58b43c73c17`) with identical order and capture IDs (`62E231133J473710X` / `9N118671PL225252E` in C2) without duplicate charge.
  2. **Authorization Capture Replay (`PayPal-Request-Id`)**:
     - Replaying `POST .../capture` with identical `PayPal-Request-Id` returned `HTTP 200 OK` (`debug_id: ca58af3c37a2f` in C1; `ca58b43cf894d` for `5WA214075B877180R` / `0MK251958S602461E` in C2) with identical capture ID and zero error or double capture.
  3. **`purchase_units[0].custom_id` Round-Tripping**:
     - Round-tripped intact on `GET /v2/checkout/orders/{id}` and on `POST /v2/checkout/orders` responses when `Prefer: return=representation` is included.
- **Not Tested Live**:
  - `invoice_id` round-tripping on `createOrder` / `captureAuthorization` was not exercised live in C1 or C2.

---

## Task C1: Live PayPal Sandbox Integration Verification (2026-11-11)

### Verification Boundary (Mocked vs. Live Sandbox vs. Manual)

| Verification Layer | Scope & What It Covers | Actual Status |
|---|---|---|
| **Mocked Automated Suite (`npm run test:unit`)** | Policy engine, state machine, ledger invariants, mocked PayPal HTTP retry/error mapping, mocked `executeDecision`, mocked `reconcilePaymentRequest`, auth/CSRF/sessions, dashboard routes, Telegram webhook/outbox mocks, React component/page unit tests. | **Passed Offline** (`vitest run`; mocked transport) |
| **Task C1 Live Sandbox Probes** | Real HTTPS against `https://api-m.sandbox.paypal.com` using existing Sandbox credentials in `.env` and verified S2/S3 US buyer token `[SANDBOX VAULT TOKEN REDACTED]` inside isolated `:memory:` SQLite DBs + ephemeral `/mcp` & `/api` servers. | **Partial — See Matrix Below** (`C1-T1`, `C1-T4`–`C1-T8B` downstream & diagnostics passed; unmodified Flow A `C1-T2` & Flow B `C1-T3` **FAILED** due to Blockers #1–#2) |
| **Manual / Live Unverified Items** | Out-of-box boot against `./data/payguard.db` (currently lacks `VAULT_TOKEN_ID` / `vendor_vault_tokens` row — **Blocker #3**); end-to-end unmodified `request_payment` (`ALLOW`/`HOLD`) after `createOrder` fix (`Task C2`); live browser/UI Playwright, live Telegram webhook (`S7`/`S10`), and `invoice_id` round-trip. | **Not Executed / Requires Task C2 + Manual Testing** |

### Live Sandbox Execution Matrix (2026-11-11)

| Test ID | Operation Tested | Outcome | PayPal HTTP Status & Debug IDs | Local / Remote State & Notes |
|---|---|---|---|---|
| **C1-T0** | Read-only preflight (`loadConfig`, `/v1/oauth2/token`, `/v3/vault/payment-tokens/[SANDBOX VAULT TOKEN REDACTED]`, `vendor_vault_tokens` check) | **PASS (Gap Noted)** | `POST /v1/oauth2/token` -> `200` (`ca58ac77adeb2`); `GET /v3/vault/...` -> `200` (`ca58ac787a9b2`) | Strictly `https://api-m.sandbox.paypal.com`. Active token `[SANDBOX VAULT TOKEN REDACTED]` (`CREATED`), but `.env` `VAULT_TOKEN_ID` and `./data/payguard.db` `vendor_vault_tokens` are unset/empty (**Blocker #3**). |
| **C1-T1** | `TokenManager` OAuth acquisition + cache reuse + `PayPalVaultService.getPaymentToken` | **PASS** | `POST /v1/oauth2/token` -> `200` (`f166762d08afc`); `GET /v3/vault/...` -> `200` (`f475437096ed5`) | Single OAuth HTTP call reused across repeat `getAccessToken`; vault status `CREATED`. |
| **C1-T2** | Unmodified Flow A (`$1.00 USD` `ALLOW` via `/mcp` -> `executeDecision` -> `PayPalOrdersService.createOrder`) | **FAIL** | `POST /v2/checkout/orders` -> `201` (`f590807457cde`); Replay `200` (`f38551271a8f7`); `GET` `200` (`f669038965462`) | Remote order `1P305303VU528854A` `COMPLETED` (capture `3BH91280H60332216`), **but** `parseOrderResponse` threw `INVALID_ORDER_RESPONSE` (`intent 'undefined'`); local stayed `AUTO_EXECUTING` with `paypal_order_id = null`, audit `EXECUTION_AMBIGUOUS`, `RESERVE` only (**Blockers #1 & #2**). |
| **C1-T2b** | Diagnostic `POST /v2/checkout/orders` (`CAPTURE`, `$1.01 USD`) with `Prefer: return=representation` + `ordersService.getOrder` | **PASS (Diagnostic)** | `POST /v2/checkout/orders` -> `201` (`ca58af35f7ae3`); `GET /v2/checkout/orders/3FV48632TU931102V` -> `200` (`ca58af36f3a13`) | Returned full `intent: "CAPTURE"`, `purchase_units[0].amount`, `purchase_units[0].custom_id`, capture `80730599UB9959234`; `getOrder` parsed `isCaptured: true`. |
| **C1-T3** | Unmodified Flow B (`$16.00 USD` `HOLD` via `/mcp` -> `executeDecision` -> `PayPalOrdersService.createOrder` `AUTHORIZE`) | **FAIL** | `POST /v2/checkout/orders` -> `201` (`ca58af34cce64`); cleanup `/void` -> `200` (`ca58af4171eaa`) | Remote auth `5UP02354SE6008326` created (`CREATED`), **but** `parseOrderResponse` threw `INVALID_ORDER_RESPONSE` (`intent 'undefined'`); local `HELD` had `paypal_order_id = null`, `paypal_authorization_id = null` (**Blockers #1 & #2**). Auth cleaned up cleanly (`VOIDED`). |
| **C1-T3b** | Diagnostic `POST /v2/checkout/orders` (`AUTHORIZE`) with `Prefer: return=representation` (`c1_diag_prefer` + 4 probe holds) | **PASS (Diagnostic)** | `201` across 5 orders (`f84991359d797`, `ca58af377af61`, `ca58af398cda9`, `ca58af3c8ea28`, `ca58af3f46caa`) | Full `intent`, `amount`, `custom_id`, `payments.authorizations[0]` returned immediately (`f39469592be86` confirmed `/void` returns `204` without `Prefer`). |
| **C1-T4** | Owner `/api/requests/:id/approve` -> `ApprovalExecutionService` -> `executeDecision` Flow C (`$16.01 USD`, seeded live `HELD` auth) | **PASS (Downstream)** | `POST .../capture` -> `201` (`ca58af387fdcc`); `GET .../8MX425738Y713501H` -> `200` (`ca58af39548f7`) | Enforced `401` unauth & `403` missing CSRF; valid approve -> `200 CAPTURED` (capture `54N2477319008361U`); ledger `RESERVE + SPEND`; remote auth `CAPTURED`. Requires `Prefer` fix for unpatched upstream Flow B creation. |
| **C1-T5** | Owner `/api/requests/:id/void` -> `ApprovalExecutionService` -> `voidAuthorization` (`$16.02 USD`, seeded live `HELD` auth) | **PASS (Downstream)** | `POST .../void` -> `200` (`ca58af3a5cfc0`); `GET .../5PJ73502A3093513S` -> `200` (`ca58af3ac293a`) | Local `VOIDED`, `remote_void_status: CONFIRMED`, ledger `RESERVE + RELEASE`, remote auth `VOIDED`. |
| **C1-T6** | `reconcilePaymentRequest` across Flows A (`1P305303VU528854A`), B (`5PJ73502A3093513S`), C (`8MX425738Y713501H`), D (`PENDING` void) | **PASS (With Persisted IDs)** | `GET /orders` `200` (`ca58af3af1d68`); `GET /authorizations` `200` (`ca58af3b28a3d`, `ca58af3b57e3f`, `ca58af3b90b44`) | Flows A & C converged to `CAPTURED + SPEND`; Flow B converged `VOIDED + RELEASE`; Flow D confirmed `remote_void_status = CONFIRMED` with `1` `RELEASE` row. (Blocked in practice if `paypal_order_id` was dropped by Blocker #2.) |
| **C1-T7** | Local idempotency guards + live `PayPal-Request-Id` replays (`createOrder` & `captureAuthorization`) | **PASS** | `POST /orders` replay -> `200` (`ca58af3bc9885`); `POST .../capture` replay -> `200` (`ca58af3c37a2f`) | `0` wire calls for terminal `executeDecision`, duplicate `/approve` (`409`), duplicate `/void` (`200`), MCP replay/conflict; PayPal returned identical order/capture IDs on replay. |
| **C1-T8A** | Pre-capture timeout (`AbortSignal.timeout(5)`) -> fail closed -> reconciler retains `CAPTURING` -> cleanup void -> reconcile `FAILED` | **PASS** | `GET /auth` `200` (`ca58af3d80d08`, `ca58af3df09ab`); cleanup `/void` `200` (`ca58af3e62995`); `GET /auth` `200` (`ca58af3ed2b16`) | `/approve` returned `202 CAPTURING` (`AMBIGUOUS_EXECUTION`). `PayPalHttpClient` executed its 1 configured idempotent POST retry (both timed out cleanly); repeat `executeDecision` had `0` wire calls; reconciler stayed `UNRESOLVED` on `CREATED`, then converged `FAILED + RELEASE` after void. |
| **C1-T8B** | Simulated `ETIMEDOUT` after real `HTTP 201` capture -> fail closed -> reconciler converges `CAPTURED + SPEND` | **PASS** | Attempt 1 `POST .../capture` -> `201` (`ca58af4017b44`); retry aborted before wire; `GET /auth` `200` (`ca58af411196d`) | `/approve` returned `202 CAPTURING`; repeat `executeDecision` had `0` wire calls; reconciler queried remote `CAPTURED` auth `28M70317TC731315C` and converged `CAPTURED` + single `SPEND`. |

### Clean Sandbox Post-Test State (2026-11-11 — After C1)
- All authorization holds opened during Task C1 probes (`9WE19151XR999192D`, `5UP02354SE6008326`, `8MX425738Y713501H`, `5PJ73502A3093513S`, `8MM27573XM049591K`, `28M70317TC731315C`) were verified in terminal `CAPTURED` or `VOIDED` state before exit.
- Historical Spike S3 order `8HA52206RU194812P` / auth `0VV72942FA945182R` (`$1.00 USD`, `CREATED`) was left untouched.

---

## Task C2: Live PayPal Sandbox Re-Verification (2026-11-11)

### Verification Boundary (Mocked vs. Live Sandbox vs. Manual)

| Verification Layer | Scope & What It Covers | Actual Status |
|---|---|---|
| **Offline Checks (`typecheck`, `lint`, `test:unit`, `build`)** | TypeScript strict check (`tsc --noEmit` + web), ESLint, Vite + server build, and full 64-file / 1403-test Vitest unit/integration suite including 12 new C2 regression tests. | **Passed** |
| **Task C2 Live Sandbox Suite (`c2_live_verify.ts`)** | Real HTTPS against `https://api-m.sandbox.paypal.com` using existing Sandbox credentials in `.env` and verified S2/S3 US buyer token `[SANDBOX VAULT TOKEN REDACTED]` inside isolated `:memory:` SQLite DB + ephemeral `/mcp` & `/api` servers. | **Passed (`C2-T0`–`C2-T6`) — See Matrix Below** |
| **Manual / Live Remaining Items** | Local runtime DB (`./data/payguard.db`) still requires explicit vault configuration for `ven-acme` (`VAULT_TOKEN_ID` / `npm run vault:onboard -- --vendor ven-acme`); live interactive browser Playwright E2E, live Telegram webhook (`S7`/`S10`), and `invoice_id` round-trip remain unexecuted live. | **Pending Manual / Optional Verification** |

### Live Sandbox Execution Matrix (2026-11-11)

| Test ID | Operation Tested | Outcome | PayPal HTTP Status & Debug IDs | Local / Remote State & Notes |
|---|---|---|---|---|
| **C2-T0** | OAuth acquisition (`TokenManager`), cache reuse, & `PayPalVaultService.getPaymentToken` (`[SANDBOX VAULT TOKEN REDACTED]`) | **PASS** | `POST /v1/oauth2/token` -> `200` (`ca58b43319aea`); `GET /v3/vault/...` -> `200` (`ca58b4333ce87`) | Strictly `https://api-m.sandbox.paypal.com`. `1` OAuth HTTP call reused across `getAccessToken`; vault token active (`CREATED`). |
| **C2-T1** | Unmodified Flow A (`$1.00 USD` `ALLOW` via MCP `request_payment` -> `executeDecision` -> `createOrder`) | **PASS** | `POST /v2/checkout/orders` (`Prefer: return=representation`) -> `201` (`ca58b43385df2`); `GET /orders` -> `200` (`ca58b43465d2a`) | MCP & DB both `CAPTURED`. Order `62E231133J473710X` (`COMPLETED`), capture `9N118671PL225252E` (`COMPLETED`), ledger `RESERVE:100, SPEND:100`. |
| **C2-T2** | Unmodified Flow B (`$16.00 USD` `HOLD` via MCP `request_payment` -> `executeDecision` -> `createOrder` `AUTHORIZE`) | **PASS** | `POST /v2/checkout/orders` (`Prefer: return=representation`) -> `201` (`ca58b434a8c0f`); `GET /authorizations` -> `200` (`ca58b4361dac6`) | MCP & DB both `HELD`. Order `6X615608PA6850000`, authorization `5WA214075B877180R` (`CREATED`), ledger `RESERVE:1600`. |
| **C2-T3** | Owner `/api/requests/:id/approve` (`401`/`403`/CSRF guards -> `ApprovalExecutionService` -> `executeDecision` Flow C) | **PASS** | `POST .../capture` -> `201` (`ca58b4365e928`); `GET /authorizations` -> `200` (`ca58b43765dc7`) | Unauth `401`, missing CSRF `403`, valid approve `200`. Capture `0MK251958S602461E` (`COMPLETED`), remote auth `CAPTURED`, ledger `RESERVE:1600, SPEND:1600`. |
| **C2-T4** | Unmodified Flow B (`$16.01 USD` `HOLD`) + Owner `/api/requests/:id/void` (`ApprovalExecutionService` -> `voidAuthorization`) | **PASS** | `POST /orders` -> `201` (`ca58b437b2db0`); `POST .../void` -> `200` (`ca58b43894e7d`); `GET /authorizations` -> `200` (`ca58b438fe97f`) | Order `8L5286482M541873R`, auth `01P61436L50221920`. Local `VOIDED`, `remote_void_status: CONFIRMED`, remote auth `VOIDED`, ledger `RESERVE:1601, RELEASE:1601`. |
| **C2-T5A** | Flow A live post-`201` stripped-body parse failure -> automatic `orderId` preservation -> `reconcilePaymentRequest` | **PASS** | `POST /orders` (Fault: `STRIP_201_BODY_KEEP_ID_STATUS`) -> `201` (`ca58b4393dfe2`); `GET /orders` -> `200` (`ca58b43a3ff21`) | Preserved `paypal_order_id: 90H693658N997090N` on `payment_requests` (`AUTO_EXECUTING`) & `EXECUTION_AMBIGUOUS` audit payload; repeat `executeDecision` blocked (`0` wire calls); reconciler resolved without manual `orderId` to `CAPTURED` (`9FA829409F055333T`) + `SPEND`. |
| **C2-T5B** | Flow B live post-`201` stripped-body parse failure -> `orderId` preservation -> `REPAIRED_HOLD_ID` -> Owner `/approve` Flow C | **PASS** | `POST /orders` (Fault: `STRIP_201_BODY_KEEP_ID_STATUS`) -> `201` (`ca58b43a819db`); `GET /orders` -> `200` (`ca58b43b62c9a`); `POST .../capture` -> `201` (`ca58b43ba3f67`) | Preserved `paypal_order_id: 78M051651X647512N` on `HELD` & audit payload; repeat `executeDecision` blocked (`0` wire calls); reconciler linked auth `5XL28680N1652815D` (`REPAIRED_HOLD_ID`); owner `POST /approve` returned `200` capturing `8AK55457F75568649` (`CAPTURED`, `RESERVE + SPEND`). |
| **C2-T6** | Local duplicate/idempotency guards (`0` wire calls) + live `PayPal-Request-Id` order & capture replays | **PASS** | `POST /orders` replay -> `200` (`ca58b43c73c17`); `POST .../capture` replay -> `200` (`ca58b43cf894d`); pre-exit `GET /authorizations` -> `200` (`ca58b43d59c3a`, `ca58b43d8e9d4`, `ca58b43dc2f58`) | Terminal `executeDecision` (`NO_OP`), duplicate `/approve` (`409`), duplicate `/void` (`200`), MCP replay/conflict all made `0` wire calls; live `PayPal-Request-Id` replays returned identical IDs; full DB audit hash chain valid (`18/18`). |

### Clean Sandbox Post-Test State (2026-11-11 — After C2)
- All authorizations created during the verified Task C2 run (`5WA214075B877180R` -> `CAPTURED`, `01P61436L50221920` -> `VOIDED`, `5XL28680N1652815D` -> `CAPTURED`) were confirmed terminal via `GET /v2/payments/authorizations/{id}` before exit.
- Authorizations opened during two earlier aborted C2 test-harness runs (prior to the harness audit-column and `snapshot_hash` test-fixture fixes) were voided in the harness `finally` cleanup block.
- Historical Spike S3 order `8HA52206RU194812P` / auth `0VV72942FA945182R` (`$1.00 USD`, `CREATED`) remains intentionally untouched.

---

### Spike S9: MCP TypeScript SDK Streamable HTTP (`/mcp`)
- **Date Executed**: 2026-11-11 (C2, C3, and Submission Runtime Refresh)
- **Status**: **VERIFIED (COMPLETE — LIVE RUNTIME)**
- **Evidence**:
  - Live clients using `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` authenticated to `POST /mcp` with per-agent Bearer keys, completed `initialize` / `tools/list`, and verified strictly 4 canonical tools: `request_payment`, `get_payment_status`, `get_budget`, `list_vendors`.
  - Unauthenticated requests failed closed (`401` JSON-RPC `-32001`), and `GET /healthz` returned `200 {"status":"ok","service":"payguard-mcp","tools":4}`.
  - Note: Local `stdio` transport is deferred; Streamable HTTP `/mcp` is the sole supported MCP transport.

---

## Task C3: Persistent Runtime, Live Gemini & Controlled Sandbox Verification (2026-11-11)

- **Vault v3 Persistent Onboarding (`./data/payguard.db`)**:
  - Executed `demo/onboardVault.ts` (`--setup-only` then `--confirm 1F743081JU613672C`) with US Personal Sandbox buyer `XAKLTFN3YBU3W`.
  - Confirmed `GET /v3/vault/payment-tokens/{id}` returned `CREATED` (`customer: jzlgElvWWa`, `[SANDBOX VAULT TOKEN REDACTED]`), persisted on `ven-acme`, and appended `vault_token_created` to `audit_log` without overwriting existing vendor records.
- **Live Gemini Integration (`gemini-3.5-flash-lite`)**:
  - Verified live `RiskExplainer` generation and `ai_runs` persistence via owner dashboard request detail (`req-hold-ai`) and live `InjectionDetector` preflight (`ai_runs` row `airun-7b402343-81a7-4c2b-985d-0c0356fb3a65`, `status: SUCCESS`, zero mock fallback).
- **Controlled `$1.00 USD` Live Sandbox Capture (`ALLOW`)**:
  - Dedicated active agent `C3 Smoke Test Agent` (`agent-551c9b61-e060-4deb-b7c6-6b8a21547d80`, `$50.00 USD` daily budget) executed one authorized `$1.00 USD` MCP `request_payment` (`req-be22b2e2-4cc8-473d-ad71-2f63edc2680f`) to `ven-acme`.
  - PayPal Sandbox created Order `42X89954AW8709130` (`intent: CAPTURE`, `status: COMPLETED`) and Capture `0GD719587L321405N` (`1.00 USD`, `COMPLETED`, `custom_id: req-be22b2e2-4cc8-473d-ad71-2f63edc2680f`).
  - SQLite recorded `CAPTURED`, `RESERVE:100 + SPEND:100` ledger entries (`$49.00 USD` agent remaining / `$199.00 USD` global remaining), and valid hash-chained `audit_log` (`38/38` valid entries at that pre-rotation C3 snapshot, `PRAGMA integrity_check = ok`).
- **Submission Runtime Refresh — Pre-Rotation Baseline (Zero Payments)**:
  - Restarted `node --env-file=.env dist/src/server.js` after final release-blocker fixes (historical baseline prior to vault-token rotation), preserving `./data/payguard.db` (`38/38` pre-rotation audit rows intact, `owners: 1`, `agents: 5`, `vendors: 5`, `payment_requests: 7`), verifying `/healthz` (`200`, `tools: 4`), rebuilt dashboard bundle `/assets/index-CdezU_AW.js` (`200`), read-only 4-tool `/mcp` discovery + `get_budget` (`$49.00`) + `list_vendors` (`4`), and zero startup errors or secret leakage.
- **Vault Token Rotation & Credential Remediation (2026-11-11 — Post-Rotation State)**:
  - Verified `GET /v3/vault/setup-tokens/{id}` (`APPROVED`), `POST /v3/vault/payment-tokens`, `GET /v3/vault/payment-tokens/{id}`, and `DELETE /v3/vault/payment-tokens/{id}` (`HTTP 204 No Content`, followed by `404` confirmation) live against PayPal Sandbox.
  - Revoked prior exposed historical Sandbox payment tokens remotely, atomically transitioned prior local `ven-acme` row `vtok-62e1776d-1e70-4a8c-a76b-00d1501bf95a` to `REVOKED` (`vault_token_revoked`), and persisted a fresh replacement Sandbox token (`vtok-984f55ae-e638-4eec-8071-8428ebf2ccb5`, customer `msZKgeYWav`, status `CREATED`, `vault_token_created`) in `./data/payguard.db` without executing any payment operations.
  - Post-rotation verification confirmed the extended SQLite hash chain at `40/40` valid `audit_log` entries (the `38` pre-rotation entries plus `vault_token_revoked` and `vault_token_created`, `PRAGMA integrity_check = ok`), offline test suite passing (`64/64` files, `1,434/1,434` tests), and refreshed runtime startup (`/healthz` `200`, `tools: 4`).
- **Known Unverified Items Explicitly Retained**:
  - Live Telegram Bot API webhook/inline buttons (`S7`/`S10`; tested with `TELEGRAM_MODE=disabled` healthy in runtime and mocked HTTP suites offline).
  - Live Docker container build/run (`docker info` reported `//./pipe/dockerDesktopLinuxEngine` unavailable on host).
  - PayPal `invoice_id` field round-trip (`S6`), interactive browser Playwright session on `/a/:token`, and live `PolicyDrafter` dashboard re-verification post-fix.
