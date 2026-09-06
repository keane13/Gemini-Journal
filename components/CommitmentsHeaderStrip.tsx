/**
 * @file components/CommitmentsHeaderStrip.tsx
 * Feature 5: Quiet Header Strip for Resurfacing Self-Stated Commitments.
 *
 * Requirements:
 * - Surfaces at most 3 open commitments past dueHint or older than 14 days.
 * - Deep-links to the entry where it was stated.
 * - Never a notification badge, never guilt language. Factual, quiet, neutral copy.
 * - One-click to mark "done" or "release" (explicitly letting it go as a valid journal outcome).
 * - Dismissing offers one-click to start a new entry pre-seeded with a reference to it.
 */

'use client';

import React, { useState } from 'react';
import { Commitment } from '@/types/journal';
import { Check, Feather, ArrowUpRight, X, Sparkles } from 'lucide-react';

interface CommitmentsHeaderStripProps {
  commitments: Commitment[];
  onSelectEntry: (entryId: string) => void;
  onUpdateStatus: (commitmentId: string, status: 'done' | 'released') => Promise<void>;
  onSeedComposer: (commitmentText: string, entryId: string) => void;
  onDismissStripItem?: (commitmentId: string) => void;
}

export const CommitmentsHeaderStrip: React.FC<CommitmentsHeaderStripProps> = ({
  commitments,
  onSelectEntry,
  onUpdateStatus,
  onSeedComposer,
  onDismissStripItem,
}) => {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [justDismissedItem, setJustDismissedItem] = useState<Commitment | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const visibleCommitments = commitments
    .filter((c) => !dismissedIds.has(c.id))
    .slice(0, 3);

  if (visibleCommitments.length === 0 && !justDismissedItem) {
    return null;
  }

  const handleDismiss = (commitment: Commitment) => {
    setDismissedIds((prev) => new Set(prev).add(commitment.id));
    setJustDismissedItem(commitment);
    if (onDismissStripItem) {
      onDismissStripItem(commitment.id);
    }
  };

  const handleStatusClick = async (commitmentId: string, status: 'done' | 'released') => {
    setUpdatingId(commitmentId);
    try {
      await onUpdateStatus(commitmentId, status);
      setDismissedIds((prev) => new Set(prev).add(commitmentId));
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div
      id="commitments-header-strip"
      className="w-full border-b border-[var(--color-divider)] bg-[var(--color-surface)]/70 px-4 py-3 text-xs backdrop-blur-sm transition-all"
    >
      <div className="mx-auto max-w-5xl space-y-2">
        {justDismissedItem && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--color-surface-hover)] px-3 py-2 text-[var(--color-text-secondary)]">
            <span>
              Dismissed reminder for:{' '}
              <strong className="text-[var(--color-text-primary)] font-normal italic">
                &ldquo;{justDismissedItem.text}&rdquo;
              </strong>
            </span>
            <div className="flex items-center gap-3">
              <button
                id="btn-seed-commitment-composer"
                onClick={() => {
                  onSeedComposer(justDismissedItem.text, justDismissedItem.sourceEntryId);
                  setJustDismissedItem(null);
                }}
                className="inline-flex items-center gap-1.5 font-medium text-cyan-400 hover:underline"
              >
                <Feather className="h-3.5 w-3.5" />
                Reflect on this in new entry
              </button>
              <button
                onClick={() => setJustDismissedItem(null)}
                className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                aria-label="Close prompt"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {visibleCommitments.map((item) => {
          const statedDate = new Date(item.statedAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          });

          return (
            <div
              key={item.id}
              id={`commitment-item-${item.id}`}
              className="flex flex-col gap-2 rounded-md border-0 bg-[var(--color-surface)] px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-2.5 min-w-0 flex-1">
                <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-cyan-400 mt-0.5 opacity-80" />
                <div className="min-w-0 flex-1">
                  <p className="text-[var(--color-text-primary)] leading-relaxed truncate">
                    &ldquo;{item.text}&rdquo;
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
                    <span>Stated on {statedDate}</span>
                    {item.dueHint && (
                      <>
                        <span>•</span>
                        <span>Timeframe: {item.dueHint}</span>
                      </>
                    )}
                    {item.sourceEntryId && (
                      <>
                        <span>•</span>
                        <button
                          onClick={() => onSelectEntry(item.sourceEntryId)}
                          className="inline-flex items-center gap-0.5 text-cyan-400 hover:underline"
                        >
                          View source entry
                          <ArrowUpRight className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 self-end sm:self-auto flex-shrink-0">
                <button
                  id={`btn-done-${item.id}`}
                  disabled={updatingId === item.id}
                  onClick={() => handleStatusClick(item.id, 'done')}
                  className="inline-flex items-center gap-1 rounded bg-[var(--paper)] px-2 py-1 text-[11px] text-[var(--ink-base)] hover:opacity-90 transition-opacity disabled:opacity-50 font-medium"
                  title="Mark this commitment completed"
                >
                  <Check className="h-3 w-3 text-white" />
                  Done
                </button>
                <button
                  id={`btn-release-${item.id}`}
                  disabled={updatingId === item.id}
                  onClick={() => handleStatusClick(item.id, 'released')}
                  className="inline-flex items-center gap-1 rounded border border-[var(--color-divider)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-secondary)] transition-colors disabled:opacity-50"
                  title="Release this commitment (let it go intentionally)"
                >
                  Release
                </button>
                <button
                  id={`btn-dismiss-${item.id}`}
                  onClick={() => handleDismiss(item)}
                  className="p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] rounded hover:bg-[var(--color-surface-hover)] transition-colors"
                  title="Dismiss from strip"
                  aria-label="Dismiss commitment"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
