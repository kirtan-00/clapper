// Script Mode backend client. Sends an email + extracted script text to the
// Clapper breakdown edge function (which holds the Groq key server-side) and
// returns a validated script pack the app imports. The anon key below is a
// public client key — it ships in every Supabase web app by design.

import type { ScriptPack } from './scriptpack';

const SUPABASE_URL = 'https://sqqdivfgdfaztfzrzkhu.supabase.co';
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNxcWRpdmZnZGZhenRmenJ6a2h1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwMTA2NTYsImV4cCI6MjA5OTU4NjY1Nn0.MUhO3nmPg4gmQI5vLK5LGpOMIzrcA_j9ZDj8sp8ftH4';
const ENDPOINT = `${SUPABASE_URL}/functions/v1/breakdown`;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Turn a script into a Clapper pack via the server. Throws with a human why. */
export async function breakdownScript(
  email: string,
  text: string,
  docName: string,
): Promise<ScriptPack> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify({ email, text, docName }),
    });
  } catch {
    throw new Error('Could not reach the breakdown service. Check your connection.');
  }

  let data: unknown = {};
  try {
    data = await res.json();
  } catch {
    /* fall through to status check */
  }
  const err = (data as { error?: string }).error;
  if (!res.ok) throw new Error(err || `Breakdown failed (${res.status}).`);
  return data as ScriptPack;
}
