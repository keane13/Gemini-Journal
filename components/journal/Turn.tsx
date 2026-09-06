'use client';

/**
 * @file components/journal/Turn.tsx
 * One block of the document, plus its marginalia.
 *
 * User text sits directly on the page: no bubble, no fill, no border, no avatar, no
 * inline timestamp. It looks now exactly as it will look when reread in a year.
 *
 * Model text is indented with a rule down its left edge, one step smaller and in the
 * secondary colour, so it reads as a margin note on your writing rather than a reply
 * from a person. There is no avatar and no "Gemini" label -- the indent and the rule
 * already say who is speaking, and naming it would reintroduce the chat frame.
 */

import React, { useState } from 'react';
import { MarkdownRenderer } from '@/components/MarkdownRenderer';
import {
  CommitmentMark,
  GutterDate,
  GutterTime,
  MoodArc,
  RedactionMark,
  RetentionMark,
} from './Marginalia';

export interface JournalTurn {
  id: string;
  role: 'user' | 'model';
  content: string;
  at: string;
  moodScore?: number | null;
  maskedCategories?: Record<string, number>;
  commitmentCount?: number;
  /** Feature 11: 0..1 of the rehydration window elapsed, when a window is in force. */
  retentionElapsed?: number | null;
  retentionLabel?: string | null;
}

interface TurnProps {
  turn: JournalTurn;
  /** True for the first turn of an entry; the dateline renders once per entry. */
  showDate?: boolean;
  entryDate?: string;
  /** Streaming reveal: line-by-line opacity ramp, the one orchestrated moment. */
  streaming?: boolean;
  onOpenLedger: (turnId: string) => void;
  onOpenCommitments: (turnId: string) => void;
}

/**
 * Splits model output into lines for the staggered reveal. Kept out of the render body
 * so a re-render mid-stream does not restart the animation for already-shown lines.
 */
function toLines(content: string): string[] {
  return content.split('\n');
}

export const Turn: React.FC<TurnProps> = ({
  turn,
  showDate,
  entryDate,
  streaming,
  onOpenLedger,
  onOpenCommitments,
}) => {
  const [hovered, setHovered] = useState(false);

  const masked = turn.maskedCategories ?? {};
  const hasMarks =
    typeof turn.moodScore === 'number' ||
    Object.keys(masked).length > 0 ||
    (turn.commitmentCount ?? 0) > 0 ||
    typeof turn.retentionElapsed === 'number';

  return (
    <article
      className="turn relative flex"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* ---- Marginalia gutter ------------------------------------------- */}
      <div
        className="journal-gutter shrink-0 flex flex-col items-center gap-1 pt-1"
        style={{ width: 'var(--gutter-w)' }}
      >
        {showDate && entryDate ? <GutterDate date={entryDate} /> : null}

        {hasMarks ? (
          <div className="mt-1 flex flex-col items-center">
            {typeof turn.moodScore === 'number' ? <MoodArc score={turn.moodScore} /> : null}

            <RedactionMark categories={masked} onOpen={() => onOpenLedger(turn.id)} />

            <CommitmentMark
              count={turn.commitmentCount ?? 0}
              onOpen={() => onOpenCommitments(turn.id)}
            />

            {typeof turn.retentionElapsed === 'number' && turn.retentionLabel ? (
              <RetentionMark
                elapsedFraction={turn.retentionElapsed}
                label={turn.retentionLabel}
              />
            ) : null}
          </div>
        ) : null}

        {/* Time lives in the gutter and only on hover. Never in the flow. */}
        <div className="mt-1">
          <GutterTime at={turn.at} visible={hovered} />
        </div>
      </div>

      {/* ---- Text column -------------------------------------------------- */}
      <div className="journal-column min-w-0 flex-1 px-8">
        {turn.role === 'user' ? (
          <div className="turn-user whitespace-pre-wrap break-words">{turn.content}</div>
        ) : streaming ? (
          <div className="turn-model">
            {toLines(turn.content).map((line, i) => (
              <div
                key={i}
                className="reveal-line"
                style={{ animationDelay: `${i * 40}ms` }}
              >
                {line === '' ? ' ' : line}
              </div>
            ))}
          </div>
        ) : (
          <div className="turn-model">
            <MarkdownRenderer content={turn.content} />
          </div>
        )}
      </div>
    </article>
  );
};
