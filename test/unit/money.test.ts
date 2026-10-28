import { describe, it, expect } from 'vitest';
import {
  parseDecimalToMinorUnits,
  formatMinorUnitsToDecimal,
  toMinorUnits,
  isValidDecimalAmount,
  isValidCurrency,
  validateCurrency,
  addMinorUnits,
  subtractMinorUnits,
  MoneyError,
  MAX_MINOR_UNITS,
  MIN_PAYMENT_MINOR_UNITS,
  type MinorUnits,
} from '../../src/core/money.js';

describe('Integer Minor-Unit Money Module (M1-T3)', () => {
  describe('parseDecimalToMinorUnits — Valid Cases', () => {
    it('should parse canonical examples from PAYGUARD_PLAN.md Section 18', () => {
      expect(parseDecimalToMinorUnits('12')).toBe(1200);
      expect(parseDecimalToMinorUnits('12.5')).toBe(1250);
      expect(parseDecimalToMinorUnits('12.50')).toBe(1250);
    });

    it('should parse minimum permitted positive payment amounts', () => {
      expect(parseDecimalToMinorUnits('0.01')).toBe(1);
      expect(parseDecimalToMinorUnits('0.1')).toBe(10);
      expect(parseDecimalToMinorUnits('0.10')).toBe(10);
      expect(parseDecimalToMinorUnits('1.00')).toBe(100);
      expect(parseDecimalToMinorUnits('1')).toBe(100);
    });

    it('should parse whole numbers without decimal places', () => {
      expect(parseDecimalToMinorUnits('1')).toBe(100);
      expect(parseDecimalToMinorUnits('50')).toBe(5000);
      expect(parseDecimalToMinorUnits('100')).toBe(10000);
      expect(parseDecimalToMinorUnits('9999999')).toBe(999999900);
    });

    it('should parse single-decimal amounts correctly', () => {
      expect(parseDecimalToMinorUnits('0.5')).toBe(50);
      expect(parseDecimalToMinorUnits('10.5')).toBe(1050);
      expect(parseDecimalToMinorUnits('99.9')).toBe(9990);
    });

    it('should parse small cent values with leading zero in decimal part', () => {
      expect(parseDecimalToMinorUnits('0.05')).toBe(5);
      expect(parseDecimalToMinorUnits('1.05')).toBe(105);
      expect(parseDecimalToMinorUnits('12.09')).toBe(1209);
    });

    it('should parse the maximum permitted amount (9,999,999.99)', () => {
      expect(parseDecimalToMinorUnits('9999999.99')).toBe(999999999);
      expect(parseDecimalToMinorUnits('9999999.99')).toBe(MAX_MINOR_UNITS);
    });

    it('should avoid IEEE 754 floating-point traps', () => {
      // In JavaScript floating-point: 19.99 * 100 === 1998.9999999999998
      // Math.floor(19.99 * 100) === 1998 (1 cent loss)
      expect(parseDecimalToMinorUnits('19.99')).toBe(1999);
      expect(parseDecimalToMinorUnits('29.99')).toBe(2999);
      expect(parseDecimalToMinorUnits('59.99')).toBe(5999);
      expect(parseDecimalToMinorUnits('0.07')).toBe(7);
      expect(parseDecimalToMinorUnits('0.29')).toBe(29);
      expect(parseDecimalToMinorUnits('4.10')).toBe(410);
      expect(parseDecimalToMinorUnits('1.14')).toBe(114);
    });
  });

  describe('parseDecimalToMinorUnits — Zero and Negative Rejections', () => {
    it('should reject zero payment amounts as NON_POSITIVE_AMOUNT', () => {
      expect(() => parseDecimalToMinorUnits('0')).toThrow(MoneyError);
      expect(() => parseDecimalToMinorUnits('0')).toThrowError(/NON_POSITIVE_AMOUNT/);

      expect(() => parseDecimalToMinorUnits('0.0')).toThrow(MoneyError);
      expect(() => parseDecimalToMinorUnits('0.0')).toThrowError(/NON_POSITIVE_AMOUNT/);

      expect(() => parseDecimalToMinorUnits('0.00')).toThrow(MoneyError);
      expect(() => parseDecimalToMinorUnits('0.00')).toThrowError(/NON_POSITIVE_AMOUNT/);
    });

    it('should reject negative amounts with minus signs as INVALID_AMOUNT_FORMAT', () => {
      expect(() => parseDecimalToMinorUnits('-1')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('-0')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('-0.01')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('-12.50')).toThrowError(/INVALID_AMOUNT_FORMAT/);
    });
  });

  describe('parseDecimalToMinorUnits — Format and Syntax Rejections', () => {
    it('should reject excess decimal precision (more than 2 decimal digits)', () => {
      expect(() => parseDecimalToMinorUnits('12.001')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('12.123')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('0.0001')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('1.12345')).toThrowError(/INVALID_AMOUNT_FORMAT/);
    });

    it('should reject malformed decimal point structures', () => {
      expect(() => parseDecimalToMinorUnits('12.')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('.50')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('.5')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('1.2.3')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('..')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('.')).toThrowError(/INVALID_AMOUNT_FORMAT/);
    });

    it('should reject scientific notation', () => {
      expect(() => parseDecimalToMinorUnits('1e3')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('1E2')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('1.5e2')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('1e-2')).toThrowError(/INVALID_AMOUNT_FORMAT/);
    });

    it('should reject leading, trailing, and internal whitespace', () => {
      expect(() => parseDecimalToMinorUnits(' 12')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('12 ')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits(' 12.50 ')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('\t12')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('12\n')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('12. 50')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('1 2')).toThrowError(/INVALID_AMOUNT_FORMAT/);
    });

    it('should reject signs and currency symbols', () => {
      expect(() => parseDecimalToMinorUnits('+12')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('+12.50')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('$12')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('$12.50')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('12 USD')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('12€')).toThrowError(/INVALID_AMOUNT_FORMAT/);
    });

    it('should reject non-ASCII and Unicode full-width digits', () => {
      expect(() => parseDecimalToMinorUnits('１２')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('١٢')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('१२')).toThrowError(/INVALID_AMOUNT_FORMAT/);
    });

    it('should reject non-numeric strings and empty inputs', () => {
      expect(() => parseDecimalToMinorUnits('')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('abc')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('NaN')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('Infinity')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits(null as unknown as string)).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits(undefined as unknown as string)).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits(12 as unknown as string)).toThrowError(/INVALID_AMOUNT_FORMAT/);
    });

    it('should reject amounts exceeding maximum 7-digit limit (9,999,999.99)', () => {
      expect(() => parseDecimalToMinorUnits('10000000')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('10000000.00')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('99999999.99')).toThrowError(/INVALID_AMOUNT_FORMAT/);
      expect(() => parseDecimalToMinorUnits('1000000000')).toThrowError(/INVALID_AMOUNT_FORMAT/);
    });
  });

  describe('formatMinorUnitsToDecimal', () => {
    it('should format minor units to standard 2-decimal strings', () => {
      expect(formatMinorUnitsToDecimal(1200 as MinorUnits)).toBe('12.00');
      expect(formatMinorUnitsToDecimal(1250 as MinorUnits)).toBe('12.50');
      expect(formatMinorUnitsToDecimal(100 as MinorUnits)).toBe('1.00');
      expect(formatMinorUnitsToDecimal(1 as MinorUnits)).toBe('0.01');
      expect(formatMinorUnitsToDecimal(9 as MinorUnits)).toBe('0.09');
      expect(formatMinorUnitsToDecimal(10 as MinorUnits)).toBe('0.10');
      expect(formatMinorUnitsToDecimal(99 as MinorUnits)).toBe('0.99');
    });

    it('should format zero minor units as 0.00 (useful for zero balance/budget)', () => {
      expect(formatMinorUnitsToDecimal(0 as MinorUnits)).toBe('0.00');
      expect(formatMinorUnitsToDecimal(toMinorUnits(0))).toBe('0.00');
    });

    it('should format maximum permitted minor units (999,999,999)', () => {
      expect(formatMinorUnitsToDecimal(MAX_MINOR_UNITS)).toBe('9999999.99');
      expect(formatMinorUnitsToDecimal(999999999 as MinorUnits)).toBe('9999999.99');
    });

    it('should round-trip cleanly with parseDecimalToMinorUnits', () => {
      const amounts = ['0.01', '0.50', '1.00', '12.00', '12.50', '99.99', '123456.78', '9999999.99'];
      for (const amount of amounts) {
        const parsed = parseDecimalToMinorUnits(amount);
        expect(formatMinorUnitsToDecimal(parsed)).toBe(amount);
      }
    });

    it('should reject negative minor units', () => {
      expect(() => formatMinorUnitsToDecimal(-1 as MinorUnits)).toThrow(MoneyError);
      expect(() => formatMinorUnitsToDecimal(-1 as MinorUnits)).toThrowError(/INVALID_MINOR_UNITS/);
      expect(() => formatMinorUnitsToDecimal(-100 as MinorUnits)).toThrowError(/INVALID_MINOR_UNITS/);
    });

    it('should reject non-integer or unsafe values', () => {
      expect(() => formatMinorUnitsToDecimal(1.5 as unknown as MinorUnits)).toThrowError(/INVALID_MINOR_UNITS/);
      expect(() => formatMinorUnitsToDecimal(12.05 as unknown as MinorUnits)).toThrowError(/INVALID_MINOR_UNITS/);
      expect(() => formatMinorUnitsToDecimal(NaN as unknown as MinorUnits)).toThrowError(/INVALID_MINOR_UNITS/);
      expect(() => formatMinorUnitsToDecimal(Infinity as unknown as MinorUnits)).toThrowError(/INVALID_MINOR_UNITS/);
    });

    it('should reject minor units exceeding MAX_MINOR_UNITS (999,999,999)', () => {
      expect(() => formatMinorUnitsToDecimal(1_000_000_000 as unknown as MinorUnits)).toThrowError(/INVALID_MINOR_UNITS/);
      expect(() => formatMinorUnitsToDecimal(Number.MAX_SAFE_INTEGER as unknown as MinorUnits)).toThrowError(/INVALID_MINOR_UNITS/);
    });
  });

  describe('toMinorUnits runtime assertion', () => {
    it('should accept valid non-negative safe integers', () => {
      expect(toMinorUnits(0)).toBe(0);
      expect(toMinorUnits(1)).toBe(1);
      expect(toMinorUnits(1200)).toBe(1200);
      expect(toMinorUnits(999999999)).toBe(999999999);
    });

    it('should reject invalid values', () => {
      expect(() => toMinorUnits(-1)).toThrowError(/INVALID_MINOR_UNITS/);
      expect(() => toMinorUnits(1.5)).toThrowError(/INVALID_MINOR_UNITS/);
      expect(() => toMinorUnits(1_000_000_000)).toThrowError(/INVALID_MINOR_UNITS/);
      expect(() => toMinorUnits(NaN)).toThrowError(/INVALID_MINOR_UNITS/);
      expect(() => toMinorUnits(Infinity)).toThrowError(/INVALID_MINOR_UNITS/);
    });
  });

  describe('isValidDecimalAmount', () => {
    it('should return true for valid positive payment decimal strings', () => {
      expect(isValidDecimalAmount('12')).toBe(true);
      expect(isValidDecimalAmount('12.5')).toBe(true);
      expect(isValidDecimalAmount('12.50')).toBe(true);
      expect(isValidDecimalAmount('0.01')).toBe(true);
      expect(isValidDecimalAmount('9999999.99')).toBe(true);
    });

    it('should return false for invalid, zero, or negative inputs', () => {
      expect(isValidDecimalAmount('0')).toBe(false);
      expect(isValidDecimalAmount('0.00')).toBe(false);
      expect(isValidDecimalAmount('-1')).toBe(false);
      expect(isValidDecimalAmount('12.001')).toBe(false);
      expect(isValidDecimalAmount('1e3')).toBe(false);
      expect(isValidDecimalAmount('')).toBe(false);
      expect(isValidDecimalAmount('10000000')).toBe(false);
      expect(isValidDecimalAmount(null)).toBe(false);
      expect(isValidDecimalAmount(undefined)).toBe(false);
      expect(isValidDecimalAmount(1200)).toBe(false);
    });
  });

  describe('isValidCurrency & validateCurrency', () => {
    it('should validate 3-letter uppercase ASCII currency codes', () => {
      expect(isValidCurrency('USD')).toBe(true);
      expect(isValidCurrency('EUR')).toBe(true);
      expect(isValidCurrency('GBP')).toBe(true);
      expect(isValidCurrency('JPY')).toBe(true);
      expect(validateCurrency('USD')).toBe('USD');
    });

    it('should reject lowercase, mixed-case, numbers, and symbols', () => {
      expect(isValidCurrency('usd')).toBe(false);
      expect(isValidCurrency('Usd')).toBe(false);
      expect(isValidCurrency('US')).toBe(false);
      expect(isValidCurrency('USDD')).toBe(false);
      expect(isValidCurrency('U$D')).toBe(false);
      expect(isValidCurrency('123')).toBe(false);
      expect(isValidCurrency('')).toBe(false);
      expect(isValidCurrency(null)).toBe(false);

      expect(() => validateCurrency('usd')).toThrow(MoneyError);
      expect(() => validateCurrency('usd')).toThrowError(/INVALID_CURRENCY/);
      expect(() => validateCurrency('US')).toThrowError(/INVALID_CURRENCY/);
    });
  });

  describe('addMinorUnits & subtractMinorUnits', () => {
    it('should safely add minor units', () => {
      const a = toMinorUnits(1200);
      const b = toMinorUnits(550);
      expect(addMinorUnits(a, b)).toBe(1750);
    });

    it('should throw on overflow exceeding maximum range', () => {
      const a = MAX_MINOR_UNITS;
      const b = toMinorUnits(1);
      expect(() => addMinorUnits(a, b)).toThrowError(/AMOUNT_TOO_LARGE/);
    });

    it('should safely subtract minor units', () => {
      const a = toMinorUnits(1200);
      const b = toMinorUnits(200);
      expect(subtractMinorUnits(a, b)).toBe(1000);
    });

    it('should allow subtracting to zero (e.g. consuming entire budget)', () => {
      const a = toMinorUnits(500);
      const b = toMinorUnits(500);
      expect(subtractMinorUnits(a, b)).toBe(0);
    });

    it('should throw when subtraction produces negative minor units', () => {
      const a = toMinorUnits(100);
      const b = toMinorUnits(200);
      expect(() => subtractMinorUnits(a, b)).toThrowError(/INVALID_MINOR_UNITS/);
    });
  });

  describe('Constants validation', () => {
    it('should have consistent constant values', () => {
      expect(MIN_PAYMENT_MINOR_UNITS).toBe(1);
      expect(MAX_MINOR_UNITS).toBe(999999999);
      expect(formatMinorUnitsToDecimal(MAX_MINOR_UNITS)).toBe('9999999.99');
      expect(parseDecimalToMinorUnits('9999999.99')).toBe(MAX_MINOR_UNITS);
    });
  });
});
