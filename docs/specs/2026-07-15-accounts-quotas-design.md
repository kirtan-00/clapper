# Clapper — Accounts, Quotas & Abuse Protection (design spec)

Date: 2026-07-15
Status: approved (Kirtan), ready to build
Owner: Clapper (kirtan-00/clapper), Supabase project `sqqdivfgdfaztfzrzkhu`

## 1. Goal

Turn Clapper from a free tool into a professional micro-SaaS foundation ahead of a Reddit
launch: real accounts, server-authoritative usage limits, row-level data isolation, and
Fort-Knox abuse protection — without breaking the frictionless, offline on-set core.

Two jobs the gates do at once: (a) capture a monetizable user list, (b) measure demand
(who hits the wall = who would pay).

## 2. Scope — what is free vs gated

Principle: **gate only what costs money (Groq) or is the pro editor-handoff. Keep on-set
logging frictionless and offline.**

| Action | Account? | Online? | Limit |
|---|---|---|---|
| Log takes (roll/cut/moments), wake-lock, tags | No | No (offline) | Unlimited |
| PDF export | No | No (offline) | Unlimited |
| Example scripts (Grandfather/School) | No | No | Unlimited |
| **Script Mode (PDF → breakdown)** | **Yes (Google)** | Yes | **5 / account** |
| **Premiere (FCP7 XML) export** | **Yes (Google)** | Yes | **5 / account** |
| **CSV export** | **Yes (Google)** | Yes | **5 / account** |

Premiere and CSV are **separate** counters (5 each), not combined.

## 3. Architecture

- **Auth:** Supabase Auth + Google OAuth (PKCE), one-tap "Sign in with Google". Anonymous
  until the first gated action; a sign-in sheet appears then and returns the user to the action.
- **DB:** Supabase Postgres, RLS default-deny on every table. `service_role` (edge functions
  only) is the sole writer of authoritative counters.
- **Enforcement:** all gated actions call an edge function with `verify_jwt=true`. The function
  derives the user from the JWT (never trusts client-sent identity), verifies a Turnstile token,
  checks per-user + per-IP rate limits, checks the global Groq gate (Script Mode only), then
  atomically consumes quota, then does the work.
- **Client:** thin — holds only the public anon key + Google client id + Turnstile site key.
  Never holds the service-role key.

## 4. Data model + RLS (contract — build to these names exactly)

Schema `public`. RLS enabled on all; `service_role` bypasses RLS (that is the design).

```
profiles(user_id uuid PK ref auth.users on delete cascade, email text, is_pro bool default false, created_at timestamptz default now())
usage(user_id uuid PK ref auth.users on delete cascade, script_uses int default 0, premiere_uses int default 0, csv_uses int default 0, updated_at timestamptz default now())
events(id uuid PK default gen_random_uuid(), user_id uuid ref auth.users on delete set null NULLABLE, name text, props jsonb default '{}', ip_hash text, created_at timestamptz default now())
rate_events(id bigint identity PK, key text, created_at timestamptz default now())  index (key, created_at desc)
config(key text PK, value jsonb)   -- seed: script_mode_enabled=true, script_mode_daily_cap=500
script_mode_daily(day date PK, count int default 0)
```

RLS policies:
- `profiles`: `SELECT`/`UPDATE` to `authenticated` where `(select auth.uid()) = user_id`.
  **Drop the UPDATE policy** so `is_pro` is server-only (research-recommended; approved).
  → profiles is read-own only for clients; all writes via service role.
- `usage`: `SELECT` own row only (`authenticated`). **No** insert/update/delete policy
  → clients can read "N of 5 left" but cannot mutate. Edge functions (service role) only writer.
- `events`: `INSERT` for `authenticated` `with check (user_id = (select auth.uid()))`;
  `INSERT` for `anon` `with check (user_id is null)`. **No SELECT policy** (analytics read via
  service role/SQL). Client inserts must use `return=minimal` (supabase-js: `.insert(row)` with
  no `.select()`).
- `rate_events`, `config`, `script_mode_daily`: RLS enabled, **no policies** → service-role only.

Wrap `auth.uid()` as `(select auth.uid())` in every policy (perf). Always specify `TO authenticated`/`TO anon`.

## 5. Database functions (SECURITY DEFINER, `set search_path = ''`, schema-qualify everything)

- `handle_new_user()` trigger `after insert on auth.users`: idempotently inserts `profiles` and
  `usage` rows (`on conflict do nothing`). Keep body minimal (a throw blocks signups).
- `consume_quota(p_user uuid, p_kind text, p_limit int) returns int`:
  atomic `update public.usage set <col> = <col>+1, updated_at=now() where user_id=p_user and <col> < p_limit returning <col>`.
  `p_kind ∈ {'script','premiere','csv'}` → columns `script_uses|premiere_uses|csv_uses`.
  Returns new count, or `-1` if at/over limit (single UPDATE = race-proof).
  `revoke execute ... from public, anon, authenticated; grant execute ... to service_role`.
- `rate_limit_check(p_key text, p_window_secs int, p_max int) returns boolean`:
  sliding window over `rate_events`; GC old rows, count in window, if `>= p_max` return false else
  insert + return true. Prepend `perform pg_advisory_xact_lock(hashtext(p_key));` for strict
  no-overallow on the same key. service-role only.
- `script_mode_gate() returns jsonb`: reads `config` (enabled + daily cap), then atomic
  `insert into script_mode_daily(day,count) values(utc_today,1) on conflict (day) do update set count=count+1 where count < cap returning count`.
  Returns `{allow:true,count}` or `{allow:false, reason:'disabled'|'daily_cap'}`. Reserve-before-Groq.
  service-role only.

Housekeeping (pg_cron): purge `rate_events` > 10 min every 10 min; purge `events` > 90 days daily.

## 6. Edge functions (contract)

All: CORS locked to `https://kirtan-00.github.io` + localhost (reuse existing helper). JSON in/out.
Derive user via `supabase.auth.getUser()` with the caller's Authorization header (see §7).

### 6a. `breakdown` (MODIFY existing)
- `verify_jwt = true`.
- Body: `{ text, docName, turnstileToken }` (email removed — identity comes from JWT).
- Flow: getUser → 401 if none → verify Turnstile token (siteverify, check hostname) → 403 on fail
  → `rate_limit_check('ip:'+ipHash, 60, 30)` and `('u:'+userId, 60, 20)` → 429 if either false
  → `script_mode_gate()` → 503 `{error:'paused'}` if not allow →
  `consume_quota(userId,'script', is_pro?BIG:5)` → 402/429 `{error:'quota_exceeded'}` if -1 →
  Groq breakdown (unchanged prompt) → log `events` row `name='script_use'` (service role) →
  return pack `{ ...pack, used, limit }`.
- Keep the existing `leads` insert OR fold into `events`; prefer `events` with `name='script_use'`.

### 6b. `export-gate` (NEW)
- `verify_jwt = true`.
- Body: `{ format: 'premiere'|'csv' }` (no Turnstile needed; not a Groq-cost action, but still
  rate-limited + quota'd).
- Flow: getUser → 401 → `rate_limit_check` per-ip + per-user → 429 →
  `consume_quota(userId, format, is_pro?BIG:5)` → return `{ allow:false, reason:'quota_exceeded' }`
  (200 with allow flag, or 402) if -1, else `{ allow:true, remaining: limit-count }` + log `events`
  `name='export' props={format}`. Client generates the XML/CSV blob ONLY on `allow:true`.
- PDF NEVER calls this (uncapped, offline).

Limits are chosen **server-side** from `is_pro` (`5` free). Client never sends the limit.

> **Deploy note (`--no-verify-jwt`):** both edge functions deploy with `--no-verify-jwt`. The
> in-function `supabase.auth.getUser()` is the real auth guard (it derives the user from the JWT
> and 401s when absent), so the gateway's JWT check is disabled to let the browser's CORS
> preflight (`OPTIONS`, which carries no Authorization header) reach the function. The gateway
> check would only have required the public anon key anyway, so disabling it removes no real
> protection — the per-request `getUser()` is what actually authenticates the caller.

## 7. Auth flow (Google OAuth, PKCE, gh-pages `/clapper/`)

- supabase-js client: `{ auth: { flowType:'pkce', detectSessionInUrl:true, persistSession:true, autoRefreshToken:true } }`.
- `signInWithOAuth({ provider:'google', options:{ redirectTo: window.location.origin + import.meta.env.BASE_URL } })`
  → returns to `https://kirtan-00.github.io/clapper/?code=...`; supabase-js auto-exchanges. Then
  `history.replaceState({}, '', import.meta.env.BASE_URL)` to strip the code.
- Session read for edge calls: use `supabase.functions.invoke(name, { body })` (auto-attaches
  `Authorization: Bearer <jwt>`), or manual fetch with the header.
- Edge side: `createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global:{ headers:{ Authorization: req.headers.get('Authorization')! } } })` then `getUser()`; a separate service-role client for privileged RPC/inserts.
- gotchas: trailing-slash must match Supabase Redirect URLs allow list; no custom callback path
  (gh-pages has no router) — return to index; PKCE is same-browser/device.

## 8. Turnstile (Managed mode, invisible execute-on-demand)

- Client: load `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`; render a
  widget with `execution:'execute'`; get a **fresh** token (`reset` + `execute`) immediately before
  each Script Mode call. Site key = `VITE_TURNSTILE_SITE_KEY` (public). Dev: dummy sitekey
  `1x00000000000000000000AA`.
- Server (`breakdown`): POST secret+token(+remoteip, idempotency_key) to `.../turnstile/v0/siteverify`;
  require `success:true`; verify `hostname`. Secret = `TURNSTILE_SECRET` (Supabase secret). Dev
  secret `1x0000000000000000000000000000000AA`.
- CSP (if any) must allow `challenges.cloudflare.com` in script-src/frame-src.

## 9. Client modules (contract)

New:
- `src/net/supabase.ts` — the configured supabase-js client (URL + anon key from `breakdown.ts` consts / env).
- `src/net/auth.ts` — `signInWithGoogle()`, `signOut()`, `useSession()` hook, `getAccessToken()`.
- `src/net/analytics.ts` — `track(name, props?)` fire-and-forget insert into `events` (attach user_id when signed in); capture `?ref=` on first `app_open`; never throws.
- `src/net/quota.ts` — `getUsage()` (reads `usage` row → {script,premiere,csv remaining}); `gateExport(format)` → calls `export-gate`.
- `src/net/turnstile.ts` (or a hook) — `getTurnstileToken()`.
- `src/ui/SignInSheet.tsx` — Google button sheet; shown when a gated action needs auth.

Modified:
- `src/ui/breakdown.ts` — drop email arg; send `{text,docName,turnstileToken}` via `functions.invoke`; surface cap/rate/paused/auth errors as human messages.
- `src/ui/ProjectsScreen.tsx` (ScriptPackSheet) — require session; if none → SignInSheet; show
  "N of 5 left"; on cap show `Free limit reached — more coming soon.`; remove the email field.
- `src/ui/ProjectScreen.tsx` (ExportBar) — PDF unchanged; Premiere/CSV: require session → SignInSheet
  → `gateExport(format)` → generate blob only on allow; on cap show the same message.
- App entry — init supabase, fire `app_open`, handle OAuth return (replaceState).

## 10. Analytics events (names)

`app_open`(props: ref, standalone, returning) · `sign_in` · `project_created`(mode:normal|script) ·
`roll` · `cut` · `script_use`(scenes) · `export`(format) · `cap_hit`(which:script|premiere|csv) ·
`example_loaded`(which). Read via SQL first (management API), dashboard later.

Traction metrics: unique users/day, open→create→roll→export funnel, % cap_hit, day-2 retention,
users collected, per-`ref` conversion.

## 11. Error handling & offline

- Offline gated action: `You're offline — Script Mode and Premiere/CSV export need a connection. Logging takes and PDF export work offline.`
- Cap: `Free limit reached — more coming soon.` + `cap_hit` event. (No CTA — per Kirtan.)
- Rate-limited: `Too fast — give it a moment and try again.`
- Groq paused (kill-switch/daily cap): `Script Mode is taking a breather — try again later.`
- Auth error: graceful, offer retry sign-in. Core logging + PDF never blocked by any of this.

## 12. Security checklist (verify before ship)

1. `get_advisors` (security) → zero RLS-disabled / policy-without-RLS findings.
2. From anon key: insert/update `usage` → denied; select `events` → 0 rows; insert `events` with
   another user_id → denied.
3. New signup → exactly one `profiles` + one `usage` row.
4. Concurrent `consume_quota` at last slot (10 parallel at count 4, limit 5) → exactly one non-`-1`.
5. Limits + `is_pro` derived server-side from JWT, never from request body.
6. service-role key only in edge secrets; never in client bundle or repo.
7. Turnstile verified server-side, hostname checked; token single-use.

## 13. Human setup (Kirtan — I supply exact values)

- **Google Cloud:** OAuth consent screen (External; scopes openid/email/profile — non-sensitive, no
  verification); Web OAuth client; Authorized redirect URI `https://sqqdivfgdfaztfzrzkhu.supabase.co/auth/v1/callback`;
  JS origin `https://kirtan-00.github.io`. → paste Client ID + Secret into Supabase Auth → Providers → Google.
- **Cloudflare Turnstile:** create widget (Managed), hostname `kirtan-00.github.io` → Site key (client) + Secret (Supabase secret `TURNSTILE_SECRET`).
- **Supabase Auth → URL config:** Site URL `https://kirtan-00.github.io/clapper/`; Redirect URLs add that + `http://localhost:5173/**`.
- Deferred: Resend spend-alert email (kill-switch + daily cap ship without it).

## 14. Build plan (parallel subagents)

Contract above is frozen so agents don't diverge. Disjoint file sets in phase 1.

- **P1a — DB (Supabase):** migrations for §4 tables + RLS + §5 functions + cron + config seed →
  `supabase/migrations/*.sql`. Apply via Supabase MCP / management API. Output: `get_advisors` clean.
- **P1b — Edge functions:** modify `breakdown`, add `export-gate` per §6 → `supabase/functions/*`.
- **P1c — Client net layer:** `src/net/*` + `SignInSheet.tsx` per §9 (new files only).
- **P2 — Client gating wiring** (after P1c): edit `breakdown.ts`, `ProjectsScreen.tsx`,
  `ProjectScreen.tsx`, app entry per §9.
- **P3 — `setup-backend.sh` update + integration:** provision events/config/cron + deploy `export-gate`
  + set `TURNSTILE_SECRET`. Build (`npm run build`) green.
- **P4 — Fable security review** against §12 + a correctness pass; fix findings.
- **P5 — Verify:** `npm run dev`, click through gated + free paths (dummy Turnstile), then hand
  Kirtan the §13 setup and deploy to gh-pages on his go.

## 15. Out of scope (YAGNI for v1)

Payments/Stripe (only the `is_pro` flag exists, unused), the analytics dashboard UI (SQL first),
email fallback auth + disposable-email blocklist (Google-only covers it), i18n.
