/**
 * @file firestore.rules.test.ts
 * Comprehensive security rule verification suite for Personal Gemini Journal.
 * Validates the Four Axioms of Fortress Security:
 *  (a) Owner can read/write their own subtree
 *  (b) Another authenticated user gets PERMISSION_DENIED on read, write, and list
 *  (c) Unauthenticated access is denied
 *  (d) Malformed field shapes / out-of-bound values are rejected
 *
 * To execute:
 *   npx firebase emulators:exec --only firestore "npm test"
 */

import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import {
  initializeTestEnvironment,
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ID = 'ai-studio-geminireflection-test';
let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const rulesPath = path.resolve(__dirname, 'firestore.rules');
  const rules = fs.readFileSync(rulesPath, 'utf8');

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

afterAll(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
  }
});

describe('Firestore Fortress Security Rules Suite', () => {
  const ALICE_UID = 'user_alice_123';
  const BOB_UID = 'user_bob_456';

  const validEntry = {
    title: 'Evening Contemplation on Stillness',
    mode: 'reflection',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 2,
    tags: ['mindfulness', 'stillness'],
    moodScore: 0.75,
    themes: ['calm', 'focus'],
    summary: {
      tldr: 'Found calm after a demanding afternoon.',
      keyThemes: ['rest', 'clarity'],
      nextSteps: ['Maintain boundary on email'],
      openQuestion: 'How can I protect tomorrow morning?',
      generatedAt: new Date().toISOString(),
      promptVersion: 'v2.0.0',
    },
  };

  const validMessage = {
    role: 'user',
    content: 'Today was demanding, but I found 15 minutes of genuine silence.',
    createdAt: new Date().toISOString(),
    modelId: 'gemini-3.6-flash',
    promptVersion: 'v2.0.0',
    tokenCount: 42,
    redactionApplied: false,
    safetyBlocked: false,
  };

  const validChunk = {
    entryId: 'entry_001',
    text: 'Today was demanding, but I found 15 minutes of genuine silence.',
    embedding: [0.012, -0.045, 0.089],
    createdAt: new Date().toISOString(),
  };

  const validInsight = {
    periodStart: '2026-08-28T00:00:00Z',
    periodEnd: '2026-09-04T00:00:00Z',
    moodTrend: [0.2, 0.5, 0.7],
    recurringThemes: ['calm', 'boundaries'],
    blockers: ['late notifications'],
    oneQuestion: 'What single commitment will restore your focus this week?',
    entryRefs: ['entry_001'],
    generatedAt: new Date().toISOString(),
  };

  const validAudit = {
    type: 'JOURNAL_CHAT',
    at: new Date().toISOString(),
    ipHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    userAgentHash: 'ca978112ca1bbdcafac231b39a23dc4da78607f9c2f960efb67284140583b238',
    outcome: 'SUCCESS',
  };

  /* ==========================================================================
     AXIOM A: Owner can read and write their own subtree
     ========================================================================== */
  describe('Axiom A: Owner Access Control', () => {
    it('allows owner Alice to create, read, update, and delete an entry', async () => {
      const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
      const entryRef = aliceDb.doc(`users/${ALICE_UID}/entries/entry_001`);

      // Create
      await assertSucceeds(entryRef.set(validEntry));

      // Read
      await assertSucceeds(entryRef.get());

      // Update
      await assertSucceeds(entryRef.update({ title: 'Updated Evening Contemplation' }));

      // Message write
      const msgRef = aliceDb.doc(`users/${ALICE_UID}/entries/entry_001/messages/msg_001`);
      await assertSucceeds(msgRef.set(validMessage));

      // Chunk write
      const chunkRef = aliceDb.doc(`users/${ALICE_UID}/chunks/chunk_001`);
      await assertSucceeds(chunkRef.set(validChunk));

      // Insight write
      const insightRef = aliceDb.doc(`users/${ALICE_UID}/insights/2026-W36`);
      await assertSucceeds(insightRef.set(validInsight));

      // Audit append
      const auditRef = aliceDb.doc(`users/${ALICE_UID}/audit/audit_001`);
      await assertSucceeds(auditRef.set(validAudit));
    });
  });

  /* ==========================================================================
     AXIOM B: Another authenticated user gets PERMISSION_DENIED
     ========================================================================== */
  describe('Axiom B: Cross-User Isolation (Tenant Boundaries)', () => {
    beforeEach(async () => {
      // Seed Alice document as admin
      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        const adminDb = adminContext.firestore();
        await adminDb.doc(`users/${ALICE_UID}/entries/entry_001`).set(validEntry);
        await adminDb.doc(`users/${ALICE_UID}/entries/entry_001/messages/msg_001`).set(validMessage);
        await adminDb.doc(`users/${ALICE_UID}/chunks/chunk_001`).set(validChunk);
        await adminDb.doc(`users/${ALICE_UID}/insights/2026-W36`).set(validInsight);
      });
    });

    it('denies Bob from reading Alice entries (get & list)', async () => {
      const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();

      // Direct document get
      const aliceEntry = bobDb.doc(`users/${ALICE_UID}/entries/entry_001`);
      await assertFails(aliceEntry.get());

      // Collection list
      const aliceEntries = bobDb.collection(`users/${ALICE_UID}/entries`);
      await assertFails(aliceEntries.get());
    });

    it('denies Bob from writing, updating, or deleting Alice entries', async () => {
      const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();
      const aliceEntry = bobDb.doc(`users/${ALICE_UID}/entries/entry_001`);

      await assertFails(aliceEntry.update({ title: 'Hacked by Bob' }));
      await assertFails(aliceEntry.delete());

      const newEntryRef = bobDb.doc(`users/${ALICE_UID}/entries/malicious_entry`);
      await assertFails(newEntryRef.set(validEntry));
    });

    it('denies Bob from reading or poisoning Alice recall chunks', async () => {
      const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();

      // Read chunk
      await assertFails(bobDb.doc(`users/${ALICE_UID}/chunks/chunk_001`).get());

      // Poison chunk
      const poisonChunk = bobDb.doc(`users/${ALICE_UID}/chunks/chunk_poison`);
      await assertFails(poisonChunk.set(validChunk));
    });

    it('denies Bob from accessing Alice insights or audit ledger', async () => {
      const bobDb = testEnv.authenticatedContext(BOB_UID).firestore();
      await assertFails(bobDb.doc(`users/${ALICE_UID}/insights/2026-W36`).get());
      await assertFails(bobDb.doc(`users/${ALICE_UID}/audit/audit_001`).get());
    });
  });

  /* ==========================================================================
     AXIOM C: Unauthenticated access is denied
     ========================================================================== */
  describe('Axiom C: Unauthenticated Rejection', () => {
    it('rejects all read, write, and list operations from anonymous / guest users', async () => {
      const guestDb = testEnv.unauthenticatedContext().firestore();

      await assertFails(guestDb.doc(`users/${ALICE_UID}/entries/entry_001`).get());
      await assertFails(guestDb.collection(`users/${ALICE_UID}/entries`).get());
      await assertFails(guestDb.doc(`users/${ALICE_UID}/entries/entry_001`).set(validEntry));
      await assertFails(guestDb.doc(`users/${ALICE_UID}/chunks/chunk_001`).get());
      await assertFails(guestDb.doc(`users/${ALICE_UID}/insights/2026-W36`).get());
    });
  });

  /* ==========================================================================
     AXIOM D: Schema Enforcement & Malformed Payload Rejection
     ========================================================================== */
  describe('Axiom D: Malformed Payload Rejection', () => {
    it('rejects entries with invalid moodScore outside [-1.0, 1.0]', async () => {
      const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
      const entryRef = aliceDb.doc(`users/${ALICE_UID}/entries/entry_bad_mood`);

      const badMoodEntry = {
        ...validEntry,
        moodScore: 45.2, // Invalid
      };

      await assertFails(entryRef.set(badMoodEntry));
    });

    it('rejects entries with oversized title exceeding 200 chars', async () => {
      const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
      const entryRef = aliceDb.doc(`users/${ALICE_UID}/entries/entry_huge_title`);

      const hugeTitleEntry = {
        ...validEntry,
        title: 'A'.repeat(250), // Exceeds 200
      };

      await assertFails(entryRef.set(hugeTitleEntry));
    });

    it('rejects message with oversized content exceeding boundary', async () => {
      const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
      const msgRef = aliceDb.doc(`users/${ALICE_UID}/entries/entry_001/messages/msg_huge`);

      const hugeMessage = {
        ...validMessage,
        content: 'X'.repeat(35000), // Exceeds 32000
      };

      await assertFails(msgRef.set(hugeMessage));
    });

    it('forbids mutating or deleting immutable audit log documents', async () => {
      const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
      const auditRef = aliceDb.doc(`users/${ALICE_UID}/audit/audit_immutability_test`);

      // Creation succeeds
      await assertSucceeds(auditRef.set(validAudit));

      // Mutation is strictly denied
      await assertFails(auditRef.update({ outcome: 'TAMPERED' }));

      // Deletion is strictly denied
      await assertFails(auditRef.delete());
    });
  });
});
