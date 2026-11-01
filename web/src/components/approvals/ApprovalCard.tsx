import { useEffect, useState } from 'react';
import {
  Clock,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Eye,
  Bot,
  Store,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import { PaymentRequestSummary } from '../../types/api';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { formatUsdFromMinor, formatDateTime, getReasonLabel } from '../../lib/formatters';
import {
  isHoldExpired,
  calculateRemainingHoldMs,
  formatHoldCountdown,
  separatePolicyAndAiReasons,
} from '../../lib/approvalUtils';

export interface ApprovalCardProps {
  request: PaymentRequestSummary;
  onApprove: (request: PaymentRequestSummary) => void;
  onVoid: (request: PaymentRequestSummary) => void;
  onInspect: (requestId: string) => void;
}

export function ApprovalCard({ request, onApprove, onVoid, onInspect }: ApprovalCardProps) {
  const [nowMs, setNowMs] = useState(Date.now());

  // Live timer tick for hold expiry countdown
  useEffect(() => {
    if (!request.expiresAt) return;
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [request.expiresAt]);

  const expired = isHoldExpired(request.expiresAt, nowMs);
  const remainingMs = calculateRemainingHoldMs(request.expiresAt, nowMs);
  const countdownText = formatHoldCountdown(remainingMs);

  const { policyReasons, aiReasons } = separatePolicyAndAiReasons(request.reasons);

  // Approximate total duration (15 min standard hold)
  const createdAtMs = new Date(request.createdAt).getTime();
  const expiresAtMs = request.expiresAt ? new Date(request.expiresAt).getTime() : 0;
  const totalDurationMs = expiresAtMs > createdAtMs ? expiresAtMs - createdAtMs : 15 * 60 * 1000;
  const percentRemaining = Math.max(0, Math.min(100, Math.round((remainingMs / totalDurationMs) * 100)));

  return (
    <div
      className={`rounded-2xl bg-[var(--card-bg)] border p-6 transition-all shadow-md ${
        expired
          ? 'border-[var(--border-color)] opacity-75'
          : 'border-[var(--border-color)] hover:border-[#E8B5A0]/60'
      }`}
    >
      {/* Top Header: Vendor, Agent, Status */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--border-color)]">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] flex items-center justify-center text-[var(--text-primary)] shrink-0">
            <Store className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-[var(--text-primary)] text-base">{request.vendorName}</h3>
              <Badge status={request.status} />
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-xs text-[var(--text-secondary)]">
              <span className="flex items-center gap-1">
                <Bot className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
                {request.agentName}
              </span>
              <span>•</span>
              <span className="font-mono text-[11px]">{formatDateTime(request.createdAt)}</span>
            </div>
          </div>
        </div>

        {/* Expiry Badge / Countdown */}
        <div className="flex items-center sm:justify-end">
          {request.expiresAt ? (
            expired ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium bg-[#E5989B]/15 text-[#E5989B] border border-[#E5989B]/30">
                <AlertTriangle className="h-3.5 w-3.5" />
                Hold Expired
              </span>
            ) : (
              <div className="text-right">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium bg-[#E8B5A0]/15 text-[#E8B5A0] border border-[#E8B5A0]/30 animate-pulse">
                  <Clock className="h-3.5 w-3.5" />
                  {countdownText} remaining
                </span>
                <div className="w-28 h-1 bg-[var(--elevated-bg)] rounded-full mt-1.5 overflow-hidden ml-auto">
                  <div
                    className="h-full bg-[#E8B5A0] transition-all duration-1000"
                    style={{ width: `${percentRemaining}%` }}
                  />
                </div>
              </div>
            )
          ) : (
            <span className="text-xs text-[var(--text-secondary)] font-mono">No TTL set</span>
          )}
        </div>
      </div>

      {/* Main Body: Amount & Purpose */}
      <div className="py-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
          <div>
            <div className="font-sans text-3xl font-bold tracking-tight text-[var(--text-primary)]">
              {formatUsdFromMinor(request.amountMinor)}
            </div>
            <div className="text-[11px] font-mono text-[var(--text-secondary)] uppercase mt-0.5">
              {request.currency} • PayPal Sandbox Authorized
            </div>
          </div>
          {request.category && (
            <div className="self-start sm:self-auto">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-lg text-xs font-mono bg-[var(--elevated-bg)] text-[var(--text-primary)] border border-[var(--border-color)]">
                Category: {request.category}
              </span>
            </div>
          )}
        </div>

        {/* Purpose */}
        <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-3 text-xs text-[var(--text-primary)]/90 leading-relaxed">
          <span className="text-[var(--text-secondary)] font-medium mr-1.5">Purpose:</span>
          {request.purpose || 'No purpose description provided'}
        </div>

        {/* Authoritative Policy Reasons */}
        {policyReasons.length > 0 && (
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center gap-1.5 text-xs font-medium text-[#E8B5A0]">
              <ShieldAlert className="h-3.5 w-3.5" />
              <span>Policy Triggers (Authoritative):</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {policyReasons.map((reason) => (
                <span
                  key={reason}
                  className="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-medium bg-[#E8B5A0]/10 text-[#E8B5A0] border border-[#E8B5A0]/25"
                >
                  {getReasonLabel(reason)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Visually Separated AI Risk Explainer Summary (Not Authoritative) */}
        {aiReasons.length > 0 && (
          <div className="rounded-xl bg-[#BBA9D8]/5 border border-[#BBA9D8]/20 p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[#BBA9D8]">
                <Sparkles className="h-3.5 w-3.5" />
                <span>AI Risk Explainer</span>
              </div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-secondary)] bg-[var(--elevated-bg)] px-2 py-0.5 rounded-md border border-[var(--border-color)]">
                Advisory Only • Non-Authoritative
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Flagged by heuristic/risk model for manual review. AI recommendations cannot remove policy restrictions
              under Hard Rule 6.
            </p>
          </div>
        )}

        {expired && (
          <div className="rounded-xl bg-[#E5989B]/10 border border-[#E5989B]/25 p-3 text-xs text-[#E5989B] flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">Hold window exceeded:</span> This payment hold has expired. The backend
              policy engine will fail closed and reject approval. You may void this request to release any reserved
              commitments.
            </div>
          </div>
        )}
      </div>

      {/* Footer Actions: Touch targets >= 44px */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-4 border-t border-[var(--border-color)]">
        <Button
          variant="ghost"
          size="md"
          onClick={() => onInspect(request.id)}
          className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] min-h-[44px] justify-center sm:justify-start"
        >
          <Eye className="h-4 w-4 mr-2" />
          Inspect Details
        </Button>

        <div className="flex items-center gap-2">
          <Button
            variant="danger"
            size="md"
            onClick={() => onVoid(request)}
            className="flex-1 sm:flex-initial min-h-[44px] text-xs font-semibold px-4"
          >
            <XCircle className="h-4 w-4 mr-1.5" />
            Void Payment
          </Button>

          <Button
            variant="primary"
            size="md"
            disabled={expired}
            onClick={() => onApprove(request)}
            className="flex-1 sm:flex-initial min-h-[44px] text-xs font-semibold px-5"
          >
            <CheckCircle2 className="h-4 w-4 mr-1.5" />
            Approve &amp; Capture
          </Button>
        </div>
      </div>
    </div>
  );
}

