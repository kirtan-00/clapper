import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors } from "../_shared/cors.ts";

// Clapper mission-control dashboard backend. The site is static on GitHub
// Pages, so nothing can be secured client-side - anyone can read the page's
// JavaScript. This function is the ONLY thing that ever holds the
// service-role key or the passphrase, and the ONLY thing that ever reads
// `events`/`profiles` for the dashboard. The page (landing/dashboard/) is a
// dumb client: it POSTs a passphrase, gets a short-lived signed token back,
// and re-sends that token on every data request. No admin/user Supabase
// session is involved anywhere in this flow - the owner is the only user,
// and a passphrase plus a signed token is the entire identity model.
//
// SAME CORS ALLOWLIST AS THE PUBLIC APP (_shared/cors.ts): unlike admin-api,
// this function IS called from a browser tab (the dashboard page itself, same
// origin family as the app - clapper.in), so it needs real browser CORS, not
// the server-to-server posture admin-api chose. Reusing the shared allowlist
// is correct here, not scope creep: it is the same site's own origins.
//
// AUTH MECHANICS.
//   - DASHBOARD_PASSPHRASE (Deno env) is the one secret the owner sets. No
//     other secret exists for this function; see the bottom of this file for
//     the exact command. Missing -> every request gets 500, never a silent
//     open door.
//   - Login compares the submitted passphrase against the configured one in
//     CONSTANT TIME (SHA-256 both sides, fixed-length XOR-accumulate compare
//     - no early exit, no length branch since both digests are always 32
//     bytes).
//   - On success, issues an HS256 JWT-shaped token: header.payload.signature,
//     base64url, `exp` ~2h out. The HMAC signing key is derived as
//     SHA-256(passphrase + "|clapper-dashboard-v1") rather than the bare
//     passphrase, so rotating DASHBOARD_PASSPHRASE automatically invalidates
//     every outstanding token with no second secret to manage. Verification
//     uses crypto.subtle.verify, which is constant-time by construction.
//   - The token is meant for sessionStorage on the client (never
//     localStorage) - that is a client-side choice this function has no way
//     to enforce, but the TTL is short specifically because it can't be.
//
// COOLDOWN + LOCKOUT, reusing `rate_events` AS-IS (id bigint, key text,
// created_at timestamptz - see 20260715120000_accounts_quotas.sql). No
// migration needed: that table is exactly "timestamped key hits", which is
// what an escalating-backoff counter is. Two distinct key namespaces on the
// SAME table, so they never interfere:
//   "dashlogin:"+ipHash / "dashstats:"+ipHash - passed to the existing
//     rate_limit_check RPC as a coarse per-IP floor (that RPC both checks AND
//     inserts for the key it is given, and GCs old rows for that key on every
//     call - exactly its designed job).
//   "dashfail:"+ipHash - NEVER passed to rate_limit_check (that RPC would GC
//     rows for this key too and eat the fail history). This function reads
//     and writes it directly: one row inserted per WRONG passphrase, all rows
//     for the key deleted on a correct one. The required gap between attempts
//     grows with how many fail rows exist in the last 10 minutes, and 10
//     minutes is a hard ceiling - not a design choice, but because
//     `clapper_purge_rate_events` (the pg_cron job in that same migration)
//     deletes anything older than that, so no memory of an attempt can
//     outlive the table's own row lifetime anyway.
//
// Every failed attempt - wrong passphrase, backoff refusal, lockout, a bad or
// expired token on a data request - is logged to `events` (best-effort,
// service-role insert) so the owner can see knocking without anything else
// being exposed.
const DASHBOARD_ALLOWED_ORIGINS_NOTE = "reuses _shared/cors.ts on purpose - see file header";
void DASHBOARD_ALLOWED_ORIGINS_NOTE;

const SIGNING_CONTEXT = "clapper-dashboard-v1";
const TOKEN_TTL_SECS = 2 * 60 * 60; // ~2h

// rate_events purges rows older than 10 minutes (clapper_purge_rate_events,
// every 10 min) - this window cannot exceed that and mean anything.
const LOCKOUT_WINDOW_SECS = 600;
// Index = fail count in the last 10 minutes; value = required seconds since
// the LAST failure before another attempt is allowed. Flat for the first
// couple of typos, then climbs. Index 10+ escalates to a hard lockout below
// rather than reading off the end of this table.
const BACKOFF_SECS = [0, 0, 0, 2, 5, 15, 30, 60, 120, 300];
const LOCKOUT_THRESHOLD = 10;

// "Data before 2026-08-21 is ~79% dev traffic" (src/net/analytics.ts's own
// measured numbers: 452/465 app_open rows on 2026-08-20, 422/425 on the 18th,
// 268/268 on the 15th). The hostname gate that fixed it landed 20 Aug,
// commit 92c31ac. Every panel below that charts a count or a trend filters to
// this cutoff and reports how many earlier rows it dropped, rather than
// charting dev traffic as if it were real use.
const DEV_GATE_CUTOFF = "2026-08-21T00:00:00.000Z";
// `vid` (the anonymous per-browser id) was added to every track() call and
// to the landing beacon on 2026-08-25 (today, at time of writing) - it is
// simply ABSENT on every row before that. Any "unique visitors" / "unique
// people" number is computed only from rows at or after this instant, and
// reads honestly as zero for the empty stretch before it rather than as a
// misleading ramp.
const VID_CUTOFF = "2026-08-25T00:00:00.000Z";

const PAGE_SIZE = 1000;
const EVENTS_ROW_CAP = 50000;
const PROFILES_ROW_CAP = 20000;

// ----------------------------------------------------------------------------
// APP CONTROL. These are the ONLY two rows in the live `config` table
// (verified 2026-08-26: `select key from public.config` returns exactly
// script_mode_daily_cap = 500 and script_mode_enabled = true). They are not a
// guess at what config could hold - they are what it holds, and the write
// action below refuses any other key rather than quietly creating one. A
// dashboard that can invent config keys is a dashboard that can typo a kill
// switch into a row nothing reads.
//
// Both are consumed by public.script_mode_gate(), which parses them as
//   (value #>> '{}')::boolean   and   (value #>> '{}')::int
// so the values written back must stay JSON SCALARS - `true`, `500` - which
// is how the seed in 20260715120000_accounts_quotas.sql wrote them.
//
// The gate itself is forgiving about this: `#>> '{}'` strips jsonb quoting,
// so '"500"' would cast to 500 and '"true"' to true just as well (checked
// against the live database rather than assumed). The reason the write path
// below still coerces to a real boolean and a real number is the READ path,
// not the gate - the stats action reports these values by checking
// `typeof === "number"` / `=== true`, so a stringified value would read back
// as malformed and the dashboard would show a blank cap over a config row
// that is working fine. Store the shape that was seeded, and both ends agree.
//
// The two dashboard_* keys are read alongside them but are NOT writable here:
// they are the "exclude my own traffic" filter, and getting them wrong hides
// real traffic rather than stopping a runaway bill. They stay a hand-run SQL
// statement (see this file's footer).
const APP_CONTROL_KEYS = ["script_mode_enabled", "script_mode_daily_cap"];
const CONFIG_READ_KEYS = [...APP_CONTROL_KEYS, "dashboard_owner_user_id", "dashboard_excluded_vids"];
// A day cap is a spend ceiling, not a counter - 100k Groq calls in a day is
// already far past any bill this project would survive, so anything above it
// is a typo (an extra zero) rather than an intention.
const DAILY_CAP_MAX = 100000;
// Matches the profiles_suspended_reason_len constraint in
// 20260826090000_profile_suspension.sql exactly. Enforced here too so the
// refusal is a readable sentence instead of a Postgres constraint violation.
const REASON_MAX = 200;
// Per-IP ceiling on writes, same mechanism and same table as the login and
// stats floors. A leaked token is the threat this exists for: it cannot be
// revoked short of rotating DASHBOARD_PASSPHRASE, so the damage it can do per
// minute is capped instead. 20/min is far more than one person clicking and
// far less than a script is worth running.
const WRITE_WINDOW_SECS = 60;
const WRITE_MAX_PER_WINDOW = 20;

const GUIDE_SLUGS = [
  "camera-clip-naming-conventions",
  "circle-takes-explained",
  "continuity-notes-guide",
  "how-to-log-takes-on-set",
  "how-to-read-a-clapperboard",
  "mos-meaning-in-film",
  "script-supervisor-duties",
  "shot-log-to-premiere-xml",
  "what-is-a-tcr-sheet",
];
const TEMPLATE_SLUGS = [
  "camera-log-sheet",
  "continuity-sheet-template",
  "script-supervisor-daily-report",
  "shot-list-template",
  "sound-report-template",
];

const APP_ACTION_EVENTS = [
  "roll",
  "cut",
  "moment_marked",
  "tag_used",
  "clip_number_edited",
  "wrap_day",
  "project_created",
  "persist",
  "onboarding",
  "install_nudge",
  "example_loaded",
  "error",
];
const FUNNEL_STAGES = ["landing_view", "landing_cta_click", "app_open", "project_created", "roll", "cut"];

// ----------------------------------------------------------------------------
// Crypto helpers
// ----------------------------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function sha256Bytes(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function sha256Hex(s: string): Promise<string> {
  return [...(await sha256Bytes(s))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fixed-length, no-early-exit compare of two byte arrays. Both inputs here
 * are always 32-byte SHA-256 digests, so there is no length-dependent branch
 * either. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function passphraseMatches(submitted: string, configured: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Bytes(submitted), sha256Bytes(configured)]);
  return constantTimeEqual(a, b);
}

async function hmacKey(passphrase: string): Promise<CryptoKey> {
  const keyBytes = await sha256Bytes(passphrase + "|" + SIGNING_CONTEXT);
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function issueToken(passphrase: string): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECS;
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ sub: "owner", iat: now, exp })),
  );
  const signingInput = `${header}.${payload}`;
  const key = await hmacKey(passphrase);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)),
  );
  return { token: `${signingInput}.${b64urlEncode(sig)}`, expiresAt: exp };
}

async function verifyToken(token: string, passphrase: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, sig] = parts;
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlDecode(sig);
  } catch {
    return false;
  }
  const key = await hmacKey(passphrase);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!ok) return false;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    const now = Math.floor(Date.now() / 1000);
    return claims?.sub === "owner" && typeof claims?.exp === "number" && claims.exp > now;
  } catch {
    return false;
  }
}

function clientIp(req: Request): string {
  const cf = req.headers.get("CF-Connecting-IP");
  if (cf) return cf.trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",");
    return parts[parts.length - 1].trim();
  }
  return "";
}

// ----------------------------------------------------------------------------
// Aggregation helpers - everything below runs in JS because no aggregation
// RPC or view exists in the live schema (three migrations that would have
// added one are unapplied), and PostgREST has no GROUP BY. Base rows are
// fetched with explicit .range() pagination because PostgREST caps a select
// at 1000 rows by default - an unpaginated fetch would silently truncate
// every count past the first page, which is exactly the kind of untrusted
// number this dashboard exists to stop shipping.
// ----------------------------------------------------------------------------

type EventRow = { name: string | null; props: Record<string, unknown> | null; user_id: string | null; created_at: string };
type ProfileRow = { user_id: string; email: string | null; is_pro: boolean; pro_until: string | null; created_at: string };

async function fetchAllPaginated<T>(
  // deno-lint-ignore no-explicit-any
  admin: any,
  table: string,
  columns: string,
  cap: number,
  // deno-lint-ignore no-explicit-any
  applyFilters: (q: any) => any,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let offset = 0;
  let truncated = false;
  for (;;) {
    if (offset >= cap) {
      truncated = true;
      break;
    }
    const end = Math.min(offset + PAGE_SIZE, cap) - 1;
    const { data, error } = await applyFilters(admin.from(table).select(columns)).range(offset, end);
    if (error) throw error;
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < end - offset + 1) break; // short page = last page
    offset += PAGE_SIZE;
  }
  return { rows, truncated };
}

function prop(row: EventRow, key: string): unknown {
  return row.props && typeof row.props === "object" ? (row.props as Record<string, unknown>)[key] : undefined;
}
function propStr(row: EventRow, key: string): string | null {
  const v = prop(row, key);
  return typeof v === "string" && v ? v : null;
}
function propNum(row: EventRow, key: string): number {
  const v = prop(row, key);
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function slugFromPath(path: string | null, base: "/articles/" | "/templates/"): string | null {
  if (!path || path.indexOf(base) !== 0) return null;
  const rest = path.slice(base.length).replace(/^\/+|\/+$/g, "");
  const slug = rest.split("/")[0];
  return slug || null;
}

function distinctVidCount(rows: EventRow[]): number {
  const s = new Set<string>();
  for (const r of rows) {
    const v = propStr(r, "vid");
    if (v) s.add(v);
  }
  return s.size;
}

// ----------------------------------------------------------------------------
// Main handler
// ----------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const PASSPHRASE = Deno.env.get("DASHBOARD_PASSPHRASE");

  // Never fall back to a default. An unconfigured secret is a closed door,
  // not an open one.
  if (!PASSPHRASE) {
    return new Response(
      JSON.stringify({ error: "Server not configured (DASHBOARD_PASSPHRASE missing)." }),
      { status: 500, headers },
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  let body: {
    action?: string;
    passphrase?: string;
    token?: string;
    exclude_self?: boolean;
    client_vid?: string;
    // Write-action fields. Every one of these is validated at its own call
    // site below; nothing typed here is trusted for being typed here.
    user_id?: string;
    pro_until?: string | null;
    reason?: string;
    key?: string;
    value?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers });
  }

  const ip = clientIp(req);
  const ipHash = await sha256Hex(ip + (Deno.env.get("IP_PEPPER") ?? "clapper"));

  const logEvent = async (name: string, props: Record<string, unknown>) => {
    try {
      await admin.from("events").insert({ user_id: null, name, props, ip_hash: ipHash });
    } catch {
      /* analytics is non-fatal */
    }
  };

  if (body.action === "login") {
    // Coarse per-IP floor, separate namespace from the fail-tracking key
    // below so this RPC's own GC never touches the fail history.
    const { data: floorOk, error: floorErr } = await admin.rpc("rate_limit_check", {
      p_key: "dashlogin:" + ipHash,
      p_window_secs: 30,
      p_max: 10,
    });
    if (floorErr || floorOk === false) {
      await logEvent("dashboard_auth_fail", { reason: "floor_rate_limited", ip_hash: ipHash });
      return new Response(
        JSON.stringify({ error: "Too fast - give it a moment and try again." }),
        { status: 429, headers },
      );
    }

    const failKey = "dashfail:" + ipHash;
    const windowStart = new Date(Date.now() - LOCKOUT_WINDOW_SECS * 1000).toISOString();
    const { data: failRows, error: failErr } = await admin
      .from("rate_events")
      .select("created_at")
      .eq("key", failKey)
      .gte("created_at", windowStart)
      .order("created_at", { ascending: true });
    // Fail CLOSED: if we cannot read the fail history, refuse rather than
    // risk skipping backoff.
    if (failErr) {
      await logEvent("dashboard_auth_fail", { reason: "backoff_check_error", ip_hash: ipHash });
      return new Response(JSON.stringify({ error: "Server error - try again in a moment." }), {
        status: 500,
        headers,
      });
    }
    const fails = (failRows ?? []) as { created_at: string }[];
    const failCount = fails.length;

    if (failCount >= LOCKOUT_THRESHOLD) {
      const oldest = fails[0]?.created_at;
      const elapsed = oldest ? (Date.now() - new Date(oldest).getTime()) / 1000 : 0;
      const retryAfter = Math.max(1, Math.ceil(LOCKOUT_WINDOW_SECS - elapsed));
      await logEvent("dashboard_auth_fail", { reason: "locked_out", ip_hash: ipHash, fail_count: failCount });
      return new Response(
        JSON.stringify({
          error: "Too many failed attempts. Locked for up to 10 minutes.",
          locked: true,
          retry_after: retryAfter,
        }),
        { status: 429, headers },
      );
    }

    const requiredGap = BACKOFF_SECS[Math.min(failCount, BACKOFF_SECS.length - 1)];
    const lastFailAt = fails[fails.length - 1]?.created_at;
    if (requiredGap > 0 && lastFailAt) {
      const elapsed = (Date.now() - new Date(lastFailAt).getTime()) / 1000;
      if (elapsed < requiredGap) {
        const retryAfter = Math.max(1, Math.ceil(requiredGap - elapsed));
        await logEvent("dashboard_auth_fail", { reason: "backoff", ip_hash: ipHash, fail_count: failCount });
        return new Response(
          JSON.stringify({ error: "Too fast - wait a moment and try again.", retry_after: retryAfter }),
          { status: 429, headers },
        );
      }
    }

    const submitted = typeof body.passphrase === "string" ? body.passphrase.slice(0, 200) : "";
    const matches = await passphraseMatches(submitted, PASSPHRASE);

    if (!matches) {
      try {
        await admin.from("rate_events").insert({ key: failKey });
      } catch {
        /* best-effort; the request still correctly fails below */
      }
      await logEvent("dashboard_auth_fail", {
        reason: "bad_passphrase",
        ip_hash: ipHash,
        fail_count: failCount + 1,
      });
      return new Response(JSON.stringify({ error: "Wrong passphrase." }), { status: 401, headers });
    }

    try {
      await admin.from("rate_events").delete().eq("key", failKey);
    } catch {
      /* best-effort reset; a stale row or two just costs one extra backoff tier */
    }
    await logEvent("dashboard_auth_ok", { ip_hash: ipHash });
    const { token, expiresAt } = await issueToken(PASSPHRASE);
    return new Response(JSON.stringify({ token, expires_at: expiresAt }), { headers });
  }

  if (body.action === "stats") {
    const { data: floorOk, error: floorErr } = await admin.rpc("rate_limit_check", {
      p_key: "dashstats:" + ipHash,
      p_window_secs: 30,
      p_max: 30,
    });
    if (floorErr || floorOk === false) {
      return new Response(
        JSON.stringify({ error: "Too fast - give it a moment and try again." }),
        { status: 429, headers },
      );
    }

    // The dashboard's OWN session token travels in the JSON body, not the
    // `Authorization` header. Supabase's platform gateway checks that header
    // for a real Supabase-issued JWT before a request ever reaches this
    // function's code (default on every project, independent of anything
    // written here) - the client sends the public anon key there purely to
    // satisfy that platform gate (see the client comment next to FN_URL in
    // landing/dashboard/index.html), whether or not this function was
    // deployed with --no-verify-jwt. This function never reads that header
    // and never treats the anon key as identity; the real decision is made
    // entirely below, against the HS256 token this function itself issued.
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token || !(await verifyToken(token, PASSPHRASE))) {
      await logEvent("dashboard_token_invalid", { ip_hash: ipHash });
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    // ---- Load base rows ------------------------------------------------
    const [{ rows: eventRows, truncated: eventsTruncated }, { rows: profileRows, truncated: profilesTruncated }] =
      await Promise.all([
        fetchAllPaginated<EventRow>(admin, "events", "name,props,user_id,created_at", EVENTS_ROW_CAP, (q) =>
          q.order("created_at", { ascending: true })),
        fetchAllPaginated<ProfileRow>(
          admin,
          "profiles",
          "user_id,email,is_pro,pro_until,created_at",
          PROFILES_ROW_CAP,
          (q) => q.order("created_at", { ascending: false }),
        ),
      ]);

    const { data: configRows } = await admin
      .from("config")
      .select("key,value")
      .in("key", CONFIG_READ_KEYS);
    const configMap = new Map<string, unknown>((configRows ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
    const ownerUserId = typeof configMap.get("dashboard_owner_user_id") === "string"
      ? (configMap.get("dashboard_owner_user_id") as string)
      : null;
    const configExcludedVids = Array.isArray(configMap.get("dashboard_excluded_vids"))
      ? (configMap.get("dashboard_excluded_vids") as unknown[]).filter((v): v is string => typeof v === "string")
      : [];

    const excludeSelf = body.exclude_self !== false;
    const clientVid = typeof body.client_vid === "string" ? body.client_vid.slice(0, 64) : null;
    const excludedVidSet = new Set(configExcludedVids);
    if (clientVid) excludedVidSet.add(clientVid);

    let liveEventRows = eventRows;
    let excludedCount = 0;
    if (excludeSelf) {
      const kept: EventRow[] = [];
      for (const r of eventRows) {
        const vid = propStr(r, "vid");
        const isOwn = (ownerUserId && r.user_id === ownerUserId) || (vid !== null && excludedVidSet.has(vid));
        if (isOwn) excludedCount++;
        else kept.push(r);
      }
      liveEventRows = kept;
    }

    let liveProfileRows = profileRows;
    if (excludeSelf && ownerUserId) {
      liveProfileRows = profileRows.filter((p) => p.user_id !== ownerUserId);
    }

    // ---- Dev-gate cutoff, applied to every count/trend below -----------
    const preCutoffCount = liveEventRows.filter((r) => r.created_at < DEV_GATE_CUTOFF).length;
    const rows = liveEventRows.filter((r) => r.created_at >= DEV_GATE_CUTOFF);
    const vidRows = rows.filter((r) => r.created_at >= VID_CUTOFF);

    // ---- Traffic ---------------------------------------------------------
    const landingViews = rows.filter((r) => r.name === "landing_view");
    const landingViewsVidWindow = vidRows.filter((r) => r.name === "landing_view");
    const byDayMap = new Map<string, { views: number; vids: Set<string> }>();
    for (const r of landingViews) {
      const d = dayKey(r.created_at);
      const cell = byDayMap.get(d) ?? { views: 0, vids: new Set<string>() };
      cell.views++;
      byDayMap.set(d, cell);
    }
    for (const r of landingViewsVidWindow) {
      const d = dayKey(r.created_at);
      const cell = byDayMap.get(d) ?? { views: 0, vids: new Set<string>() };
      const v = propStr(r, "vid");
      if (v) cell.vids.add(v);
      byDayMap.set(d, cell);
    }
    const trafficByDay = [...byDayMap.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([day, cell]) => ({ day, views: cell.views, unique: cell.vids.size }));

    const bySectionMap = new Map<string, { views: number; vids: Set<string> }>();
    for (const r of landingViews) {
      const section = propStr(r, "section") ?? "other";
      const cell = bySectionMap.get(section) ?? { views: 0, vids: new Set<string>() };
      cell.views++;
      bySectionMap.set(section, cell);
    }
    for (const r of landingViewsVidWindow) {
      const section = propStr(r, "section") ?? "other";
      const cell = bySectionMap.get(section) ?? { views: 0, vids: new Set<string>() };
      const v = propStr(r, "vid");
      if (v) cell.vids.add(v);
      bySectionMap.set(section, cell);
    }
    const trafficBySection = [...bySectionMap.entries()].map(([section, cell]) => ({
      section,
      views: cell.views,
      unique: cell.vids.size,
    }));

    const slugBreakdown = (base: "/articles/" | "/templates/", slugs: string[]) => {
      const map = new Map<string, { views: number; vids: Set<string> }>();
      for (const s of slugs) map.set(s, { views: 0, vids: new Set<string>() });
      for (const r of landingViews) {
        const slug = slugFromPath(propStr(r, "path"), base);
        if (!slug || !map.has(slug)) continue;
        map.get(slug)!.views++;
      }
      for (const r of landingViewsVidWindow) {
        const slug = slugFromPath(propStr(r, "path"), base);
        if (!slug || !map.has(slug)) continue;
        const v = propStr(r, "vid");
        if (v) map.get(slug)!.vids.add(v);
      }
      return slugs.map((slug) => ({ slug, views: map.get(slug)!.views, unique: map.get(slug)!.vids.size }));
    };

    const traffic = {
      total_views: landingViews.length,
      unique_visitors: distinctVidCount(landingViewsVidWindow),
      cta_clicks: rows.filter((r) => r.name === "landing_cta_click").length,
      by_day: trafficByDay,
      by_section: trafficBySection,
      guides: slugBreakdown("/articles/", GUIDE_SLUGS),
      templates: slugBreakdown("/templates/", TEMPLATE_SLUGS),
    };

    // ---- Funnel (distinct vid per stage, vid-window only) ---------------
    const funnelStages = FUNNEL_STAGES.map((name) => ({
      name,
      unique: distinctVidCount(vidRows.filter((r) => r.name === name)),
    }));

    // ---- App usage --------------------------------------------------------
    const eventCounts = new Map<string, number>();
    for (const r of rows) {
      if (!r.name) continue;
      eventCounts.set(r.name, (eventCounts.get(r.name) ?? 0) + 1);
    }
    const screenCounts = new Map<string, number>();
    for (const r of rows) {
      if (r.name !== "screen_view") continue;
      const screen = propStr(r, "screen") ?? "unknown";
      screenCounts.set(screen, (screenCounts.get(screen) ?? 0) + 1);
    }
    const sessionEndRows = rows.filter((r) => r.name === "session_end");
    const sessionEndByScreen = new Map<string, number>();
    for (const r of sessionEndRows) {
      const screen = propStr(r, "screen") ?? "unknown";
      sessionEndByScreen.set(screen, (sessionEndByScreen.get(screen) ?? 0) + 1);
    }

    const appUsage = {
      event_counts: [...eventCounts.entries()]
        .filter(([name]) => ["app_open", "screen_view", ...APP_ACTION_EVENTS].includes(name))
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      screens: [...screenCounts.entries()].map(([screen, count]) => ({ screen, count })).sort((a, b) => b.count - a.count),
      session_ends: {
        total: sessionEndRows.length,
        by_screen: [...sessionEndByScreen.entries()].map(([screen, count]) => ({ screen, count })).sort((a, b) => b.count - a.count),
      },
    };

    // ---- LLM ----------------------------------------------------------
    const llmRows = rows.filter((r) => r.name === "script_use" || r.name === "script_fail");
    type LlmAgg = { calls: number; ok: number; failed: number; rate_limited: number; prompt_tokens: number; completion_tokens: number };
    const emptyAgg = (): LlmAgg => ({ calls: 0, ok: 0, failed: 0, rate_limited: 0, prompt_tokens: 0, completion_tokens: 0 });
    const addAgg = (agg: LlmAgg, r: EventRow) => {
      agg.calls += propNum(r, "llm_calls");
      agg.ok += propNum(r, "llm_ok");
      agg.failed += propNum(r, "llm_failed");
      agg.rate_limited += propNum(r, "llm_rate_limited");
      agg.prompt_tokens += propNum(r, "llm_prompt_tokens");
      agg.completion_tokens += propNum(r, "llm_completion_tokens");
    };

    const totals = emptyAgg();
    const byModel = new Map<string, LlmAgg>();
    const byDay = new Map<string, LlmAgg>();
    const byUser = new Map<string, LlmAgg>();
    for (const r of llmRows) {
      addAgg(totals, r);
      const model = propStr(r, "llm_model") ?? "unknown";
      if (!byModel.has(model)) byModel.set(model, emptyAgg());
      addAgg(byModel.get(model)!, r);
      const day = dayKey(r.created_at);
      if (!byDay.has(day)) byDay.set(day, emptyAgg());
      addAgg(byDay.get(day)!, r);
      const uid = r.user_id ?? "anon";
      if (!byUser.has(uid)) byUser.set(uid, emptyAgg());
      addAgg(byUser.get(uid)!, r);
    }
    const emailByUser = new Map(profileRows.map((p) => [p.user_id, p.email]));

    const llm = {
      totals,
      by_model: [...byModel.entries()].map(([model, agg]) => ({ model, ...agg })).sort((a, b) => b.calls - a.calls),
      by_day: [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([day, agg]) => ({ day, ...agg })),
      by_user: [...byUser.entries()]
        .map(([user_id, agg]) => ({ user_id, email: emailByUser.get(user_id) ?? null, ...agg }))
        .sort((a, b) => b.calls - a.calls),
    };

    // ---- Can this database be suspended into? --------------------------
    // Asked of the database, every load, rather than hard-coded. A file in
    // supabase/migrations/ proves NOTHING about what is live here - this
    // project's schema_migrations table is empty, so migration history cannot
    // be read as applied state and two days were once lost to believing it.
    // One select for one column is the only honest way to know.
    //
    // PostgREST refuses an entire select if any named column is unknown
    // (SQLSTATE 42703), which is precisely the signal wanted: no error means
    // the column is there.
    const { error: suspendProbeErr } = await admin.from("profiles").select("is_suspended").limit(1);
    const suspendAvailable = !suspendProbeErr;
    // The reason travels to the page as text so the disabled control can say
    // what is actually wrong instead of just being grey. Two distinct cases,
    // because they need two different fixes: the column is missing (apply the
    // migration) versus the lookup failed for some other reason (look at the
    // database).
    const suspendUnavailableReason = !suspendProbeErr
      ? null
      : (suspendProbeErr as { code?: string })?.code === "42703"
      ? "profiles.is_suspended does not exist yet. Apply supabase/migrations/20260826090000_profile_suspension.sql, then reload this page - the control turns itself on."
      : "The suspension column could not be read: " +
        String((suspendProbeErr as { message?: string })?.message ?? "unknown error");

    // ---- App control ----------------------------------------------------
    // Reported from the same config read the exclude-my-traffic filter uses.
    // Values are echoed back exactly as stored so the page shows what the DB
    // says, not what the page last sent - a control that renders its own
    // optimistic guess is how a kill switch ends up looking flipped when it
    // is not.
    const rawEnabled = configMap.get("script_mode_enabled");
    const rawCap = configMap.get("script_mode_daily_cap");
    const appControl = {
      script_mode_enabled: rawEnabled === true,
      script_mode_daily_cap: typeof rawCap === "number" && Number.isFinite(rawCap) ? rawCap : null,
      // Today's spend against that cap, straight from the counter
      // script_mode_gate() itself increments. The cap means nothing without
      // it: "500" is not a useful number next to a blank space.
      used_today: 0,
      day: new Date().toISOString().slice(0, 10),
      // A key present in config but holding something the gate cannot cast is
      // worth saying out loud rather than rounding to a default, because
      // script_mode_gate() coalesces a failed read to `false`/`0` and would
      // silently switch Script Mode off for everyone.
      malformed: [] as string[],
    };
    if (rawEnabled !== undefined && typeof rawEnabled !== "boolean") appControl.malformed.push("script_mode_enabled");
    if (rawCap !== undefined && typeof rawCap !== "number") appControl.malformed.push("script_mode_daily_cap");
    {
      const { data: dailyRow } = await admin
        .from("script_mode_daily")
        .select("count")
        .eq("day", appControl.day)
        .maybeSingle();
      appControl.used_today = typeof dailyRow?.count === "number" ? dailyRow.count : 0;
    }

    // ---- Users -------------------------------------------------------
    // Suspension state is fetched in its own pass, and ONLY when the probe
    // above said the column is there. It cannot be folded into the main
    // profiles select at the top of this action for the same reason it had to
    // be pulled out of breakdown and export-gate: naming a column PostgREST
    // does not know fails the whole select, and that select is what every
    // other panel's user attribution is built on. One missing column would
    // take the entire dashboard down rather than one button.
    const suspendedByUser = new Map<string, { is_suspended: boolean; suspended_at: string | null; suspended_reason: string | null }>();
    if (suspendAvailable) {
      const { data: susRows } = await admin
        .from("profiles")
        .select("user_id,is_suspended,suspended_at,suspended_reason")
        .eq("is_suspended", true);
      for (const r of (susRows ?? []) as { user_id: string; is_suspended: boolean; suspended_at: string | null; suspended_reason: string | null }[]) {
        suspendedByUser.set(r.user_id, {
          is_suspended: r.is_suspended === true,
          suspended_at: r.suspended_at,
          suspended_reason: r.suspended_reason,
        });
      }
    }

    const usersRows = liveProfileRows.map((p) => {
      const agg = byUser.get(p.user_id) ?? emptyAgg();
      const sus = suspendedByUser.get(p.user_id);
      return {
        user_id: p.user_id,
        email: p.email,
        created_at: p.created_at,
        is_pro: p.is_pro,
        pro_until: p.pro_until,
        // Absent column and "not suspended" are deliberately the same false
        // here. The page never has to reason about a third state: whether the
        // control is usable at all is answered once, by suspend_available.
        is_suspended: sus?.is_suspended === true,
        suspended_at: sus?.suspended_at ?? null,
        suspended_reason: sus?.suspended_reason ?? null,
        llm_calls: agg.calls,
        llm_prompt_tokens: agg.prompt_tokens,
        llm_completion_tokens: agg.completion_tokens,
      };
    });
    const users = {
      total: usersRows.length,
      pro: usersRows.filter((u) => u.is_pro).length,
      free: usersRows.filter((u) => !u.is_pro).length,
      rows: usersRows,
      // Suspend availability is ASKED, not asserted. This used to be a
      // hard-coded `false` with a hand-written sentence about which migration
      // was unapplied - which was true on the day it was written and would
      // have gone on claiming it the day after the owner applied the file.
      // The probe above puts the actual database in charge of the answer, so
      // the control turns itself on the moment the column lands and nobody
      // has to remember to come back here and flip a constant. It is one
      // cheap select against one row.
      suspend_available: suspendAvailable,
      suspend_unavailable_reason: suspendAvailable ? null : suspendUnavailableReason,
      suspended: usersRows.filter((u) => u.is_suspended).length,
    };

    // Pro upgrade/downgrade needs no schema at all - is_pro and pro_until are
    // both live and both already read above - so it is reported separately
    // from the suspension probe rather than sharing its verdict. Wiring them
    // to one flag would switch off the one control the owner needs most
    // (Razorpay is not connected yet, so comping a user by hand is the only
    // way anybody becomes Pro) over a column that has nothing to do with it.
    const proControlsAvailable = true;

    return new Response(
      JSON.stringify({
        meta: {
          generated_at: new Date().toISOString(),
          dev_gate_cutoff: DEV_GATE_CUTOFF,
          vid_cutoff: VID_CUTOFF,
          pre_cutoff_events_excluded: preCutoffCount,
          events_fetched: eventRows.length,
          events_truncated: eventsTruncated,
          profiles_fetched: profileRows.length,
          profiles_truncated: profilesTruncated,
          exclude_self: excludeSelf,
          owner_user_id_configured: !!ownerUserId,
          excluded_vids_configured: configExcludedVids.length > 0,
          excluded_rows_count: excludedCount,
        },
        traffic,
        funnel: { stages: funnelStages },
        app_usage: appUsage,
        llm,
        users,
        app_control: { ...appControl, pro_controls_available: proControlsAvailable },
      }),
      { headers },
    );
  }

  // ==========================================================================
  // WRITE ACTIONS
  //
  // Everything above this point reads. Everything below changes the live
  // database for ten real people, so all five actions go through one gate and
  // there is no second way in.
  //
  // THE GATE IS THE SAME ONE THE READ PATH USES, ON PURPOSE. Same
  // rate_limit_check RPC, same rate_events table, same verifyToken against
  // the same HS256 key derived from DASHBOARD_PASSPHRASE. No admins table, no
  // Supabase session, no second secret, no "write passphrase". That is not
  // laziness about authorization - it is the decision this whole surface was
  // built on ("dashboard is for only my usage one passrod only"). There is
  // exactly one person who can hold that passphrase, so an authenticated
  // caller IS the owner, and inventing a second tier would only add a thing
  // to lose. Rotating DASHBOARD_PASSPHRASE still invalidates every token in
  // existence, writes included, with nothing else to remember.
  //
  // WHAT THE RATE LIMIT IS FOR. The token lives for two hours and cannot be
  // revoked individually. If one leaks - copied off a screen, left in a
  // sessionStorage dump - the ceiling on what it can do is the only control
  // left, so the write path is capped per IP exactly like the login path is.
  // It is not protecting against the owner clicking too fast.
  //
  // WHAT IS NOT HERE: delete. Nothing below removes a row of user data. Every
  // action is a reversible flag, and its opposite is one of the other four.
  // ==========================================================================
  const WRITE_ACTIONS = ["set_pro", "set_free", "suspend", "unsuspend", "set_config"];

  if (WRITE_ACTIONS.indexOf(body.action ?? "") !== -1) {
    const action = body.action as string;

    const { data: writeOk, error: writeErr } = await admin.rpc("rate_limit_check", {
      p_key: "dashwrite:" + ipHash,
      p_window_secs: WRITE_WINDOW_SECS,
      p_max: WRITE_MAX_PER_WINDOW,
    });
    // Fail CLOSED. Unlike the suspension lookup in _shared/suspension.ts,
    // which declines to spend money and so can afford to guess "allowed", a
    // broken limiter here is the one thing standing between a leaked token
    // and the database. Refusing the owner for a minute is the cheap error.
    if (writeErr || writeOk === false) {
      return new Response(
        JSON.stringify({ error: "Too fast - give it a moment and try again." }),
        { status: 429, headers },
      );
    }

    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token || !(await verifyToken(token, PASSPHRASE))) {
      await logEvent("dashboard_token_invalid", { ip_hash: ipHash, attempted_action: action });
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    // ---- Audit -----------------------------------------------------------
    // One row in `events` per write, name "admin_action", carrying what
    // changed and what it changed from. The before value is the part that
    // matters: "set someone Pro" is not a record of anything, "set someone
    // Pro who was free until 2026-09-30" is.
    //
    // NOTHING NEW ABOUT ANYBODY GOES IN HERE. Every field below is a user_id,
    // a boolean, a date or a config number that this database already stores
    // in a column - no email, no IP, no name. An audit log is not a place to
    // start collecting things, and props are capped at 4096 bytes by the
    // existing events_sane constraint anyway.
    //
    // Unlike logEvent above, a failure is NOT swallowed. Analytics can drop a
    // row and nobody is worse off; an audit trail that quietly stopped
    // recording is a worse artefact than no audit trail, because it still
    // looks complete. The write itself has already happened by then and is
    // not rolled back - undoing a correct change because the note about it
    // failed would be the wrong trade - so the answer carries
    // `audit_logged: false` and the page says so out loud.
    const audit = async (props: Record<string, unknown>): Promise<boolean> => {
      try {
        const { error } = await admin.from("events").insert({
          user_id: null,
          name: "admin_action",
          props: { ...props, action },
          ip_hash: ipHash,
        });
        return !error;
      } catch {
        return false;
      }
    };

    const bad = (msg: string, status = 400) =>
      new Response(JSON.stringify({ error: msg }), { status, headers });

    // ---- Shared: resolve the target account ------------------------------
    // Read before write, always. It supplies the before-values the audit row
    // needs, and it turns a mistyped id into a plain "no account with that
    // id" instead of an update that matches zero rows and reports success.
    const targetId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    const needsTarget = action !== "set_config";
    let before: Record<string, unknown> = {};
    if (needsTarget) {
      if (!targetId) return bad("Which account? user_id is required.");
      // Postgres will reject a non-uuid with a type error rather than an
      // empty result, so the shape is checked here to keep the message
      // readable.
      if (!/^[0-9a-fA-F-]{36}$/.test(targetId)) return bad("That is not a user id.");

      // Typed `string`, not left to inference. supabase-js parses a select
      // list at the TYPE level to shape the result, and it cannot parse a
      // value that is a union of two literals - it resolves to a ParserError
      // type and the call stops type-checking. Widening to string opts this
      // one dynamic select out of that machinery; the shape is asserted
      // below instead.
      const columns: string = (action === "suspend" || action === "unsuspend")
        ? "user_id,is_pro,pro_until,is_suspended,suspended_at,suspended_reason"
        : "user_id,is_pro,pro_until";
      const { data: row, error: readErr } = await admin
        .from("profiles")
        .select(columns)
        .eq("user_id", targetId)
        .maybeSingle();

      if (readErr) {
        // 42703 here means the same thing it means in the stats probe: the
        // suspension migration has not been applied. Said plainly, with the
        // fix in it, rather than surfaced as a generic server error.
        if ((readErr as { code?: string })?.code === "42703") {
          return bad(
            "Suspension is not set up in the database yet. Apply supabase/migrations/20260826090000_profile_suspension.sql first.",
            409,
          );
        }
        return bad("Could not read that account.", 500);
      }
      if (!row) return bad("No account with that id.", 404);
      // Through `unknown`: the select list above is a runtime string, so
      // supabase-js has no column names to infer a row shape from and hands
      // back its generic fallback type. The real shape is whatever `columns`
      // asked for, and only the before-values are read off it.
      before = row as unknown as Record<string, unknown>;
    }

    // ---- set_pro / set_free ----------------------------------------------
    // The action the owner reaches for most, because Razorpay is not wired up
    // yet: every Pro account today is one he granted by hand. is_pro and
    // pro_until are both live columns, so this needs no migration and works
    // the moment it is deployed.
    if (action === "set_pro" || action === "set_free") {
      let proUntil: string | null = null;
      if (action === "set_pro") {
        const raw = typeof body.pro_until === "string" ? body.pro_until.trim() : "";
        if (raw) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return bad("Expiry must be a date, YYYY-MM-DD.");
          // STORED AS THE START OF THE NEXT DAY, UTC. The page sends a date
          // the owner picked meaning "Pro through this day". export-gate
          // lapses an account when `pro_until <= now`, so storing the picked
          // day at 00:00 would end the comp at the START of the day he wrote
          // down - a full day early, on the last day, which is exactly when
          // somebody would notice and be annoyed. Adding a day makes the
          // stored instant the moment the named day is over.
          const start = Date.parse(raw + "T00:00:00.000Z");
          if (!Number.isFinite(start)) return bad("That date does not exist.");
          const end = new Date(start + 24 * 60 * 60 * 1000);
          if (end.getTime() <= Date.now()) return bad("That date has already passed.");
          proUntil = end.toISOString();
        }
        // An empty date is not an error - it means "Pro with no expiry",
        // which is what a NULL pro_until has always meant on this column
        // (see export-gate: a NULL is treated as still valid).
      }

      const after = { is_pro: action === "set_pro", pro_until: proUntil };
      const { error: updErr } = await admin.from("profiles").update(after).eq("user_id", targetId);
      if (updErr) return bad("The update was refused: " + String((updErr as { message?: string })?.message ?? ""), 500);

      const audited = await audit({
        target_user_id: targetId,
        before: { is_pro: before.is_pro, pro_until: before.pro_until },
        after,
      });
      return new Response(
        JSON.stringify({ ok: true, action, user_id: targetId, before, after, audit_logged: audited }),
        { headers },
      );
    }

    // ---- suspend / unsuspend ---------------------------------------------
    // The only two actions that need schema that is not applied yet. They are
    // reachable at all only because the read above already proved the columns
    // exist - a caller that gets here has passed that check.
    if (action === "suspend" || action === "unsuspend") {
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, REASON_MAX) : "";
      // Required on BOTH directions. Why somebody is being let back in is not
      // implied by why they were booted, and a suspension nobody wrote a
      // sentence about is one nobody can safely reverse six months later.
      if (!reason) return bad("Say why. A reason is required.");

      const after = action === "suspend"
        ? { is_suspended: true, suspended_at: new Date().toISOString(), suspended_reason: reason }
        : { is_suspended: false, suspended_at: null, suspended_reason: null };

      const { error: updErr } = await admin.from("profiles").update(after).eq("user_id", targetId);
      if (updErr) return bad("The update was refused: " + String((updErr as { message?: string })?.message ?? ""), 500);

      const audited = await audit({
        target_user_id: targetId,
        before: { is_suspended: before.is_suspended, suspended_at: before.suspended_at },
        after: { is_suspended: after.is_suspended, suspended_at: after.suspended_at },
        // The reason is the whole point of the record, and it is text the
        // owner typed about an account - not a new fact about the user.
        reason,
      });
      return new Response(
        JSON.stringify({ ok: true, action, user_id: targetId, before, after, audit_logged: audited }),
        { headers },
      );
    }

    // ---- set_config -------------------------------------------------------
    // The global kill switch and the day cap. Only the two keys that actually
    // exist are writable, checked against the allowlist rather than against
    // "is it a string" - config is a key-value table with no schema of its
    // own, so a typo'd key would insert cleanly, read back cleanly, and be
    // read by absolutely nothing. UPDATE, never upsert, for the same reason:
    // if the row is not there, the right answer is to say so.
    if (action === "set_config") {
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (APP_CONTROL_KEYS.indexOf(key) === -1) {
        return bad("Not a setting this dashboard can change.");
      }

      let value: boolean | number;
      if (key === "script_mode_enabled") {
        if (typeof body.value !== "boolean") return bad("The kill switch is on or off.");
        value = body.value;
      } else {
        const n = typeof body.value === "number" ? body.value : Number.NaN;
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > DAILY_CAP_MAX) {
          return bad("The day cap is a whole number from 0 to " + DAILY_CAP_MAX + ".");
        }
        value = n;
      }

      const { data: beforeRows } = await admin.from("config").select("key,value").eq("key", key).maybeSingle();
      if (!beforeRows) return bad("That setting is not in the config table.", 404);

      // A real boolean / real number goes in, so jsonb stores the same scalar
      // shape the migration seeded and both readers agree about it: the gate
      // casts it, and the stats action recognises it. See APP_CONTROL_KEYS at
      // the top of this file for why the shape is worth being strict about
      // even though the gate would tolerate a quoted string.
      const { error: cfgErr } = await admin.from("config").update({ value }).eq("key", key);
      if (cfgErr) return bad("The setting was refused: " + String((cfgErr as { message?: string })?.message ?? ""), 500);

      const audited = await audit({
        config_key: key,
        before: { value: (beforeRows as { value: unknown }).value },
        after: { value },
      });
      return new Response(
        JSON.stringify({
          ok: true,
          action,
          key,
          before: (beforeRows as { value: unknown }).value,
          after: value,
          audit_logged: audited,
        }),
        { headers },
      );
    }
  }

  return new Response(JSON.stringify({ error: "Unknown action." }), { status: 400, headers });
});

// ============================================================================
// OWNER SETUP - the one command:
//
//   supabase secrets set DASHBOARD_PASSPHRASE='choose-a-long-passphrase'
//
// Optional, to seed the "exclude my own traffic" filter (config table already
// exists, service_role only, no migration needed):
//
//   insert into public.config (key, value) values
//     ('dashboard_owner_user_id', '"<your-auth-user-uuid>"'::jsonb)
//   on conflict (key) do update set value = excluded.value;
//
//   insert into public.config (key, value) values
//     ('dashboard_excluded_vids', '["<vid-1>", "<vid-2>"]'::jsonb)
//   on conflict (key) do update set value = excluded.value;
//
// ----------------------------------------------------------------------------
// TO TURN ON SUSPEND / UNSUSPEND. Nothing else is needed - no admins table, no
// second secret. Apply one migration by hand and reload the page; the control
// stops being grey on its own, because `suspend_available` is a live probe of
// the column rather than a constant in this file:
//
//   supabase/migrations/20260826090000_profile_suspension.sql
//
// Read it before applying it. It adds three columns to `profiles` and one
// partial index, and nothing else. Note that the OLDER
// 20260822090000_admin_suspension.sql covers the same ground for a different
// caller (admin-api, which authenticates a real Supabase user) and builds an
// admins table plus four RPCs this dashboard cannot use - see the header of
// the new file for why they are not interchangeable.
//
// Pro / free and the app-control settings need NO migration. is_pro,
// pro_until and both config keys are already live; those controls work as
// soon as this function is deployed.
// ============================================================================
