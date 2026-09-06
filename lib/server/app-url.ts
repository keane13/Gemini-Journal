/**
 * @file lib/server/app-url.ts
 * Resolves the canonical application origin used to build deep links in outbound email.
 *
 * Prefers the explicitly configured APP_URL. Falls back to the request's forwarded host
 * only when no configuration exists, and never trusts a host header that is not in the
 * allowlist -- an attacker-controlled Host would otherwise rewrite the links inside a
 * user's own digest email.
 */

import { NextRequest } from 'next/server';

function allowedHosts(): string[] {
  return (process.env.APP_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function appUrlFrom(req?: NextRequest): string {
  const configured = process.env.APP_URL;
  if (configured) return configured.replace(/\/+$/, '');

  if (req) {
    const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const proto = (req.headers.get('x-forwarded-proto') || 'https').split(',')[0].trim();

    const permitted = allowedHosts();
    const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
    if (host && (isLocal || permitted.includes(host))) {
      return `${proto}://${host}`;
    }
  }

  // Deliberately not derived from an untrusted header.
  return 'https://localhost:3000';
}
