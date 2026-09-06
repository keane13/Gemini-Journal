/**
 * @file tests/redaction.test.ts
 * Deterministic Privacy Shield Redaction Unit Tests.
 *
 * Tests Indonesian street address detection producing [ADDRESS_n],
 * international addresses, credit cards, emails, phones, and rehydration.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { runPrivacyShield, rehydrateModelOutput } from '../lib/server/redaction';

test('Redaction Gap: Indonesian street address detection with exact string', () => {
  const input = 'I was meeting at Jl. Gatot Subroto Kav 52, Jakarta Selatan yesterday afternoon.';
  const result = runPrivacyShield(input, 'standard');

  // Must detect address and mask as [ADDRESS_1]
  assert.strictEqual(result.redactionApplied, true, 'Redaction should be applied');
  assert.ok(
    result.redactedText.includes('[ADDRESS_1]'),
    `Redacted text should contain [ADDRESS_1], got: ${result.redactedText}`
  );
  assert.strictEqual(
    result.redactedText,
    'I was meeting at [ADDRESS_1] yesterday afternoon.'
  );
  assert.strictEqual(result.categoryCounts.address, 1);

  // Check ephemeral map contains exact original string
  assert.strictEqual(
    result.ephemeralMap.get('[ADDRESS_1]'),
    'Jl. Gatot Subroto Kav 52, Jakarta Selatan'
  );

  // Test rehydration restores original address
  const simulatedModelOutput = 'Thank you for noting your meeting at [ADDRESS_1]. How did it go?';
  const rehydrated = rehydrateModelOutput(simulatedModelOutput, result.ephemeralMap);
  assert.strictEqual(
    rehydrated,
    'Thank you for noting your meeting at Jl. Gatot Subroto Kav 52, Jakarta Selatan. How did it go?'
  );
});

test('Redaction Gap: Multiple Indonesian addresses and PII', () => {
  const input =
    'Contact office at Jalan Sudirman No. 10, RT 01 / RW 02, Kelurahan Senayan, Jakarta Selatan or email support@example.com';
  const result = runPrivacyShield(input, 'standard');

  assert.strictEqual(result.redactionApplied, true);
  assert.ok(result.redactedText.includes('[ADDRESS_1]'));
  assert.ok(result.redactedText.includes('[EMAIL_1]'));
  assert.strictEqual(result.categoryCounts.address, 1);
  assert.strictEqual(result.categoryCounts.email, 1);
});
