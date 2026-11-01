import { useEffect, useState } from 'react';
import { Bot, Plus, AlertTriangle, CheckCircle2, Copy, Check, ShieldAlert, KeyRound } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/Table';
import { Modal } from '../components/ui/Modal';
import { LoadingSpinner } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { apiClient } from '../lib/api';
import { formatCurrencyFromMinor, formatDateTime } from '../lib/formatters';
import type { AgentsResponse, AgentSummary, CreateAgentResponse, SuspendAgentResponse } from '../types/api';

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Agent Creation Modal
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState('');
  const [dailyBudget, setDailyBudget] = useState('50.00');

  // One-Time Transient Secret Key Modal (Requirement 3: strictly transient memory only)
  const [revealedSecret, setRevealedSecret] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Suspension Confirmation Modal
  const [agentToSuspend, setAgentToSuspend] = useState<AgentSummary | null>(null);
  const [suspendSubmitting, setSuspendSubmitting] = useState(false);
  const [suspendError, setSuspendError] = useState<string | null>(null);

  // Notification Banner
  const [notification, setNotification] = useState<string | null>(null);

  const fetchAgents = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await apiClient.get<AgentsResponse>('/api/agents');
      setAgents(res.agents || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to retrieve agent list');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAgents();
    return () => {
      // Clear key transient state on unmount / navigation away
      setRevealedSecret(null);
      setCopied(false);
    };
  }, []);

  const handleOpenCreateModal = () => {
    setAgentName('');
    setDailyBudget('50.00');
    setCreateError(null);
    setIsCreateModalOpen(true);
  };

  const handleCreateAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);

    const trimmedName = agentName.trim();
    if (!trimmedName || trimmedName.length > 100) {
      setCreateError('Agent name is required (max 100 characters).');
      return;
    }

    const budgetNum = parseFloat(dailyBudget.trim());
    if (isNaN(budgetNum) || budgetNum < 0) {
      setCreateError('Daily budget must be a positive number (e.g. 50.00).');
      return;
    }

    try {
      setCreateSubmitting(true);
      const res = await apiClient.post<CreateAgentResponse>('/api/agents', {
        name: trimmedName,
        daily_budget_decimal: budgetNum.toFixed(2),
      });

      setIsCreateModalOpen(false);

      // Store key ONLY in transient component memory for one-time reveal
      setRevealedSecret({
        name: res.name,
        key: res.apiKey,
      });
      setCopied(false);

      await fetchAgents();
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create agent.');
    } finally {
      setCreateSubmitting(false);
    }
  };

  const handleDismissSecretKey = () => {
    // Security Invariant (Requirement 3):
    // Clear key from transient memory immediately upon modal dismissal. Never persist in localStorage or sessionStorage.
    setRevealedSecret(null);
    setCopied(false);
  };

  const handleCopyKey = async () => {
    if (!revealedSecret) return;
    try {
      await navigator.clipboard.writeText(revealedSecret.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  };

  const handleConfirmSuspend = async () => {
    if (!agentToSuspend) return;
    try {
      setSuspendSubmitting(true);
      setSuspendError(null);
      await apiClient.post<SuspendAgentResponse>(`/api/agents/${agentToSuspend.id}/suspend`, {});

      const suspendedName = agentToSuspend.name;
      setAgentToSuspend(null);
      setNotification(`Agent '${suspendedName}' has been suspended.`);
      setTimeout(() => setNotification(null), 4000);
      await fetchAgents();
    } catch (err: unknown) {
      setSuspendError(err instanceof Error ? err.message : 'Failed to suspend agent.');
    } finally {
      setSuspendSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">AI Agents</h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            Registered autonomous agents, daily spending limits, and suspension controls
          </p>
        </div>
        <Button onClick={handleOpenCreateModal} size="sm" className="self-start sm:self-auto">
          <Plus className="mr-1.5 h-4 w-4" />
          Register Agent
        </Button>
      </div>

      {/* Notification Banner */}
      {notification && (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--accent-sage)]/30 bg-[var(--accent-sage)]/10 p-3 text-xs text-[var(--accent-sage)]">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{notification}</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <Card className="p-6">
          <EmptyState
            icon={AlertTriangle}
            title="Failed to load agents"
            description={error}
            action={
              <Button variant="secondary" size="sm" onClick={fetchAgents}>
                Retry
              </Button>
            }
          />
        </Card>
      )}

      {/* Agents Table */}
      {!error && (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Daily Budget</TableHead>
                <TableHead>Registered</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-12 text-center">
                    <EmptyState
                      icon={Bot}
                      title="No Agents Registered"
                      description="Register an autonomous AI agent to provision an authenticated MCP API key."
                      action={
                        <Button size="sm" onClick={handleOpenCreateModal}>
                          <Plus className="mr-1.5 h-4 w-4" />
                          Register Agent
                        </Button>
                      }
                    />
                  </TableCell>
                </TableRow>
              ) : (
                agents.map((agent) => (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium text-[var(--text-primary)]">{agent.name}</span>
                        <span className="font-mono text-xs text-[var(--text-secondary)]">{agent.id}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge status={agent.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs font-semibold text-[var(--text-primary)]">
                      {formatCurrencyFromMinor(agent.dailyBudgetMinor, 'USD')}
                      <span className="ml-1 text-[11px] font-normal text-[var(--text-secondary)]">/ 24h</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-[var(--text-secondary)]">
                      {formatDateTime(agent.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {agent.status === 'ACTIVE' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSuspendError(null);
                            setAgentToSuspend(agent);
                          }}
                          className="h-8 px-2 text-xs text-[var(--status-error)] hover:bg-[var(--status-error-bg)]"
                        >
                          <ShieldAlert className="mr-1 h-3.5 w-3.5" />
                          Suspend
                        </Button>
                      ) : (
                        <span className="font-mono text-xs text-[var(--text-muted)]">Suspended</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Register Agent Modal */}
      <Modal
        isOpen={isCreateModalOpen}
        onClose={() => !createSubmitting && setIsCreateModalOpen(false)}
        title="Register New Agent"
        description="Provision credentials and daily budget ceiling for an autonomous AI agent."
        maxWidth="md"
      >
        <form onSubmit={handleCreateAgent} className="space-y-4">
          {createError && (
            <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3 text-xs text-[var(--status-error)]">
              {createError}
            </div>
          )}

          <Input
            label="Agent Name"
            placeholder="e.g. Travel Booking Assistant, Code Reviewer"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            hint="Identifies the agent in audit logs and payment requests."
            required
            autoFocus
          />

          <Input
            label="Daily Spending Limit (USD)"
            placeholder="50.00"
            type="number"
            step="0.01"
            min="0"
            value={dailyBudget}
            onChange={(e) => setDailyBudget(e.target.value)}
            hint="Maximum rolling 24-hour total spend permitted for this agent."
            required
          />

          <div className="flex justify-end gap-2 pt-4 border-t border-[var(--border-color)]">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setIsCreateModalOpen(false)}
              disabled={createSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" isLoading={createSubmitting}>
              Generate Credentials
            </Button>
          </div>
        </form>
      </Modal>

      {/* One-Time Secret Key Reveal Modal (Transient Memory Only) */}
      {revealedSecret && (
        <Modal
          isOpen={Boolean(revealedSecret)}
          onClose={handleDismissSecretKey}
          title="Agent Secret Key Generated"
          description={`One-time MCP authentication credential for '${revealedSecret.name}'.`}
          maxWidth="md"
        >
          <div className="space-y-4">
            {/* High-visibility security warning */}
            <div className="flex items-start gap-3 rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3.5 text-xs text-[var(--status-error)]">
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-error)]" />
              <div className="space-y-1">
                <p className="font-semibold">Save This Secret Key Immediately</p>
                <p>
                  This secret key is shown <strong>ONCE</strong>. It is hashed before storage and cannot be retrieved,
                  re-displayed, or recovered by anyone. Store it securely in your agent configuration.
                </p>
              </div>
            </div>

            {/* API Key Box */}
            <div className="space-y-1.5">
              <label className="font-mono text-xs text-[var(--text-secondary)]">Secret API Key</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={revealedSecret.key}
                  className="flex h-10 w-full rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] px-3 font-mono text-xs font-semibold text-[var(--text-primary)] focus:outline-none"
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleCopyKey}
                  className="h-10 shrink-0 gap-1 px-3"
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4 text-[var(--accent-sage)]" />
                      <span className="text-xs text-[var(--accent-sage)]">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      <span className="text-xs">Copy</span>
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="flex justify-end pt-4 border-t border-[var(--border-color)]">
              <Button type="button" size="sm" onClick={handleDismissSecretKey}>
                I have securely saved this key
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Suspend Confirmation Modal */}
      {agentToSuspend && (
        <Modal
          isOpen={Boolean(agentToSuspend)}
          onClose={() => !suspendSubmitting && setAgentToSuspend(null)}
          title="Confirm Agent Suspension"
          description={`Revoke payment authorization for '${agentToSuspend.name}'.`}
          maxWidth="sm"
        >
          <div className="space-y-4">
            {suspendError && (
              <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3 text-xs text-[var(--status-error)]">
                {suspendError}
              </div>
            )}

            <p className="text-xs text-[var(--text-secondary)]">
              Are you sure you want to suspend this agent? Any payment requests issued by{' '}
              <strong className="text-[var(--text-primary)]">{agentToSuspend.name}</strong> will be immediately{' '}
              <strong className="text-[var(--status-error)]">DENIED</strong> by the policy firewall engine.
            </p>

            <div className="flex justify-end gap-2 pt-2 border-t border-[var(--border-color)]">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setAgentToSuspend(null)}
                disabled={suspendSubmitting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleConfirmSuspend}
                isLoading={suspendSubmitting}
              >
                Suspend Agent
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
