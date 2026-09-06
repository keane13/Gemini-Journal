/**
 * @file app/api/gemini/reflect/route.ts
 * Proxies legacy reflect requests to the secure /api/journal/chat pipeline.
 */

import { NextRequest } from 'next/server';
import { POST as chatHandler } from '@/app/api/journal/chat/route';

export async function POST(req: NextRequest) {
  return chatHandler(req);
}
