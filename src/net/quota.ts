// Entitlement reads + the server-authoritative export gate. Clients can READ
// their own `profiles` row (RLS: select-own) to show "N of 2 free projects
// left", but only edge functions (service role) can mutate any counter.
// Enforcement always happens server-side.
//
// REWORKED 2026-08-27. This file used to read five per-format export
// counters out of `usage` (script, callsheet, premiere, pdf, csv), each a
// lifetime cap that never refilled and never distinguished one project from
// another. That gated the LIGHTEST user first - see the migration header in
// supabase/migrations/20260827120000_project_metering.sql for the full
// argument - so the meter moved to PROJECTS:
//
//   csv                free for any signed-in account, forever, no counter.
//   pdf, premiere      need the CURRENT PROJECT unlocked (a credit spent via
//                      unlock_project) - see gateExport's projectId param.
//   Script Mode        (shots + call sheet, in supabase/functions/breakdown)
//                      free on an account's first FREE_PROJECT_LIMIT
//                      projects ever; every project beyond that needs the
//                      same unlock.
//
// The five old `usage` columns are UNCHANGED server-side (deployed clients
// keep reading them; dropping one 42703s the whole select for every client
// still asking - see callsheetUsed's own comment below for the shipped
// precedent of that exact bug) but this file no longer reads them: there is
// nothing left here for them to answer.

import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import { supabase } from './supabase';

/**
 * How many projects a free account gets Script Mode access on before every
 * further project needs a credit. DISPLAY ONLY - the server derives its own
 * copy (FREE_PROJECT_LIMIT in supabase/functions/_shared/products.ts) and is
 * the only thing that enforces anything. Kept in sync by hand, same posture
 * the old FREE_LIMITS carried: if the two drift, the server wins, and the
 * worst case is a screen that is off by one number until the next reload.
 */
export const FREE_PROJECT_LIMIT = 2;

/**
 * THE ONE-LINE FLIP, mirrored from products.ts for display purposes only.
 * 0 = the free grant never refills (today's setting). See that file's own
 * comment on FREE_PROJECT_RESET_DAYS for the full reasoning - this constant
 * exists here purely so the Account screen's copy can say "never refills" or
 * "refills monthly" honestly without a round trip.
 */
export const FREE_PROJECT_RESET_DAYS = 0;

/** Podcast roll-time allowance, minutes per month, by tier. DISPLAY ONLY -
 *  mirrors products.ts. See that file's header for why nothing has ever
 *  consumed against these yet: no part of this codebase currently times a
 *  recording and reports it to the server, so `podcastMinutesUsed` below
 *  will honestly read 0 until that wiring exists. */
export const PODCAST_MINUTES_FREE_PER_MONTH = 180; // 3 hours
export const PODCAST_MINUTES_STUDIO_PER_MONTH = 1200; // 20 hours
export const PODCAST_MINUTES_STUDIO_PLUS_PER_MONTH = 3600; // 60 hours

/** Which products.ts subscription key maps to which podcast allowance.
 *  Mirrors podcastMinutesForPlan server-side. */
function podcastMinutesForPlan(product: string | null, active: boolean): number {
  if (active && product === 'studio_plus') return PODCAST_MINUTES_STUDIO_PLUS_PER_MONTH;
  if (active && product === 'pro_monthly') return PODCAST_MINUTES_STUDIO_PER_MONTH;
  return PODCAST_MINUTES_FREE_PER_MONTH;
}

/**
 * The subset `gateExport` may be called with - export-gate's own known set,
 * spelled out rather than derived from anything else so a format that does
 * not exist server-side cannot silently typecheck here.
 */
export type GatedFormat = 'csv' | 'pdf' | 'premiere';

/** What the Account screen (and ProjectScreen's export bar) needs to show,
 *  read off the caller's own `profiles` row. Every field here is exactly
 *  what a client is already allowed to select under profiles_select_own -
 *  no new RLS policy needed for this half of the read. */
export interface Entitlements {
  isPro: boolean;
  /** ISO timestamp, or null (no expiry - an is_pro grant with no pro_until
   *  reads as still valid, matching the server). */
  proUntil: string | null;
  freeProjectsUsed: number;
  freeProjectsLimit: number;
  /** Unspent project credits - permanent unlocks waiting to be spent via
   *  unlock_project. Fungible: a credit from the free bundle, a one-off
   *  purchase or a subscription's monthly grant all look identical here. */
  projectCredits: number;
  /** True when profiles.subscription_status reads as a currently-paying
   *  state, in either provider's vocabulary. See
   *  ACTIVE_SUBSCRIPTION_STATUSES for the exact set and for why being wrong
   *  here can double-charge somebody. Nothing is GATED on this (only
   *  project_credits and project_entitlements ever gate anything), but the
   *  Account screen DOES decide from it whether to render a plan as "Your
   *  plan" or as a live buy button, so it is not display-only in the
   *  harmless sense that phrase usually means. */
  subscriptionActive: boolean;
  /** Which products.ts key the account is subscribed to, or null. */
  subscriptionProduct: string | null;
  podcastMinutesLimit: number;
  /** Always 0 until the recording flow reports roll time - see the header
   *  of this file and of the 2026-08-27 migration. Honest, not fake. */
  podcastMinutesUsed: number;
}

interface ProfileRow {
  is_pro: boolean;
  pro_until: string | null;
  free_projects_used: number | null;
  project_credits: number | null;
  subscription_status: string | null;
  subscription_product: string | null;
  podcast_seconds_used: number | null;
}

/**
 * Subscription states that mean THIS ACCOUNT IS CURRENTLY PAYING US.
 *
 * ONE COLUMN, TWO PROVIDERS' VOCABULARIES. `profiles.subscription_status` is
 * a plain mirror of whatever status the provider reported, and BOTH Stripe
 * and Razorpay write to it (stripe-webhook and razorpay-webhook). So this set
 * has to speak both languages, and a word that belongs to one of them is not
 * dead code just because the other never sends it.
 *
 * Stripe:
 *   active        - paying.
 *   trialing      - inside a free trial, card on file, will be charged. Kept
 *                   deliberately: Stripe really does send this, even though
 *                   Razorpay never has.
 *
 * Razorpay, both ADDED 2026-08-27 because neither was here and both mean the
 * account is live:
 *   authenticated - the mandate is approved and the first charge is on its
 *                   way. razorpay-webhook mirrors whatever status the
 *                   subscription fetch returns at delivery time, and that
 *                   fetch can land before Razorpay has flipped the row to
 *                   `active`.
 *   pending       - a charge failed and Razorpay is retrying it. Still a
 *                   live subscription, still going to be charged again.
 *
 * WHY GETTING THIS WRONG COSTS MONEY rather than just looking untidy. The
 * Account screen decides which plan row renders as "Your plan" instead of a
 * buy button from `subscriptionActive` (see AccountScreen.tsx's
 * `currentSubscriptionKey`). An account reading `authenticated` therefore
 * gets offered a live Subscribe button for the plan it already holds, and
 * tapping it opens a second real subscription on a card that is already
 * being charged. The old comment on `subscriptionActive` said nothing is
 * gated on this so it only affects a displayed allowance; that was true when
 * it was written and stopped being true the day this screen grew a buy
 * button.
 *
 * ERRS TOWARD "ALREADY SUBSCRIBED". A state we do not recognise resolves to
 * not-paying, so the deliberate direction of the whole set is to include
 * anything that plausibly means live. Being wrong that way shows somebody a
 * plan they cannot buy again and they send an email. Being wrong the other
 * way takes their money twice.
 *
 * NOT INCLUDED, because they are genuinely over: `created` (never
 * authorised), `halted` (retries exhausted), `cancelled`, `completed`,
 * `expired`.
 */
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'authenticated', 'pending']);

/**
 * Read the caller's entitlements. Returns null when signed out (or if the
 * row is unreadable). DISPLAY ONLY - every number here is re-derived
 * server-side by export-gate and breakdown, which is the only thing that
 * enforces anything.
 *
 * A SINGLE query, unlike the old getUsage's two-query split for
 * callsheet_uses. That split existed because callsheet_uses arrived in a
 * LATER migration than the other four columns, and naming it in the same
 * select as those four would have 42703'd the whole thing on a database that
 * had not run that migration yet (PostgREST resolves the full column list
 * before running anything). Every column this function selects arrives in
 * the SAME migration (20260827120000), so that risk does not apply here -
 * but the risk itself is real for as long as a signed-in client can load
 * against a database that has not been migrated yet, which is exactly why
 * every failure below resolves to a safe default rather than a thrown error.
 */
export async function getEntitlements(): Promise<Entitlements | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select(
      'is_pro, pro_until, free_projects_used, project_credits, subscription_status, subscription_product, podcast_seconds_used',
    )
    .maybeSingle<ProfileRow>();

  if (error || !data) return null;

  const subscriptionActive = data.subscription_status != null &&
    ACTIVE_SUBSCRIPTION_STATUSES.has(data.subscription_status);
  const podcastMinutesLimit = podcastMinutesForPlan(data.subscription_product, subscriptionActive);

  return {
    isPro: data.is_pro === true,
    proUntil: data.pro_until,
    freeProjectsUsed: data.free_projects_used ?? 0,
    freeProjectsLimit: FREE_PROJECT_LIMIT,
    projectCredits: data.project_credits ?? 0,
    subscriptionActive,
    subscriptionProduct: data.subscription_product,
    podcastMinutesLimit,
    podcastMinutesUsed: Math.floor((data.podcast_seconds_used ?? 0) / 60),
  };
}

export interface GateResult {
  allow: boolean;
  /**
   * On allow:false, one of: 'project_locked' (pdf/premiere on a project
   * that has not been unlocked) | 'auth' (from the server, or synthesized
   * here from a 401) | 'suspended' | 'unreachable' (the request never
   * reached the function) | 'http_error' (the function answered, with an
   * error status). The UI decides what to say for each; see
   * ProjectScreen.tsx.
   */
  reason?: string;
  /** HTTP status the function responded with. Only set when reason is 'http_error'. */
  status?: number;
}

/**
 * Ask the `export-gate` edge function whether an export is allowed. The
 * client must generate the blob ONLY when `allow` is true.
 *
 * `projectId` is REQUIRED for 'pdf' and 'premiere' - the server checks
 * whether THAT project is unlocked, and an absent id can never resolve to
 * yes. It is ignored for 'csv', which is free regardless of project.
 *
 * Every failure used to collapse into `reason: 'network'`, which the UI then
 * read as "offline" even when the function was up and answering with a 500.
 * That's what this function exists to prevent: a fetch that never reached
 * the function ('unreachable', @supabase/functions-js's FunctionsFetchError
 * or FunctionsRelayError) is not the same fact as the function answering
 * with an error status ('http_error'), and neither is the same fact as the
 * caller being offline. That call is the UI's to make, from
 * `navigator.onLine`, not ours.
 */
export async function gateExport(format: GatedFormat, projectId?: string): Promise<GateResult> {
  const { data, error } = await supabase.functions.invoke<GateResult>('export-gate', {
    body: { format, projectId: projectId ?? '' },
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
