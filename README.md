# PayGuard (AgentAllowance)

> **MCP Policy Firewall for Autonomous AI Agent Payments on PayPal Sandbox**

PayGuard sits between autonomous AI agents and PayPal. Agents interact with a restricted set of Model Context Protocol (MCP) tools to request payments, while a deterministic, rule-based policy engine evaluates transactions against strict budget, velocity, vendor, and risk rules to **ALLOW** (instant capture), **HOLD** (native PayPal authorization hold requiring owner confirmation), or **DENY**.

---

## Current Status: Milestone M0 (Foundations & Spikes)

PayGuard is currently in **Milestone M0 (Foundations and Spikes)**:
- Core repository skeleton, TypeScript strict mode, ESLint, and Vitest test runner initialized.
- Architectural boundaries and safety invariants defined.
- **Important**: No live PayPal integration has been verified at this stage. All external sandbox and tool integrations are queued for systematic validation in milestone spikes (S1–S10).

---

## Prerequisites

- **Node.js**: v20.0.0 or higher (LTS recommended)
- **npm**: v10.0.0 or higher
- **Git**

---

## Local Setup

1. **Clone the repository**:
   ```bash
   git clone <repo-url>
   cd Paypal-Firewall
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   > **Safety Rule**: Never commit `.env` or any real or fake credentials. Sandbox credentials only will be added in later milestones.

---

## Verification Commands

Run the foundational verification pipeline:

```bash
# Type check TypeScript codebase in strict mode
npm run typecheck

# Lint all files
npm run lint

# Run unit test suite
npm run test:unit

# Build project to dist/
npm run build
```

---

## Core Safety Invariants

1. **No Credentials to Agents**: AI agents never possess PayPal credentials and cannot execute capture, void, or approval operations.
2. **Deterministic Rules**: Spend policies are 100% deterministic code. AI models are used only for explanations and stricter-only advisory checks.
3. **Integer Minor Units**: Currency amounts are handled internally as integer minor units (e.g. cents) to prevent floating-point rounding errors.
4. **Append-Only Audit**: Every state transition writes an immutable audit record in the database.
5. **Zero Spend / Free Tier**: Operates strictly within PayPal Sandbox and free-tier AI services. No credit cards or paid services are required.

---

## License

This project is open-source under the [MIT License](LICENSE).
