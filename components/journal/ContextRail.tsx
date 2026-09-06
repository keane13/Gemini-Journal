'use client';

/**
 * @file components/journal/ContextRail.tsx
 * The right rail. Hidden entirely until there is something to show.
 *
 * Deliberately NOT a stack of cards. Sections are separated by hairline rules and sit on
 * the same ground as the page; only the modal-like egress detail gets a raised surface.
 * A rail of bordered, rounded, slightly-lighter panels is the most recognisable shape in
 * generated interfaces, and it would undo the page-with-margins reading the rest of the
 * layout works to establish.
 */

import React from 'react';
import { entityLabel } from './Marginalia';

export interface EgressSummary {
  turnId: string;
  bytesUpstream: number;
  categories: Record<string, number>;
  redactedPayload?: string;
}

export interface RailCommitment {
  id: string;
  text: string;
  dueHint: string | null;
}

interface ContextRailProps {
  egress: EgressSummary | null;
  commitments: RailCommitment[];
  retentionNote?: string | null;
  onOpenCommitment: (id: string) => void;
  onDismissEgress: () => void;
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <section className="border-b border-[var(--ink-rule)] px-5 py-5 last:border-b-0">
    {/* Sentence case, never all caps. */}
    <h2 className="mb-3 text-[12px] text-[var(--paper-faint)]">{title}</h2>
    {children}
  </section>
);

export const ContextRail: React.FC<ContextRailProps> = ({
  egress,
  commitments,
  retentionNote,
  onOpenCommitment,
  onDismissEgress,
}) => {
  const hasEgress = egress && Object.keys(egress.categories).length > 0;
  const hasCommitments = commitments.length > 0;

  // The rail does not exist when it has nothing to say.
  if (!hasEgress && !hasCommitments && !retentionNote) return null;

  return (
    <aside
      className="journal-rail hidden shrink-0 overflow-y-auto lg:block"
      style={{ width: 'var(--rail-w)' }}
      aria-label="Entry context"
    >
      {hasEgress ? (
        <Section title="Sent upstream">
          <p className="mb-3 text-[var(--paper-muted)]">
            {egress!.bytesUpstream.toLocaleString()} bytes left this server for the model.
          </p>

          <ul className="flex flex-col gap-1.5">
            {Object.entries(egress!.categories).map(([category, count]) => (
              <li key={category} className="flex items-baseline justify-between gap-3">
                <span className="text-[var(--annotation)]">{entityLabel(category)}</span>
                <span className="tabular-nums text-[var(--paper-faint)]">×{count}</span>
              </li>
            ))}
          </ul>

          {egress!.redactedPayload ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-[var(--paper-muted)] transition-colors duration-[120ms] hover:text-[var(--paper)]">
                Exact payload that departed
              </summary>
              {/* The one raised surface in the rail: a transient detail, not a section. */}
              <pre className="payload-dump mt-2 max-h-56 overflow-auto rounded-[4px] bg-[var(--ink-raised)] p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-[var(--paper-muted)]">
                {egress!.redactedPayload}
              </pre>
            </details>
          ) : null}

          <button
            type="button"
            onClick={onDismissEgress}
            className="mt-4 text-[var(--paper-faint)] transition-colors duration-[120ms] hover:text-[var(--paper)]"
          >
            Dismiss
          </button>
        </Section>
      ) : null}

      {hasCommitments ? (
        <Section title="Commitments from this entry">
          <ul className="flex flex-col gap-3">
            {commitments.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onOpenCommitment(c.id)}
                  className="block w-full text-left text-[var(--paper-muted)] transition-colors duration-[120ms] hover:text-[var(--paper)]"
                >
                  {c.text}
                  {c.dueHint ? (
                    <span className="mt-1 block text-[11px] text-[var(--paper-faint)]">
                      {new Date(c.dueHint).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {retentionNote ? (
        <Section title="Retention">
          <p className="text-[var(--paper-muted)]">{retentionNote}</p>
        </Section>
      ) : null}
    </aside>
  );
};
