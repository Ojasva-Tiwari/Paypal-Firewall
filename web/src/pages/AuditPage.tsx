import { useEffect, useState, useTransition } from 'react';
import { History, Search, Filter, RotateCcw, AlertTriangle, Eye, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { LoadingSpinner } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { apiClient } from '../lib/api';
import { formatDateTime, formatRelativeTime } from '../lib/formatters';
import type { AuditLogResponse, AuditLogSummary } from '../types/api';

const COMMON_EVENTS = [
  'ALL',
  'PAYMENT_REQUESTED',
  'POLICY_ACTIVATED',
  'VENDOR_CREATED',
  'AGENT_CREATED',
  'AGENT_SUSPENDED',
  'APPROVAL_GRANTED',
  'PAYMENT_CAPTURED',
  'PAYMENT_VOIDED',
  'HOLD_EXPIRED',
];

export function AuditPage() {
  const [items, setItems] = useState<AuditLogSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination
  const [limit] = useState(25);
  const [offset, setOffset] = useState(0);

  // Filters supported by backend in src/api/owner.ts
  const [actorFilter, setActorFilter] = useState<string>('ALL');
  const [eventFilter, setEventFilter] = useState<string>('ALL');
  const [customEvent, setCustomEvent] = useState<string>('');
  const [requestIdFilter, setRequestIdFilter] = useState<string>('');

  // Payload Detail Modal
  const [selectedEntry, setSelectedEntry] = useState<AuditLogSummary | null>(null);

  const [, startTransition] = useTransition();

  const fetchAuditLogs = async (currentOffset = offset) => {
    try {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(currentOffset));

      if (actorFilter && actorFilter !== 'ALL') {
        params.set('actor', actorFilter);
      }

      const activeEvent = customEvent.trim() || (eventFilter !== 'ALL' ? eventFilter : '');
      if (activeEvent) {
        params.set('event', activeEvent);
      }

      if (requestIdFilter.trim()) {
        params.set('requestId', requestIdFilter.trim());
      }

      const res = await apiClient.get<AuditLogResponse>(`/api/audit?${params.toString()}`);
      setItems(res.items || []);
      setTotal(res.total || 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to retrieve audit log');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAuditLogs(offset);
  }, [offset, actorFilter, eventFilter]);

  const handleApplyFilters = (e: React.FormEvent) => {
    e.preventDefault();
    setOffset(0);
    fetchAuditLogs(0);
  };

  const handleResetFilters = () => {
    setActorFilter('ALL');
    setEventFilter('ALL');
    setCustomEvent('');
    setRequestIdFilter('');
    setOffset(0);
    startTransition(() => {
      fetchAuditLogs(0);
    });
  };

  const hasActiveFilters =
    actorFilter !== 'ALL' || eventFilter !== 'ALL' || Boolean(customEvent.trim()) || Boolean(requestIdFilter.trim());

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">Audit Log</h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Append-only activity log of all state transitions and policy decisions
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-[var(--text-secondary)]">
            Total Logged Events: <strong className="text-[var(--text-primary)]">{total}</strong>
          </span>
        </div>
      </div>

      {/* Filter Bar */}
      <Card className="p-4">
        <form onSubmit={handleApplyFilters} className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
            <Filter className="h-3.5 w-3.5" />
            <span>Filter Audit Trail</span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {/* Actor Filter */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-[var(--text-secondary)]">Actor</label>
              <select
                value={actorFilter}
                onChange={(e) => {
                  setActorFilter(e.target.value);
                  setOffset(0);
                }}
                className="flex h-9 w-full rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] px-3 text-xs text-[var(--text-primary)] focus:border-[var(--accent-sage)] focus:outline-none"
              >
                <option value="ALL">All Actors</option>
                <option value="agent">agent (MCP client)</option>
                <option value="owner">owner (Dashboard operator)</option>
                <option value="system">system (Automated engine)</option>
                <option value="ai">ai (LLM adviser)</option>
              </select>
            </div>

            {/* Event Preset Filter */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-[var(--text-secondary)]">Event Type</label>
              <select
                value={eventFilter}
                onChange={(e) => {
                  setEventFilter(e.target.value);
                  setCustomEvent('');
                  setOffset(0);
                }}
                className="flex h-9 w-full rounded-xl border border-[var(--input-border)] bg-[var(--input-bg)] px-3 text-xs text-[var(--text-primary)] focus:border-[var(--accent-sage)] focus:outline-none"
              >
                {COMMON_EVENTS.map((evt) => (
                  <option key={evt} value={evt}>
                    {evt === 'ALL' ? 'All Event Types' : evt}
                  </option>
                ))}
              </select>
            </div>

            {/* Request ID Filter */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-[var(--text-secondary)]">Request ID</label>
              <Input
                placeholder="req-..."
                value={requestIdFilter}
                onChange={(e) => setRequestIdFilter(e.target.value)}
                className="h-9 text-xs font-mono"
              />
            </div>

            {/* Actions */}
            <div className="flex items-end gap-2">
              <Button type="submit" size="sm" className="h-9 flex-1 gap-1.5">
                <Search className="h-3.5 w-3.5" />
                Filter
              </Button>
              {hasActiveFilters && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleResetFilters}
                  className="h-9 px-2.5 text-xs text-[var(--text-secondary)]"
                  title="Reset filters"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        </form>
      </Card>

      {/* Error state */}
      {error && (
        <Card className="p-6">
          <EmptyState
            icon={AlertTriangle}
            title="Failed to load audit logs"
            description={error}
            action={
              <Button variant="secondary" size="sm" onClick={() => fetchAuditLogs(offset)}>
                Retry
              </Button>
            }
          />
        </Card>
      )}

      {/* Audit Log Table */}
      {!error && (
        <Card className="overflow-hidden">
          {loading ? (
            <div className="flex h-64 items-center justify-center">
              <LoadingSpinner />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Request Reference</TableHead>
                  <TableHead>Entry Hash</TableHead>
                  <TableHead className="text-right">Payload</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-12 text-center">
                      <EmptyState
                        icon={History}
                        title="No Matching Audit Records"
                        description={
                          hasActiveFilters
                            ? 'No events match the selected filter criteria. Try adjusting or clearing filters.'
                            : 'No state transitions or audit events recorded in the ledger yet.'
                        }
                        action={
                          hasActiveFilters ? (
                            <Button variant="secondary" size="sm" onClick={handleResetFilters}>
                              Clear Filters
                            </Button>
                          ) : undefined
                        }
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((entry) => {
                    const shortHash = entry.hash ? `${entry.hash.slice(0, 10)}…` : '—';
                    return (
                      <TableRow key={entry.id}>
                        <TableCell className="whitespace-nowrap">
                          <div className="flex flex-col">
                            <span className="font-mono text-xs text-[var(--text-primary)]">
                              {formatDateTime(entry.timestamp)}
                            </span>
                            <span className="text-[11px] text-[var(--text-secondary)]">
                              {formatRelativeTime(entry.timestamp)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider ${
                              entry.actor === 'agent'
                                ? 'border-[var(--accent-lavender)]/30 bg-[var(--accent-lavender)]/15 text-[var(--accent-lavender)]'
                                : entry.actor === 'owner'
                                ? 'border-[var(--accent-sage)]/30 bg-[var(--accent-sage)]/15 text-[var(--accent-sage)]'
                                : entry.actor === 'ai'
                                ? 'border-[var(--accent-peach)]/30 bg-[var(--accent-peach)]/15 text-[var(--accent-peach)]'
                                : 'border-[var(--border-color)] bg-[var(--elevated-bg)] text-[var(--text-secondary)]'
                            }`}
                          >
                            {entry.actor}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="rounded-md border border-[var(--border-color)] bg-[var(--elevated-bg)] px-2 py-1 font-mono text-xs font-semibold text-[var(--text-primary)]">
                            {entry.event}
                          </span>
                        </TableCell>
                        <TableCell>
                          {entry.requestId ? (
                            <a
                              href={`#/requests/${entry.requestId}`}
                              className="inline-flex items-center gap-1 font-mono text-xs text-[var(--accent-sage)] hover:underline"
                            >
                              <span>{entry.requestId}</span>
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="font-mono text-xs text-[var(--text-muted)]">—</span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-[var(--text-secondary)]" title={entry.hash}>
                          {shortHash}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectedEntry(entry)}
                            className="h-8 px-2 text-xs"
                          >
                            <Eye className="mr-1 h-3.5 w-3.5" />
                            Inspect
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}

          {/* Pagination Controls */}
          {total > 0 && (
            <div className="flex flex-col gap-2 border-t border-[var(--border-color)] p-4 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs text-[var(--text-secondary)]">
                Showing{' '}
                <strong className="text-[var(--text-primary)]">
                  {offset + 1}–{Math.min(offset + limit, total)}
                </strong>{' '}
                of <strong className="text-[var(--text-primary)]">{total}</strong> events
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  disabled={offset === 0 || loading}
                  className="h-8 gap-1 px-2.5 text-xs"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setOffset(offset + limit)}
                  disabled={offset + limit >= total || loading}
                  className="h-8 gap-1 px-2.5 text-xs"
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Inspect Audit Entry Modal */}
      {selectedEntry && (
        <Modal
          isOpen={Boolean(selectedEntry)}
          onClose={() => setSelectedEntry(null)}
          title={`Audit Event: ${selectedEntry.event}`}
          description={`Logged by ${selectedEntry.actor} at ${formatDateTime(selectedEntry.timestamp)}`}
          maxWidth="lg"
        >
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3 text-xs sm:grid-cols-2">
              <div>
                <span className="text-[11px] text-[var(--text-secondary)]">Event ID:</span>
                <p className="font-mono font-medium text-[var(--text-primary)]">{selectedEntry.id}</p>
              </div>
              <div>
                <span className="text-[11px] text-[var(--text-secondary)]">Actor:</span>
                <p className="font-mono font-medium uppercase text-[var(--text-primary)]">{selectedEntry.actor}</p>
              </div>
              {selectedEntry.requestId && (
                <div>
                  <span className="text-[11px] text-[var(--text-secondary)]">Request Reference:</span>
                  <p className="font-mono font-medium text-[var(--text-primary)]">{selectedEntry.requestId}</p>
                </div>
              )}
              <div>
                <span className="text-[11px] text-[var(--text-secondary)]">Recorded Timestamp:</span>
                <p className="font-mono font-medium text-[var(--text-primary)]">{selectedEntry.timestamp}</p>
              </div>
            </div>

            {/* Hash Metadata */}
            <div className="space-y-2 rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] p-3 text-xs">
              <span className="font-mono text-[11px] font-semibold uppercase text-[var(--text-secondary)]">
                Hash Metadata
              </span>
              <div className="space-y-1">
                <div className="flex flex-col">
                  <span className="text-[11px] text-[var(--text-secondary)]">Entry Hash:</span>
                  <span className="break-all font-mono text-[11px] text-[var(--text-primary)]">
                    {selectedEntry.hash}
                  </span>
                </div>
                {selectedEntry.prevHash && (
                  <div className="flex flex-col pt-1">
                    <span className="text-[11px] text-[var(--text-secondary)]">Previous Hash:</span>
                    <span className="break-all font-mono text-[11px] text-[var(--text-secondary)]">
                      {selectedEntry.prevHash}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Escaped Structured Payload */}
            <div className="space-y-1.5">
              <span className="font-mono text-[11px] font-semibold uppercase text-[var(--text-secondary)]">
                Event Payload JSON
              </span>
              <pre className="max-h-64 overflow-auto rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3 font-mono text-xs text-[var(--text-primary)]">
                {JSON.stringify(selectedEntry.payload, null, 2)}
              </pre>
            </div>

            <div className="flex justify-end pt-2 border-t border-[var(--border-color)]">
              <Button variant="secondary" size="sm" onClick={() => setSelectedEntry(null)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
