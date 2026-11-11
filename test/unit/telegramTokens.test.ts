/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * Unit Tests: Telegram Link Tokens (M6-T3-A)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, runMigrations } from '../../src/db/index.js';
import type { Database } from '../../src/db/index.js';
import { createRepositories } from '../../src/db/repositories.js';
import type { Repositories } from '../../src/db/repositories.js';
import {
  generateRawTelegramLinkToken,
  hashTelegramLinkToken,
  isValidTelegramLinkTokenFormat,
  mintTelegramLinkToken,
  verifyTelegramLinkToken,
  consumeTelegramLinkToken,
  DEFAULT_TELEGRAM_LINK_TTL_SECONDS,
} from '../../src/telegram/tokens.js';

describe('Telegram Link Tokens', () => {
  let db: Database;
  let repos: Repositories;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repos = createRepositories(db);

    // Insert initial owner row
    repos.owners.upsert({
      id: 'default',
      display_name: 'Test Owner',
      passphrase_hash: 'test_hash',
      telegram_chat_id: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('Token Generation, Hashing & Formatting', () => {
    it('generates a 43-character base64url random token', () => {
      const token1 = generateRawTelegramLinkToken();
      const token2 = generateRawTelegramLinkToken();

      expect(typeof token1).toBe('string');
      expect(token1.length).toBe(43);
      expect(token1).not.toBe(token2);
      expect(isValidTelegramLinkTokenFormat(token1)).toBe(true);
      expect(isValidTelegramLinkTokenFormat(token2)).toBe(true);
    });

    it('computes deterministic 64-char hex SHA-256 digest', () => {
      const raw = 'test-token-12345678901234567890123456789012';
      const hash1 = hashTelegramLinkToken(raw);
      const hash2 = hashTelegramLinkToken(raw);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('validates token format strictly', () => {
      expect(isValidTelegramLinkTokenFormat('validTokenWithFortyThreeCharactersLength123')).toBe(true);
      expect(isValidTelegramLinkTokenFormat('too-short')).toBe(false);
      expect(isValidTelegramLinkTokenFormat('has+invalid/characters=padding43charactersLong')).toBe(false);
      expect(isValidTelegramLinkTokenFormat('')).toBe(false);
      // @ts-expect-error Testing invalid runtime input
      expect(isValidTelegramLinkTokenFormat(null)).toBe(false);
      // @ts-expect-error Testing invalid runtime input
      expect(isValidTelegramLinkTokenFormat(undefined)).toBe(false);
    });
  });

  describe('mintTelegramLinkToken', () => {
    it('mints token for valid owner with default 10-minute TTL', () => {
      const now = new Date('2026-11-02T12:00:00Z');
      const result = mintTelegramLinkToken(db, repos, { now });

      expect(result.success).toBe(true);
      expect(result.id).toMatch(/^tlt-/);
      expect(result.rawToken).toBeDefined();
      expect(result.rawToken?.length).toBe(43);
      expect(result.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.ownerId).toBe('default');
      expect(result.expiresAt).toBe(
        new Date(now.getTime() + DEFAULT_TELEGRAM_LINK_TTL_SECONDS * 1000).toISOString()
      );

      // Verify DB record: raw token is NEVER persisted, only hash
      const row = repos.telegramLinkTokens.getByTokenHash(result.tokenHash!);
      expect(row).toBeDefined();
      expect(row?.id).toBe(result.id);
      expect(row?.owner_id).toBe('default');
      expect(row?.token_hash).toBe(result.tokenHash);
      expect(row?.used_at).toBeNull();
      expect(row?.expires_at).toBe(result.expiresAt);

      // Direct query check to ensure raw token does not exist in DB
      const dbAll = db.prepare('SELECT * FROM telegram_link_tokens WHERE id = ?').get(result.id) as Record<string, unknown>;
      expect(JSON.stringify(dbAll)).not.toContain(result.rawToken!);
    });

    it('supports custom ttlSeconds', () => {
      const now = new Date('2026-11-02T12:00:00Z');
      const result = mintTelegramLinkToken(db, repos, {
        ttlSeconds: 300,
        now,
      });

      expect(result.success).toBe(true);
      expect(result.expiresAt).toBe(new Date(now.getTime() + 300 * 1000).toISOString());
    });

    it('fails when owner row does not exist', () => {
      // Clear owners table
      db.prepare('DELETE FROM owners').run();

      const result = mintTelegramLinkToken(db, repos);
      expect(result.success).toBe(false);
      expect(result.error).toBe('OWNER_NOT_FOUND');
    });
  });

  describe('verifyTelegramLinkToken', () => {
    it('returns valid for a freshly minted token', () => {
      const minted = mintTelegramLinkToken(db, repos);
      expect(minted.success).toBe(true);

      const verification = verifyTelegramLinkToken(db, repos, minted.rawToken!);
      expect(verification.valid).toBe(true);
      expect(verification.tokenRow).toBeDefined();
      expect(verification.tokenRow?.token_hash).toBe(minted.tokenHash);
    });

    it('rejects malformed token strings with INVALID_TOKEN_FORMAT', () => {
      const verification = verifyTelegramLinkToken(db, repos, 'too-short');
      expect(verification.valid).toBe(false);
      expect(verification.error).toBe('INVALID_TOKEN_FORMAT');
    });

    it('rejects unknown token with TOKEN_NOT_FOUND', () => {
      const fakeToken = generateRawTelegramLinkToken();
      const verification = verifyTelegramLinkToken(db, repos, fakeToken);
      expect(verification.valid).toBe(false);
      expect(verification.error).toBe('TOKEN_NOT_FOUND');
    });

    it('rejects expired token with TOKEN_EXPIRED', () => {
      const now = new Date('2026-11-02T12:00:00Z');
      const minted = mintTelegramLinkToken(db, repos, {
        ttlSeconds: 60,
        now,
      });

      const verification = verifyTelegramLinkToken(
        db,
        repos,
        minted.rawToken!,
        new Date('2026-11-02T12:01:01Z') // 61 seconds later
      );
      expect(verification.valid).toBe(false);
      expect(verification.error).toBe('TOKEN_EXPIRED');
    });

    it('rejects already used token with TOKEN_ALREADY_USED', () => {
      const minted = mintTelegramLinkToken(db, repos);
      repos.telegramLinkTokens.consume(minted.tokenHash!, new Date().toISOString());

      const verification = verifyTelegramLinkToken(db, repos, minted.rawToken!);
      expect(verification.valid).toBe(false);
      expect(verification.error).toBe('TOKEN_ALREADY_USED');
    });
  });

  describe('consumeTelegramLinkToken', () => {
    it('atomically consumes token, updates owner, and writes audit log', () => {
      const now = new Date('2026-11-02T12:00:00Z');
      const minted = mintTelegramLinkToken(db, repos, { now });
      expect(minted.success).toBe(true);

      const consumeResult = consumeTelegramLinkToken(db, repos, {
        rawToken: minted.rawToken!,
        chatId: 987654321,
        username: '@alice_owner',
        now: new Date('2026-11-02T12:02:00Z'),
      });

      expect(consumeResult.success).toBe(true);
      expect(consumeResult.ownerId).toBe('default');
      expect(consumeResult.chatId).toBe('987654321');
      expect(consumeResult.username).toBe('alice_owner'); // @ stripped

      // Check token record in DB: used_at is updated
      const tokenInDb = repos.telegramLinkTokens.getByTokenHash(minted.tokenHash!);
      expect(tokenInDb?.used_at).toBe('2026-11-02T12:02:00.000Z');

      // Check owner record: telegram fields updated
      const updatedOwner = repos.owners.get();
      expect(updatedOwner?.telegram_chat_id).toBe('987654321');
      expect(updatedOwner?.telegram_username).toBe('alice_owner');
      expect(updatedOwner?.telegram_linked_at).toBe('2026-11-02T12:02:00.000Z');

      // Check audit log
      const auditEntries = repos.auditLog.list();
      const linkEntry = auditEntries.find((e) => e.event === 'TELEGRAM_ACCOUNT_LINKED');
      expect(linkEntry).toBeDefined();
      expect(linkEntry?.actor).toBe('owner');

      const payload = JSON.parse(linkEntry!.payload);
      expect(payload).toEqual({
        owner_id: 'default',
        chat_id: '987654321',
        username: 'alice_owner',
        link_token_id: minted.id,
      });
    });

    it('enforces single-use CAS: replay attack fails with TOKEN_ALREADY_USED', () => {
      const minted = mintTelegramLinkToken(db, repos);

      const firstConsume = consumeTelegramLinkToken(db, repos, {
        rawToken: minted.rawToken!,
        chatId: 11111,
        username: 'first_user',
      });
      expect(firstConsume.success).toBe(true);

      // Second consume attempt with same token
      const secondConsume = consumeTelegramLinkToken(db, repos, {
        rawToken: minted.rawToken!,
        chatId: 22222,
        username: 'attacker',
      });
      expect(secondConsume.success).toBe(false);
      expect(secondConsume.error).toBe('TOKEN_ALREADY_USED');

      // Verify owner was NOT overwritten by second user
      const owner = repos.owners.get();
      expect(owner?.telegram_chat_id).toBe('11111');
      expect(owner?.telegram_username).toBe('first_user');
    });

    it('fails to consume expired token', () => {
      const now = new Date('2026-11-02T12:00:00Z');
      const minted = mintTelegramLinkToken(db, repos, { ttlSeconds: 60, now });

      const consumeResult = consumeTelegramLinkToken(db, repos, {
        rawToken: minted.rawToken!,
        chatId: 12345,
        now: new Date('2026-11-02T12:02:00Z'), // expired by 1 minute
      });

      expect(consumeResult.success).toBe(false);
      expect(consumeResult.error).toBe('TOKEN_EXPIRED');

      // Verify owner is still unlinked
      const owner = repos.owners.get();
      expect(owner?.telegram_chat_id).toBeNull();
    });

    it('fails to consume non-existent token', () => {
      const fakeToken = generateRawTelegramLinkToken();
      const consumeResult = consumeTelegramLinkToken(db, repos, {
        rawToken: fakeToken,
        chatId: 12345,
      });

      expect(consumeResult.success).toBe(false);
      expect(consumeResult.error).toBe('TOKEN_NOT_FOUND');
    });

    it('persists telegram_user_id when userId is provided and includes it in audit log', () => {
      const now = new Date('2026-11-02T12:00:00Z');
      const minted = mintTelegramLinkToken(db, repos, { now });

      const consumeResult = consumeTelegramLinkToken(db, repos, {
        rawToken: minted.rawToken!,
        chatId: 987654321,
        userId: 123456789,
        username: 'alice_tg',
        now: new Date('2026-11-02T12:01:00Z'),
      });

      expect(consumeResult.success).toBe(true);
      expect(consumeResult.chatId).toBe('987654321');
      expect(consumeResult.userId).toBe('123456789');

      const updatedOwner = repos.owners.get('default');
      expect(updatedOwner?.telegram_chat_id).toBe('987654321');
      expect(updatedOwner?.telegram_user_id).toBe('123456789');

      const auditEntry = repos.auditLog.list().find((e) => e.event === 'TELEGRAM_ACCOUNT_LINKED');
      expect(auditEntry).toBeDefined();
      expect(JSON.parse(auditEntry!.payload)).toEqual({
        owner_id: 'default',
        chat_id: '987654321',
        telegram_user_id: '123456789',
        username: 'alice_tg',
        link_token_id: minted.id,
      });
    });

    it('rejects non-positive or invalid userId with INVALID_CALLER_IDENTITY without consuming token', () => {
      const minted = mintTelegramLinkToken(db, repos);

      for (const badUserId of [0, -5, 'not-numeric', '']) {
        const res = consumeTelegramLinkToken(db, repos, {
          rawToken: minted.rawToken!,
          chatId: 987654321,
          userId: badUserId,
        });
        expect(res.success).toBe(false);
        expect(res.error).toBe('INVALID_CALLER_IDENTITY');
      }

      const tokenRow = repos.telegramLinkTokens.getByTokenHash(minted.tokenHash!);
      expect(tokenRow?.used_at).toBeNull();
      expect(repos.owners.get('default')?.telegram_user_id).toBeNull();
    });

    it('rejects CONFLICTING_OWNERSHIP when owner is already bound to a different telegram_user_id', () => {
      repos.owners.linkTelegram({
        ownerId: 'default',
        chatId: '987654321',
        userId: '111111',
        username: 'alice',
        linkedAtIso: new Date().toISOString(),
      });

      const minted = mintTelegramLinkToken(db, repos);
      const res = consumeTelegramLinkToken(db, repos, {
        rawToken: minted.rawToken!,
        chatId: 987654321,
        userId: 222222,
        username: 'impostor',
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe('CONFLICTING_OWNERSHIP');
      expect(repos.owners.get('default')?.telegram_user_id).toBe('111111');
    });

    it('rejects CHAT_ALREADY_BOUND when telegram_user_id is already linked to another owner', () => {
      const getByUserSpy = vi.spyOn(repos.owners, 'getByTelegramUserId').mockReturnValueOnce({
        id: 'owner-two',
        display_name: 'Second Owner',
        passphrase_hash: 'hash-two',
        telegram_chat_id: '555000111',
        telegram_user_id: '444999',
        telegram_username: 'shared_user',
        telegram_linked_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });

      const minted = mintTelegramLinkToken(db, repos, { ownerId: 'default' });
      const res = consumeTelegramLinkToken(db, repos, {
        rawToken: minted.rawToken!,
        chatId: 999888777,
        userId: 444999,
        username: 'shared_user',
      });

      expect(res.success).toBe(false);
      expect(res.error).toBe('CHAT_ALREADY_BOUND');
      expect(repos.owners.get('default')?.telegram_user_id).toBeNull();
      getByUserSpy.mockRestore();
    });
  });
});
