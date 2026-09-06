/**
 * @file lib/server/commitments.ts
 * Feature 5: Self-Stated First-Person Commitments Extraction & Lifecycle.
 *
 * Strictly captures only first-person commitments the user explicitly stated in their journal.
 * Validates extraction using a strict Zod schema. Never invents tasks.
 */

import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import { MODEL_ID } from '@/lib/config';

export const RawExtractedCommitmentSchema = z.object({
  text: z.string().min(3).max(500),
  dueHint: z.string().nullable().optional(),
});

export const CommitmentExtractionResponseSchema = z.object({
  commitments: z.array(RawExtractedCommitmentSchema),
});

export type ExtractedCommitment = z.infer<typeof RawExtractedCommitmentSchema>;

/**
 * Server-side helper to resolve natural language relative time hints into a date/range string.
 * Example: "tomorrow" -> "2026-09-06 (tomorrow)", "next week" -> "2026-09-12 (next week)"
 */
export function resolveDueHint(hint: string | null | undefined, baseDate: Date = new Date()): string | null {
  if (!hint || typeof hint !== 'string') return null;
  const trimmed = hint.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  const dayMs = 24 * 60 * 60 * 1000;

  try {
    if (lower.includes('tomorrow')) {
      const d = new Date(baseDate.getTime() + dayMs);
      return `${d.toISOString().split('T')[0]} (tomorrow)`;
    }
    if (lower.includes('in 2 days') || lower.includes('in two days')) {
      const d = new Date(baseDate.getTime() + 2 * dayMs);
      return `${d.toISOString().split('T')[0]} (in 2 days)`;
    }
    if (lower.includes('in 3 days') || lower.includes('in three days')) {
      const d = new Date(baseDate.getTime() + 3 * dayMs);
      return `${d.toISOString().split('T')[0]} (in 3 days)`;
    }
    if (lower.includes('next week') || lower.includes('by next week')) {
      const d = new Date(baseDate.getTime() + 7 * dayMs);
      return `${d.toISOString().split('T')[0]} (next week)`;
    }
    if (lower.includes('end of the week') || lower.includes('end of week')) {
      const day = baseDate.getDay();
      const diff = (5 - day + 7) % 7 || 7;
      const d = new Date(baseDate.getTime() + diff * dayMs);
      return `${d.toISOString().split('T')[0]} (end of week)`;
    }
    if (lower.includes('this weekend')) {
      const day = baseDate.getDay();
      const diff = (6 - day + 7) % 7 || 7;
      const d = new Date(baseDate.getTime() + diff * dayMs);
      return `${d.toISOString().split('T')[0]} (this weekend)`;
    }
    if (lower.includes('in a month') || lower.includes('next month')) {
      const d = new Date(baseDate.getTime() + 30 * dayMs);
      return `${d.toISOString().split('T')[0]} (next month)`;
    }
    // Return the cleaned natural string if it has specific phrasing
    return trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Checks whether an open commitment qualifies for resurfacing:
 * - Status is 'open'
 * - Past its dueHint (if dueHint contains an ISO date that has passed)
 * - OR older than 14 days with no recent mention
 */
export function isCommitmentDueForResurface(
  commitment: {
    statedAt: string;
    dueHint: string | null;
    status: string;
  },
  now: Date = new Date()
): boolean {
  if (commitment.status !== 'open') return false;

  const nowTime = now.getTime();
  const statedTime = new Date(commitment.statedAt).getTime();
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;

  // Rule 1: Older than 14 days
  if (!isNaN(statedTime) && nowTime - statedTime >= fourteenDaysMs) {
    return true;
  }

  // Rule 2: Past dueHint if it contains a parseable date prefix (e.g. YYYY-MM-DD)
  if (commitment.dueHint) {
    const match = commitment.dueHint.match(/(\d{4}-\d{2}-\d{2})/);
    if (match) {
      const dueDate = new Date(match[1]);
      if (!isNaN(dueDate.getTime()) && nowTime >= dueDate.getTime()) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Calls Gemini to extract self-stated first-person commitments strictly.
 * Uses Zod schema validation. If none exist, returns empty array. Never invents tasks.
 */
export async function extractSelfStatedCommitments(
  ai: GoogleGenAI,
  entryText: string
): Promise<ExtractedCommitment[]> {
  if (!entryText || entryText.trim().length < 15) return [];

  const prompt = `You are a literal, zero-assumption extractor of first-person self-stated commitments from personal journal entries.

CRITICAL CONSTRAINTS:
1. ONLY capture commitments where the author explicitly states what they personally intend or promise to do in the first-person (e.g. "I will call my doctor", "I am going to take a 20-minute walk daily", "I promise myself to finish the draft by Friday").
2. NEVER invent tasks, habits, suggestions, recommendations, or to-dos.
3. If the author is merely reflecting, venting, expressing a wish ("I wish I was happier"), or brainstorming without an explicit commitment, you MUST return an empty array [].
4. Extraction schema requires "text" (the author's self-stated commitment in concise first-person words) and "dueHint" (nullable natural language timing like "next week", "tomorrow", or null if none mentioned).

SAFETY CONSTRAINT: The model never diagnoses, never names a clinical condition, and never asserts a downward trend as a fact about the person. Insight copy describes what was written, not what the user is.

JOURNAL ENTRY:
"""
${entryText.slice(0, 3000)}
"""

Respond with strictly valid JSON matching this schema:
{
  "commitments": [
    {
      "text": "first-person commitment text",
      "dueHint": "natural language timing or null"
    }
  ]
}`;

  try {
    const res = await ai.models.generateContent({
      model: MODEL_ID,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1, // Highly deterministic
      },
    });

    const raw = (res?.text || '').replace(/```json\n?|\n?```/g, '').trim();
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    const validated = CommitmentExtractionResponseSchema.safeParse(parsed);

    if (!validated.success) {
      console.warn('Commitment extraction schema validation failed:', validated.error);
      return [];
    }

    return validated.data.commitments;
  } catch (error) {
    console.warn('Error during commitment extraction:', error);
    return [];
  }
}
