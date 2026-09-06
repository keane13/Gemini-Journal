/**
 * @file lib/server/firestore-rest.ts
 * Server-side Firestore persistence using authenticated user token and Firestore REST API.
 * Ensures all server writes are checked against firestore.rules using the verified token.
 */

import firebaseConfig from '@/firebase-applet-config.json';

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents`;

/**
 * Converts a standard JavaScript object into Firestore REST API value format.
 */
function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: value.toString() } : { doubleValue: value };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map(toFirestoreValue),
      },
    };
  }
  if (typeof value === 'object') {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

/**
 * Persists a document to Firestore using the verified user's Bearer token.
 */
export async function persistDocument(
  path: string,
  data: Record<string, unknown>,
  idToken: string
): Promise<boolean> {
  try {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      fields[k] = toFirestoreValue(v);
    }

    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    const res = await fetch(`${BASE_URL}/${cleanPath}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`Firestore REST write warning on ${path}:`, errText);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`Failed to persist document to Firestore (${path}):`, error);
    return false;
  }
}

/**
 * Converts a Firestore REST API value back to a JavaScript object.
 */
export function fromFirestoreValue(val: any): any {
  if (!val || typeof val !== 'object') return null;
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return parseFloat(val.doubleValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) {
    return (val.arrayValue.values || []).map(fromFirestoreValue);
  }
  if ('mapValue' in val) {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      res[k] = fromFirestoreValue(v);
    }
    return res;
  }
  return null;
}

/**
 * Lists documents from a Firestore subcollection using REST API.
 */
export async function listDocuments(
  path: string,
  idToken: string,
  pageSize: number = 50
): Promise<Array<{ id: string; [key: string]: any }>> {
  try {
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    const res = await fetch(`${BASE_URL}/${cleanPath}?pageSize=${pageSize}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const documents = data.documents || [];
    return documents.map((doc: any) => {
      const id = doc.name.split('/').pop() || '';
      const fields: Record<string, any> = {};
      for (const [k, v] of Object.entries(doc.fields || {})) {
        fields[k] = fromFirestoreValue(v);
      }
      return { id, ...fields };
    });
  } catch (err) {
    console.warn(`Failed to list documents at ${path}:`, err);
    return [];
  }
}

