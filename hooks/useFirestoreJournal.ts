'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { sanitizeFirestorePayload } from '@/lib/sanitizer';
import { JournalInteraction } from '@/types/journal';

export function useFirestoreJournal(userId: string | undefined) {
  const [interactions, setInteractions] = useState<JournalInteraction[]>([]);
  const [loading, setLoading] = useState<boolean>(() => !!userId);
  const [firestoreError, setFirestoreError] = useState<string | null>(null);
  const [pendingRetryInteraction, setPendingRetryInteraction] = useState<JournalInteraction | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  useEffect(() => {
    if (!userId) {
      return;
    }

    const interactionsRef = collection(db, 'users', userId, 'interactions');
    const q = query(interactionsRef, orderBy('createdAt', 'desc'));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list: JournalInteraction[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as JournalInteraction;
          list.push({
            ...data,
            id: docSnap.id,
          });
        });
        setInteractions(list);
        setLoading(false);
      },
      (error) => {
        console.error('Firestore snapshot listener error:', error);
        setFirestoreError(
          `Unable to sync reflections: ${error.message}. Please check permissions or network connectivity.`
        );
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  const saveInteraction = useCallback(
    async (interaction: JournalInteraction): Promise<boolean> => {
      if (!userId) {
        setFirestoreError('Cannot save entry: No authenticated user session found.');
        return false;
      }

      setIsSaving(true);
      setFirestoreError(null);

      try {
        const sanitizedData = sanitizeFirestorePayload(interaction);
        const docRef = doc(db, 'users', userId, 'interactions', interaction.id);

        await setDoc(docRef, sanitizedData, { merge: true });
        setPendingRetryInteraction(null);
        setIsSaving(false);
        return true;
      } catch (err: any) {
        console.error('Firestore save failed:', err);
        setPendingRetryInteraction(interaction);
        setFirestoreError(
          `Failed to persist reflection to Firestore: ${err?.message || 'Unknown database write error'}. Your text has been preserved.`
        );
        setIsSaving(false);
        return false;
      }
    },
    [userId]
  );

  const retrySave = useCallback(async (): Promise<boolean> => {
    if (!pendingRetryInteraction) return false;
    return await saveInteraction(pendingRetryInteraction);
  }, [pendingRetryInteraction, saveInteraction]);

  const removeInteraction = useCallback(
    async (interactionId: string): Promise<boolean> => {
      if (!userId) return false;
      try {
        const docRef = doc(db, 'users', userId, 'interactions', interactionId);
        await deleteDoc(docRef);
        return true;
      } catch (err: any) {
        console.error('Firestore delete failed:', err);
        setFirestoreError(`Failed to delete reflection: ${err?.message || 'Write permission denied'}`);
        return false;
      }
    },
    [userId]
  );

  return {
    interactions,
    loading: userId ? loading : false,
    firestoreError,
    setFirestoreError,
    pendingRetryInteraction,
    isSaving,
    saveInteraction,
    retrySave,
    removeInteraction,
  };
}
