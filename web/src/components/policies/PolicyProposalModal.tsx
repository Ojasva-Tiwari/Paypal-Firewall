import { useState, useEffect } from 'react';
import {
  ShieldCheck,
  AlertTriangle,
  Info,
  XCircle,
  Clock,
  Hash,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  ArrowRight,
} from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/Table';
import { apiClient } from '../../lib/api';
import {
  formatPolicyFieldValue,
  getPolicyFieldLabel,
  getDiffChangeBadgeProps,
  getProposalStatusBadgeProps,
  isProposalExpired,
  calculateRemainingProposalMs,
  formatProposalCountdown,
  canActivateProposal,
  resolveActivationErrorMessage,
} from '../../lib/policyUtils';
import type { PolicyProposalDetail, ActivateProposalResponse, RejectProposalResponse } from '../../types/api';

export interface PolicyProposalModalProps {
  isOpen: boolean;
  proposal: PolicyProposalDetail | null;
  activePolicyVersion: number;
  onClose: () => void;
  onActivated: (response: ActivateProposalResponse) => void;
  onRejected: (response: RejectProposalResponse) => void;
}

export function PolicyProposalModal({
  isOpen,
  proposal,
  activePolicyVersion,
  onClose,
  onActivated,
  onRejected,
}: PolicyProposalModalProps) {
  const [acknowledgedRelaxations, setAcknowledgedRelaxations] = useState(false);
  const [isActivating, setIsActivating] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const [showRejectConfirm, setShowRejectConfirm] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('Rejected by owner from dashboard');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showRawJson, setShowRawJson] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  // Reset modal state whenever a new proposal is opened
  useEffect(() => {
    if (proposal) {
      setAcknowledgedRelaxations(false);
      setErrorMessage(null);
      setShowRejectConfirm(false);
      setShowRawJson(false);
    }
  }, [proposal?.id]);

  // Live countdown ticker
  useEffect(() => {
    if (!isOpen || !proposal) return;
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [isOpen, proposal]);

  if (!proposal) return null;

  const expired = isProposalExpired(proposal.expiresAt, nowMs) || proposal.status === 'EXPIRED';
  const remainingMs = calculateRemainingProposalMs(proposal.expiresAt, nowMs);
  const countdownText = formatProposalCountdown(remainingMs);
  const statusBadge = getProposalStatusBadgeProps(expired && proposal.status === 'PENDING' ? 'EXPIRED' : proposal.status);

  const isPending = proposal.status === 'PENDING' && !expired;
  const isStaleBaseVersion = proposal.baseVersion !== activePolicyVersion;

  const activationCheck = canActivateProposal(proposal, {
    acknowledged: acknowledgedRelaxations,
    nowMs,
  });

  const handleActivate = async () => {
    if (!activationCheck.allowed || isActivating || isRejecting) return;

    setIsActivating(true);
    setErrorMessage(null);

    try {
      const response = await apiClient.post<ActivateProposalResponse>(
        `/api/policies/drafts/${proposal.id}/activate`,
        {
          proposalHash: proposal.proposalHash,
          acknowledgeRelaxations: proposal.hasRelaxations ? true : undefined,
        }
      );
      onActivated(response);
    } catch (err: unknown) {
      const msg = resolveActivationErrorMessage(err);
      setErrorMessage(msg);
    } finally {
      setIsActivating(false);
    }
  };

  const handleReject = async () => {
    if (isRejecting || isActivating) return;

    setIsRejecting(true);
    setErrorMessage(null);

    try {
      const response = await apiClient.post<RejectProposalResponse>(
        `/api/policies/drafts/${proposal.id}/reject`,
        {
          reason: rejectionReason.trim() || 'Rejected by owner from dashboard',
        }
      );
      onRejected(response);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to reject proposal.');
    } finally {
      setIsRejecting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Policy Proposal Review"
      description="Deterministic differential analysis and authorization review for candidate financial rules"
      maxWidth="xl"
    >
      <div className="space-y-6 max-h-[80vh] overflow-y-auto pr-1">
        {/* Header Metadata Ribbon */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3 text-xs">
          <div>
            <span className="font-mono text-[10px] uppercase text-[var(--text-secondary)]">Proposal ID</span>
            <p className="font-mono font-medium text-[var(--text-primary)] truncate" title={proposal.id}>
              {proposal.id}
            </p>
          </div>
          <div>
            <span className="font-mono text-[10px] uppercase text-[var(--text-secondary)]">Version Transition</span>
            <p className="font-mono font-medium text-[var(--text-primary)] flex items-center gap-1.5">
              <span>Active v{proposal.baseVersion}</span>
              <ArrowRight className="h-3 w-3 text-[var(--text-muted)]" />
              <span className="text-[var(--accent-sage)] font-semibold">Candidate v{proposal.baseVersion + 1}</span>
            </p>
          </div>
          <div>
            <span className="font-mono text-[10px] uppercase text-[var(--text-secondary)]">Status & Expiry</span>
            <div className="flex items-center gap-2 mt-0.5">
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${statusBadge.className}`}
              >
                {statusBadge.label}
              </span>
              {isPending && (
                <span className="font-mono text-[11px] text-[var(--text-secondary)] flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {countdownText}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Stale Base Version Warning */}
        {isStaleBaseVersion && isPending && (
          <div className="flex items-start gap-3 rounded-xl border border-[var(--status-warn-border)] bg-[var(--status-warn-bg)] p-3.5 text-xs text-[var(--status-warn)]">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">Base Policy Version Conflict</p>
              <p className="text-[var(--text-primary)]">
                This proposal was generated against base version <strong>v{proposal.baseVersion}</strong>, but the current
                active version is now <strong>v{activePolicyVersion}</strong>. Activating this proposal will be refused
                by the concurrency guard to prevent overwriting intermediate changes. Please draft a new proposal against v{activePolicyVersion}.
              </p>
            </div>
          </div>
        )}

        {/* Expired Warning */}
        {expired && isPending && (
          <div className="flex items-start gap-3 rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3.5 text-xs text-[var(--status-error)]">
            <Clock className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">Proposal Expired</p>
              <p className="text-[var(--text-primary)]">
                The review TTL window for this proposal has elapsed. Expired proposals cannot be activated and must be regenerated.
              </p>
            </div>
          </div>
        )}

        {/* Error Alert */}
        {errorMessage && (
          <div className="flex items-start gap-3 rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3.5 text-xs text-[var(--status-error)]">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">Action Failed</p>
              <p className="text-[var(--text-primary)]">{errorMessage}</p>
            </div>
          </div>
        )}

        {/* AI Explanation Callout (Explicitly Labelled Informational) */}
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] p-4 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-[var(--accent-lavender)]" />
            <span className="font-semibold text-[var(--text-primary)]">
              AI Drafter Summary <span className="font-normal font-mono text-[10px] text-[var(--text-muted)]">(Informational Only)</span>
            </span>
          </div>
          <p className="text-[var(--text-secondary)] leading-relaxed">{proposal.explanation}</p>
          <p className="font-mono text-[10px] text-[var(--text-muted)] border-t border-[var(--border-color)]/60 pt-2">
            Security Invariant: AI summaries are advisory only. Ceilings, permissions, and status transitions are governed
            strictly by the deterministic differential analysis below.
          </p>
        </div>

        {/* Unsupported Requests Warning */}
        {proposal.unsupportedRequests && proposal.unsupportedRequests.length > 0 && (
          <div className="rounded-xl border border-[var(--status-warn-border)] bg-[var(--status-warn-bg)] p-4 text-xs text-[var(--status-warn)] space-y-1.5">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-4 w-4" />
              <span>Omitted Unsupported Requests</span>
            </div>
            <p className="text-[var(--text-primary)]">
              The drafter identified requested constraints that exceed current policy engine schema capabilities. These requests
              were safe-omitted and are <strong>not</strong> part of this proposal:
            </p>
            <ul className="list-disc pl-5 space-y-0.5 text-[var(--text-secondary)]">
              {proposal.unsupportedRequests.map((unsupported, uIdx) => (
                <li key={uIdx}>{unsupported}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Deterministic Policy Diff Table */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-primary)] font-mono">
              Deterministic Differential Analysis
            </h4>
            <span className="font-mono text-[11px] text-[var(--text-secondary)]">
              {proposal.diff.length} Field{proposal.diff.length === 1 ? '' : 's'} Evaluated
            </span>
          </div>

          <div className="rounded-xl border border-[var(--border-color)] overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%]">Field</TableHead>
                  <TableHead className="w-[18%]">Classification</TableHead>
                  <TableHead className="w-[27%]">Active Rule</TableHead>
                  <TableHead className="w-[27%]">Proposed Rule</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {proposal.diff.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-6 text-center text-xs text-[var(--text-secondary)]">
                      No field differences detected between active and proposed rules.
                    </TableCell>
                  </TableRow>
                ) : (
                  proposal.diff.map((item, idx) => {
                    const changeType = item.changeType || item.change || 'UNCHANGED';
                    const badge = getDiffChangeBadgeProps(changeType);
                    const activeValStr = formatPolicyFieldValue(item.field, item.activeValue);
                    const proposedValStr = formatPolicyFieldValue(item.field, item.proposedValue);

                    return (
                      <TableRow key={idx} className="text-xs">
                        <TableCell>
                          <div className="font-medium text-[var(--text-primary)]">{getPolicyFieldLabel(item.field)}</div>
                          <div className="font-mono text-[10px] text-[var(--text-muted)]">{item.field}</div>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-[var(--text-secondary)]">
                          {activeValStr}
                        </TableCell>
                        <TableCell className="font-mono text-[11px] font-semibold text-[var(--text-primary)]">
                          {proposedValStr}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Mandatory Relaxation Acknowledgement Callout */}
        {proposal.hasRelaxations && (
          <div className="rounded-xl border border-[var(--status-warn-border)] bg-[var(--status-warn-bg)] p-4 space-y-3">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="h-5 w-5 text-[var(--status-warn)] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h5 className="font-semibold text-xs text-[var(--status-warn)]">
                  Mandatory Relaxation Acknowledgement Required
                </h5>
                <p className="text-xs text-[var(--text-primary)]">
                  This policy proposal contains relaxations that expand financial spending ceilings or widen review windows:
                </p>
                <ul className="list-disc pl-4 space-y-1 text-xs text-[var(--text-secondary)]">
                  {proposal.relaxations.map((rel, rIdx) => (
                    <li key={rIdx}>{rel}</li>
                  ))}
                </ul>
              </div>
            </div>

            {isPending && (
              <label className="flex items-start gap-2.5 pt-2 border-t border-[var(--status-warn-border)]/50 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={acknowledgedRelaxations}
                  onChange={(e) => setAcknowledgedRelaxations(e.target.checked)}
                  disabled={isActivating || isRejecting}
                  className="mt-0.5 rounded border-[var(--border-color)] bg-[var(--elevated-bg)] text-[var(--accent-sage)] focus:ring-[var(--accent-sage)]"
                />
                <span className="text-xs text-[var(--text-primary)] font-medium">
                  I understand and explicitly authorize that this proposal relaxes financial limits or security controls.
                </span>
              </label>
            )}
          </div>
        )}

        {/* Collapsible Full Proposal Rules JSON */}
        <div className="border border-[var(--border-color)] rounded-xl overflow-hidden">
          <button
            type="button"
            onClick={() => setShowRawJson(!showRawJson)}
            className="w-full flex items-center justify-between p-3 bg-[var(--elevated-bg)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            <span className="font-mono flex items-center gap-1.5">
              <Hash className="h-3.5 w-3.5" />
              Candidate Rules & Cryptographic Hash ({proposal.proposalHash.slice(0, 16)}...)
            </span>
            {showRawJson ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {showRawJson && (
            <div className="p-3 bg-[var(--card-bg)] space-y-2 border-t border-[var(--border-color)]">
              <div className="text-[11px] font-mono text-[var(--text-muted)] flex items-center gap-1">
                <span>SHA-256 Hash:</span>
                <span className="text-[var(--text-primary)] select-all">{proposal.proposalHash}</span>
              </div>
              <pre className="max-h-60 overflow-auto rounded-lg border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3 font-mono text-xs text-[var(--text-primary)]">
                {JSON.stringify(proposal.rules, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Rejection Reason Form (when expanded) */}
        {showRejectConfirm && isPending && (
          <div className="rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-4 space-y-3">
            <h5 className="font-semibold text-xs text-[var(--status-error)]">Confirm Proposal Rejection</h5>
            <p className="text-xs text-[var(--text-secondary)]">
              Rejecting this proposal is irreversible and writes an immutable audit record.
            </p>
            <input
              type="text"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Reason for rejection (e.g. Budget ceiling too permissive)"
              className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--elevated-bg)] p-2 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
            />
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowRejectConfirm(false)}
                disabled={isRejecting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleReject}
                isLoading={isRejecting}
                disabled={isRejecting}
              >
                Confirm Rejection
              </Button>
            </div>
          </div>
        )}

        {/* Modal Action Bar */}
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-[var(--border-color)] pt-4">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isActivating || isRejecting}>
            Close
          </Button>

          {isPending && !showRejectConfirm && (
            <div className="flex items-center gap-2">
              <Button
                variant="danger"
                size="sm"
                onClick={() => setShowRejectConfirm(true)}
                disabled={isActivating || isRejecting}
              >
                <XCircle className="mr-1.5 h-4 w-4" />
                Reject Proposal
              </Button>

              <Button
                variant="primary"
                size="sm"
                onClick={handleActivate}
                disabled={!activationCheck.allowed || isActivating || isRejecting || isStaleBaseVersion}
                isLoading={isActivating}
                title={
                  isStaleBaseVersion
                    ? 'Base version conflict'
                    : proposal.hasRelaxations && !acknowledgedRelaxations
                    ? 'Must acknowledge relaxations before activating'
                    : undefined
                }
              >
                <ShieldCheck className="mr-1.5 h-4 w-4" />
                Activate Policy
              </Button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
