import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";

// Clapper export gate. Server-authoritative counter for the pro editor-handoff
// exports (Premiere FCP7 XML, CSV) — separate 5-each free counters. No Groq, so
// no Turnstile, but still rate-limited + quota'd. Identity comes from the JWT.
// Returns an allow flag; the client generates the blob only when allow=true.
// The service-role key is used only server-side and never leaves this function.

const FREE_LIMIT = 5;
const PRO_LIMIT = 1000000;
const VALID_FORMATS = new Set(["premiere", "csv"]);

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clientIp(req: Request): string {
  const cf = req.headers.get("CF-Connecting-IP");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
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
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Sign in required" }), { status: 401, headers });
  }
  const userId = user.id;

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
  const { data: ipOk } = await admin.rpc("rate_limit_check", {
    p_key: "ip:" + ipHash,
    p_window_secs: 60,
    p_max: 30,
  });
  const { data: userOk } = await admin.rpc("rate_limit_check", {
    p_key: "u:" + userId,
    p_window_secs: 60,
    p_max: 20,
  });
  if (ipOk === false || userOk === false) {
    return new Response(
      JSON.stringify({ error: "Too fast — give it a moment." }),
      { status: 429, headers },
    );
  }

  // 4. Server-authoritative quota. Limit derived from is_pro, never the request.
  const { data: profile } = await admin
    .from("profiles")
    .select("is_pro")
    .eq("user_id", userId)
    .single();
  const limit = profile?.is_pro ? PRO_LIMIT : FREE_LIMIT;
  const { data: newCount } = await admin.rpc("consume_quota", {
    p_user: userId,
    p_kind: format,
    p_limit: limit,
  });

  if (newCount === -1 || newCount == null) {
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
      props: { format },
      ip_hash: ipHash,
    });
  } catch (_) { /* analytics is non-fatal */ }

  return new Response(
    JSON.stringify({ allow: true, remaining: limit - newCount }),
    { headers },
  );
});
