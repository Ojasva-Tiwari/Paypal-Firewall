import React from 'react';
import { cx } from '../../lib/utils';

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  action?: React.ReactNode;
  subtitle?: React.ReactNode;
}

export function Card({ title, subtitle, action, className, children, ...props }: CardProps) {
  return (
    <section
      className={cx(
        'relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--border-color)] bg-[var(--card-bg)] p-5 text-[var(--text-primary)] shadow-sm transition-colors duration-200',
        className
      )}
      {...props}
    >
      {(title || action || subtitle) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
