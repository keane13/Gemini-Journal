/**
 * @file types/journal.ts
 * Type definitions for Personal Gemini Journal ("Nightstand").
 */

export type InteractionMode = 'reflection' | 'brainstorming' | 'summary' | 'deep_dive' | 'recall';
export type PrivacyMode = 'off' | 'standard' | 'strict';

export interface MaskedSpan {
  start: number;
  end: number;
  category: string;
  placeholder: string;
  maskedPreview: string;
}

export interface RedactionDetails {
  redactionApplied: boolean;
  categoryCounts: Record<string, number>;
  maskedSpans: MaskedSpan[];
  redactedPayload: string;
  originalLength: number;
  redactedLength: number;
}

export interface Citation {
  entryId: string;
  chunkId: string;
  snippet: string;
  score: number;
}

export interface Turn {
  id: string;
  role: 'user' | 'gemini';
  content: string;
  timestamp: string;
  redactionDetails?: RedactionDetails;
  citations?: Citation[];
}

export interface JournalInteraction {
  id: string;
  userId: string;
  title: string;
  prompt: string;
  geminiResponse: string;
  summary: string;
  mode: InteractionMode;
  turns: Turn[];
  createdAt: string;
  updatedAt: string;
  moodScore?: number;
  dominantEmotion?: string;
  tags?: string[];
  redactionDetails?: RedactionDetails;
}

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export interface WeeklyInsight {
  periodStart: string;
  periodEnd: string;
  moodTrend: number[];
  recurringThemes: string[];
  blockers: string[];
  oneQuestion: string;
  entryRefs: string[];
  generatedAt: string;
}

export type CommitmentStatus = 'open' | 'done' | 'released';

export interface Commitment {
  id: string;
  text: string;
  sourceEntryId: string;
  sourceMessageId?: string;
  statedAt: string;
  dueHint: string | null;
  status: CommitmentStatus;
  resurfacedCount: number;
  lastResurfacedAt: string | null;
}

