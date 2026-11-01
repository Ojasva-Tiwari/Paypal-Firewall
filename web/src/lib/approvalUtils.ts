/**
 * PayGuard — Approval Queue Utilities & Pure Logic
 *
 * Handles authoritative hold expiry calculations, countdown formatting,
 * strict separation of deterministic policy reasons from non-authoritative AI flags,
 * and fail-closed resolution of action outcomes and errors.
 */

export function isHoldExpired(expiresAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const expiryTime = new Date(expiresAt).getTime();
  if (isNaN(expiryTime)) return false;
  return expiryTime <= nowMs;
}

export function calculateRemainingHoldMs(
  expiresAt: string | null | undefined,
  nowMs: number = Date.now()
): number {
  if (!expiresAt) return 0;
  const expiryTime = new Date(expiresAt).getTime();
  if (isNaN(expiryTime)) return 0;
  return Math.max(0, expiryTime - nowMs);
}

export function formatHoldCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return 'Expired';
  const totalSec = Math.floor(remainingMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

export function isAiReason(reasonCode: string): boolean {
  const norm = (reasonCode || '').toUpperCase();
  return norm === 'AI_FLAG' || norm.startsWith('AI_');
}

export function separatePolicyAndAiReasons(reasons: string[] = []): {
  policyReasons: string[];
  aiReasons: string[];
} {
  const policyReasons: string[] = [];
  const aiReasons: string[] = [];

  for (const code of reasons) {
    if (isAiReason(code)) {
      aiReasons.push(code);
    } else {
      policyReasons.push(code);
    }
  }

  return { policyReasons, aiReasons };
}

export interface ActionOutcomeDetails {
  status?: string;
  captureId?: string;
  remoteVoidStatus?: 'CONFIRMED' | 'PENDING' | 'FAILED';
  warning?: string;
}

export interface ActionOutcomePresentation {
  type: 'APPROVE' | 'VOID' | 'ERROR';
  headline: string;
  message: string;
  isSuccess: boolean;
  isAmbiguous: boolean;
}

/**
 * Evaluates the outcome of an Approve or Void action, ensuring that
 * ambiguous outcomes (e.g. CAPTURING) or failures NEVER present a false success.
 */
export function resolveActionOutcome(
  actionType: 'APPROVE' | 'VOID',
  details: ActionOutcomeDetails = {},
  fallbackMessage?: string
): ActionOutcomePresentation {
  if (actionType === 'APPROVE') {
    if (details.status === 'CAPTURED') {
      return {
        type: 'APPROVE',
        headline: 'Payment Captured Successfully',
        message:
          fallbackMessage ||
          `Payment request approved and captured successfully. Capture ID: ${details.captureId || 'N/A'}`,
        isSuccess: true,
        isAmbiguous: false,
      };
    }
    // Ambiguous outcome (e.g. CAPTURING or awaiting reconciliation)
    const baseWarning = details.warning || fallbackMessage || 'Capture in progress';
    return {
      type: 'APPROVE',
      headline: 'Capture Status Pending / Reconciling',
      message: `${baseWarning}. Capture is pending PayPal reconciliation. Do not retry.`,
      isSuccess: false, // Never claim false success!
      isAmbiguous: true,
    };
  }

  // VOID action
  const remoteStatus = details.remoteVoidStatus || 'PENDING';
  let headline = 'Payment Request Voided';
  let message = fallbackMessage;

  if (remoteStatus === 'CONFIRMED') {
    headline = 'Payment Voided & Authorization Cancelled';
    message =
      message ||
      'Payment request voided successfully (Remote: CONFIRMED). Reserved budget released.';
  } else if (remoteStatus === 'PENDING') {
    headline = 'Payment Voided (Remote Cancellation Pending)';
    message =
      message ||
      'Payment request voided locally. Remote PayPal authorization cancellation is queued for reconciliation.';
  } else if (remoteStatus === 'FAILED') {
    headline = 'Payment Voided (Remote Cancellation Failed)';
    message =
      message ||
      'Payment request voided locally, but remote PayPal authorization void encountered an error. Manual check required.';
  }

  return {
    type: 'VOID',
    headline,
    message: message || 'Payment request voided.',
    isSuccess: remoteStatus === 'CONFIRMED',
    isAmbiguous: remoteStatus === 'PENDING' || remoteStatus === 'FAILED',
  };
}

/**
 * Resolves an API or network error into a safe, descriptive error message.
 * Guarantees fail-closed behavior (never false success).
 */
export function resolveActionErrorMessage(err: unknown): {
  code: 'HOLD_EXPIRED' | 'INVALID_STATUS' | 'CSRF_ERROR' | 'AUTH_ERROR' | 'NETWORK_ERROR' | 'SERVER_ERROR';
  message: string;
  shouldRefreshQueue: boolean;
} {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status;
    const msg = (err as { message?: string }).message || '';

    if (status === 410) {
      return {
        code: 'HOLD_EXPIRED',
        message: 'HOLD_EXPIRED: Payment hold has expired and cannot be approved. Queue will refresh.',
        shouldRefreshQueue: true,
      };
    }
    if (status === 409) {
      return {
        code: 'INVALID_STATUS',
        message: `INVALID_STATUS: ${msg || 'Payment request status has changed.'}`,
        shouldRefreshQueue: true,
      };
    }
    if (status === 403) {
      return {
        code: 'CSRF_ERROR',
        message: 'CSRF verification failed. Please refresh your session.',
        shouldRefreshQueue: false,
      };
    }
    if (status === 401) {
      return {
        code: 'AUTH_ERROR',
        message: 'Authentication session expired. Please re-login.',
        shouldRefreshQueue: false,
      };
    }
    return {
      code: 'SERVER_ERROR',
      message: msg
        ? `${msg} (Fail-closed: No money was moved)`
        : `Action failed with server status ${status}. No money was moved.`,
      shouldRefreshQueue: false,
    };
  }

  if (err instanceof Error) {
    return {
      code: 'NETWORK_ERROR',
      message: `Network error: ${err.message}. Transaction outcome unconfirmed — do not retry blindly.`,
      shouldRefreshQueue: true,
    };
  }

  return {
    code: 'SERVER_ERROR',
    message: 'An unexpected error occurred. Failed closed without moving funds.',
    shouldRefreshQueue: false,
  };
}

/**
 * Validates whether an approval action is permitted based on hold status and expiry.
 */
export function canApproveHold(
  request: { status: string; expiresAt?: string | null } | null | undefined,
  nowMs: number = Date.now()
): { allowed: boolean; reason?: string } {
  if (!request) {
    return { allowed: false, reason: 'NO_REQUEST' };
  }
  if (request.status !== 'HELD') {
    return { allowed: false, reason: `STATUS_NOT_HELD: ${request.status}` };
  }
  if (isHoldExpired(request.expiresAt, nowMs)) {
    return { allowed: false, reason: 'HOLD_EXPIRED' };
  }
  return { allowed: true };
}
