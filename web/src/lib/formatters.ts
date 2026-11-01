/**
 * PayGuard — Financial & Formatting Utilities
 * Handles exact minor unit conversions, date formatting, and reason codes
 */

export function formatCurrencyFromMinor(minorUnits: number, currency: string = 'USD'): string {
  const isNegative = minorUnits < 0;
  const absMinor = Math.abs(minorUnits);
  const dollars = Math.floor(absMinor / 100);
  const cents = absMinor % 100;
  const formattedCents = cents.toString().padStart(2, '0');
  const formattedDollars = dollars.toLocaleString('en-US');
  const sign = isNegative ? '−' : '';
  const code = (currency || 'USD').toUpperCase();

  if (code === 'USD') return `${sign}$${formattedDollars}.${formattedCents}`;
  if (code === 'EUR') return `${sign}€${formattedDollars}.${formattedCents}`;
  if (code === 'GBP') return `${sign}£${formattedDollars}.${formattedCents}`;
  return `${sign}${formattedDollars}.${formattedCents} ${code}`;
}

export function formatUsdFromMinor(minorUnits: number): string {
  return formatCurrencyFromMinor(minorUnits, 'USD');
}

export function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

export function formatRelativeTime(isoString: string): string {
  try {
    const d = new Date(isoString).getTime();
    const now = Date.now();
    const diffSec = Math.floor((now - d) / 1000);

    if (diffSec < 5) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    return `${diffDays}d ago`;
  } catch {
    return isoString;
  }
}

export function maskIdentifier(id: string, showLast = 4): string {
  if (!id) return '';
  if (id.length <= showLast) return id;
  const last = id.slice(-showLast);
  return `**** ${last}`;
}

export const REASON_CODE_LABELS: Record<string, string> = {
  OVER_AUTO_LIMIT: 'Exceeds auto-approve ceiling',
  OVER_HARD_CAP: 'Exceeds maximum hard cap',
  VENDOR_UNKNOWN: 'Vendor not in approved registry',
  VENDOR_BLOCKED: 'Vendor is explicitly blocked',
  VENDOR_NEW: 'Vendor status is unverified',
  AGENT_SUSPENDED: 'Agent credentials suspended',
  AGENT_BUDGET_EXCEEDED: 'Agent daily budget exhausted',
  GLOBAL_BUDGET_EXCEEDED: 'Global daily budget exhausted',
  CURRENCY_NOT_ALLOWED: 'Currency not in allowlist',
  VELOCITY: 'High request velocity detected',
  DUPLICATE: 'Duplicate payment pattern detected',
  CATEGORY_MISMATCH: 'Vendor category mismatch',
  AI_FLAG: 'Flagged by risk explainer model',
};

export function getReasonLabel(code: string): string {
  return REASON_CODE_LABELS[code] ?? code;
}

