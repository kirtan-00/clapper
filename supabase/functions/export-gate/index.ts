import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";

// Clapper export gate. Server-authoritative counter for the editor-handoff
// exports (Premiere FCP7 XML, Resolve FCPXML, CSV). No Groq, so no Turnstile,
// but still rate-limited + quota'd. Returns an allow flag; the client generates
// the blob only when allow=true. The service-role key is used only server-side
// and never leaves this function.
//
// ONE IDENTITY. A JWT means an account, counted per format in public.usage; no
// JWT is refused. The signed-out XML handoff that used to live here is gone —
// the app requires an account to do anything now, so there is nothing left for
// an anonymous caller to be offered.

// Effectively uncapped — what a valid Pro grant gets, on every format.
const PRO_LIMIT = 1000000;

// The free tier, per format. This replaces the flat 5-across-the-board the
// "for now" above was waiting on.
//
//   script    1   the expensive one — it calls Groq, and it is the feature Pro
//                 exists to sell. One is enough to prove it works on your own
//                 shot list, which is the only demo that convinces anybody.
//   premiere  3   XML, POOLED across Premiere and DaVinci Resolve. They share
//                 one counter deliberately: same handoff, same editor, and
//                 charging twice for choosing a different NLE is arbitrary.
//   pdf       5   NEW. PDF was ungated entirely — the one export a producer
//                 actually prints and hands round a unit was the only one
//                 nobody paid for.
//   csv       5   unchanged.
const FREE_LIMITS: Record<string, number> = {
  script: 1,
  premiere: 3,
  pdf: 5,
  csv: 5,
};

// Every format the gate knows. Kept as its own set rather than derived from
// FREE_LIMITS.keys(): a format Pro can use but the free tier cannot would
// otherwise be impossible to express.
const VALID_FORMATS = new Set(["premiere", "csv", "pdf"]);

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
  // A missing/expired session is NOT refused here any more: a signed-out
  // caller falls through to the anonymous path below, which counts against
  // their IP hash instead of a user id. `userId` being null IS the signal.
  const { data: { user } } = await userClient.auth.getUser();
  const userId: string | null = user?.id ?? null;

  // 2. Validate format.
  let payload: { format?: string };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }
  const format = (payload.format ?? "").trim();
  if (!VALID_FORMATS.has(format)) {
    return new Response(
      JSON.stringify({ error: "Invalid format" }),
      { status: 400, headers },
    );
  }

  // Service-role client: sole writer of counters + analytics. Never exposed.
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // 3. Rate limits: per-IP and per-user sliding windows.
  const ip = clientIp(req);
  const ipHash = await sha256Hex(ip + (Deno.env.get("IP_PEPPER") ?? "clapper"));
  const rateLimited = new Response(
    JSON.stringify({ error: "Too fast — give it a moment and try again." }),
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

  // 4. Server-authoritative quota. The limit is derived here, from identity —
  // never from the request body.
  let limit: number;
  let newCount: number | null;
  let quotaErr: unknown;

  // Signed out is simply out. The anonymous XML handoff that used to live here
  // is gone: the app now requires an account to do anything, so a signed-out
  // caller is either a stale tab or somebody poking the endpoint directly.
  //
  // This also removes a live trap. The anon path called `consume_anon_quota`,
  // and that function has never existed in production — the migration that
  // creates it was never applied. Deploying the old code as it stood would have
  // failed CLOSED on every signed-out export: HTTP 500, not a friendly wall.
  if (!userId) {
    return new Response(
      JSON.stringify({ error: "Sign in required", code: "SIGNIN_REQUIRED" }),
      { status: 401, headers },
    );
  }

  // Pro is a grant with a clock. `is_pro` alone cannot express "paid, ran out in
  // March", so an expired `pro_until` demotes to the free tier rather than
  // leaving someone uncapped forever off one payment. A NULL `pro_until` on an
  // is_pro account is treated as still valid — that is how the flag behaved
  // before the column existed, and silently cutting off early accounts would be
  // the worse failure.
  const { data: profile } = await admin
    .from("profiles")
    .select("is_pro, pro_until")
    .eq("user_id", userId)
    .maybeSingle();

  const proLapsed = profile?.pro_until != null &&
    new Date(profile.pro_until as string).getTime() <= Date.now();
  const isPro = profile?.is_pro === true && !proLapsed;

  limit = isPro ? PRO_LIMIT : (FREE_LIMITS[format] ?? 0);

  // A format with no free allowance is refused outright rather than counted to
  // zero, so the client can say "Pro only" instead of "you have used 0 of 0".
  if (limit <= 0) {
    return new Response(
      JSON.stringify({ allow: false, reason: "pro_only" }),
      { headers },
    );
  }

  {
    const res = await admin.rpc("consume_quota", {
      p_user: userId,
      p_kind: format,
      p_limit: limit,
    });
    newCount = res.data;
    quotaErr = res.error;
  }

  if (quotaErr || newCount == null) {
    // Fail CLOSED: an rpc error must never resolve to allow:true.
    return new Response(
      JSON.stringify({ allow: false, reason: "error" }),
      { status: 500, headers },
    );
  }
  if (newCount === -1) {
    return new Response(
      JSON.stringify({ allow: false, reason: "quota_exceeded" }),
      { headers },
    );
  }

  // 5. Allowed — log the export event (best-effort).
  try {
    await admin.from("events").insert({
      user_id: userId,
      name: "export",
      // `tier` replaces the old `anon` flag, which is now always false and so
      // measures nothing. What is worth knowing is which side of the paywall an
      // export came from: free exports are the ones running out.
      props: { format, tier: isPro ? "pro" : "free", left: limit - newCount },
      ip_hash: ipHash,
    });
  } catch (_) { /* analytics is non-fatal */ }

  return new Response(
    JSON.stringify({ allow: true, remaining: limit - newCount }),
    { headers },
  );
});
