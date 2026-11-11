/**
 * PayGuard — Milestone M6: Full-System QA & Reliability
 * M6-T3.3: Telegram Markup Encryption & Canonical AAD Contract (PGA1)
 *
 * Implements:
 * - AES-256-GCM authenticated encryption for Telegram inline keyboard markup.
 * - Canonical binary AAD contract (PGA1 magic header with length-prefixed fields).
 * - Cryptographic binding to outbox_id, owner_id, request_id, recipient_chat_id, and linked_at.
 * - Key rotation support (primary key with fallback to previous key).
 * - Safe fail-closed handling on tampering, missing keys, or corrupted envelopes.
 *
 * Invariants:
 * - Hard Rule 2: Never log or persist plaintext markup or raw callback tokens.
 * - Hard Rule 8: Fail closed on any decryption error, tag mismatch, or AAD mismatch.
 */

import * as crypto from 'node:crypto';
import type { TelegramInlineKeyboardMarkup } from './types.js';

export const PGA1_MAGIC_HEADER = Buffer.from('PGA1', 'utf8'); // 0x50, 0x47, 0x41, 0x31
export const GCM_IV_LENGTH_BYTES = 12;
export const GCM_TAG_LENGTH_BYTES = 16;
export const KEY_LENGTH_BYTES = 32;

export interface EncryptedMarkupEnvelope {
  readonly v: 1;
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

export interface TelegramMarkupAadParams {
  readonly outboxId: string;
  readonly ownerId: string;
  readonly requestId: string;
  readonly recipientChatId: string;
  readonly linkedAt: string;
}

export class TelegramCryptoError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(`[TelegramCryptoError] ${code}: ${message}`);
    this.name = 'TelegramCryptoError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Encodes a string field into length-prefixed NFC-normalized UTF-8 bytes.
 * [2-byte big-endian unsigned length] + [UTF-8 bytes]
 */
function encodeLengthPrefixedField(value: string | null | undefined): Buffer {
  const normalized = (value ?? '').normalize('NFC');
  const strBuf = Buffer.from(normalized, 'utf8');
  if (strBuf.length > 65535) {
    throw new TelegramCryptoError(
      'AAD_FIELD_TOO_LONG',
      'AAD field exceeds maximum 16-bit unsigned integer length'
    );
  }
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(strBuf.length, 0);
  return Buffer.concat([lenBuf, strBuf]);
}

/**
 * Constructs the canonical binary PGA1 AAD buffer.
 * Layout:
 * [PGA1 magic header (4 bytes)]
 * [len(2) + outbox_id]
 * [len(2) + owner_id]
 * [len(2) + request_id]
 * [len(2) + recipient_chat_id]
 * [len(2) + linked_at]
 */
export function buildTelegramMarkupAad(params: TelegramMarkupAadParams): Buffer {
  return Buffer.concat([
    PGA1_MAGIC_HEADER,
    encodeLengthPrefixedField(params.outboxId),
    encodeLengthPrefixedField(params.ownerId),
    encodeLengthPrefixedField(params.requestId),
    encodeLengthPrefixedField(params.recipientChatId),
    encodeLengthPrefixedField(params.linkedAt),
  ]);
}

/**
 * Validates and converts a 64-character hex key string into a 32-byte key Buffer.
 */
function parseKeyHex(keyHex: string, paramName: string): Buffer {
  if (typeof keyHex !== 'string') {
    throw new TelegramCryptoError('INVALID_KEY', `${paramName} must be a string`);
  }
  const clean = keyHex.trim();
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new TelegramCryptoError(
      'INVALID_KEY_FORMAT',
      `${paramName} must be a 64-character hexadecimal string (32 bytes)`
    );
  }
  return Buffer.from(clean, 'hex');
}

/**
 * Encrypts Telegram inline keyboard markup using AES-256-GCM and PGA1 AAD.
 *
 * @returns JSON string of EncryptedMarkupEnvelope
 */
export function encryptReplyMarkup(
  markup: TelegramInlineKeyboardMarkup,
  aadParams: TelegramMarkupAadParams,
  primaryKeyHex: string
): string {
  const key = parseKeyHex(primaryKeyHex, 'TELEGRAM_ENCRYPTION_KEY');
  const iv = crypto.randomBytes(GCM_IV_LENGTH_BYTES);
  const aad = buildTelegramMarkupAad(aadParams);

  const plaintext = JSON.stringify(markup);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope: EncryptedMarkupEnvelope = {
    v: 1,
    iv: iv.toString('hex'),
    ct: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  };

  return JSON.stringify(envelope);
}

/**
 * Internal helper to attempt AES-256-GCM decryption with a single key.
 */
function attemptDecryption(
  envelope: EncryptedMarkupEnvelope,
  aad: Buffer,
  key: Buffer
): TelegramInlineKeyboardMarkup {
  const iv = Buffer.from(envelope.iv, 'hex');
  if (iv.length !== GCM_IV_LENGTH_BYTES) {
    throw new TelegramCryptoError('INVALID_IV_LENGTH', `IV must be ${GCM_IV_LENGTH_BYTES} bytes`);
  }
  const tag = Buffer.from(envelope.tag, 'hex');
  if (tag.length !== GCM_TAG_LENGTH_BYTES) {
    throw new TelegramCryptoError('INVALID_TAG_LENGTH', `Tag must be ${GCM_TAG_LENGTH_BYTES} bytes`);
  }
  const ciphertext = Buffer.from(envelope.ct, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const decryptedBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(decryptedBytes.toString('utf8')) as TelegramInlineKeyboardMarkup;

  if (!parsed || !Array.isArray(parsed.inline_keyboard)) {
    throw new TelegramCryptoError('MALFORMED_MARKUP', 'Decrypted payload is not a valid inline keyboard');
  }

  return parsed;
}

/**
 * Decrypts and authenticates Telegram inline keyboard markup using AES-256-GCM and PGA1 AAD.
 * Attempts primaryKeyHex first; if tag verification fails and previousKeyHex is provided, attempts fallback.
 */
export function decryptReplyMarkup(
  envelopeJson: string,
  aadParams: TelegramMarkupAadParams,
  primaryKeyHex: string,
  previousKeyHex?: string
): TelegramInlineKeyboardMarkup {
  if (!envelopeJson || typeof envelopeJson !== 'string') {
    throw new TelegramCryptoError('EMPTY_ENVELOPE', 'Encrypted markup envelope must be a non-empty string');
  }

  let envelope: EncryptedMarkupEnvelope;
  try {
    envelope = JSON.parse(envelopeJson) as EncryptedMarkupEnvelope;
  } catch {
    throw new TelegramCryptoError('MALFORMED_JSON', 'Failed to parse encrypted markup envelope JSON');
  }

  if (envelope.v !== 1 || !envelope.iv || !envelope.ct || !envelope.tag) {
    throw new TelegramCryptoError('INVALID_ENVELOPE_SCHEMA', 'Invalid encrypted markup envelope format');
  }

  const primaryKey = parseKeyHex(primaryKeyHex, 'TELEGRAM_ENCRYPTION_KEY');
  const aad = buildTelegramMarkupAad(aadParams);

  try {
    return attemptDecryption(envelope, aad, primaryKey);
  } catch (primaryErr: unknown) {
    // If primary decryption failed and a previous key is configured, attempt key rotation fallback
    if (previousKeyHex && typeof previousKeyHex === 'string' && previousKeyHex.trim().length > 0) {
      try {
        const previousKey = parseKeyHex(previousKeyHex, 'TELEGRAM_PREVIOUS_ENCRYPTION_KEY');
        return attemptDecryption(envelope, aad, previousKey);
      } catch {
        // Fallback also failed; throw authoritative authentication failure
        throw new TelegramCryptoError(
          'DECRYPTION_FAILED',
          'Authentication failed for both primary and previous encryption keys (tamper detected or invalid key)'
        );
      }
    }

    if (primaryErr instanceof TelegramCryptoError) {
      throw primaryErr;
    }
    throw new TelegramCryptoError(
      'DECRYPTION_FAILED',
      `Decryption authentication failed: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`
    );
  }
}

