/**
 * @file lib/config.ts
 * Central configuration registry for models, prompt versions, and runtime limits.
 * Model IDs are centralized here so they can be changed in one place.
 */

// Primary Gemini Model (gemini-3.6-flash as specified by user instructions)
export const MODEL_ID = 'gemini-3.6-flash';

// Fallback model ladder for transient upstream errors
export const MODEL_FALLBACK_LADDER = [
  'gemini-3.6-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-3.7-flash',
] as const;

// Text Embedding Model for grounded vector recall
export const EMBEDDING_MODEL_ID = 'text-embedding-004';

// Application & prompt version tag stored on messages and metadata
export const PROMPT_VERSION = 'v2.0.0';

// Global volumetric boundaries
export const LIMITS = {
  MAX_PROMPT_LENGTH: 8000,
  MAX_HISTORY_TURNS: 12,
  MAX_CHUNK_LENGTH: 1500,
  CHUNK_OVERLAP: 200,
  RATE_LIMIT_PER_MINUTE: 25,
  SIMILARITY_FLOOR: 0.55,
  MAX_RECALL_CITATIONS: 5,
} as const;
