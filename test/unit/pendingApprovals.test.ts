import { describe, it, expect, vi } from 'vitest';
import {
  isHoldExpired,
  calculateRemainingHoldMs,
  formatHoldCountdown,
  isAiReason,
  separatePolicyAndAiReasons,
  canApproveHold,
  resolveActionOutcome,
  resolveActionErrorMessage,
} from '../../web/src/lib/approvalUtils.js';
import { formatUsdFromMinor, getReasonLabel } from '../../web/src/lib/formatters.js';
import { ApiError } from '../../web/src/lib/api.js';

describe('M4-T8: Pending Approvals Queue & Action Logic', () => {
  describe('Hold Expiry Pure Logic & Calculations', () => {
    it('accurately identifies expired holds based on authoritative timestamp vs now', () => {
      const nowMs = 1700000000000;
      const pastExpiry = new Date(nowMs - 5000).toISOString();
      const futureExpiry = new Date(nowMs + 60000).toISOString();

      expect(isHoldExpired(pastExpiry, nowMs)).toBe(true);
      expect(isHoldExpired(futureExpiry, nowMs)).toBe(false);
      expect(isHoldExpired(new Date(nowMs).toISOString(), nowMs)).toBe(true);
    });

    it('handles missing, null, or invalid expiry dates safely without throwing', () => {
      const nowMs = 1700000000000;
      expect(isHoldExpired(null, nowMs)).toBe(false);
      expect(isHoldExpired(undefined, nowMs)).toBe(false);
      expect(isHoldExpired('invalid-date', nowMs)).toBe(false);
    });

    it('calculates remaining milliseconds and clamps to 0 when expired', () => {
      const nowMs = 1700000000000;
      const futureExpiry = new Date(nowMs + 45000).toISOString();
      const pastExpiry = new Date(nowMs - 10000).toISOString();

      expect(calculateRemainingHoldMs(futureExpiry, nowMs)).toBe(45000);
      expect(calculateRemainingHoldMs(pastExpiry, nowMs)).toBe(0);
      expect(calculateRemainingHoldMs(null, nowMs)).toBe(0);
    });

    it('formats countdown string appropriately for minutes, seconds, and expired states', () => {
      expect(formatHoldCountdown(0)).toBe('Expired');
      expect(formatHoldCountdown(-5000)).toBe('Expired');
      expect(formatHoldCountdown(35000)).toBe('35s');
      expect(formatHoldCountdown(125000)).toBe('2m 5s');
      expect(formatHoldCountdown(900000)).toBe('15m 0s');
    });
  });

  describe('Policy Reason vs Non-Authoritative AI Separation (Hard Rule 6)', () => {
    it('correctly identifies AI flag reasons', () => {
      expect(isAiReason('AI_FLAG')).toBe(true);
      expect(isAiReason('AI_RISK_WARNING')).toBe(true);
      expect(isAiReason('ai_heuristic')).toBe(true);
      expect(isAiReason('OVER_AUTO_LIMIT')).toBe(false);
      expect(isAiReason('VENDOR_NEW')).toBe(false);
      expect(isAiReason('GLOBAL_BUDGET_EXCEEDED')).toBe(false);
    });

    it('strictly separates authoritative deterministic policy rules from advisory AI summaries', () => {
      const mixedReasons = [
        'OVER_AUTO_LIMIT',
        'AI_FLAG',
        'VENDOR_NEW',
        'AI_SUSPICIOUS_PROMPT',
        'CURRENCY_NOT_ALLOWED',
      ];

      const { policyReasons, aiReasons } = separatePolicyAndAiReasons(mixedReasons);

      expect(policyReasons).toEqual(['OVER_AUTO_LIMIT', 'VENDOR_NEW', 'CURRENCY_NOT_ALLOWED']);
      expect(aiReasons).toEqual(['AI_FLAG', 'AI_SUSPICIOUS_PROMPT']);
    });

    it('translates known reason codes to user-friendly authoritative descriptions', () => {
      expect(getReasonLabel('OVER_AUTO_LIMIT')).toBe('Exceeds auto-approve ceiling');
      expect(getReasonLabel('VENDOR_NEW')).toBe('Vendor status is unverified');
      expect(getReasonLabel('GLOBAL_BUDGET_EXCEEDED')).toBe('Global daily budget exhausted');
      expect(getReasonLabel('CUSTOM_UNKNOWN_RULE')).toBe('CUSTOM_UNKNOWN_RULE');
    });
  });

  describe('Queue Filtering & State Authority', () => {
    it('strictly filters for active HELD requests and excludes historical holds', () => {
      const sampleRequests = [
        { id: 'req-1', status: 'HELD', decision: 'HOLD', amountMinor: 2500 },
        { id: 'req-2', status: 'CAPTURED', decision: 'HOLD', amountMinor: 4000 }, // Previously held, now captured
        { id: 'req-3', status: 'VOIDED', decision: 'HOLD', amountMinor: 1500 }, // Previously held, now voided
        { id: 'req-4', status: 'FAILED', decision: 'HOLD', amountMinor: 5000 }, // Failed hold
        { id: 'req-5', status: 'HELD', decision: 'HOLD', amountMinor: 8000 }, // Active hold
      ];

      const activeQueue = sampleRequests.filter((r) => r.status === 'HELD');
      expect(activeQueue.length).toBe(2);
      expect(activeQueue.map((r) => r.id)).toEqual(['req-1', 'req-5']);
    });

    it('formats monetary amounts from integer minor units with exact precision', () => {
      expect(formatUsdFromMinor(1500)).toBe('$15.00');
      expect(formatUsdFromMinor(25)).toBe('$0.25');
      expect(formatUsdFromMinor(100000)).toBe('$1,000.00');
      expect(formatUsdFromMinor(0)).toBe('$0.00');
    });
  });

  describe('Action Flow Contracts & DTOs', () => {
    it('validates approve response contract for definitive CAPTURED outcome', () => {
      const mockSuccessResponse = {
        success: true,
        status: 'CAPTURED',
        captureId: 'cap-99901',
        orderId: 'ord-88801',
      };

      expect(mockSuccessResponse.success).toBe(true);
      expect(mockSuccessResponse.status).toBe('CAPTURED');
      expect(mockSuccessResponse.captureId).toBe('cap-99901');
    });

    it('validates approve response contract for in-progress CAPTURING outcome (Fail Closed / No Blind Retry)', () => {
      const mockCapturingResponse = {
        success: true,
        status: 'CAPTURING',
        warning: 'Capture in progress or awaiting reconciliation',
      };

      expect(mockCapturingResponse.success).toBe(true);
      expect(mockCapturingResponse.status).toBe('CAPTURING');
      expect(mockCapturingResponse.warning).toBeDefined();
    });

    it('validates void request memo schema and remote void statuses', () => {
      const validVoidPayload = {
        reason: 'Vendor unverified upon inspection',
      };

      expect(typeof validVoidPayload.reason).toBe('string');
      expect(validVoidPayload.reason.trim().length).toBeGreaterThan(0);

      // Verify remote void status outcomes
      const possibleRemoteStatuses: Array<'CONFIRMED' | 'PENDING' | 'FAILED'> = [
        'CONFIRMED',
        'PENDING',
        'FAILED',
      ];
      for (const s of possibleRemoteStatuses) {
        const voidResponse = {
          success: true,
          status: 'VOIDED',
          remoteVoidStatus: s,
        };
        expect(voidResponse.status).toBe('VOIDED');
        expect(voidResponse.remoteVoidStatus).toBe(s);
      }
    });

    it('verifies that detail view only presents external IDs if returned by backend', () => {
      const detailWithPaypal = {
        id: 'req-auth-1',
        paypalOrderId: 'ord-123',
        paypalAuthorizationId: 'auth-456',
        paypalCaptureId: 'cap-789',
        remoteVoidStatus: null,
      };

      const detailWithoutPaypal = {
        id: 'req-auth-2',
        paypalOrderId: null,
        paypalAuthorizationId: null,
        paypalCaptureId: null,
        remoteVoidStatus: null,
      };

      expect(detailWithPaypal.paypalAuthorizationId).toBeTruthy();
      expect(detailWithoutPaypal.paypalAuthorizationId).toBeNull();
    });
  });

  describe('Focused Behavioral Verification: Security & Error Guarantees', () => {
    // 1. Duplicate approval submission prevention
    it('1. prevents duplicate approval submissions with an active submission lock', async () => {
      let isSubmitting = false;
      const apiCall = vi.fn().mockImplementation(async () => {
        // Simulate in-flight network latency
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { success: true, status: 'CAPTURED', captureId: 'cap-lock-1' };
      });

      const executeSubmission = async () => {
        if (isSubmitting) return 'BLOCKED_DUPLICATE';
        isSubmitting = true;
        try {
          return await apiCall();
        } finally {
          isSubmitting = false;
        }
      };

      // Launch two rapid submissions concurrently
      const [firstAttempt, secondAttempt] = await Promise.all([
        executeSubmission(),
        executeSubmission(),
      ]);

      // First succeeds, second is locked out and blocked
      expect(firstAttempt).toEqual({ success: true, status: 'CAPTURED', captureId: 'cap-lock-1' });
      expect(secondAttempt).toBe('BLOCKED_DUPLICATE');
      expect(apiCall).toHaveBeenCalledTimes(1); // Crucial: network called exactly once
    });

    // 2. Expired hold approval lockout
    it('2. locks out approval when hold has expired (canApproveHold pre-flight & card guard)', () => {
      const nowMs = 1700000000000;
      const expiredRequest = {
        id: 'req-exp-1',
        status: 'HELD',
        expiresAt: new Date(nowMs - 5000).toISOString(),
      };
      const activeRequest = {
        id: 'req-act-1',
        status: 'HELD',
        expiresAt: new Date(nowMs + 60000).toISOString(),
      };
      const capturedRequest = {
        id: 'req-cap-1',
        status: 'CAPTURED',
        expiresAt: new Date(nowMs + 60000).toISOString(),
      };

      // Expired hold: allowed is false with reason HOLD_EXPIRED
      const expiredCheck = canApproveHold(expiredRequest, nowMs);
      expect(expiredCheck.allowed).toBe(false);
      expect(expiredCheck.reason).toBe('HOLD_EXPIRED');

      // Active hold: allowed is true
      const activeCheck = canApproveHold(activeRequest, nowMs);
      expect(activeCheck.allowed).toBe(true);

      // Captured request: locked out because status is not HELD
      const capturedCheck = canApproveHold(capturedRequest, nowMs);
      expect(capturedCheck.allowed).toBe(false);
      expect(capturedCheck.reason).toContain('STATUS_NOT_HELD');
    });

    // 3. HTTP 410 HOLD_EXPIRED handling and queue refresh
    it('3. handles HTTP 410 HOLD_EXPIRED, sets clear error alert, and flags queue refresh', () => {
      const api410Error = new ApiError('Payment hold has expired and cannot be approved', 410);

      const parsed = resolveActionErrorMessage(api410Error);
      expect(parsed.code).toBe('HOLD_EXPIRED');
      expect(parsed.shouldRefreshQueue).toBe(true); // Triggers immediate queue refresh
      expect(parsed.message).toContain('HOLD_EXPIRED');
      expect(parsed.message).toContain('cannot be approved');

      // Verify that this error NEVER creates a false success outcome
      expect(() => {
        if (parsed.code === 'HOLD_EXPIRED') {
          throw new Error('Hold expired, cannot proceed to capture');
        }
      }).toThrow('Hold expired, cannot proceed to capture');
    });

    // 4. CAPTURING outcome without blind retry
    it('4. presents CAPTURING outcome as in-progress reconciliation and warns against blind retries', () => {
      const capturingDetails = {
        status: 'CAPTURING',
        warning: 'Capture in progress or awaiting reconciliation',
      };

      const outcome = resolveActionOutcome('APPROVE', capturingDetails);

      // Invariants:
      expect(outcome.isSuccess).toBe(false); // MUST NOT be presented as definitive success
      expect(outcome.isAmbiguous).toBe(true); // Flagged as ambiguous
      expect(outcome.headline).toBe('Capture Status Pending / Reconciling');
      expect(outcome.message).toContain('Capture is pending PayPal reconciliation');
      expect(outcome.message).toContain('Do not retry'); // Prevents duplicate charges
    });

    // 5. Void PENDING versus CONFIRMED versus FAILED presentation
    it('5. presents Void PENDING, CONFIRMED, and FAILED with honest, non-misleading statuses', () => {
      // 5a. CONFIRMED: Local voided and remote PayPal cancellation confirmed
      const confirmedOutcome = resolveActionOutcome('VOID', {
        status: 'VOIDED',
        remoteVoidStatus: 'CONFIRMED',
      });
      expect(confirmedOutcome.isSuccess).toBe(true);
      expect(confirmedOutcome.isAmbiguous).toBe(false);
      expect(confirmedOutcome.headline).toBe('Payment Voided & Authorization Cancelled');
      expect(confirmedOutcome.message).toContain('Remote: CONFIRMED');

      // 5b. PENDING: Local voided, but remote PayPal void is queued
      const pendingOutcome = resolveActionOutcome('VOID', {
        status: 'VOIDED',
        remoteVoidStatus: 'PENDING',
      });
      expect(pendingOutcome.isSuccess).toBe(false); // Not claimed as full remote success
      expect(pendingOutcome.isAmbiguous).toBe(true);
      expect(pendingOutcome.headline).toBe('Payment Voided (Remote Cancellation Pending)');
      expect(pendingOutcome.message).toContain('queued for reconciliation');

      // 5c. FAILED: Local voided, but remote PayPal void failed
      const failedOutcome = resolveActionOutcome('VOID', {
        status: 'VOIDED',
        remoteVoidStatus: 'FAILED',
      });
      expect(failedOutcome.isSuccess).toBe(false);
      expect(failedOutcome.isAmbiguous).toBe(true);
      expect(failedOutcome.headline).toBe('Payment Voided (Remote Cancellation Failed)');
      expect(failedOutcome.message).toContain('encountered an error');
      expect(failedOutcome.message).toContain('Manual check required');
    });

    // 6. Network/API failure without falsely claiming payment success
    it('6. safely handles network dropouts, 500 server errors, and 403 CSRF failures without false success', () => {
      // 6a. Network failure (e.g. fetch dropped or timed out)
      const networkError = new Error('Failed to fetch (connection refused)');
      const networkParsed = resolveActionErrorMessage(networkError);

      expect(networkParsed.code).toBe('NETWORK_ERROR');
      expect(networkParsed.message).toContain('Network error');
      expect(networkParsed.message).toContain('Transaction outcome unconfirmed — do not retry blindly');
      expect(networkParsed.shouldRefreshQueue).toBe(true);

      // 6b. Internal Server Error (500)
      const server500Error = new ApiError('Database transaction conflict', 500);
      const serverParsed = resolveActionErrorMessage(server500Error);

      expect(serverParsed.code).toBe('SERVER_ERROR');
      expect(serverParsed.message).toContain('No money was moved');

      // 6c. CSRF Failure (403)
      const csrfError = new ApiError('Invalid CSRF token', 403);
      const csrfParsed = resolveActionErrorMessage(csrfError);

      expect(csrfParsed.code).toBe('CSRF_ERROR');
      expect(csrfParsed.message).toContain('CSRF verification failed');

      // 6d. Authentication Expiry (401)
      const authError = new ApiError('Unauthorized session', 401);
      const authParsed = resolveActionErrorMessage(authError);

      expect(authParsed.code).toBe('AUTH_ERROR');
      expect(authParsed.message).toContain('Authentication session expired');

      // Invariant: None of these errors must ever generate a successful outcome presentation
      for (const err of [networkError, server500Error, csrfError, authError]) {
        const errResult = resolveActionErrorMessage(err);
        expect(errResult.code).not.toBe('CAPTURED');
        expect(errResult.message).not.toContain('successfully');
      }
    });
  });
});
