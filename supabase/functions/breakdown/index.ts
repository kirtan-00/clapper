import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";

// Clapper Script Mode backend. Identity comes from the caller's Supabase JWT
// (never a client-sent email). Flow: getUser -> Turnstile -> rate limits ->
// global Groq gate -> atomic quota consume -> Groq (Llama 3.3 70B) -> analytics
// event -> answer. The service-role key is used only server-side and never
// leaves this function.
//
// Two modes, both judgement-only. The app no longer asks a model to READ a
// document: `src/ui/shotlist.ts` parses the shotlist deterministically
// on-device, so the model never sees the script and never transcribes a table.
//   'shots'     — given the already-parsed shot division, write the tappable
//                 key-moment chips for each shot.
//   'callsheet' — given the project's known scenes, say which shoot today.
// The old 'script' mode (whole screenplay -> scenes) is retired: the device
// parser replaced it, and nothing calls it.

// Cloudflare testing keys so local dev works without a real secret configured.
const DEV_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA";
const TURNSTILE_HOSTS = new Set(["clapboard.duckdns.org", "kirtan-00.github.io"]);

const SYSTEM_SHOTS = [
  "You are given a JSON list of camera SHOTS already broken down from a shotlist. Each has a code, and some of: size, move, action, dialogue.",
  "For each shot, write its KEY MOMENTS: the beats an operator would tap on a phone the instant they happen while that shot is rolling.",
  "Return ONLY valid JSON, no prose, shape:",
  '{"shots":[{"code":"5.31","keyMoments":["hurls mug","mug shatters"]}]}',
  "RULES — the count rule is the one people get wrong, so read it twice:",
  "- 0 to 3 moments per shot. ZERO IS A CORRECT ANSWER, and it is the common one.",
  "- Most shots are one simple action and need one chip, or none at all. Do NOT pad.",
  "- A shot whose action is 'Ansh, flat.' has no tappable beat inside it. Return [] for it.",
  "- 137 shots each padded with three invented chips is unusable on a phone. Restraint is the job.",
  "- Each moment must be a PHYSICAL, VISIBLE beat, or a spoken line, that happens INSIDE THAT ONE SHOT.",
  "- Good: 'door slams', 'she raises voice', 'phone buzzes', 'mug shatters', 'walks into sunset'. Quote a distinctive spoken line in quotes.",
  "- BANNED: abstract themes / emotions / summaries like 'belonging','emotional','friendship','nostalgia','introduction','conversation','narration'. Never output those.",
  "- Never restate the shot's size or move ('MCU', 'push in', 'handheld') — those are already on the slate.",
  "- Keep each chip short (under 22 chars), and order them as they happen within the shot.",
  "- Use only what that shot's own action and dialogue say. Never borrow action from a neighbouring shot.",
  "- Return every code you were given, in the order given, with \"keyMoments\":[] where there is nothing to tap. Never invent a code.",
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

// A call sheet is one page of text; 12k has always been ample.
const CALLSHEET_INPUT_CAP = 12000;
// Shots mode sends structured JSON, not extracted text, so it is capped by
// entry count and by serialised size — and an oversized payload is REFUSED, not
// truncated: cutting a JSON array mid-element is worse than saying no.
const MAX_BRIEFS = 400;
const MAX_BRIEF_PAYLOAD = 60000;
// Field clamps, mirroring ScriptPackShot in src/ui/scriptpack.ts.
const MAX_CODE = 12;
const MAX_SIZE = 24;
const MAX_MOVE = 40;
const MAX_ACTION = 160;
const MAX_DIALOGUE = 200;
// The on-phone contract: at most 3 short chips a shot.
const MAX_MOMENTS_PER_SHOT = 3;
const MAX_MOMENT = 22;
// 400 shots x ~25 tokens of reply is ~10k, so 12k covers the worst payload we
// accept. A reply cut off mid-JSON fails to parse and costs the user a retry.
const MAX_OUTPUT_TOKENS_SHOTS = 12000;
const MAX_OUTPUT_TOKENS_CALLSHEET = 3000;

/**
 * A model- or client-supplied string, or undefined. Anything that isn't a
 * string (number, null, object, array) is dropped rather than stringified — a
 * `{}` in the size cell must not reach the operator as "[object Object]".
 */
function cleanStr(v: any, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : undefined;
}

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
    shots?: { code?: string; size?: string; move?: string; action?: string; dialogue?: string }[];
  };
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }
  const text = (payload.text ?? "").trim();
  const docName = (payload.docName ?? "").slice(0, 200);
  const turnstileToken = (payload.turnstileToken ?? "").trim();
  // Explicit mode only. A missing or unknown mode is the retired 'script' path
  // (or a typo) — say so plainly instead of silently falling through.
  const mode: "shots" | "callsheet" | null = payload.mode === "shots"
    ? "shots"
    : payload.mode === "callsheet"
    ? "callsheet"
    : null;
  if (!mode) {
    return new Response(
      JSON.stringify({ error: "Unknown mode — expected 'shots' or 'callsheet'." }),
      { status: 400, headers },
    );
  }

  // Shots mode: sanitize the parsed shot list the client sent. Same posture as
  // the callsheet scene list below — require a real code, clamp every field,
  // drop duplicates, and keep the surviving codes as the set the model's reply
  // is checked against. All of this runs BEFORE the quota is consumed, so a
  // malformed payload never costs the user a slot.
  const briefSeen = new Set<string>();
  const briefs: { code: string; size?: string; move?: string; action?: string; dialogue?: string }[] = [];
  if (mode === "shots") {
    const raw = Array.isArray(payload.shots) ? payload.shots : [];
    for (const s of raw) {
      if (briefs.length >= MAX_BRIEFS) break;
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const code = cleanStr(s.code, MAX_CODE);
      if (!code || briefSeen.has(code)) continue;
      briefSeen.add(code);
      const brief: { code: string; size?: string; move?: string; action?: string; dialogue?: string } = { code };
      const size = cleanStr(s.size, MAX_SIZE);
      const move = cleanStr(s.move, MAX_MOVE);
      const action = cleanStr(s.action, MAX_ACTION);
      const dialogue = cleanStr(s.dialogue, MAX_DIALOGUE);
      if (size) brief.size = size;
      if (move) brief.move = move;
      if (action) brief.action = action;
      if (dialogue) brief.dialogue = dialogue;
      briefs.push(brief);
    }
    if (!briefs.length) {
      return new Response(
        JSON.stringify({ error: "No shots to enrich — send a parsed shotlist." }),
        { status: 400, headers },
      );
    }
  }
  const briefJson = mode === "shots" ? JSON.stringify(briefs) : "";
  if (briefJson.length > MAX_BRIEF_PAYLOAD) {
    return new Response(
      JSON.stringify({
        error: "That shotlist is too big to enrich in one call. Split it and upload again.",
      }),
      { status: 400, headers },
    );
  }
  if (mode === "callsheet" && text.length < 40) {
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
    ? "KNOWN SCENES:\n" + JSON.stringify(knownScenes) + "\n\nCALL SHEET:\n" +
      text.slice(0, CALLSHEET_INPUT_CAP)
    : "SHOTS:\n" + briefJson;

  // 7. Groq. Both modes are judgement calls over structured input, never a
  // transcription of the document itself.
  let shotMoments: any[] = [];
  let today: any[] = [];
  try {
    const gr = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.2,
        max_tokens: mode === "callsheet" ? MAX_OUTPUT_TOKENS_CALLSHEET : MAX_OUTPUT_TOKENS_SHOTS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: mode === "callsheet" ? SYSTEM_CALLSHEET : SYSTEM_SHOTS },
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
      shotMoments = Array.isArray(parsed.shots) ? parsed.shots : [];
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

  // Shots mode. Validate the model's reply against the codes we actually sent:
  // build a map of the moments it returned, then walk the ORIGINAL briefs to
  // emit the answer. Driving off the briefs rather than the reply means an
  // invented code cannot get in, a duplicated code collapses, and the order is
  // the order the client asked in — for free.
  const momentsByCode = new Map<string, string[]>();
  for (const s of shotMoments) {
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    // A model handed codes like "5.31" sometimes emits them as JSON numbers.
    const rawCode = typeof s.code === "number" && Number.isFinite(s.code) ? String(s.code) : s.code;
    const code = cleanStr(rawCode, MAX_CODE);
    if (!code || !briefSeen.has(code) || momentsByCode.has(code)) continue;
    const moments = (Array.isArray(s.keyMoments) ? s.keyMoments : [])
      .map((m: any) => cleanStr(m, MAX_MOMENT))
      .filter((m: string | undefined): m is string => !!m)
      .slice(0, MAX_MOMENTS_PER_SHOT);
    momentsByCode.set(code, moments);
  }
  // Empty entries are dropped: the client applies chips by code and treats a
  // missing code as "no chips", so shipping hundreds of empty arrays back to a
  // phone would be pure weight. Zero moments is a correct answer, not a gap.
  const validShots = briefs
    .map((b) => ({ code: b.code, keyMoments: momentsByCode.get(b.code) ?? [] }))
    .filter((s) => s.keyMoments.length > 0);
  const momentCount = validShots.reduce((n, s) => n + s.keyMoments.length, 0);

  // Nothing usable came back for ANY shot — the model ignored the schema rather
  // than exercised restraint. The call bought the user nothing, so refund the
  // slot. Still a 200: the client keeps its correctly-parsed shotlist, chipless.
  let used = newCount;
  if (!validShots.length) {
    await admin.rpc("refund_quota", { p_user: userId, p_kind: "script" });
    used = Math.max(0, Number(newCount) - 1);
  }

  // 8. Analytics event (service role). Best-effort, never blocks the response.
  try {
    await admin.from("events").insert({
      user_id: userId,
      name: "script_use",
      props: {
        mode,
        shots: briefs.length,
        enriched: validShots.length,
        moments: momentCount,
        doc: docName || null,
      },
      ip_hash: ipHash,
    });
  } catch (_) { /* analytics is non-fatal */ }

  return new Response(JSON.stringify({ shots: validShots, used, limit }), { headers });
});
