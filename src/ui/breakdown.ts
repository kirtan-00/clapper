// Backend client for the two things Clapper still asks a server to do.
//
// It does NOT send scripts. The scene and shot structure is parsed on-device by
// `shotlist.ts`, exactly and for free. What goes over the wire is small and
// structured: the already-parsed shot division (for key-moment chips), or a
// call sheet plus the project's known scene refs (for today's shooting order).
//
// The `breakdown` edge function holds the Groq key server-side and derives the
// user from the auth JWT — never a client-sent email. `functions.invoke`
// auto-attaches the caller's `Authorization: Bearer <jwt>` from the persisted
// session, so identity + quota are enforced entirely server-side.

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '../net/supabase';
import { getTurnstileToken } from '../net/turnstile';
import type { ScriptPack } from './scriptpack';

// The user must be signed in before this runs.
const OFFLINE_MSG = 'Could not reach the breakdown service. Check your connection.';

/**
 * Sentinel thrown when a server call needs a signed-in user (no local session,
 * or the server answered 401). The caller detects it (`instanceof`) and opens
 * the sign-in sheet rather than showing a raw error.
 */
export class SignInRequiredError extends Error {
  constructor() {
    super('Sign in to read a shotlist.');
    this.name = 'SignInRequiredError';
  }
}

/** What we send per shot — the parsed row, not the script it came from. */
interface ShotBrief {
  code: string;
  size?: string;
  move?: string;
  action?: string;
  dialogue?: string;
}

/**
 * Add key-moment chips to an already-parsed shotlist.
 *
 * The structure is ours: `shotlist.ts` read the scenes and shots off the table
 * on-device, exactly. This asks the model for the ONE thing that isn't
 * transcription — which beats inside each shot an operator would want to tap
 * mid-take. It sends the parsed shot division, never the script, so the payload
 * is small and structured and there is nothing long to truncate.
 *
 * Enrichment is a bonus, not a gate: if the server refuses for any reason other
 * than "sign in" or "out of uses", the caller still gets its shotlist back with
 * no chips rather than losing a correct parse to a flaky network.
 */
export async function enrichShotMoments(pack: ScriptPack, docName: string): Promise<ScriptPack> {
  const briefs: ShotBrief[] = [];
  for (const scene of pack.scenes) {
    for (const s of scene.shots ?? []) {
      briefs.push({ code: s.code, size: s.size, move: s.move, action: s.action, dialogue: s.dialogue });
    }
  }
  if (!briefs.length) return pack;

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) throw new SignInRequiredError();

  let turnstileToken: string;
  try {
    turnstileToken = await getTurnstileToken();
  } catch {
    throw new Error('Could not verify you are human. Please try again.');
  }

  const { data, error } = await supabase.functions.invoke<{
    shots: { code: string; keyMoments: string[] }[];
  }>('breakdown', {
    body: { mode: 'shots', shots: briefs, docName, turnstileToken },
  });

  if (error) {
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
      // These two the user must act on, so they surface. Everything else is a
      // transient server problem the shotlist itself shouldn't die for.
      if (status === 401) throw new SignInRequiredError();
      if (status === 402 || reason === 'quota_exceeded') throw new Error('CAP');
    }
    return pack;
  }
  if (!data || !Array.isArray(data.shots)) return pack;

  const byCode = new Map(data.shots.map((s) => [String(s.code), s.keyMoments]));
  return {
    ...pack,
    scenes: pack.scenes.map((scene) => ({
      ...scene,
      shots: scene.shots?.map((s) => {
        const moments = byCode.get(s.code);
        return Array.isArray(moments) && moments.length
          ? { ...s, keyMoments: moments.filter((m) => typeof m === 'string' && m.trim()).slice(0, 4) }
          : s;
      }),
    })),
  };
}

/**
 * Load today's call sheet against an already-imported project: sends the
 * extracted call-sheet text plus the project's current scene refs, gets back
 * which of those scenes are shooting today and in what order. Mirrors
 * the same auth/error handling as above — same server, same rules.
 */
export async function breakdownCallSheet(
  text: string,
  docName: string,
  scenes: { ref: string; name: string }[],
): Promise<{ today: { ref: string; order: number }[] }> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) throw new SignInRequiredError();

  let turnstileToken: string;
  try {
    turnstileToken = await getTurnstileToken();
  } catch {
    throw new Error('Could not verify you are human. Please try again.');
  }

  const { data, error } = await supabase.functions.invoke<{ callSheet: 1; today: { ref: string; order: number }[] }>(
    'breakdown',
    { body: { text, docName, turnstileToken, mode: 'callsheet', scenes } },
  );

  if (error) {
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
    throw new Error(OFFLINE_MSG);
  }

  if (!data) throw new Error(OFFLINE_MSG);

  const today = Array.isArray(data.today) ? data.today : [];
  if (today.length === 0) {
    throw new Error("No scenes from today's call sheet matched this script. Check they're the same production.");
  }

  return { today };
}
