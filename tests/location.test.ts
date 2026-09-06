/**
 * @file tests/location.test.ts
 * FEATURE 9 verification: coarse-by-default storage, location redaction before model
 * egress, Egress Ledger visibility, key isolation, and fail-closed settings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import {
  COARSE_DECIMAL_PLACES,
  coarsen,
  selectPlaceLabel,
  validateCoordinates,
} from '../lib/server/geocode';
import {
  DEFAULT_LOCATION_SETTINGS,
  normalizeLocationSettings,
} from '../lib/server/location-settings';
import { runPrivacyShield } from '../lib/server/redaction';

const ROOT = path.join(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// Coarse by default
// ---------------------------------------------------------------------------

test('Coordinates are coarsened to roughly 1km by default', () => {
  assert.equal(COARSE_DECIMAL_PLACES, 2, '2dp of latitude is ~1.1km');

  const precise = { lat: -6.2297465, lng: 106.8295733 };
  const coarse = coarsen(precise);

  assert.equal(coarse.lat, -6.23);
  assert.equal(coarse.lng, 106.83);

  // The coarse value must not be recoverable to the original precision.
  assert.notEqual(coarse.lat, precise.lat);
  assert.notEqual(coarse.lng, precise.lng);
});

test('Coarsening keeps the point within ~1.5km of the original', () => {
  const precise = { lat: -6.2297465, lng: 106.8295733 };
  const coarse = coarsen(precise);

  // 1 degree latitude ~111km; 0.005 deg is the max rounding error at 2dp.
  const latErrorKm = Math.abs(coarse.lat - precise.lat) * 111;
  const lngErrorKm = Math.abs(coarse.lng - precise.lng) * 111 * Math.cos((precise.lat * Math.PI) / 180);

  assert.ok(latErrorKm < 1.5, `latitude error ${latErrorKm}km must stay under ~1.5km`);
  assert.ok(lngErrorKm < 1.5, `longitude error ${lngErrorKm}km must stay under ~1.5km`);
});

test('Coordinate validation rejects out-of-range and non-numeric input', () => {
  assert.throws(() => validateCoordinates(91, 0), /lat must be between/);
  assert.throws(() => validateCoordinates(0, 181), /lng must be between/);
  assert.throws(() => validateCoordinates('-6.2', 106.8), /finite numbers/);
  assert.throws(() => validateCoordinates(NaN, 0), /finite numbers/);
  assert.doesNotThrow(() => validateCoordinates(-6.23, 106.83));
});

// ---------------------------------------------------------------------------
// Settings fail closed
// ---------------------------------------------------------------------------

test('Location settings default to off', () => {
  assert.deepEqual(DEFAULT_LOCATION_SETTINGS, {
    preciseLocation: false,
    locationContextForReflections: false,
  });
  assert.deepEqual(normalizeLocationSettings(undefined), DEFAULT_LOCATION_SETTINGS);
  assert.deepEqual(normalizeLocationSettings({}), DEFAULT_LOCATION_SETTINGS);
});

test('Location settings fail closed on truthy-but-not-true values', () => {
  // A string "true", a 1, or a stray object must not silently enable precise storage
  // or unmasked egress.
  for (const sneaky of ['true', 1, 'yes', {}, []]) {
    const settings = normalizeLocationSettings({
      preciseLocation: sneaky,
      locationContextForReflections: sneaky,
    });
    assert.equal(settings.preciseLocation, false, `${JSON.stringify(sneaky)} must not enable precise`);
    assert.equal(settings.locationContextForReflections, false);
  }

  const enabled = normalizeLocationSettings({
    preciseLocation: true,
    locationContextForReflections: true,
  });
  assert.equal(enabled.preciseLocation, true);
  assert.equal(enabled.locationContextForReflections, true);
});

// ---------------------------------------------------------------------------
// Redaction before egress
// ---------------------------------------------------------------------------

test('Location is masked as [LOCATION_n] before model egress', () => {
  const label = 'Kebayoran Baru, Jakarta';
  const text = `Wrote this from the cafe.\n\n[Entry location: ${label}]`;

  const result = runPrivacyShield(text, 'standard', { maskLocations: [label] });

  assert.ok(!result.redactedText.includes(label), 'the place label must not survive to egress');
  assert.match(result.redactedText, /\[LOCATION_1\]/);
  assert.equal(result.redactionApplied, true);
});

test('Location masking appears in the Egress Ledger like any other entity', () => {
  const label = 'Kebayoran Baru, Jakarta';
  const result = runPrivacyShield(`Note. [Entry location: ${label}]`, 'standard', {
    maskLocations: [label],
  });

  const span = result.maskedSpans.find((s) => s.category === 'LOCATION');
  assert.ok(span, 'a LOCATION span must be recorded for the ledger');
  assert.equal(span!.placeholder, '[LOCATION_1]');
  assert.ok(span!.maskedPreview.includes('•'), 'the ledger shows a masked preview, not the value');
  assert.equal(result.categoryCounts.location, 1, 'location must be counted in the histogram');
});

test('Location is rehydrated only in server memory, never left in the payload', () => {
  const label = 'Ubud, Bali';
  const result = runPrivacyShield(`Today. [Entry location: ${label}]`, 'standard', {
    maskLocations: [label],
  });

  // The ephemeral map holds the original for rehydration...
  assert.equal(result.ephemeralMap.get('[LOCATION_1]'), label);
  // ...but the text that would be sent upstream does not.
  assert.ok(!result.redactedText.includes('Ubud'));
});

test('Location is NOT masked when the user enabled location context', () => {
  const label = 'Ubud, Bali';
  const text = `Today. [Entry location: ${label}]`;

  // The route passes an empty maskLocations list in this case.
  const result = runPrivacyShield(text, 'standard', { maskLocations: [] });

  assert.ok(result.redactedText.includes(label), 'an explicit opt-in means the label may pass');
  assert.equal(
    result.maskedSpans.some((s) => s.category === 'LOCATION'),
    false
  );
});

test('Location masking applies even when the privacy mode is off', () => {
  // Privacy mode governs PII heuristics; location sharing is a separate, explicit
  // consent. Turning heuristics off must not silently start leaking location.
  const label = 'Ubud, Bali';
  const result = runPrivacyShield(`Today. [Entry location: ${label}]`, 'off', {
    maskLocations: [label],
  });

  assert.ok(!result.redactedText.includes(label));
  assert.match(result.redactedText, /\[LOCATION_1\]/);
});

test('Privacy mode off with no location still short-circuits unchanged', () => {
  const text = 'Call me at 555-123-4567.';
  const result = runPrivacyShield(text, 'off');
  assert.equal(result.redactedText, text);
  assert.equal(result.redactionApplied, false);
});

test('Regex metacharacters in a place label cannot break the masker', () => {
  // A label like "St. John's (Old Town)" must be matched literally, not as a pattern.
  const label = "St. John's (Old Town) [East]";
  const result = runPrivacyShield(`Here. [Entry location: ${label}]`, 'standard', {
    maskLocations: [label],
  });

  assert.ok(!result.redactedText.includes(label));
  assert.match(result.redactedText, /\[LOCATION_1\]/);
});

// ---------------------------------------------------------------------------
// Place label selection
// ---------------------------------------------------------------------------

test('Place labels prefer neighbourhood-or-broader, never a street address', () => {
  const results = [
    {
      address_components: [
        { long_name: '742', types: ['street_number'] },
        { long_name: 'Evergreen Terrace', types: ['route'] },
        { long_name: 'Kebayoran Baru', types: ['sublocality', 'sublocality_level_1'] },
        { long_name: 'Jakarta', types: ['locality'] },
      ],
    },
  ];

  const label = selectPlaceLabel(results);
  assert.equal(label, 'Kebayoran Baru, Jakarta');
  assert.ok(!label.includes('742'), 'a street number must never appear in a place label');
  assert.ok(!label.includes('Evergreen'), 'a route must never appear in a place label');
});

test('Place label degrades gracefully with no geocoding results', () => {
  assert.equal(selectPlaceLabel([]), 'Unknown location');
  assert.equal(selectPlaceLabel(undefined as any), 'Unknown location');
});

// ---------------------------------------------------------------------------
// Key isolation
// ---------------------------------------------------------------------------

test('The Maps key is a separate credential and never reaches the client', () => {
  const secrets = read('lib/server/secrets.ts');
  assert.ok(secrets.includes('MAPS_SERVER_API_KEY'));
  assert.ok(secrets.includes('GCP_MAPS_SECRET_NAME'));
  assert.ok(
    secrets.includes('getMapsApiKey'),
    'the Maps key must have its own resolver, distinct from the Gemini key'
  );

  // The key must never be exposed under a NEXT_PUBLIC_ name, which Next.js inlines
  // into the client bundle.
  assert.ok(
    !/NEXT_PUBLIC_[A-Z_]*MAPS/.test(secrets),
    'the Maps key must never be a NEXT_PUBLIC_ variable'
  );
});

test('No client component references a Maps API key', () => {
  const clientDirs = ['components', 'hooks'];
  for (const dir of clientDirs) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    for (const file of fs.readdirSync(base)) {
      if (!/\.tsx?$/.test(file)) continue;
      const source = fs.readFileSync(path.join(base, file), 'utf8');
      assert.ok(
        !/MAPS_SERVER_API_KEY|maps\.googleapis\.com/.test(source),
        `${dir}/${file} must not reference the Maps key or call the Maps API directly`
      );
    }
  }
});

test('Reverse geocoding runs server-side only', () => {
  const geocode = read('lib/server/geocode.ts');
  assert.ok(geocode.includes('maps.googleapis.com/maps/api/geocode/json'));
  assert.ok(
    !geocode.includes("'use client'"),
    'the geocoding module must never become a client module'
  );

  const route = read('app/api/location/resolve/route.ts');
  assert.ok(route.includes('authenticateRequest'), 'geocoding must require authentication');
  assert.ok(route.includes('checkRateLimit'), 'a paid upstream call must be rate limited');
});

test('Location settings are owner-gated in firestore.rules', () => {
  const rules = read('firestore.rules');
  const start = rules.indexOf('match /settings/{settingId}');
  assert.ok(start > -1, 'a settings match block must exist');

  const block = rules.slice(start, start + 700);
  assert.match(block, /allow read, delete: if isOwner\(userId\)/);
  assert.ok(!/isAdmin\(\)/.test(block), 'the admin role must confer no access to settings');
});
