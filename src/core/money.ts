/**
 * PayGuard — Milestone M1: Core Brain
 * M1-T3: Integer Minor-Unit Money Module
 *
 * Implements strict integer minor-unit money handling per PAYGUARD_PLAN.md.
 * Invariant I4: Money is represented strictly as integer minor units (cents).
 * Conversion to/from decimal strings occurs only at boundaries.
 * Zero floating-point arithmetic is used for financial amounts.
 */

declare const MinorUnitsBrand: unique symbol;

/**
 * Branded type representing monetary values in integer minor units (e.g. cents).
 * Prevents accidental mixing of raw numbers or floating-point decimals with minor units.
 */
export type MinorUnits = number & { readonly [MinorUnitsBrand]: true };

export type MoneyErrorCode =
  | 'INVALID_AMOUNT_FORMAT'
  | 'NON_POSITIVE_AMOUNT'
  | 'AMOUNT_TOO_LARGE'
  | 'INVALID_MINOR_UNITS'
  | 'INVALID_CURRENCY';

export class MoneyError extends Error {
  public readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'MoneyError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Strict regex matching decimal amounts per PAYGUARD_PLAN.md line 486:
 * Up to 7 digits before the decimal, and optionally 1 or 2 digits after the decimal.
 * Maximum valid decimal string: 9999999.99 ($9,999,999.99).
 */
export const AMOUNT_DECIMAL_REGEX = /^\d{1,7}(\.\d{1,2})?$/;

/**
 * Maximum permitted minor-unit amount: 999,999,999 cents ($9,999,999.99).
 */
export const MAX_MINOR_UNITS = 999_999_999 as MinorUnits;

/**
 * Minimum permitted payment amount in minor units: 1 cent ($0.01).
 * Payments must be strictly positive.
 */
export const MIN_PAYMENT_MINOR_UNITS = 1 as MinorUnits;

/**
 * Currency code regex: 3 uppercase ASCII letters per PAYGUARD_PLAN.md line 486.
 */
export const CURRENCY_CODE_REGEX = /^[A-Z]{3}$/;

/**
 * Type guard and runtime assertion that casts a safe integer to MinorUnits.
 * Permitted range: 0 <= value <= MAX_MINOR_UNITS.
 */
export function toMinorUnits(value: number): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(
      'INVALID_MINOR_UNITS',
      `Minor units must be a safe integer, received: ${value}`
    );
  }

  if (value < 0 || value > MAX_MINOR_UNITS) {
    throw new MoneyError(
      'INVALID_MINOR_UNITS',
      `Minor units must be between 0 and ${MAX_MINOR_UNITS}, received: ${value}`
    );
  }

  return value as MinorUnits;
}

/**
 * Parses an untrusted decimal amount string into integer minor units.
 *
 * Rules:
 * - Must strictly match ^\d{1,7}(\.\d{1,2})?$.
 * - Rejects signs (+, -), spaces, scientific notation (1e3), non-ASCII digits, extra decimals.
 * - Parses major and minor parts using integer arithmetic (never parseFloat or multiplication).
 * - Enforces positive payment amount (> 0). Zero and negative amounts are rejected.
 * - Maximum permitted amount is 9999999.99 (999,999,999 minor units).
 */
export function parseDecimalToMinorUnits(amount: string): MinorUnits {
  if (typeof amount !== 'string') {
    throw new MoneyError(
      'INVALID_AMOUNT_FORMAT',
      `Amount must be a string, received ${typeof amount}`
    );
  }

  if (!AMOUNT_DECIMAL_REGEX.test(amount)) {
    throw new MoneyError(
      'INVALID_AMOUNT_FORMAT',
      `Amount "${amount}" is invalid. Must match pattern ^\\d{1,7}(\\.\\d{1,2})?$`
    );
  }

  const dotIndex = amount.indexOf('.');
  let majorPart: string;
  let minorValue = 0;

  if (dotIndex === -1) {
    majorPart = amount;
  } else {
    majorPart = amount.slice(0, dotIndex);
    const fractionPart = amount.slice(dotIndex + 1);
    if (fractionPart.length === 1) {
      minorValue = parseInt(fractionPart, 10) * 10;
    } else if (fractionPart.length === 2) {
      minorValue = parseInt(fractionPart, 10);
    }
  }

  const majorValue = parseInt(majorPart, 10);
  const totalMinor = majorValue * 100 + minorValue;

  if (totalMinor <= 0) {
    throw new MoneyError(
      'NON_POSITIVE_AMOUNT',
      `Payment amount must be greater than zero, received: "${amount}"`
    );
  }

  if (totalMinor > MAX_MINOR_UNITS) {
    throw new MoneyError(
      'AMOUNT_TOO_LARGE',
      `Payment amount exceeds maximum permitted amount of 9999999.99: "${amount}"`
    );
  }

  return totalMinor as MinorUnits;
}

/**
 * Formats a valid minor-unit value to a standard 2-decimal string (e.g. 1200 -> "12.00").
 * Used at the PayPal API and UI display boundaries.
 *
 * Supports valid non-negative minor units in the specification's range (0 to 999,999,999).
 * Zero minor units formats to "0.00" (e.g. for zero balances or budgets).
 */
export function formatMinorUnitsToDecimal(minorUnits: MinorUnits | number): string {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MoneyError(
      'INVALID_MINOR_UNITS',
      `Minor units must be a safe integer, received: ${minorUnits}`
    );
  }

  if (minorUnits < 0 || minorUnits > MAX_MINOR_UNITS) {
    throw new MoneyError(
      'INVALID_MINOR_UNITS',
      `Minor units must be between 0 and ${MAX_MINOR_UNITS}, received: ${minorUnits}`
    );
  }

  const major = Math.floor(minorUnits / 100);
  const minor = minorUnits % 100;
  return `${major}.${minor.toString().padStart(2, '0')}`;
}

/**
 * Non-throwing validator returning whether a value is a valid payment decimal string.
 */
export function isValidDecimalAmount(amount: unknown): boolean {
  if (typeof amount !== 'string' || !AMOUNT_DECIMAL_REGEX.test(amount)) {
    return false;
  }

  const dotIndex = amount.indexOf('.');
  const majorPart = dotIndex === -1 ? amount : amount.slice(0, dotIndex);
  let minorPart = 0;

  if (dotIndex !== -1) {
    const fraction = amount.slice(dotIndex + 1);
    minorPart = fraction.length === 1 ? parseInt(fraction, 10) * 10 : parseInt(fraction, 10);
  }

  const total = parseInt(majorPart, 10) * 100 + minorPart;
  return total > 0 && total <= MAX_MINOR_UNITS;
}

/**
 * Validates whether a currency code is a valid 3-letter uppercase ASCII code.
 */
export function isValidCurrency(currency: unknown): currency is string {
  return typeof currency === 'string' && CURRENCY_CODE_REGEX.test(currency);
}

/**
 * Asserts that a currency string is valid, or throws a MoneyError.
 */
export function validateCurrency(currency: unknown): string {
  if (!isValidCurrency(currency)) {
    throw new MoneyError(
      'INVALID_CURRENCY',
      `Currency must be a 3-letter uppercase ASCII string (e.g. USD), received: ${String(currency)}`
    );
  }
  return currency;
}

/**
 * Safe integer addition for minor units with overflow check.
 */
export function addMinorUnits(a: MinorUnits, b: MinorUnits): MinorUnits {
  const sum = a + b;
  if (!Number.isSafeInteger(sum) || sum > MAX_MINOR_UNITS) {
    throw new MoneyError(
      'AMOUNT_TOO_LARGE',
      `Sum of minor units (${sum}) exceeds maximum range (${MAX_MINOR_UNITS})`
    );
  }
  return sum as MinorUnits;
}

/**
 * Safe integer subtraction for minor units. Throws if result is negative.
 */
export function subtractMinorUnits(a: MinorUnits, b: MinorUnits): MinorUnits {
  const diff = a - b;
  if (!Number.isSafeInteger(diff) || diff < 0) {
    throw new MoneyError(
      'INVALID_MINOR_UNITS',
      `Subtraction resulted in negative minor units: ${diff}`
    );
  }
  return diff as MinorUnits;
}
