import { useState, useEffect } from 'react';
import { Eye, Clock, RefreshCw, FileText } from 'lucide-react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/Table';
import { LoadingSpinner } from '../ui/LoadingState';
import {
  getProposalStatusBadgeProps,
  isProposalExpired,
  calculateRemainingProposalMs,
  formatProposalCountdown,
} from '../../lib/policyUtils';
import { formatDateTime } from '../../lib/formatters';
import type { PolicyProposalSummary, ProposalStatus } from '../../types/api';

export type StatusFilterOption = 'ALL' | ProposalStatus;

export interface PolicyProposalsTableProps {
  proposals: PolicyProposalSummary[];
  loading: boolean;
  statusFilter: StatusFilterOption;
  onFilterChange: (filter: StatusFilterOption) => void;
  onSelectProposal: (proposal: PolicyProposalSummary) => void;
  onRefresh: () => void;
}

export function PolicyProposalsTable({
  proposals,
  loading,
  statusFilter,
  onFilterChange,
  onSelectProposal,
  onRefresh,
}: PolicyProposalsTableProps) {
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const filterOptions: Array<{ id: StatusFilterOption; label: string }> = [
    { id: 'ALL', label: 'All Proposals' },
    { id: 'PENDING', label: 'Pending' },
    { id: 'ACTIVATED', label: 'Activated' },
    { id: 'REJECTED', label: 'Rejected' },
    { id: 'EXPIRED', label: 'Expired' },
  ];

  return (
    <div className="space-y-4">
      {/* Header and Filter Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-[var(--text-secondary)]" />
          <h3 className="text-base font-semibold text-[var(--text-primary)]">Policy Proposals</h3>
          <span className="rounded-full bg-[var(--elevated-bg)] px-2 py-0.5 font-mono text-xs text-[var(--text-secondary)]">
            {proposals.length}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Status Filter Tabs */}
          <div className="flex items-center rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] p-1 text-xs">
            {filterOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => onFilterChange(opt.id)}
                className={`rounded-lg px-2.5 py-1 font-medium transition-colors cursor-pointer ${
                  statusFilter === opt.id
                    ? 'bg-[var(--elevated-bg)] text-[var(--text-primary)] font-semibold shadow-xs'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <Button variant="ghost" size="sm" onClick={onRefresh} className="h-8 w-8 p-0" aria-label="Refresh proposals">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Proposals Table */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <LoadingSpinner />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Proposal ID</TableHead>
                <TableHead>Base → Target</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Diff Analysis</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expiry / Event</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {proposals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-xs text-[var(--text-secondary)]">
                    No policy proposals found matching the selected filter.
                  </TableCell>
                </TableRow>
              ) : (
                proposals.map((item) => {
                  const expired = isProposalExpired(item.expiresAt, nowMs) || item.status === 'EXPIRED';
                  const effectiveStatus: ProposalStatus =
                    expired && item.status === 'PENDING' ? 'EXPIRED' : item.status;
                  const badge = getProposalStatusBadgeProps(effectiveStatus);
                  const remainingMs = calculateRemainingProposalMs(item.expiresAt, nowMs);

                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-mono text-xs font-medium text-[var(--text-primary)] truncate max-w-[120px]" title={item.id}>
                        {item.id}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        v{item.baseVersion} → v{item.baseVersion + 1}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {item.hasRelaxations ? (
                          <span className="font-mono text-[11px] text-[var(--status-warn)]">
                            {item.relaxations.length} Relaxation{item.relaxations.length === 1 ? '' : 's'}
                          </span>
                        ) : (
                          <span className="font-mono text-[11px] text-[var(--accent-sage)]">
                            Tightened / Constrained
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-[var(--text-secondary)]">
                        {formatDateTime(item.createdAt)}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-[var(--text-secondary)]">
                        {item.status === 'PENDING' && !expired ? (
                          <span className="flex items-center gap-1 text-[var(--accent-lavender)]">
                            <Clock className="h-3 w-3" />
                            {formatProposalCountdown(remainingMs)}
                          </span>
                        ) : item.status === 'ACTIVATED' && item.activatedAt ? (
                          <span>Activated</span>
                        ) : item.status === 'REJECTED' && item.rejectedAt ? (
                          <span>Rejected</span>
                        ) : (
                          <span>Expired</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onSelectProposal(item)}
                          className="h-8 px-2.5 text-xs"
                        >
                          <Eye className="mr-1 h-3.5 w-3.5" />
                          Review
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

