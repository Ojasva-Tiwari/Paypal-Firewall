import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Link2,
  Moon,
  RefreshCw,
  Send,
  Sun,
  Unlink,
} from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { LoadingSpinner } from '../components/ui/LoadingState';
import { useTheme } from '../context/ThemeContext';
import { formatDateTime } from '../lib/formatters';
import {
  extractTelegramStartCommand,
  fetchTelegramStatus,
  generateTelegramLinkToken,
  resolveTelegramErrorMessage,
  unlinkTelegramAccount,
} from '../lib/telegramSettings';
import type { TelegramLinkTokenResponse, TelegramStatusResponse } from '../types/api';

export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  const [telegramStatus, setTelegramStatus] = useState<TelegramStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [linkToken, setLinkToken] = useState<TelegramLinkTokenResponse | null>(null);
  const [generatingToken, setGeneratingToken] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const loadTelegramStatus = useCallback(async (opts?: { background?: boolean }) => {
    const isBackground = opts?.background === true;
    if (isBackground) {
      setStatusRefreshing(true);
    } else {
      setStatusLoading(true);
    }
    setStatusError(null);

    try {
      const nextStatus = await fetchTelegramStatus();
      setTelegramStatus(nextStatus);
      if (nextStatus.linked) {
        setLinkToken(null);
      }
      return nextStatus;
    } catch (err: unknown) {
      setStatusError(resolveTelegramErrorMessage(err, 'Failed to load Telegram connection status.'));
      return null;
    } finally {
      if (isBackground) {
        setStatusRefreshing(false);
      } else {
        setStatusLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadTelegramStatus();
  }, [loadTelegramStatus]);

  const handleRefreshStatus = async () => {
    setActionError(null);
    setActionSuccess(null);
    const wasLinked = telegramStatus?.linked ?? false;
    const next = await loadTelegramStatus({ background: true });
    if (next && !wasLinked && next.linked) {
      setActionSuccess('Telegram account is now linked and ready to receive notifications.');
    }
  };

  const handleGenerateLinkToken = async () => {
    setGeneratingToken(true);
    setActionError(null);
    setActionSuccess(null);
    setCopiedLabel(null);
    setConfirmUnlink(false);

    try {
      const minted = await generateTelegramLinkToken();
      setLinkToken(minted);
      setActionSuccess(
        'One-time link token generated. Open the bot link or send the /start command in Telegram, then click Refresh Status.'
      );
    } catch (err: unknown) {
      setActionError(resolveTelegramErrorMessage(err, 'Failed to generate Telegram link token.'));
    } finally {
      setGeneratingToken(false);
    }
  };

  const handleCopyText = async (value: string, label: string) => {
    setActionError(null);
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
        throw new Error('Clipboard access is unavailable in this browser.');
      }
      await navigator.clipboard.writeText(value);
      setCopiedLabel(label);
    } catch (err: unknown) {
      setCopiedLabel(null);
      setActionError(
        err instanceof Error ? err.message : 'Unable to copy to clipboard. Copy the value manually.'
      );
    }
  };

  const handleUnlinkTelegram = async () => {
    setUnlinking(true);
    setActionError(null);
    setActionSuccess(null);
    setCopiedLabel(null);

    try {
      const result = await unlinkTelegramAccount();
      setConfirmUnlink(false);
      setLinkToken(null);
      await loadTelegramStatus({ background: true });
      setActionSuccess(result.message || 'Telegram account unlinked successfully.');
    } catch (err: unknown) {
      setActionError(resolveTelegramErrorMessage(err, 'Failed to unlink Telegram account.'));
    } finally {
      setUnlinking(false);
    }
  };

  const startCommand = linkToken ? extractTelegramStartCommand(linkToken.deepLink) : null;

  const statusBadge = statusLoading ? (
    <Badge status="VOIDED" label="CHECKING" />
  ) : statusError && !telegramStatus ? (
    <Badge status="FAILED" label="UNAVAILABLE" />
  ) : !telegramStatus?.configured ? (
    <Badge status="VOIDED" label="DISABLED" />
  ) : telegramStatus.linked ? (
    <Badge status="ACTIVE" label="CONNECTED" />
  ) : (
    <Badge status="UNVERIFIED" label="NOT LINKED" />
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">Settings & Health</h2>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Interface preferences, Telegram approval alerts, and PayPal sandbox integration status
        </p>
      </div>

      {/* Theme Preference Card */}
      <Card title="Interface Appearance" subtitle="Choose your preferred visual presentation for the PayGuard firewall">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          {/* Dark Mode Option */}
          <button
            type="button"
            onClick={() => setTheme('dark')}
            className={`p-4 rounded-2xl border text-left flex flex-col justify-between transition-all cursor-pointer ${
              theme === 'dark'
                ? 'border-[var(--accent-sage)] bg-[var(--elevated-bg)] ring-1 ring-[var(--accent-sage)]'
                : 'border-[var(--border-color)] bg-[var(--card-bg)] hover:bg-[var(--elevated-bg)]'
            }`}
          >
            <div className="flex items-center justify-between w-full mb-3">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-[#050505] border border-[#262626] flex items-center justify-center text-[#B8D99A]">
                  <Moon className="h-4 w-4" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-[var(--text-primary)]">Dark Mode</h4>
                  <span className="text-[10px] uppercase font-mono text-[var(--text-secondary)]">Default · Pure Black</span>
                </div>
              </div>
              {theme === 'dark' && <CheckCircle2 className="h-4 w-4 text-[var(--accent-sage)]" />}
            </div>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Monochrome Mercury aesthetic with #050505 obsidian background, high contrast, and deep dark surfaces.
            </p>
          </button>

          {/* Light Mode Option */}
          <button
            type="button"
            onClick={() => setTheme('light')}
            className={`p-4 rounded-2xl border text-left flex flex-col justify-between transition-all cursor-pointer ${
              theme === 'light'
                ? 'border-[var(--accent-sage)] bg-[var(--elevated-bg)] ring-1 ring-[var(--accent-sage)]'
                : 'border-[var(--border-color)] bg-[var(--card-bg)] hover:bg-[var(--elevated-bg)]'
            }`}
          >
            <div className="flex items-center justify-between w-full mb-3">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-[#FAFAF8] border border-[#E3E5DF] flex items-center justify-center text-[#739B59]">
                  <Sun className="h-4 w-4" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-[var(--text-primary)]">Light Mode</h4>
                  <span className="text-[10px] uppercase font-mono text-[var(--text-secondary)]">Warm Neutral</span>
                </div>
              </div>
              {theme === 'light' && <CheckCircle2 className="h-4 w-4 text-[var(--accent-sage)]" />}
            </div>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Sophisticated, calm palette with #F5F6F3 natural canvas, crisp card surfaces, and comfortable daylight readability.
            </p>
          </button>
        </div>
      </Card>

      {/* Telegram Integration Card */}
      <Card
        title="Telegram Integration"
        subtitle="Receive real-time held-payment alerts and execute one-tap Approve / Void decisions from Telegram"
        action={statusBadge}
      >
        {statusLoading ? (
          <LoadingSpinner className="p-6" />
        ) : (
          <div className="space-y-4">
            {/* Load Error Banner */}
            {statusError && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] px-4 py-3 text-xs text-[var(--status-error)]">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{statusError}</span>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  isLoading={statusRefreshing}
                  onClick={() => void handleRefreshStatus()}
                >
                  Retry
                </Button>
              </div>
            )}

            {/* Action Error Banner */}
            {actionError && (
              <div className="flex items-start gap-2.5 rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] px-4 py-3 text-xs text-[var(--status-error)]">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{actionError}</span>
              </div>
            )}

            {/* Action Success Banner */}
            {actionSuccess && (
              <div className="flex items-start gap-2.5 rounded-xl border border-[var(--status-success-border)] bg-[var(--status-success-bg)] px-4 py-3 text-xs text-[var(--status-success)]">
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{actionSuccess}</span>
              </div>
            )}

            {telegramStatus && !telegramStatus.configured && (
              <div className="rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                      Telegram Bot Not Configured on Server
                    </h4>
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                      Telegram mode is currently <span className="font-mono text-[var(--text-primary)]">{telegramStatus.mode}</span>.
                      Dashboard approvals remain fully operational. To enable Telegram notifications and inline approvals,
                      configure <span className="font-mono text-[var(--text-primary)]">TELEGRAM_MODE=webhook</span> along with{' '}
                      <span className="font-mono text-[var(--text-primary)]">TELEGRAM_BOT_TOKEN</span>,{' '}
                      <span className="font-mono text-[var(--text-primary)]">TELEGRAM_BOT_USERNAME</span>,{' '}
                      <span className="font-mono text-[var(--text-primary)]">TELEGRAM_WEBHOOK_SECRET</span>, and{' '}
                      <span className="font-mono text-[var(--text-primary)]">TELEGRAM_ENCRYPTION_KEY</span> on the server.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    isLoading={statusRefreshing}
                    onClick={() => void handleRefreshStatus()}
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Refresh Status
                  </Button>
                </div>
              </div>
            )}

            {telegramStatus && telegramStatus.configured && !telegramStatus.linked && (
              <div className="space-y-4">
                <div className="rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Send className="h-4 w-4 text-[var(--accent-sage)]" />
                      <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                        Link Your Telegram Account
                      </h4>
                    </div>
                    <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                      Bot{' '}
                      <span className="font-mono text-[var(--text-primary)]">
                        {telegramStatus.botUsername ? `@${telegramStatus.botUsername}` : 'configured'}
                      </span>{' '}
                      is ready ({telegramStatus.mode} mode). Generate a single-use cryptographic link token to bind your private
                      Telegram chat to this owner account.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      isLoading={statusRefreshing}
                      onClick={() => void handleRefreshStatus()}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      Refresh Status
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      isLoading={generatingToken}
                      onClick={() => void handleGenerateLinkToken()}
                    >
                      <Link2 className="mr-1.5 h-3.5 w-3.5" />
                      {linkToken ? 'Regenerate Link Token' : 'Generate Link Token'}
                    </Button>
                  </div>
                </div>

                {linkToken && (
                  <div className="rounded-xl border border-[var(--accent-sage)]/30 bg-[var(--elevated-bg)] p-4 space-y-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-[var(--border-color)] pb-3">
                      <div>
                        <h5 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-primary)]">
                          Linking Instructions
                        </h5>
                        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                          Token expires {formatDateTime(linkToken.expiresAt)} ({Math.max(1, Math.round(linkToken.ttlSeconds / 60))} min TTL).
                        </p>
                      </div>
                      <a
                        href={linkToken.deepLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center rounded-xl bg-[var(--accent-sage)] px-3 py-1.5 text-xs font-semibold text-[var(--app-bg)] hover:bg-[var(--accent-sage-hover)] transition-colors"
                      >
                        Open Telegram Bot
                        <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                      </a>
                    </div>

                    <ol className="list-decimal list-inside space-y-2 text-xs text-[var(--text-secondary)]">
                      <li>
                        Click <span className="font-medium text-[var(--text-primary)]">Open Telegram Bot</span> (or open{' '}
                        <span className="font-mono text-[var(--text-primary)]">
                          {telegramStatus.botUsername ? `@${telegramStatus.botUsername}` : 'the PayGuard bot'}
                        </span>{' '}
                        in Telegram) and press <span className="font-mono text-[var(--text-primary)]">Start</span>.
                      </li>
                      <li>
                        If Telegram does not pre-fill the start token automatically, send this exact command in your private chat with the bot:
                      </li>
                      <li>
                        Return here and click <span className="font-medium text-[var(--text-primary)]">Refresh Status</span> to confirm the connection.
                      </li>
                    </ol>

                    <div className="grid grid-cols-1 gap-3">
                      {startCommand && (
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-[var(--border-color)] bg-[var(--card-bg)] px-3 py-2">
                          <div className="min-w-0">
                            <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
                              Manual Bot Command
                            </div>
                            <code className="block truncate font-mono text-xs text-[var(--text-primary)] mt-0.5">
                              {startCommand}
                            </code>
                          </div>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => void handleCopyText(startCommand, 'command')}
                          >
                            <Copy className="mr-1.5 h-3.5 w-3.5" />
                            {copiedLabel === 'command' ? 'Copied Command' : 'Copy Command'}
                          </Button>
                        </div>
                      )}

                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-lg border border-[var(--border-color)] bg-[var(--card-bg)] px-3 py-2">
                        <div className="min-w-0">
                          <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
                            Deep Link URL
                          </div>
                          <code className="block truncate font-mono text-xs text-[var(--text-secondary)] mt-0.5">
                            {linkToken.deepLink}
                          </code>
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => void handleCopyText(linkToken.deepLink, 'deepLink')}
                        >
                          <Copy className="mr-1.5 h-3.5 w-3.5" />
                          {copiedLabel === 'deepLink' ? 'Copied Link' : 'Copy Link'}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {telegramStatus && telegramStatus.linked && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
                      Telegram Chat ID
                    </div>
                    <div className="mt-1 font-mono text-xs font-medium text-[var(--text-primary)] break-all">
                      {telegramStatus.chatId ?? '—'}
                    </div>
                  </div>

                  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
                      Username
                    </div>
                    <div className="mt-1 font-mono text-xs font-medium text-[var(--text-primary)]">
                      {telegramStatus.username ? `@${telegramStatus.username}` : 'Not provided'}
                    </div>
                  </div>

                  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
                      Linked At
                    </div>
                    <div className="mt-1 font-mono text-xs font-medium text-[var(--text-primary)]">
                      {telegramStatus.linkedAt ? formatDateTime(telegramStatus.linkedAt) : '—'}
                    </div>
                  </div>

                  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] p-3">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
                      Bot / Mode
                    </div>
                    <div className="mt-1 font-mono text-xs font-medium text-[var(--text-primary)]">
                      {telegramStatus.botUsername
                        ? `@${telegramStatus.botUsername} (${telegramStatus.mode})`
                        : telegramStatus.mode}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-[var(--border-color)] bg-[var(--elevated-bg)] px-4 py-3">
                  <p className="text-xs text-[var(--text-secondary)]">
                    Unlinking immediately stops Telegram notifications and invalidates any pending inline approval buttons.
                  </p>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      isLoading={statusRefreshing}
                      onClick={() => void handleRefreshStatus()}
                    >
                      <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      Refresh Status
                    </Button>

                    {!confirmUnlink ? (
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={() => setConfirmUnlink(true)}
                      >
                        <Unlink className="mr-1.5 h-3.5 w-3.5" />
                        Unlink Telegram
                      </Button>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={unlinking}
                          onClick={() => setConfirmUnlink(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          isLoading={unlinking}
                          onClick={() => void handleUnlinkTelegram()}
                        >
                          Confirm Unlink
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
