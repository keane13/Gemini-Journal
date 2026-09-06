/**
 * @file lib/server/notifications/triggers.ts
 * EXTERNAL NOTIFICATIONS: deciding whether a configured destination should fire.
 *
 * This module is deliberately small and total. It reads only the structured facts on a
 * TriggerEvent -- what kind of thing happened, in which mode, under which tags, how many
 * commitments or themes -- and returns a boolean.
 *
 * It does NOT read `rawText`, and it has no access to a mood score, sentiment estimate,
 * or any other inference about the writer's state. That absence is enforced by test:
 * `tests/notifications.test.ts` asserts none of FORBIDDEN_TRIGGER_SIGNALS appears in this
 * file's executable code, so a well-meaning future change that adds "notify me when I
 * seem stressed" fails CI instead of shipping.
 */

import { TRIGGER_TYPES, TriggerEvent, TriggerFilter, TriggerType } from './types';

export function isKnownTriggerType(value: unknown): value is TriggerType {
  return typeof value === 'string' && (TRIGGER_TYPES as readonly string[]).includes(value);
}

/**
 * Validates and normalizes a trigger filter supplied by the client.
 * Unknown trigger types are rejected rather than ignored, so a typo cannot silently
 * produce a destination that never fires (or, worse, one that fires on everything).
 */
export function normalizeTriggerFilter(raw: unknown): TriggerFilter {
  const input = (raw ?? {}) as Record<string, unknown>;

  if (!isKnownTriggerType(input.type)) {
    throw new Error(
      `Unknown trigger type: ${JSON.stringify(input.type)}. ` +
        `Permitted types are: ${TRIGGER_TYPES.join(', ')}.`
    );
  }

  const filter: TriggerFilter = { type: input.type };

  if (input.type === 'entry_mode') {
    const modes = Array.isArray(input.modes)
      ? input.modes.filter((m): m is string => typeof m === 'string' && !!m.trim())
      : [];
    if (modes.length === 0) {
      throw new Error("The 'entry_mode' trigger requires at least one mode.");
    }
    filter.modes = modes.map((m) => m.trim().toLowerCase()).slice(0, 10);
  }

  if (input.type === 'entry_tagged') {
    const tags = Array.isArray(input.tags)
      ? input.tags.filter((t): t is string => typeof t === 'string' && !!t.trim())
      : [];
    if (tags.length === 0) {
      throw new Error("The 'entry_tagged' trigger requires at least one tag.");
    }
    filter.tags = tags.map((t) => t.trim().toLowerCase()).slice(0, 20);
  }

  if (input.type === 'themes_threshold') {
    const threshold = Number(input.threshold);
    if (!Number.isFinite(threshold) || threshold < 1) {
      throw new Error("The 'themes_threshold' trigger requires a threshold of at least 1.");
    }
    filter.threshold = Math.min(50, Math.floor(threshold));
  }

  return filter;
}

/**
 * Which filter types an event of a given type may satisfy.
 *
 * Writing an entry is the event that carries mode, tags, commitment count, and theme
 * count, so all four refinements of "an entry happened" are satisfiable by it. Without
 * this map, a `themes_threshold` or `commitment_created` destination would silently
 * never fire, because the journal write path emits `entry_created`.
 *
 * `commitment_overdue` is the one genuinely distinct event: it originates from the
 * commitment resurface path, not from writing.
 */
const FILTERS_SATISFIABLE_BY: Record<TriggerType, readonly TriggerType[]> = {
  entry_created: [
    'entry_created',
    'entry_mode',
    'entry_tagged',
    'commitment_created',
    'themes_threshold',
  ],
  entry_mode: ['entry_mode'],
  entry_tagged: ['entry_tagged'],
  commitment_created: ['commitment_created'],
  commitment_overdue: ['commitment_overdue'],
  themes_threshold: ['themes_threshold'],
};

/** Returns true when the event satisfies this single filter. */
export function filterMatches(filter: TriggerFilter, event: TriggerEvent): boolean {
  const satisfiable = FILTERS_SATISFIABLE_BY[event.type] ?? [];
  if (!satisfiable.includes(filter.type)) return false;

  switch (filter.type) {
    case 'entry_created':
      return true;

    case 'entry_mode':
      return Boolean(
        event.mode && (filter.modes ?? []).includes(event.mode.trim().toLowerCase())
      );

    case 'entry_tagged': {
      const eventTags = (event.tags ?? []).map((t) => t.trim().toLowerCase());
      return (filter.tags ?? []).some((t) => eventTags.includes(t));
    }

    case 'commitment_created':
      return (event.commitmentCount ?? 0) > 0;

    case 'commitment_overdue':
      return (event.commitmentCount ?? 0) > 0;

    case 'themes_threshold':
      return (event.themeCount ?? 0) >= (filter.threshold ?? 1);

    default:
      // Unreachable for well-formed filters; fail closed rather than fire.
      return false;
  }
}

/** Returns true when ANY configured filter matches (filters are ORed). */
export function shouldNotify(filters: TriggerFilter[], event: TriggerEvent): boolean {
  if (!Array.isArray(filters) || filters.length === 0) return false;
  return filters.some((filter) => filterMatches(filter, event));
}
