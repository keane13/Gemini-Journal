/**
 * @file components/YearView.tsx
 * Feature 6: Year View (a rendering, not a module).
 *
 * Requirements:
 * - 12-month grid where each day is a cell tinted by that day's mood score and entry density.
 * - Hover / focus shows date, entry count, and dominant themes.
 * - Click opens that day's entry.
 * - Reads ONLY from existing entry fields. No new collections, no new routes, no calendar OAuth.
 * - Renders legibly at 360px width.
 * - Keyboard navigable with arrow keys (ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Enter).
 */

'use client';

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { JournalInteraction } from '@/types/journal';
import { ChevronLeft, ChevronRight, X, Calendar, BookOpen } from 'lucide-react';

interface YearViewProps {
  interactions: JournalInteraction[];
  onSelectEntry: (entryId: string) => void;
  onClose?: () => void;
  initialYear?: number;
}

interface DayData {
  dateStr: string; // YYYY-MM-DD
  dateObj: Date;
  entries: JournalInteraction[];
  count: number;
  avgMood: number | null;
  dominantThemes: string[];
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const WEEKDAY_HEADERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function formatIsoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const YearView: React.FC<YearViewProps> = ({
  interactions,
  onSelectEntry,
  onClose,
  initialYear = new Date().getFullYear(),
}) => {
  const [currentYear, setCurrentYear] = useState<number>(initialYear);
  const [focusedDateStr, setFocusedDateStr] = useState<string>(() => formatIsoDate(new Date()));
  const [hoveredDay, setHoveredDay] = useState<DayData | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Group existing entries by YYYY-MM-DD
  const dayDataMap = useMemo(() => {
    const map = new Map<string, DayData>();

    for (const item of interactions) {
      if (!item.createdAt) continue;
      const d = new Date(item.createdAt);
      if (isNaN(d.getTime())) continue;

      const key = formatIsoDate(d);
      let existing = map.get(key);
      if (!existing) {
        existing = {
          dateStr: key,
          dateObj: d,
          entries: [],
          count: 0,
          avgMood: null,
          dominantThemes: [],
        };
        map.set(key, existing);
      }

      existing.entries.push(item);
      existing.count += 1;

      // Extract themes from tags or dominantEmotion
      if (item.tags && Array.isArray(item.tags)) {
        for (const t of item.tags) {
          if (t && !existing.dominantThemes.includes(t)) {
            existing.dominantThemes.push(t);
          }
        }
      }
      if (item.dominantEmotion && !existing.dominantThemes.includes(item.dominantEmotion)) {
        existing.dominantThemes.push(item.dominantEmotion);
      }
    }

    // Compute average mood score per day
    for (const data of map.values()) {
      let sum = 0;
      let scoredCount = 0;
      for (const e of data.entries) {
        if (typeof e.moodScore === 'number' && !isNaN(e.moodScore)) {
          sum += e.moodScore;
          scoredCount += 1;
        }
      }
      data.avgMood = scoredCount > 0 ? sum / scoredCount : null;
      data.dominantThemes = data.dominantThemes.slice(0, 3);
    }

    return map;
  }, [interactions]);

  // Compute color & opacity styling for a day cell
  const getCellVisuals = useCallback((count: number, avgMood: number | null) => {
    if (count === 0) {
      return {
        bg: 'bg-[var(--color-surface)]/30 border border-[var(--color-divider)]/40',
        titleSuffix: 'No entries',
      };
    }

    // Determine hue based on mood:
    // avgMood in [-1.0, 1.0]
    let colorClass = 'bg-amber-500/60 border-amber-400/50 text-white';
    let titleSuffix = `${count} reflection${count > 1 ? 's' : ''}`;

    if (avgMood !== null) {
      if (avgMood >= 0.25) {
        // Optimistic / warm
        colorClass = count > 1
          ? 'bg-amber-500 text-black font-bold shadow-sm'
          : 'bg-amber-500/75 text-black font-semibold';
        titleSuffix += ` (Mood: +${avgMood.toFixed(2)})`;
      } else if (avgMood <= -0.25) {
        // Deep reflective / contemplative
        colorClass = count > 1
          ? 'bg-indigo-500 text-white font-bold shadow-sm'
          : 'bg-indigo-500/75 text-white font-semibold';
        titleSuffix += ` (Mood: ${avgMood.toFixed(2)})`;
      } else {
        // Balanced
        colorClass = count > 1
          ? 'bg-gradient-to-br from-blue-500 to-emerald-400 text-white font-bold shadow-sm'
          : 'bg-gradient-to-br from-blue-500/85 to-emerald-400/85 text-white font-semibold';
        titleSuffix += ` (Mood: balanced)`;
      }
    } else {
      colorClass = count > 1
        ? 'bg-gradient-to-br from-blue-500 to-emerald-400 text-white font-bold shadow-sm'
        : 'bg-gradient-to-br from-blue-500/85 to-emerald-400/85 text-white font-medium';
    }

    return { bg: colorClass, titleSuffix };
  }, []);

  // Keyboard navigation handler (ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Enter)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const current = new Date(`${focusedDateStr}T12:00:00`);
      if (isNaN(current.getTime())) return;

      let nextDate: Date | null = null;
      const dayMs = 24 * 60 * 60 * 1000;

      switch (e.key) {
        case 'ArrowLeft':
          nextDate = new Date(current.getTime() - dayMs);
          break;
        case 'ArrowRight':
          nextDate = new Date(current.getTime() + dayMs);
          break;
        case 'ArrowUp':
          nextDate = new Date(current.getTime() - 7 * dayMs);
          break;
        case 'ArrowDown':
          nextDate = new Date(current.getTime() + 7 * dayMs);
          break;
        case 'Enter':
        case ' ': {
          e.preventDefault();
          const day = dayDataMap.get(focusedDateStr);
          if (day && day.entries.length > 0) {
            onSelectEntry(day.entries[0].id);
          }
          return;
        }
        default:
          return;
      }

      if (nextDate) {
        e.preventDefault();
        const nextKey = formatIsoDate(nextDate);
        setFocusedDateStr(nextKey);
        if (nextDate.getFullYear() !== currentYear) {
          setCurrentYear(nextDate.getFullYear());
        }

        // Set hovered info for keyboard user
        const dayInfo = dayDataMap.get(nextKey) || {
          dateStr: nextKey,
          dateObj: nextDate,
          entries: [],
          count: 0,
          avgMood: null,
          dominantThemes: [],
        };
        setHoveredDay(dayInfo);

        // Focus element in DOM
        const el = document.getElementById(`year-cell-${nextKey}`);
        if (el) el.focus();
      }
    },
    [focusedDateStr, currentYear, dayDataMap, onSelectEntry]
  );

  // Active day details for the preview card (hovered or focused)
  const activeDayData: DayData = useMemo(() => {
    if (hoveredDay) return hoveredDay;
    const existing = dayDataMap.get(focusedDateStr);
    if (existing) return existing;
    return {
      dateStr: focusedDateStr,
      dateObj: new Date(`${focusedDateStr}T12:00:00`),
      entries: [],
      count: 0,
      avgMood: null,
      dominantThemes: [],
    };
  }, [hoveredDay, focusedDateStr, dayDataMap]);

  return (
    <div
      id="year-view-root"
      ref={containerRef}
      onKeyDown={handleKeyDown}
      className="flex flex-col h-full w-full max-w-5xl mx-auto overflow-y-auto px-4 py-6"
    >
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-divider)] pb-4">
        <div className="flex items-center gap-3">
          <Calendar className="h-5 w-5 text-[var(--color-accent)]" />
          <div>
            <h2 className="text-lg font-serif font-medium text-[var(--color-text-primary)]">
              Year View
            </h2>
            <p className="text-xs text-[var(--color-text-secondary)]">
              12-month reflection cadence and emotional landscape.
            </p>
          </div>
        </div>

        {/* Year Navigation Controls */}
        <div className="flex items-center gap-2">
          <button
            id="btn-prev-year"
            onClick={() => setCurrentYear((y) => y - 1)}
            className="p-1.5 rounded border border-[var(--color-divider)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] transition-colors"
            aria-label="Previous year"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="font-mono text-sm font-semibold px-2 text-[var(--color-text-primary)]">
            {currentYear}
          </span>
          <button
            id="btn-next-year"
            onClick={() => setCurrentYear((y) => y + 1)}
            className="p-1.5 rounded border border-[var(--color-divider)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] transition-colors"
            aria-label="Next year"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          {onClose && (
            <button
              onClick={onClose}
              className="ml-4 p-1.5 rounded text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface)] transition-colors"
              aria-label="Close year view"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      {/* Dynamic Inspector Strip (Hover/Focus Details) */}
      <div
        id="year-view-inspector"
        className="my-4 rounded-lg border border-[var(--color-divider)] bg-[var(--color-surface)] p-3 shadow-sm transition-all"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--color-text-primary)]">
              {activeDayData.dateObj.toLocaleDateString(undefined, {
                weekday: 'short',
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </span>
            <span className="text-[var(--color-text-secondary)]">•</span>
            <span className="text-[var(--color-text-secondary)]">
              {activeDayData.count === 0
                ? 'No reflections recorded'
                : `${activeDayData.count} reflection${activeDayData.count > 1 ? 's' : ''}`}
            </span>
            {activeDayData.avgMood !== null && (
              <>
                <span className="text-[var(--color-text-secondary)]">•</span>
                <span className="text-[var(--color-text-secondary)]">
                  Avg Mood:{' '}
                  <strong className="text-[var(--color-text-primary)]">
                    {activeDayData.avgMood > 0 ? `+${activeDayData.avgMood.toFixed(2)}` : activeDayData.avgMood.toFixed(2)}
                  </strong>
                </span>
              </>
            )}
          </div>

          {activeDayData.dominantThemes.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[var(--color-text-secondary)]">Themes:</span>
              {activeDayData.dominantThemes.map((theme) => (
                <span
                  key={theme}
                  className="rounded bg-[var(--color-surface-hover)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-primary)] border border-[var(--color-divider)]/40"
                >
                  {theme}
                </span>
              ))}
            </div>
          )}

          {activeDayData.entries.length > 0 && (
            <div className="flex items-center gap-2">
              {activeDayData.entries.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => onSelectEntry(entry.id)}
                  className="inline-flex items-center gap-1 rounded bg-[var(--color-surface-subtle)] px-2 py-1 text-[11px] font-medium text-[var(--color-accent)] hover:underline border border-[var(--color-divider)]"
                >
                  <BookOpen className="h-3 w-3" />
                  Open &ldquo;{entry.title || 'Entry'}&rdquo;
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 12-Month Grid (Designed for 360px+ viewport scalability) */}
      <div
        id="year-grid-container"
        className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 pb-8"
      >
        {MONTH_NAMES.map((monthName, monthIndex) => {
          const daysInMonth = new Date(currentYear, monthIndex + 1, 0).getDate();
          const firstDayWeekday = new Date(currentYear, monthIndex, 1).getDay(); // 0 = Sunday

          return (
            <div
              key={monthName}
              id={`month-${monthIndex}`}
              className="rounded-lg border-0 bg-[var(--color-surface)]/80 shadow-sm p-3"
            >
              <h3 className="mb-2 font-serif text-xs font-semibold text-[var(--color-text-primary)] tracking-wide">
                {monthName}
              </h3>

              {/* Day of week headers */}
              <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-[var(--color-text-secondary)] mb-1">
                {WEEKDAY_HEADERS.map((w, idx) => (
                  <span key={idx} className="h-4 leading-4">
                    {w}
                  </span>
                ))}
              </div>

              {/* Day cells */}
              <div className="grid grid-cols-7 gap-1" role="grid" aria-label={`${monthName} ${currentYear}`}>
                {/* Offset padding cells before day 1 */}
                {Array.from({ length: firstDayWeekday }).map((_, padIdx) => (
                  <div key={`pad-${padIdx}`} className="h-6 w-6" aria-hidden="true" />
                ))}

                {/* Days of the month */}
                {Array.from({ length: daysInMonth }).map((_, dayIdx) => {
                  const dayNum = dayIdx + 1;
                  const dObj = new Date(currentYear, monthIndex, dayNum);
                  const dateStr = formatIsoDate(dObj);
                  const dayInfo = dayDataMap.get(dateStr) || {
                    dateStr,
                    dateObj: dObj,
                    entries: [],
                    count: 0,
                    avgMood: null,
                    dominantThemes: [],
                  };

                  const isFocused = dateStr === focusedDateStr;
                  const visuals = getCellVisuals(dayInfo.count, dayInfo.avgMood);

                  return (
                    <button
                      key={dateStr}
                      id={`year-cell-${dateStr}`}
                      role="gridcell"
                      tabIndex={isFocused ? 0 : -1}
                      aria-label={`${monthName} ${dayNum}, ${currentYear}: ${visuals.titleSuffix}${
                        dayInfo.dominantThemes.length > 0
                          ? `. Themes: ${dayInfo.dominantThemes.join(', ')}`
                          : ''
                      }`}
                      onClick={() => {
                        setFocusedDateStr(dateStr);
                        setHoveredDay(dayInfo);
                        if (dayInfo.entries.length > 0) {
                          onSelectEntry(dayInfo.entries[0].id);
                        }
                      }}
                      onMouseEnter={() => setHoveredDay(dayInfo)}
                      onFocus={() => {
                        setFocusedDateStr(dateStr);
                        setHoveredDay(dayInfo);
                      }}
                      className={`h-6 w-6 rounded text-[10px] flex items-center justify-center transition-all ${
                        visuals.bg
                      } ${
                        isFocused
                          ? 'ring-2 ring-[var(--color-accent)] scale-110 z-10'
                          : 'hover:scale-105'
                      }`}
                      title={`${monthName} ${dayNum}: ${visuals.titleSuffix}`}
                    >
                      {dayNum}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend & Navigation Guide */}
      <div className="mt-auto border-t border-[var(--color-divider)] pt-4 flex flex-wrap items-center justify-between gap-4 text-[11px] text-[var(--color-text-secondary)]">
        <div className="flex items-center gap-3">
          <span>Cadence Tint:</span>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded bg-amber-500" />
            <span>Optimistic</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded bg-gradient-to-br from-blue-500 to-emerald-400" />
            <span>Balanced</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded bg-indigo-500" />
            <span>Contemplative</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded border border-[var(--color-divider)] bg-[var(--color-surface)]/30" />
            <span>Rest Day</span>
          </div>
        </div>

        <div className="font-mono text-[10px] text-[var(--color-text-secondary)]">
          Keyboard: Arrow keys to navigate days • Enter to open
        </div>
      </div>
    </div>
  );
};
