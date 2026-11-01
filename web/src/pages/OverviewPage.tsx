import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiClient } from '../lib/api';
import {
  OverviewResponse,
  AgentsResponse,
  PaymentRequestsListResponse,
  PoliciesResponse,
  AgentSummary,
  PaymentRequestSummary,
  PolicySummary,
} from '../types/api';
import type { DashboardRoute } from '../types/ui';

import { SpendingVolumeChart } from '../components/overview/SpendingVolumeChart';
import { AgentCardStack } from '../components/overview/AgentCardStack';
import { BudgetGauge } from '../components/overview/BudgetGauge';
import { SpendingTrendsChart } from '../components/overview/SpendingTrendsChart';
import { AllocationBreakdown } from '../components/overview/AllocationBreakdown';
import { PendingApprovalsCard } from '../components/overview/PendingApprovalsCard';
import { RecentActivityFeed } from '../components/overview/RecentActivityFeed';
import { Skeleton } from '../components/ui/LoadingState';

interface OverviewPageProps {
  onNavigate?: (route: DashboardRoute) => void;
}

export function OverviewPage({ onNavigate }: OverviewPageProps) {
  const { owner } = useAuth();
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [requests, setRequests] = useState<PaymentRequestSummary[]>([]);
  const [totalRequestsCount, setTotalRequestsCount] = useState(0);
  const [heldRequests, setHeldRequests] = useState<PaymentRequestsListResponse | null>(null);
  const [activePolicy, setActivePolicy] = useState<PolicySummary | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  const fetchDashboardData = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setIsRefreshing(true);
    setError(null);

    try {
      const [overviewRes, agentsRes, requestsRes, heldRequestsRes, policiesRes] = await Promise.all([
        apiClient.get<OverviewResponse>('/api/overview'),
        apiClient.get<AgentsResponse>('/api/agents'),
        apiClient.get<PaymentRequestsListResponse>('/api/requests?limit=100'),
        apiClient.get<PaymentRequestsListResponse>('/api/requests?status=HELD&limit=50'),
        apiClient.get<PoliciesResponse>('/api/policies'),
      ]);

      setOverview(overviewRes);
      setAgents(agentsRes.agents ?? []);
      setRequests(requestsRes.items ?? []);
      setTotalRequestsCount(requestsRes.total ?? requestsRes.items?.length ?? 0);
      setHeldRequests(heldRequestsRes);
      setActivePolicy(policiesRes.activePolicy ?? null);
      setLastRefreshed(new Date());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch dashboard metrics';
      setError(message);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Initial fetch and 10s polling interval
  useEffect(() => {
    void fetchDashboardData(false);
    const interval = setInterval(() => {
      void fetchDashboardData(false);
    }, 10000);

    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  const activePolicyRules = activePolicy?.rules as
    | { auto_limit_minor?: number; hard_cap_minor?: number }
    | undefined;

  // Authoritative current pending holds count (only requests currently in HELD status)
  const currentPendingHeldCount = heldRequests?.total ?? 0;
  const currentPendingItems = heldRequests?.items ?? [];

  return (
    <div className="space-y-5">
      {/* Top Welcome & Firewall Status Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            gm, {owner?.displayName || 'Owner'}
          </h1>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            PayGuard MCP Firewall · Live PayPal Sandbox Policy & Spend Monitor
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] bg-[var(--card-bg)] px-3 py-1.5 rounded-xl border border-[var(--border-color)] transition-colors">
            <span className="w-1.5 h-1.5 rounded-full bg-[#B8D99A] animate-pulse" />
            <span className="font-mono text-[11px]">
              {lastRefreshed.toLocaleTimeString([], { hour12: false })}
            </span>
          </div>

          <button
            type="button"
            onClick={() => void fetchDashboardData(true)}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-primary)] bg-[var(--card-bg)] hover:bg-[var(--elevated-bg)] px-3 py-1.5 rounded-xl border border-[var(--border-color)] transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-[#B8D99A] ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Error Alert if fetching failed */}
      {error && (
        <div className="p-4 rounded-xl bg-[#E89A9A]/10 border border-[#E89A9A]/30 flex items-center justify-between text-xs text-[#F2F2F0]">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-[#E89A9A] flex-shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => void fetchDashboardData(true)}
            className="text-[#B8D99A] hover:underline font-medium ml-4"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading Skeletons */}
      {isLoading && !overview ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-5">
          <Skeleton className="h-[280px] lg:col-span-5 rounded-[26px]" />
          <Skeleton className="h-[280px] lg:col-span-4 rounded-[26px]" />
          <Skeleton className="h-[280px] lg:col-span-3 rounded-[26px]" />
          <Skeleton className="h-[260px] lg:col-span-5 rounded-[26px]" />
          <Skeleton className="h-[260px] lg:col-span-4 rounded-[26px]" />
          <Skeleton className="h-[260px] lg:col-span-3 rounded-[26px]" />
          <Skeleton className="h-[300px] lg:col-span-12 rounded-[26px]" />
        </div>
      ) : overview ? (
        /* Bento Command Grid Layout */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-5">
          {/* Row 1, Col 1: 24h Spend Headline & Volume Bars (lg:col-span-5) */}
          <SpendingVolumeChart
            overview={overview}
            requests={requests}
            className="lg:col-span-5"
          />

          {/* Row 1, Col 2: Agent Cards Stack (lg:col-span-4) */}
          <AgentCardStack
            agents={agents}
            className="lg:col-span-4"
          />

          {/* Row 1, Col 3: Budget Utilization Arc Gauge (lg:col-span-3) */}
          <BudgetGauge
            spentMinor={overview.budget.spentRolling24hMinor}
            reservedMinor={overview.budget.reservedRolling24hMinor}
            globalDailyBudgetMinor={overview.budget.globalDailyBudgetMinor}
            currency={overview.budget.currency}
            className="lg:col-span-3"
          />

          {/* Row 2, Col 1: Spending Velocity & Commitments Trend (lg:col-span-5) */}
          <SpendingTrendsChart
            overview={overview}
            requests={requests}
            totalRequestsCount={totalRequestsCount}
            className="lg:col-span-5"
          />

          {/* Row 2, Col 2: Category Allocation Breakdown (lg:col-span-4) */}
          <AllocationBreakdown
            requests={requests}
            className="lg:col-span-4"
          />

          {/* Row 2, Col 3: Pending Approvals Action Card (lg:col-span-3) */}
          <PendingApprovalsCard
            heldCount={currentPendingHeldCount}
            pendingRequests={currentPendingItems}
            autoLimitMinor={activePolicyRules?.auto_limit_minor}
            hardCapMinor={activePolicyRules?.hard_cap_minor}
            globalBudgetMinor={overview.budget.globalDailyBudgetMinor}
            onNavigateApprovals={() => onNavigate?.('approvals')}
            className="lg:col-span-3"
          />

          {/* Row 3: Live Recent Payments Stream (lg:col-span-12) */}
          <RecentActivityFeed
            recentActivity={overview.recentActivity}
            onViewAll={() => onNavigate?.('payments')}
            className="lg:col-span-12"
          />
        </div>
      ) : null}
    </div>
  );
}
