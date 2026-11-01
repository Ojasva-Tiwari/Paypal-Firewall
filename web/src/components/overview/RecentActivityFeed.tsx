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
    if (status === 'CAPTURED' || decision === 'ALLOW') {
      return (
        <div className="w-8 h-8 rounded-full bg-[#B8D99A]/10 border border-[#B8D99A]/20 flex items-center justify-center flex-shrink-0">
          <CheckCircle2 className="w-4 h-4 text-[#B8D99A]" />
        </div>
      );
    }
    if (status === 'HELD' || decision === 'HOLD') {
      return (
        <div className="w-8 h-8 rounded-full bg-[#BBA9D8]/10 border border-[#BBA9D8]/20 flex items-center justify-center flex-shrink-0">
          <Clock className="w-4 h-4 text-[#BBA9D8]" />
        </div>
      );
    }
    if (status === 'DENIED' || decision === 'DENY') {
      return (
        <div className="w-8 h-8 rounded-full bg-[#E89A9A]/10 border border-[#E89A9A]/20 flex items-center justify-center flex-shrink-0">
          <ShieldAlert className="w-4 h-4 text-[#E89A9A]" />
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-full bg-[#171717] border border-[#262626] flex items-center justify-center flex-shrink-0">
        <XCircle className="w-4 h-4 text-[#A0A0A0]" />
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
                  <div className="flex items-center gap-1.5">
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
