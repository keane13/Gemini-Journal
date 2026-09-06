/**
 * @file tests/route-exports.test.ts
 * Guard against a recurring build break.
 *
 * Next.js allows a route module to export only a fixed set of names. Exporting anything
 * else — a shared constant, a helper — fails the PRODUCTION build with an opaque
 * `OmitWithTag` type error, while `tsc --noEmit`, `eslint`, and the whole test suite all
 * pass. It is therefore invisible until deploy time.
 *
 * This has now broken the build three separate times in this codebase
 * (`deriveTitle`, `EXCERPT_CONSENT_PHRASE`, `SHORTEN_CONFIRM_PHRASE`). The fix each time
 * is the same: move the constant into `lib/` and import it. This test makes the mistake
 * fail in one second rather than at the end of a five-minute build.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');

/** Names Next.js permits a route module to export. */
const ALLOWED = new Set([
  'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS',
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime',
  'preferredRegion', 'maxDuration', 'generateStaticParams', 'config',
  'metadata', 'generateMetadata', 'alt', 'size', 'contentType',
]);

function findRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findRouteFiles(full, out);
    else if (entry.name === 'route.ts' || entry.name === 'route.tsx') out.push(full);
  }
  return out;
}

test('No route module exports a name Next.js does not allow', () => {
  const routes = findRouteFiles(path.join(ROOT, 'app'));
  assert.ok(routes.length > 0, 'expected to find route modules to check');

  const offenders: string[] = [];

  for (const file of routes) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');

    // `export const X`, `export function X`, `export async function X`, `export class X`.
    const re = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (!ALLOWED.has(m[1])) {
        offenders.push(`${rel} exports "${m[1]}"`);
      }
    }

    // `export type`/`export interface` are erased at compile time and are permitted.
  }

  assert.deepEqual(
    offenders,
    [],
    'Route modules may only export Next.js route handlers and segment config. ' +
      'Move shared values into lib/ and import them:\n  ' + offenders.join('\n  ')
  );
});
