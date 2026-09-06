/**
 * @file lib/server/audit.ts
 * Cryptographic security audit helper.
 * Generates SHA-256 hashes of client IP and User-Agent; stores zero journal text content.
 */

import * as crypto from 'crypto';
import { NextRequest } from 'next/server';

export interface AuditRecord {
  type: string;
  at: string;
  ipHash: string;
  userAgentHash: string;
  outcome: 'SUCCESS' | 'RATE_LIMITED' | 'UNAUTHORIZED' | 'SAFETY_BLOCKED' | 'ERROR';
}

export function createAuditRecord(
  req: NextRequest,
  type: string,
  outcome: AuditRecord['outcome']
): AuditRecord {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    '127.0.0.1';

  const userAgent = req.headers.get('user-agent') || 'unknown';

  const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
  const userAgentHash = crypto.createHash('sha256').update(userAgent).digest('hex');

  return {
    type,
    at: new Date().toISOString(),
    ipHash,
    userAgentHash,
    outcome,
  };
}
