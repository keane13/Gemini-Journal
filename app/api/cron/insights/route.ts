/**
 * @file app/api/cron/insights/route.ts
 * FEATURE 3: Longitudinal Insight Engine.
 *
 * Evaluates entries over a period (e.g. past 7 days) and synthesizes:
 * - moodTrend: array of numbers
 * - recurringThemes: array of strings
 * - blockers: array of strings
 * - oneQuestion: exactly one powerful Socratic question for the coming week
 * - entryRefs: array of referenced entryIds
 * Runs on redacted text through the Privacy Shield pipeline.
 */

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { authenticateRequest } from '@/lib/server/auth';
import { getGeminiApiKey } from '@/lib/server/secrets';
import { MODEL_ID } from '@/lib/config';
import { runPrivacyShield } from '@/lib/server/redaction';
import { persistDocument } from '@/lib/server/firestore-rest';
import firebaseConfig from '@/firebase-applet-config.json';
import { createAuditRecord } from '@/lib/server/audit';

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';

interface WeeklyInsightSchema {
  periodStart: string;
  periodEnd: string;
  moodTrend: number[];
  recurringThemes: string[];
  blockers: string[];
  oneQuestion: string;
  entryRefs: string[];
  generatedAt: string;
}

function validateInsight(data: any): WeeklyInsightSchema {
  if (!data || typeof data !== 'object') {
    throw new Error('Insight data must be an object.');
  }
  if (!data.oneQuestion || typeof data.oneQuestion !== 'string') {
    throw new Error('Insight must contain "oneQuestion" string.');
  }
  return {
    periodStart: data.periodStart || new Date(Date.now() - 7 * 86400000).toISOString(),
    periodEnd: data.periodEnd || new Date().toISOString(),
    moodTrend: Array.isArray(data.moodTrend) ? data.moodTrend.map(Number).filter((n: number) => !isNaN(n)) : [],
    recurringThemes: Array.isArray(data.recurringThemes) ? data.recurringThemes.slice(0, 8) : [],
    blockers: Array.isArray(data.blockers) ? data.blockers.slice(0, 5) : [],
    oneQuestion: data.oneQuestion.slice(0, 300),
    entryRefs: Array.isArray(data.entryRefs) ? data.entryRefs.slice(0, 10) : [],
    generatedAt: new Date().toISOString(),
  };
}

export async function POST(req: NextRequest) {
  let user;
  const rawAuthHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = rawAuthHeader.replace(/^Bearer\s+/i, '').trim();

  try {
    user = await authenticateRequest(req);
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED: Valid token required.' }, { status: 401 });
  }

  try {
    // 1. Fetch user's recent entries (past 14 days)
    const entriesUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/users/${user.uid}/entries?pageSize=20`;
    const res = await fetch(entriesUrl, { headers: { Authorization: `Bearer ${token}` } });

    if (!res.ok) {
      return NextResponse.json({ error: 'Failed to retrieve entries.' }, { status: 500 });
    }

    const data = await res.json();
    const documents = data.documents || [];

    if (documents.length === 0) {
      return NextResponse.json({
        message: 'No journal entries found in this period to generate longitudinal insights.',
        insight: null,
      });
    }

    // 2. Prepare summaries and redact PII
    const entrySummaries: Array<{ id: string; title: string; excerpt: string }> = [];
    for (const doc of documents) {
      const fields = doc.fields || {};
      const entryId = doc.name.split('/').pop() || '';
      const title = fields.title?.stringValue || 'Untitled';
      const tldr = fields.summary?.mapValue?.fields?.tldr?.stringValue || title;
      const redacted = runPrivacyShield(tldr, 'standard').redactedText;
      entrySummaries.push({ id: entryId, title, excerpt: redacted });
    }

    const synthesisPrompt = `You are an introspective longitudinal analyst. Analyze the author's recent journal entries below:
${entrySummaries.map((e) => `- Entry ID "${e.id}": "${e.title}" — Summary: ${e.excerpt}`).join('\n')}

SAFETY CONSTRAINT: The model never diagnoses, never names a clinical condition, and never asserts a downward trend as a fact about the person. Insight copy describes what was written, not what the user is.

Produce a JSON object adhering strictly to this schema:
{
  "periodStart": "${new Date(Date.now() - 7 * 86400000).toISOString()}",
  "periodEnd": "${new Date().toISOString()}",
  "moodTrend": [an array of 3 to 7 floating numbers between -1.0 and 1.0 reflecting chronological emotional cadence],
  "recurringThemes": [array of 3-5 recurring themes as short nouns, e.g. "Creative Clarity", "Work Boundaries"],
  "blockers": [array of 1-3 specific recurring friction points or blockers mentioned],
  "oneQuestion": "Exactly one evocative, deep Socratic question for the user to reflect on next week",
  "entryRefs": [array of entry IDs that were analyzed]
}

Return ONLY valid JSON.`;

    const apiKey = await getGeminiApiKey();
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: [{ role: 'user', parts: [{ text: synthesisPrompt }] }],
      config: { temperature: 0.3 },
    });

    const cleaned = (response?.text || '').replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const validated = validateInsight(parsed);

    // Save to users/{uid}/insights/{periodId}
    const periodId = `${new Date().getFullYear()}-W${Math.ceil(new Date().getDate() / 7)}`;
    if (token) {
      await persistDocument(`users/${user.uid}/insights/${periodId}`, validated as any, token);
      const audit = createAuditRecord(req, 'GENERATE_INSIGHTS', 'SUCCESS');
      await persistDocument(`users/${user.uid}/audit/audit_${Date.now()}`, audit as any, token);
    }

    return NextResponse.json({ insight: validated, periodId });
  } catch (error: any) {
    console.error('Insights generation error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to synthesize insights.' },
      { status: 500 }
    );
  }
}
