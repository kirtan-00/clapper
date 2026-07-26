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
const TURNSTILE_HOSTS = new Set(["clapboard.duckdns.org", "kirtan-00.github.io"]);

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

const SYSTEM_CALLSHEET = [
  "You read a film CALL SHEET and pick which of the project's known scenes are shooting TODAY, in shooting order.",
  "You will be given a JSON list of known scenes, each with a ref and a name, like:",
  '[{"ref":"S14","name":"SC 14 - INT. CHAI STALL - DAY"}, ...]',
  "Return ONLY valid JSON, no prose, shape:",
  '{"today":[{"ref":"S14","order":1},{"ref":"S22","order":2}]}',
  "RULES:",
  "- Every returned ref MUST be one of the provided refs — match by scene number / slugline between the call sheet and the known scene names.",
  "- Put them in the call sheet's shooting order (order starts at 1).",
  "- If a scene on the call sheet isn't in the known list, skip it.",
  "- If nothing matches, return {\"today\":[]}.",
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
  let payload: {
    text?: string;
    docName?: string;
    turnstileToken?: string;
    mode?: string;
    scenes?: { ref?: string; name?: string }[];
  };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }
  const text = (payload.text ?? "").trim();
  const docName = (payload.docName ?? "").slice(0, 200);
  const turnstileToken = (payload.turnstileToken ?? "").trim();
  const mode: "script" | "callsheet" = payload.mode === "callsheet" ? "callsheet" : "script";
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

  // 3. Turnstile. In dev (no configured secret, or the Cloudflare dummy secret)
  // skip verification entirely. In prod, require success AND a known hostname.
  const ip = clientIp(req);
  const tsSecret = Deno.env.get("TURNSTILE_SECRET");
  const devTurnstile = !tsSecret || tsSecret === DEV_TURNSTILE_SECRET;
  if (!devTurnstile) {
    const ts = await verifyTurnstile(turnstileToken, ip);
    const hostOk = ts.hostname != null && TURNSTILE_HOSTS.has(ts.hostname);
    if (!ts.success || !hostOk) {
      return new Response(JSON.stringify({ error: "Bot check failed" }), { status: 403, headers });
    }
  }

  // Service-role client: sole writer of counters + analytics. Never exposed.
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // 4. Rate limits: per-IP and per-user sliding windows. Fail CLOSED — an rpc
  // error OR a false result is treated as rate-limited.
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
  const { data: userOk, error: userErr } = await admin.rpc("rate_limit_check", {
    p_key: "u:" + userId,
    p_window_secs: 60,
    p_max: 20,
  });
  if (userErr || userOk === false) return rateLimited;

  // 5. Server-authoritative quota — consumed BEFORE the global gate so the gate
  // check never touches a user's lifetime slot. Limit derived from is_pro.
  const { data: profile } = await admin
    .from("profiles")
    .select("is_pro")
    .eq("user_id", userId)
    .single();
  const limit = profile?.is_pro ? PRO_LIMIT : FREE_LIMIT;
  const { data: newCount, error: quotaErr } = await admin.rpc("consume_quota", {
    p_user: userId,
    p_kind: "script",
    p_limit: limit,
  });
  if (quotaErr || newCount == null) {
    // Fail CLOSED: never let a broken counter hand out free breakdowns.
    return new Response(
      JSON.stringify({ error: "Server error — try again in a moment." }),
      { status: 500, headers },
    );
  }
  if (newCount === -1) {
    return new Response(
      JSON.stringify({ error: "quota_exceeded" }),
      { status: 402, headers },
    );
  }

  // 6. Global Groq gate (kill-switch + daily cap). If it denies, refund the slot
  // we just consumed so a paused service does not burn a user's lifetime quota.
  const { data: gate, error: gateErr } = await admin.rpc("script_mode_gate");
  if (gateErr || !gate || !gate.allow) {
    await admin.rpc("refund_quota", { p_user: userId, p_kind: "script" });
    return new Response(
      JSON.stringify({ error: "Script Mode is taking a breather — try again later." }),
      { status: 503, headers },
    );
  }

  // Callsheet mode: sanitize the known-scenes list the client sent (project's
  // already-known scenes), used both in the Groq prompt and for validation.
  const knownScenes = (Array.isArray(payload.scenes) ? payload.scenes : [])
    .filter((s): s is { ref?: string; name?: string } => !!s && typeof s.ref === "string" && s.ref.trim().length > 0)
    .slice(0, 200)
    .map((s) => ({ ref: s.ref!.trim(), name: typeof s.name === "string" ? s.name.trim() : "" }));
  const knownRefs = new Set(knownScenes.map((s) => s.ref));

  const userContent = mode === "callsheet"
    ? "KNOWN SCENES:\n" + JSON.stringify(knownScenes) + "\n\nCALL SHEET:\n" + text.slice(0, 12000)
    : text.slice(0, 12000);

  // 7. Groq breakdown (unchanged prompt / logic for script mode).
  let scenes: any[] = [];
  let today: any[] = [];
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
          { role: "system", content: mode === "callsheet" ? SYSTEM_CALLSHEET : SYSTEM },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!gr.ok) {
      const errTxt = await gr.text();
      // Groq outage must not burn the user's lifetime slot — refund it.
      await admin.rpc("refund_quota", { p_user: userId, p_kind: "script" });
      return new Response(
        JSON.stringify({ error: "Breakdown service error", detail: errTxt.slice(0, 300) }),
        { status: 502, headers },
      );
    }
    const gjson = await gr.json();
    const content = gjson.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    if (mode === "callsheet") {
      today = Array.isArray(parsed.today) ? parsed.today : [];
    } else {
      scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
    }
  } catch (e) {
    // Groq/parse failure must not burn the user's lifetime slot — refund it.
    await admin.rpc("refund_quota", { p_user: userId, p_kind: "script" });
    return new Response(
      JSON.stringify({ error: "Could not parse the breakdown", detail: String(e).slice(0, 200) }),
      { status: 502, headers },
    );
  }

  if (mode === "callsheet") {
    // Validate: every ref must be one of the provided known refs, coerce order
    // to a number, then re-sort/re-number 1..n and clamp to 60 entries.
    const validToday = today
      .filter((t: any) => t && typeof t.ref === "string" && t.ref.trim() && knownRefs.has(t.ref.trim()))
      .map((t: any) => ({ ref: t.ref.trim(), order: Number(t.order) || 0 }))
      .sort((a, b) => a.order - b.order)
      .slice(0, 60)
      .map((t, i) => ({ ref: t.ref, order: i + 1 }));

    // 8. Analytics event (service role). Best-effort, never blocks the response.
    try {
      await admin.from("events").insert({
        user_id: userId,
        name: "script_use",
        props: { mode, today: validToday.length, doc: docName || null },
        ip_hash: ipHash,
      });
    } catch (_) { /* analytics is non-fatal */ }

    return new Response(
      JSON.stringify({ callSheet: 1, today: validToday, used: newCount, limit }),
      { headers },
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
      props: { scenes: packScenes.length, doc: docName || null, mode },
      ip_hash: ipHash,
    });
  } catch (_) { /* analytics is non-fatal */ }

  return new Response(JSON.stringify({ ...pack, used: newCount, limit }), { headers });
});
