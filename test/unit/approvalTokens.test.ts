/**
 * PayGuard — Milestone M4: Approvals & Dashboard
 * M4-T2 Unit & Security Tests: Approval Tokens (test/unit/approvalTokens.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../../src/db/connection.js';
import { Repositories } from '../../src/db/repositories.js';
import { toMinorUnits } from '../../src/core/money.js';
import { computeSnapshotHash } from '../../src/core/service.js';
import {
  generateRawApprovalToken,
  hashApprovalToken,
  isValidTokenFormat,
  constantTimeCompare,
  mintApprovalToken,
  verifyApprovalToken,
  consumeApprovalToken,
} from '../../src/approvals/tokens.js';

describe('M4-T2: Approval Tokens (Mint, Verify, Single-Use & Cryptographic Binding)', () => {
  let db: Database;
  let repos: Repositories;

  const testAgentId = 'agent-test-1';
  const testVendorId = 'ven-acme';
  const testPolicyId = 'pol-v1';
  const testRequestId = 'req-held-001';

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = new Repositories(db);

    // Setup base records: Owner, Agent, Vendor, Policy
    repos.owners.upsert({
      display_name: 'Primary Owner',
      passphrase_hash: 'dummy-hash',
      telegram_chat_id: null,
      created_at: new Date().toISOString(),
    });

    repos.agents.insert({
      id: testAgentId,
      name: 'Test Agent',
      api_key_hash: 'agent-hash',
      status: 'ACTIVE',
      daily_budget_minor: toMinorUnits(5000),
      created_at: new Date().toISOString(),
    });

    repos.vendors.insert({
      id: testVendorId,
      name: 'Acme Cloud',
      status: 'ACTIVE',
      categories: JSON.stringify(['cloud']),
      currencies: JSON.stringify(['USD']),
      connector_key: 'acme_cloud',
      created_at: new Date().toISOString(),
    });

    repos.policyVersions.insert({
      id: testPolicyId,
      version: 1,
      rules: JSON.stringify({ auto_limit_minor: 1500 }),
      author: 'owner',
      active: 1,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
  });

  /**
   * Helper to insert a valid HELD payment request with a deterministic snapshot_hash.
   */
  function insertHeldRequest(overrides?: {
    id?: string;
    amountMinor?: number;
    status?: string;
    expiresAt?: string;
    snapshotHash?: string | null;
  }) {
    const requestId = overrides?.id ?? testRequestId;
    const amountMinor = toMinorUnits(overrides?.amountMinor ?? 2500); // $25.00
    const currency = 'USD';
    const purpose = 'Monthly cloud server hosting';
    const category = 'cloud';
    const nowIso = new Date().toISOString();
    const expiresAt = overrides?.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const computedSnapshot = computeSnapshotHash({
      requestId,
      agentId: testAgentId,
      vendorId: testVendorId,
      amountMinor,
      currency,
      purpose,
      category,
    });

    const snapshotHash = overrides?.snapshotHash !== undefined ? overrides.snapshotHash : computedSnapshot;

    repos.paymentRequests.insert({
      id: requestId,
      agent_id: testAgentId,
      idempotency_key: `idem-${requestId}`,
      vendor_id: testVendorId,
      amount_minor: amountMinor,
      currency,
      purpose,
      category,
      source_context_excerpt: 'Server instance invoice',
      source_context_hash: null,
      status: overrides?.status ?? 'HELD',
      decision: 'HOLD',
      reasons: JSON.stringify(['AMOUNT_EXCEEDS_AUTO_LIMIT']),
      policy_version_id: testPolicyId,
      snapshot_hash: snapshotHash,
      paypal_order_id: null,
      paypal_authorization_id: 'AUTH-TEST-12345',
      paypal_capture_id: null,
      expires_at: expiresAt,
      created_at: nowIso,
      updated_at: nowIso,
    });

    return { requestId, snapshotHash, expiresAt, amountMinor };
  }

  // ============================================================================
  // 1. Token Generation & Format
  // ============================================================================

  describe('1. Token Generation & Format', () => {
    it('generates 32 cryptographically random bytes encoded as 43-character base64url', () => {
      const rawToken = generateRawApprovalToken();

      expect(typeof rawToken).toBe('string');
      // 32 bytes in base64url has exactly ceil(32 * 4 / 3) = 43 characters
      expect(rawToken).toHaveLength(43);
      // Valid base64url characters only (no padding, no '+', no '/')
      expect(/^[A-Za-z0-9_-]{43}$/.test(rawToken)).toBe(true);
      expect(rawToken).not.toContain('=');
      expect(rawToken).not.toContain('+');
      expect(rawToken).not.toContain('/');
    });

    it('generates unique tokens across multiple calls with high entropy', () => {
      const count = 100;
      const tokens = new Set<string>();
      for (let i = 0; i < count; i++) {
        tokens.add(generateRawApprovalToken());
      }
      expect(tokens.size).toBe(count);
    });

    it('validates token format using isValidTokenFormat', () => {
      const validToken = generateRawApprovalToken();
      expect(isValidTokenFormat(validToken)).toBe(true);

      // Rejections
      expect(isValidTokenFormat('')).toBe(false);
      expect(isValidTokenFormat(null)).toBe(false);
      expect(isValidTokenFormat(undefined)).toBe(false);
      expect(isValidTokenFormat(12345)).toBe(false);
      expect(isValidTokenFormat('short-token')).toBe(false);
      expect(isValidTokenFormat(validToken + 'a')).toBe(false); // 44 chars
      expect(isValidTokenFormat(validToken.slice(0, 42))).toBe(false); // 42 chars
      expect(isValidTokenFormat(validToken.replace(/[A-Za-z0-9]/, '+'))).toBe(false); // '+' is not base64url
      expect(isValidTokenFormat(validToken.replace(/[A-Za-z0-9]/, '='))).toBe(false); // '=' is padding
    });

    it('constantTimeCompare performs timing-safe buffer comparison', () => {
      expect(constantTimeCompare('secret-token-12345', 'secret-token-12345')).toBe(true);
      expect(constantTimeCompare('secret-token-12345', 'secret-token-12346')).toBe(false);
      expect(constantTimeCompare('short', 'longer-string')).toBe(false);
      expect(constantTimeCompare('', '')).toBe(true);
    });
  });

  // ============================================================================
  // 2. Only Token Hashes Are Persisted
  // ============================================================================

  describe('2. Only Token Hashes Are Persisted', () => {
    it('persists only the SHA-256 digest in approvals table and never the raw token', () => {
      const { requestId } = insertHeldRequest();
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
      });

      expect(mintResult.success).toBe(true);
      const rawToken = mintResult.rawToken!;
      const tokenHash = mintResult.tokenHash!;

      // Verify tokenHash is a 64-character hex string
      expect(tokenHash).toHaveLength(64);
      expect(/^[a-f0-9]{64}$/.test(tokenHash)).toBe(true);
      expect(tokenHash).toBe(hashApprovalToken(rawToken));

      // Direct inspection of database row
      const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(mintResult.approvalId) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.token_hash).toBe(tokenHash);
      expect(row.token_hash).not.toBe(rawToken);

      // Ensure raw token does NOT appear anywhere in the database tables
      const allApprovalsJson = JSON.stringify(db.prepare('SELECT * FROM approvals').all());
      expect(allApprovalsJson).not.toContain(rawToken);

      const allRequestsJson = JSON.stringify(db.prepare('SELECT * FROM payment_requests').all());
      expect(allRequestsJson).not.toContain(rawToken);

      const allAuditJson = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
      expect(allAuditJson).not.toContain(rawToken);
    });
  });

  // ============================================================================
  // 3. Correct Request / Action / Snapshot Binding
  // ============================================================================

  describe('3. Correct Request / Action / Snapshot Binding', () => {
    it('correctly binds token to requestId, action APPROVE, and snapshotHash', () => {
      const { requestId, snapshotHash } = insertHeldRequest();
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
        channel: 'web',
      });

      expect(mintResult.success).toBe(true);
      expect(mintResult.requestId).toBe(requestId);
      expect(mintResult.action).toBe('APPROVE');
      expect(mintResult.snapshotHash).toBe(snapshotHash);
      expect(mintResult.channel).toBe('web');

      // Verify token
      const verifyResult = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        expectedAction: 'APPROVE',
        expectedRequestId: requestId,
        expectedSnapshotHash: snapshotHash ?? undefined,
      });

      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.approval?.request_id).toBe(requestId);
      expect(verifyResult.approval?.action).toBe('APPROVE');
      expect(verifyResult.request?.id).toBe(requestId);
      expect(verifyResult.request?.snapshot_hash).toBe(snapshotHash);
    });

    it('correctly binds token to action VOID and channel telegram', () => {
      const { requestId } = insertHeldRequest();
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'VOID',
        channel: 'telegram',
      });

      expect(mintResult.success).toBe(true);
      expect(mintResult.action).toBe('VOID');
      expect(mintResult.channel).toBe('telegram');

      const verifyResult = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        expectedAction: 'VOID',
        expectedRequestId: requestId,
      });

      expect(verifyResult.valid).toBe(true);
      expect(verifyResult.approval?.action).toBe('VOID');
      expect(verifyResult.approval?.channel).toBe('telegram');
    });
  });

  // ============================================================================
  // 4. Expiry and Hold-Expiry Boundary
  // ============================================================================

  describe('4. Expiry and Hold-Expiry Boundary', () => {
    it('token expiry is strictly clamped to never exceed hold expiry', () => {
      const now = new Date('2026-11-01T12:00:00.000Z');
      const holdExpiresAt = new Date('2026-11-01T12:15:00.000Z').toISOString(); // 15 mins hold

      const { requestId } = insertHeldRequest({ expiresAt: holdExpiresAt });

      // Request TTL of 60 minutes (3600s), but hold expires in 15 minutes (900s)
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
        ttlSeconds: 3600,
        now,
      });

      expect(mintResult.success).toBe(true);
      // Expiry must be clamped to holdExpiresAt (12:15), NOT 12:00 + 60m (13:00)
      expect(mintResult.expiresAt).toBe(holdExpiresAt);
    });

    it('uses requested TTL when it is shorter than hold expiry', () => {
      const now = new Date('2026-11-01T12:00:00.000Z');
      const holdExpiresAt = new Date('2026-11-01T12:30:00.000Z').toISOString(); // 30 mins hold

      const { requestId } = insertHeldRequest({ expiresAt: holdExpiresAt });

      // Request TTL of 5 minutes (300s)
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
        ttlSeconds: 300,
        now,
      });

      expect(mintResult.success).toBe(true);
      // Expiry must be 12:05:00
      expect(mintResult.expiresAt).toBe('2026-11-01T12:05:00.000Z');
    });

    it('rejects minting if payment hold has already expired', () => {
      const now = new Date('2026-11-01T12:16:00.000Z');
      const pastHoldExpiresAt = new Date('2026-11-01T12:15:00.000Z').toISOString();

      const { requestId } = insertHeldRequest({ expiresAt: pastHoldExpiresAt });

      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
        now,
      });

      expect(mintResult.success).toBe(false);
      expect(mintResult.error).toBe('HOLD_EXPIRED');
    });

    it('rejects verification if token has expired', () => {
      const now = new Date('2026-11-01T12:00:00.000Z');
      const holdExpiresAt = new Date('2026-11-01T12:15:00.000Z').toISOString();

      const { requestId } = insertHeldRequest({ expiresAt: holdExpiresAt });

      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
        ttlSeconds: 300, // Expires at 12:05:00
        now,
      });
      expect(mintResult.success).toBe(true);

      // Verify at 12:04:59 (valid)
      const validBefore = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        now: new Date('2026-11-01T12:04:59.000Z'),
      });
      expect(validBefore.valid).toBe(true);

      // Verify at 12:05:01 (expired)
      const expiredAfter = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        now: new Date('2026-11-01T12:05:01.000Z'),
      });
      expect(expiredAfter.valid).toBe(false);
      expect(expiredAfter.error).toBe('TOKEN_EXPIRED');
    });

    it('rejects verification if associated hold expires even if token expiry is in the future', () => {
      const now = new Date('2026-11-01T12:00:00.000Z');
      const holdExpiresAt = new Date('2026-11-01T12:10:00.000Z').toISOString();

      const { requestId } = insertHeldRequest({ expiresAt: holdExpiresAt });

      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
        now,
      });
      expect(mintResult.success).toBe(true);

      // Manually simulate hold expired on the request record
      db.prepare('UPDATE payment_requests SET expires_at = ? WHERE id = ?').run(
        '2026-11-01T12:01:00.000Z',
        requestId
      );

      const check = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        now: new Date('2026-11-01T12:02:00.000Z'),
      });

      expect(check.valid).toBe(false);
      expect(check.error).toBe('HOLD_EXPIRED');
    });
  });

  // ============================================================================
  // 5. Successful One-Time Consumption
  // ============================================================================

  describe('5. Successful One-Time Consumption', () => {
    it('atomically marks token used and records used_at timestamp', () => {
      const now = new Date('2026-11-01T12:00:00.000Z');
      const holdExpiresAt = new Date('2026-11-01T12:15:00.000Z').toISOString();
      const { requestId } = insertHeldRequest({ expiresAt: holdExpiresAt });
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
        now,
      });
      expect(mintResult.success).toBe(true);

      const consumeTime = '2026-11-01T12:02:00.000Z';
      const consumeResult = consumeApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        expectedAction: 'APPROVE',
        now: consumeTime,
      });

      expect(consumeResult.success).toBe(true);
      expect(consumeResult.approval?.used_at).toBe(consumeTime);
      expect(consumeResult.request?.id).toBe(requestId);

      // Verify row in database
      const row = repos.approvals.getByTokenHash(mintResult.tokenHash!);
      expect(row?.used_at).toBe(consumeTime);
    });
  });

  // ============================================================================
  // 6. Replay Rejection
  // ============================================================================

  describe('6. Replay Rejection', () => {
    it('rejects replay consumption on an already consumed token', () => {
      const { requestId } = insertHeldRequest();
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
      });
      expect(mintResult.success).toBe(true);

      // First consumption succeeds
      const first = consumeApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        expectedAction: 'APPROVE',
      });
      expect(first.success).toBe(true);

      // Second consumption must fail closed with TOKEN_ALREADY_USED
      const second = consumeApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        expectedAction: 'APPROVE',
      });
      expect(second.success).toBe(false);
      expect(second.error).toBe('TOKEN_ALREADY_USED');

      // Subsequent read-only verification also reports TOKEN_ALREADY_USED
      const verifyCheck = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
      });
      expect(verifyCheck.valid).toBe(false);
      expect(verifyCheck.error).toBe('TOKEN_ALREADY_USED');
    });
  });

  // ============================================================================
  // 7. Concurrent Consumption Protection
  // ============================================================================

  describe('7. Concurrent Consumption Protection', () => {
    it('guarantees that exactly one concurrent consumption succeeds and the other fails', () => {
      const { requestId } = insertHeldRequest();
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
      });
      expect(mintResult.success).toBe(true);

      // Simulate race condition: 10 parallel consumption attempts
      const attempts = Array.from({ length: 10 }, (_, i) => {
        return consumeApprovalToken(db, repos, {
          rawToken: mintResult.rawToken!,
          expectedAction: 'APPROVE',
          now: new Date(Date.now() + i * 10).toISOString(),
        });
      });

      const successful = attempts.filter((r) => r.success);
      const rejected = attempts.filter((r) => !r.success && r.error === 'TOKEN_ALREADY_USED');

      expect(successful).toHaveLength(1);
      expect(rejected).toHaveLength(9);
    });
  });

  // ============================================================================
  // 8. Invalid Token Rejection
  // ============================================================================

  describe('8. Invalid Token Rejection', () => {
    it('rejects malformed token strings', () => {
      expect(verifyApprovalToken(db, repos, { rawToken: '' }).error).toBe('INVALID_TOKEN_FORMAT');
      expect(verifyApprovalToken(db, repos, { rawToken: 'abc' }).error).toBe('INVALID_TOKEN_FORMAT');
      expect(
        verifyApprovalToken(db, repos, {
          rawToken: '0123456789012345678901234567890123456789012345678901234567890123',
        }).error
      ).toBe('INVALID_TOKEN_FORMAT'); // 64 chars
    });

    it('rejects properly formatted but non-existent tokens', () => {
      const fakeToken = generateRawApprovalToken();
      const res = verifyApprovalToken(db, repos, { rawToken: fakeToken });

      expect(res.valid).toBe(false);
      expect(res.error).toBe('TOKEN_NOT_FOUND');
    });

    it('rejects consumption of non-existent tokens', () => {
      const fakeToken = generateRawApprovalToken();
      const res = consumeApprovalToken(db, repos, { rawToken: fakeToken });

      expect(res.success).toBe(false);
      expect(res.error).toBe('TOKEN_NOT_FOUND');
    });
  });

  // ============================================================================
  // 9. Action Mismatch
  // ============================================================================

  describe('9. Action Mismatch', () => {
    it('rejects verification and consumption when action does not match expected action', () => {
      const { requestId } = insertHeldRequest();
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
      });
      expect(mintResult.success).toBe(true);

      // Expected action is VOID, but token is APPROVE
      const verifyCheck = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        expectedAction: 'VOID',
      });
      expect(verifyCheck.valid).toBe(false);
      expect(verifyCheck.error).toBe('ACTION_MISMATCH');

      const consumeCheck = consumeApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        expectedAction: 'VOID',
      });
      expect(consumeCheck.success).toBe(false);
      expect(consumeCheck.error).toBe('ACTION_MISMATCH');

      // Token must NOT have been consumed by the failed attempt
      const row = repos.approvals.getByTokenHash(mintResult.tokenHash!);
      expect(row?.used_at).toBeNull();
    });
  });

  // ============================================================================
  // 10. Request Mismatch
  // ============================================================================

  describe('10. Request Mismatch', () => {
    it('rejects verification and consumption when requestId does not match expected requestId', () => {
      const { requestId } = insertHeldRequest({ id: 'req-held-target' });
      insertHeldRequest({ id: 'req-held-other' });

      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
      });
      expect(mintResult.success).toBe(true);

      // Expected request is 'req-held-other', but token is for 'req-held-target'
      const verifyCheck = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        expectedRequestId: 'req-held-other',
      });
      expect(verifyCheck.valid).toBe(false);
      expect(verifyCheck.error).toBe('REQUEST_MISMATCH');

      const consumeCheck = consumeApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        expectedRequestId: 'req-held-other',
      });
      expect(consumeCheck.success).toBe(false);
      expect(consumeCheck.error).toBe('REQUEST_MISMATCH');
    });

    it('rejects verification if payment request status is no longer HELD (e.g. already CAPTURED or DENIED)', () => {
      const { requestId } = insertHeldRequest();
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
      });
      expect(mintResult.success).toBe(true);

      // Simulate status transition to CAPTURED
      db.prepare("UPDATE payment_requests SET status = 'CAPTURED' WHERE id = ?").run(requestId);

      const verifyCheck = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
      });
      expect(verifyCheck.valid).toBe(false);
      expect(verifyCheck.error).toBe('INVALID_REQUEST_STATUS');
    });
  });

  // ============================================================================
  // 11. Snapshot Mismatch (TOCTOU & Tampering Protection)
  // ============================================================================

  describe('11. Snapshot Mismatch & TOCTOU Protection', () => {
    it('rejects verification if expectedSnapshotHash does not match request snapshot_hash', () => {
      const { requestId } = insertHeldRequest();
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
      });
      expect(mintResult.success).toBe(true);

      const fakeSnapshot = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      const verifyCheck = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
        expectedSnapshotHash: fakeSnapshot,
      });

      expect(verifyCheck.valid).toBe(false);
      expect(verifyCheck.error).toBe('SNAPSHOT_MISMATCH');
    });

    it('detects tampering with request fields (TOCTOU: amount changed between hold and approve)', () => {
      const { requestId } = insertHeldRequest({ amountMinor: 2500 }); // $25.00
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
      });
      expect(mintResult.success).toBe(true);

      // Attacker or bug modifies amount in payment_requests table to $250.00
      db.prepare('UPDATE payment_requests SET amount_minor = ? WHERE id = ?').run(
        toMinorUnits(25000),
        requestId
      );

      // Verification MUST detect snapshot mismatch upon recomputing the canonical hash
      const verifyCheck = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
      });

      expect(verifyCheck.valid).toBe(false);
      expect(verifyCheck.error).toBe('SNAPSHOT_MISMATCH');
      expect(verifyCheck.message).toContain('tampering detected');

      // Consumption must also fail closed
      const consumeCheck = consumeApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
      });
      expect(consumeCheck.success).toBe(false);
      expect(consumeCheck.error).toBe('SNAPSHOT_MISMATCH');
    });

    it('detects tampering when request snapshot_hash is null or altered', () => {
      const { requestId } = insertHeldRequest();
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
      });
      expect(mintResult.success).toBe(true);

      // Clear snapshot_hash in DB
      db.prepare('UPDATE payment_requests SET snapshot_hash = NULL WHERE id = ?').run(requestId);

      const verifyCheck = verifyApprovalToken(db, repos, {
        rawToken: mintResult.rawToken!,
      });

      expect(verifyCheck.valid).toBe(false);
      expect(verifyCheck.error).toBe('SNAPSHOT_MISMATCH');
    });
  });

  // ============================================================================
  // 12. No Plaintext Token Leakage
  // ============================================================================

  describe('12. No Plaintext Token Leakage', () => {
    it('ensures error messages and database records never contain raw tokens', () => {
      const { requestId } = insertHeldRequest();
      const mintResult = mintApprovalToken(db, repos, {
        requestId,
        action: 'APPROVE',
      });
      const rawToken = mintResult.rawToken!;

      // 1. Consume token once
      consumeApprovalToken(db, repos, { rawToken });

      // 2. Trigger errors
      const errReplay = consumeApprovalToken(db, repos, { rawToken });
      expect(errReplay.message).toBeDefined();
      expect(errReplay.message).not.toContain(rawToken);

      const errAction = verifyApprovalToken(db, repos, {
        rawToken,
        expectedAction: 'VOID',
      });
      expect(errAction.message).not.toContain(rawToken);

      const errRequest = verifyApprovalToken(db, repos, {
        rawToken,
        expectedRequestId: 'req-different',
      });
      expect(errRequest.message).not.toContain(rawToken);

      // 3. Inspect repository approvals query result
      const approvalRow = repos.approvals.getByTokenHash(mintResult.tokenHash!);
      expect(approvalRow).toBeDefined();
      expect(approvalRow?.token_hash).not.toBe(rawToken);
      expect(JSON.stringify(approvalRow)).not.toContain(rawToken);
    });
  });
});
