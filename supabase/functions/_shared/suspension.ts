// Shared suspension lookup for Clapper's two gated edge functions (breakdown,
// export-gate). One function, one policy, so the two call sites cannot drift
// into disagreeing about what a failed lookup means.
//
// WHY THIS IS A SEPARATE QUERY AND NOT A THIRD COLUMN IN THE is_pro SELECT.
// It used to be one select - `.select("is_pro, pro_until, is_suspended")` -
// and that was a live production bug, not a style problem. `is_suspended` does
// not exist in the live database (verified 2026-08-26 against
// information_schema: profiles has user_id, email, is_pro, created_at,
// pro_until, and nothing else). PostgREST resolves the whole column list
// before it runs anything, so naming one missing column fails the ENTIRE
// select with HTTP 400 / SQLSTATE 42703 and returns `data: null`. Both call
// sites read the result as `profile?.is_pro`, which is then `undefined` -
// so every Pro account silently collapsed to the free tier: free Script Mode
// limits in breakdown, and an outright "pro_only" refusal in export-gate for
// any format with no free allowance. One unapplied migration turned a paid
// feature off for the people who paid for it, and nothing logged an error
// because both call sites destructure `data` and discard `error`.
//
// Splitting the lookup contains the blast radius. The is_pro/pro_until select
// stays exactly as it was before is_suspended was ever added, so it cannot be
// broken by a column that has not shipped yet. This lookup asks for the new
// column on its own, and a failure here decides one thing only.
//
// THIS FAILS OPEN, DELIBERATELY. Any error - missing column, dropped
// connection, PostgREST having a bad minute - is treated as "not suspended".
// Suspension is an anti-abuse tool on an app with ten accounts, not a
// security boundary; nothing here protects data, it only declines to spend
// money on someone. A bug that lets one abuser run a breakdown for an hour
// costs a few cents. A bug that reads an error as "suspended" locks every
// paying user out of the feature they paid for, silently, until someone
// notices. The second failure is worse by orders of magnitude, so the error
// branch resolves to false.
//
// The auth/quota/rate-limit checks around this one are unaffected and still
// fail CLOSED, as they should - they are the actual boundary.

/** True only when the database positively says this account is suspended.
 * Any error, any missing row, any missing column resolves to false. */
export async function isSuspended(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("profiles")
      .select("is_suspended")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return false;
    return data?.is_suspended === true;
  } catch {
    // A thrown network error is the same answer as a returned one.
    return false;
  }
}
