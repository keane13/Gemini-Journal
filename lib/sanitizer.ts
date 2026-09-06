/**
 * Sanitizes Firestore payloads by recursively removing any `undefined` values.
 * Firestore client libraries reject objects containing `undefined` values.
 */
export function sanitizeFirestorePayload<T extends Record<string, any>>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj
      .filter((item) => item !== undefined)
      .map((item) =>
        item !== null && typeof item === 'object' ? sanitizeFirestorePayload(item) : item
      ) as unknown as T;
  }

  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) {
      continue;
    }
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      sanitized[key] = sanitizeFirestorePayload(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized as T;
}
