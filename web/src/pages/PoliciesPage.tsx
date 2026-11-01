import { useEffect, useState } from 'react';
import { ShieldCheck, History, Eye, Info, AlertTriangle } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { LoadingSpinner } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { apiClient } from '../lib/api';
import { formatCurrencyFromMinor, formatDateTime } from '../lib/formatters';
import type { PoliciesResponse, PolicySummary } from '../types/api';

interface PolicyRules {
  version?: number;
  currency_allowlist?: string[];
  auto_limit_minor?: number;
  hard_cap_minor?: number;
  agent_daily_budget_minor?: number;
  global_daily_budget_minor?: number;
  velocity?: {
    max_requests?: number;
    window_minutes?: number;
  };
  duplicate_window_minutes?: number;
  new_vendor_action?: 'HOLD' | 'DENY';
  hold_ttl_minutes?: number;
  [key: string]: unknown;
}

export function PoliciesPage() {
  const [data, setData] = useState<PoliciesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<PolicySummary | null>(null);

  const fetchPolicies = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.get<PoliciesResponse>('/api/policies');
      setData(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load policy configurations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPolicies();
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (error || !data) {
    return (
      <Card className="p-6">
        <EmptyState
          icon={AlertTriangle}
          title="Unable to load policies"
          description={error || 'An unexpected error occurred while fetching policies.'}
          action={
            <Button variant="secondary" size="sm" onClick={fetchPolicies}>
              Retry
            </Button>
          }
        />
      </Card>
    );
  }

  const active = data.activePolicy;
  const activeRules = (active?.rules || {}) as PolicyRules;
  const history = data.history || [];

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">Financial Policies</h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Deterministic rules engine ceilings, velocity limits, and immutable version history
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--elevated-bg)] px-3 py-1 font-mono text-xs text-[var(--text-secondary)]">
            <span className="size-1.5 rounded-full bg-[var(--accent-sage)]" />
            READ-ONLY ENFORCEMENT
          </span>
        </div>
      </div>

      {/* Scope / Read-only Notice */}
      <div className="flex items-start gap-3 rounded-2xl border border-[var(--border-color)] bg-[var(--card-bg)] p-4 text-xs text-[var(--text-secondary)]">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-sage)]" />
        <div className="space-y-1">
          <p className="font-medium text-[var(--text-primary)]">Strict Deterministic Policy Engine</p>
          <p>
            All AI agent payment requests are evaluated against the active policy version below. Historical versions
            are permanently immutable and preserved for audit reconciliation. Policy editing and plain-language authoring
            are scheduled for upcoming milestones.
          </p>
        </div>
      </div>

      {/* Active Policy Card */}
      {active ? (
        <Card className="space-y-6 p-6">
          <div className="flex flex-col gap-4 border-b border-[var(--border-color)] pb-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-sage)]/10 text-[var(--accent-sage)]">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-[var(--text-primary)]">
                    Active Policy v{active.version}
                  </h3>
                  <Badge status="ACTIVE" label="ACTIVE VERSION" />
                </div>
                <p className="mt-0.5 font-mono text-xs text-[var(--text-secondary)]">
                  Author: {active.author} &bull; Activated {formatDateTime(active.createdAt)}
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSelectedVersion(active)}
              className="self-start sm:self-auto"
            >
              <Eye className="mr-1.5 h-3.5 w-3.5" />
              View Full Rules
            </Button>
          </div>

          {/* Grid of Ceilings & Settings */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-4">
              <span className="font-mono text-[11px] font-medium uppercase text-[var(--text-secondary)]">
                Auto-Approve Limit
              </span>
              <p className="mt-1 font-mono text-xl font-bold tracking-tight text-[var(--text-primary)]">
                {activeRules.auto_limit_minor !== undefined
                  ? formatCurrencyFromMinor(activeRules.auto_limit_minor, 'USD')
                  : '—'}
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-secondary)]">Instant execution ceiling</p>
            </div>

            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-4">
              <span className="font-mono text-[11px] font-medium uppercase text-[var(--text-secondary)]">
                Maximum Hard Cap
              </span>
              <p className="mt-1 font-mono text-xl font-bold tracking-tight text-[var(--text-primary)]">
                {activeRules.hard_cap_minor !== undefined
                  ? formatCurrencyFromMinor(activeRules.hard_cap_minor, 'USD')
                  : '—'}
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-secondary)]">Strict hard denial threshold</p>
            </div>

            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-4">
              <span className="font-mono text-[11px] font-medium uppercase text-[var(--text-secondary)]">
                Agent Daily Cap
              </span>
              <p className="mt-1 font-mono text-xl font-bold tracking-tight text-[var(--text-primary)]">
                {activeRules.agent_daily_budget_minor !== undefined
                  ? formatCurrencyFromMinor(activeRules.agent_daily_budget_minor, 'USD')
                  : '—'}
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-secondary)]">Per-agent rolling 24h limit</p>
            </div>

            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-4">
              <span className="font-mono text-[11px] font-medium uppercase text-[var(--text-secondary)]">
                Global Daily Budget
              </span>
              <p className="mt-1 font-mono text-xl font-bold tracking-tight text-[var(--text-primary)]">
                {activeRules.global_daily_budget_minor !== undefined
                  ? formatCurrencyFromMinor(activeRules.global_daily_budget_minor, 'USD')
                  : '—'}
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-secondary)]">Total firewall 24h ceiling</p>
            </div>
          </div>

          {/* Secondary Rule Attributes */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 pt-2">
            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] p-4">
              <span className="font-mono text-[11px] font-medium uppercase text-[var(--text-secondary)]">
                Velocity Ceiling
              </span>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-mono text-base font-semibold text-[var(--text-primary)]">
                  {activeRules.velocity?.max_requests ?? 5} requests
                </span>
                <span className="text-xs text-[var(--text-secondary)]">
                  per {activeRules.velocity?.window_minutes ?? 10} min
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] p-4">
              <span className="font-mono text-[11px] font-medium uppercase text-[var(--text-secondary)]">
                Allowed Currencies
              </span>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(activeRules.currency_allowlist || ['USD']).map((curr) => (
                  <span
                    key={curr}
                    className="rounded-md border border-[var(--border-color)] bg-[var(--elevated-bg)] px-2 py-0.5 font-mono text-xs font-semibold text-[var(--text-primary)]"
                  >
                    {curr}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] p-4">
              <span className="font-mono text-[11px] font-medium uppercase text-[var(--text-secondary)]">
                Unverified Vendor Action
              </span>
              <div className="mt-2 flex items-center gap-2">
                <Badge
                  status={activeRules.new_vendor_action === 'DENY' ? 'DENIED' : 'HELD'}
                  label={activeRules.new_vendor_action || 'HOLD'}
                />
                <span className="text-xs text-[var(--text-secondary)]">
                  TTL: {activeRules.hold_ttl_minutes ?? 15}m
                </span>
              </div>
            </div>
          </div>
        </Card>
      ) : (
        <Card className="p-6">
          <EmptyState
            icon={ShieldCheck}
            title="No Active Policy Found"
            description="The system has not initialized an active financial policy document."
          />
        </Card>
      )}

      {/* Immutable Version History */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-[var(--text-secondary)]" />
          <h3 className="text-base font-semibold text-[var(--text-primary)]">Version History</h3>
          <span className="rounded-full bg-[var(--elevated-bg)] px-2 py-0.5 font-mono text-xs text-[var(--text-secondary)]">
            {history.length}
          </span>
        </div>

        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Author</TableHead>
                <TableHead>Activated At</TableHead>
                <TableHead>Auto Limit</TableHead>
                <TableHead>Hard Cap</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-xs text-[var(--text-secondary)]">
                    No historical policy versions found.
                  </TableCell>
                </TableRow>
              ) : (
                history.map((versionItem) => {
                  const rules = (versionItem.rules || {}) as PolicyRules;
                  return (
                    <TableRow key={versionItem.id}>
                      <TableCell className="font-mono font-medium">v{versionItem.version}</TableCell>
                      <TableCell>
                        <Badge
                          status={versionItem.active ? 'ACTIVE' : 'VOIDED'}
                          label={versionItem.active ? 'ACTIVE' : 'ARCHIVED'}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs text-[var(--text-secondary)]">
                        {versionItem.author}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-[var(--text-secondary)]">
                        {formatDateTime(versionItem.createdAt)}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {rules.auto_limit_minor !== undefined
                          ? formatCurrencyFromMinor(rules.auto_limit_minor, 'USD')
                          : '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {rules.hard_cap_minor !== undefined
                          ? formatCurrencyFromMinor(rules.hard_cap_minor, 'USD')
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedVersion(versionItem)}
                          className="h-8 px-2 text-xs"
                        >
                          <Eye className="mr-1 h-3.5 w-3.5" />
                          View Rules
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      {/* Inspect Policy Version Modal */}
      {selectedVersion && (
        <Modal
          isOpen={Boolean(selectedVersion)}
          onClose={() => setSelectedVersion(null)}
          title={`Policy Rules — Version ${selectedVersion.version}`}
          description={`Immutable policy definition authored by ${selectedVersion.author} on ${formatDateTime(
            selectedVersion.createdAt
          )}`}
          maxWidth="lg"
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3">
              <span className="font-mono text-xs text-[var(--text-secondary)]">Status</span>
              <Badge
                status={selectedVersion.active ? 'ACTIVE' : 'VOIDED'}
                label={selectedVersion.active ? 'ACTIVE VERSION' : 'ARCHIVED VERSION'}
              />
            </div>

            <div className="space-y-2">
              <span className="font-mono text-xs font-semibold uppercase text-[var(--text-secondary)]">
                Stored Policy JSON
              </span>
              <pre className="max-h-80 overflow-auto rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-4 font-mono text-xs text-[var(--text-primary)]">
                {JSON.stringify(selectedVersion.rules, null, 2)}
              </pre>
            </div>

            <div className="flex justify-end pt-2">
              <Button variant="secondary" size="sm" onClick={() => setSelectedVersion(null)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
