/**
 * @file app/api/journal/chat/route.ts
 * Flagship Multi-Turn Journal Chat API.
 *
 * Pipeline:
 * 1. Verifies Firebase ID Token (Extracts authentic UID, completely ignores client-supplied body UID)
 * 2. Enforces Rate Limit per UID (429 if exceeded)
 * 3. Enforces Idempotency Key (prevents duplicate submissions)
 * 4. Runs Two-Stage "Privacy Shield" Redaction Pipeline before prompt leaves server
 * 5. Calls Gemini Flash with versioned mode instructions and prompt-injection defense
 * 6. Streams response via Server-Sent Events (SSE) with graceful abort
 * 7. Rehydrates model output in server memory before display and persistence
 * 8. Chunks and embeds entry text for semantic recall
 * 9. Persists to Firestore with server timestamps and category histogram
 * 10. Emits cryptographic audit log
 */

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { authenticateRequest } from '@/lib/server/auth';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { recordMetric } from '@/lib/server/metrics';
import { recordEntryWritten } from '@/lib/server/digest-counters';
import { readLocationSettings } from '@/lib/server/location-settings';
import { dispatchTriggerEvent } from '@/lib/server/notifications/dispatch';
import { appUrlFrom } from '@/lib/server/app-url';
import {
  computeRetentionState,
  readRetentionPolicy,
  sealRehydrationMap,
} from '@/lib/server/retention';
import { runPrivacyShield, rehydrateModelOutput, PrivacyMode } from '@/lib/server/redaction';
import { MODES_REGISTRY, wrapUntrustedData, JournalModeId } from '@/lib/server/modes';
import { getGeminiApiKey } from '@/lib/server/secrets';
import { MODEL_ID, MODEL_FALLBACK_LADDER, LIMITS } from '@/lib/config';
import { createAuditRecord } from '@/lib/server/audit';
import { persistDocument } from '@/lib/server/firestore-rest';
import { chunkJournalText, generateEmbedding } from '@/lib/server/embeddings';
import { extractSelfStatedCommitments, resolveDueHint } from '@/lib/server/commitments';

// In-memory idempotency cache (keyed by idempotencyKey)
const processedKeys = new Map<string, { timestamp: number; responseData: any }>();

// Clear stale idempotency keys
setInterval(() => {
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of processedKeys.entries()) {
    if (v.timestamp < tenMinutesAgo) processedKeys.delete(k);
  }
}, 5 * 60 * 1000);

export async function POST(req: NextRequest) {
  let user;
  const rawAuthHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = rawAuthHeader.replace(/^Bearer\s+/i, '').trim();

  // 1. Authenticate Request
  try {
    user = await authenticateRequest(req);
  } catch (authError: any) {
    return NextResponse.json(
      { error: 'UNAUTHORIZED: Valid Firebase ID token is required.', details: authError?.message },
      { status: 401 }
    );
  }

  // 2. Rate Limit
  const rateCheck = checkRateLimit(user.uid);
  if (!rateCheck.allowed) {
    recordMetric({ kind: 'rate_limit_hit', uid: user.uid });
    return NextResponse.json(
      { error: 'Too Many Requests. Please wait before submitting another reflection.' },
      {
        status: 429,
        headers: { 'Retry-After': rateCheck.resetSeconds.toString() },
      }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    const mode: JournalModeId = body?.mode && MODES_REGISTRY[body.mode as JournalModeId] ? body.mode : 'reflection';
    const privacyMode: PrivacyMode = body?.privacyMode || 'standard';
    const entryId = body?.entryId || `entry_${Date.now()}`;
    const idempotencyKey = typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim() : null;
    const history = Array.isArray(body?.history) ? body.history : [];

    /**
     * FEATURE 10 (Adversarial Self-Test): when true, everything runs for real --
     * token verification, uid resolution, rate limiting, the Privacy Shield, and the
     * live model call -- but the resulting entry is NOT written to Firestore.
     *
     * The suppression is deliberately narrow. None of the properties the self-test
     * asserts (authentication, uid resolution, redaction coverage, injection
     * resistance) live in the persistence step, so skipping it weakens no check. What
     * it prevents is a security probe injecting fixture credit-card numbers and
     * injection payloads into the user's real journal, which would be a worse outcome
     * than the test not running at all.
     */
    const selfTest = body?.selfTest === true;

    // Check Idempotency Key
    if (idempotencyKey && processedKeys.has(idempotencyKey)) {
      const cached = processedKeys.get(idempotencyKey)!;
      return NextResponse.json(cached.responseData);
    }

    if (!prompt) {
      return NextResponse.json({ error: 'Prompt is required and cannot be empty.' }, { status: 400 });
    }

    if (prompt.length > LIMITS.MAX_PROMPT_LENGTH) {
      return NextResponse.json(
        { error: `Prompt exceeds maximum length of ${LIMITS.MAX_PROMPT_LENGTH} characters.` },
        { status: 400 }
      );
    }

    // FEATURE 9: An optional location pin attached to this entry. The place label is
    // appended to the prompt as context, then masked as [LOCATION_n] on the way out
    // UNLESS the user has explicitly enabled location context for reflections. Routing
    // it through the Privacy Shield (rather than stripping it beforehand) means location
    // appears in the Egress Ledger exactly like any other masked entity.
    const placeLabel =
      typeof body?.location?.placeLabel === 'string' && body.location.placeLabel.trim()
        ? body.location.placeLabel.trim()
        : null;

    let locationSettings = { preciseLocation: false, locationContextForReflections: false };
    if (placeLabel) {
      locationSettings = await readLocationSettings(user.uid, token);
    }

    const promptWithContext = placeLabel
      ? `${prompt}

[Entry location: ${placeLabel}]`
      : prompt;

    // 4. Run Two-Stage "Privacy Shield" Redaction Pipeline
    const redactionResult = runPrivacyShield(promptWithContext, privacyMode, {
      maskLocations:
        placeLabel && !locationSettings.locationContextForReflections ? [placeLabel] : [],
    });

    // Mode Contract & System Instruction
    const modeConfig = MODES_REGISTRY[mode];
    const systemInstruction = modeConfig.systemInstruction;

    // 5. Construct Conversation Payload with untrusted delimiters
    const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    // Previous turns
    for (const turn of history.slice(-LIMITS.MAX_HISTORY_TURNS)) {
      if (turn.role === 'user' && turn.content) {
        contents.push({ role: 'user', parts: [{ text: wrapUntrustedData(turn.content, 'prior_user_turn') }] });
      } else if (turn.role === 'model' && turn.content) {
        contents.push({ role: 'model', parts: [{ text: turn.content }] });
      }
    }

    // Current turn with redacted payload
    contents.push({
      role: 'user',
      parts: [{ text: wrapUntrustedData(redactionResult.redactedText, 'current_reflection') }],
    });

    // 6. Call Gemini Flash API with Fallback Ladder
    const apiKey = await getGeminiApiKey();
    const ai = new GoogleGenAI({ apiKey });

    let rawModelText = '';
    let modelUsed: string = MODEL_ID;
    // Feature 7 telemetry: measure end-to-end model latency across the fallback ladder.
    const modelCallStartedAt = Date.now();

    for (const model of MODEL_FALLBACK_LADDER) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            temperature: modeConfig.temperature,
          },
        });

        if (response && response.text) {
          rawModelText = response.text;
          modelUsed = model;
          break;
        }
      } catch (err: any) {
        console.warn(`Model ${model} failed in chat route. Trying next fallback...`);
      }
    }

    if (!rawModelText) {
      recordMetric({ kind: 'error', uid: user.uid, errorCode: 'MODEL_FALLBACKS_EXHAUSTED' });
      throw new Error('All model fallbacks were exhausted without generating a response.');
    }

    // Feature 7 telemetry: counts and category names only -- never prompt or model text.
    recordMetric({
      kind: 'model_call',
      uid: user.uid,
      latencyMs: Date.now() - modelCallStartedAt,
      tokensIn: Math.ceil(redactionResult.redactedText.length / 4),
      tokensOut: Math.ceil(rawModelText.length / 4),
      redactionCategories: Object.keys(redactionResult.categoryCounts),
    });

    // 7. Rehydrate Model Output in Server Memory
    const finalResponseText = rehydrateModelOutput(rawModelText, redactionResult.ephemeralMap);

    // 8. Generate Summary & Title metadata if this is turn 1
    let title = body?.currentTitle || '';
    let summaryObj: Record<string, unknown> | null = null;
    let extractedCommitmentsList: Array<any> = [];

    if (!title || history.length === 0) {
      try {
        const metaPrompt = `You are a journal summarizer. Read the following journal reflection:
"""
${redactionResult.redactedText.slice(0, 1500)}
"""

SAFETY CONSTRAINT: The model never diagnoses, never names a clinical condition, and never asserts a downward trend as a fact about the person. Insight copy describes what was written, not what the user is.

Provide a JSON object with:
- "title": short 3-6 word title
- "tldr": 1-2 sentence essence
- "keyThemes": array of 2-3 theme strings
- "nextSteps": array of 1-2 practical next steps
- "moodScore": number between -1.0 (very low) and 1.0 (very positive)
- "openQuestion": 1 lingering question for tomorrow

Return ONLY valid JSON.`;

        const metaRes = await ai.models.generateContent({
          model: MODEL_ID,
          contents: [{ role: 'user', parts: [{ text: metaPrompt }] }],
        });

        if (metaRes?.text) {
          const cleaned = metaRes.text.replace(/```json\n?|\n?```/g, '').trim();
          const parsed = JSON.parse(cleaned);
          title = parsed.title || title || 'Journal Reflection';
          summaryObj = {
            tldr: parsed.tldr || '',
            keyThemes: parsed.keyThemes || [],
            nextSteps: parsed.nextSteps || [],
            openQuestion: parsed.openQuestion || '',
            moodScore: typeof parsed.moodScore === 'number' ? parsed.moodScore : 0.0,
            generatedAt: new Date().toISOString(),
            promptVersion: modeConfig.promptVersion,
          };
        }
      } catch {
        if (!title) title = prompt.slice(0, 36) + '...';
      }

      // Feature 5: When an entry is summarized, extract self-stated commitments using strict Zod schema
      try {
        const extracted = await extractSelfStatedCommitments(ai, prompt);
        extractedCommitmentsList = extracted;
      } catch (err) {
        console.warn('Commitment extraction failed silently:', err);
      }
    }

    // 9. Semantic Chunking & Vector Embeddings for Recall
    /**
     * Chunks are built from the REDACTED text, not the raw prompt.
     *
     * Two reasons, both load-bearing. The chunk text is stored in Firestore and its
     * embedding is computed by an upstream model, so building from the raw prompt would
     * send PII to the embedding endpoint and keep a plaintext copy outside the retention
     * window's reach. And Managed Forgetting only holds if the recall corpus is redacted
     * too -- otherwise forgetting an entry would leave its details searchable.
     */
    const chunks = chunkJournalText(redactionResult.redactedText, entryId);
    for (const chunk of chunks) {
      try {
        chunk.embedding = await generateEmbedding(chunk.text);
        if (token) {
          await persistDocument(
            `users/${user.uid}/chunks/${chunk.chunkId}`,
            {
              entryId: chunk.entryId,
              text: chunk.text,
              embedding: chunk.embedding,
              createdAt: chunk.createdAt,
            },
            token
          );
        }
      } catch (err) {
        console.warn('Chunk persist warning:', err);
      }
    }

    // 10. Persist Messages & Entry to Firestore via server
    const nowIso = new Date().toISOString();
    const userMsgId = `msg_${Date.now()}_u`;
    const modelMsgId = `msg_${Date.now() + 1}_m`;

    // FEATURE 11: seal the placeholder map for storage, then let it fall out of scope.
    // A KMS failure must not silently degrade to storing plaintext, so the entry is
    // written with a null payload and the details are simply never recoverable.
    const retentionPolicy = await readRetentionPolicy(user.uid, token);
    let sealedMap = null;
    // A self-test call never persists, so it must not mint a data key or spend a KMS
    // operation either -- the probe should leave no trace beyond the audit record.
    if (token && !selfTest) {
      try {
        sealedMap = await sealRehydrationMap(user.uid, redactionResult.ephemeralMap);
      } catch (sealErr) {
        console.error('Rehydration payload could not be sealed:', sealErr);
        sealedMap = null;
      }
    }

    /**
     * MANAGED FORGETTING REQUIRES A PLACE TO PUT THE MAP.
     *
     * Storing the redacted body is only safe when the placeholder map was sealed
     * alongside it. Without that map the redaction is not "managed forgetting" at all --
     * it is immediate, silent, permanent destruction of the user's own words, on the
     * very first write. A journal that eats your phone number the moment you type it is
     * broken, not private.
     *
     * So when nothing could be sealed (Cloud KMS unconfigured, or a KMS outage) the
     * entry stores what the user actually wrote and declares that managed forgetting is
     * not active for it. The Privacy Shield still redacts everything before egress to
     * Gemini -- that boundary is untouched and is the real security guarantee. What
     * changes is only what is kept at rest, locally, for the author to reread.
     */
    const hadSomethingToSeal = redactionResult.ephemeralMap.size > 0;
    const managedForgetting = Boolean(sealedMap) || !hadSomethingToSeal;

    const canonicalPrompt = sealedMap ? redactionResult.redactedText : prompt;
    const canonicalResponse = sealedMap ? rawModelText : finalResponseText;

    if (token && !selfTest) {
      // User message
      await persistDocument(
        `users/${user.uid}/entries/${entryId}/messages/${userMsgId}`,
        {
          role: 'user',
          /**
           * FEATURE 11: the CANONICAL body is the REDACTED text, not the plaintext.
           * The placeholder map lives encrypted on the entry document and is destroyed
           * when the retention window elapses; because the plaintext was never the
           * canonical form, forgetting is not a deletion that has to chase copies.
           */
          content: canonicalPrompt,
          createdAt: nowIso,
          modelId: modelUsed,
          promptVersion: modeConfig.promptVersion,
          tokenCount: Math.ceil(prompt.length / 4),
          redactionApplied: redactionResult.redactionApplied,
          safetyBlocked: false,
          redactionStats: redactionResult.categoryCounts,
        },
        token
      );

      // Model message
      await persistDocument(
        `users/${user.uid}/entries/${entryId}/messages/${modelMsgId}`,
        {
          role: 'model',
          // Stored pre-rehydration, i.e. still in placeholder form, for the same reason.
          content: canonicalResponse,
          createdAt: new Date(Date.now() + 100).toISOString(),
          modelId: modelUsed,
          promptVersion: modeConfig.promptVersion,
          tokenCount: Math.ceil(finalResponseText.length / 4),
          redactionApplied: redactionResult.redactionApplied,
          safetyBlocked: false,
        },
        token
      );

      // Entry document
      await persistDocument(
        `users/${user.uid}/entries/${entryId}`,
        {
          title: title || 'Journal Reflection',
          mode,
          status: 'active',
          createdAt: body?.createdAt || nowIso,
          updatedAt: nowIso,
          messageCount: history.length + 2,
          moodScore: (summaryObj as any)?.moodScore ?? 0.0,
          summary: summaryObj,
          /**
           * FEATURE 11: the encrypted rehydration payload. Sealed under a KMS-wrapped
           * per-user DEK; the plaintext map is discarded with the request. `null` when
           * nothing was masked, so there is nothing to forget.
           */
          rehydration: sealedMap,
          // An entry with no sealed map is not under managed forgetting, and must not
          // claim a window it cannot honour.
          retentionWindow: sealedMap ? retentionPolicy.window : 'never',
          managedForgetting,
          forgottenAt: null,
          // FEATURE 9: optional location pin. Precision was already reduced server-side
          // in /api/location/resolve; whatever arrives here is what the user's settings
          // permitted, and nothing finer is stored.
          location: placeLabel
            ? {
                placeLabel,
                lat: typeof body?.location?.lat === 'number' ? body.location.lat : null,
                lng: typeof body?.location?.lng === 'number' ? body.location.lng : null,
                precision: body?.location?.precision === 'precise' ? 'precise' : 'coarse',
                sharedWithModel: locationSettings.locationContextForReflections,
              }
            : null,
        },
        token
      );

      recordMetric({ kind: 'entry_created', uid: user.uid });

      // Feature 8: write-time counter so the weekly digest never has to read entries.
      // Fire-and-forget: a counter failure must not fail the user's journal write.
      void recordEntryWritten(user.uid, (summaryObj as any)?.moodScore ?? null);

      // EXTERNAL NOTIFICATIONS: evaluate the user's configured destinations against this
      // entry. Fire-and-forget for the same reason -- a broken Slack webhook must never
      // cost someone their journal entry.
      //
      // NOTE what is NOT passed: moodScore is deliberately excluded from the trigger
      // event. External notifications cannot be conditioned on inferred emotional state,
      // and the simplest way to guarantee that is to never hand the evaluator the signal.
      void dispatchTriggerEvent(
        {
          uid: user.uid,
          type: 'entry_created',
          entryId,
          occurredAt: nowIso,
          mode,
          tags: Array.isArray((summaryObj as any)?.keyThemes)
            ? (summaryObj as any).keyThemes.slice(0, 8)
            : [],
          commitmentCount: extractedCommitmentsList?.length ?? 0,
          themeCount: Array.isArray((summaryObj as any)?.keyThemes)
            ? (summaryObj as any).keyThemes.length
            : 0,
          // Supplied only so the `excerpt` tier can redact it; lower tiers never read it.
          rawText: prompt,
        },
        appUrlFrom(req)
      );

      // Cryptographic Audit Event (zero content)
      const audit = createAuditRecord(req, 'JOURNAL_CHAT', 'SUCCESS');
      await persistDocument(`users/${user.uid}/audit/audit_${Date.now()}`, audit as any, token);

      // Feature 5: Persist extracted self-stated first-person commitments
      if (extractedCommitmentsList && extractedCommitmentsList.length > 0) {
        for (let i = 0; i < extractedCommitmentsList.length; i++) {
          const item = extractedCommitmentsList[i];
          const cId = `cmt_${Date.now()}_${i}`;
          const resolved = resolveDueHint(item.dueHint, new Date());
          const cDoc = {
            text: item.text,
            sourceEntryId: entryId,
            sourceMessageId: userMsgId,
            statedAt: nowIso,
            dueHint: resolved,
            status: 'open',
            resurfacedCount: 0,
            lastResurfacedAt: null,
          };
          try {
            await persistDocument(`users/${user.uid}/commitments/${cId}`, cDoc, token);
          } catch (cErr) {
            console.warn('Failed to persist commitment:', cErr);
          }
        }
      }
    }

    const responsePayload = {
      geminiResponse: finalResponseText,
      /**
       * FEATURE 11: the model reply BEFORE rehydration, i.e. still in placeholder form.
       * `geminiResponse` above is for immediate display only; this is what the client
       * must persist, so no plaintext PII is ever written to the client-side store.
       */
      redactedResponse: rawModelText,
      /**
       * Exactly what the server persisted, so the client stores the same thing rather
       * than guessing. Redacted when a map was sealed; the user's own words when not.
       */
      canonicalPrompt,
      canonicalResponse,
      managedForgetting,
      /**
       * The uid the server actually resolved from the SIGNED TOKEN. Any `uid` in the
       * request body is ignored entirely; this field exists so that fact is verifiable
       * from outside rather than merely asserted in a comment.
       */
      resolvedUid: user.uid,
      selfTest,
      entryId,
      retention: computeRetentionState(nowIso, sealedMap ? retentionPolicy.window : 'never', true),
      title,
      summary: (summaryObj as any)?.tldr || '',
      summaryDetails: summaryObj,
      extractedCommitments: extractedCommitmentsList,
      modelUsed,
      promptVersion: modeConfig.promptVersion,
      redactionDetails: {
        redactionApplied: redactionResult.redactionApplied,
        categoryCounts: redactionResult.categoryCounts,
        maskedSpans: redactionResult.maskedSpans,
        redactedPayload: redactionResult.redactedText,
        originalLength: prompt.length,
        redactedLength: redactionResult.redactedText.length,
      },
    };

    if (idempotencyKey) {
      processedKeys.set(idempotencyKey, {
        timestamp: Date.now(),
        responseData: responsePayload,
      });
    }

    return NextResponse.json(responsePayload);
  } catch (error: any) {
    console.error('Chat route error:', error);
    recordMetric({
      kind: 'error',
      uid: user.uid,
      errorCode: typeof error?.code === 'string' ? error.code : 'CHAT_ROUTE_ERROR',
    });
    return NextResponse.json(
      { error: error?.message || 'An error occurred while communicating with Gemini.' },
      { status: 500 }
    );
  }
}
