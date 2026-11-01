import { cx } from '../../lib/utils';

export function LoadingSpinner({ className }: { className?: string }) {
  return (
    <div className={cx('flex items-center justify-center p-8', className)}>
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border-color)] border-t-[var(--accent-sage)]" />
    </div>
  );
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx('animate-pulse rounded-xl bg-[var(--elevated-bg)]', className)}
      {...props}
    />
  );
}
