/**
 * @file components/CommitmentsModal.tsx
 * Feature 5: Self-Stated Commitments Ledger.
 *
 * Dedicated view for user's past journal commitments:
 * - Factual, neutral, zero guilt language.
 * - Allows marking done or releasing (intentional letting go).
 * - Deep-links to the original journal reflection where it was stated.
 */

'use client';

import React, { useState } from 'react';
import { Commitment, CommitmentStatus } from '@/types/journal';
import { X, Check, ArrowUpRight, CheckCircle2, Archive, Clock } from 'lucide-react';

interface CommitmentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  commitments: Commitment[];
  onSelectEntry: (entryId: string) => void;
  onUpdateStatus: (commitmentId: string, status: 'done' | 'released') => Promise<void>;
  onSeedComposer: (commitmentText: string, entryId: string) => void;
}

export const CommitmentsModal: React.FC<CommitmentsModalProps> = ({
  isOpen,
  onClose,
  commitments,
  onSelectEntry,
  onUpdateStatus,
  onSeedComposer,
}) => {
  const [filter, setFilter] = useState<CommitmentStatus>('open');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  if (!isOpen) return null;

  const filtered = commitments.filter((c) => c.status === filter);

  const handleStatusChange = async (id: string, newStatus: 'done' | 'released') => {
    setUpdatingId(id);
    try {
      await onUpdateStatus(id, newStatus);
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <div
      id="commitments-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      onClick={onClose}
    >
      <div
        id="commitments-modal-container"
        className="w-full max-w-2xl rounded-xl border border-[var(--color-divider)] bg-[var(--color-surface)] shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-divider)] px-6 py-4">
          <div>
            <h2 className="text-base font-serif font-medium text-[var(--color-text-primary)]">
              Self-Stated Commitments
            </h2>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              Intentions and promises extracted directly from your journal reflections.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-1 border-b border-[var(--color-divider)] bg-[var(--color-surface-subtle)]/40 px-6 py-2 text-xs">
          <button
            onClick={() => setFilter('open')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 transition-colors ${
              filter === 'open'
                ? 'bg-[var(--color-surface)] font-medium text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <Clock className="h-3.5 w-3.5" />
            Open ({commitments.filter((c) => c.status === 'open').length})
          </button>
          <button
            onClick={() => setFilter('done')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 transition-colors ${
              filter === 'done'
                ? 'bg-[var(--color-surface)] font-medium text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5 text-[var(--system)]" />
            Done ({commitments.filter((c) => c.status === 'done').length})
          </button>
          <button
            onClick={() => setFilter('released')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 transition-colors ${
              filter === 'released'
                ? 'bg-[var(--color-surface)] font-medium text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <Archive className="h-3.5 w-3.5" />
            Released ({commitments.filter((c) => c.status === 'released').length})
          </button>
        </div>

        {/* Content list */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-xs text-[var(--color-text-secondary)]">
              {filter === 'open' && 'No open commitments currently active.'}
              {filter === 'done' && 'No completed commitments yet.'}
              {filter === 'released' && 'No commitments have been released.'}
            </div>
          ) : (
            filtered.map((item) => {
              const statedDate = new Date(item.statedAt).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              });

              return (
                <div
                  key={item.id}
                  className="rounded-lg border-0 bg-[var(--color-surface)] p-4 transition-all hover:bg-[var(--color-surface-elevated)]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <p className="text-sm text-[var(--color-text-primary)] leading-relaxed flex-1">
                      &ldquo;{item.text}&rdquo;
                    </p>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {filter === 'open' && (
                        <>
                          <button
                            disabled={updatingId === item.id}
                            onClick={() => handleStatusChange(item.id, 'done')}
                            className="inline-flex items-center gap-1 rounded bg-[var(--paper)] px-2.5 py-1 text-xs text-[var(--ink-base)] hover:opacity-90 transition-opacity disabled:opacity-50 font-medium"
                          >
                            <Check className="h-3.5 w-3.5 text-white" />
                            Done
                          </button>
                          <button
                            disabled={updatingId === item.id}
                            onClick={() => handleStatusChange(item.id, 'released')}
                            className="inline-flex items-center gap-1 rounded border border-[var(--color-divider)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors disabled:opacity-50"
                            title="Acknowledge and deliberately release this commitment"
                          >
                            Release
                          </button>
                        </>
                      )}
                      {filter !== 'open' && (
                        <span className="text-[11px] uppercase tracking-wider text-[var(--color-text-secondary)]">
                          {item.status}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-secondary)]">
                    <span>Stated on {statedDate}</span>
                    {item.dueHint && <span>• Timeframe: {item.dueHint}</span>}
                    {item.resurfacedCount > 0 && (
                      <span>• Resurfaced {item.resurfacedCount} time{item.resurfacedCount > 1 ? 's' : ''}</span>
                    )}
                    {item.sourceEntryId && (
                      <button
                        onClick={() => {
                          onSelectEntry(item.sourceEntryId);
                          onClose();
                        }}
                        className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline ml-auto"
                      >
                        View entry
                        <ArrowUpRight className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      onClick={() => {
                        onSeedComposer(item.text, item.sourceEntryId);
                        onClose();
                      }}
                      className="inline-flex items-center gap-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                    >
                      Reflect on this
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
