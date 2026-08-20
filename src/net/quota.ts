// Quota reads + the server-authoritative export gate. Clients can READ their own
// `usage` row (RLS: select-own) to show "N of 5 left", but only edge functions
// (service role) can mutate the counters. Enforcement always happens server-side.

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';

/**
 * The free tier, per format. DISPLAY ONLY — the server derives its own copy and
 * is the only thing that enforces anything.
 *
 * MUST match FREE_LIMITS in supabase/functions/export-gate/index.ts. This copy
 * exists purely so the UI can count down truthfully; if the two ever drift the
 * server wins, and the user was shown a number that lied to them.
 *
 *   script    1   it calls Groq, and it is what Pro is for
 *   premiere  3   XML, POOLED across Premiere and Resolve — same handoff, same
 *                 editor, one counter
 *   pdf       5   gated as of 2026-08-20; it was free and uncounted before
 *   csv       5
 */
export const FREE_LIMITS = {
  script: 1,
  premiere: 3,
  pdf: 5,
  csv: 5,
} as const;

export type GatedFormat = keyof typeof FREE_LIMITS;

/** Kept as a name because call sites read `FREE_LIMIT` for the CSV/PDF case.
 *  Prefer FREE_LIMITS[format]. */
export const FREE_LIMIT = FREE_LIMITS.csv;

/**
 * @deprecated Was "what a SIGNED-OUT caller gets of the XML handoff". Nobody
 * gets anything signed out any more — the app requires an account — so this now
 * aliases the free-tier XML allowance, which happens to be the same number.
 *
 * Two call sites in ProjectScreen.tsx still print copy around it that says "on
 * this connection" and "sign in for unlimited". Both are unreachable now and
 * both are wrong; they are left alone only because that file is being edited by
 * another agent as this lands. Fix the copy, then delete this.
 */
export const ANON_LIMIT_XML = FREE_LIMITS.premiere;

export interface QuotaCounter {
  used: number;
  left: number;
}

export interface Usage {
  script: QuotaCounter;
  premiere: QuotaCounter;
  pdf: QuotaCounter;
  csv: QuotaCounter;
}

interface UsageRow {
  script_uses: number;
  premiere_uses: number;
  /** Added 2026-08-20. Absent on rows written before the column existed, so it
   *  is read defensively rather than assumed. */
  pdf_uses: number | null;
  csv_uses: number;
}

function counter(used: number, limit: number = FREE_LIMIT): QuotaCounter {
  return { used, left: Math.max(0, limit - used) };
}

/**
 * Read the caller's usage row. Returns null when signed out (or if the row is
 * unreadable). Values are for display only — the server enforces the real limit.
 */
export async function getUsage(): Promise<Usage | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return null;

  const { data, error } = await supabase
    .from('usage')
    .select('script_uses, premiere_uses, pdf_uses, csv_uses')
    .maybeSingle<UsageRow>();

  if (error || !data) return null;

  return {
    script: counter(data.script_uses, FREE_LIMITS.script),
    premiere: counter(data.premiere_uses, FREE_LIMITS.premiere),
    pdf: counter(data.pdf_uses ?? 0, FREE_LIMITS.pdf),
    csv: counter(data.csv_uses, FREE_LIMITS.csv),
  };
}

export interface GateResult {
  allow: boolean;
  remaining?: number;
  reason?: string;
}

/**
 * Ask the `export-gate` edge function whether an export is allowed, consuming
 * one quota unit server-side on allow. The client must generate the blob ONLY
 * when `allow` is true.
 *
 * PDF is now in here too. It was the one export that never called this — which
 * meant the file a producer actually prints and hands round a unit was the only
 * one nobody paid for.
 */
export async function gateExport(format: GatedFormat): Promise<GateResult> {
  const { data, error } = await supabase.functions.invoke<GateResult>('export-gate', {
    body: { format },
  });
  if (error || !data) {
    // A 401 from the gateway/function means the session is missing or expired —
    // surface it as an auth error so the UI can prompt sign-in, distinct from a
    // transport failure.
    if (error instanceof FunctionsHttpError && error.context?.status === 401) {
      return { allow: false, reason: 'auth' };
    }
    return { allow: false, reason: 'network' };
  }
  return data;
}
