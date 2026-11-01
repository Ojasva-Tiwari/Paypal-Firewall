import { useState } from 'react';
import { AlertTriangle, CheckCircle2, XCircle, Store, Bot } from 'lucide-react';
import { PaymentRequestSummary, ApprovePaymentResponse, VoidPaymentResponse } from '../../types/api';
import { apiClient } from '../../lib/api';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { formatUsdFromMinor } from '../../lib/formatters';
import {
  canApproveHold,
  resolveActionErrorMessage,
} from '../../lib/approvalUtils';

export interface ApprovalConfirmModalProps {
  isOpen: boolean;
  mode: 'APPROVE' | 'VOID';
  request: PaymentRequestSummary | null;
  onClose: () => void;
  onSuccess: (result: {
    type: 'APPROVE' | 'VOID';
    message: string;
    details?: {
      status?: string;
      captureId?: string;
      remoteVoidStatus?: 'CONFIRMED' | 'PENDING' | 'FAILED';
      warning?: string;
    };
  }) => void;
  onQueueRefreshNeeded?: () => void;
}

export function ApprovalConfirmModal({
  isOpen,
  mode,
  request,
  onClose,
  onSuccess,
  onQueueRefreshNeeded,
}: ApprovalConfirmModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('Owner voided hold from dashboard');

  if (!request) return null;

  const isApprove = mode === 'APPROVE';

  const handleAction = async () => {
    if (isSubmitting) return; // Prevent duplicate submission
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      if (isApprove) {
        // Pre-flight check: lockout if hold expired while modal was open
        const check = canApproveHold(request);
        if (!check.allowed) {
          if (check.reason === 'HOLD_EXPIRED') {
            setErrorMessage('HOLD_EXPIRED: Payment hold has expired and cannot be approved. Queue will refresh.');
            onQueueRefreshNeeded?.();
          } else {
            setErrorMessage(`Cannot approve hold: ${check.reason}`);
          }
          setIsSubmitting(false);
          return;
        }

        const res = await apiClient.post<ApprovePaymentResponse>(`/api/requests/${request.id}/approve`);
        if (res.status === 'CAPTURED') {
          onSuccess({
            type: 'APPROVE',
            message: `Payment request approved and captured successfully. Capture ID: ${res.captureId ?? 'N/A'}`,
            details: {
              status: res.status,
              captureId: res.captureId,
            },
          });
        } else {
          // Status may be CAPTURING or awaiting reconciliation
          onSuccess({
            type: 'APPROVE',
            message: res.warning || `Payment approval recorded (status: ${res.status}). Awaiting capture reconciliation.`,
            details: {
              status: res.status,
              warning: res.warning,
            },
          });
        }
      } else {
        const payload = {
          reason: voidReason.trim() ? voidReason.trim() : undefined,
        };
        const res = await apiClient.post<VoidPaymentResponse>(`/api/requests/${request.id}/void`, payload);
        const remoteStatus = res.remoteVoidStatus ? ` (Remote: ${res.remoteVoidStatus})` : '';
        onSuccess({
          type: 'VOID',
          message: res.message || `Payment request voided successfully${remoteStatus}. Reserved budget released.`,
          details: {
            status: res.status,
            remoteVoidStatus: res.remoteVoidStatus,
          },
        });
      }
      onClose();
    } catch (err: unknown) {
      const parsed = resolveActionErrorMessage(err);
      setErrorMessage(parsed.message);
      if (parsed.shouldRefreshQueue && onQueueRefreshNeeded) {
        onQueueRefreshNeeded();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onClose();
      }}
      title={isApprove ? 'Confirm Payment Capture' : 'Confirm Payment Void'}
      description={
        isApprove
          ? 'Authorize Flow C capture on the PayPal Sandbox'
          : 'Cancel payment hold and release reserved funds'
      }
      maxWidth="md"
    >
      <div className="space-y-4">
        {/* Payment Summary Box */}
        <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-secondary)]">Amount to {isApprove ? 'Capture' : 'Void'}</span>
            <span className="font-sans text-xl font-bold text-[var(--text-primary)]">
              {formatUsdFromMinor(request.amountMinor)} {request.currency}
            </span>
          </div>

          <div className="pt-2 border-t border-[var(--border-color)] grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-[var(--text-secondary)] flex items-center gap-1 mb-0.5">
                <Store className="h-3 w-3" /> Vendor
              </span>
              <span className="font-medium text-[var(--text-primary)]">{request.vendorName}</span>
            </div>
            <div>
              <span className="text-[var(--text-secondary)] flex items-center gap-1 mb-0.5">
                <Bot className="h-3 w-3" /> Requesting Agent
              </span>
              <span className="font-medium text-[var(--text-primary)]">{request.agentName}</span>
            </div>
          </div>

          {request.purpose && (
            <div className="pt-2 border-t border-[var(--border-color)] text-xs">
              <span className="text-[var(--text-secondary)] block mb-0.5">Purpose:</span>
              <span className="text-[var(--text-primary)]/90">{request.purpose}</span>
            </div>
          )}
        </div>

        {/* Warning / Explanation Message */}
        {isApprove ? (
          <div className="rounded-xl bg-[#B8D99A]/10 border border-[#B8D99A]/20 p-3.5 text-xs text-[var(--text-primary)] flex items-start gap-2.5">
            <AlertTriangle className="h-4 w-4 text-[#B8D99A] shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium text-[#B8D99A]">Financial Authorization Action</p>
              <p className="text-[var(--text-secondary)] leading-relaxed">
                Approving will immediately trigger real money capture against the merchant’s sandbox account via
                executeDecision (Flow C). Once captured, the reservation will convert to an immutable spend record.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl bg-[#E5989B]/10 border border-[#E5989B]/20 p-3.5 text-xs text-[var(--text-primary)] flex items-start gap-2.5">
              <AlertTriangle className="h-4 w-4 text-[#E5989B] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-medium text-[#E5989B]">Void &amp; Release Action</p>
                <p className="text-[var(--text-secondary)] leading-relaxed">
                  Voiding will immediately transition the request to VOIDED, release the reserved budget back into the
                  agent and global daily pools, and trigger remote PayPal authorization cancellation.
                </p>
              </div>
            </div>

            {/* Optional Reason Memo */}
            <div>
              <Input
                label="Void Reason Memo (Optional)"
                placeholder="e.g. Unverified vendor, duplicate agent task, or owner rejection"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                disabled={isSubmitting}
                hint="Recorded in the cryptographic audit log row for this void transition."
              />
            </div>
          </div>
        )}

        {/* Error Alert */}
        {errorMessage && (
          <div className="rounded-xl bg-[#E5989B]/15 border border-[#E5989B]/30 p-3 text-xs text-[#E5989B] flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>{errorMessage}</div>
          </div>
        )}

        {/* Modal Actions */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--border-color)]">
          <Button
            variant="ghost"
            size="md"
            onClick={onClose}
            disabled={isSubmitting}
            className="text-xs min-h-[44px]"
          >
            Cancel
          </Button>

          {isApprove ? (
            <Button
              variant="primary"
              size="md"
              onClick={handleAction}
              isLoading={isSubmitting}
              className="text-xs font-semibold px-5 min-h-[44px]"
            >
              <CheckCircle2 className="h-4 w-4 mr-1.5" />
              Confirm &amp; Capture
            </Button>
          ) : (
            <Button
              variant="danger"
              size="md"
              onClick={handleAction}
              isLoading={isSubmitting}
              className="text-xs font-semibold px-5 min-h-[44px]"
            >
              <XCircle className="h-4 w-4 mr-1.5" />
              Confirm Void
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
