import { useEffect, useState, useCallback } from 'react';
import {
  ShieldCheck,
  RotateCw,
  Clock,
  AlertTriangle,
  CheckCircle2,
  X,
  Filter,
} from 'lucide-react';
import { PaymentRequestSummary, PaymentRequestsListResponse } from '../types/api';
import { apiClient, ApiError } from '../lib/api';
import { ApprovalCard } from '../components/approvals/ApprovalCard';
import { ApprovalConfirmModal } from '../components/approvals/ApprovalConfirmModal';
import { RequestDetailModal } from '../components/approvals/RequestDetailModal';
import { Button } from '../components/ui/Button';
import { resolveActionOutcome } from '../lib/approvalUtils';

interface ActionOutcome {
  type: 'APPROVE' | 'VOID' | 'ERROR';
  headline: string;
  message: string;
  isAmbiguous?: boolean;
}

export interface ApprovalsPageProps {
  onInspectRequest?: (id: string) => void;
}

export function ApprovalsPage({ onInspectRequest }: ApprovalsPageProps = {}) {
  const [items, setItems] = useState<PaymentRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modals & Action State
  const [selectedForApprove, setSelectedForApprove] = useState<PaymentRequestSummary | null>(null);
  const [selectedForVoid, setSelectedForVoid] = useState<PaymentRequestSummary | null>(null);
  const [inspectRequestId, setInspectRequestId] = useState<string | null>(null);
  const [outcomeBanner, setOutcomeBanner] = useState<ActionOutcome | null>(null);

  const fetchHeldRequests = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setIsRefreshing(true);
    setError(null);

    try {
      // Authoritative: strictly query requests in HELD status
      const res = await apiClient.get<PaymentRequestsListResponse>('/api/requests?status=HELD&limit=50');
      // Extra client-side guard: filter strictly status === 'HELD'
      const heldItems = (res.items || []).filter((r) => r.status === 'HELD');
      setItems(heldItems);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to fetch pending approval queue.');
      }
    } finally {
      setLoading(false);
      if (isManualRefresh) setIsRefreshing(false);
    }
  }, []);

  // Initial fetch and 10s polling interval
  useEffect(() => {
    fetchHeldRequests();
    const interval = setInterval(() => {
      fetchHeldRequests();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchHeldRequests]);

  const handleActionSuccess = (result: {
    type: 'APPROVE' | 'VOID';
    message: string;
    details?: { status?: string; captureId?: string; remoteVoidStatus?: 'CONFIRMED' | 'PENDING' | 'FAILED'; warning?: string };
  }) => {
    const outcome = resolveActionOutcome(result.type, result.details, result.message);
    setOutcomeBanner({
      type: outcome.type,
      headline: outcome.headline,
      message: outcome.message,
      isAmbiguous: outcome.isAmbiguous,
    });
    // Immediately refresh queue
    fetchHeldRequests(true);
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">Pending Approvals</h2>
            {!loading && (
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-medium ${
                  items.length > 0
                    ? 'bg-[var(--status-warn-bg)] text-[var(--status-warn)] border border-[var(--status-warn-border)] animate-pulse'
                    : 'bg-[var(--status-success-bg)] text-[var(--status-success)] border border-[var(--status-success-border)]'
                }`}
              >
                <Clock className="h-3 w-3" />
                {items.length} {items.length === 1 ? 'Hold' : 'Holds'} Pending
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Authoritative queue of payment requests held for owner review before PayPal sandbox capture.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fetchHeldRequests(true)}
            disabled={isRefreshing}
            className="text-xs min-h-[40px] px-3.5"
          >
            <RotateCw className={`h-3.5 w-3.5 mr-1.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh Queue
          </Button>
        </div>
      </div>

      {/* Outcome Banner (Captured, Voided, Ambiguous, Expired) */}
      {outcomeBanner && (
        <div
          className={`rounded-2xl p-4 border flex items-start justify-between gap-3 shadow-lg transition-all ${
            outcomeBanner.isAmbiguous
              ? 'bg-[var(--accent-lavender)]/10 border-[var(--accent-lavender)]/30 text-[var(--text-primary)]'
              : outcomeBanner.type === 'APPROVE'
              ? 'bg-[var(--accent-sage)]/15 border-[var(--accent-sage)]/30 text-[var(--text-primary)]'
              : 'bg-[var(--status-error-bg)] border-[var(--status-error-border)] text-[var(--text-primary)]'
          }`}
        >
          <div className="flex items-start gap-2.5">
            {outcomeBanner.isAmbiguous ? (
              <AlertTriangle className="h-5 w-5 text-[var(--accent-lavender)] shrink-0 mt-0.5" />
            ) : outcomeBanner.type === 'APPROVE' ? (
              <CheckCircle2 className="h-5 w-5 text-[var(--accent-sage)] shrink-0 mt-0.5" />
            ) : (
              <ShieldCheck className="h-5 w-5 text-[var(--status-error)] shrink-0 mt-0.5" />
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
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Error Banner */}
      {error && !loading && (
        <div className="rounded-2xl bg-[#E5989B]/15 border border-[#E5989B]/30 p-4 text-xs text-[#E5989B] flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Failed to load queue</p>
              <p className="text-[#E5989B]/80 mt-0.5">{error}</p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => fetchHeldRequests(true)} className="text-xs">
            Retry
          </Button>
        </div>
      )}

      {/* Loading Skeletons */}
      {loading && (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-4 animate-pulse"
            >
              <div className="flex items-center justify-between pb-4 border-b border-[var(--border-color)]">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-2xl bg-[var(--elevated-bg)]" />
                  <div className="space-y-2">
                    <div className="h-4 w-32 bg-[var(--elevated-bg)] rounded" />
                    <div className="h-3 w-48 bg-[var(--elevated-bg)] rounded" />
                  </div>
                </div>
                <div className="h-6 w-24 bg-[var(--elevated-bg)] rounded-full" />
              </div>
              <div className="space-y-2">
                <div className="h-8 w-28 bg-[var(--elevated-bg)] rounded" />
                <div className="h-4 w-full bg-[var(--elevated-bg)] rounded" />
              </div>
              <div className="flex justify-end gap-2 pt-4 border-t border-[var(--border-color)]">
                <div className="h-10 w-24 bg-[var(--elevated-bg)] rounded-xl" />
                <div className="h-10 w-32 bg-[var(--elevated-bg)] rounded-xl" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && items.length === 0 && (
        <div className="rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-12 text-center flex flex-col items-center justify-center space-y-4">
          <div className="h-14 w-14 rounded-2xl bg-[var(--accent-sage)]/10 border border-[var(--accent-sage)]/20 flex items-center justify-center text-[var(--accent-sage)]">
            <ShieldCheck className="h-7 w-7" />
          </div>
          <div className="space-y-1">
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">Approval Queue Clear</h3>
            <p className="text-xs text-[var(--text-secondary)] max-w-md">
              There are currently no payment requests in HELD status. All agent payments have either been auto-approved
              within policy limits or resolved by previous owner actions.
            </p>
          </div>
          <div className="pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fetchHeldRequests(true)}
              className="text-xs min-h-[40px] px-4"
            >
              <RotateCw className="h-3.5 w-3.5 mr-1.5" />
              Check Again
            </Button>
          </div>
        </div>
      )}

      {/* Queue List of Held Requests */}
      {!loading && !error && items.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)] px-1">
            <span className="flex items-center gap-1.5 font-medium">
              <Filter className="h-3.5 w-3.5" /> Showing {items.length} held {items.length === 1 ? 'request' : 'requests'}
            </span>
            <span>Sorted by newest submission</span>
          </div>

          {items.map((request) => (
            <ApprovalCard
              key={request.id}
              request={request}
              onApprove={(req) => setSelectedForApprove(req)}
              onVoid={(req) => setSelectedForVoid(req)}
              onInspect={(id) => {
                if (onInspectRequest) {
                  onInspectRequest(id);
                } else {
                  window.location.hash = `#/requests/${id}`;
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Confirmation Modals */}
      <ApprovalConfirmModal
        isOpen={selectedForApprove !== null}
        mode="APPROVE"
        request={selectedForApprove}
        onClose={() => setSelectedForApprove(null)}
        onSuccess={handleActionSuccess}
        onQueueRefreshNeeded={() => fetchHeldRequests(true)}
      />

      <ApprovalConfirmModal
        isOpen={selectedForVoid !== null}
        mode="VOID"
        request={selectedForVoid}
        onClose={() => setSelectedForVoid(null)}
        onSuccess={handleActionSuccess}
        onQueueRefreshNeeded={() => fetchHeldRequests(true)}
      />

      {/* Audit Detail Modal */}
      <RequestDetailModal
        isOpen={inspectRequestId !== null}
        requestId={inspectRequestId}
        onClose={() => setInspectRequestId(null)}
      />
    </div>
  );
}
