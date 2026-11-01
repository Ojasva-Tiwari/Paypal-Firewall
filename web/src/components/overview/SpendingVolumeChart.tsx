import { OverviewResponse } from '../../types/api';
import { formatUsdFromMinor } from '../../lib/formatters';
import { calculateHourlyActivityBuckets } from '../../lib/overviewUtils';

interface SpendingVolumeChartProps {
  overview: OverviewResponse;
  requests?: Array<{ createdAt: string; amountMinor: number }>;
  className?: string;
}

export function SpendingVolumeChart({
  overview,
  requests = [],
  className = '',
}: SpendingVolumeChartProps) {
  const { budget, counts24h } = overview;
  const buckets = calculateHourlyActivityBuckets(requests, 14);

  const maxAmount = Math.max(...buckets.map((b) => b.amountMinor), 1);
  const totalVolume = buckets.reduce((sum, b) => sum + b.amountMinor, 0);
  const hasData = requests.length > 0 && totalVolume > 0;

  return (
    <div
      className={`relative rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 flex flex-col justify-between transition-colors duration-200 ${className}`}
    >
      {/* Top Header & Spend Headline */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-[var(--text-primary)]">24h Spend & Commitments</h2>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-[var(--accent-sage)]/10 text-[var(--accent-sage)] border border-[var(--accent-sage)]/20">
              <span className="w-1 h-1 rounded-full bg-[var(--accent-sage)] animate-pulse" />
              Active
            </span>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
            Rolling 24-hour firewall transaction volume
          </p>
        </div>

        <div className="text-left sm:text-right">
          <span className="text-xs uppercase font-medium tracking-wider text-[var(--text-secondary)]">Committed</span>
          <div className="font-sans text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            {formatUsdFromMinor(budget.totalCommittedMinor)}
          </div>
          <p className="text-[11px] text-[var(--accent-sage)] font-medium mt-0.5">
            {formatUsdFromMinor(budget.spentRolling24hMinor)} spent · {formatUsdFromMinor(budget.reservedRolling24hMinor)} reserved
          </p>
        </div>
      </div>

      {/* Decision Summary Pills */}
      <div className="flex flex-wrap items-center gap-2 my-3">
        <span className="text-xs font-medium text-[var(--text-primary)] px-2.5 py-1 rounded-lg bg-[var(--elevated-bg)] border border-[var(--border-color)]">
          Total: <strong className="text-[var(--text-primary)] font-semibold">{counts24h.total}</strong>
        </span>
        <span className="text-xs font-medium text-[var(--accent-sage)] px-2.5 py-1 rounded-lg bg-[var(--accent-sage)]/10 border border-[var(--accent-sage)]/20">
          Allowed: <strong className="font-semibold">{counts24h.allowed}</strong>
        </span>
        <span className="text-xs font-medium text-[var(--accent-lavender)] px-2.5 py-1 rounded-lg bg-[var(--accent-lavender)]/10 border border-[var(--accent-lavender)]/20">
          Held: <strong className="font-semibold">{counts24h.held}</strong>
        </span>
        <span className="text-xs font-medium text-[var(--status-error)] px-2.5 py-1 rounded-lg bg-[var(--status-error-bg)] border border-[var(--status-error-border)]">
          Denied: <strong className="font-semibold">{counts24h.denied}</strong>
        </span>
      </div>

      {/* Vertical Bar Chart */}
      <div className="mt-2">
        <div className="flex items-end justify-between gap-1.5 h-24 px-1 pb-1 border-b border-[var(--border-color)]">
          {buckets.map((b, idx) => {
            const heightPct = hasData
              ? Math.max(8, Math.round((b.amountMinor / maxAmount) * 100))
              : 8;

            const barColor = idx % 2 === 0 ? 'var(--accent-sage)' : 'var(--accent-lavender)';

            return (
              <div
                key={`vol-bar-${idx}`}
                className="flex-1 flex flex-col items-center justify-end h-full group relative"
              >
                {/* Tooltip */}
                <div className="absolute -top-7 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none bg-[var(--elevated-bg)] border border-[var(--border-color)] px-1.5 py-0.5 rounded text-[10px] font-mono text-[var(--text-primary)] whitespace-nowrap z-20 shadow-lg">
                  {b.hourLabel}: {formatUsdFromMinor(b.amountMinor)} ({b.count} reqs)
                </div>

                <div
                  style={{
                    height: `${heightPct}%`,
                    backgroundColor: hasData ? barColor : 'var(--chart-empty-bar)',
                  }}
                  className={`w-full max-w-[12px] rounded-t-sm transition-all duration-500 ${
                    hasData ? 'group-hover:brightness-110' : ''
                  }`}
                />
              </div>
            );
          })}
        </div>

        {/* Axis labels */}
        <div className="flex items-center justify-between text-[10px] text-[var(--text-secondary)] font-medium mt-1 px-1">
          <span>24h ago</span>
          <span>Hourly Volume</span>
          <span>Now</span>
        </div>
      </div>
    </div>
  );
}
