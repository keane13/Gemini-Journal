/**
 * @file lib/server/secrets.ts
 * Secure credential resolver for server-side operations.
 * Resolves Gemini API key with priority:
 * 1. Google Cloud Secret Manager (if configured in production)
 * 2. Environment variable (GEMINI_API_KEY)
 * Never exposes credentials to client-side bundles.
 */

let cachedGeminiKey: string | null = null;

export async function getGeminiApiKey(): Promise<string> {
  if (cachedGeminiKey) {
    return cachedGeminiKey;
  }

  // Check direct server environment variable first
  const envKey = process.env.GEMINI_API_KEY;
  if (envKey && envKey.trim()) {
    cachedGeminiKey = envKey.trim();
    return cachedGeminiKey;
  }

  // Attempt Google Cloud Secret Manager REST retrieval if SECRET_NAME is set
  const secretName = process.env.GCP_GEMINI_SECRET_NAME;
  if (secretName && process.env.GCP_PROJECT_ID) {
    try {
      // In Cloud Run, metadata server provides auth token for Secret Manager REST API
      const metadataRes = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } }
      );
      if (metadataRes.ok) {
        const tokenData = await metadataRes.json();
        const secretRes = await fetch(
          `https://secretmanager.googleapis.com/v1/projects/${process.env.GCP_PROJECT_ID}/secrets/${secretName}/versions/latest:access`,
          { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
        );
        if (secretRes.ok) {
          const secretPayload = await secretRes.json();
          const decoded = Buffer.from(secretPayload.payload.data, 'base64').toString('utf8');
          if (decoded) {
            cachedGeminiKey = decoded.trim();
            return cachedGeminiKey;
          }
        }
      }
    } catch (error) {
      console.warn('Secret Manager retrieval attempted but fell through:', error);
    }
  }

  throw new Error(
    'GEMINI_API_KEY is not configured. Please define GEMINI_API_KEY in environment variables or Secret Manager.'
  );
}

/**
 * FEATURE 9: Resolves the Google Maps API key used for SERVER-SIDE reverse geocoding.
 *
 * This is a SEPARATE credential from the Gemini key, resolved from a separate secret,
 * and is expected to be API-restricted (Geocoding API only) and IP-restricted to the
 * server egress range. It is never sent to the browser: the client posts coordinates to
 * /api/location/resolve and receives a place label back, so no map key is bundled.
 */
let cachedMapsKey: string | null = null;

export async function getMapsApiKey(): Promise<string> {
  if (cachedMapsKey) return cachedMapsKey;

  const envKey = process.env.MAPS_SERVER_API_KEY;
  if (envKey && envKey.trim()) {
    cachedMapsKey = envKey.trim();
    return cachedMapsKey;
  }

  const secretName = process.env.GCP_MAPS_SECRET_NAME;
  if (secretName && process.env.GCP_PROJECT_ID) {
    try {
      const metadataRes = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } }
      );
      if (metadataRes.ok) {
        const tokenData = await metadataRes.json();
        const secretRes = await fetch(
          `https://secretmanager.googleapis.com/v1/projects/${process.env.GCP_PROJECT_ID}/secrets/${secretName}/versions/latest:access`,
          { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
        );
        if (secretRes.ok) {
          const secretPayload = await secretRes.json();
          const decoded = Buffer.from(secretPayload.payload.data, 'base64').toString('utf8');
          if (decoded) {
            cachedMapsKey = decoded.trim();
            return cachedMapsKey;
          }
        }
      }
    } catch (error) {
      console.warn('Maps Secret Manager retrieval attempted but fell through:', error);
    }
  }

  throw new Error(
    'MAPS_SERVER_API_KEY is not configured. Location context requires a separate, ' +
      'API-restricted Maps key in MAPS_SERVER_API_KEY or Secret Manager (GCP_MAPS_SECRET_NAME).'
  );
}
