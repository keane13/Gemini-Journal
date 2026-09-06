'use client';

/**
 * @file components/journal/EntryView.tsx
 * The reading and writing surface: gutter, text column, conditional rail.
 *
 * This replaces the chat client. There is no message list, no bubble, no avatar, no
 * inline timestamp and no divider between turns -- one continuous document, annotated in
 * the margin.
 *
 * The empty state is worth noting for what it does NOT contain: no centred icon, no
 * heading, no subtitle, no suggestion chips. Just today's date in the gutter and an
 * invitation in the composer. An empty notebook does not explain itself, and the
 * icon-heading-subtitle-chips arrangement is the most reliable tell of a generated
 * interface.
 */

import React, { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { Composer, ComposerMode } from './Composer';
import { ContextRail, EgressSummary, RailCommitment } from './ContextRail';
import { JournalTurn, Turn } from './Turn';

export const JOURNAL_MODES: ComposerMode[] = [
  { id: 'reflection', label: 'Reflection', description: 'Gentle inquiry, reframing' },
  { id: 'brainstorming', label: 'Brainstorming', description: 'Divergent angles' },
  { id: 'summary', label: 'Synthesis', description: 'Themes and next steps' },
  { id: 'deep_dive', label: 'Analysis', description: 'Root causes, tradeoffs' },
  { id: 'recall', label: 'Recall', description: 'Grounded retrieval over past entries' },
];

interface EntryViewProps {
  title?: string;
  entryDate?: string;
  turns: JournalTurn[];
  streamingTurnId?: string | null;

  draft: string;
  onDraftChange: (v: string) => void;
  activeMode: string;
  onModeChange: (id: string) => void;
  onReflect: () => void;
  onSaveWithoutReply: () => void;
  busy?: boolean;

  egress: EgressSummary | null;
  commitments: RailCommitment[];
  retentionNote?: string | null;
  /** FEATURE 11: plain-language retention state for this entry, shown under the title. */
  retentionLabel?: string | null;
  retentionForgotten?: boolean;

  onOpenLedger: (turnId: string) => void;
  onOpenCommitments: (turnId: string) => void;
  onOpenCommitment: (id: string) => void;
  onDismissEgress: () => void;
}

export const EntryView: React.FC<EntryViewProps> = ({
  title,
  entryDate,
  turns,
  streamingTurnId,
  draft,
  onDraftChange,
  activeMode,
  onModeChange,
  onReflect,
  onSaveWithoutReply,
  busy,
  egress,
  commitments,
  retentionNote,
  retentionLabel,
  retentionForgotten,
  onOpenLedger,
  onOpenCommitments,
  onOpenCommitment,
  onDismissEgress,
}) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, streamingTurnId]);

  const today = entryDate ?? new Date().toISOString();

  return (
    <div className="journal-page flex h-full min-h-0 flex-1 bg-transparent">
      {/* ---- Document ---------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[calc(var(--gutter-w)+var(--measure)+8rem)] flex-1 flex-col">
          {/* Title sits in the text column as a heading of the document, not a page header. */}
          {title ? (
            <div className="flex pt-10">
              <div className="shrink-0" style={{ width: 'var(--gutter-w)' }} />
              <div className="journal-column min-w-0 flex-1 px-8">
                <h1
                  className="text-[26px] leading-tight text-[var(--paper)]"
                  style={{ fontFamily: 'var(--face-body)' }}
                >
                  {title}
                </h1>

                {/* FEATURE 11: retention state, stated plainly rather than hidden in a
                    settings screen. Forgotten entries say so in past tense. */}
                {retentionLabel ? (
                  <p
                    className="mt-2 text-[12px]"
                    style={{
                      fontFamily: 'var(--face-ui)',
                      color: retentionForgotten
                        ? 'var(--paper-faint)'
                        : 'var(--paper-muted)',
                    }}
                  >
                    {retentionLabel}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="flex flex-1 flex-col gap-10 py-10">
            {turns.map((turn, i) => (
              <Turn
                key={turn.id}
                turn={turn}
                showDate={i === 0}
                entryDate={today}
                streaming={streamingTurnId === turn.id}
                onOpenLedger={onOpenLedger}
                onOpenCommitments={onOpenCommitments}
              />
            ))}

            {/* Empty state: the dateline and the invitation. Nothing else. */}
            {turns.length === 0 ? (
              <div className="flex">
                <div
                  className="journal-gutter shrink-0 pt-1"
                  style={{ width: 'var(--gutter-w)' }}
                >
                  <div className="flex justify-center">
                    <GutterDateInline date={today} />
                  </div>
                </div>
                <div className="min-w-0 flex-1" />
              </div>
            ) : null}

            {busy && (
              <div className="flex pt-4 pb-2">
                <div className="shrink-0" style={{ width: 'var(--gutter-w)' }} />
                <div className="journal-column min-w-0 flex-1 px-8">
                  <div className="flex items-center gap-2 text-[var(--color-text-secondary)] font-mono text-xs">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--color-accent)]" />
                    <span className="italic">AI is reflecting...</span>
                  </div>
                </div>
              </div>
            )}

            <div ref={endRef} />
          </div>

          <div className="mt-auto">
            <Composer
              value={draft}
              onChange={onDraftChange}
              modes={JOURNAL_MODES}
              activeMode={activeMode}
              onModeChange={onModeChange}
              onReflect={onReflect}
              onSaveWithoutReply={onSaveWithoutReply}
              busy={busy}
            />
          </div>
        </div>
      </div>

      {/* ---- Rail (absent unless it has something to say) ------------------ */}
      <ContextRail
        egress={egress}
        commitments={commitments}
        retentionNote={retentionNote}
        onOpenCommitment={onOpenCommitment}
        onDismissEgress={onDismissEgress}
      />
    </div>
  );
};

/** Local re-use of the dateline for the empty state. */
const GutterDateInline: React.FC<{ date: string }> = ({ date }) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const months = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  ];
  return (
    <div
      className="flex flex-col items-center leading-none select-none"
      style={{ fontFamily: 'var(--face-ui)' }}
    >
      <span className="text-[20px] font-medium text-[var(--paper-muted)] tabular-nums">
        {String(d.getDate()).padStart(2, '0')}
      </span>
      <span className="mt-0.5 text-[10px] tracking-[0.08em] text-[var(--mark-rest)]">
        {months[d.getMonth()]}
      </span>
    </div>
  );
};
