import {
  LayoutDashboard,
  CreditCard,
  CheckCircle2,
  Bot,
  ShieldCheck,
  Building2,
  History,
  Settings,
  ShieldAlert,
  LogOut,
} from 'lucide-react';
import type { DashboardRoute, NavItem } from '../../types/ui';
import { useAuth } from '../../context/AuthContext';
import { cx } from '../../lib/utils';

export interface SidebarProps {
  currentRoute: DashboardRoute;
  onNavigate: (route: DashboardRoute) => void;
  pendingApprovalsCount?: number;
  isOpenMobile?: boolean;
  onCloseMobile?: () => void;
}

export function Sidebar({
  currentRoute,
  onNavigate,
  pendingApprovalsCount = 0,
  isOpenMobile = false,
  onCloseMobile,
}: SidebarProps) {
  const { logout, owner } = useAuth();

  const navItems: NavItem[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'payments', label: 'Payments' },
    { id: 'approvals', label: 'Approvals', badge: pendingApprovalsCount },
    { id: 'agents', label: 'AI Agents' },
    { id: 'policies', label: 'Policies' },
    { id: 'vendors', label: 'Vendors' },
    { id: 'audit', label: 'Audit Log' },
    { id: 'settings', label: 'Settings' },
  ];

  const getIcon = (id: DashboardRoute) => {
    switch (id) {
      case 'overview':
        return LayoutDashboard;
      case 'payments':
        return CreditCard;
      case 'approvals':
        return CheckCircle2;
      case 'agents':
        return Bot;
      case 'policies':
        return ShieldCheck;
      case 'vendors':
        return Building2;
      case 'audit':
        return History;
      case 'settings':
        return Settings;
      case 'payment-detail':
        return CreditCard;
      default:
        return LayoutDashboard;
    }
  };

  return (
    <>
      {/* Mobile overlay */}
      {isOpenMobile && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      {/* Sidebar container */}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-[var(--border-color)] bg-[var(--sidebar-bg)] transition-transform duration-200 lg:static lg:translate-x-0',
          isOpenMobile ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Brand Header */}
        <div className="flex h-16 items-center gap-2.5 border-b border-[var(--border-color)] px-6">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--elevated-bg)] text-[var(--text-primary)] border border-[var(--border-color)]">
            <ShieldAlert className="h-4 w-4 text-[var(--accent-sage)]" />
          </div>
          <div className="flex flex-col">
            <span className="font-sans text-sm font-bold tracking-tight text-[var(--text-primary)]">PayGuard</span>
            <span className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-secondary)]">AI Agent Firewall</span>
          </div>
        </div>

        {/* Navigation list */}
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="Main Navigation">
          {navItems.map((item) => {
            const Icon = getIcon(item.id);
            const isActive =
              currentRoute === item.id || (currentRoute === 'payment-detail' && item.id === 'payments');

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onNavigate(item.id);
                  onCloseMobile?.();
                }}
                className={cx(
                  'flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-xs font-medium transition-colors select-none',
                  isActive
                    ? 'bg-[var(--elevated-bg)] text-[var(--text-primary)] font-semibold border border-[var(--border-color)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--elevated-bg)] hover:text-[var(--text-primary)]'
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon className={cx('h-4 w-4', isActive ? 'text-[var(--accent-sage)]' : 'text-[var(--text-muted)]')} />
                  <span>{item.label}</span>
                </div>
                {Boolean(item.badge && item.badge > 0) && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--accent-peach)]/20 px-1.5 font-mono text-[10px] font-bold text-[var(--accent-peach)]">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Owner Profile & Logout */}
        <div className="border-t border-[var(--border-color)] p-3">
          <div className="flex items-center justify-between rounded-xl bg-[var(--card-bg)] p-2.5 border border-[var(--border-color)]">
            <div className="min-w-0 pr-2">
              <p className="truncate text-xs font-medium text-[var(--text-primary)]">{owner?.displayName || 'Primary Owner'}</p>
              <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">Owner Session</p>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              title="Log out"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:bg-[var(--elevated-bg)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
