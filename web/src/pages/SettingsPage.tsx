import { Settings, Moon, Sun, CheckCircle2 } from 'lucide-react';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { useTheme } from '../context/ThemeContext';

export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">Settings & Health</h2>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          Interface preferences, runtime configuration, and PayPal sandbox status
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

      <Card>
        <EmptyState
          icon={Settings}
          title="System Settings"
          description="Service diagnostics and PayPal activity panel will be implemented in Milestone M4-T10."
        />
      </Card>
    </div>
  );
}

