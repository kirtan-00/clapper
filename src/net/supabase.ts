// The single configured Supabase client for Clapper's account + quota layer.
// The anon key is a public client key — it ships in every Supabase web app by
// design (the service-role key lives only in edge-function secrets).

import { createClient } from '@supabase/supabase-js';

// Copied from src/ui/breakdown.ts (kept in sync by hand — same project).
export const SUPABASE_URL = 'https://sqqdivfgdfaztfzrzkhu.supabase.co';
export const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxcWRpdmZnZGZhenRmenJ6a2h1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTA2NTYsImV4cCI6MjA5OTU4NjY1Nn0.MUhO3nmPg4gmQI5vLK5LGpOMIzrcA_j9ZDj8sp8ftH4';

export const supabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true,
  },
});

/**
 * Finish an OAuth PKCE return. On the redirect back to `/clapper/?code=...`,
 * supabase-js (with `detectSessionInUrl`) exchanges the code for a session. We
 * await `getSession()` — which resolves only after that PKCE exchange completes —
 * BEFORE stripping the `?code=...` (or `?error=...`) from the URL, so we never
 * race the exchange and drop the code. Only touch the URL when such a param is
 * present. gh-pages has no router, so we replace back to BASE_URL. Non-blocking
 * and never throws.
 */
export function initAuthReturn(): void {
  const search = window.location.search;
  if (!/[?&](code|error)=/.test(search)) return;
  void (async () => {
    try {
      // Awaits the in-flight detectSessionInUrl PKCE code exchange.
      await supabase.auth.getSession();
      history.replaceState({}, '', import.meta.env.BASE_URL);
    } catch {
      /* never block app boot on a cleanup step */
    }
  })();
}
