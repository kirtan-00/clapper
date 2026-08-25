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
      .in("key", ["dashboard_owner_user_id", "dashboard_excluded_vids"]);
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

    // ---- Users -------------------------------------------------------
    const usersRows = liveProfileRows.map((p) => {
      const agg = byUser.get(p.user_id) ?? emptyAgg();
      return {
        user_id: p.user_id,
        email: p.email,
        created_at: p.created_at,
        is_pro: p.is_pro,
        pro_until: p.pro_until,
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
      // Suspend/upgrade controls: the app-side code already reads
      // profiles.is_suspended (see breakdown/index.ts), but that column, the
      // admins table, and admin_suspend_user/admin_unsuspend_user do not
      // exist in the live schema (20260822090000_admin_suspension.sql is
      // written and UNAPPLIED). Rather than call an RPC that would 404/500,
      // this stays hard-coded false and the page renders the controls
      // disabled with that reason attached.
      suspend_available: false,
      suspend_unavailable_reason:
        "supabase/migrations/20260822090000_admin_suspension.sql is written but not applied - no admins table, no is_suspended column, no admin_suspend_user/admin_unsuspend_user RPC.",
    };

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
      }),
      { headers },
    );
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
// ============================================================================
