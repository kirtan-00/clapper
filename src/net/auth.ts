// Authentication surface for the account + quota layer: Google OAuth sign-in,
// sign-out, a React session hook, and an access-token getter for edge calls.

import { useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Start the Google OAuth (PKCE) flow. Returns to `/clapper/?code=...`. */
export async function signInWithGoogle(): Promise<void> {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin + import.meta.env.BASE_URL,
    },
  });
  if (error) throw error;
}

/** Sign the current user out (clears the persisted session). */
export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export interface SessionState {
  session: Session | null;
  user: User | null;
  loading: boolean;
}

/**
 * React hook: current auth session. Reads the persisted session once, then
 * subscribes to auth state changes and cleans up on unmount.
 */
export function useSession(): SessionState {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, user: session?.user ?? null, loading };
}

/** Current access token (JWT) if signed in, else null. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
