import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Clapper admin API. The server half of "boot users and do other admin
// stuff": list accounts with their usage and payment state, search, suspend,
// unsuspend, and read the suspension audit trail. Called by the separate
// clapper-analytics dashboard, never by the Clapper app itself - there is no
// admin UI in src/, and this function is how it stays that way.
//
// IDENTITY. There is no admin secret to leak, because there is no admin
// secret at all. The caller signs in the same way any Clapper user does (a
// normal Supabase session, same as every other function here) and sends that
// session's JWT. What makes them an admin is a row in public.admins, a table
// with RLS on and zero policies - unreadable and unwritable through the
// client API by anyone, including the admin themselves. The dashboard must
// hold a real access token for an account the owner has put in that table by
// hand (see the migration this ships with for the one-time SQL). A caller
// with no session, or a session that is not in that table, gets refused
// before any of the four actions below runs.
//
// The service-role key is used only inside this function and never leaves
// it. Every RPC this calls (is_admin, admin_suspend_user, admin_unsuspend_user,
// admin_list_accounts, admin_suspension_history) is granted to service_role
// only, so even a stolen anon/authenticated credential cannot reach any of
// this - the RLS default-deny this project uses everywhere is left exactly
// as it was; nothing here opens a table to `authenticated`.
//
// CORS. Deliberately not wired to _shared/cors.ts, which allowlists the
// public gh-pages app - widening that file for an admin endpoint would open
// every OTHER function's shared allowlist to whatever origin the dashboard
// runs on. This function expects to be called SERVER-SIDE, from the
// dashboard's own backend process with the admin's access token attached,
// not from a page loaded in a browser tab. If clapper-analytics is a browser
// SPA calling this directly instead, it needs its own explicit origin added
// to ADMIN_ALLOWED_ORIGINS below - do not add it to the app's allowlist.
const ADMIN_ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:4173",
]);

function adminCors(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Vary": "Origin",
  };
  if (origin && ADMIN_ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  // No origin match: the response carries no Access-Control-Allow-Origin at
  // all, so a browser refuses to hand the JSON to any page's script. A
  // server-side caller (no browser CORS enforcement in the way) is unaffected
  // either way - CORS never blocks the request from running, only a
  // browser's script from reading the reply.
  return headers;
}

type Action =
  | { action: "list"; search?: string; limit?: number; offset?: number }
  | { action: "suspend"; target_user_id?: string; reason?: string }
  | { action: "unsuspend"; target_user_id?: string; reason?: string }
  | { action: "history"; target_user_id?: string };

// A loose but real check - good enough to reject "drop everything" typos
// before they reach the database, not a validator. The RPCs themselves are
// the real gate (they raise on a target that does not exist), this just
// keeps a malformed value out of the query in the first place.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...adminCors(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Identity from the caller's JWT - same pattern as every other function
  // in this project. Nothing here is trusted from the request body.
  const authHeader = req.headers.get("Authorization");
  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authHeader ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return new Response(
      JSON.stringify({ error: "Sign in first.", code: "SIGNIN_REQUIRED" }),
      { status: 401, headers },
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // 2. Admin membership. A signed-in user is not an admin by default - most
  // Clapper accounts are paying customers, not operators, and this is the
  // check that keeps it that way. Anything below this line assumes the
  // caller is an admin; nothing above it does.
  const { data: isAdmin, error: adminErr } = await admin.rpc("is_admin", { p_user: user.id });
  if (adminErr || isAdmin !== true) {
    return new Response(
      JSON.stringify({ error: "Not authorized.", code: "not_admin" }),
      { status: 403, headers },
    );
  }

  // 3. Rate limit, same rate_limit_check RPC every mutating function in this
  // project already uses rather than a second mechanism. One window covers
  // every action an admin session takes through this function; mutations get
  // a second, tighter window on top, because "suspend everyone" is the one
  // mistake (bug, or a leaked token) this really has to slow down.
  const rateLimited = new Response(
    JSON.stringify({ error: "Too fast, give it a moment and try again." }),
    { status: 429, headers },
  );
  const { data: rateOk, error: rateErr } = await admin.rpc("rate_limit_check", {
    p_key: "admin:" + user.id,
    p_window_secs: 60,
    p_max: 30,
  });
  if (rateErr || rateOk === false) return rateLimited;

  let payload: Action;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }

  if (payload.action === "list") {
    const search = typeof payload.search === "string" && payload.search.trim() ? payload.search.trim() : null;
    const limit = Number.isFinite(payload.limit) ? Number(payload.limit) : 50;
    const offset = Number.isFinite(payload.offset) ? Number(payload.offset) : 0;
    const { data, error } = await admin.rpc("admin_list_accounts", {
      p_admin: user.id,
      p_search: search,
      p_limit: limit,
      p_offset: offset,
    });
    if (error) {
      console.error("admin-api: admin_list_accounts failed", error);
      return new Response(JSON.stringify({ error: "Could not list accounts." }), { status: 500, headers });
    }
    return new Response(JSON.stringify({ accounts: data ?? [] }), { headers });
  }

  if (payload.action === "history") {
    const target = typeof payload.target_user_id === "string" ? payload.target_user_id : "";
    if (!UUID_RE.test(target)) {
      return new Response(JSON.stringify({ error: "target_user_id must be a uuid." }), { status: 400, headers });
    }
    const { data, error } = await admin.rpc("admin_suspension_history", {
      p_admin: user.id,
      p_target: target,
    });
    if (error) {
      console.error("admin-api: admin_suspension_history failed", error);
      return new Response(JSON.stringify({ error: "Could not read suspension history." }), { status: 500, headers });
    }
    return new Response(JSON.stringify({ history: data ?? [] }), { headers });
  }

  if (payload.action === "suspend" || payload.action === "unsuspend") {
    // 3b. The tighter mutation window. Keyed separately from the read limit
    // above so a dashboard doing a lot of legitimate listing does not eat
    // into the budget meant to catch a suspend loop.
    const { data: mutateOk, error: mutateErr } = await admin.rpc("rate_limit_check", {
      p_key: "admin_mutate:" + user.id,
      p_window_secs: 60,
      p_max: 10,
    });
    if (mutateErr || mutateOk === false) return rateLimited;

    const target = typeof payload.target_user_id === "string" ? payload.target_user_id : "";
    if (!UUID_RE.test(target)) {
      return new Response(JSON.stringify({ error: "target_user_id must be a uuid." }), { status: 400, headers });
    }
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (!reason) {
      return new Response(JSON.stringify({ error: "A reason is required." }), { status: 400, headers });
    }

    const fn = payload.action === "suspend" ? "admin_suspend_user" : "admin_unsuspend_user";
    const { data, error } = await admin.rpc(fn, {
      p_admin: user.id,
      p_target: target,
      p_reason: reason,
    });
    if (error) {
      // The RPC raises rather than fails silently for "not an admin", "no
      // such user" and "reason is required" - all three are caller mistakes
      // (or the admin check disagreeing, which should never happen given the
      // check above, but the RPC re-checks on its own; see the migration).
      // Surfacing the message is safe: none of those three reveal anything
      // an admin caller does not already know.
      return new Response(JSON.stringify({ error: error.message }), { status: 400, headers });
    }
    return new Response(JSON.stringify({ ok: true, result: data }), { headers });
  }

  return new Response(JSON.stringify({ error: "Unknown action." }), { status: 400, headers });
});
