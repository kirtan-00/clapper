import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";

// Clapper export gate. Server-authoritative counter for the editor-handoff
// exports (Premiere FCP7 XML, Resolve FCPXML, CSV). No Groq, so no Turnstile,
// but still rate-limited + quota'd. Returns an allow flag; the client generates
// the blob only when allow=true. The service-role key is used only server-side
// and never leaves this function.
//
// TWO IDENTITIES, two counters. A JWT means an account, counted in
// public.usage and currently uncapped. NO JWT is no longer refused: the XML
// handoff is offered signed-out, counted in public.anon_usage against the hash
// of the caller's IP (see the 20260801 migration for what that key is and is
// not worth). Every other format still needs an account.

// Effectively uncapped. Signed-in accounts currently get this for EVERY
// format regardless of is_pro — a deliberate "for now", not a bug: the only
// wall right now is the signed-out one below, and signing in is the thing it
// is pushing people toward. Reintroducing a free-tier ceiling means giving
// non-pro accounts their own limits map again, nothing more.
const PRO_LIMIT = 1000000;

// What a caller with NO account gets: 3 XML exports (Premiere FCP7 XML and
// Resolve FCPXML share the "premiere" counter, so 3 across both, not 3 each),
// counted against the hash of their IP.
//
// An IP is not a person. A crew sharing one set wifi shares ONE allowance, and
// the same phone on mobile data gets a fresh one. That is understood and
// accepted — this is a nudge toward signing in, not an entitlement boundary.
const ANON_LIMITS: Record<string, number> = { premiere: 3 };

// Every format the gate knows. CSV is deliberately absent from ANON_LIMITS
// above: it needs an account, and asking for it signed-out is refused rather
// than counted.
const VALID_FORMATS = new Set(["premiere", "csv"]);

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

  if (userId) {
    limit = PRO_LIMIT;
    const res = await admin.rpc("consume_quota", {
      p_user: userId,
      p_kind: format,
      p_limit: limit,
    });
    newCount = res.data;
    quotaErr = res.error;
  } else {
    // Signed out. Only the XML handoff is on offer; anything else needs an
    // account and is refused rather than counted.
    if (!(format in ANON_LIMITS)) {
      return new Response(JSON.stringify({ error: "Sign in required" }), { status: 401, headers });
    }
    // No usable IP means no key to count against, and a blank key would put
    // every un-identifiable caller in one shared bucket. Fail CLOSED: refuse
    // the export rather than hand out an uncounted one.
    if (!ip) {
      return new Response(JSON.stringify({ error: "Sign in required" }), { status: 401, headers });
    }
    limit = ANON_LIMITS[format];
    const res = await admin.rpc("consume_anon_quota", {
      p_ip_hash: ipHash,
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
      // `anon` is the whole point of measuring this: it is the only way to see
      // how many people hit the signed-out wall versus sail past it.
      props: { format, anon: !userId },
      ip_hash: ipHash,
    });
  } catch (_) { /* analytics is non-fatal */ }

  return new Response(
    JSON.stringify({ allow: true, remaining: limit - newCount }),
    { headers },
  );
});
