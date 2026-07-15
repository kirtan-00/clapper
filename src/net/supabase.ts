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
 * supabase-js (with `detectSessionInUrl`) exchanges the code for a session on
 * load; we wait a tick for that, then strip the `?code=...` (and any error)
 * from the URL so a refresh or bookmark stays clean. gh-pages has no router,
 * so we replace back to BASE_URL.
 */
export function initAuthReturn(): void {
  const search = window.location.search;
  if (!/[?&]code=/.test(search)) return;
  // Let supabase-js run its detectSessionInUrl exchange first.
  window.setTimeout(() => {
    history.replaceState({}, '', import.meta.env.BASE_URL);
  }, 0);
}
