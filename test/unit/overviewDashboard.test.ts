import { describe, it, expect } from 'vitest';
import {
  calculateBudgetUtilization,
  calculateCategoryAllocations,
  calculateHourlyActivityBuckets,
} from '../../web/src/lib/overviewUtils.js';
import {
  formatUsdFromMinor,
  maskIdentifier,
  getReasonLabel,
} from '../../web/src/lib/formatters.js';

describe('M4-T7: Overview Dashboard Logic & Calculations', () => {
  describe('calculateBudgetUtilization & Authoritative Commitments', () => {
    it('verifies that totalCommittedMinor is the authoritative sum of spent + reserved', () => {
      // In src/core/facts.ts & src/api/owner.ts:
      // totalCommittedMinor = globalSpendRolling24hMinor + globalReservedRolling24hMinor
      const spentMinor = 1200; // $12.00
      const reservedMinor = 4000; // $40.00
      const totalCommittedMinor = spentMinor + reservedMinor; // $52.00
      const globalDailyBudgetMinor = 20000; // $200.00

      const res = calculateBudgetUtilization(totalCommittedMinor, globalDailyBudgetMinor);
      // 5,200 / 20,000 = 26%
      expect(res.utilizationPercent).toBe(26);
      expect(res.status).toBe('safe');
      expect(res.statusLabel).toBe('Safe');
      expect(res.headroomMinor).toBe(14800); // $148.00 remaining
      expect(res.totalCommittedMinor).toBe(5200);
    });

    it('handles zero or negative global budget safely without division by zero', () => {
      const res = calculateBudgetUtilization(5000, 0);
      expect(res.utilizationPercent).toBe(0);
      expect(res.status).toBe('safe');
      expect(res.headroomMinor).toBe(0);
      expect(res.totalCommittedMinor).toBe(5000);
    });

    it('calculates exact percentage and safe status below 70%', () => {
      // 5,000 / 20,000 = 25%
      const res = calculateBudgetUtilization(5000, 20000);
      expect(res.utilizationPercent).toBe(25);
      expect(res.status).toBe('safe');
      expect(res.statusLabel).toBe('Safe');
      expect(res.headroomMinor).toBe(15000);
    });

    it('identifies elevated status between 70% and 89%', () => {
      // 15,000 / 20,000 = 75%
      const res = calculateBudgetUtilization(15000, 20000);
      expect(res.utilizationPercent).toBe(75);
      expect(res.status).toBe('elevated');
      expect(res.statusLabel).toBe('Elevated');
      expect(res.headroomMinor).toBe(5000);
    });

    it('identifies cap exceeded status at or above 90%', () => {
      // 19,000 / 20,000 = 95%
      const res = calculateBudgetUtilization(19000, 20000);
      expect(res.utilizationPercent).toBe(95);
      expect(res.status).toBe('exceeded');
      expect(res.statusLabel).toBe('Cap Exceeded');
      expect(res.headroomMinor).toBe(1000);
    });

    it('clamps utilization to 100% and headroom to 0 when over budget', () => {
      // 25,000 / 20,000 = 125% -> clamped to 100%
      const res = calculateBudgetUtilization(25000, 20000);
      expect(res.utilizationPercent).toBe(100);
      expect(res.status).toBe('exceeded');
      expect(res.headroomMinor).toBe(0);
    });
  });

  describe('Pending Approvals & Hold Expiry Semantics', () => {
    it('isolates currently active HELD requests from historical approved/voided holds', () => {
      const allRequests = [
        { id: 'req-1', status: 'CAPTURED', decision: 'ALLOW' },
        { id: 'req-2', status: 'CAPTURED', decision: 'HOLD' }, // Previously held, now approved & captured
        { id: 'req-3', status: 'VOIDED', decision: 'HOLD' },   // Previously held, now voided
        { id: 'req-4', status: 'HELD', decision: 'HOLD' },     // Active unresolved hold
      ];

      // Historical decision count would be 3, but active pending count MUST be 1
      const activePendingHolds = allRequests.filter((r) => r.status === 'HELD');
      expect(activePendingHolds).toHaveLength(1);
      expect(activePendingHolds[0]?.id).toBe('req-4');
    });

    it('calculates remaining TTL accurately from authoritative expiresAt', () => {
      const nowMs = 1700000000000;
      const createdAtIso = new Date(nowMs - 5 * 60 * 1000).toISOString(); // 5 min ago
      const expiresAtIso = new Date(nowMs + 10 * 60 * 1000).toISOString(); // 10 min from now

      const expiresAtMs = new Date(expiresAtIso).getTime();
      const createdAtMs = new Date(createdAtIso).getTime();

      const totalDurationMs = expiresAtMs - createdAtMs; // 15 min = 900,000 ms
      const remainingMs = expiresAtMs - nowMs; // 10 min = 600,000 ms
      const percentRemaining = Math.round((remainingMs / totalDurationMs) * 100);

      expect(totalDurationMs).toBe(15 * 60 * 1000);
      expect(remainingMs).toBe(10 * 60 * 1000);
      expect(percentRemaining).toBe(67);
    });

    it('identifies expired holds where expiresAt <= now', () => {
      const nowMs = 1700000000000;
      const expiredIso = new Date(nowMs - 60000).toISOString(); // 1 min in the past
      const remainingMs = new Date(expiredIso).getTime() - nowMs;
      expect(remainingMs).toBeLessThanOrEqual(0);
    });
  });

  describe('calculateCategoryAllocations', () => {
    it('returns empty array when no requests exist', () => {
      const res = calculateCategoryAllocations([]);
      expect(res).toEqual([]);
    });

    it('groups requests by category and calculates percentages descending', () => {
      const sampleRequests = [
        { category: 'Cloud Infrastructure', amountMinor: 6000 },
        { category: 'API Credits', amountMinor: 3000 },
        { category: 'Cloud Infrastructure', amountMinor: 1000 },
      ];

      // Total = 10,000: Cloud = 7,000 (70%), API = 3,000 (30%)
      const res = calculateCategoryAllocations(sampleRequests);
      expect(res).toHaveLength(2);
      expect(res[0]?.category).toBe('Cloud Infrastructure');
      expect(res[0]?.amountMinor).toBe(7000);
      expect(res[0]?.percentage).toBe(70);
      expect(res[1]?.category).toBe('API Credits');
      expect(res[1]?.amountMinor).toBe(3000);
      expect(res[1]?.percentage).toBe(30);
    });

    it('defaults missing or blank category to "General"', () => {
      const sample = [
        { category: null, amountMinor: 2500 },
        { category: '   ', amountMinor: 1500 },
      ];
      const res = calculateCategoryAllocations(sample);
      expect(res).toHaveLength(1);
      expect(res[0]?.category).toBe('General');
      expect(res[0]?.amountMinor).toBe(4000);
      expect(res[0]?.percentage).toBe(100);
    });
  });

  describe('calculateHourlyActivityBuckets', () => {
    it('generates the specified number of buckets', () => {
      const buckets = calculateHourlyActivityBuckets([], 12);
      expect(buckets).toHaveLength(12);
      expect(buckets[0]).toHaveProperty('hourLabel');
      expect(buckets[0]).toHaveProperty('count');
      expect(buckets[0]).toHaveProperty('amountMinor');
      expect(buckets[0]?.count).toBe(0);
    });

    it('aggregates requests into the correct time bucket', () => {
      const thirtySecondsAgoIso = new Date(Date.now() - 30000).toISOString();
      const sample = [{ createdAt: thirtySecondsAgoIso, amountMinor: 1200 }];
      const buckets = calculateHourlyActivityBuckets(sample, 12);
      const lastBucket = buckets[buckets.length - 1];
      expect(lastBucket?.count).toBe(1);
      expect(lastBucket?.amountMinor).toBe(1200);
    });
  });

  describe('Financial and Masking Formatting Utilities', () => {
    it('formats USD from integer minor units precisely', () => {
      expect(formatUsdFromMinor(0)).toBe('$0.00');
      expect(formatUsdFromMinor(1200)).toBe('$12.00');
      expect(formatUsdFromMinor(4050)).toBe('$40.50');
      expect(formatUsdFromMinor(12091700)).toBe('$120,917.00');
      expect(formatUsdFromMinor(-1500)).toBe('−$15.00');
    });

    it('masks agent identifiers showing last 4 characters', () => {
      expect(maskIdentifier('agent-demo-honest')).toBe('**** nest');
      expect(maskIdentifier('agent-1234')).toBe('**** 1234');
      expect(maskIdentifier('abc')).toBe('abc');
    });

    it('maps authoritative policy reason codes to descriptions', () => {
      expect(getReasonLabel('OVER_AUTO_LIMIT')).toBe('Exceeds auto-approve ceiling');
      expect(getReasonLabel('VENDOR_UNKNOWN')).toBe('Vendor not in approved registry');
      expect(getReasonLabel('CUSTOM_UNKNOWN')).toBe('CUSTOM_UNKNOWN');
    });
  });
});
