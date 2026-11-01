import React, { useState } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import type { DashboardRoute } from '../../types/ui';

export interface AppShellProps {
  currentRoute: DashboardRoute;
  onNavigate: (route: DashboardRoute) => void;
  pendingApprovalsCount?: number;
  children: React.ReactNode;
}

export function AppShell({
  currentRoute,
  onNavigate,
  pendingApprovalsCount = 0,
  children,
}: AppShellProps) {
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-[var(--app-bg)] text-[var(--text-primary)] transition-colors duration-200">
      <Sidebar
        currentRoute={currentRoute}
        onNavigate={onNavigate}
        pendingApprovalsCount={pendingApprovalsCount}
        isOpenMobile={isMobileSidebarOpen}
        onCloseMobile={() => setIsMobileSidebarOpen(false)}
      />

      <div className="flex flex-1 flex-col overflow-hidden bg-[var(--content-bg)] transition-colors duration-200">
        <Header
          currentRoute={currentRoute}
          onOpenMobileSidebar={() => setIsMobileSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
