/**
 * @file lib/server/location-settings.ts
 * FEATURE 9: Per-user location preferences.
 *
 * Both settings default to FALSE and are only ever read from the user's own document
 * using the user's own token, so Firestore rules -- not application code -- decide
 * whether the read is permitted.
 *
 * `preciseLocation`               -- store exact coordinates instead of ~1km coarse.
 * `locationContextForReflections` -- allow the place label to reach Gemini unmasked.
 *
 * A missing document means both are off. Anything other than boolean `true` is treated
 * as off, so a malformed or partially-written document fails closed.
 */

import { getDocument, persistDocument } from '@/lib/server/firestore-rest';

export interface LocationSettings {
  preciseLocation: boolean;
  locationContextForReflections: boolean;
}

export const DEFAULT_LOCATION_SETTINGS: LocationSettings = {
  preciseLocation: false,
  locationContextForReflections: false,
};

const settingsPath = (uid: string) => `users/${uid}/settings/location`;

export function normalizeLocationSettings(raw: unknown): LocationSettings {
  const doc = (raw ?? {}) as Record<string, unknown>;
  return {
    // Strict identity check: only an explicit boolean true enables a setting.
    preciseLocation: doc.preciseLocation === true,
    locationContextForReflections: doc.locationContextForReflections === true,
  };
}

export async function readLocationSettings(
  uid: string,
  idToken: string
): Promise<LocationSettings> {
  try {
    const doc = await getDocument(settingsPath(uid), idToken);
    return normalizeLocationSettings(doc);
  } catch {
    return { ...DEFAULT_LOCATION_SETTINGS };
  }
}

export async function writeLocationSettings(
  uid: string,
  idToken: string,
  settings: LocationSettings
): Promise<boolean> {
  return await persistDocument(
    settingsPath(uid),
    {
      preciseLocation: settings.preciseLocation,
      locationContextForReflections: settings.locationContextForReflections,
      updatedAt: new Date().toISOString(),
    },
    idToken
  );
}
