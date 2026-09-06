/**
 * @file lib/server/geocode.ts
 * FEATURE 9: Server-side reverse geocoding and coordinate coarsening.
 *
 * KEY ISOLATION: the Maps key is resolved server-side from Secret Manager (see
 * lib/server/secrets.ts#getMapsApiKey) and is a different credential from the Gemini key.
 * It never reaches the browser -- the client posts coordinates and receives a label.
 *
 * PRECISION MINIMIZATION: coordinates are coarsened to ~1km by default. The precise
 * value is discarded in this module before anything is returned or stored, so "coarse by
 * default" is a property of the data flow rather than a promise made by the UI.
 */

import { getMapsApiKey } from '@/lib/server/secrets';

/**
 * Decimal places that yield roughly 1km of latitude precision.
 * 1 degree of latitude is ~111km, so 2dp is ~1.11km.
 */
export const COARSE_DECIMAL_PLACES = 2;

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface ResolvedLocation {
  /** Coordinates actually retained (coarse unless precise mode is enabled). */
  lat: number;
  lng: number;
  /** Human-readable place label, e.g. "Kebayoran Baru, Jakarta". */
  placeLabel: string;
  /** 'coarse' (~1km) or 'precise'. */
  precision: 'coarse' | 'precise';
  /** Approximate radius in metres implied by the stored precision. */
  approxRadiusMeters: number;
}

export function isValidCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateCoordinates(lat: unknown, lng: unknown): Coordinates {
  if (!isValidCoordinate(lat) || !isValidCoordinate(lng)) {
    throw new Error('lat and lng must be finite numbers.');
  }
  if (lat < -90 || lat > 90) throw new Error('lat must be between -90 and 90.');
  if (lng < -180 || lng > 180) throw new Error('lng must be between -180 and 180.');
  return { lat, lng };
}

/** Rounds coordinates to ~1km. Irreversible: the precise value is not retained. */
export function coarsen(coords: Coordinates, places = COARSE_DECIMAL_PLACES): Coordinates {
  const factor = 10 ** places;
  return {
    lat: Math.round(coords.lat * factor) / factor,
    lng: Math.round(coords.lng * factor) / factor,
  };
}

/**
 * Picks a neighbourhood-or-broader label from Google's reverse geocoding result.
 *
 * Deliberately skips `street_address`, `premise`, and `route` components: a street
 * address is exactly the kind of identifying detail this feature is meant to avoid
 * storing, and the Privacy Shield would only have to mask it again later.
 */
export function selectPlaceLabel(results: any[]): string {
  if (!Array.isArray(results) || results.length === 0) return 'Unknown location';

  const preferredTypes = [
    'neighborhood',
    'sublocality',
    'sublocality_level_1',
    'locality',
    'administrative_area_level_2',
    'administrative_area_level_1',
    'country',
  ];

  const parts: string[] = [];
  for (const type of ['neighborhood', 'sublocality_level_1', 'sublocality', 'locality']) {
    const component = results
      .flatMap((r: any) => r.address_components || [])
      .find((c: any) => Array.isArray(c.types) && c.types.includes(type));
    if (component?.long_name && !parts.includes(component.long_name)) {
      parts.push(component.long_name);
      break;
    }
  }

  for (const type of ['locality', 'administrative_area_level_1']) {
    const component = results
      .flatMap((r: any) => r.address_components || [])
      .find((c: any) => Array.isArray(c.types) && c.types.includes(type));
    if (component?.long_name && !parts.includes(component.long_name)) {
      parts.push(component.long_name);
      break;
    }
  }

  if (parts.length === 0) {
    const fallback = results
      .flatMap((r: any) => r.address_components || [])
      .find((c: any) => Array.isArray(c.types) && c.types.some((t: string) => preferredTypes.includes(t)));
    if (fallback?.long_name) parts.push(fallback.long_name);
  }

  return parts.length > 0 ? parts.join(', ') : 'Unknown location';
}

/**
 * Reverse geocodes coordinates to a place label.
 *
 * The coordinates sent upstream to Google are the COARSENED ones unless the user has
 * explicitly enabled precise mode -- the exact position is not disclosed to the geocoder
 * either, not merely withheld from storage.
 */
export async function reverseGeocode(
  raw: Coordinates,
  precise: boolean
): Promise<ResolvedLocation> {
  const stored = precise ? raw : coarsen(raw);
  const apiKey = await getMapsApiKey();

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${stored.lat},${stored.lng}`);
  url.searchParams.set('result_type', 'neighborhood|sublocality|locality|administrative_area_level_1');
  url.searchParams.set('key', apiKey);

  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Reverse geocoding failed (HTTP ${res.status}).`);
  }
  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Reverse geocoding failed: ${data.status}`);
  }

  return {
    lat: stored.lat,
    lng: stored.lng,
    placeLabel: selectPlaceLabel(data.results || []),
    precision: precise ? 'precise' : 'coarse',
    approxRadiusMeters: precise ? 10 : 1100,
  };
}
