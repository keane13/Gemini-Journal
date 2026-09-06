/**
 * @file app/api/admin/metrics/route.ts
 * FEATURE 7: Operational health for the blind admin console.
 *
 * Serves ONLY precomputed aggregates from /aggregates/{YYYY-MM-DD}, shaped through
 * small-cell suppression. This route has no code path that touches /users/**, and the
 * aggregate documents it reads contain counts only -- never entry text, titles, model
 * output, or raw uids.
 *
 * Aggregates are read with the ADMIN'S OWN ID token, so firestore.rules is what permits
 * the read (role == 'admin' on /aggregates). The same token is denied on /users/**,
 * which is exactly what the "Prove it" affordance demonstrates.
 */

import { NextRequest, NextResponse } from 'next/server';
import { adminErrorResponse, requireAdmin, writeAdminAudit } from '@/lib/server/admin';
import { buildFleetMetrics } from '@/lib/server/aggregates';
import { getDocument } from '@/lib/server/firestore-rest';
import { AggregateDocument } from '@/lib/server/metrics';

export const dynamic = 'force-dynamic';

const MAX_RANGE_DAYS = 90;

function dayRange(days: number): string[] {
  const out: string[] = [];
  const cursor = new Date();
  for (let i = 0; i < days; i++) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out.reverse();
}

export async function GET(req: NextRequest) {
  try {
    const admin = await requireAdmin(req);

    const requested = Number(new URL(req.url).searchParams.get('days') || '7');
    const days = Math.min(
      MAX_RANGE_DAYS,
      Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 7)
    );

    const wanted = dayRange(days);
    const docs: AggregateDocument[] = [];
    const missingDays: string[] = [];

    const fetched = await Promise.all(
      wanted.map(async (day) => ({
        day,
        doc: await getDocument(`aggregates/${day}`, admin.token),
      }))
    );

    for (const { day, doc } of fetched) {
      if (doc) {
        docs.push({ ...(doc as unknown as AggregateDocument), day });
      } else {
        missingDays.push(day);
      }
    }

    const metrics = buildFleetMetrics(docs, {
      start: wanted[0],
      end: wanted[wanted.length - 1],
      missingDays,
    });

    // Viewing fleet health is itself an audited administrative act.
    await writeAdminAudit(req, admin, {
      action: 'ADMIN_VIEW_METRICS',
      phase: 'OUTCOME',
      outcome: 'SUCCESS',
      detail: `days=${days}`,
    });

    return NextResponse.json({
      metrics,
      contract: {
        readsUserContent: false,
        source: '/aggregates/{day} (precomputed counts only)',
        suppressionRule: `cells backed by fewer than ${metrics.smallCellThreshold} distinct users are withheld`,
      },
    });
  } catch (err) {
    return adminErrorResponse(err);
  }
}
