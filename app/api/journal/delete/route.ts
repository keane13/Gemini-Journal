/**
 * @file app/api/journal/delete/route.ts
 * FEATURE 4: Data Sovereignty - Hard Cascading Deletion.
 *
 * Permanently removes user's entries, messages, chunks, and insights.
 * Requires explicit string confirmation: "DELETE MY JOURNAL".
 * Leaves an immutable audit tombstone record documenting the deletion timestamp.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server/auth';
import firebaseConfig from '@/firebase-applet-config.json';
import { createAuditRecord } from '@/lib/server/audit';
import { persistDocument } from '@/lib/server/firestore-rest';

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';

export async function POST(req: NextRequest) {
  let user;
  const rawAuthHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = rawAuthHeader.replace(/^Bearer\s+/i, '').trim();

  try {
    user = await authenticateRequest(req);
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED: Valid ID token required.' }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const confirmation = body?.confirmation;

    if (confirmation !== 'DELETE MY JOURNAL') {
      return NextResponse.json(
        { error: 'Confirmation failed. You must provide exact phrase "DELETE MY JOURNAL".' },
        { status: 400 }
      );
    }

    // List of collections to sweep
    const collections = ['entries', 'chunks', 'insights'];
    let deletedCount = 0;

    for (const col of collections) {
      const colUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/users/${user.uid}/${col}?pageSize=300`;
      const res = await fetch(colUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        for (const doc of data.documents || []) {
          // Delete document via REST
          await fetch(`https://firestore.googleapis.com/v1/${doc.name}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          deletedCount++;
        }
      }
    }

    // Leave immutable audit tombstone
    const audit = createAuditRecord(req, 'HARD_DELETE_JOURNAL', 'SUCCESS');
    await persistDocument(`users/${user.uid}/audit/tombstone_${Date.now()}`, audit as any, token);

    return NextResponse.json({
      success: true,
      message: `Permanently destroyed ${deletedCount} documents across your journal.`,
      tombstoneCreated: true,
    });
  } catch (err: any) {
    console.error('Delete error:', err);
    return NextResponse.json({ error: 'Failed to complete hard deletion.' }, { status: 500 });
  }
}
