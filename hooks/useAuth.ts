'use client';

import { useState, useEffect } from 'react';
import {
  User,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { auth, googleProvider } from '@/lib/firebase';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    // Check if returning from redirect
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) {
          setUser(result.user);
        }
      })
      .catch((err) => {
        console.error('Redirect sign-in error:', err);
        setAuthError(err?.message || 'Authentication redirect failed.');
      });

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err: any) {
      console.warn('Popup sign in failed, trying fallback...', err);
      // If popup was blocked or iframe restriction
      if (err.code === 'auth/popup-blocked' || err.code === 'auth/cancelled-popup-request') {
        try {
          await signInWithRedirect(auth, googleProvider);
          return;
        } catch (redirectErr: any) {
          setAuthError(redirectErr?.message || 'Failed to sign in via redirect.');
          return;
        }
      }
      setAuthError(err?.message || 'Google authentication failed. Please try again.');
    }
  };

  const signOutUser = async () => {
    setAuthError(null);
    try {
      await signOut(auth);
    } catch (err: any) {
      setAuthError(err?.message || 'Failed to sign out.');
    }
  };

  return {
    user,
    loading,
    authError,
    setAuthError,
    signInWithGoogle,
    signOutUser,
  };
}
