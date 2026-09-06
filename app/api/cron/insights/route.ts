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
import { recordThemeCount } from '@/lib/server/digest-counters';
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
    /**
     * 1. Fetch the user's recent entries.
     *
     * `entries` is the authoritative store: it is what the server writes on every
     * reflection. `interactions` is the older client-side store, still written by the
     * browser, and this route used to read ONLY that -- which is why it failed for an
     * account whose entries were all written server-side. Read the real store first and
     * fall back, so both old and new accounts work.
     */
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/users/${user.uid}`;

    async function loadFrom(collection: string) {
      const r = await fetch(`${base}/${collection}?pageSize=20`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { ok: r.ok, status: r.status, body: await r.text(), collection };
    }

    const attempts: Array<{ collection: string; status: number; ok: boolean }> = [];
    let res = await loadFrom('entries');
    attempts.push({ collection: 'entries', status: res.status, ok: res.ok });
    let docs: any[] = [];

    if (res.ok) {
      try {
        docs = JSON.parse(res.body).documents ?? [];
      } catch {
        docs = [];
      }
    }

    // Nothing in the authoritative store: try the legacy one before giving up.
    if (docs.length === 0) {
      const legacy = await loadFrom('interactions');
      attempts.push({ collection: 'interactions', status: legacy.status, ok: legacy.ok });
      if (legacy.ok) {
        try {
          docs = JSON.parse(legacy.body).documents ?? [];
        } catch {
          docs = [];
        }
      }
      // Only surface an error if BOTH reads were refused.
      if (!res.ok && !legacy.ok) res = legacy;
      else if (!res.ok) res = { ...legacy, ok: true };
    }

    if (!res.ok) {
      const errText = res.body;
      console.error('Firestore API error:', errText);

      /**
       * Surface what Firestore actually said.
       *
       * "Failed to retrieve entries." told the user nothing and buried the real cause in
       * a server console they cannot see. This is the caller's own data and their own
       * error, so there is nothing to protect by hiding it -- and a diagnosable message
       * is worth far more than a tidy one.
       */
      let status: string | null = null;
      let detail: string | null = null;
      try {
        const parsed = JSON.parse(errText);
        status = parsed?.error?.status ?? null;
        detail = parsed?.error?.message ?? null;
      } catch {
        detail = errText.slice(0, 300);
      }

      /**
       * Name every collection that was tried and what each returned.
       *
       * The previous message hardcoded "/users/{uid}/interactions" even after the route
       * started reading `entries` first. It stayed plausible while being wrong, which
       * cost real debugging time. An error that names its own inputs cannot mislead
       * that way, and it also makes it obvious whether a deploy actually landed.
       */
      const tried = attempts
        .map((a) => `${a.collection}=HTTP ${a.status}`)
        .join(', ');

      const allDenied = attempts.every((a) => a.status === 403);
      const hint = allDenied
        ? 'Every collection was refused, which points at the security rules rather than ' +
          'at any one collection. Confirm the rules are PUBLISHED on database ' +
          `"${databaseId}" — a named database, not (default).`
        : 'See the dev-server console for the full Firestore response.';

      return NextResponse.json(
        {
          error: 'FIRESTORE_READ_FAILED',
          message: `Could not read your entries. Tried: ${tried}. ${hint}`,
          attempts,
          buildMarker: 'insights-v2-entries-first',
          firestoreStatus: status,
          firestoreMessage: detail,
        },
        { status: 502 }
      );
    }

    const documents = docs;

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

      // Feature 8: record only HOW MANY themes surfaced, never the theme names, so the
      // weekly digest can report a count without the digest path reading insights.
      void recordThemeCount(user.uid, validated.recurringThemes.length);
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
