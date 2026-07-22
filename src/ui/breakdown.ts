// Script Mode backend client. Sends the extracted script text + a fresh Turnstile
// token to the Clapper `breakdown` edge function (which holds the Groq key
// server-side, and derives the user from the auth JWT — never a client-sent
// email). Returns a validated script pack the app imports. `functions.invoke`
// auto-attaches the caller's `Authorization: Bearer <jwt>` from the persisted
// session, so identity + quota are enforced entirely server-side.

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../net/supabase';
import { getTurnstileToken } from '../net/turnstile';
import type { ScriptPack } from './scriptpack';

// The user must be signed in before this runs.
const OFFLINE_MSG = 'Could not reach the breakdown service. Check your connection.';

/**
 * Sentinel thrown when Script Mode needs a signed-in user (no local session, or
 * the server answered 401). The caller detects it (`instanceof`) and opens the
 * sign-in sheet rather than showing a raw error.
 */
export class SignInRequiredError extends Error {
  constructor() {
    super('Sign in to use Script Mode.');
    this.name = 'SignInRequiredError';
  }
}

/** Turn a script into a Clapper pack via the server. Throws with a human why. */
export async function breakdownScript(text: string, docName: string): Promise<ScriptPack> {
  // Identity comes from the JWT. No session → don't spend a Turnstile token,
  // just tell the caller to sign in.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) throw new SignInRequiredError();

  let turnstileToken: string;
  try {
    turnstileToken = await getTurnstileToken();
  } catch {
    throw new Error('Could not verify you are human. Please try again.');
  }

  const { data, error } = await supabase.functions.invoke<ScriptPack>('breakdown', {
    body: { text, docName, turnstileToken },
  });

  if (error) {
    // Non-2xx from the function: read the JSON body + status off the Response.
    if (error instanceof FunctionsHttpError) {
      let status = 0;
      let reason = '';
      try {
        status = error.context.status;
        const body = (await error.context.json()) as { error?: string; reason?: string };
        reason = body.reason || body.error || '';
      } catch {
        /* no/invalid body — fall back to the status code below */
      }
      if (status === 401) throw new SignInRequiredError();
      if (status === 402 || reason === 'quota_exceeded') throw new Error('CAP');
      if (status === 429) throw new Error('Too fast. Give it a moment and try again.');
      if (status === 503) throw new Error('Script Mode is taking a breather. Try again later.');
      if (status === 403) throw new Error('Bot check failed. Please try again.');
      throw new Error(reason || `Breakdown failed (${status}).`);
    }
    // Relay / fetch error → we never reached the function (offline, DNS, etc.).
    throw new Error(OFFLINE_MSG);
  }

  if (!data) throw new Error(OFFLINE_MSG);
  return data;
}
