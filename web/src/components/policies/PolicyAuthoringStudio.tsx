import { useState } from 'react';
import { Sparkles, AlertTriangle, ShieldAlert, Clock, CornerDownLeft } from 'lucide-react';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { apiClient } from '../../lib/api';
import { resolveDraftErrorMessage } from '../../lib/policyUtils';
import type { PolicyProposalDetail } from '../../types/api';

export interface PolicyAuthoringStudioProps {
  activeVersion: number;
  onProposalDrafted: (proposal: PolicyProposalDetail) => void;
}

const EXAMPLE_PROMPTS = [
  {
    label: 'Conservative Guardrails',
    prompt: 'Set auto-approve limit to $15 and hard cap to $100. Deny all unverified vendors immediately.',
  },
  {
    label: 'High-Volume Micro-Transactions',
    prompt: 'Auto-approve payments up to $10. Increase velocity ceiling to 15 requests per 10 minutes.',
  },
  {
    label: 'Stricter Velocity & Hold Review',
    prompt: 'Reduce velocity limit to 3 requests every 15 minutes. Increase hold review TTL to 30 minutes.',
  },
  {
    label: 'Expanded Currencies',
    prompt: 'Allow USD and EUR currencies. Require approval for anything over $50.',
  },
];

const MAX_PROMPT_CHARS = 2000;

export function PolicyAuthoringStudio({ activeVersion, onProposalDrafted }: PolicyAuthoringStudioProps) {
  const [prompt, setPrompt] = useState('');
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [isGenerating, setIsGenerating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [unsupportedWarnings, setUnsupportedWarnings] = useState<string[]>([]);

  const charCount = prompt.length;
  const isOverLimit = charCount > MAX_PROMPT_CHARS;
  const isSubmitDisabled = isGenerating || !prompt.trim() || isOverLimit;

  const handleGenerate = async () => {
    if (isSubmitDisabled) return;

    setIsGenerating(true);
    setErrorMessage(null);
    setUnsupportedWarnings([]);

    try {
      const response = await apiClient.post<PolicyProposalDetail>('/api/policies/draft', {
        prompt: prompt.trim(),
        ttlMinutes,
      });

      if (response.unsupportedRequests && response.unsupportedRequests.length > 0) {
        setUnsupportedWarnings(response.unsupportedRequests);
      }

      onProposalDrafted(response);
    } catch (err: unknown) {
      const msg = resolveDraftErrorMessage(err);
      setErrorMessage(msg);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Enter or Cmd+Enter to submit
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleGenerate();
    }
  };

  return (
    <Card className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between border-b border-[var(--border-color)] pb-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-lavender)]/15 text-[var(--accent-lavender)]">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-[var(--text-primary)]">
              Plain-English Policy Authoring
            </h3>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
              Describe your desired financial rules in natural language. PayGuard synthesizes a structured,
              validated candidate policy against active version <strong>v{activeVersion}</strong>.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto font-mono text-xs text-[var(--text-secondary)]">
          <Clock className="h-3.5 w-3.5" />
          <span>Review TTL: {ttlMinutes}m</span>
        </div>
      </div>

      {/* Preset Example Chips */}
      <div className="space-y-2">
        <span className="font-mono text-[11px] font-medium uppercase text-[var(--text-secondary)]">
          Quick Starters / Templates
        </span>
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_PROMPTS.map((example, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setPrompt(example.prompt)}
              className="rounded-lg border border-[var(--border-color)] bg-[var(--elevated-bg)] px-2.5 py-1 text-xs text-[var(--text-secondary)] hover:border-[var(--accent-lavender)]/50 hover:text-[var(--text-primary)] transition-colors cursor-pointer text-left"
            >
              {example.label}
            </button>
          ))}
        </div>
      </div>

      {/* Textarea Input */}
      <div className="space-y-2">
        <div className="relative">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isGenerating}
            rows={4}
            placeholder="e.g., Never allow payments above $100 to new vendors. Require human approval for payments above $50. Cap daily agent spend at $200."
            className="w-full rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--accent-sage)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-sage)] transition-colors resize-y min-h-[90px]"
          />
        </div>

        {/* Character Count & Shortcut Hint */}
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--text-muted)] flex items-center gap-1 font-mono">
            <CornerDownLeft className="h-3 w-3 inline" /> Press Ctrl+Enter to generate
          </span>
          <span
            className={`font-mono ${
              isOverLimit ? 'font-bold text-[var(--status-error)]' : 'text-[var(--text-secondary)]'
            }`}
          >
            {charCount} / {MAX_PROMPT_CHARS} characters
          </span>
        </div>
      </div>

      {/* Unsupported Requests Warning */}
      {unsupportedWarnings.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-[var(--status-warn-border)] bg-[var(--status-warn-bg)] p-4 text-xs text-[var(--status-warn)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warn)]" />
          <div className="space-y-1">
            <p className="font-semibold">Unsupported Constraints Noted</p>
            <p className="text-[var(--text-secondary)]">
              The AI engine noted that the following requested rules are outside the current policy engine schema
              and were safely omitted:
            </p>
            <ul className="list-disc pl-4 space-y-0.5 text-[var(--text-primary)]">
              {unsupportedWarnings.map((warning, wIdx) => (
                <li key={wIdx}>{warning}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Error Alert */}
      {errorMessage && (
        <div className="flex items-start gap-3 rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-4 text-xs text-[var(--status-error)]">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">Draft Generation Failed</p>
            <p className="text-[var(--text-primary)]">{errorMessage}</p>
          </div>
        </div>
      )}

      {/* Generating Pipeline State */}
      {isGenerating && (
        <div className="flex items-center gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3 text-xs text-[var(--text-secondary)] animate-pulse">
          <Sparkles className="h-4 w-4 text-[var(--accent-lavender)] shrink-0 animate-spin" />
          <span>
            Evaluating prompt against active policy v{activeVersion}, scanning prompt injection, and computing deterministic diff...
          </span>
        </div>
      )}

      {/* Footer Action Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-2">
        <div className="flex items-center gap-2">
          <label htmlFor="ttl-select" className="text-xs text-[var(--text-secondary)]">
            Proposal Expiry:
          </label>
          <select
            id="ttl-select"
            value={ttlMinutes}
            onChange={(e) => setTtlMinutes(Number(e.target.value))}
            disabled={isGenerating}
            className="rounded-lg border border-[var(--border-color)] bg-[var(--elevated-bg)] px-2 py-1 text-xs text-[var(--text-primary)] focus:outline-none"
          >
            <option value={15}>15 minutes</option>
            <option value={30}>30 minutes</option>
            <option value={60}>1 hour</option>
            <option value={240}>4 hours</option>
            <option value={1440}>24 hours</option>
          </select>
        </div>

        <Button
          variant="primary"
          onClick={handleGenerate}
          disabled={isSubmitDisabled}
          isLoading={isGenerating}
          className="w-full sm:w-auto"
        >
          <Sparkles className="mr-2 h-4 w-4" />
          Generate Policy Proposal
        </Button>
      </div>
    </Card>
  );
}
