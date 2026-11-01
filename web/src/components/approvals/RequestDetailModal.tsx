import { useEffect, useState } from 'react';
import {
  ShieldCheck,
  Store,
  Bot,
  FileText,
  DollarSign,
  Layers,
  Sparkles,
  Activity,
  AlertCircle,
} from 'lucide-react';
import { PaymentRequestDetail } from '../../types/api';
import { apiClient, ApiError } from '../../lib/api';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { formatUsdFromMinor, formatDateTime, getReasonLabel } from '../../lib/formatters';
import { separatePolicyAndAiReasons } from '../../lib/approvalUtils';

export interface RequestDetailModalProps {
  isOpen: boolean;
  requestId: string | null;
  onClose: () => void;
}

export function RequestDetailModal({ isOpen, requestId, onClose }: RequestDetailModalProps) {
  const [detail, setDetail] = useState<PaymentRequestDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !requestId) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(true);
    setError(null);

    apiClient
      .get<PaymentRequestDetail>(`/api/requests/${requestId}`)
      .then((data) => {
        if (isMounted) setDetail(data);
      })
      .catch((err: unknown) => {
        if (isMounted) {
          if (err instanceof ApiError) {
            setError(err.message);
          } else if (err instanceof Error) {
            setError(err.message);
          } else {
            setError('Failed to load request details');
          }
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [requestId, isOpen]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Payment Request Audit Inspection"
      description={requestId ? `Authoritative audit trail and state record for #${requestId}` : undefined}
      maxWidth="xl"
    >
      {loading && (
        <div className="py-12 flex flex-col items-center justify-center space-y-3">
          <div className="h-7 w-7 rounded-full border-2 border-[var(--text-primary)] border-t-transparent animate-spin" />
          <p className="text-xs text-[var(--text-secondary)]">Loading request details &amp; audit history...</p>
        </div>
      )}

      {error && !loading && (
        <div className="rounded-xl bg-[#E5989B]/15 border border-[#E5989B]/30 p-4 text-xs text-[#E5989B] flex items-start gap-2.5">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Unable to fetch details</p>
            <p className="text-[#E5989B]/80 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {detail && !loading && (
        <div className="space-y-6 max-h-[75vh] overflow-y-auto pr-1">
          {/* Top Overview Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Amount */}
            <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-3.5">
              <span className="text-[11px] font-medium tracking-wider uppercase text-[var(--text-secondary)] flex items-center gap-1">
                <DollarSign className="h-3 w-3 text-[#B8D99A]" /> Amount
              </span>
              <div className="font-sans text-xl font-bold text-[var(--text-primary)] mt-1">
                {formatUsdFromMinor(detail.amount.amountMinor)}
              </div>
              <div className="text-[10px] font-mono text-[var(--text-secondary)] uppercase mt-0.5">
                {detail.amount.currency} ({detail.amount.amountDecimal})
              </div>
            </div>

            {/* Status & Decision */}
            <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-3.5">
              <span className="text-[11px] font-medium tracking-wider uppercase text-[var(--text-secondary)] flex items-center gap-1">
                <ShieldCheck className="h-3 w-3 text-[#E8B5A0]" /> Current State
              </span>
              <div className="mt-1 flex items-center gap-2">
                <Badge status={detail.status} />
                {detail.decision && (
                  <span className="text-xs font-mono text-[var(--text-secondary)]">
                    Dec: <strong className="text-[var(--text-primary)]">{detail.decision}</strong>
                  </span>
                )}
              </div>
              <div className="text-[10px] font-mono text-[var(--text-secondary)] mt-1">
                Created: {formatDateTime(detail.createdAt)}
              </div>
            </div>

            {/* Entity Context */}
            <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-3.5">
              <span className="text-[11px] font-medium tracking-wider uppercase text-[var(--text-secondary)] flex items-center gap-1">
                <Layers className="h-3 w-3 text-[#BBA9D8]" /> Parties
              </span>
              <div className="mt-1 text-xs text-[var(--text-primary)] space-y-0.5">
                <div className="flex items-center gap-1 truncate">
                  <Store className="h-3 w-3 text-[var(--text-secondary)] shrink-0" />
                  <span className="truncate">{detail.vendor.name}</span>
                </div>
                <div className="flex items-center gap-1 truncate">
                  <Bot className="h-3 w-3 text-[var(--text-secondary)] shrink-0" />
                  <span className="truncate">{detail.agent.name}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Purpose & Category */}
          <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-[var(--text-primary)]">Payment Purpose</span>
              {detail.category && (
                <span className="px-2 py-0.5 rounded-lg text-[11px] font-mono bg-[var(--card-bg)] text-[var(--text-primary)] border border-[var(--border-color)]">
                  Category: {detail.category}
                </span>
              )}
            </div>
            <p className="text-xs text-[var(--text-primary)]/90 leading-relaxed">{detail.purpose || 'No purpose provided'}</p>
          </div>

          {/* Source Context Excerpt */}
          {detail.sourceContextExcerpt && (
            <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5 text-[#B8D99A]" />
                  Agent Source Context Excerpt
                </span>
                <span className="text-[10px] font-mono text-[var(--text-secondary)]">Raw Captured Input</span>
              </div>
              <pre className="font-mono text-[11px] overflow-x-auto p-3 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl text-[var(--text-primary)] whitespace-pre-wrap break-all leading-relaxed">
                {detail.sourceContextExcerpt}
              </pre>
            </div>
          )}

          {/* Policy Decision Reasons vs AI Explainer */}
          {(() => {
            const { policyReasons, aiReasons } = separatePolicyAndAiReasons(detail.reasons);
            return (
              <div className="space-y-3">
                {policyReasons.length > 0 && (
                  <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-4 space-y-2">
                    <span className="text-xs font-semibold text-[#E8B5A0] flex items-center gap-1.5">
                      <ShieldCheck className="h-3.5 w-3.5" />
                      Deterministic Policy Reasons (Authoritative)
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {policyReasons.map((r) => (
                        <span
                          key={r}
                          className="px-2.5 py-1 rounded-lg text-xs font-medium bg-[#E8B5A0]/10 text-[#E8B5A0] border border-[#E8B5A0]/25"
                        >
                          {getReasonLabel(r)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {aiReasons.length > 0 && (
                  <div className="rounded-xl bg-[#BBA9D8]/5 border border-[#BBA9D8]/20 p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#BBA9D8] flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5" />
                        AI Risk Explainer (Advisory)
                      </span>
                      <span className="text-[10px] font-mono text-[var(--text-secondary)] bg-[var(--elevated-bg)] px-2 py-0.5 rounded border border-[var(--border-color)]">
                        Non-Authoritative
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)]">
                      Evaluated by risk analysis model. Per AGENTS.md Hard Rule 6, AI output is advisory and cannot
                      remove or relax any deterministic policy restriction.
                    </p>
                  </div>
                )}
              </div>
            );
          })()}

          {/* External PayPal References */}
          {(detail.paypalOrderId ||
            detail.paypalAuthorizationId ||
            detail.paypalCaptureId ||
            detail.remoteVoidStatus) && (
            <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-4 space-y-2.5">
              <span className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Layers className="h-3.5 w-3.5 text-[#B8D99A]" />
                PayPal Sandbox External Identifiers
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono">
                {detail.paypalOrderId && (
                  <div className="p-2.5 rounded-xl bg-[var(--card-bg)] border border-[var(--border-color)]">
                    <span className="text-[var(--text-secondary)] block text-[10px]">PayPal Order ID</span>
                    <span className="text-[var(--text-primary)] select-all">{detail.paypalOrderId}</span>
                  </div>
                )}
                {detail.paypalAuthorizationId && (
                  <div className="p-2.5 rounded-xl bg-[var(--card-bg)] border border-[var(--border-color)]">
                    <span className="text-[var(--text-secondary)] block text-[10px]">Authorization ID</span>
                    <span className="text-[var(--text-primary)] select-all">{detail.paypalAuthorizationId}</span>
                  </div>
                )}
                {detail.paypalCaptureId && (
                  <div className="p-2.5 rounded-xl bg-[var(--card-bg)] border border-[var(--border-color)]">
                    <span className="text-[var(--text-secondary)] block text-[10px]">Capture ID</span>
                    <span className="text-[#B8D99A] select-all">{detail.paypalCaptureId}</span>
                  </div>
                )}
                {detail.remoteVoidStatus && (
                  <div className="p-2.5 rounded-xl bg-[var(--card-bg)] border border-[var(--border-color)]">
                    <span className="text-[var(--text-secondary)] block text-[10px]">Remote Void Status</span>
                    <span className="text-[var(--text-primary)] font-semibold">{detail.remoteVoidStatus}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Ledger Records */}
          {detail.ledger && detail.ledger.length > 0 && (
            <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-4 space-y-2">
              <span className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5 text-[#B8D99A]" />
                Internal Ledger Entries
              </span>
              <div className="divide-y divide-[var(--border-color)]">
                {detail.ledger.map((entry) => (
                  <div key={entry.id} className="py-2 flex items-center justify-between text-xs font-mono">
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
                      <span className="font-sans text-[var(--text-primary)] font-semibold">{formatUsdFromMinor(entry.amountMinor)}</span>
                      <span className="text-[var(--text-secondary)] text-[10px] block">{formatDateTime(entry.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Cryptographic Audit Trail Timeline */}
          {detail.timeline && detail.timeline.length > 0 && (
            <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-[#B8D99A]" />
                  Audit Log Timeline ({detail.timeline.length} events)
                </span>
                <span className="text-[10px] font-mono text-[var(--text-secondary)]">Audit Record Chained</span>
              </div>
              <div className="space-y-2.5">
                {detail.timeline.map((event, idx) => (
                  <div
                    key={event.id || idx}
                    className="p-3 rounded-xl bg-[var(--card-bg)] border border-[var(--border-color)] text-xs font-mono space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--text-primary)]">{event.event}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--elevated-bg)] text-[var(--text-secondary)] border border-[var(--border-color)]">
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

          {/* Approvals history */}
          {detail.approvals && detail.approvals.length > 0 && (
            <div className="rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] p-4 space-y-2">
              <span className="text-xs font-semibold text-[var(--text-primary)]">Approval Records</span>
              <div className="space-y-1.5 text-xs font-mono">
                {detail.approvals.map((ap) => (
                  <div
                    key={ap.id}
                    className="flex items-center justify-between p-2 rounded-lg bg-[var(--card-bg)] border border-[var(--border-color)]"
                  >
                    <div>
                      <span className="text-[var(--text-primary)] font-semibold">{ap.action}</span>
                      <span className="text-[var(--text-secondary)] text-[10px] ml-2">channel: {ap.channel}</span>
                    </div>
                    <div className="text-right text-[10px] text-[var(--text-secondary)]">
                      {ap.usedAt ? `Used: ${formatDateTime(ap.usedAt)}` : `Expires: ${formatDateTime(ap.expiresAt)}`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 flex justify-end">
        <Button variant="ghost" size="md" onClick={onClose} className="min-h-[44px] text-xs">
          Close Inspection
        </Button>
      </div>
    </Modal>
  );
}
