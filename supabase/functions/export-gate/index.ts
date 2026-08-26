import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";
import { isSuspended } from "../_shared/suspension.ts";
import { decideExport, type ExportFormat } from "../_shared/gate.ts";

// Clapper export gate. REWORKED 2026-08-27: this used to consume a
// per-format lifetime counter (Premiere/Resolve FCP7 XML 2, PDF 5, CSV 5)
// out of public.usage. That gated the LIGHTEST user first - a film student
// on one short hits the 2-XML cap on their only project, while a production
// house running twenty shoots pays exactly the same nothing - so the meter
// moved to PROJECTS, and this function stopped counting exports entirely.
//
// THE NEW RULE, IN FULL:
//   csv                free for any signed-in, non-suspended account,
//                       forever, no counter. It is the format that proves
//                       Clapper works without being the format that finishes
//                       the job - an editor still wants the XML and the
//                       printable PDF, a CSV is raw data somebody still has
//                       to do something with. Demonstrates value, creates
//                       the want the paid tier satisfies.
//   pdf, premiere       require the PROJECT to be unlocked: a credit spent
//                       via unlock_project (supabase/migrations/
//                       20260826170000_entitlements.sql), forever, once. Not
//                       gated by the free project grant - see
//                       _shared/products.ts, EXPORT_FORMATS_REQUIRING_UNLOCK.
//                       No counter either: an unlocked project gets every
//                       format, uncapped, permanently.
//
// So this function no longer consumes anything. It READS is_pro/pro_until
// (unchanged), reads whether the named project is unlocked, and answers
// yes/no - see decideExport in _shared/gate.ts, which is also what
// src/net/gate.test.ts exercises directly, since this file cannot be unit
// tested (it is a Deno edge function, not importable by vitest).
//
// ONE IDENTITY. A JWT means an account; no JWT is refused. The signed-out XML
// handoff that used to live here is gone - the app requires an account to do
// anything now, so there is nothing left for an anonymous caller to be
// offered.

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // 1. Identity from the caller's JWT.
  const authHeader = req.headers.get("Authorization");
  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authHeader ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  const userId: string | null = user?.id ?? null;

  // 2. Validate format + read the (optional for csv, required for pdf/
  // premiere) project id. The id is a client-chosen string, never trusted
  // for anything beyond being a lookup key scoped to this JWT's user id -
  // same trust model as breakdown's projectId and project_entitlements
  // itself (see that table's comment in 20260826170000).
  let payload: { format?: string; projectId?: string };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }
  const format = (payload.format ?? "").trim();
  if (format !== "csv" && format !== "pdf" && format !== "premiere") {
    return new Response(
      JSON.stringify({ error: "Invalid format" }),
      { status: 400, headers },
    );
  }
  const projectId = typeof payload.projectId === "string" ? payload.projectId.trim().slice(0, 64) : "";

  // Service-role client: sole reader of unlock state, sole writer of
  // analytics. Never exposed.
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // 3. Rate limits: per-IP and per-user sliding windows. Unrelated to
  // pricing - this is anti-abuse and untouched by the rework.
  const ip = clientIp(req);
  const ipHash = await sha256Hex(ip + (Deno.env.get("IP_PEPPER") ?? "clapper"));
  const rateLimited = new Response(
    JSON.stringify({ error: "Too fast - give it a moment and try again." }),
    { status: 429, headers },
  );
  const { data: ipOk, error: ipErr } = await admin.rpc("rate_limit_check", {
    p_key: "ip:" + ipHash,
    p_window_secs: 60,
    p_max: 30,
  });
  if (ipErr || ipOk === false) return rateLimited;
  if (userId) {
    const { data: userOk, error: userErr } = await admin.rpc("rate_limit_check", {
      p_key: "u:" + userId,
      p_window_secs: 60,
      p_max: 20,
    });
    if (userErr || userOk === false) return rateLimited;
  }

  // Signed out is simply out. The app requires an account to do anything now,
  // so a signed-out caller here is either a stale tab or somebody poking the
  // endpoint directly.
  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Sign in required", code: "SIGNIN_REQUIRED" }),
      { status: 401, headers },
    );
  }

  // 4. Pro + suspension. Read separately from each other and from the unlock
  // lookup below, on purpose: a select naming a column the live database
  // does not yet have fails the WHOLE select (PostgREST 42703), and this
  // codebase has already been bitten by that twice locking out the people
  // who paid (see _shared/suspension.ts, and breakdown/index.ts's matching
  // comment). Keeping is_pro/pro_until, is_suspended and the project lookup
  // as three independent reads means a problem with one can never silently
  // make another read the wrong answer.
  const { data: profile } = await admin
    .from("profiles")
    .select("is_pro, pro_until")
    .eq("user_id", userId)
    .maybeSingle();

  if (await isSuspended(admin, userId)) {
    return new Response(
      JSON.stringify({ allow: false, reason: "suspended" }),
      { headers },
    );
  }

  // 5. Is the named project unlocked? Only meaningful for pdf/premiere - csv
  // never reads this, and decideExport ignores it for that format - but the
  // lookup runs unconditionally because it is cheap and keeps the code
  // simple. An absent/empty projectId reads as NOT unlocked (a client asking
  // for pdf/premiere with no project named has nothing to be unlocked).
  let projectUnlocked = false;
  if (projectId) {
    const { data: entitlement } = await admin
      .from("project_entitlements")
      .select("unlocked_at")
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .maybeSingle();
    projectUnlocked = entitlement?.unlocked_at != null;
  }

  const verdict = decideExport({
    format: format as ExportFormat,
    isSuspended: false, // already checked and returned above
    pro: { isPro: profile?.is_pro === true, proUntil: (profile?.pro_until as string | null) ?? null },
    projectUnlocked,
  });

  if (!verdict.allow) {
    return new Response(JSON.stringify(verdict), { headers });
  }

  // 6. Allowed - log the export event (best-effort). `tier` and `unlocked`
  // replace the old `left` field: there is no countdown left to report, only
  // which side of the paywall this export came from.
  try {
    await admin.from("events").insert({
      user_id: userId,
      name: "export",
      props: {
        format,
        tier: profile?.is_pro === true ? "pro" : projectUnlocked ? "unlocked" : "free",
      },
      ip_hash: ipHash,
    });
  } catch (_) { /* analytics is non-fatal */ }

  return new Response(JSON.stringify({ allow: true }), { headers });
});

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string {
  const cf = req.headers.get("CF-Connecting-IP");
  if (cf) return cf.trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  // Prefer the LAST hop of x-forwarded-for: upstream proxies append the true
  // client, so the first entry is the one a client can spoof.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",");
    return parts[parts.length - 1].trim();
  }
  return "";
}
