/**
 * @file app/api/journal/export/route.ts
 * FEATURE 4: Data Sovereignty - Complete Journal Export.
 *
 * Provides a one-click export of everything:
 * - Structured JSON archive with all entries, messages, and insights
 * - Human-readable Markdown document formatted for long-term personal preservation
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/server/auth';
import firebaseConfig from '@/firebase-applet-config.json';
import { createAuditRecord } from '@/lib/server/audit';
import { persistDocument } from '@/lib/server/firestore-rest';

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';

export async function GET(req: NextRequest) {
  let user;
  const rawAuthHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = rawAuthHeader.replace(/^Bearer\s+/i, '').trim();

  try {
    user = await authenticateRequest(req);
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED: Valid ID token required.' }, { status: 401 });
  }

  try {
    // 1. Fetch entries
    const entriesUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/users/${user.uid}/entries?pageSize=200`;
    const res = await fetch(entriesUrl, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    const rawEntries = data.documents || [];

    const entriesArchive: any[] = [];
    let markdownDocument = `# Personal Gemini Journal Archive\n**Export Date:** ${new Date().toISOString()}\n**User ID:** ${user.uid}\n\n---\n\n`;

    for (const doc of rawEntries) {
      const entryId = doc.name.split('/').pop();
      const fields = doc.fields || {};
      const title = fields.title?.stringValue || 'Untitled Entry';
      const createdAt = fields.createdAt?.stringValue || '';
      const mode = fields.mode?.stringValue || 'reflection';
      const summary = fields.summary?.mapValue?.fields?.tldr?.stringValue || '';

      // Fetch messages for entry
      const messagesUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/users/${user.uid}/entries/${entryId}/messages?pageSize=100`;
      const msgRes = await fetch(messagesUrl, { headers: { Authorization: `Bearer ${token}` } });
      const msgData = msgRes.ok ? await msgRes.json() : { documents: [] };

      const messages: any[] = [];
      for (const mDoc of msgData.documents || []) {
        const mFields = mDoc.fields || {};
        messages.push({
          role: mFields.role?.stringValue,
          content: mFields.content?.stringValue,
          createdAt: mFields.createdAt?.stringValue,
          modelId: mFields.modelId?.stringValue,
          promptVersion: mFields.promptVersion?.stringValue,
          redactionApplied: mFields.redactionApplied?.booleanValue,
        });
      }

      entriesArchive.push({
        entryId,
        title,
        mode,
        createdAt,
        summary,
        messages,
      });

      // Append to human-readable Markdown
      markdownDocument += `## ${title}\n*Date: ${createdAt} | Mode: ${mode}*\n\n`;
      if (summary) {
        markdownDocument += `> **Synthesis TL;DR:** ${summary}\n\n`;
      }
      for (const m of messages) {
        const speaker = m.role === 'user' ? '### Author' : '### Gemini Companion';
        markdownDocument += `${speaker} (${m.createdAt}):\n\n${m.content}\n\n---\n\n`;
      }
      markdownDocument += `\n`;
    }

    // Audit Event
    if (token) {
      const audit = createAuditRecord(req, 'DATA_EXPORT', 'SUCCESS');
      await persistDocument(`users/${user.uid}/audit/audit_${Date.now()}`, audit as any, token);
    }

    return NextResponse.json({
      exportedAt: new Date().toISOString(),
      entryCount: entriesArchive.length,
      jsonData: entriesArchive,
      markdownDocument,
    });
  } catch (err: any) {
    console.error('Export error:', err);
    return NextResponse.json({ error: 'Failed to generate archive.' }, { status: 500 });
  }
}
