/**
 * @file app/api/journal/recall/route.ts
 * FEATURE 2: "Ask Your Past Self" Grounded Semantic Recall.
 *
 * Flow:
 * 1. Verifies Firebase ID Token -> authentic UID
 * 2. Generates query vector embedding
 * 3. Retrieves chunks strictly from users/{uid}/chunks (cross-user retrieval structurally impossible)
 * 4. Ranks chunks by cosine similarity
 * 5. If top score < SIMILARITY_FLOOR: returns explicit non-hallucinatory message
 * 6. Prompts Gemini with <untrusted_journal_data> delimiters and requires inline citations
 * 7. Returns grounded answer with deep-linkable citations
 */

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { authenticateRequest } from '@/lib/server/auth';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { getGeminiApiKey } from '@/lib/server/secrets';
import { MODEL_ID, LIMITS } from '@/lib/config';
import { MODES_REGISTRY, wrapUntrustedData } from '@/lib/server/modes';
import { generateEmbedding, cosineSimilarity, ScoredChunk } from '@/lib/server/embeddings';
import firebaseConfig from '@/firebase-applet-config.json';
import { createAuditRecord } from '@/lib/server/audit';
import { runPrivacyShield, rehydrateModelOutput, PrivacyMode } from '@/lib/server/redaction';
import { persistDocument } from '@/lib/server/firestore-rest';

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';

export async function POST(req: NextRequest) {
  let user;
  const rawAuthHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = rawAuthHeader.replace(/^Bearer\s+/i, '').trim();

  // 1. Authenticate Request
  try {
    user = await authenticateRequest(req);
  } catch (authErr: any) {
    return NextResponse.json({ error: 'UNAUTHORIZED: Valid ID token required.' }, { status: 401 });
  }

  // 2. Rate Limit
  const rate = checkRateLimit(user.uid);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please wait a moment.' },
      { status: 429, headers: { 'Retry-After': rate.resetSeconds.toString() } }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const query = typeof body?.query === 'string' ? body.query.trim() : '';

    if (!query) {
      return NextResponse.json({ error: 'Recall query cannot be empty.' }, { status: 400 });
    }

    /**
     * The recall query is user-written text that leaves this server twice: once to the
     * embedding endpoint and once to Gemini. It must therefore cross the SAME Privacy
     * Shield boundary as a journal entry.
     *
     * This was previously missing: a query like "what did I discuss with budi@x.com?"
     * reached both models verbatim, contradicting the egress guarantee the rest of the
     * system upholds.
     */
    const privacyMode: PrivacyMode = body?.privacyMode || 'standard';
    const shieldedQuery = runPrivacyShield(query, privacyMode);

    // 3. Generate query embedding from the redacted form.
    const queryVector = await generateEmbedding(shieldedQuery.redactedText);

    // 4. Retrieve user's own chunks from Firestore REST API
    // Structurally scoped to users/{uid}/chunks - cannot access any other user
    const chunksUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/users/${user.uid}/chunks?pageSize=100`;
    const chunksRes = await fetch(chunksUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const scoredChunks: ScoredChunk[] = [];

    if (chunksRes.ok) {
      const chunksData = await chunksRes.json();
      const documents = chunksData.documents || [];

      for (const doc of documents) {
        const fields = doc.fields || {};
        const text = fields.text?.stringValue || '';
        const entryId = fields.entryId?.stringValue || '';
        const chunkId = doc.name.split('/').pop() || '';
        const embeddingValues: number[] =
          fields.embedding?.arrayValue?.values?.map((v: any) =>
            v.doubleValue !== undefined ? Number(v.doubleValue) : Number(v.integerValue || 0)
          ) || [];

        if (embeddingValues.length > 0) {
          const score = cosineSimilarity(queryVector, embeddingValues);
          if (score >= LIMITS.SIMILARITY_FLOOR) {
            scoredChunks.push({
              chunkId,
              entryId,
              text,
              score,
              createdAt: fields.createdAt?.stringValue || '',
            });
          }
        }
      }
    }

    // 5. Zero-Hallucination Policy: if no chunks above floor, respond with explicit boundary
    if (scoredChunks.length === 0) {
      return NextResponse.json({
        answer: 'I searched your past journal entries, but found no relevant reflections on this topic.',
        grounded: false,
        citations: [],
      });
    }

    // Sort descending by score and pick top N
    scoredChunks.sort((a, b) => b.score - a.score);
    const topChunks = scoredChunks.slice(0, LIMITS.MAX_RECALL_CITATIONS);

    // 6. Format untrusted context blocks
    const contextBlocks = topChunks
      .map(
        (c, idx) =>
          `[Excerpt ${idx + 1} from Entry "${c.entryId}"] (Similarity: ${(c.score * 100).toFixed(1)}%):\n"${c.text}"`
      )
      .join('\n\n');

    const promptText = `User Question: "${shieldedQuery.redactedText}"\n\nRetrieved Historical Journal Excerpts:\n${wrapUntrustedData(contextBlocks, 'historical_chunks')}\n\nPlease answer the user question grounded solely on these excerpts, citing [Entry: <entryId>] inline.`;

    const apiKey = await getGeminiApiKey();
    const ai = new GoogleGenAI({ apiKey });
    const modeConfig = MODES_REGISTRY.recall;

    const response = await ai.models.generateContent({
      model: MODEL_ID,
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      config: {
        systemInstruction: modeConfig.systemInstruction,
        temperature: modeConfig.temperature,
      },
    });

    // Rehydrated in server memory so the user reads their own terms back; the map is
    // discarded with the request and never persisted.
    const rawAnswer = response?.text || 'Unable to generate recall response.';
    const answer = rehydrateModelOutput(rawAnswer, shieldedQuery.ephemeralMap);

    // Audit Event
    if (token) {
      const audit = createAuditRecord(req, 'JOURNAL_RECALL', 'SUCCESS');
      await persistDocument(`users/${user.uid}/audit/audit_${Date.now()}`, audit as any, token);
    }

    return NextResponse.json({
      answer,
      // What the client should persist: redacted, like every other write path.
      canonicalQuery: shieldedQuery.redactedText,
      canonicalAnswer: rawAnswer,
      redactionDetails: {
        redactionApplied: shieldedQuery.redactionApplied,
        categoryCounts: shieldedQuery.categoryCounts,
        maskedSpans: shieldedQuery.maskedSpans,
        redactedPayload: shieldedQuery.redactedText,
        originalLength: query.length,
        redactedLength: shieldedQuery.redactedText.length,
      },
      grounded: true,
      citations: topChunks.map((c) => ({
        entryId: c.entryId,
        chunkId: c.chunkId,
        snippet: c.text.slice(0, 160) + (c.text.length > 160 ? '...' : ''),
        score: Math.round(c.score * 100) / 100,
      })),
    });
  } catch (error: any) {
    console.error('Recall route error:', error);
    return NextResponse.json(
      { error: error?.message || 'Error processing recall inquiry.' },
      { status: 500 }
    );
  }
}
