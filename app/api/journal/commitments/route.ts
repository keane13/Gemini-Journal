/**
 * @file app/api/journal/commitments/route.ts
 * Feature 5: Commitments API.
 *
 * Handles fetching, resurfacing, marking done, and releasing self-stated first-person commitments.
 * Zero guilt language, neutral and factual.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server/auth';
import { listDocuments, persistDocument } from '@/lib/server/firestore-rest';
import { isCommitmentDueForResurface } from '@/lib/server/commitments';
import { Commitment } from '@/types/journal';

export async function GET(req: NextRequest) {
  let user;
  const rawAuthHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = rawAuthHeader.replace(/^Bearer\s+/i, '').trim();

  try {
    user = await authenticateRequest(req);
  } catch (err: any) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED: Valid Firebase ID token is required.', details: err?.message },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(req.url);
  const resurfaceOnly = searchParams.get('resurface') === 'true';

  try {
    const rawDocs = await listDocuments(`users/${user.uid}/commitments`, token, 100);

    const commitments: Commitment[] = rawDocs.map((doc) => ({
      id: doc.id,
      text: doc.text || '',
      sourceEntryId: doc.sourceEntryId || '',
      sourceMessageId: doc.sourceMessageId,
      statedAt: doc.statedAt || new Date().toISOString(),
      dueHint: doc.dueHint ?? null,
      status: doc.status || 'open',
      resurfacedCount: typeof doc.resurfacedCount === 'number' ? doc.resurfacedCount : 0,
      lastResurfacedAt: doc.lastResurfacedAt ?? null,
    }));

    if (resurfaceOnly) {
      // Filter open commitments past their dueHint or older than 14 days
      const candidates = commitments.filter((c) => isCommitmentDueForResurface(c));

      // Sort by statedAt ascending (oldest first) or due date
      candidates.sort((a, b) => new Date(a.statedAt).getTime() - new Date(b.statedAt).getTime());

      // Surface at most 3
      const toSurface = candidates.slice(0, 3);

      // Increment resurfacedCount & lastResurfacedAt in the background
      const nowIso = new Date().toISOString();
      for (const item of toSurface) {
        persistDocument(
          `users/${user.uid}/commitments/${item.id}`,
          {
            ...item,
            resurfacedCount: (item.resurfacedCount || 0) + 1,
            lastResurfacedAt: nowIso,
          },
          token
        ).catch((e) => console.warn('Failed updating resurfaced count:', e));
      }

      return NextResponse.json({ commitments: toSurface });
    }

    // Return all commitments (for dedicated viewer)
    commitments.sort((a, b) => new Date(b.statedAt).getTime() - new Date(a.statedAt).getTime());
    return NextResponse.json({ commitments });
  } catch (error: any) {
    console.error('Failed fetching commitments:', error);
    return NextResponse.json({ error: error?.message || 'Failed to fetch commitments.' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  let user;
  const rawAuthHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = rawAuthHeader.replace(/^Bearer\s+/i, '').trim();

  try {
    user = await authenticateRequest(req);
  } catch (err: any) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED: Valid Firebase ID token is required.', details: err?.message },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();
    const { commitmentId, status } = body;

    if (!commitmentId || typeof commitmentId !== 'string') {
      return NextResponse.json({ error: 'commitmentId is required.' }, { status: 400 });
    }

    if (status !== 'done' && status !== 'released') {
      return NextResponse.json(
        { error: 'Invalid status. Status can only be changed to "done" or "released".' },
        { status: 400 }
      );
    }

    const nowIso = new Date().toISOString();
    const ok = await persistDocument(
      `users/${user.uid}/commitments/${commitmentId}`,
      {
        status,
        updatedAt: nowIso,
      },
      token
    );

    if (!ok) {
      return NextResponse.json({ error: 'Failed to update commitment status in database.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, commitmentId, status });
  } catch (error: any) {
    console.error('Failed updating commitment:', error);
    return NextResponse.json({ error: error?.message || 'Failed to update commitment.' }, { status: 500 });
  }
}
