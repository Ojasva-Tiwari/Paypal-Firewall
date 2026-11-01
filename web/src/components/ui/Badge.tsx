import { cx } from '../../lib/utils';

export type BadgeStatus =
  | 'ALLOWED'
  | 'CAPTURED'
  | 'HELD'
  | 'DENIED'
  | 'FAILED'
  | 'VOIDED'
  | 'EXPIRED'
  | 'APPROVED'
  | 'CAPTURING'
  | 'AUTO_EXECUTING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'UNVERIFIED'
  | 'BLOCKED';

export interface BadgeProps {
  status: BadgeStatus | string;
  label?: string;
  className?: string;
}

export function Badge({ status, label, className }: BadgeProps) {
  const norm = (status || '').toUpperCase();
  const displayLabel = label || norm;

  let colorClasses = 'bg-[var(--elevated-bg)] text-[var(--text-secondary)] border-[var(--border-color)]';

  if (norm === 'ALLOWED' || norm === 'CAPTURED' || norm === 'ACTIVE') {
    colorClasses = 'bg-[var(--accent-sage)]/15 text-[var(--accent-sage)] border-[var(--accent-sage)]/30';
  } else if (norm === 'HELD' || norm === 'UNVERIFIED') {
    colorClasses = 'bg-[var(--accent-peach)]/15 text-[var(--accent-peach)] border-[var(--accent-peach)]/30';
  } else if (norm === 'DENIED' || norm === 'FAILED' || norm === 'BLOCKED' || norm === 'SUSPENDED') {
    colorClasses = 'bg-[var(--status-error-bg)] text-[var(--status-error)] border-[var(--status-error-border)]';
  } else if (norm === 'APPROVED' || norm === 'CAPTURING' || norm === 'AUTO_EXECUTING') {
    colorClasses = 'bg-[var(--accent-sage)]/20 text-[var(--accent-sage)] border-[var(--accent-sage)]/35';
  } else if (norm === 'VOIDED' || norm === 'EXPIRED') {
    colorClasses = 'bg-[var(--elevated-bg)] text-[var(--text-secondary)] border-[var(--border-color)]';
  }

  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wider',
        colorClasses,
        className
      )}
    >
      <span
        className={cx(
          'size-1.5 rounded-full',
          norm === 'ALLOWED' || norm === 'CAPTURED' || norm === 'ACTIVE'
            ? 'bg-[var(--accent-sage)]'
            : norm === 'HELD' || norm === 'UNVERIFIED'
            ? 'bg-[var(--accent-peach)]'
            : norm === 'DENIED' || norm === 'FAILED' || norm === 'BLOCKED' || norm === 'SUSPENDED'
            ? 'bg-[var(--status-error)]'
            : norm === 'APPROVED' || norm === 'CAPTURING' || norm === 'AUTO_EXECUTING'
            ? 'bg-[var(--accent-sage)]'
            : 'bg-[var(--text-secondary)]'
        )}
        aria-hidden="true"
      />
      <span>{displayLabel}</span>
    </span>
  );
}
