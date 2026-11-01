import { useEffect, useState } from 'react';
import { ArrowUpRight, ShieldCheck, Clock, AlertTriangle } from 'lucide-react';
import { Button } from '../ui/Button';
import { formatUsdFromMinor } from '../../lib/formatters';

export interface PendingHoldSummary {
  id: string;
  createdAt: string;
  expiresAt?: string | null;
}

interface PendingApprovalsCardProps {
  heldCount: number;
  pendingRequests?: PendingHoldSummary[];
  autoLimitMinor?: number;
  hardCapMinor?: number;
  globalBudgetMinor?: number;
  onNavigateApprovals?: () => void;
  className?: string;
}

export function PendingApprovalsCard({
  heldCount,
  pendingRequests = [],
  autoLimitMinor = 1500,
  hardCapMinor = 10000,
  globalBudgetMinor = 20000,
  onNavigateApprovals,
  className = '',
}: PendingApprovalsCardProps) {
  const isUrgent = heldCount > 0;
  const [nowMs, setNowMs] = useState(Date.now());

  // Live timer tick when there are active holds with expiry timestamps
  useEffect(() => {
    if (!isUrgent) return;
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [isUrgent]);

  // Find the earliest expiring hold with an authoritative timestamp
  const holdsWithExpiry = pendingRequests.filter(
    (r) => r.expiresAt && !isNaN(new Date(r.expiresAt).getTime())
  );

  const hasAuthoritativeExpiry = holdsWithExpiry.length > 0;

  let earliestHold: PendingHoldSummary | null = null;
  let remainingMs = 0;
  let totalDurationMs = 15 * 60 * 1000;
  let percentRemaining = 0;
  let isExpired = false;

  if (hasAuthoritativeExpiry) {
    const sorted = [...holdsWithExpiry].sort(
      (a, b) => new Date(a.expiresAt!).getTime() - new Date(b.expiresAt!).getTime()
    );
    earliestHold = sorted[0];
    const expiresAtMs = new Date(earliestHold.expiresAt!).getTime();
    const createdAtMs = new Date(earliestHold.createdAt).getTime();

    totalDurationMs = Math.max(1000, expiresAtMs - createdAtMs);
    remainingMs = expiresAtMs - nowMs;
    isExpired = remainingMs <= 0;
    percentRemaining = Math.max(0, Math.min(100, Math.round((remainingMs / totalDurationMs) * 100)));
  }

  const formatCountdown = (ms: number): string => {
    if (ms <= 0) return '0s';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min === 0) return `${sec}s`;
    return `${min}m ${sec}s`;
  };

  return (
    <div
      className={`relative rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 flex flex-col justify-between transition-colors duration-200 ${
        isUrgent ? 'border-[var(--accent-peach)]/40' : ''
      } ${className}`}
    >
      {/* Top Header & Status Badge */}
      <div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[var(--text-primary)]">Human Approvals</span>
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${
              isUrgent
                ? 'bg-[var(--accent-peach)]/15 text-[var(--accent-peach)] border border-[var(--accent-peach)]/30 animate-pulse'
                : 'bg-[var(--accent-sage)]/15 text-[var(--accent-sage)] border border-[var(--accent-sage)]/30'
            }`}
          >
            {isUrgent ? (
              <>
                <Clock className="w-3 h-3" />
                Action Needed
              </>
            ) : (
              <>
                <ShieldCheck className="w-3 h-3" />
                Queue Clear
              </>
            )}
          </span>
        </div>

        {/* Big Held Count Headline */}
        <div className="mt-4">
          <div className="flex items-baseline gap-2">
            <span className="font-sans text-4xl font-bold tracking-tight text-[var(--text-primary)]">
              {heldCount}
            </span>
            <span className="text-sm text-[var(--text-secondary)]">
              {heldCount === 1 ? 'hold pending' : 'holds pending'}
            </span>
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            {isUrgent
              ? 'Payment requests currently in HELD status awaiting owner authorization.'
              : 'Zero active holds in queue. All agent requests are processed or denied.'}
          </p>
        </div>

        {/* Expiry / TTL Progress Indicator */}
        <div className="mt-4 p-3 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)]">
          {isUrgent && hasAuthoritativeExpiry ? (
            /* Authoritative Countdown Progress Bar */
            <div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[var(--text-secondary)]">
                  {isExpired ? 'Hold Status' : 'Earliest Hold Expiry'}
                </span>
                <span
                  className={`font-mono font-medium ${
                    isExpired ? 'text-[var(--status-error)]' : 'text-[var(--accent-peach)]'
                  }`}
                >
                  {isExpired ? (
                    <span className="flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      Expired · Pending Void
                    </span>
                  ) : (
                    formatCountdown(remainingMs)
                  )}
                </span>
              </div>
              <div className="w-full bg-[var(--border-color)] h-1.5 rounded-full mt-2 overflow-hidden">
                <div
                  style={{ width: `${isExpired ? 100 : percentRemaining}%` }}
                  className={`h-full rounded-full transition-all duration-1000 ease-linear ${
                    isExpired ? 'bg-[var(--status-error)]' : 'bg-[var(--accent-peach)]'
                  }`}
                />
              </div>
              <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
                Fail-closed: Unapproved hold voids automatically upon timer expiry
              </p>
            </div>
          ) : isUrgent ? (
            /* Authoritative timestamp unavailable: display policy without fake countdown */
            <div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[var(--text-secondary)]">Hold TTL Policy</span>
                <span className="text-[var(--text-primary)] font-medium">15m Window</span>
              </div>
              <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
                Exact expiry timestamp unavailable in record. Governed by 15-minute policy window.
              </p>
            </div>
          ) : (
            /* Queue is clear: show static policy specification without active countdown */
            <div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-[var(--text-secondary)]">Policy Hold TTL</span>
                <span className="text-[var(--text-primary)] font-medium">15m Window</span>
              </div>
              <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
                Fail-closed rule: Unapproved holds default-void upon timer expiry
              </p>
            </div>
          )}
        </div>

        {/* Key Policy Limits */}
        <div className="mt-4 space-y-2 text-xs">
          <div className="flex items-center justify-between text-[var(--text-secondary)]">
            <span>Auto-approve limit</span>
            <span className="font-sans text-[var(--text-primary)] font-semibold">
              {formatUsdFromMinor(autoLimitMinor)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[var(--text-secondary)]">
            <span>Hard maximum cap</span>
            <span className="font-sans text-[var(--text-primary)] font-semibold">
              {formatUsdFromMinor(hardCapMinor)}
            </span>
          </div>
          <div className="flex items-center justify-between text-[var(--text-secondary)]">
            <span>Global daily limit</span>
            <span className="font-sans text-[var(--text-primary)] font-semibold">
              {formatUsdFromMinor(globalBudgetMinor)}
            </span>
          </div>
        </div>
      </div>

      {/* Primary Action Button */}
      <div className="mt-6">
        <Button
          variant={isUrgent ? 'primary' : 'secondary'}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold shadow-md"
          onClick={onNavigateApprovals}
        >
          <span>{isUrgent ? `Review ${heldCount} Holds` : 'View Approvals Queue'}</span>
          <ArrowUpRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
