import React from 'react';
import { LucideIcon, Inbox } from 'lucide-react';
import { cx } from '../../lib/utils';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        'flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--border-color)] p-8 text-center transition-colors duration-200',
        className
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--elevated-bg)] text-[var(--text-secondary)] border border-[var(--border-color)]">
        <Icon className="h-6 w-6 stroke-[1.5]" />
      </div>
      <h4 className="mt-4 text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
      {description && <p className="mt-1.5 max-w-sm text-xs text-[var(--text-secondary)] leading-relaxed">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
