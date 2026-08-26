// Quota reads + the server-authoritative export gate. Clients can READ their own
// `usage` row (RLS: select-own) to show "N of 5 left", but only edge functions
// (service role) can mutate the counters. Enforcement always happens server-side.

import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import { supabase } from './supabase';

/**
 * The free tier, per counter. DISPLAY ONLY. The server derives its own copy
 * and is the only thing that enforces anything.
 *
 * MUST match the servers, which now price in TWO files:
 *   - `script` and `callsheet`  → MODE_QUOTA in supabase/functions/breakdown/index.ts
 *   - `premiere`, `pdf`, `csv`  → FREE_LIMITS in supabase/functions/export-gate/index.ts
 * This copy exists purely so the UI can count down truthfully; if the two ever
 * drift the server wins, and the user was shown a number that lied to them.
 *
 *   script     1   the shot-list breakdown. It calls Groq, and it is what Pro
 *                  is for. The server used to enforce 5 here while this file
 *                  said 1, so a counter could read "4 of 1"; fixed 2026-08-26.
 *   callsheet  5   working out which scenes shoot today. SPLIT OUT of `script`
 *                  on 2026-08-26, because it used to spend the breakdown's
 *                  counter. It is a per-shoot-day action, so a lifetime cap
 *                  of 1 would read as broken on day two of a shoot.
 *   premiere   2   XML, POOLED across Premiere and Resolve, same handoff, same
 *                  editor, one counter. Cut from 3 to 2 on 2026-08-26.
 *   pdf        5   gated as of 2026-08-20; it was free and uncounted before
 *   csv        5
 */
export const FREE_LIMITS = {
  script: 1,
  callsheet: 5,
  premiere: 2,
  pdf: 5,
  csv: 5,
} as const;

/** Every counter the UI can show a number for. */
export type QuotaKey = keyof typeof FREE_LIMITS;

/**
 * The subset `gateExport` may be called with, which is the export-gate
 * function's own VALID_FORMATS, spelled out rather than derived from
 * FREE_LIMITS.
 *
 * This used to be `keyof typeof FREE_LIMITS`, which let `gateExport('script')`
 * typecheck even though export-gate answers that with HTTP 400 Invalid format.
 * Adding `callsheet` above would have widened the hole by one more value that
 * compiles and cannot work. Script Mode's two counters are spent by the
 * `breakdown` function, never by the export gate.
 */
export type GatedFormat = 'premiere' | 'pdf' | 'csv';

/** Kept as a name because call sites read `FREE_LIMIT` for the CSV/PDF case.
 *  Prefer FREE_LIMITS[format]. */
export const FREE_LIMIT = FREE_LIMITS.csv;

export interface QuotaCounter {
  used: number;
  left: number;
}

export type Usage = Record<QuotaKey, QuotaCounter>;

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
 * How many call-sheet parses this account has spent.
 *
 * ASKED ON ITS OWN, AND IT FAILS OPEN AT ZERO. `usage.callsheet_uses` arrives
 * with supabase/migrations/20260826150000_callsheet_quota.sql, and this app has
 * already been bitten once by naming a column the live database did not have
 * yet: PostgREST resolves the whole column list before it runs anything, so ONE
 * unknown column fails the ENTIRE select with HTTP 400 / SQLSTATE 42703 and
 * returns `data: null`. See supabase/functions/_shared/suspension.ts for the
 * `is_suspended` version of this, which turned off the paid tier for the people
 * who paid for it.
 *
 * Adding `callsheet_uses` to the four-column select below would do the same
 * thing here, only louder: getUsage would return null on an unmigrated
 * database and the Account screen would show a dash for all five counters
 * instead of the four it can still read perfectly well.
 *
 * So it is a second query, and any failure resolves to 0 used. Zero is the
 * right default because these numbers are DISPLAY ONLY. The server is the only
 * thing that enforces anything, and it will refuse a call sheet whether or not
 * this read worked. The worst case is a screen that says 5 left to somebody
 * with 2 left, which they discover on the next parse. The alternative, a read
 * error blanking a screen that is otherwise correct, is worse and is the exact
 * defect this pattern exists to stop.
 */
async function callsheetUsed(): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('usage')
      .select('callsheet_uses')
      .maybeSingle<{ callsheet_uses: number | null }>();
    if (error || !data) return 0;
    return data.callsheet_uses ?? 0;
  } catch {
    // A thrown network error is the same answer as a returned one.
    return 0;
  }
}

/**
 * Read the caller's usage row. Returns null when signed out (or if the row is
 * unreadable). Values are for display only — the server enforces the real limit.
 *
 * The two Script Mode counters are INDEPENDENT: `script` is the shot-list
 * breakdown, `callsheet` is today's call sheet, and spending one has no effect
 * on the other. They shared a column until 2026-08-26.
 */
export async function getUsage(): Promise<Usage | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return null;

  const [row, callsheet] = await Promise.all([
    supabase
      .from('usage')
      .select('script_uses, premiere_uses, pdf_uses, csv_uses')
      .maybeSingle<UsageRow>(),
    callsheetUsed(),
  ]);

  const { data, error } = row;
  if (error || !data) return null;

  return {
    script: counter(data.script_uses, FREE_LIMITS.script),
    callsheet: counter(callsheet, FREE_LIMITS.callsheet),
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
