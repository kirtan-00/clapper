// The entitlement DECISIONS, pure and Deno-free, so vitest can exercise the
// four required scenarios (free with slots left, free at zero, legacy Pro,
// subscriber mid-cycle) without a database or a Deno runtime - same reason
// _shared/entitlements.ts exists as a port: the atomic CONSUME still has to
// happen in Postgres (claim_project_access, consume_quota's WHERE-clause
// guard is what makes concurrency safe, not this file), but the QUESTION -
// should this request be allowed, and off which fact - is a pure function of
// a handful of booleans and belongs somewhere a test can reach it directly.
//
// export-gate and breakdown both import this. Neither duplicates the pro/
// suspended logic, which is exactly the bug this file exists to prevent: see
// the comment on proBypass below for the one export-gate already had and
// breakdown did not.

/** is_pro / pro_until, read once and passed in - never re-queried here. */
export interface ProAccess {
  isPro: boolean;
  /** ISO timestamp, or null. NULL means "no expiry set", which this app has
   *  always read as still valid (see export-gate's original comment: an
   *  is_pro account predating the pro_until column must not be silently cut
   *  off). Not "now": lapse is decided at call time via `now`. */
  proUntil: string | null;
}

/**
 * Whether this account bypasses every project/export gate below - "every
 * project this account touches behaves as already unlocked", which is the
 * exact guarantee is_pro has always carried.
 *
 * UNIFIED HERE ON PURPOSE. Before 2026-08-27, export-gate checked BOTH
 * is_pro and pro_until (demoting a lapsed grant to free), while breakdown
 * checked only is_pro and never looked at pro_until at all - so the same
 * account could get uncapped Script Mode past its Pro expiry while exports
 * correctly demoted it. One helper, one answer, used by both functions now.
 */
export function proBypass(pro: ProAccess, now: number = Date.now()): boolean {
  if (!pro.isPro) return false;
  if (pro.proUntil == null) return true;
  return new Date(pro.proUntil).getTime() > now;
}

// ---------------------------------------------------------------------------
// Exports: CSV is always free; PDF and Premiere/Resolve need the project
// unlocked. No counters anywhere in this half - see products.ts,
// EXPORT_FORMATS_REQUIRING_UNLOCK.
// ---------------------------------------------------------------------------

export type ExportFormat = "csv" | "pdf" | "premiere";

export interface ExportDecisionInput {
  format: ExportFormat;
  isSuspended: boolean;
  pro: ProAccess;
  /** project_entitlements.unlocked_at is not null for this (user, project).
   *  Irrelevant for csv. Ignored (treated as false) when the format needs a
   *  project id and none was supplied - an absent id can never mean yes. */
  projectUnlocked: boolean;
  now?: number;
}

export type ExportVerdict =
  | { allow: true }
  | { allow: false; reason: "suspended" }
  /** The project this export is for has not been bought. Replaces
   *  'quota_exceeded' for pdf/premiere: there is no counter left to exceed,
   *  only a project that either has been unlocked or has not. */
  | { allow: false; reason: "project_locked" };

export function decideExport(input: ExportDecisionInput): ExportVerdict {
  // Suspension outranks everything, exactly as it did under the old model:
  // a booted account gets nothing regardless of tier or unlock state.
  if (input.isSuspended) return { allow: false, reason: "suspended" };
  // CSV is free for any signed-in, non-suspended account. No pro check
  // needed - pro can never make an already-unlimited format more unlimited.
  if (input.format === "csv") return { allow: true };
  if (proBypass(input.pro, input.now)) return { allow: true };
  if (input.projectUnlocked) return { allow: true };
  return { allow: false, reason: "project_locked" };
}

// ---------------------------------------------------------------------------
// Script Mode project access: does this project get to call the `breakdown`
// function at all, for either mode (shots or call sheet). This is the
// free-tier meter - "2 projects, ever" (or whatever FREE_PROJECT_RESET_DAYS
// currently makes it) - and it is entirely separate from project_credits /
// unlock_project: a free-granted project gets Script Mode, never exports.
// ---------------------------------------------------------------------------

export interface ProjectAccessInput {
  isSuspended: boolean;
  pro: ProAccess;
  /** project_entitlements.unlocked_at is set - paid, unlimited. */
  projectUnlocked: boolean;
  /** project_entitlements.free_at is set - already spent a free slot on an
   *  earlier call to this SAME project. Only meaningful when a project id
   *  was supplied; see the id-less path in claim_project_access. */
  projectFreeGranted: boolean;
  freeProjectsUsed: number;
  freeProjectsLimit: number;
  now?: number;
}

export type ProjectAccessVerdict =
  | { allow: true; consumesFreeSlot: boolean }
  | { allow: false; reason: "suspended" }
  /** No free slots left, and this project has neither been unlocked nor
   *  already free-granted. The honest, final wall - see AccountScreen.tsx
   *  for the copy this drives. */
  | { allow: false; reason: "no_free_projects" };

export function decideProjectAccess(input: ProjectAccessInput): ProjectAccessVerdict {
  if (input.isSuspended) return { allow: false, reason: "suspended" };
  if (proBypass(input.pro, input.now)) return { allow: true, consumesFreeSlot: false };
  if (input.projectUnlocked) return { allow: true, consumesFreeSlot: false };
  if (input.projectFreeGranted) return { allow: true, consumesFreeSlot: false };
  if (input.freeProjectsUsed < input.freeProjectsLimit) return { allow: true, consumesFreeSlot: true };
  return { allow: false, reason: "no_free_projects" };
}
