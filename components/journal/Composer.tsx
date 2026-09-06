'use client';

/**
 * @file components/journal/Composer.tsx
 * Writing surface.
 *
 * No border, no background, no rounded box. The text you type is set in the same face and
 * size as everything you have already written, so composing and rereading look identical
 * -- which is the point: you are adding to a document, not filling in a prompt field.
 *
 * On focus a very low-contrast ruled baseline grid fades in behind the text at exactly the
 * line-height interval, like paper revealing its rules under a pen, and fades out on blur.
 * The interval is an integer (--leading-body: 33px) specifically so the rules tile without
 * drifting out of register with the text.
 */

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface ComposerMode {
  id: string;
  label: string;
  description: string;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  modes: ComposerMode[];
  activeMode: string;
  onModeChange: (id: string) => void;
  onReflect: () => void;
  onSaveWithoutReply: () => void;
  busy?: boolean;
  placeholder?: string;
}

export const Composer: React.FC<ComposerProps> = ({
  value,
  onChange,
  modes,
  activeMode,
  onModeChange,
  onReflect,
  onSaveWithoutReply,
  busy,
  placeholder = 'Write what is on your mind…',
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Grow with content rather than scrolling inside a fixed box: a document does not
  // have a scrollbar in the middle of it.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const current = modes.find((m) => m.id === activeMode) ?? modes[0];
  const canSubmit = value.trim().length > 0 && !busy;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) {
      e.preventDefault();
      onReflect();
    }
  };

  return (
    <div className="composer-shell flex">
      {/* Gutter column kept empty so the composer aligns to the text column above it. */}
      <div className="journal-gutter shrink-0" style={{ width: 'var(--gutter-w)' }} />

      <div className="min-w-0 flex-1 px-8">
        {/* The single hairline that separates writing from what is already written. */}
        <div className="h-px w-full bg-[var(--ink-rule)]" />

        <div className="journal-column relative pt-6">
          {/* Ruled grid, behind the text, revealed on focus. */}
          <div
            className="composer-ruled pointer-events-none absolute inset-0"
            aria-hidden="true"
          />

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
            aria-label="Journal entry"
            className="composer relative block min-h-[33px] w-full bg-transparent"
          />
        </div>

        {/* ---- Footer: reads as a dateline, not a toolbar ------------------ */}
        <div
          className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 pb-8"
          style={{ fontFamily: 'var(--face-ui)', fontSize: 'var(--size-ui)' }}
        >
          {/* Mode: text with a chevron. No select chrome, no boxed control. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-haspopup="listbox"
              className="inline-flex items-center gap-1 text-[var(--paper-muted)] transition-colors duration-[120ms] hover:text-[var(--paper)]"
            >
              {current?.label}
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </button>

            {menuOpen ? (
              <ul
                role="listbox"
                aria-label="Reflection mode"
                className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-[4px] border border-[var(--ink-rule)] bg-[var(--ink-raised)] py-1"
              >
                {modes.map((mode) => (
                  <li key={mode.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={mode.id === activeMode}
                      onClick={() => {
                        onModeChange(mode.id);
                        setMenuOpen(false);
                      }}
                      className="block w-full px-3 py-2 text-left transition-colors duration-[120ms] hover:bg-[var(--color-accent-dim)]"
                    >
                      <span
                        className={
                          mode.id === activeMode
                            ? 'text-[var(--paper)]'
                            : 'text-[var(--paper-muted)]'
                        }
                      >
                        {mode.label}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-[var(--paper-faint)]">
                        {mode.description}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-5">
            {/* The model is optional, not a toll gate. */}
            <button
              type="button"
              onClick={onSaveWithoutReply}
              disabled={!canSubmit}
              className="text-[var(--paper-muted)] transition-colors duration-[120ms] hover:text-[var(--paper)] disabled:opacity-40 disabled:hover:text-[var(--paper-muted)]"
            >
              Save without reply
            </button>

            <button
              type="button"
              onClick={onReflect}
              disabled={!canSubmit}
              className="rounded-[4px] bg-[var(--paper)] px-4 py-2 text-[var(--ink-base)] transition-opacity duration-[120ms] hover:opacity-90 disabled:opacity-30"
            >
              {busy ? 'Reflecting…' : 'Reflect on this'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
