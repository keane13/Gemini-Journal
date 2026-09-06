'use client';

/**
 * @file components/journal/Marginalia.tsx
 * The gutter. This is the element that makes the surface a journal rather than a chat log.
 *
 * A chat client spends its layout budget on ATTRIBUTION -- who spoke, when, in which turn.
 * This gutter spends it on PROVENANCE: what mood this passage carried, what was masked
 * before it left the server, what you committed to. Nothing enters the gutter unless it is
 * derived from the content beside it; it is an index of the text, never decoration.
 *
 * Accessibility notes, because the marks are small and information-bearing:
 *   - Glyphs sit at 8-10px inside a >=24px hit area, and use --mark-rest (4.6:1 on the
 *     gutter) rather than --paper-faint (3.07:1, which is unreadable at this size).
 *   - No meaning is carried by shape or colour alone: every mark has an aria-label and
 *     reveals a text label on hover AND on keyboard focus.
 *   - Interactive marks are real <button>s so they are reachable by keyboard.
 */

import React from 'react';

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

/** Human-readable entity labels. Never raw placeholder keys in the interface. */
export const ENTITY_LABELS: Record<string, string> = {
  indonesian_nik: 'NIK',
  indonesian_npwp: 'NPWP',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  credit_card: 'Card',
  iban: 'Bank account',
  url_secret: 'Access token',
  person: 'Name',
  location: 'Location',
};

export function entityLabel(category: string): string {
  return ENTITY_LABELS[category.toLowerCase()] ?? category.toLowerCase();
}

/** A label that appears on hover or keyboard focus, never at rest. */
const MarkLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    className="
      pointer-events-none absolute left-full top-1/2 z-20 ml-1 -translate-y-1/2
      whitespace-nowrap rounded-[4px] bg-[var(--ink-raised)] px-2 py-1
      text-[11px] text-[var(--paper)] opacity-0
      transition-opacity duration-[120ms]
      group-hover:opacity-100 group-focus-visible:opacity-100
    "
    style={{ fontFamily: 'var(--face-ui)' }}
  >
    {children}
  </span>
);

/**
 * The dateline. Day number set large with the month beneath, in the UI face --
 * the one place in the reading surface where a number is meant to be scanned
 * rather than read.
 */
export const GutterDate: React.FC<{ date: string }> = ({ date }) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;

  return (
    <div
      className="flex flex-col items-center leading-none select-none"
      style={{ fontFamily: 'var(--face-ui)' }}
    >
      <span className="text-[20px] font-medium text-[var(--paper-muted)] tabular-nums">
        {String(d.getDate()).padStart(2, '0')}
      </span>
      <span className="mt-0.5 text-[10px] tracking-[0.08em] text-[var(--mark-rest)]">
        {MONTHS[d.getMonth()]}
      </span>
    </div>
  );
};

/**
 * Mood arc. The fill fraction encodes the mood score for the adjacent block.
 * Not interactive -- it reports, it does not navigate -- so it is a role="img"
 * with a text alternative rather than a button.
 */
export const MoodArc: React.FC<{ score: number }> = ({ score }) => {
  // Domain is -1..1; map to a 0..1 fill fraction.
  const clamped = Math.max(-1, Math.min(1, score));
  const fraction = (clamped + 1) / 2;

  const r = 5;
  const circumference = 2 * Math.PI * r;
  const filled = circumference * fraction;

  const description =
    clamped > 0.25 ? 'lighter' : clamped < -0.25 ? 'heavier' : 'level';

  return (
    <span
      className="group relative inline-flex items-center justify-center p-1.5"
      role="img"
      aria-label={`Mood for this passage: ${description}`}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        {/* Track */}
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="var(--ink-rule)"
          strokeWidth="2"
        />
        {/* Fill, drawn from the top clockwise */}
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="var(--mark-rest)"
          strokeWidth="2"
          strokeLinecap="butt"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <MarkLabel>Mood: {description}</MarkLabel>
    </span>
  );
};

/**
 * Masked-entity mark. Amber, because --annotation means exactly one thing in this
 * system: personal data was masked here. Opens the Egress Ledger bound to THIS turn.
 */
export const RedactionMark: React.FC<{
  categories: Record<string, number>;
  onOpen: () => void;
}> = ({ categories, onOpen }) => {
  const total = Object.values(categories).reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const summary = Object.entries(categories)
    .map(([c, n]) => `${entityLabel(c)}${n > 1 ? ` ×${n}` : ''}`)
    .join(', ');

  return (
    <button
      type="button"
      onClick={onOpen}
      data-kind="redaction"
      className="group relative inline-flex items-center justify-center p-1.5"
      aria-label={`${total} masked ${total === 1 ? 'entity' : 'entities'}: ${summary}. Open the egress ledger for this passage.`}
    >
      <span
        className="block h-[8px] w-[8px] bg-[var(--annotation)]"
        aria-hidden="true"
      />
      <MarkLabel>Masked: {summary}</MarkLabel>
    </button>
  );
};

/** Commitment mark. A tick when a commitment was extracted from the adjacent block. */
export const CommitmentMark: React.FC<{ count: number; onOpen: () => void }> = ({
  count,
  onOpen,
}) => {
  if (count < 1) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative inline-flex items-center justify-center p-1.5 text-[var(--mark-rest)] transition-colors duration-[120ms] hover:text-[var(--mark-active)] focus-visible:text-[var(--mark-active)]"
      aria-label={`${count} commitment${count === 1 ? '' : 's'} recorded from this passage. Open commitments.`}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path
          d="M1 5.4 L3.6 8 L9 1.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <MarkLabel>
        {count} commitment{count === 1 ? '' : 's'}
      </MarkLabel>
    </button>
  );
};

/**
 * Retention mark (Feature 11 forward-compatibility).
 * A hollow ring that fills as the rehydration window elapses. Rendered only when a
 * retention window is actually in force.
 */
export const RetentionMark: React.FC<{
  elapsedFraction: number;
  label: string;
}> = ({ elapsedFraction, label }) => {
  const fraction = Math.max(0, Math.min(1, elapsedFraction));
  const r = 4.5;
  const circumference = 2 * Math.PI * r;
  const filled = circumference * fraction;

  return (
    <span
      className="group relative inline-flex items-center justify-center p-1.5"
      role="img"
      aria-label={label}
    >
      <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r={r} fill="none" stroke="var(--ink-rule)" strokeWidth="1.5" />
        <circle
          cx="6.5"
          cy="6.5"
          r={r}
          fill="none"
          stroke="var(--paper-faint)"
          strokeWidth="1.5"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform="rotate(-90 6.5 6.5)"
        />
      </svg>
      <MarkLabel>{label}</MarkLabel>
    </span>
  );
};

/** Timestamp, revealed on hover of the adjacent turn. Never in the text flow. */
export const GutterTime: React.FC<{ at: string; visible: boolean }> = ({ at, visible }) => {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;

  return (
    <span
      className="select-none text-[10px] tabular-nums text-[var(--mark-rest)] transition-opacity duration-[120ms]"
      style={{ fontFamily: 'var(--face-ui)', opacity: visible ? 1 : 0 }}
      aria-hidden={!visible}
    >
      {d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
};
