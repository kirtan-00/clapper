import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";

// Clapper Script Mode backend. Identity comes from the caller's Supabase JWT
// (never a client-sent email). Flow: getUser -> Turnstile -> rate limits ->
// global Groq gate -> atomic quota consume -> Groq (Llama 3.3 70B) breakdown ->
// analytics event -> return a Clapper script pack the PWA imports directly.
// The service-role key is used only server-side and never leaves this function.

const DEFAULT_COVERAGE = ["WIDE", "MID", "CU", "OTS", "INSERT"];

// Cloudflare testing keys so local dev works without a real secret configured.
const DEV_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
const TURNSTILE_HOSTS = new Set(["kirtan-00.github.io", "localhost", "127.0.0.1"]);

const SYSTEM = [
  "You break a film/ad script into filmable SCENES for an on-set shot logger.",
  "A SCENE is one location+time setup (a slugline). Split the script into those.",
  "Return ONLY valid JSON, no prose, shape:",
  '{"scenes":[{"name":"SC n - INT/EXT. PLACE - TIME","summary":"one plain sentence","coverageTags":["WIDE","MID","CU","OTS","INSERT"],"keyMomentTags":["beat"]}]}',
  "RULES for keyMomentTags (the most important part):",
  "- Each must be a PHYSICAL, VISIBLE action or a spoken line that happens at ONE moment you could TAP on set.",
  "- Good: 'door slams', 'she raises voice', 'phone buzzes', 'walks into sunset', quote a distinctive line in quotes.",
  "- BANNED: abstract themes / emotions / summaries like 'belonging','emotional','friendship','nostalgia','introduction','conversation','narration'. Never output those.",
  "- Max 6 per scene. Keep each chip short (aim under 22 chars). Order them as they happen.",
  "coverageTags: pick the sensible subset of WIDE/MID/CU/OTS/INSERT for that scene (drop OTS from solo scenes, add INSERT only when there is an insert).",
].join("\n");

const FREE_LIMIT = 5;
const PRO_LIMIT = 1000000;

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

async function verifyTurnstile(
  token: string,
  ip: string,
): Promise<{ success: boolean; hostname?: string }> {
  const configured = Deno.env.get("TURNSTILE_SECRET");
  const secret = configured || DEV_TURNSTILE_SECRET;
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (ip) form.set("remoteip", ip);
  form.set("idempotency_key", crypto.randomUUID());
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const out = await r.json();
    return { success: !!out.success, hostname: out.hostname };
  } catch {
    return { success: false };
  }
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

  // 1. Identity from the caller's JWT (user-scoped client). Never trust body identity.
  const authHeader = req.headers.get("Authorization");
  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: authHeader ?? "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Sign in required" }), { status: 401, headers });
  }
  const userId = user.id;

  // 2. Parse + validate body (email removed).
  let payload: { text?: string; docName?: string; turnstileToken?: string };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }
  const text = (payload.text ?? "").trim();
  const docName = (payload.docName ?? "").slice(0, 200);
  const turnstileToken = (payload.turnstileToken ?? "").trim();
  if (text.length < 40) {
    return new Response(
      JSON.stringify({ error: "Script text is too short or the PDF had no readable text" }),
      { status: 400, headers },
    );
  }

  const groqKey = Deno.env.get("GROQ_API_KEY");
  if (!groqKey) {
    return new Response(
      JSON.stringify({ error: "Server not configured (GROQ_API_KEY missing)" }),
      { status: 500, headers },
    );
  }

  // 3. Turnstile. Require success; require a known hostname. In dev (no configured
  // secret) the testing key returns a non-matching hostname, so relax the host check.
  const ip = clientIp(req);
  const devTurnstile = !Deno.env.get("TURNSTILE_SECRET");
  const ts = await verifyTurnstile(turnstileToken, ip);
  const hostOk = devTurnstile || (ts.hostname != null && TURNSTILE_HOSTS.has(ts.hostname));
  if (!ts.success || !hostOk) {
    return new Response(JSON.stringify({ error: "Bot check failed" }), { status: 403, headers });
  }

  // Service-role client: sole writer of counters + analytics. Never exposed.
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // 4. Rate limits: per-IP and per-user sliding windows.
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

  // 5. Global Groq gate (kill-switch + daily cap). Reserve before spending Groq.
  const { data: gate } = await admin.rpc("script_mode_gate");
  if (!gate || !gate.allow) {
    return new Response(
      JSON.stringify({ error: "Script Mode is taking a breather — try again later." }),
      { status: 503, headers },
    );
  }

  // 6. Server-authoritative quota. Limit derived from is_pro, never the request.
  const { data: profile } = await admin
    .from("profiles")
    .select("is_pro")
    .eq("user_id", userId)
    .single();
  const limit = profile?.is_pro ? PRO_LIMIT : FREE_LIMIT;
  const { data: newCount } = await admin.rpc("consume_quota", {
    p_user: userId,
    p_kind: "script",
    p_limit: limit,
  });
  if (newCount === -1 || newCount == null) {
    return new Response(
      JSON.stringify({ error: "quota_exceeded" }),
      { status: 402, headers },
    );
  }

  // 7. Groq breakdown (unchanged prompt / logic).
  let scenes: any[] = [];
  try {
    const gr = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.2,
        max_tokens: 3000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text.slice(0, 12000) },
        ],
      }),
    });
    if (!gr.ok) {
      const errTxt = await gr.text();
      return new Response(
        JSON.stringify({ error: "Breakdown service error", detail: errTxt.slice(0, 300) }),
        { status: 502, headers },
      );
    }
    const gjson = await gr.json();
    const content = gjson.choices?.[0]?.message?.content ?? "{}";
    scenes = JSON.parse(content).scenes ?? [];
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Could not parse the breakdown", detail: String(e).slice(0, 200) }),
      { status: 502, headers },
    );
  }

  // Normalize into a Clapper script pack (unchanged shape).
  const packScenes = scenes.slice(0, 40).map((s: any, i: number) => ({
    scriptRef: `S${i + 1}`,
    name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : `SC ${i + 1}`,
    summary: typeof s.summary === "string" ? s.summary.trim() : "",
    order: i + 1,
    coverageTags: Array.isArray(s.coverageTags) && s.coverageTags.length
      ? s.coverageTags.slice(0, 5)
      : DEFAULT_COVERAGE,
    keyMomentTags: Array.isArray(s.keyMomentTags)
      ? s.keyMomentTags.slice(0, 6).map((t: any) => String(t).slice(0, 40))
      : [],
  }));

  const projectName = docName ? docName.replace(/\.pdf$/i, "") : "Imported script";
  const pack = {
    clapperScriptPack: 1,
    project: { name: projectName, coverageTags: DEFAULT_COVERAGE },
    scenes: packScenes,
  };

  // 8. Analytics event (service role). Best-effort, never blocks the response.
  try {
    await admin.from("events").insert({
      user_id: userId,
      name: "script_use",
      props: { scenes: packScenes.length, doc: docName || null },
      ip_hash: ipHash,
    });
  } catch (_) { /* analytics is non-fatal */ }

  return new Response(JSON.stringify({ ...pack, used: newCount, limit }), { headers });
});
