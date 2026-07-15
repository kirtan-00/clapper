// Quota reads + the server-authoritative export gate. Clients can READ their own
// `usage` row (RLS: select-own) to show "N of 5 left", but only edge functions
// (service role) can mutate the counters. Enforcement always happens server-side.

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Free-tier limit per counter. The server re-derives this from `is_pro`; the
 *  client value is display-only and never sent to the edge. */
export const FREE_LIMIT = 5;

export interface QuotaCounter {
  used: number;
  left: number;
}

export interface Usage {
  script: QuotaCounter;
  premiere: QuotaCounter;
  csv: QuotaCounter;
}

interface UsageRow {
  script_uses: number;
  premiere_uses: number;
  csv_uses: number;
}

function counter(used: number): QuotaCounter {
  return { used, left: Math.max(0, FREE_LIMIT - used) };
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
    .select('script_uses, premiere_uses, csv_uses')
    .maybeSingle<UsageRow>();

  if (error || !data) return null;

  return {
    script: counter(data.script_uses),
    premiere: counter(data.premiere_uses),
    csv: counter(data.csv_uses),
  };
}

export interface GateResult {
  allow: boolean;
  remaining?: number;
  reason?: string;
}

/**
 * Ask the `export-gate` edge function whether a Premiere/CSV export is allowed,
 * consuming one quota unit server-side on allow. The client must generate the
 * XML/CSV blob ONLY when `allow` is true. PDF export never calls this.
 */
export async function gateExport(format: 'premiere' | 'csv'): Promise<GateResult> {
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
