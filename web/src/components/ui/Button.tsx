import React from 'react';
import { cx } from '../../lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  isLoading = false,
  className,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const baseStyles =
    'inline-flex items-center justify-center font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-sage)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-bg)] disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98] select-none cursor-pointer';

  const variantStyles = {
    primary: 'bg-[var(--accent-sage)] text-[var(--app-bg)] hover:bg-[var(--accent-sage-hover)] shadow-sm font-semibold',
    secondary: 'bg-[var(--elevated-bg)] text-[var(--text-primary)] border border-[var(--border-color)] hover:bg-[var(--card-bg)] hover:text-[var(--text-primary)]',
    ghost: 'bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--elevated-bg)]',
    danger: 'bg-[var(--status-error-bg)] text-[var(--status-error)] border border-[var(--status-error-border)] hover:brightness-110',
  };

  const sizeStyles = {
    sm: 'rounded-xl px-3 py-1.5 text-xs h-8',
    md: 'rounded-xl px-4 py-2 text-sm h-10',
    lg: 'rounded-2xl px-5 py-2.5 text-base h-12',
  };

  return (
    <button
      className={cx(baseStyles, variantStyles[variant], sizeStyles[size], className)}
      disabled={disabled || isLoading}
      {...props}
    >
      {isLoading && (
        <svg
          className="mr-2 h-4 w-4 animate-spin text-current"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
      )}
      {children}
    </button>
  );
}
