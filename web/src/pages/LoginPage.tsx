import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ShieldAlert, AlertCircle, Loader2, Sun, Moon } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

export function LoginPage() {
  const { login, error: authError } = useAuth();
  const { toggleTheme, isDark } = useTheme();
  const [passphrase, setPassphrase] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Generate 5 organic metallic mercury blobs positioned toward the right
  const blobsData = useMemo(() => {
    return [
      { size: 320, left: 62, top: 15, delay: 0, duration: 24 },
      { size: 260, left: 74, top: 48, delay: -6, duration: 28 },
      { size: 380, left: 58, top: 62, delay: -12, duration: 22 },
      { size: 200, left: 82, top: 28, delay: -18, duration: 26 },
      { size: 240, left: 68, top: 78, delay: -8, duration: 30 },
    ];
  }, []);

  const blobRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    // Check for user's reduced-motion preference
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mediaQuery.matches) return;

    let rafId: number | null = null;

    const handleMouseMove = (e: MouseEvent) => {
      if (rafId) return;

      rafId = requestAnimationFrame(() => {
        const x = (e.clientX / window.innerWidth - 0.5) * 2; // -1 to 1
        const y = (e.clientY / window.innerHeight - 0.5) * 2;

        blobRefs.current.forEach((blob, index) => {
          if (blob) {
            const factor = (index + 1) * 8; // Restrained parallax
            blob.style.marginLeft = `${x * factor}px`;
            blob.style.marginTop = `${y * factor}px`;
          }
        });
        rafId = null;
      });
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase.trim()) {
      setLocalError('Please enter your owner passphrase');
      return;
    }

    setLocalError(null);
    setIsSubmitting(true);
    try {
      await login(passphrase.trim());
    } finally {
      setIsSubmitting(false);
    }
  };

  const errorMessage = localError || authError;

  return (
    <div className="mercury-login-wrapper relative flex min-h-screen w-full items-center justify-start overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)] transition-colors duration-200">
      {/* Theme Switcher Toggle */}
      <div className="absolute top-6 right-6 z-20">
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-9 items-center gap-1.5 rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] px-3 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--elevated-bg)] hover:text-[var(--text-primary)] transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-sage)] select-none shadow-sm"
          title={`Switch to ${isDark ? 'Light' : 'Dark'} mode`}
          aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
        >
          {isDark ? (
            <>
              <Sun className="h-4 w-4 text-[var(--accent-peach)]" />
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">Light</span>
            </>
          ) : (
            <>
              <Moon className="h-4 w-4 text-[var(--accent-lavender)]" />
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">Dark</span>
            </>
          )}
        </button>
      </div>

      <style>{`
        .mercury-login-wrapper {
          --filter-goo: url('#mercury-gooey');
        }

        /* SVG Stage Liquid Blobs Simulation */
        .mercury-stage {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          z-index: 1;
          filter: var(--filter-goo);
          opacity: 0.85;
          pointer-events: none;
        }

        .mercury-blob {
          position: absolute;
          background: radial-gradient(circle at 35% 35%, #FFFFFF 0%, #D8D8D8 25%, #8A8A8A 65%, #383838 100%);
          border-radius: 50%;
          filter: blur(28px);
          animation: mercuryFloat 24s infinite alternate ease-in-out;
          box-shadow: inset -12px -12px 24px rgba(0, 0, 0, 0.7),
                      12px 12px 32px rgba(255, 255, 255, 0.15);
          transition: margin 0.15s ease-out;
          will-change: transform, margin;
        }

        html.light .mercury-blob {
          background: radial-gradient(circle at 35% 35%, #A5B2A8 0%, #C2CBC4 35%, #D6DDD8 70%, #E8ECE9 100%);
          box-shadow: inset -12px -12px 24px rgba(80, 85, 80, 0.22),
                      12px 12px 32px rgba(0, 0, 0, 0.05);
        }

        @keyframes mercuryFloat {
          0% {
            transform: translate(0, 0) scale(1);
          }
          33% {
            transform: translate(4vw, 6vh) scale(1.08);
          }
          66% {
            transform: translate(-3vw, 3vh) scale(0.92);
          }
          100% {
            transform: translate(2vw, -4vh) scale(1.04);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .mercury-blob {
            animation: none !important;
            transition: none !important;
          }
        }

        /* Underline Input Glow Line */
        .mercury-input-group {
          position: relative;
          transition: transform 0.3s cubic-bezier(0.2, 1, 0.3, 1);
        }

        .mercury-input-group:focus-within {
          transform: translateX(4px);
        }

        .mercury-glow-line {
          position: absolute;
          bottom: 0;
          left: 0;
          width: 0%;
          height: 1px;
          background: #FFFFFF;
          transition: width 0.4s cubic-bezier(0.2, 1, 0.3, 1);
          box-shadow: 0 0 12px rgba(255, 255, 255, 0.8);
        }

        html.light .mercury-glow-line {
          background: #20231F;
          box-shadow: 0 0 12px rgba(32, 35, 31, 0.4);
        }

        .mercury-input:focus + .mercury-glow-line {
          width: 100%;
        }

        /* Mercury Submit Button */
        .mercury-submit-btn {
          position: relative;
          background: #FFFFFF;
          color: #000000;
          border: none;
          padding: 16px 36px;
          font-family: var(--font-sans);
          font-size: 13px;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: 2px;
          cursor: pointer;
          width: 100%;
          border-radius: 9999px;
          transition: letter-spacing 0.3s ease, background-color 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease;
          box-shadow: 0 4px 20px rgba(255, 255, 255, 0.12);
        }

        .mercury-submit-btn:hover:not(:disabled) {
          letter-spacing: 3px;
          background: #F0F0F0;
        }

        html.light .mercury-submit-btn {
          background: #20231F;
          color: #FAFAF8;
          box-shadow: 0 4px 20px rgba(32, 35, 31, 0.15);
        }

        html.light .mercury-submit-btn:hover:not(:disabled) {
          background: #111310;
        }

        .mercury-submit-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      `}</style>

      {/* Hidden SVG Filter Definition */}
      <svg className="absolute h-0 w-0 pointer-events-none" aria-hidden="true">
        <defs>
          <filter id="mercury-gooey">
            <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>

      {/* Background Liquid Physics Simulation */}
      <div className="mercury-stage" aria-hidden="true">
        {blobsData.map((data, index) => (
          <div
            key={index}
            ref={(el) => {
              blobRefs.current[index] = el;
            }}
            className="mercury-blob hidden md:block"
            style={{
              width: `${data.size}px`,
              height: `${data.size}px`,
              left: `${data.left}%`,
              top: `${data.top}%`,
              animationDelay: `${data.delay}s`,
              animationDuration: `${data.duration}s`,
            }}
          />
        ))}
      </div>

      {/* Main Authentication Container Positioned Left of Centre */}
      <main className="relative z-10 w-full max-w-[460px] px-6 py-12 sm:px-12 md:ml-12 lg:ml-28 xl:ml-36">
        {/* Brand System Identifier & Header */}
        <header className="mb-12 text-left">
          <div className="mb-3 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-[var(--text-secondary)]" />
            <span className="font-mono text-[10px] uppercase tracking-[4px] text-[var(--text-secondary)]">
              SYSTEM NODE: 0X992 · PAYPAL SANDBOX
            </span>
          </div>

          <h1 className="font-sans text-4xl font-extrabold uppercase leading-[0.95] tracking-[-1px] text-[var(--text-primary)] sm:text-5xl">
            PAYGUARD<br />
            <span>OWNER ACCESS</span>
          </h1>

          <p className="mt-4 text-xs font-normal text-[var(--text-secondary)]">
            Deterministic policy firewall & spend monitor for autonomous AI agents
          </p>
        </header>

        {/* Error Alert Banner */}
        {errorMessage && (
          <div
            role="alert"
            className="mb-8 flex items-center gap-3 rounded-xl border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-3.5 text-xs text-[var(--status-error)]"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span className="font-mono text-xs">{errorMessage}</span>
          </div>
        )}

        {/* Form Elements */}
        <form onSubmit={handleSubmit} autoComplete="off" className="space-y-8">
          <div className="mercury-input-group">
            <label
              htmlFor="owner-passphrase-input"
              className="block font-mono text-[11px] uppercase tracking-wider text-[var(--text-secondary)]"
            >
              Owner Passphrase
            </label>
            <input
              id="owner-passphrase-input"
              type="password"
              placeholder="••••••••••••"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              disabled={isSubmitting}
              autoFocus
              required
              className="mercury-input w-full border-0 border-b border-[var(--border-color)] bg-transparent py-3 font-mono text-base tracking-widest text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
            <div className="mercury-glow-line" />
          </div>

          {/* Submit Button */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="mercury-submit-btn flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className={`h-4 w-4 animate-spin ${isDark ? 'text-black' : 'text-white'}`} />
                  <span>Verifying Session...</span>
                </>
              ) : (
                <span>Authenticate Session</span>
              )}
            </button>
          </div>
        </form>

        {/* Minimal Footer Navigation */}
        <footer className="mt-14 flex items-center justify-between font-mono text-[10px] text-[var(--text-muted)]">
          <span className="tracking-widest uppercase">ENCRYPTED RECOVERY</span>
          <span className="tracking-widest uppercase">FAIL-CLOSED PROTOCOL</span>
        </footer>
      </main>
    </div>
  );
}
