import { useState, useEffect } from 'react';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppShell } from './components/layout/AppShell';
import { LoadingSpinner } from './components/ui/LoadingState';
import type { DashboardRoute } from './types/ui';

// Pages
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { PaymentDetailPage } from './pages/PaymentDetailPage';
import { AgentsPage } from './pages/AgentsPage';
import { PoliciesPage } from './pages/PoliciesPage';
import { VendorsPage } from './pages/VendorsPage';
import { AuditPage } from './pages/AuditPage';
import { SettingsPage } from './pages/SettingsPage';

interface ParsedRoute {
  route: DashboardRoute;
  requestId?: string;
}

function parseRouteFromHash(): ParsedRoute {
  const rawHash = window.location.hash.replace(/^#\/?/, '').trim();
  const parts = rawHash.split('/');
  const base = parts[0]?.toLowerCase() || '';
  const param = parts[1];

  if ((base === 'requests' || base === 'payments') && param) {
    return {
      route: 'payment-detail',
      requestId: param,
    };
  }

  switch (base) {
    case 'payments':
      return { route: 'payments' };
    case 'approvals':
      return { route: 'approvals' };
    case 'agents':
      return { route: 'agents' };
    case 'policies':
      return { route: 'policies' };
    case 'vendors':
      return { route: 'vendors' };
    case 'audit':
      return { route: 'audit' };
    case 'settings':
      return { route: 'settings' };
    case 'overview':
    default:
      return { route: 'overview' };
  }
}

function DashboardRouter() {
  const { isAuthenticated, isLoading } = useAuth();
  const [currentParsedRoute, setCurrentParsedRoute] = useState<ParsedRoute>(parseRouteFromHash());
  const [originatingRoute, setOriginatingRoute] = useState<DashboardRoute>('overview');

  useEffect(() => {
    const handleHashChange = () => {
      const parsed = parseRouteFromHash();
      setCurrentParsedRoute((prev) => {
        // Track the originating screen when diving into payment-detail
        if (prev.route !== 'payment-detail' && parsed.route === 'payment-detail') {
          setOriginatingRoute(prev.route);
        }
        return parsed;
      });
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const navigateTo = (route: DashboardRoute) => {
    window.location.hash = `#/${route}`;
  };

  const navigateToRequest = (id: string) => {
    window.location.hash = `#/requests/${id}`;
  };

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigateTo(originatingRoute || 'payments');
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--app-bg)]">
        <LoadingSpinner />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  const renderPage = () => {
    switch (currentParsedRoute.route) {
      case 'overview':
        return <OverviewPage onNavigate={navigateTo} />;
      case 'payments':
        return <PaymentsPage onSelectRequest={navigateToRequest} />;
      case 'approvals':
        return <ApprovalsPage onInspectRequest={navigateToRequest} />;
      case 'payment-detail':
        return (
          <PaymentDetailPage
            requestId={currentParsedRoute.requestId || ''}
            onBack={handleBack}
          />
        );
      case 'agents':
        return <AgentsPage />;
      case 'policies':
        return <PoliciesPage />;
      case 'vendors':
        return <VendorsPage />;
      case 'audit':
        return <AuditPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <OverviewPage onNavigate={navigateTo} />;
    }
  };

  return (
    <AppShell currentRoute={currentParsedRoute.route} onNavigate={navigateTo}>
      {renderPage()}
    </AppShell>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <DashboardRouter />
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
