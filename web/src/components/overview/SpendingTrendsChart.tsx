import { useState } from 'react';
import { OverviewResponse } from '../../types/api';
import { formatUsdFromMinor, formatDateTime } from '../../lib/formatters';

interface SpendingTrendsChartProps {
  overview: OverviewResponse;
  requests?: Array<{ createdAt: string; amountMinor: number; decision?: string | null; status: string }>;
  totalRequestsCount?: number;
  className?: string;
}

export function SpendingTrendsChart({
  overview,
  requests = [],
  totalRequestsCount = 0,
  className = '',
}: SpendingTrendsChartProps) {
  const [timeframe, setTimeframe] = useState<'24H' | '7D' | '30D'>('24H');
  const { budget } = overview;

  // Filter requests that fall in the selected timeframe window
  const now = Date.now();
  let windowMs = 24 * 60 * 60 * 1000;
  if (timeframe === '7D') windowMs = 7 * 24 * 60 * 60 * 1000;
  if (timeframe === '30D') windowMs = 30 * 24 * 60 * 60 * 1000;

  const filtered = requests
    .filter((r) => {
      try {
        const t = new Date(r.createdAt).getTime();
        return t >= now - windowMs;
      } catch {
        return false;
      }
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const hasData = filtered.length > 0;
  const isTruncated = (totalRequestsCount > requests.length) && timeframe !== '24H';

  // For 24H, use the authoritative rolling 24h ledger totals from the backend overview
  // For 7D and 30D, sum the actual filtered items available in the dataset
  let spentDisplayMinor = budget.spentRolling24hMinor;
  let reservedDisplayMinor = budget.reservedRolling24hMinor;

  if (timeframe !== '24H') {
    spentDisplayMinor = filtered
      .filter((r) => r.status === 'CAPTURED' || r.decision === 'ALLOW')
      .reduce((sum, r) => sum + r.amountMinor, 0);

    reservedDisplayMinor = filtered
      .filter((r) => r.status === 'HELD' || r.decision === 'HOLD')
      .reduce((sum, r) => sum + r.amountMinor, 0);
  }

  // Generate SVG curve points
  const width = 500;
  const height = 180;
  const padX = 24;
  const padY = 24;
  const graphWidth = width - padX * 2;
  const graphHeight = height - padY * 2;

  const startTime = now - windowMs;
  const timeSpan = windowMs;

  const spentPoints: Array<{ x: number; y: number }> = [];
  const reservedPoints: Array<{ x: number; y: number }> = [];

  // Initial zero point at start of window
  spentPoints.push({ x: padX, y: height - padY });
  reservedPoints.push({ x: padX, y: height - padY });

  let runningSpent = 0;
  let runningReserved = 0;

  for (const req of filtered) {
    const t = new Date(req.createdAt).getTime();
    const x = padX + Math.max(0, Math.min(graphWidth, ((t - startTime) / timeSpan) * graphWidth));

    if (req.status === 'CAPTURED' || req.decision === 'ALLOW') {
      runningSpent += req.amountMinor;
    } else if (req.status === 'HELD' || req.decision === 'HOLD') {
      runningReserved += req.amountMinor;
    }

    spentPoints.push({ x, y: 0 });
    reservedPoints.push({ x, y: 0 });
  }

  // Terminal point at current timestamp
  spentPoints.push({ x: width - padX, y: 0 });
  reservedPoints.push({ x: width - padX, y: 0 });

  const maxVal = Math.max(spentDisplayMinor, reservedDisplayMinor, runningSpent, runningReserved, 1000);

  // Recalculate Y coordinates with normalized scale
  let sAcc = 0;
  for (let i = 1; i < spentPoints.length; i++) {
    if (i - 1 < filtered.length) {
      const r = filtered[i - 1];
      if (r?.status === 'CAPTURED' || r?.decision === 'ALLOW') sAcc += r.amountMinor;
    }
    const ratio = Math.min(1, sAcc / maxVal);
    spentPoints[i]!.y = height - padY - ratio * graphHeight;
  }
  spentPoints[spentPoints.length - 1]!.y = height - padY - (sAcc / maxVal) * graphHeight;

  let rAcc = 0;
  for (let i = 1; i < reservedPoints.length; i++) {
    if (i - 1 < filtered.length) {
      const r = filtered[i - 1];
      if (r?.status === 'HELD' || r?.decision === 'HOLD') rAcc += r.amountMinor;
    }
    const ratio = Math.min(1, rAcc / maxVal);
    reservedPoints[i]!.y = height - padY - ratio * graphHeight;
  }
  reservedPoints[reservedPoints.length - 1]!.y = height - padY - (rAcc / maxVal) * graphHeight;

  const buildSvgPath = (points: Array<{ x: number; y: number }>) => {
    if (points.length < 2) return `M ${padX} ${height - padY} L ${width - padX} ${height - padY}`;
    let d = `M ${points[0]?.x} ${points[0]?.y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      if (!p0 || !p1) continue;
      const mx = (p0.x + p1.x) / 2;
      d += ` C ${mx} ${p0.y}, ${mx} ${p1.y}, ${p1.x} ${p1.y}`;
    }
    return d;
  };

  const spentPathD = buildSvgPath(spentPoints);
  const reservedPathD = buildSvgPath(reservedPoints);
  const spentAreaD = `${spentPathD} L ${width - padX} ${height - padY} L ${padX} ${height - padY} Z`;

  const earliestItemDate = filtered.length > 0 ? filtered[0]?.createdAt : null;

  return (
    <div
      className={`relative rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 flex flex-col justify-between transition-colors duration-200 ${className}`}
    >
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-[var(--text-primary)]">Spending Trends</h2>
          <p className="text-[11px] text-[var(--text-secondary)]">Cumulative actual spend vs held reserves</p>
        </div>

        {/* Timeframe Toggle Pills */}
        <div className="flex items-center gap-1 bg-[var(--elevated-bg)] p-1 rounded-full border border-[var(--border-color)]">
          {(['24H', '7D', '30D'] as const).map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => setTimeframe(tf)}
              className={`px-3 py-0.5 rounded-full text-xs font-mono transition-colors ${
                timeframe === tf
                  ? 'bg-[var(--card-bg)] text-[var(--text-primary)] font-semibold shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Dataset Truncation Disclaimer */}
      {isTruncated && (
        <div className="mt-2 py-1 px-2.5 rounded-lg bg-[var(--elevated-bg)] border border-[var(--border-color)] text-[10px] text-[var(--text-secondary)] flex items-center justify-between">
          <span>Showing latest {requests.length} of {totalRequestsCount} total requests.</span>
          <span className="text-[#B8D99A]">Older history in Audit Log</span>
        </div>
      )}

      {/* Metric Indicators */}
      <div className="flex items-center gap-6 my-3">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-0.5 rounded-full bg-[#B8D99A]" />
          <span className="text-xs text-[var(--text-secondary)]">
            {timeframe === '24H' ? '24h Spent:' : 'Window Spent:'}
          </span>
          <span className="font-sans text-sm font-bold text-[var(--text-primary)]">
            {formatUsdFromMinor(spentDisplayMinor)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-2.5 h-0.5 rounded-full border-t border-dashed border-[#BBA9D8]" />
          <span className="text-xs text-[var(--text-secondary)]">
            {timeframe === '24H' ? '24h Reserved:' : 'Window Reserved:'}
          </span>
          <span className="font-sans text-sm font-bold text-[#BBA9D8]">
            {formatUsdFromMinor(reservedDisplayMinor)}
          </span>
        </div>
      </div>

      {/* SVG Spline Chart */}
      <div className="relative w-full h-[180px]">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
          <defs>
            <linearGradient id="spent-gradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#B8D99A" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#B8D99A" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          <line
            x1={padX}
            y1={padY}
            x2={width - padX}
            y2={padY}
            stroke="var(--chart-grid)"
            strokeDasharray="4 4"
            strokeWidth="0.8"
          />
          <line
            x1={padX}
            y1={height / 2}
            x2={width - padX}
            y2={height / 2}
            stroke="var(--chart-grid)"
            strokeDasharray="4 4"
            strokeWidth="0.8"
          />
          <line
            x1={padX}
            y1={height - padY}
            x2={width - padX}
            y2={height - padY}
            stroke="var(--chart-grid)"
            strokeWidth="1"
          />

          {/* Area Fill */}
          <path d={spentAreaD} fill="url(#spent-gradient)" />

          {/* Dashed Reserved Line */}
          <path
            d={reservedPathD}
            fill="none"
            stroke="#BBA9D8"
            strokeWidth="2"
            strokeDasharray="5 5"
            strokeLinecap="round"
          />

          {/* Solid Spent Line */}
          <path
            d={spentPathD}
            fill="none"
            stroke="#B8D99A"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>

        {!hasData && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none bg-[var(--card-bg)]/80 backdrop-blur-[1px]">
            <p className="text-xs text-[var(--text-secondary)]">No spending events in this {timeframe} window</p>
            <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
              Live curves render as agents submit payments
            </p>
          </div>
        )}
      </div>

      {/* Axis Footer */}
      <div className="flex items-center justify-between text-[10px] font-medium text-[var(--text-secondary)] pt-2 border-t border-[var(--border-color)]">
        <span>
          {timeframe === '24H'
            ? '24h ago'
            : earliestItemDate
            ? `Earliest: ${formatDateTime(earliestItemDate)}`
            : `${timeframe.toLowerCase()} ago`}
        </span>
        <span>Timeline</span>
        <span>Now</span>
      </div>
    </div>
  );
}
