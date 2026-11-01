import { Menu, Shield, Sun, Moon } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import type { DashboardRoute } from '../../types/ui';

export interface HeaderProps {
  currentRoute: DashboardRoute;
  onOpenMobileSidebar: () => void;
}

export function Header({ currentRoute, onOpenMobileSidebar }: HeaderProps) {
  const { toggleTheme, isDark } = useTheme();

  const titles: Record<DashboardRoute, string> = {
    overview: 'Overview',
    payments: 'Payment Requests',
    approvals: 'Pending Approvals',
    agents: 'AI Agents',
    policies: 'Financial Policies',
    vendors: 'Approved Vendors',
    audit: 'Immutable Audit Log',
    settings: 'Settings & Status',
    'payment-detail': 'Payment Details',
  };

  return (
    <header className="sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-[var(--border-color)] bg-[var(--app-bg)]/85 px-4 backdrop-blur-md sm:px-6 transition-colors duration-200">
      <div className="flex items-center gap-3">
        {/* Mobile menu trigger */}
        <button
          type="button"
          onClick={onOpenMobileSidebar}
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--elevated-bg)] transition-colors lg:hidden"
          aria-label="Open sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* Route title */}
        <div>
          <h1 className="text-sm font-semibold tracking-tight text-[var(--text-primary)] sm:text-base">
            {titles[currentRoute] || 'Dashboard'}
          </h1>
        </div>
      </div>

      {/* Right controls: Theme switcher & Status pills */}
      <div className="flex items-center gap-2.5 sm:gap-3">
        {/* Compact theme toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-9 items-center gap-1.5 rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] px-2.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--elevated-bg)] hover:text-[var(--text-primary)] transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-sage)] select-none"
          title={`Switch to ${isDark ? 'Light' : 'Dark'} mode (currently ${isDark ? 'Dark' : 'Light'})`}
          aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
        >
          {isDark ? (
            <>
              <Sun className="h-4 w-4 text-[var(--accent-peach)] transition-transform hover:rotate-45" />
              <span className="hidden md:inline text-[11px] font-medium text-[var(--text-secondary)]">Light</span>
            </>
          ) : (
            <>
              <Moon className="h-4 w-4 text-[var(--accent-lavender)] transition-transform hover:-rotate-12" />
              <span className="hidden md:inline text-[11px] font-medium text-[var(--text-secondary)]">Dark</span>
            </>
          )}
        </button>

        <div className="flex items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--card-bg)] px-3 py-1 font-medium text-[11px] text-[var(--text-secondary)] transition-colors">
          <span className="size-2 rounded-full bg-[var(--accent-sage)]" aria-hidden="true" />
          <span className="hidden sm:inline">PayPal</span> Sandbox
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--card-bg)] px-3 py-1 font-medium text-[11px] text-[var(--text-secondary)] transition-colors">
          <Shield className="h-3 w-3 text-[var(--accent-sage)]" />
          <span>Firewall Active</span>
        </div>
      </div>
    </header>
  );
}
