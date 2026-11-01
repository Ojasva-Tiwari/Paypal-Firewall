import React from 'react';
import { cx } from '../../lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className, id, ...props }, ref) => {
    const inputId = id || React.useId();

    return (
      <div className="flex w-full flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-xs font-medium text-[var(--text-secondary)]">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cx(
            'flex h-10 w-full rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] px-3.5 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent-sage)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-sage)] disabled:cursor-not-allowed disabled:opacity-50 transition-colors',
            error && 'border-[var(--status-error)] focus:border-[var(--status-error)] focus:ring-[var(--status-error)]',
            className
          )}
          {...props}
        />
        {hint && !error && <p className="text-[11px] text-[var(--text-secondary)]">{hint}</p>}
        {error && <p className="text-[11px] text-[var(--status-error)]">{error}</p>}
      </div>
    );
  }
);

Input.displayName = 'Input';
