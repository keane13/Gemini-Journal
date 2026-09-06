/**
 * @file lib/server/notifications/store.ts
 * EXTERNAL NOTIFICATIONS: persistence for destinations and their sealed credentials.
 *
 * Two collections, deliberately split:
 *
 *   /notificationDestinations/{uid}_{id}  -- configuration. Contains no secret, so it can
 *                                            be listed for the settings UI freely.
 *   /notificationSecrets/{uid}_{id}       -- the sealed webhook URL. Loaded only at the
 *                                            moment of delivery.
 *
 * Both are denied to every client by firestore.rules and reached only with the service
 * credential, so a browser compromise cannot enumerate or exfiltrate webhook URLs. The
 * secret document is additionally encrypted (see crypto.ts), so the Firestore credential
 * alone is not enough to read it either.
 */

import { getGoogleAccessToken } from '@/lib/server/google-auth';
import { getDocument, listDocuments, persistDocument } from '@/lib/server/firestore-rest';
import { SealedSecret, openSecret, sealSecret } from './crypto';
import { NotificationDestination } from './types';

const destPath = (uid: string, id: string) => `notificationDestinations/${uid}_${id}`;
const secretPath = (uid: string, id: string) => `notificationSecrets/${uid}_${id}`;

/** Maximum destinations per account. Bounds fan-out and abuse. */
export const MAX_DESTINATIONS_PER_USER = 10;

export async function listDestinations(uid: string): Promise<NotificationDestination[]> {
  const token = await getGoogleAccessToken();
  const docs = await listDocuments('notificationDestinations', token, 200);
  return docs
    .filter((d) => d.uid === uid)
    .map((d) => d as unknown as NotificationDestination)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
}

export async function getDestination(
  uid: string,
  id: string
): Promise<NotificationDestination | null> {
  const token = await getGoogleAccessToken();
  const doc = await getDocument(destPath(uid, id), token);
  if (!doc) return null;
  const record = doc as unknown as NotificationDestination;
  // Defence in depth: never return a record whose uid does not match the caller, even
  // if a path were somehow constructed incorrectly.
  return record.uid === uid ? record : null;
}

export async function saveDestination(
  destination: NotificationDestination
): Promise<boolean> {
  const token = await getGoogleAccessToken();
  return persistDocument(
    destPath(destination.uid, destination.id),
    destination as unknown as Record<string, unknown>,
    token
  );
}

/** Seals and stores the delivery credential for a destination. */
export async function saveDestinationSecret(
  uid: string,
  id: string,
  target: string
): Promise<void> {
  const sealed = await sealSecret(target);
  const token = await getGoogleAccessToken();
  await persistDocument(
    secretPath(uid, id),
    { uid, id, sealed: sealed as unknown as Record<string, unknown>, updatedAt: new Date().toISOString() },
    token
  );
}

/** Loads and decrypts the delivery credential. Returns null when absent. */
export async function loadDestinationSecret(
  uid: string,
  id: string
): Promise<string | null> {
  const token = await getGoogleAccessToken();
  const doc = await getDocument(secretPath(uid, id), token);
  const sealed = (doc as any)?.sealed as SealedSecret | undefined;
  if (!sealed) return null;
  try {
    return await openSecret(sealed);
  } catch (err) {
    console.error('Failed to open notification credential:', err);
    return null;
  }
}

/**
 * Removes a destination and its credential.
 * The secret is overwritten with a tombstone rather than left behind, so deleting a
 * destination actually relinquishes the webhook capability.
 */
export async function deleteDestination(uid: string, id: string): Promise<void> {
  const token = await getGoogleAccessToken();
  const now = new Date().toISOString();
  await persistDocument(
    secretPath(uid, id),
    { uid, id, sealed: null, revokedAt: now },
    token
  );
  await persistDocument(
    destPath(uid, id),
    { uid, id, deleted: true, enabled: false, deletedAt: now },
    token
  );
}

/** Records the outcome of a delivery attempt. Counts and status only -- no payload. */
export async function recordDeliveryOutcome(
  destination: NotificationDestination,
  outcome: 'success' | 'failure'
): Promise<void> {
  const consecutiveFailures =
    outcome === 'failure' ? (destination.consecutiveFailures ?? 0) + 1 : 0;

  // Auto-disable a persistently broken destination so a deleted Slack channel does not
  // generate unbounded failing requests forever.
  const enabled = consecutiveFailures >= 10 ? false : destination.enabled;

  await saveDestination({
    ...destination,
    enabled,
    lastDeliveryAt: new Date().toISOString(),
    lastDeliveryOutcome: outcome,
    consecutiveFailures,
    updatedAt: new Date().toISOString(),
  });
}
