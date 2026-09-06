/**
 * @file lib/server/notifications/types.ts
 * EXTERNAL NOTIFICATIONS: shared vocabulary for the notification directive.
 *
 * Two invariants are encoded directly in these types rather than left to convention,
 * because both were promised elsewhere in this system and must not erode:
 *
 *   1. TRIGGERS ARE AN ALLOWLIST, and mood/sentiment/distress are not on it.
 *      A journal that pages an external chat workspace because it inferred someone is
 *      struggling would leak the single most sensitive bit it holds, to the audience
 *      least entitled to it. `TRIGGER_TYPES` is exhaustive and `FORBIDDEN_TRIGGER_SIGNALS`
 *      documents what may never join it.
 *
 *   2. PAYLOAD TIERS ESCALATE ONLY BY EXPLICIT CONSENT.
 *      Unlike the weekly digest (which goes from the user's own account to themselves),
 *      these destinations are third parties: Slack and Discord receive and retain
 *      whatever is sent. The default tier therefore carries no journal-derived content
 *      at all, and each step up requires a separate, per-destination opt-in.
 */

/** Channels a notification can be delivered to. */
export type NotificationChannel = 'slack' | 'discord' | 'email';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  'slack',
  'discord',
  'email',
] as const;

/**
 * The complete set of events that may fire an external notification.
 *
 * Every member is derived from something the user did deliberately -- wrote an entry,
 * stated a commitment, applied a tag -- never from an inference about their state.
 */
export type TriggerType =
  /** Any entry was written. */
  | 'entry_created'
  /** An entry was written in a specific interaction mode (see `modes` filter). */
  | 'entry_mode'
  /** An entry carried one of the tags named in the `tags` filter. */
  | 'entry_tagged'
  /** The entry contained a self-stated first-person commitment (Feature 5). */
  | 'commitment_created'
  /** A previously open commitment passed the time the user named for it. */
  | 'commitment_overdue'
  /** The weekly insight run surfaced at least `threshold` recurring themes. */
  | 'themes_threshold';

export const TRIGGER_TYPES: readonly TriggerType[] = [
  'entry_created',
  'entry_mode',
  'entry_tagged',
  'commitment_created',
  'commitment_overdue',
  'themes_threshold',
] as const;

/**
 * Signals that must NEVER become trigger types.
 *
 * This is not decoration: `tests/notifications.test.ts` asserts that none of these
 * strings appears in the trigger evaluator's executable code, so adding a mood-based
 * trigger fails the suite rather than shipping quietly.
 *
 * The reasoning, so a future maintainer can weigh it rather than just obey it:
 *   - Routing an inferred emotional state to a Slack workspace can out someone's mental
 *     health to colleagues who have no business knowing it.
 *   - Distress inference is unreliable, and a false positive is not a harmless bug here.
 *   - A journal that reacts to sadness teaches the user to self-censor, which destroys
 *     the thing the product exists to provide.
 * If a crisis-support feature is ever wanted, it belongs in-app and in front of the
 * person themselves -- not on an outbound webhook.
 */
export const FORBIDDEN_TRIGGER_SIGNALS: readonly string[] = [
  'mood',
  'moodScore',
  'sentiment',
  'distress',
  'crisis',
  'risk',
  'emotion',
  'selfHarm',
] as const;

/**
 * How much a notification is permitted to say.
 *
 * `signal`   -- that something happened, plus a deep link. No journal-derived content.
 * `metadata` -- adds the trigger name, interaction mode, tag names the user chose, and
 *               counts. Still no free text written by the user or the model.
 * `excerpt`  -- adds a Privacy-Shield-redacted excerpt of the entry. Third parties will
 *               store this. Requires a typed confirmation per destination.
 */
export type PayloadTier = 'signal' | 'metadata' | 'excerpt';

export const PAYLOAD_TIERS: readonly PayloadTier[] = ['signal', 'metadata', 'excerpt'] as const;

/** Ordering used to compare tiers; higher discloses more. */
export const PAYLOAD_TIER_RANK: Record<PayloadTier, number> = {
  signal: 0,
  metadata: 1,
  excerpt: 2,
};

export const DEFAULT_PAYLOAD_TIER: PayloadTier = 'signal';

/** Maximum characters of redacted excerpt ever sent, at the `excerpt` tier. */
export const MAX_EXCERPT_CHARS = 280;

export interface TriggerFilter {
  type: TriggerType;
  /** For `entry_mode`: which interaction modes fire. */
  modes?: string[];
  /** For `entry_tagged`: which tags fire. Matched case-insensitively. */
  tags?: string[];
  /** For `themes_threshold`: minimum recurring theme count. */
  threshold?: number;
}

/**
 * A configured delivery target. The webhook URL / address lives encrypted in a separate
 * server-only document (see credentials.ts) and is never part of this record, so a
 * destination can be listed in the UI without the secret being loaded.
 */
export interface NotificationDestination {
  id: string;
  uid: string;
  channel: NotificationChannel;
  /** User-facing name, e.g. "my #journal channel". */
  label: string;
  enabled: boolean;
  triggers: TriggerFilter[];
  payloadTier: PayloadTier;
  /** Redacted display form of the target, e.g. "hooks.slack.com/services/T00…XYZ". */
  targetPreview: string;
  /** Set when the user typed the confirmation required for the `excerpt` tier. */
  excerptConsentAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Delivery health, for the settings UI. Counts only. */
  lastDeliveryAt: string | null;
  lastDeliveryOutcome: 'success' | 'failure' | null;
  consecutiveFailures: number;
}

/** A trigger that fired, before any payload decision has been made. */
export interface TriggerEvent {
  uid: string;
  type: TriggerType;
  entryId: string;
  occurredAt: string;
  /** Interaction mode of the entry, when applicable. */
  mode?: string;
  /** Tags the user applied. */
  tags?: string[];
  /** Counts only -- never the commitment text itself. */
  commitmentCount?: number;
  themeCount?: number;
  /**
   * Raw entry text. Present ONLY so the `excerpt` tier can redact and truncate it.
   * Never included in a payload without passing through the Privacy Shield first.
   */
  rawText?: string;
}

/** The body actually sent, after tier enforcement. */
export interface NotificationPayload {
  tier: PayloadTier;
  title: string;
  lines: string[];
  deepLink: string;
  /** Categories masked by the Privacy Shield, for the Egress Ledger. */
  redactedCategories: string[];
}
