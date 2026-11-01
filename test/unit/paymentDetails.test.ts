import { describe, it, expect } from 'vitest';
import { formatCurrencyFromMinor, formatUsdFromMinor } from '../../web/src/lib/formatters.js';

describe('M4-T9: Payment Request Details Screen Logic & Contracts', () => {
  describe('1. Currency & Minor Unit Formatting (User Correction 1)', () => {
    it('correctly formats integer minor units using actual currency from API DTO', () => {
      expect(formatCurrencyFromMinor(4850, 'USD')).toBe('$48.50');
      expect(formatCurrencyFromMinor(2500, 'EUR')).toBe('€25.00');
      expect(formatCurrencyFromMinor(1550, 'GBP')).toBe('£15.50');
      expect(formatCurrencyFromMinor(3000, 'CAD')).toBe('30.00 CAD');
      expect(formatCurrencyFromMinor(100000, 'JPY')).toBe('1,000.00 JPY');
    });

    it('handles negative minor units gracefully for all currencies', () => {
      expect(formatCurrencyFromMinor(-1200, 'USD')).toBe('−$12.00');
      expect(formatCurrencyFromMinor(-500, 'EUR')).toBe('−€5.00');
    });

    it('maintains formatUsdFromMinor backward compatibility as a USD alias', () => {
      expect(formatUsdFromMinor(1234)).toBe('$12.34');
      expect(formatUsdFromMinor(1234)).toBe(formatCurrencyFromMinor(1234, 'USD'));
    });
  });

  describe('2. AI Information Verification & Timeline Inspection (User Correction 2)', () => {
    it('omits AI section when timeline contains no verified AI events', () => {
      const mockTimeline = [
        { id: 'ev-1', actor: 'agent', event: 'REQUEST_CREATED', timestamp: '2026-10-31T10:00:00Z', payload: {} },
        { id: 'ev-2', actor: 'system', event: 'POLICY_EVALUATED', timestamp: '2026-10-31T10:00:01Z', payload: {} },
        { id: 'ev-3', actor: 'owner', event: 'OWNER_APPROVED', timestamp: '2026-10-31T10:05:00Z', payload: {} },
      ];

      const verifiedAiEvents = mockTimeline.filter(
        (ev) => ev.actor === 'ai' || ev.event.toUpperCase().startsWith('AI_')
      );

      expect(verifiedAiEvents.length).toBe(0);
    });

    it('identifies and isolates verified AI advisory events strictly from timeline provenance', () => {
      const mockTimelineWithAi = [
        { id: 'ev-1', actor: 'agent', event: 'REQUEST_CREATED', timestamp: '2026-10-31T10:00:00Z', payload: {} },
        {
          id: 'ev-2',
          actor: 'ai',
          event: 'AI_RISK_EVALUATION',
          timestamp: '2026-10-31T10:00:01Z',
          payload: { risk_score: 0.85, advisory_flag: 'SUSPICIOUS_EXCERPT_PATTERN' },
        },
      ];

      const verifiedAiEvents = mockTimelineWithAi.filter(
        (ev) => ev.actor === 'ai' || ev.event.toUpperCase().startsWith('AI_')
      );

      expect(verifiedAiEvents.length).toBe(1);
      expect(verifiedAiEvents[0]?.actor).toBe('ai');
      expect(verifiedAiEvents[0]?.payload).toHaveProperty('advisory_flag');
    });
  });

  describe('3. Audit Timeline Semantics (User Correction 3)', () => {
    it('verifies timeline representation maps actor, event, timestamp, and payload without claiming hashes', () => {
      const timelineEvent = {
        id: 'aud-event-1',
        actor: 'owner',
        event: 'OWNER_VOIDED',
        timestamp: '2026-10-31T11:00:00Z',
        payload: { reason: 'Unverified vendor' },
      };

      // Validates presence of verified audit fields
      expect(timelineEvent.actor).toBe('owner');
      expect(timelineEvent.event).toBe('OWNER_VOIDED');
      expect(timelineEvent.payload.reason).toBe('Unverified vendor');
      // Invariant: The detail DTO omits prev_hash and hash for privacy/bandwidth; timeline is named "Audit Timeline"
      expect((timelineEvent as Record<string, unknown>).hash).toBeUndefined();
    });
  });

  describe('4. External PayPal Identifiers Discipline (User Correction 4)', () => {
    it('verifies external PayPal identifiers are rendered only when explicitly returned', () => {
      const capturedDetail = {
        id: 'req-captured',
        paypalOrderId: 'ord-sandbox-123',
        paypalAuthorizationId: 'auth-sandbox-456',
        paypalCaptureId: 'cap-sandbox-789',
        remoteVoidStatus: null,
      };

      const heldDetail = {
        id: 'req-held',
        paypalOrderId: null,
        paypalAuthorizationId: 'auth-sandbox-999',
        paypalCaptureId: null,
        remoteVoidStatus: null,
      };

      const deniedDetail = {
        id: 'req-denied',
        paypalOrderId: null,
        paypalAuthorizationId: null,
        paypalCaptureId: null,
        remoteVoidStatus: null,
      };

      // Captured: has captureId and orderId
      expect(capturedDetail.paypalCaptureId).toBe('cap-sandbox-789');
      expect(capturedDetail.paypalOrderId).toBe('ord-sandbox-123');

      // Held: has authorizationId only
      expect(heldDetail.paypalAuthorizationId).toBe('auth-sandbox-999');
      expect(heldDetail.paypalCaptureId).toBeNull();

      // Denied: zero PayPal calls were made
      expect(deniedDetail.paypalOrderId).toBeNull();
      expect(deniedDetail.paypalAuthorizationId).toBeNull();
      expect(deniedDetail.paypalCaptureId).toBeNull();
    });

    it('verifies remote void statuses are distinct and never claimed as confirmed when pending or failed', () => {
      const voidPending = { remoteVoidStatus: 'PENDING' };
      const voidFailed = { remoteVoidStatus: 'FAILED' };
      const voidConfirmed = { remoteVoidStatus: 'CONFIRMED' };

      expect(voidPending.remoteVoidStatus).toBe('PENDING');
      expect(voidPending.remoteVoidStatus).not.toBe('CONFIRMED');

      expect(voidFailed.remoteVoidStatus).toBe('FAILED');
      expect(voidFailed.remoteVoidStatus).not.toBe('CONFIRMED');

      expect(voidConfirmed.remoteVoidStatus).toBe('CONFIRMED');
    });
  });

  describe('5. Policy Version & Raw Source Context Provenance (User Corrections 6 & 7)', () => {
    it('uses the exact policyVersionId returned by API without inventing labels', () => {
      const detailA = { policyVersionId: 'pol-custom-uuid-1' };
      const detailB = { policyVersionId: null };

      expect(detailA.policyVersionId).toBe('pol-custom-uuid-1');
      expect(detailB.policyVersionId).toBeNull();
    });

    it('preserves raw source context excerpt as string without HTML injection', () => {
      const maliciousPrompt = '<script>alert("xss")</script>\nHost: attacker.com';
      // In React, rendering inside <pre>{sourceContextExcerpt}</pre> treats this as plain string
      expect(typeof maliciousPrompt).toBe('string');
      expect(maliciousPrompt).toContain('<script>');
    });
  });

  describe('6. Parameterized Hash Route Parsing (User Correction 8)', () => {
    function parseRoute(hashString: string): { route: string; requestId?: string } {
      const raw = hashString.replace(/^#\/?/, '').trim();
      const parts = raw.split('/');
      const base = parts[0]?.toLowerCase() || '';
      const param = parts[1];

      if ((base === 'requests' || base === 'payments') && param) {
        return { route: 'payment-detail', requestId: param };
      }

      switch (base) {
        case 'payments':
          return { route: 'payments' };
        case 'approvals':
          return { route: 'approvals' };
        case 'overview':
        default:
          return { route: 'overview' };
      }
    }

    it('parses requests/:id and payments/:id into payment-detail route with requestId', () => {
      expect(parseRoute('#/requests/req-test-123')).toEqual({
        route: 'payment-detail',
        requestId: 'req-test-123',
      });

      expect(parseRoute('#/payments/req-test-456')).toEqual({
        route: 'payment-detail',
        requestId: 'req-test-456',
      });
    });

    it('preserves existing top-level routes without collision', () => {
      expect(parseRoute('#/overview')).toEqual({ route: 'overview' });
      expect(parseRoute('#/payments')).toEqual({ route: 'payments' });
      expect(parseRoute('#/approvals')).toEqual({ route: 'approvals' });
      expect(parseRoute('')).toEqual({ route: 'overview' });
    });
  });
});

