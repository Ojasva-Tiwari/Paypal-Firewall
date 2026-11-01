import { calculateCategoryAllocations } from '../../lib/overviewUtils';
import { formatUsdFromMinor } from '../../lib/formatters';

interface AllocationBreakdownProps {
  requests: Array<{ category?: string | null; amountMinor: number }>;
  className?: string;
}

export function AllocationBreakdown({ requests, className = '' }: AllocationBreakdownProps) {
  const allocations = calculateCategoryAllocations(requests);
  const totalMinor = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
  const hasData = allocations.length > 0 && totalMinor > 0;

  return (
    <div
      className={`relative rounded-[26px] bg-[var(--card-bg)] border border-[var(--border-color)] p-6 flex flex-col justify-between transition-colors duration-200 ${className}`}
    >
      {/* Header */}
      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">Category Allocation</h2>
          <span className="text-[11px] font-medium text-[var(--text-secondary)]">
            {allocations.length} {allocations.length === 1 ? 'category' : 'categories'}
          </span>
        </div>

        {/* Big Total Requested Volume */}
        <div className="mt-2">
          <div className="font-sans text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            {formatUsdFromMinor(totalMinor)}
          </div>
          <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
            Total categorized request volume
          </p>
        </div>
      </div>

      {/* Segmented Horizontal Pill Bar matching reference */}
      <div className="my-4">
        {hasData ? (
          <div className="flex h-5 w-full rounded-full overflow-hidden bg-[var(--elevated-bg)] p-0.5 gap-0.5 border border-[var(--border-color)]">
            {allocations.map((a, i) => (
              <div
                key={`pill-${i}`}
                style={{
                  width: `${Math.max(4, a.percentage)}%`,
                  backgroundColor: a.color,
                }}
                className="h-full first:rounded-l-full last:rounded-r-full transition-all duration-500 hover:brightness-110"
                title={`${a.category}: ${a.percentage}% (${formatUsdFromMinor(a.amountMinor)})`}
              />
            ))}
          </div>
        ) : (
          <div className="h-5 w-full rounded-full bg-[var(--elevated-bg)] border border-[var(--border-color)] flex items-center justify-center">
            <span className="text-[10px] text-[var(--text-secondary)] font-mono">No category distribution</span>
          </div>
        )}
      </div>

      {/* Itemized Legend Grid */}
      <div className="border-t border-[var(--border-color)] pt-3">
        {hasData ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            {allocations.slice(0, 4).map((a, i) => (
              <div key={`legend-${i}`} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: a.color }}
                  />
                  <span className="text-[var(--text-primary)] truncate max-w-[85px]">{a.category}</span>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0 font-mono">
                  <span className="text-[var(--text-secondary)]">{a.percentage}%</span>
                  <span className="text-[var(--text-primary)] font-medium font-sans">
                    {formatUsdFromMinor(a.amountMinor)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-2">
            <p className="text-xs text-[var(--text-secondary)]">No categorized payments recorded yet</p>
            <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
              Vendor requests with categories will segment here
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
