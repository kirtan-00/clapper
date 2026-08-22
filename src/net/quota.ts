// Quota reads + the server-authoritative export gate. Clients can READ their own
// `usage` row (RLS: select-own) to show "N of 5 left", but only edge functions
// (service role) can mutate the counters. Enforcement always happens server-side.

import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
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
  /**
   * On allow:false, one of: 'quota_exceeded' | 'auth' (from the server, or
   * synthesized here from a 401) | 'suspended' (the account is blocked; the
   * server says so at HTTP 200 precisely so this body is read at all, since
   * gateExport only parses JSON on a 2xx) | 'unreachable' (the request never
   * reached the function) | 'http_error' (the function answered, with an error
   * status). The UI decides what to say for each; see ProjectScreen.tsx.
   */
  reason?: string;
  /** HTTP status the function responded with. Only set when reason is 'http_error'. */
  status?: number;
}

/**
 * Ask the `export-gate` edge function whether an export is allowed, consuming
 * one quota unit server-side on allow. The client must generate the blob ONLY
 * when `allow` is true.
 *
 * PDF is now in here too. It was the one export that never called this, which
 * meant the file a producer actually prints and hands round a unit was the only
 * one nobody paid for.
 *
 * Every failure used to collapse into `reason: 'network'`, which the UI then
 * read as "offline" even when the function was up and answering with a 500.
 * That's what this function exists to prevent now: a fetch that never reached
 * the function ('unreachable', @supabase/functions-js's FunctionsFetchError or
 * FunctionsRelayError) is not the same fact as the function answering with an
 * error status ('http_error'), and neither is the same fact as the caller
 * being offline. That call is the UI's to make, from `navigator.onLine`, not
 * ours. Either way, the real error goes to the console so a report is
 * diagnosable from the first round trip instead of a follow-up asking what
 * the console said.
 */
export async function gateExport(format: GatedFormat): Promise<GateResult> {
  const { data, error } = await supabase.functions.invoke<GateResult>('export-gate', {
    body: { format },
  });
  if (error || !data) {
    if (error instanceof FunctionsHttpError) {
      const status = error.context?.status as number | undefined;
      // A 401 means the session is missing or expired. Surface it as an auth
      // error so the UI can prompt sign-in, distinct from every other status.
      if (status === 401) {
        return { allow: false, reason: 'auth' };
      }
      console.error(`export-gate: function answered with status ${status}`, error);
      return { allow: false, reason: 'http_error', status };
    }
    if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) {
      console.error('export-gate: request never reached the function', error);
      return { allow: false, reason: 'unreachable' };
    }
    console.error('export-gate: invoke failed with no data and an unrecognized error shape', error);
    return { allow: false, reason: 'unreachable' };
  }
  return data;
}
