import { useEffect, useState, useCallback } from 'react';
import {
  ArrowLeft,
  Clock,
  Store,
  Bot,
  FileText,
  CheckCircle2,
  XCircle,
  AlertCircle,
  AlertTriangle,
  RotateCw,
  Copy,
  Check,
  Activity,
  Layers,
  ShieldAlert,
} from 'lucide-react';
import {
  PaymentRequestDetail,
  PaymentRequestSummary,
} from '../types/api';
import { apiClient, ApiError } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { formatCurrencyFromMinor, formatDateTime, getReasonLabel } from '../lib/formatters';
import {
  isHoldExpired,
  calculateRemainingHoldMs,
  formatHoldCountdown,
  resolveActionOutcome,
} from '../lib/approvalUtils';
import { ApprovalConfirmModal } from '../components/approvals/ApprovalConfirmModal';

export interface PaymentDetailPageProps {
  requestId: string;
  onBack: () => void;
}

interface ActionOutcome {
  type: 'APPROVE' | 'VOID' | 'ERROR';
  headline: string;
  message: string;
  isAmbiguous?: boolean;
}

export function PaymentDetailPage({ requestId, onBack }: PaymentDetailPageProps) {
  const [detail, setDetail] = useState<PaymentRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  // Approval and Void Modal State (reuses M4-T8 modal)
  const [modalMode, setModalMode] = useState<'APPROVE' | 'VOID' | null>(null);
  const [outcomeBanner, setOutcomeBanner] = useState<ActionOutcome | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!requestId) return;
    setLoading(true);
    setErrorStatus(null);
    setErrorMessage(null);

    try {
      const data = await apiClient.get<PaymentRequestDetail>(`/api/requests/${requestId}`);
      setDetail(data);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorStatus(err.status);
        if (err.status === 404) {
          setErrorMessage('Payment request not found. The ID may be invalid or does not exist.');
        } else if (err.status === 401) {
          setErrorMessage('Your session has expired. Please authenticate to view request details.');
        } else if (err.status === 403) {
          setErrorMessage('Access forbidden. You do not have permission to view this payment request.');
        } else {
          setErrorMessage(err.message || `Failed to retrieve request (HTTP ${err.status})`);
        }
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Failed to load payment details due to a network error.');
      }
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  // Live timer for active hold countdown
  useEffect(() => {
    if (!detail?.expiresAt || detail.status !== 'HELD') return;
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [detail?.expiresAt, detail?.status]);

  const copyRequestId = () => {
    if (!detail?.id) return;
    navigator.clipboard.writeText(detail.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleActionSuccess = (result: {
    type: 'APPROVE' | 'VOID';
    message: string;
    details?: {
      status?: string;
      captureId?: string;
      remoteVoidStatus?: 'CONFIRMED' | 'PENDING' | 'FAILED';
      warning?: string;
    };
  }) => {
    const outcome = resolveActionOutcome(result.type, result.details, result.message);
    setOutcomeBanner({
      type: outcome.type,
      headline: outcome.headline,
      message: outcome.message,
      isAmbiguous: outcome.isAmbiguous,
    });
    setModalMode(null);
    fetchDetail();
  };

  // Convert detail to summary for ApprovalConfirmModal reuse
  const summaryForModal: PaymentRequestSummary | null = detail
    ? {
        id: detail.id,
        agentId: detail.agent.id,
        agentName: detail.agent.name,
        vendorId: detail.vendor.id,
        vendorName: detail.vendor.name,
        amountMinor: detail.amount.amountMinor,
        amountDecimal: detail.amount.amountDecimal,
        currency: detail.amount.currency,
        purpose: detail.purpose,
        category: detail.category,
        status: detail.status,
        decision: detail.decision,
        reasons: detail.reasons,
        createdAt: detail.createdAt,
        expiresAt: detail.expiresAt,
      }
    : null;

  const expired = detail?.expiresAt ? isHoldExpired(detail.expiresAt, nowMs) : false;
  const remainingMs = detail?.expiresAt ? calculateRemainingHoldMs(detail.expiresAt, nowMs) : 0;
  const countdownText = formatHoldCountdown(remainingMs);

  // Inspect timeline for verified AI events per user correction 2
  const verifiedAiEvents = (detail?.timeline || []).filter(
    (ev) => ev.actor === 'ai' || ev.event.toUpperCase().startsWith('AI_')
  );

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      {/* Top Breadcrumb & Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors self-start min-h-[40px] px-2"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back</span>
        </button>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={fetchDetail}
            disabled={loading}
            className="text-xs min-h-[40px] px-3.5"
          >
            <RotateCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh Details
          </Button>
        </div>
      </div>

      {/* Outcome Banner (Approve/Void Feedback) */}
      {outcomeBanner && (
        <div
          className={`rounded-2xl p-4 border flex items-start justify-between gap-3 shadow-lg transition-all ${
            outcomeBanner.isAmbiguous
              ? 'bg-[#BBA9D8]/10 border-[#BBA9D8]/30 text-[var(--text-primary)]'
              : outcomeBanner.type === 'APPROVE'
              ? 'bg-[#B8D99A]/15 border-[#B8D99A]/30 text-[var(--text-primary)]'
              : 'bg-[#E5989B]/15 border-[#E5989B]/30 text-[var(--text-primary)]'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {outcomeBanner.isAmbiguous ? (
              <AlertTriangle className="h-5 w-5 text-[#BBA9D8] shrink-0 mt-0.5" />
            ) : outcomeBanner.type === 'APPROVE' ? (
              <CheckCircle2 className="h-5 w-5 text-[#B8D99A] shrink-0 mt-0.5" />
            ) : (
              <XCircle className="h-5 w-5 text-[#E5989B] shrink-0 mt-0.5" />
            )}
            <div className="space-y-0.5 text-xs">
              <span className="font-semibold block">{outcomeBanner.headline}</span>
              <p className="text-[var(--text-secondary)]">{outcomeBanner.message}</p>
            </div>
          </div>
          <button
            onClick={() => setOutcomeBanner(null)}
            className="text-[var(--text-secondary)] hover:text-[var(--text-primary)] p-1 rounded-lg"
            aria-label="Dismiss banner"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && !detail && (
        <div className="space-y-4 animate-pulse">
          <div className="rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-4">
            <div className="h-6 w-48 bg-[var(--elevated-bg)] rounded" />
            <div className="h-10 w-36 bg-[var(--elevated-bg)] rounded" />
            <div className="h-4 w-full bg-[var(--elevated-bg)] rounded" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 h-36" />
            <div className="rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 h-36" />
          </div>
        </div>
      )}

      {/* Error States (404, 401, 403, 500) */}
      {!loading && errorStatus && (
        <div className="rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-12 text-center flex flex-col items-center justify-center space-y-4">
          <div className="h-14 w-14 rounded-2xl bg-[#E5989B]/10 border border-[#E5989B]/20 flex items-center justify-center text-[#E5989B]">
            <AlertCircle className="h-7 w-7" />
          </div>
          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">
              {errorStatus === 404
                ? 'Payment Request Not Found'
                : errorStatus === 401
                ? 'Authentication Required'
                : errorStatus === 403
                ? 'Access Denied'
                : 'Unable to Load Request'}
            </h3>
            <p className="text-xs text-[var(--text-secondary)] max-w-md">{errorMessage}</p>
          </div>
          <div className="pt-2 flex items-center gap-3">
            <Button variant="secondary" size="sm" onClick={onBack} className="text-xs min-h-[40px] px-4">
              Return to Previous View
            </Button>
            {errorStatus !== 404 && (
              <Button variant="primary" size="sm" onClick={fetchDetail} className="text-xs min-h-[40px] px-4">
                Retry
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Main Request Detail Content */}
      {detail && (
        <div className="space-y-6">
          {/* Header Card: ID, Status, Amount, Actions */}
          <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-6 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-5 border-b border-[var(--border-color)]">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--text-secondary)]">Payment Request</span>
                  <button
                    type="button"
                    onClick={copyRequestId}
                    className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--elevated-bg)] border border-[var(--border-color)] text-xs font-mono text-[var(--text-primary)] hover:text-[#B8D99A] transition-colors"
                    title="Click to copy ID"
                  >
                    <span>{detail.id}</span>
                    {copied ? <Check className="h-3 w-3 text-[#B8D99A]" /> : <Copy className="h-3 w-3 text-[var(--text-secondary)]" />}
                  </button>
                </div>
                <div className="text-xs text-[var(--text-secondary)]">
                  Created {formatDateTime(detail.createdAt)} • Updated {formatDateTime(detail.updatedAt)}
                </div>
              </div>

              {/* Status and Decision Badges */}
              <div className="flex items-center gap-2">
                <Badge status={detail.status} />
                {detail.decision && (
                  <span className="px-2.5 py-0.5 rounded-full font-mono text-[11px] font-medium uppercase border border-[var(--border-color)] bg-[var(--elevated-bg)] text-[var(--text-secondary)]">
                    Dec: <strong className="text-[var(--text-primary)]">{detail.decision}</strong>
                  </span>
                )}
                {detail.policyVersionId && (
                  <span className="px-2 py-0.5 rounded-md font-mono text-[11px] bg-[var(--elevated-bg)] text-[var(--text-primary)] border border-[var(--border-color)]">
                    Policy: {detail.policyVersionId}
                  </span>
                )}
              </div>
            </div>

            {/* Financial & Expiry Row */}
            <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-4">
              <div>
                <span className="text-xs font-medium tracking-wider uppercase text-[var(--text-secondary)]">Requested Amount</span>
                <div className="font-sans text-4xl font-bold tracking-tight text-[var(--text-primary)] mt-0.5">
                  {formatCurrencyFromMinor(detail.amount.amountMinor, detail.amount.currency)}
                </div>
                <div className="text-xs font-mono text-[var(--text-secondary)] uppercase mt-1">
                  Currency: {detail.amount.currency} ({detail.amount.amountDecimal})
                </div>
              </div>

              {/* Hold Expiry Countdown (if applicable) */}
              {detail.expiresAt && detail.status === 'HELD' && (
                <div className="self-start sm:self-auto text-left sm:text-right">
                  {expired ? (
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium bg-[#E5989B]/15 text-[#E5989B] border border-[#E5989B]/30">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Hold Window Expired
                    </span>
                  ) : (
                    <div className="space-y-1">
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-medium bg-[#E8B5A0]/15 text-[#E8B5A0] border border-[#E8B5A0]/30 animate-pulse">
                        <Clock className="h-3.5 w-3.5" />
                        {countdownText} remaining
                      </span>
                      <p className="text-[11px] text-[var(--text-secondary)]">
                        Expires at {formatDateTime(detail.expiresAt)}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Purpose */}
            <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-4 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[var(--text-primary)]">Purpose Description</span>
                {detail.category && (
                  <span className="px-2 py-0.5 rounded-lg text-xs font-mono bg-[var(--card-bg)] text-[var(--text-primary)] border border-[var(--border-color)]">
                    Category: {detail.category}
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--text-primary)]/90 leading-relaxed">
                {detail.purpose || 'No purpose description provided'}
              </p>
            </div>

            {/* Inline Owner Actions if HELD */}
            {detail.status === 'HELD' && (
              <div className="pt-4 border-t border-[var(--border-color)] flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-3">
                <Button
                  variant="danger"
                  size="md"
                  onClick={() => setModalMode('VOID')}
                  className="min-h-[44px] text-xs font-semibold px-4"
                >
                  <XCircle className="h-4 w-4 mr-1.5" />
                  Void Payment Hold
                </Button>

                <Button
                  variant="primary"
                  size="md"
                  disabled={expired}
                  onClick={() => setModalMode('APPROVE')}
                  className="min-h-[44px] text-xs font-semibold px-5"
                >
                  <CheckCircle2 className="h-4 w-4 mr-1.5" />
                  Approve &amp; Capture
                </Button>
              </div>
            )}
          </div>

          {/* Context Cards: Agent & Vendor */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Agent Context */}
            <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] flex items-center justify-center text-[var(--text-secondary)]">
                  <Bot className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-secondary)]">Requesting Agent</span>
                  <h4 className="text-sm font-semibold text-[var(--text-primary)]">{detail.agent.name}</h4>
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] font-mono text-xs text-[var(--text-secondary)]">
                <span className="text-[10px] font-medium uppercase tracking-wider block mb-0.5">Agent Identifier</span>
                <span className="text-[var(--text-primary)] select-all">{detail.agent.id}</span>
              </div>
            </div>

            {/* Vendor Context */}
            <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] flex items-center justify-center text-[var(--text-secondary)]">
                  <Store className="h-5 w-5" />
                </div>
                <div>
                  <span className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-secondary)]">Payee Vendor</span>
                  <h4 className="text-sm font-semibold text-[var(--text-primary)]">{detail.vendor.name}</h4>
                </div>
              </div>
              <div className="p-3 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] font-mono text-xs text-[var(--text-secondary)]">
                <span className="text-[10px] font-medium uppercase tracking-wider block mb-0.5">Vendor Identifier</span>
                <span className="text-[var(--text-primary)] select-all">{detail.vendor.id}</span>
              </div>
            </div>
          </div>

          {/* Raw Source Context Excerpt (Rendered as normal React text per user correction 6) */}
          {detail.sourceContextExcerpt && (
            <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                  <FileText className="h-4 w-4 text-[#B8D99A]" />
                  Agent Source Context Excerpt
                </span>
                <span className="text-[10px] font-mono text-[var(--text-secondary)]">Raw Captured Input</span>
              </div>
              <pre className="font-mono text-xs overflow-x-auto p-4 bg-[var(--elevated-bg)] border border-[var(--border-color)] rounded-xl text-[var(--text-primary)] whitespace-pre-wrap break-all leading-relaxed">
                {detail.sourceContextExcerpt}
              </pre>
            </div>
          )}

          {/* Policy Evaluation Reasons */}
          {detail.reasons && detail.reasons.length > 0 && (
            <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-3">
              <span className="text-xs font-semibold text-[#E8B5A0] flex items-center gap-1.5">
                <ShieldAlert className="h-4 w-4" />
                Policy Decision Triggers
              </span>
              <div className="flex flex-wrap gap-2">
                {detail.reasons.map((code) => (
                  <span
                    key={code}
                    className="px-3 py-1.5 rounded-xl text-xs font-medium bg-[#E8B5A0]/10 text-[#E8B5A0] border border-[#E8B5A0]/25"
                  >
                    {getReasonLabel(code)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Verified AI Events */}
          {verifiedAiEvents.length > 0 && (
            <div className="rounded-2xl bg-[var(--card-bg)] border border-[#BBA9D8]/30 p-6 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#BBA9D8] flex items-center gap-1.5">
                  <Activity className="h-4 w-4" />
                  Verified AI Advisory Events
                </span>
                <span className="text-[10px] font-mono text-[var(--text-secondary)] bg-[var(--elevated-bg)] px-2 py-0.5 rounded border border-[var(--border-color)]">
                  Non-Authoritative
                </span>
              </div>
              <div className="space-y-2">
                {verifiedAiEvents.map((ev, idx) => (
                  <div key={ev.id || idx} className="p-3 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] text-xs space-y-1">
                    <div className="flex items-center justify-between font-mono">
                      <span className="text-[#BBA9D8] font-semibold">{ev.event}</span>
                      <span className="text-[10px] text-[var(--text-secondary)]">{formatDateTime(ev.timestamp)}</span>
                    </div>
                    {ev.payload && Object.keys(ev.payload).length > 0 && (
                      <pre className="text-[10px] text-[var(--text-secondary)] font-mono pt-1">
                        {JSON.stringify(ev.payload, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* External PayPal Identifiers */}
          {(detail.paypalOrderId ||
            detail.paypalAuthorizationId ||
            detail.paypalCaptureId ||
            detail.remoteVoidStatus) && (
            <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-3">
              <span className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Layers className="h-4 w-4 text-[#B8D99A]" />
                PayPal Sandbox External Identifiers
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
                {detail.paypalOrderId && (
                  <div className="p-3 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)]">
                    <span className="text-[var(--text-secondary)] block text-[10px] uppercase">PayPal Order ID</span>
                    <span className="text-[var(--text-primary)] select-all font-semibold">{detail.paypalOrderId}</span>
                  </div>
                )}
                {detail.paypalAuthorizationId && (
                  <div className="p-3 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)]">
                    <span className="text-[var(--text-secondary)] block text-[10px] uppercase">Authorization ID</span>
                    <span className="text-[var(--text-primary)] select-all font-semibold">{detail.paypalAuthorizationId}</span>
                  </div>
                )}
                {detail.paypalCaptureId && (
                  <div className="p-3 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)]">
                    <span className="text-[var(--text-secondary)] block text-[10px] uppercase">Capture ID</span>
                    <span className="text-[#B8D99A] select-all font-semibold">{detail.paypalCaptureId}</span>
                  </div>
                )}
                {detail.remoteVoidStatus && (
                  <div className="p-3 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)]">
                    <span className="text-[var(--text-secondary)] block text-[10px] uppercase">Remote Void Status</span>
                    <span className="text-[var(--text-primary)] font-semibold">{detail.remoteVoidStatus}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Internal Ledger Trail */}
          {detail.ledger && detail.ledger.length > 0 && (
            <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-3">
              <span className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Activity className="h-4 w-4 text-[#B8D99A]" />
                Internal Ledger Entries
              </span>
              <div className="divide-y divide-[var(--border-color)]">
                {detail.ledger.map((entry) => (
                  <div key={entry.id} className="py-2.5 flex items-center justify-between text-xs font-mono">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                          entry.kind === 'SPEND'
                            ? 'bg-[#B8D99A]/15 text-[#B8D99A]'
                            : entry.kind === 'RESERVE'
                            ? 'bg-[#E8B5A0]/15 text-[#E8B5A0]'
                            : 'bg-[#A0A0A0]/15 text-[#A0A0A0]'
                        }`}
                      >
                        {entry.kind}
                      </span>
                      <span className="text-[var(--text-secondary)]">{entry.id}</span>
                    </div>
                    <div className="text-right">
                      <span className="font-sans text-[var(--text-primary)] font-semibold">
                        {formatCurrencyFromMinor(entry.amountMinor, entry.currency)}
                      </span>
                      <span className="text-[var(--text-secondary)] text-[10px] block">{formatDateTime(entry.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Audit Timeline */}
          {detail.timeline && detail.timeline.length > 0 && (
            <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                  <Activity className="h-4 w-4 text-[#B8D99A]" />
                  Audit Timeline
                </span>
                <span className="text-[10px] font-mono text-[var(--text-secondary)]">
                  {detail.timeline.length} {detail.timeline.length === 1 ? 'event' : 'events'}
                </span>
              </div>
              <div className="space-y-2">
                {detail.timeline.map((event, idx) => (
                  <div
                    key={event.id || idx}
                    className="p-3.5 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] text-xs font-mono space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--text-primary)]">{event.event}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--card-bg)] text-[var(--text-secondary)] border border-[var(--border-color)]">
                          actor: {event.actor}
                        </span>
                      </div>
                      <span className="text-[10px] text-[var(--text-secondary)]">{formatDateTime(event.timestamp)}</span>
                    </div>
                    {event.payload && Object.keys(event.payload).length > 0 && (
                      <pre className="text-[10px] text-[var(--text-secondary)] overflow-x-auto pt-1 border-t border-[var(--border-color)]">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Confirmation Modal (Reusing verified M4-T8 component) */}
      {modalMode && summaryForModal && (
        <ApprovalConfirmModal
          isOpen={true}
          mode={modalMode}
          request={summaryForModal}
          onClose={() => setModalMode(null)}
          onSuccess={handleActionSuccess}
          onQueueRefreshNeeded={fetchDetail}
        />
      )}
    </div>
  );
}

