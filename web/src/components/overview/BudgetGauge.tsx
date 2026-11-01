import { calculateBudgetUtilization } from '../../lib/overviewUtils';
import { formatUsdFromMinor } from '../../lib/formatters';

interface BudgetGaugeProps {
  spentMinor: number;
  reservedMinor: number;
  globalDailyBudgetMinor: number;
  currency?: string;
  className?: string;
}

export function BudgetGauge({
  spentMinor,
  reservedMinor,
  globalDailyBudgetMinor,
  currency = 'USD',
  className = '',
}: BudgetGaugeProps) {
  const totalCommittedMinor = spentMinor + reservedMinor;
  const util = calculateBudgetUtilization(totalCommittedMinor, globalDailyBudgetMinor);

  // SVG Geometry for Semicircular Arc Gauge
  const cx = 100;
  const cy = 82;
  const r = 62;
  const strokeWidth = 8;
  const arcLength = Math.PI * r;
  const strokeDashoffset = arcLength * (1 - util.utilizationPercent / 100);

  // Needle angle in radians: 0% -> 180° (left), 100% -> 0° (right)
  const angleRad = Math.PI - (util.utilizationPercent / 100) * Math.PI;
  const needleLength = r - 12;
  const needleX = cx + needleLength * Math.cos(angleRad);
  const needleY = cy - needleLength * Math.sin(angleRad);

  // Determine accent color via CSS variables
  let strokeColor = 'var(--accent-sage)';
  if (util.status === 'elevated') strokeColor = 'var(--accent-peach)';
  if (util.status === 'exceeded') strokeColor = 'var(--status-error)';

  return (
    <div
      className={`relative rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 flex flex-col justify-between transition-colors duration-200 ${className}`}
    >
      {/* Card Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--text-primary)]">Budget Utilization</span>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-sage)] animate-pulse" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-secondary)]">24h live</span>
        </div>
      </div>

      {/* Semicircular Gauge Meter */}
      <div className="relative flex flex-col items-center justify-center my-1">
        <svg viewBox="0 0 200 105" className="w-48 h-26 overflow-visible">
          {/* Background Arc Track */}
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            fill="none"
            stroke="var(--chart-grid)"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />

          {/* Active Arc Progress */}
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            fill="none"
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={arcLength}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            className="transition-all duration-700 ease-out"
          />

          {/* Center Needle & Pivot */}
          <line
            x1={cx}
            y1={cy}
            x2={needleX}
            y2={needleY}
            stroke="var(--text-primary)"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="transition-all duration-500 ease-out"
          />
          <circle cx={cx} cy={cy} r="4.5" fill="var(--text-primary)" />
          <circle cx={cx} cy={cy} r="2" fill="var(--card-bg)" />
        </svg>

        {/* Readout */}
        <div className="text-center mt-1">
          <div className="flex items-baseline justify-center gap-1.5">
            <span className="font-sans text-2xl font-bold tracking-tight text-[var(--text-primary)]">
              {util.utilizationPercent}%
            </span>
            <span className="text-xs text-[var(--text-secondary)]">used</span>
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
            = {formatUsdFromMinor(util.headroomMinor)} {currency} headroom
          </p>
        </div>
      </div>

      {/* Status Pill Selector */}
      <div className="flex items-center justify-center gap-1.5 pt-2 border-t border-[var(--border-color)]">
        <span
          className={`px-3 py-1 rounded-full text-[11px] font-medium transition-colors ${
            util.status === 'safe'
              ? 'bg-[var(--accent-sage)] text-[var(--app-bg)] font-semibold'
              : 'bg-[var(--elevated-bg)] text-[var(--text-secondary)] border border-[var(--border-color)]'
          }`}
        >
          Safe
        </span>
        <span
          className={`px-3 py-1 rounded-full text-[11px] font-medium transition-colors ${
            util.status === 'elevated'
              ? 'bg-[var(--accent-peach)] text-[var(--app-bg)] font-semibold'
              : 'bg-[var(--elevated-bg)] text-[var(--text-secondary)] border border-[var(--border-color)]'
          }`}
        >
          Elevated
        </span>
        <span
          className={`px-3 py-1 rounded-full text-[11px] font-medium transition-colors ${
            util.status === 'exceeded'
              ? 'bg-[var(--status-error)] text-[var(--app-bg)] font-semibold'
              : 'bg-[var(--elevated-bg)] text-[var(--text-secondary)] border border-[var(--border-color)]'
          }`}
        >
          Cap Exceeded
        </span>
      </div>
    </div>
  );
}
