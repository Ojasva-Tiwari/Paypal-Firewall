import { useEffect, useState, useCallback } from 'react';
import {
  CreditCard,
  RotateCw,
  Bot,
  ChevronRight,
  Filter,
} from 'lucide-react';
import { PaymentRequestSummary, PaymentRequestsListResponse } from '../types/api';
import { apiClient, ApiError } from '../lib/api';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { formatCurrencyFromMinor, formatDateTime } from '../lib/formatters';

export interface PaymentsPageProps {
  onSelectRequest?: (id: string) => void;
}

export function PaymentsPage({ onSelectRequest }: PaymentsPageProps) {
  const [items, setItems] = useState<PaymentRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  const fetchPayments = useCallback(async (isManual = false) => {
    if (isManual) setIsRefreshing(true);
    setError(null);

    try {
      const endpoint =
        statusFilter === 'ALL'
          ? '/api/requests?limit=50'
          : `/api/requests?status=${statusFilter}&limit=50`;

      const res = await apiClient.get<PaymentRequestsListResponse>(endpoint);
      setItems(res.items || []);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to fetch payment requests.');
      }
    } finally {
      setLoading(false);
      if (isManual) setIsRefreshing(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchPayments();
  }, [fetchPayments]);

  const handleRowClick = (id: string) => {
    if (onSelectRequest) {
      onSelectRequest(id);
    } else {
      window.location.hash = `#/requests/${id}`;
    }
  };

  const filterTabs = [
    { id: 'ALL', label: 'All Requests' },
    { id: 'HELD', label: 'Held' },
    { id: 'CAPTURED', label: 'Captured' },
    { id: 'DENIED', label: 'Denied' },
    { id: 'VOIDED', label: 'Voided' },
  ];

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">Payment Requests</h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Audit-backed queue of all payment requests submitted across registered AI agents.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fetchPayments(true)}
            disabled={isRefreshing}
            className="text-xs min-h-[40px] px-3.5"
          >
            <RotateCw className={`h-3.5 w-3.5 mr-1.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-b border-[var(--border-color)]">
        {filterTabs.map((tab) => {
          const isActive = statusFilter === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setStatusFilter(tab.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-[var(--card-bg)] text-[var(--text-primary)] border border-[var(--border-color)] font-semibold shadow-xs'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--elevated-bg)]'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Error Banner */}
      {error && !loading && (
        <div className="rounded-xl bg-[#E5989B]/15 border border-[#E5989B]/30 p-4 text-xs text-[#E5989B] flex items-center justify-between">
          <span>{error}</span>
          <Button variant="secondary" size="sm" onClick={() => fetchPayments(true)} className="text-xs">
            Retry
          </Button>
        </div>
      )}

      {/* Loading Skeletons */}
      {loading && (
        <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] p-6 space-y-3 animate-pulse">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 bg-[var(--elevated-bg)] rounded-xl" />
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && items.length === 0 && (
        <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] p-12 text-center flex flex-col items-center justify-center space-y-3">
          <div className="h-12 w-12 rounded-xl bg-[var(--elevated-bg)] border border-[var(--border-color)] flex items-center justify-center text-[var(--text-secondary)]">
            <CreditCard className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-[var(--text-primary)]">No Payment Requests</h3>
          <p className="text-xs text-[var(--text-secondary)] max-w-sm">
            {statusFilter === 'ALL'
              ? 'No payment requests have been submitted by agents yet.'
              : `No payment requests matching status "${statusFilter}" were found.`}
          </p>
        </div>
      )}

      {/* Payments Table / List */}
      {!loading && !error && items.length > 0 && (
        <div className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border-color)] overflow-hidden shadow-sm">
          <div className="p-4 border-b border-[var(--border-color)] flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span className="flex items-center gap-1.5 font-medium">
              <Filter className="h-3.5 w-3.5" /> Showing {items.length} {items.length === 1 ? 'request' : 'requests'}
            </span>
            <span className="font-mono text-[11px]">Click any request to view full audit details</span>
          </div>

          <div className="divide-y divide-[var(--border-color)]">
            {items.map((req) => (
              <div
                key={req.id}
                onClick={() => handleRowClick(req.id)}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-[var(--elevated-bg)] cursor-pointer transition-colors group"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleRowClick(req.id);
                  }
                }}
              >
                {/* Left: Vendor, Agent, Purpose */}
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-[var(--text-primary)] group-hover:text-[var(--text-primary)] transition-colors truncate">
                      {req.vendorName}
                    </span>
                    <Badge status={req.status} />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
                    <span className="flex items-center gap-1">
                      <Bot className="h-3 w-3 text-[var(--text-secondary)]" />
                      {req.agentName}
                    </span>
                    <span>•</span>
                    <span className="font-mono text-[11px]">{formatDateTime(req.createdAt)}</span>
                    {req.purpose && (
                      <>
                        <span className="hidden md:inline">•</span>
                        <span className="hidden md:inline truncate max-w-xs">{req.purpose}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Right: Amount & Arrow */}
                <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                  <div className="text-left sm:text-right">
                    <div className="font-sans text-base font-bold text-[var(--text-primary)]">
                      {formatCurrencyFromMinor(req.amountMinor, req.currency)}
                    </div>
                    <div className="text-[10px] font-mono text-[var(--text-secondary)] uppercase">
                      {req.currency}
                    </div>
                  </div>
                  <div className="h-8 w-8 rounded-full bg-[var(--elevated-bg)] border border-[var(--border-color)] flex items-center justify-center text-[var(--text-secondary)] group-hover:text-[var(--text-primary)] group-hover:border-[var(--border-color)] transition-colors">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
