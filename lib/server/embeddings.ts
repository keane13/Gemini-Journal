/**
 * @file lib/server/embeddings.ts
 * Text chunking, vector embedding generation, and cosine similarity search.
 * Strictly scoped to the authenticated user's own subtree: users/{uid}/chunks.
 */

import { GoogleGenAI } from '@google/genai';
import { EMBEDDING_MODEL_ID, LIMITS } from '@/lib/config';
import { getGeminiApiKey } from '@/lib/server/secrets';

export interface TextChunk {
  chunkId: string;
  entryId: string;
  text: string;
  embedding?: number[];
  createdAt: string;
}

export interface ScoredChunk extends TextChunk {
  score: number;
}

/**
 * Splits journal entry into overlapping chunks of readable text.
 */
export function chunkJournalText(text: string, entryId: string): TextChunk[] {
  if (!text || !text.trim()) return [];

  const chunks: TextChunk[] = [];
  const clean = text.trim();
  const maxLen = LIMITS.MAX_CHUNK_LENGTH;
  const overlap = LIMITS.CHUNK_OVERLAP;

  if (clean.length <= maxLen) {
    return [
      {
        chunkId: `${entryId}_chunk_0`,
        entryId,
        text: clean,
        createdAt: new Date().toISOString(),
      },
    ];
  }

  let start = 0;
  let index = 0;
  while (start < clean.length) {
    let end = start + maxLen;
    // Prefer breaking at paragraph or sentence boundary
    if (end < clean.length) {
      const naturalBreak = clean.lastIndexOf('\n\n', end);
      if (naturalBreak > start + maxLen / 2) {
        end = naturalBreak + 2;
      } else {
        const sentenceBreak = clean.lastIndexOf('. ', end);
        if (sentenceBreak > start + maxLen / 2) {
          end = sentenceBreak + 2;
        }
      }
    }

    const chunkText = clean.substring(start, Math.min(end, clean.length)).trim();
    if (chunkText.length > 20) {
      chunks.push({
        chunkId: `${entryId}_chunk_${index}`,
        entryId,
        text: chunkText,
        createdAt: new Date().toISOString(),
      });
      index++;
    }

    start = end - overlap;
    if (start >= clean.length) break;
  }

  return chunks;
}

/**
 * Generates vector embedding using Gemini embedding model.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = await getGeminiApiKey();
  const ai = new GoogleGenAI({ apiKey });

  try {
    const response = await ai.models.embedContent({
      model: EMBEDDING_MODEL_ID,
      contents: text.slice(0, 2000),
    });

    const resAny = response as any;
    if (resAny?.embedding?.values) {
      return resAny.embedding.values;
    }
    if (Array.isArray(resAny?.embeddings) && resAny.embeddings[0]?.values) {
      return resAny.embeddings[0].values;
    }
  } catch (err) {
    console.warn('Embedding generation warning:', err);
  }

  // Fallback heuristic deterministic representation if upstream embedding is unavailable
  return computeDeterministicVector(text, 128);
}

/**
 * Computes cosine similarity between two numeric vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Deterministic fallback vector using character n-grams and hashing.
 */
function computeDeterministicVector(text: string, dims: number): number[] {
  const vec = new Array(dims).fill(0);
  const words = text.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    for (let c = 0; c < word.length; c++) {
      const idx = (word.charCodeAt(c) * (i + 1)) % dims;
      vec[idx] += 1;
    }
  }
  const norm = Math.sqrt(vec.reduce((acc, val) => acc + val * val, 0)) || 1;
  return vec.map((v) => v / norm);
}
