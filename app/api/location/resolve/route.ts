/**
 * @file app/api/location/resolve/route.ts
 * FEATURE 9: Server-side reverse geocoding for an optional per-entry location pin.
 *
 * The browser posts coordinates and receives a place label plus the coordinates that
 * were actually retained. The Maps key stays on the server (a separate, API-restricted
 * credential from Secret Manager), so no map key is shipped to the client at all.
 *
 * Coarse (~1km) is the default. Precise coordinates are used only when the user has
 * explicitly set preciseLocation, which is read from their own settings document with
 * their own token.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, extractBearerToken } from '@/lib/server/auth';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { reverseGeocode, validateCoordinates } from '@/lib/server/geocode';
import { readLocationSettings, writeLocationSettings } from '@/lib/server/location-settings';
import { recordMetric } from '@/lib/server/metrics';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let user;
  let token: string;
  try {
    token = extractBearerToken(req);
    user = await authenticateRequest(req);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'UNAUTHORIZED',
        message: err instanceof Error ? err.message : 'Authentication failed.',
      },
      { status: 401 }
    );
  }

  // Geocoding is a paid upstream call; rate limit it like any other egress.
  const rate = checkRateLimit(user.uid);
  if (!rate.allowed) {
    recordMetric({ kind: 'rate_limit_hit', uid: user.uid });
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many location lookups. Please wait.' },
      { status: 429, headers: { 'Retry-After': String(rate.resetSeconds) } }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const coords = validateCoordinates(body?.lat, body?.lng);

    const settings = await readLocationSettings(user.uid, token);
    const resolved = await reverseGeocode(coords, settings.preciseLocation);

    return NextResponse.json({
      location: resolved,
      settings,
      note:
        resolved.precision === 'coarse'
          ? 'Stored at approximately 1km precision. Exact coordinates were discarded server-side.'
          : 'Precise coordinates stored because you enabled precise location.',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to resolve location.';
    recordMetric({ kind: 'error', uid: user.uid, errorCode: 'LOCATION_RESOLVE_FAILED' });
    return NextResponse.json(
      { error: 'LOCATION_RESOLVE_FAILED', message },
      { status: /must be|between/.test(message) ? 400 : 502 }
    );
  }
}

/** Returns the caller's current location preferences. */
export async function GET(req: NextRequest) {
  try {
    const token = extractBearerToken(req);
    const user = await authenticateRequest(req);
    return NextResponse.json({ settings: await readLocationSettings(user.uid, token) });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'UNAUTHORIZED',
        message: err instanceof Error ? err.message : 'Authentication failed.',
      },
      { status: 401 }
    );
  }
}

/** Updates the caller's location preferences. Both default to off. */
export async function PATCH(req: NextRequest) {
  let user;
  let token: string;
  try {
    token = extractBearerToken(req);
    user = await authenticateRequest(req);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'UNAUTHORIZED',
        message: err instanceof Error ? err.message : 'Authentication failed.',
      },
      { status: 401 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const current = await readLocationSettings(user.uid, token);

    const next = {
      preciseLocation:
        typeof body?.preciseLocation === 'boolean' ? body.preciseLocation : current.preciseLocation,
      locationContextForReflections:
        typeof body?.locationContextForReflections === 'boolean'
          ? body.locationContextForReflections
          : current.locationContextForReflections,
    };

    const ok = await writeLocationSettings(user.uid, token, next);
    if (!ok) {
      return NextResponse.json(
        { error: 'SETTINGS_WRITE_FAILED', message: 'Failed to persist location settings.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ settings: next });
  } catch (error) {
    return NextResponse.json(
      {
        error: 'SETTINGS_WRITE_FAILED',
        message: error instanceof Error ? error.message : 'Failed to update settings.',
      },
      { status: 500 }
    );
  }
}
