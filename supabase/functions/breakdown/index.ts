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
// clapboard.duckdns.org is kept alongside the new home for the same reason it
// is kept in _shared/cors.ts: an installed PWA keeps the origin it was added
// from, so a pre-move install still presents the old hostname in its Turnstile
// token. Dropping it would fail CAPTCHA validation - and therefore Script Mode
// - for the people who installed Clapper earliest.
const TURNSTILE_HOSTS = new Set([
  "clapper.in",
  "www.clapper.in",
  "clapboard.duckdns.org",
  "kirtan-00.github.io",
]);

const SYSTEM_SHOTS = [
  "You are given a JSON list of camera SHOTS already broken down from a shotlist. Each has a code, and some of: size, move, action, dialogue.",
  "For each shot, write its KEY MOMENTS: the beats an operator would tap on a phone the instant they happen while that shot is rolling.",
  "Return ONLY valid JSON, no prose, shape:",
  '{"shots":[{"code":"5.31","keyMoments":["hurls mug","mug shatters"]}]}',
  "HOW MANY — the count rule is the one people get wrong, so read it twice:",
  "- Aim for 1 to 3 moments per shot. ONE GOOD CHIP IS THE NORMAL ANSWER.",
  "- Every shot is doing something — a camera move, a person's action, a specific beat. Pulling one tag out of it should not be hard.",
  "- If the row has an action line, it HAS a beat. Name the beat; do not skip the shot.",
  "- Reach for [] ONLY when the row genuinely has no filmable beat inside it: a title card, a superimposition, a fade, a slug with no action.",
  "- Still never pad to three. One precise chip beats three vague ones, and 137 shots x three invented chips is unusable on a phone.",
  "WHAT COUNTS:",
  "- Each moment must be a PHYSICAL, VISIBLE beat, or a spoken line, that happens INSIDE THAT ONE SHOT.",
  "- Good: 'door slams', 'she raises voice', 'phone buzzes', 'mug shatters', 'walks into sunset'. Quote a distinctive spoken line in quotes.",
  "- BANNED: abstract themes / emotions / summaries like 'belonging','emotional','friendship','nostalgia','introduction','conversation','narration'. Never output those. This is the most important constraint: a chip is a physical visible thing or a spoken line, never a theme or a mood.",
  "- Use only what that shot's own action and dialogue say. Never borrow action from a neighbouring shot.",
  "HOW TO WRITE IT:",
  "- NO ABBREVIATIONS IN CHIP TEXT. Chips get tapped at 5am under a work light, where 'ECU' and 'MCU' are one character apart.",
  "- Never emit CU, MCU, ECU, WS, XWS, MWS, MS, OTS, POV — or any other trade shorthand — as chip text.",
  "- When a size or framing really does belong in a chip, SPELL IT: closeup, medium closeup, extreme closeup, wide, extreme wide, medium wide, medium, over shoulder, point of view.",
  "- The same goes for every other abbreviation: write 'push in', not 'PI'; 'handheld', not 'HH'.",
  "- Do not restate the shot's own size or move as a chip — the slate already carries them, so a shot marked MCU / PUSH IN needs no chip saying so. The spelling rule above is the backstop for when a framing legitimately belongs inside a chip anyway.",
  "- Keep each chip short (under 22 chars), and order them as they happen within the shot.",
  "- Return every code you were given, in the order given, with \"keyMoments\":[] where there is nothing to tap. Never invent a code.",
  "WORKED EXAMPLES, from a shipped shotlist — match this target:",
  '4.14 MS High / from balcony — "She sets the coffee down hard enough that it slops over, storms back inside without a word." -> ["coffee slops","storms inside"]',
  '1.1 XWS STATIC, low — "Terrace at night, string lights, a ring light glowing on its stand." -> ["ring light glow"]   (an establisher still has one thing to mark)',
  "1.21 — Superimpose — \"Title Card: KEEP THE TAKE\" -> []   (genuinely nothing to tap)",
  '3.6 CU STATIC — Maya, not having it. "Dev." -> ["\\"Dev.\\""]',
  "Note those inputs carry XWS / MS / CU, and not one chip repeats them.",
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
// The on-phone contract: at most 3 short chips a shot. The prompt asks for
// under 22 chars, and the clamp sits at 28 so it stays a backstop rather than a
// routine editor — chips must spell sizes out ("extreme closeup", 15, not
// "ECU"), and composed ones like "extreme closeup on eyes" (23) or "point of
// view through glass" (27) would otherwise be sliced mid-word.
const MAX_MOMENTS_PER_SHOT = 3;
const MAX_MOMENT = 28;
// The model, named once. It was previously written inline at the single call
// site, which was fine until the dashboard started reporting cost per model:
// a number attributed to the wrong model name is worse than no number, and a
// second call site added later would have silently drifted.
const GROQ_MODEL = "llama-3.3-70b-versatile";

const MAX_OUTPUT_TOKENS_CALLSHEET = 3000;

// Shots-mode batching. Groq's free tier counts RESERVED output tokens against
// tokens-per-minute, so the old single call reserved 12,000 for a reply that
// would never exceed a few hundred and got itself refused at the door.
//
// 40 shots a batch amortises the system prompt (~1k tokens, paid once per call)
// over enough rows to be worth sending, while keeping any one request near 5k
// tokens — comfortably inside even the free tier's 12k ceiling.
const SHOT_BATCH = 40;
// Three chips of under 28 characters, plus the JSON around them, is ~20 tokens.
// 30 is headroom, not a target, and it is what we RESERVE per shot.
const OUTPUT_TOKENS_PER_SHOT = 30;
// No artificial gap between batches: we let the rate limiter tell us when to
// wait rather than guessing. That way a paid tier runs at full speed and the
// free tier self-throttles, from the same code.
const SHOT_RETRY_MS = 8000;
const SHOT_MAX_RETRIES = 3;
// Leave room under the platform's wall clock. On a long film the free tier's
// TPM ceiling means we may not finish; we return the chips we did earn.
const SHOT_TIME_BUDGET_MS = 100000;

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

/**
 * A chip, trimmed to fit. The prompt asks for under 22 characters, but a model
 * handed a long line of dialogue will hand it straight back, and a hard slice
 * turns `"Thodi der mein woh aayegi, tension mat lo."` into
 * `"Thodi der mein woh aayegi..` — cut mid-word, quote left hanging open. On a
 * chip at arm's length that reads as a rendering fault.
 *
 * So: cut at a word boundary, drop the trailing punctuation the cut exposed,
 * mark the elision, and close the quote if we opened one.
 */
function tidyMoment(v: any): string | undefined {
  // Models asked for JSON sometimes escape a quote twice and the surviving
  // backslash rides all the way to the chip: \"Character mat todo.\ . No chip
  // legitimately contains a backslash, so they all go.
  const t = cleanStr(typeof v === "string" ? v.replace(/\\/g, "") : v, 400);
  if (!t) return undefined;
  if (t.length <= MAX_MOMENT) {
    // Stripping a backslash can leave an opening quote without its partner.
    return /^"/.test(t) && (t.match(/"/g) ?? []).length % 2 === 1 ? `${t}"` : t;
  }
  const quoted = /^["“']/.test(t);
  // Two characters of the budget are spent on the ellipsis and closing quote.
  let cut = t.slice(0, MAX_MOMENT - 2);
  const lastSpace = cut.lastIndexOf(" ");
  // Only honour a word boundary that leaves something readable behind.
  if (lastSpace > 8) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s.,;:!?"“”']+$/, "");
  if (!cut) return undefined;
  return quoted ? `${cut}…"` : `${cut}…`;
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
    .select("is_pro, is_suspended")
    .eq("user_id", userId)
    .single();

  // A booted account is refused before a slot is ever consumed and before this
  // call ever reaches Groq. Script Mode is the expensive feature, and a
  // suspended user gets none of it regardless of how many free uses are left.
  // 423 (Locked) rather than 403: this function's breakdown.ts client already
  // hardcodes a "Bot check failed" message for any 403 (that status is
  // Turnstile's), so reusing it here would show the wrong reason for the
  // right refusal. `code: "suspended"` (not `reason`) matches the existing
  // `code: "SIGNIN_REQUIRED"` convention in this file's 401 responses, and
  // `error` carries copy a user can actually read. breakdown.ts falls back to
  // `reason || error` when it doesn't recognize the status, so leaving `error`
  // as the human sentence is what surfaces today, before any src change wires
  // `code` in explicitly.
  if (profile?.is_suspended === true) {
    return new Response(
      JSON.stringify({
        error: "This account has been suspended. If you think that's a mistake, email us.",
        code: "suspended",
      }),
      { status: 423, headers },
    );
  }

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

  // 7. Groq. Both modes are judgement calls over structured input, never a
  // transcription of the document itself.
  //
  // Shots mode goes in BATCHES, and the reason is a rate limit rather than a
  // context limit. Groq's free tier counts `max_tokens` — what you RESERVE for
  // the reply, not what you use — against tokens-per-minute. So one call over a
  // 137-shot film asked for 18,505 against a 12,000 TPM ceiling and was refused
  // outright, mostly on reserved output nobody was going to spend. Small
  // batches, each reserving only what its own shots could possibly need, stay
  // under the ceiling on any tier.
  //
  // Batches are sequential and spaced, because TPM is a per-MINUTE budget:
  // firing them all at once would rebuild the same wall out of smaller bricks.
  // Failure is per-batch, so one bad batch costs its own shots' chips and
  // nothing else, and a whole run that overruns the time budget returns the
  // chips it did earn rather than nothing.
  // LLM COST METER. `script_use` already existed but could not answer "how many
  // model requests are we making", and that is the number with a bill attached.
  // Two reasons it could not:
  //   1. Shots mode BATCHES. One script_use can be a single call or a dozen,
  //      depending on the length of the script, and retries below fire more.
  //      Counting script_use rows undercounts real requests by a wide and
  //      variable margin.
  //   2. FAILED CALLS COST TOO. A 429 or a 502 is a request that was made, may
  //      have burned input tokens, and counts against the rate limit - and the
  //      old failure paths returned early without logging anything at all, so
  //      the worst days looked like the quietest ones.
  //
  // Counted HERE, inside the one function that actually talks to Groq, rather
  // than at the call sites: every path including each retry passes through this
  // line, so a new caller added later is metered without anyone remembering to.
  // Server-side by necessity - a client-reported number can be spoofed by
  // anyone with a browser console, and would miss every failure.
  const meter = {
    calls: 0,
    ok: 0,
    failed: 0,
    rateLimited: 0,
    promptTokens: 0,
    completionTokens: 0,
  };

  /* The meter, flattened for `events.props`. Prefixed `llm_` so a dashboard
     query can pull cost out of any event that carries it without knowing
     which event it is looking at, and so these can never collide with the
     mode-specific keys (`shots`, `moments`, `today`) alongside them.
     `llm_model` travels WITH the counts because price is per-model: a token
     total with no model attached cannot be turned into money later, and this
     project has already switched models once. */
  const llmProps = () => ({
    llm_model: GROQ_MODEL,
    llm_calls: meter.calls,
    llm_ok: meter.ok,
    llm_failed: meter.failed,
    llm_rate_limited: meter.rateLimited,
    llm_prompt_tokens: meter.promptTokens,
    llm_completion_tokens: meter.completionTokens,
  });

  /* Log a run that produced NOTHING. Without this the meter would still be a
     lie by omission: an outage day makes the most requests, burns the most
     input tokens and returns the fewest results, and the old code returned
     502 without writing a row - so the most expensive days were invisible and
     the dashboard's "requests" line would fall exactly when spend spiked.
     `script_fail` rather than `script_use` because the user was refunded and
     it must never be counted as a use. Best-effort: never blocks the error
     response the caller is waiting on. */
  const logLlmFailure = async (mode: string, status: number | null) => {
    try {
      await admin.from("events").insert({
        user_id: userId,
        name: "script_fail",
        props: { mode, status: status ?? null, ...llmProps() },
        ip_hash: ipHash,
      });
    } catch (_) { /* analytics is non-fatal */ }
  };

  async function groqJson(
    system: string,
    user: string,
    maxTokens: number,
  ): Promise<{ ok: true; parsed: any } | { ok: false; status: number; detail: string }> {
    meter.calls++;
    const gr = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!gr.ok) {
      meter.failed++;
      if (gr.status === 429) meter.rateLimited++;
      return { ok: false, status: gr.status, detail: (await gr.text()).slice(0, 300) };
    }
    const gjson = await gr.json();
    // Groq returns OpenAI-shaped `usage`. Read it BEFORE the JSON.parse below,
    // because a reply whose content fails to parse is still a reply that was
    // generated and billed - counting only parseable replies would quietly
    // under-report spend on exactly the days the model misbehaves most.
    meter.ok++;
    meter.promptTokens += Number(gjson?.usage?.prompt_tokens) || 0;
    meter.completionTokens += Number(gjson?.usage?.completion_tokens) || 0;
    try {
      return { ok: true, parsed: JSON.parse(gjson.choices?.[0]?.message?.content ?? "{}") };
    } catch (e) {
      return { ok: false, status: 502, detail: String(e).slice(0, 200) };
    }
  }

  let shotMoments: any[] = [];
  let today: any[] = [];

  if (mode === "callsheet") {
    const userContent = "KNOWN SCENES:\n" + JSON.stringify(knownScenes) +
      "\n\nCALL SHEET:\n" + text.slice(0, CALLSHEET_INPUT_CAP);
    const r = await groqJson(SYSTEM_CALLSHEET, userContent, MAX_OUTPUT_TOKENS_CALLSHEET);
    if (!r.ok) {
      // Groq outage must not burn the user's lifetime slot — refund it.
      await admin.rpc("refund_quota", { p_user: userId, p_kind: "script" });
      await logLlmFailure(mode, r.status);
      return new Response(
        JSON.stringify({ error: "Breakdown service error", detail: r.detail }),
        { status: 502, headers },
      );
    }
    today = Array.isArray(r.parsed.today) ? r.parsed.today : [];
  } else {
    const startedAt = Date.now();
    let lastDetail = "";
    let lastStatus = 0;
    let attempted = 0;

    for (let i = 0; i < briefs.length; i += SHOT_BATCH) {
      // Out of time: keep what we have. A partial set of chips beats none, and
      // the shotlist itself is already parsed and safe on the client either way.
      if (Date.now() - startedAt > SHOT_TIME_BUDGET_MS) break;
      const batch = briefs.slice(i, i + SHOT_BATCH);
      const userContent = "SHOTS:\n" + JSON.stringify(batch);
      const reserve = batch.length * OUTPUT_TOKENS_PER_SHOT;
      attempted++;

      // 429 is the rate limiter asking us to wait, not a failure — on the free
      // tier it is the EXPECTED reply once a minute's budget is spent. Waiting
      // it out is the whole throttling strategy, so retry rather than give up.
      let r = await groqJson(SYSTEM_SHOTS, userContent, reserve);
      for (let attempt = 0; attempt < SHOT_MAX_RETRIES && !r.ok && r.status === 429; attempt++) {
        if (Date.now() - startedAt > SHOT_TIME_BUDGET_MS) break;
        await new Promise((res) => setTimeout(res, SHOT_RETRY_MS));
        r = await groqJson(SYSTEM_SHOTS, userContent, reserve);
      }
      if (!r.ok) {
        lastStatus = r.status;
        lastDetail = r.detail;
        continue;
      }
      if (Array.isArray(r.parsed.shots)) shotMoments = shotMoments.concat(r.parsed.shots);
    }

    // Every batch we tried failed — that is a real outage, not model restraint,
    // so say so and refund rather than passing off silence as "no key moments".
    if (!shotMoments.length && attempted > 0 && lastStatus) {
      await admin.rpc("refund_quota", { p_user: userId, p_kind: "script" });
      await logLlmFailure(mode, lastStatus);
      return new Response(
        JSON.stringify({ error: "Breakdown service error", detail: lastDetail }),
        { status: 502, headers },
      );
    }
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
        props: { mode, today: validToday.length, doc: docName || null, ...llmProps() },
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
      .map((m: any) => tidyMoment(m))
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
        ...llmProps(),
      },
      ip_hash: ipHash,
    });
  } catch (_) { /* analytics is non-fatal */ }

  return new Response(JSON.stringify({ shots: validShots, used, limit }), { headers });
});
