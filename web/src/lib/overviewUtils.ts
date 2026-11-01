/**
 * PayGuard — Overview Dashboard Calculations & Formatting Utilities
 * Provides deterministic, unit-tested calculations for budget utilization,
 * category breakdowns, and hourly activity buckets using integer minor units.
 */

export interface BudgetUtilization {
  utilizationPercent: number;
  status: 'safe' | 'elevated' | 'exceeded';
  statusLabel: string;
  headroomMinor: number;
  totalCommittedMinor: number;
}

export function calculateBudgetUtilization(
  totalCommittedMinor: number,
  globalDailyBudgetMinor: number
): BudgetUtilization {
  if (globalDailyBudgetMinor <= 0) {
    return {
      utilizationPercent: 0,
      status: 'safe',
      statusLabel: 'Safe',
      headroomMinor: 0,
      totalCommittedMinor,
    };
  }

  const rawPercent = (totalCommittedMinor / globalDailyBudgetMinor) * 100;
  const utilizationPercent = Math.min(100, Math.max(0, Math.round(rawPercent)));
  const headroomMinor = Math.max(0, globalDailyBudgetMinor - totalCommittedMinor);

  let status: 'safe' | 'elevated' | 'exceeded' = 'safe';
  let statusLabel = 'Safe';

  if (rawPercent >= 90) {
    status = 'exceeded';
    statusLabel = 'Cap Exceeded';
  } else if (rawPercent >= 70) {
    status = 'elevated';
    statusLabel = 'Elevated';
  }

  return {
    utilizationPercent,
    status,
    statusLabel,
    headroomMinor,
    totalCommittedMinor,
  };
}

export interface CategoryAllocation {
  category: string;
  amountMinor: number;
  percentage: number;
  color: string;
}

export function calculateCategoryAllocations(
  requests: Array<{ category?: string | null; amountMinor: number }>
): CategoryAllocation[] {
  if (!requests || requests.length === 0) return [];

  const totalsByCategory = new Map<string, number>();
  let grandTotalMinor = 0;

  for (const req of requests) {
    const cat = req.category?.trim() || 'General';
    const current = totalsByCategory.get(cat) ?? 0;
    totalsByCategory.set(cat, current + req.amountMinor);
    grandTotalMinor += req.amountMinor;
  }

  if (grandTotalMinor <= 0) return [];

  // Color palette sequence: Sage (#B8D99A), Lavender (#BBA9D8), Peach (#E8B5A0), Muted (#929B91)
  const palette = ['#B8D99A', '#BBA9D8', '#E8B5A0', '#929B91', '#D0E5BD'];

  const sorted = Array.from(totalsByCategory.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([category, amountMinor], index) => {
      const percentage = Math.round((amountMinor / grandTotalMinor) * 1000) / 10;
      return {
        category,
        amountMinor,
        percentage,
        color: palette[index % palette.length] ?? '#B8D99A',
      };
    });

  return sorted;
}

export interface ActivityBucket {
  hourLabel: string;
  count: number;
  amountMinor: number;
}

export function calculateHourlyActivityBuckets(
  requests: Array<{ createdAt: string; amountMinor: number }>,
  bucketCount = 12
): ActivityBucket[] {
  const now = Date.now();
  const bucketDurationMs = (24 * 60 * 60 * 1000) / bucketCount;
  const buckets: ActivityBucket[] = [];

  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = now - (bucketCount - i) * bucketDurationMs;
    const bucketEnd = bucketStart + bucketDurationMs;
    const d = new Date(bucketStart);
    const hourLabel = `${d.getHours().toString().padStart(2, '0')}:00`;

    let count = 0;
    let amountMinor = 0;

    for (const req of requests) {
      try {
        const t = new Date(req.createdAt).getTime();
        const isLast = i === bucketCount - 1;
        if (t >= bucketStart && (isLast ? t <= bucketEnd + 5000 : t < bucketEnd)) {
          count++;
          amountMinor += req.amountMinor;
        }
      } catch {
        // Skip invalid date
      }
    }

    buckets.push({ hourLabel, count, amountMinor });
  }

  return buckets;
}
