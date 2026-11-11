import { CheckCircle2, Clock, ShieldAlert, XCircle, ArrowUpRight } from 'lucide-react';
import { OverviewResponse } from '../../types/api';
import { formatUsdFromMinor, formatRelativeTime, getReasonLabel } from '../../lib/formatters';
import { Badge } from '../ui/Badge';

interface RecentActivityFeedProps {
  recentActivity: OverviewResponse['recentActivity'];
  onViewAll?: () => void;
  onSelectRequest?: (id: string) => void;
  className?: string;
}

export function RecentActivityFeed({
  recentActivity = [],
  onViewAll,
  onSelectRequest,
  className = '',
}: RecentActivityFeedProps) {
  const hasItems = recentActivity.length > 0;

  const getStatusIcon = (status: string, decision: string) => {
    const normStatus = (status || '').toUpperCase();
    const normDecision = (decision || '').toUpperCase();

    if (normStatus === 'CAPTURED') {
      return (
        <div className="w-8 h-8 rounded-full bg-[var(--accent-sage)]/10 border border-[var(--accent-sage)]/25 flex items-center justify-center flex-shrink-0">
          <CheckCircle2 className="w-4 h-4 text-[var(--accent-sage)]" />
        </div>
      );
    }
    if (normStatus === 'AUTO_EXECUTING' || normStatus === 'APPROVED' || normStatus === 'CAPTURING') {
      return (
        <div className="w-8 h-8 rounded-full bg-[var(--accent-lavender)]/10 border border-[var(--accent-lavender)]/25 flex items-center justify-center flex-shrink-0">
          <Clock className="w-4 h-4 text-[var(--accent-lavender)]" />
        </div>
      );
    }
    if (normStatus === 'HELD') {
      return (
        <div className="w-8 h-8 rounded-full bg-[var(--accent-peach)]/10 border border-[var(--accent-peach)]/25 flex items-center justify-center flex-shrink-0">
          <Clock className="w-4 h-4 text-[var(--accent-peach)]" />
        </div>
      );
    }
    if (normStatus === 'DENIED' || normStatus === 'FAILED' || normDecision === 'DENY') {
      return (
        <div className="w-8 h-8 rounded-full bg-[var(--status-error-bg)] border border-[var(--status-error-border)] flex items-center justify-center flex-shrink-0">
          <ShieldAlert className="w-4 h-4 text-[var(--status-error)]" />
        </div>
      );
    }
    if (normStatus === 'EXPIRED' || normStatus === 'VOIDED') {
      return (
        <div className="w-8 h-8 rounded-full bg-[var(--elevated-bg)] border border-[var(--border-color)] flex items-center justify-center flex-shrink-0">
          <XCircle className="w-4 h-4 text-[var(--text-secondary)]" />
        </div>
      );
    }
    if (normDecision === 'ALLOW') {
      return (
        <div className="w-8 h-8 rounded-full bg-[var(--accent-sage)]/10 border border-[var(--accent-sage)]/25 flex items-center justify-center flex-shrink-0">
          <CheckCircle2 className="w-4 h-4 text-[var(--accent-sage)]" />
        </div>
      );
    }
    if (normDecision === 'HOLD') {
      return (
        <div className="w-8 h-8 rounded-full bg-[var(--accent-peach)]/10 border border-[var(--accent-peach)]/25 flex items-center justify-center flex-shrink-0">
          <Clock className="w-4 h-4 text-[var(--accent-peach)]" />
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-full bg-[var(--elevated-bg)] border border-[var(--border-color)] flex items-center justify-center flex-shrink-0">
        <XCircle className="w-4 h-4 text-[var(--text-secondary)]" />
      </div>
    );
  };

  return (
    <div
      className={`relative rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 flex flex-col justify-between transition-colors duration-200 ${className}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[var(--border-color)]">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">Recent Payments</h2>
          <span className="text-xs text-[var(--text-secondary)]">({recentActivity.length} events)</span>
        </div>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="text-xs text-[var(--text-primary)] hover:text-[var(--accent-sage)] flex items-center gap-1 font-medium transition-colors cursor-pointer"
          >
            <span>View all</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Activity List */}
      <div className="mt-3 divide-y divide-[var(--border-color)] flex-1">
        {hasItems ? (
          recentActivity.map((r) => {
            const primaryReason = r.reasons && r.reasons.length > 0 ? r.reasons[0] : null;
            const hasUnresolvedVoid =
              r.remoteVoidStatus === 'PENDING' || r.remoteVoidStatus === 'FAILED';
            const paypalRef = r.paypalCaptureId
              ? { label: `Cap ${r.paypalCaptureId.slice(-8)}`, full: r.paypalCaptureId }
              : r.paypalAuthorizationId
              ? { label: `Auth ${r.paypalAuthorizationId.slice(-8)}`, full: r.paypalAuthorizationId }
              : r.paypalOrderId
              ? { label: `Ord ${r.paypalOrderId.slice(-8)}`, full: r.paypalOrderId }
              : null;

            const handleItemClick = () => {
              if (onSelectRequest) {
                onSelectRequest(r.id);
              } else {
                window.location.hash = `#/requests/${r.id}`;
              }
            };

            return (
              <div
                key={r.id}
                onClick={handleItemClick}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleItemClick();
                  }
                }}
                role="button"
                tabIndex={0}
                className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0 hover:bg-[var(--elevated-bg)] px-2 -mx-2 rounded-xl transition-colors cursor-pointer"
              >
                {/* Left: Icon and Details */}
                <div className="flex items-center gap-3 min-w-0">
                  {getStatusIcon(r.status, r.decision ?? '')}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">{r.vendorName}</p>
                    <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)] mt-0.5">
                      <span className="truncate max-w-[120px]">{r.agentName}</span>
                      <span>•</span>
                      <span>{formatRelativeTime(r.timestamp)}</span>
                    </div>
                  </div>
                </div>

                {/* Right: Amount & Status Badge */}
                <div className="text-right flex-shrink-0 flex flex-col items-end gap-1">
                  <span className="font-sans text-sm font-semibold text-[var(--text-primary)]">
                    {formatUsdFromMinor(r.amountMinor)}
                  </span>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {paypalRef && (
                      <span
                        className="hidden sm:inline-block text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--elevated-bg)] text-[var(--text-secondary)] border border-[var(--border-color)] max-w-[110px] truncate"
                        title={`PayPal ID: ${paypalRef.full}`}
                      >
                        {paypalRef.label}
                      </span>
                    )}
                    {hasUnresolvedVoid && (
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border uppercase ${
                          r.remoteVoidStatus === 'FAILED'
                            ? 'bg-[var(--status-error-bg)] text-[var(--status-error)] border-[var(--status-error-border)]'
                            : 'bg-[var(--status-warn-bg)] text-[var(--status-warn)] border-[var(--status-warn-border)]'
                        }`}
                        title={`Remote void status: ${r.remoteVoidStatus}`}
                      >
                        Void {r.remoteVoidStatus}
                      </span>
                    )}
                    {primaryReason && (
                      <span
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--elevated-bg)] text-[var(--text-secondary)] border border-[var(--border-color)] max-w-[110px] truncate"
                        title={getReasonLabel(primaryReason)}
                      >
                        {primaryReason}
                      </span>
                    )}
                    <Badge status={r.status} />
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="py-8 text-center">
            <p className="text-xs text-[var(--text-secondary)]">No payment requests recorded yet</p>
            <p className="text-[10px] text-[var(--text-muted)] mt-1">
              Firewall decisions and live transactions will stream here in real time
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
