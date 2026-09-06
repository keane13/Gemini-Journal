/**
 * @file lib/server/retention.ts
 * FEATURE 11: Managed Forgetting — policy, window arithmetic, and the seal/open path.
 *
 * The inversion this feature makes:
 *
 *   Canonical body      = REDACTED text. Always. Forever.
 *   Rehydration payload = the placeholder map, encrypted under a KMS-wrapped per-user DEK.
 *
 * Inside the retention window a read decrypts the map server-side and rehydrates the body
 * for display. Past the window a scheduled job destroys the encrypted payload, and the
 * entry stays fully readable and searchable — only the personal details are gone:
 *
 *   "Dia minta aku follow up ke [EMAIL_1]"
 *
 * That is the whole design. Because the canonical body was never the plaintext, forgetting
 * is not a deletion that has to chase copies: there is nothing to chase. And because
 * Recall and Patterns already operate on redacted text, forgetting costs no retrieval
 * quality whatsoever.
 *
 * IRREVERSIBILITY: destroying the payload is final. There is no archive, no soft delete,
 * and no administrative recovery — the plaintext map was never stored anywhere else, and
 * the ciphertext is overwritten rather than moved.
 */

import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument, persistDocument } from '@/lib/server/firestore-rest';
import {
  SealedPayload,
  generateWrappedDek,
  openUnderDek,
  sealUnderDek,
  unwrapDek,
} from '@/lib/server/kms';

/** Permitted windows, in days. `never` retains the payload indefinitely. */
export const RETENTION_OPTIONS = [30, 90, 365, 'never'] as const;
export type RetentionWindow = (typeof RETENTION_OPTIONS)[number];

export const DEFAULT_RETENTION: RetentionWindow = 90;

/**
 * Typed to shorten a window, because shortening destroys data in the same request with
 * no way back. Lives here rather than in the route because Next.js restricts which names
 * a route module may export.
 */
export const SHORTEN_CONFIRM_PHRASE = 'FORGET THE DETAILS NOW';

/**
 * The floor is 30 days, and "off" is deliberately not offered.
 *
 * A zero-day window would mean the map is destroyed before the user has read their own
 * reflection back — the feature would stop being a privacy control and start being data
 * loss. 30 days is the shortest window where the entry is still useful to its author.
 */
export const MINIMUM_RETENTION_DAYS = 30;

export function isValidRetention(value: unknown): value is RetentionWindow {
  return (RETENTION_OPTIONS as readonly unknown[]).includes(value as RetentionWindow);
}

export interface RetentionPolicy {
  window: RetentionWindow;
  updatedAt: string;
}

const policyPath = (uid: string) => `users/${uid}/settings/retention`;
const dekPath = (uid: string) => `userDataKeys/${uid}`;

export function normalizeRetentionPolicy(raw: unknown): RetentionPolicy {
  const doc = (raw ?? {}) as Record<string, unknown>;
  const value = doc.window;
  return {
    // Anything unrecognised falls back to the default rather than to "never":
    // a corrupt document must not silently upgrade someone to indefinite retention.
    window: isValidRetention(value) ? value : DEFAULT_RETENTION,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date(0).toISOString(),
  };
}

export async function readRetentionPolicy(
  uid: string,
  idToken: string
): Promise<RetentionPolicy> {
  try {
    return normalizeRetentionPolicy(await getDocument(policyPath(uid), idToken));
  } catch {
    return { window: DEFAULT_RETENTION, updatedAt: new Date(0).toISOString() };
  }
}

export async function writeRetentionPolicy(
  uid: string,
  idToken: string,
  window: RetentionWindow
): Promise<boolean> {
  return persistDocument(
    policyPath(uid),
    { window, updatedAt: new Date().toISOString() },
    idToken
  );
}

// ---------------------------------------------------------------------------
// Window arithmetic
// ---------------------------------------------------------------------------

export type RetentionStatus = 'retained' | 'expiring' | 'forgotten' | 'never';

export interface RetentionState {
  status: RetentionStatus;
  /** ISO date the payload becomes eligible for destruction; null when `never`. */
  expiresAt: string | null;
  /** Whole days remaining; null when `never` or already forgotten. */
  daysRemaining: number | null;
  /** 0..1 of the window elapsed, for the gutter mark. Null when `never`. */
  elapsedFraction: number | null;
  /** Human sentence for the entry header. */
  label: string;
}

const DAY_MS = 86400000;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Computes the retention state of one entry.
 *
 * `hasPayload` is authoritative for "forgotten": an entry whose payload is gone is
 * forgotten regardless of what the dates say, because the data is genuinely destroyed.
 * Deriving it from arithmetic alone would let a clock change resurrect a claim that the
 * details are still available when they are not.
 */
export function computeRetentionState(
  createdAt: string,
  window: RetentionWindow,
  hasPayload: boolean,
  now: Date = new Date()
): RetentionState {
  const created = new Date(createdAt);
  const createdMs = Number.isNaN(created.getTime()) ? now.getTime() : created.getTime();

  if (!hasPayload) {
    return {
      status: 'forgotten',
      expiresAt: null,
      daysRemaining: null,
      elapsedFraction: 1,
      label: `Details forgotten${Number.isNaN(created.getTime()) ? '' : ''}`,
    };
  }

  if (window === 'never') {
    return {
      status: 'never',
      expiresAt: null,
      daysRemaining: null,
      elapsedFraction: null,
      label: 'Details kept indefinitely',
    };
  }

  const expiresMs = createdMs + window * DAY_MS;
  const expiresAt = new Date(expiresMs).toISOString();
  const remainingMs = expiresMs - now.getTime();
  const daysRemaining = Math.max(0, Math.ceil(remainingMs / DAY_MS));
  const elapsedFraction = Math.max(0, Math.min(1, 1 - remainingMs / (window * DAY_MS)));

  if (remainingMs <= 0) {
    // Past the window but the job has not run yet. Honest about both facts.
    return {
      status: 'expiring',
      expiresAt,
      daysRemaining: 0,
      elapsedFraction: 1,
      label: `Details expire today`,
    };
  }

  return {
    status: daysRemaining <= 7 ? 'expiring' : 'retained',
    expiresAt,
    daysRemaining,
    elapsedFraction,
    label:
      daysRemaining === 1
        ? 'Details expire tomorrow'
        : `Details expire in ${daysRemaining} days`,
  };
}

/** Label for an entry whose payload has already been destroyed. */
export function forgottenLabel(forgottenAt: string | null): string {
  return forgottenAt
    ? `Details forgotten on ${formatDate(forgottenAt)}`
    : 'Details forgotten';
}

/** True when this entry's payload is eligible for destruction now. */
export function isEligibleForForgetting(
  createdAt: string,
  window: RetentionWindow,
  now: Date = new Date()
): boolean {
  if (window === 'never') return false;
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return false;
  return now.getTime() >= created + window * DAY_MS;
}

// ---------------------------------------------------------------------------
// Per-user data key
// ---------------------------------------------------------------------------

/**
 * Returns the user's plaintext DEK, minting and wrapping one on first use.
 *
 * The wrapped form is stored at /userDataKeys/{uid}, which no client can read. The
 * plaintext is returned to the caller for the duration of one request and is never
 * written anywhere.
 */
export async function getUserDek(uid: string): Promise<Buffer> {
  const token = await getGoogleAccessToken();
  const existing = await getDocument(dekPath(uid), token);
  const wrapped = (existing as { wrappedDek?: string } | null)?.wrappedDek;

  if (typeof wrapped === 'string' && wrapped) {
    return unwrapDek(uid, wrapped);
  }

  const { dek, wrappedDek } = await generateWrappedDek(uid);
  await persistDocument(
    dekPath(uid),
    { uid, wrappedDek, createdAt: new Date().toISOString() },
    token
  );
  return dek;
}

// ---------------------------------------------------------------------------
// Sealing and opening the placeholder map
// ---------------------------------------------------------------------------

/**
 * Seals a placeholder map for storage.
 *
 * The input is the ephemeral map produced by the Privacy Shield during the request that
 * created the entry. It is encrypted here and then discarded; the plaintext map is never
 * persisted, logged, or returned.
 */
export async function sealRehydrationMap(
  uid: string,
  map: Map<string, string>
): Promise<SealedPayload | null> {
  if (map.size === 0) return null;

  const dek = await getUserDek(uid);
  const serialized = JSON.stringify(Object.fromEntries(map));
  return sealUnderDek(dek, serialized);
}

/** Opens a sealed placeholder map. Returns null when the payload is absent or unreadable. */
export async function openRehydrationMap(
  uid: string,
  sealed: SealedPayload | null | undefined
): Promise<Record<string, string> | null> {
  if (!sealed) return null;
  try {
    const dek = await getUserDek(uid);
    return JSON.parse(openUnderDek(dek, sealed));
  } catch (err) {
    console.warn('Rehydration payload could not be opened:', err);
    return null;
  }
}

/**
 * Substitutes placeholders back into a redacted body for display.
 * Pure and synchronous: the map is already in memory by the time this runs.
 */
export function rehydrate(text: string, map: Record<string, string> | null): string {
  if (!map || !text) return text;
  let out = text;
  for (const [placeholder, original] of Object.entries(map)) {
    out = out.replaceAll(placeholder, original);
  }
  return out;
}
