'use client';

import React from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';

interface LandingPageProps {
  onSignIn: () => void;
  loading: boolean;
  error: string | null;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onSignIn, loading, error }) => {
  return (
    <div className="min-h-screen bg-[var(--color-base)] text-[var(--color-text-primary)] flex flex-col justify-between selection:bg-[var(--color-accent-dim)] selection:text-[var(--color-accent)]">
      {/* Top Borderline Chrome */}
      <header className="border-b border-[var(--color-divider)] bg-[var(--color-surface)]">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-serif text-lg tracking-tight font-medium text-[var(--color-text-primary)]">
              Personal Gemini Journal
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded bg-[var(--color-accent-dim)] text-[var(--color-accent)] font-mono">
              Nightstand v2.0
            </span>
          </div>

          <button
            id="nav-signin-btn"
            onClick={onSignIn}
            disabled={loading}
            className="px-4 py-1.5 text-xs font-mono text-white bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-500 hover:opacity-90 rounded-md transition-all disabled:opacity-50 cursor-pointer shadow-sm shadow-blue-500/20"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Sign In'}
          </button>
        </div>
      </header>

      {/* Main Reading & Call-to-Action Surface */}
      <main className="flex-1 max-w-3xl mx-auto px-6 py-20 flex flex-col items-center text-center justify-center space-y-8">
        {error && (
          <div
            id="auth-error-banner"
            className="w-full p-4 bg-[var(--color-alert-dim)] border border-[var(--color-alert)] rounded-md text-left text-xs font-mono text-[var(--color-alert)] space-y-1"
          >
            <p className="font-medium">Authentication Notice</p>
            <p>{error}</p>
            <p className="text-[11px] text-[var(--color-text-secondary)]">
              If popups are restricted in your iframe preview, allow popups or open in a new tab.
            </p>
          </div>
        )}

        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--color-surface)] text-[var(--color-accent)] text-xs font-mono border border-[var(--color-divider)]">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Privacy Shield &bull; Zero Browser Model Calls &bull; Firestore UID Isolated</span>
        </div>

        <h1 className="font-serif text-4xl sm:text-5xl font-normal tracking-tight text-[var(--color-text-primary)] leading-tight max-w-2xl">
          A quiet writing surface for honest introspection.
        </h1>

        <p className="text-base sm:text-lg text-[var(--color-text-secondary)] font-serif italic max-w-xl leading-relaxed">
          Write multi-turn reflections with Gemini 3.6 Flash. Sensitive data is deterministically redacted before leaving your device, and all memories are isolated strictly to your authentic identity.
        </p>

        {/* Primary CTA */}
        <div className="pt-2">
          <button
            id="hero-google-signin-btn"
            onClick={onSignIn}
            disabled={loading}
            className="inline-flex items-center justify-center gap-3 px-6 py-3 bg-[var(--color-surface)] hover:bg-[var(--color-surface-elevated)] border border-[var(--color-divider)] hover:border-[var(--color-accent)] text-[var(--color-text-primary)] font-mono text-xs rounded-md transition-all active:scale-[0.99] disabled:opacity-60 cursor-pointer"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin text-[var(--color-accent)]" />
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
            )}
            <span>Sign in with Google</span>
          </button>
        </div>

        {/* Minimal Architectural Axioms */}
        <div className="pt-12 grid grid-cols-1 sm:grid-cols-3 gap-4 text-left w-full">
          <div className="p-4 rounded-md bg-[var(--color-surface)] border border-[var(--color-divider)] space-y-2">
            <h3 className="font-mono text-xs font-medium text-[var(--color-accent)]">Egress Redaction</h3>
            <p className="text-xs text-[var(--color-text-secondary)] font-serif leading-relaxed">
              Phones, Luhn-verified cards, Indonesian NIK/NPWP, and emails are masked before upstream egress.
            </p>
          </div>

          <div className="p-4 rounded-md bg-[var(--color-surface)] border border-[var(--color-divider)] space-y-2">
            <h3 className="font-mono text-xs font-medium text-[var(--color-accent)]">Grounded Recall</h3>
            <p className="text-xs text-[var(--color-text-secondary)] font-serif leading-relaxed">
              &ldquo;Ask your past self&rdquo; searches embedded memory chunks with deep-link citations.
            </p>
          </div>

          <div className="p-4 rounded-md bg-[var(--color-surface)] border border-[var(--color-divider)] space-y-2">
            <h3 className="font-mono text-xs font-medium text-[var(--color-accent)]">Data Sovereignty</h3>
            <p className="text-xs text-[var(--color-text-secondary)] font-serif leading-relaxed">
              One-click full JSON and Markdown bundle export. Complete cascading hard deletion on command.
            </p>
          </div>
        </div>
      </main>

      {/* Subtle Footer */}
      <footer className="border-t border-[var(--color-divider)] py-4 text-center text-[11px] font-mono text-[var(--color-text-secondary)]">
        <span>Grounded Architecture &bull; Next.js 15 App Router &bull; Google Cloud Firestore &bull; Gemini Flash</span>
      </footer>
    </div>
  );
};
