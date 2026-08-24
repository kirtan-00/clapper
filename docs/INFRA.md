# Clapper infrastructure

Single source of truth for where Clapper lives and how it gets there.
Every fact below was verified against production on 2026-08-24, not inferred
from config files. When something here stops matching reality, fix this file
in the same commit that changed reality.

**No secrets in this file.** Tokens live in the gitignored `credentials.md`
(chmod 600). The one identifier that IS here on purpose is the GA4 Measurement
ID, which is public by definition and ships in the source of every page.

---

## Domains

| Domain | Role | Registrar | Serves |
|---|---|---|---|
| `clapper.in` | **primary** | GoDaddy, created 2026-08-24 | the site + app, from GitHub Pages |
| `clappers.in` | typo catch | GoDaddy | 301 forward to `https://clapper.in` |
| `clapboard.duckdns.org` | retired | duckdns | the "we've moved" notice |

`clapper.in` nameservers: `ns77.domaincontrol.com`, `ns78.domaincontrol.com`.

### DNS records on clapper.in

GitHub Pages apex. All four A records share the name `@`; that is correct and
is how Pages does failover.

```
A     @    185.199.108.153
A     @    185.199.109.153
A     @    185.199.110.153
A     @    185.199.111.153
AAAA  @    2606:50c0:8000::153
AAAA  @    2606:50c0:8001::153
AAAA  @    2606:50c0:8002::153
AAAA  @    2606:50c0:8003::153
CNAME www  kirtan-00.github.io
```

**Status 2026-08-24: all nine records are in and verified** against
`ns77.domaincontrol.com` directly, not just the registrar's success toast.
`http://www.clapper.in` 301s to the apex, which serves 200 over HTTPS.

One thing settles on its own: for up to an hour after the `www` CNAME
changed, `https://www.clapper.in` presented GitHub's `*.github.io`
certificate rather than one for this domain, because GitHub had not yet
issued a cert for the new hostname. That is normal after a DNS change, not a
misconfiguration. If it persists past a day, toggle the custom domain off and
on in the repo's Pages settings to force a re-issue.

### GOTCHA: GoDaddy Forwarding locks the apex A record

If Domain Forwarding is switched on, GoDaddy creates an A record it owns,
displays its value as **`Parked`**, and makes it uneditable and undeletable.
There is no error message explaining this: the Edit and Delete controls are
simply inert, and the "Add New Record" button does not render at all. The
domain resolves to GoDaddy's forwarding infrastructure on AWS (seen:
`3.33.x.x`, `15.197.x.x`).

To fix: DNS → **Forwarding** tab → delete the rule. The A record becomes
editable immediately. This cost an afternoon on both `clapper.in` and
`clappers.in`.

Note the same feature is the RIGHT tool for `clappers.in`: forwarding, type
**Permanent (301)**, masking **off**. Masking would keep `clappers.in` in the
address bar while serving clapper.in's content, which is duplicate content.

---

## Hosting

Both sites are static, on GitHub Pages, free tier. There is no server.

### Main site — `clapper.in`

- Repo `kirtan-00/clapper`, orphan branch **`gh-pages`**
- Published by `./deploy.sh` from the repo root. The script builds the app,
  assembles the site, and force-pushes an orphan branch. It does NOT push
  `main`/`feat/app-shell`; source history and published output are separate.
- The custom domain is claimed by the `CNAME` file, written by `deploy.sh`
  (search for `printf 'clapper.in'`). Changing the domain means changing that
  line, not a GitHub settings page.
- Layout: landing at `/`, app at `/app/`, guides at `/articles/`, free
  templates at `/templates/`, the XML rewriter at `/relink/`, the private
  dashboard at `/admin/`, policies at `/legal/`.

### Retired domain — `clapboard.duckdns.org`

- Repo `kirtan-00/clapper-moved`, branch **`main`**, Pages enabled, HTTPS
  enforced. Source: `moved-site/` in the main repo, copied over by hand.
- **Why a second repo at all:** GitHub Pages allows exactly ONE custom domain
  per repo. The moment the main repo's CNAME became `clapper.in`, the old
  domain lost its certificate and started serving GitHub's "Site not found".
  A second repo is the only way it keeps a valid cert.
- **Why keep it alive:** shot logs live in IndexedDB, which is per-origin, and
  `src/net/sync.ts` is a no-op without a session (`return; // no session ->
  sync is a no-op`). Anyone who logged a shoot signed-out has data that exists
  ONLY on that origin. The page tells them how to carry it across. Do not
  retire this until you are certain nobody is in that position.

### TLS

Let's Encrypt, issued and renewed automatically by GitHub once the domain is
claimed and DNS resolves. No action needed, no cron, nothing to renew by hand.
`clapper.in` was issued within minutes of the first deploy. If `https://` fails
right after a domain change, that is the certificate not yet issued, not a
misconfiguration; give it up to an hour.

---

## Analytics

Two separate systems that measure different things. Do not merge them.

### 1. GA4 — the marketing site only

Measurement ID **`G-RMLDR8GENF`**.

Injected at DEPLOY time by `deploy.sh` (step 2c), not written into the HTML
sources. Two reasons:

1. Pages are authored by several hands. A snippet that must be pasted into
   every new page is one the next page will be missing. Injection covers pages
   that do not exist yet.
2. It is deliberately NOT behind an env var, unlike `META_PIXEL_ID`. A GA4
   Measurement ID is public. An unset env var fails SILENTLY, and analytics
   that quietly is not running is worse than none, because you trust the zero.

**Three paths are excluded, and one is a promise:**

- `/app/` — the PWA has its own first-party analytics. GA here would
  double-count every session and add a third-party request to an app whose
  point is working offline on set.
- `/admin/` — the private dashboard.
- `/relink/` — **this one is not a preference.** That page promises editors
  that a client's shot log never leaves their machine. A tracking tag makes
  that sentence a lie. Read the comment on relink's copy step before touching.

Guards in the injector: pages already carrying the ID are skipped, so a re-run
cannot double-fire pageviews; the tag goes before the first `</head>` only; and
**the deploy aborts if zero pages were injected** rather than shipping blind.

### 2. First-party events — the app

`src/net/analytics.ts` writes to Supabase `public.events`. Insert-only: the
client has no read access to that table, by design.

`LIVE_HOSTS` gates which hostnames may write. It currently allows
`clapper.in`, `www.clapper.in`, `clapboard.duckdns.org` and
`kirtan-00.github.io`. **The old host is in that list on purpose** — an
installed PWA keeps the origin it was added from, so pre-move installs still
report from duckdns. Removing it would delete real users from our own numbers.

**~79% of all historical events are dev traffic.** The hostname gate that
stopped it shipped 2026-08-20 (commit `92c31ac`); nothing before that date is
trustworthy. Every number on the admin dashboard is scoped to
`created_at >= 2026-08-20` and the page says so on screen.

**Event vocabulary**, all fire-and-forget, all props limited to counts, enums
and booleans — never a project name, scene text, shot text, an operator name,
a file name, or any free text a user typed:

| Event | Props | Answers |
|---|---|---|
| `app_open` | `ref`, `standalone` | how many people opened the app |
| `screen_view` | `screen` (nav route name, or `how_to` for the guide overlay) | which screens people reach |
| `session_end` | `screen` | which screen was showing when the app went to the background — an *approximation* of drop-off, not a session count (see the migration/dashboard comment) |
| `project_created` | `mode` (`normal`/`script`/`podcast`), `cameras`, `sound` | which setup flow people use |
| `roll`, `cut` | — | per camera unit, not per take — see "Not shown" below |
| `tag_used` | `gold` (boolean) | quick-tag use, and GOLD/circle specifically — never the tag text, which is a crew's own free-text vocabulary (`tagdefaults.ts`) |
| `moment_marked` | — | MARK IN/OUT ranges, whether closed by a second tap or folded in at CUT |
| `clip_number_edited` | `surface` (`counter`/`take`) | the clip-number editor — the live counter vs. correcting an already-logged take |
| `wrap_day` | `action` (`wrap`/`undo`) | wrap-day PRESSES, not shoot days worked — see below |
| `shotlist_uploaded`, `shotlist_parsed`, `example_loaded` | — / `scenes`,`shots` / `which` | Script Mode use |
| `export` | `format` | which export formats get used |
| `cap_hit` | `which` | which gated action hit its free-tier cap |
| `pro_interest`, `pro_purchased` | `gate` / `plan` | interest vs. purchases (selling is paused; `pro_purchased` is aggregated but has no client call site right now) |
| `persist` | `granted`, `already` | storage-permission prompt outcome |
| `error` | `message`, `stack`, `name`, `...context` | crash telemetry |

**Not tracked, on purpose:** a device/anonymous-user identifier. It would let
"distinct users" and "how often they come back" include anonymous opens, not
just signed-in ones — but adding one is a privacy decision reserved for the
owner, not something to add silently. Flagged as an open question wherever
this analytics work is discussed.

---

## Supabase

Project ref **`sqqdivfgdfaztfzrzkhu`**.

### Edge functions

| Function | Version (2026-08-24) | Purpose |
|---|---|---|
| `breakdown` | v9 | Script Mode: PDF → shot breakdown via Groq |
| `export-gate` | v2 | server-authoritative export quota |

**`deploy.sh` does NOT touch edge functions.** They are a separate deploy, and
forgetting this is how a CORS change sits in git looking done while production
still rejects the new origin. Deploy them with:

```bash
export SUPABASE_ACCESS_TOKEN=<sbp_ token from credentials.md>
npx supabase@latest functions deploy breakdown   --project-ref sqqdivfgdfaztfzrzkhu --no-verify-jwt
npx supabase@latest functions deploy export-gate --project-ref sqqdivfgdfaztfzrzkhu --no-verify-jwt
```

Docker is not required for this (the CLI warns that Docker is not running;
ignore it). Verify a deploy actually took by preflighting CORS:

```bash
curl -s -D- -o /dev/null -X OPTIONS \
  https://sqqdivfgdfaztfzrzkhu.supabase.co/functions/v1/export-gate \
  -H "Origin: https://clapper.in" -H "Access-Control-Request-Method: POST" \
  | grep -i access-control-allow-origin
```

Allowed origins live in `supabase/functions/_shared/cors.ts`; the Turnstile
host allowlist is `TURNSTILE_HOSTS` in `supabase/functions/breakdown/index.ts`.
Both keep `clapboard.duckdns.org` for the installed-PWA reason above.

### Auth

Google OAuth. **The redirect allowlist is a dashboard setting, not code.**
Authentication → URL Configuration must list `https://clapper.in/**`, or
sign-in bounces to the site root. Keep the duckdns entry for old installs.

### GOTCHA: migrations are NOT tracked

`supabase_migrations.schema_migrations` is **empty**. Early schema was applied
by hand through the SQL editor. **A file in `supabase/migrations/` is not
evidence it ran.** This has already caused one silent production outage: a
migration adding `usage.pdf_uses` was never applied, `export-gate` called a
`consume_quota` arm that did not exist, Postgres raised, the function 500'd,
and the client displayed **"You're offline."** PDF export was dead for two days
while the error message blamed the user's wifi.

Before trusting any migration, check `information_schema` directly.

Migrations here are additive and idempotent by convention (`add column if not
exists`, `create table if not exists`, `create or replace function`), which is
what makes catching up safe.

---

## The admin dashboard

`https://clapper.in/admin/`. Serves 200, and is **not functional yet.**

It is a static page holding only the public anon key and the code to ask for
numbers. Authorisation is decided by Postgres, never by client JavaScript:
`admin_analytics_summary()` is `SECURITY DEFINER`, revoked from `public` and
`anon`, granted only to `authenticated`, and its first act is
`is_admin(auth.uid())` or raise. It returns pre-aggregated counts only and
never a row of `public.events` — that matters because `events.props` carries
`trackError`'s raw stack traces.

**Five steps to make it work, in order. None are automated.**

1. Apply `supabase/migrations/20260822090000_admin_suspension.sql` — creates
   `public.admins` and `is_admin`.
2. Apply `supabase/migrations/20260824090000_admin_analytics.sql`.
3. Apply `supabase/migrations/20260824150000_admin_analytics_engagement.sql`
   — same function, `create or replace`d with the full body restated plus
   screens/tagging/moments/clip-edits/wrap-day/session-end/returning-users
   added. **Not applied yet as of this writing** — the dashboard's own
   `renderDashboard()` still works against just step 2's function (every new
   card falls back to an empty/zero shape instead of throwing), so applying
   this step can happen whenever the owner reviews it, independent of when
   the app-side code deploys.
4. Insert your own `auth.users` id into `public.admins`. **Nobody is seeded.**
   Until this row exists every account, including the owner's, sees "This
   account is not an admin". That is fail-closed by design, not a bug.
5. Add `https://clapper.in/admin/` to Supabase Auth's redirect allowlist, or
   Google sign-in bounces to the site root instead of the dashboard.

Deliberately not shown on the dashboard: **takes logged** and **shoot days
worked**. `ROLL`/`CUT` fire per camera unit, not per saved take (a two-camera
take logs two CUTs; a false start logs a CUT with nothing saved). `wrap_day`
IS shown, but only as a press count — it undercounts any day the crew forgot
to press it, so it is labelled "wrap day presses", never "shoot days". A
number built on any of these to mean "shoot days worked" would look precise
and be wrong.

---

## Deploy checklist

```bash
npm test          # 337 tests
npm run build
./deploy.sh       # builds, assembles, injects GA4, force-pushes gh-pages
```

`deploy.sh` covers: the app, landing, `/articles/`, `/templates/`, `/relink/`,
`/admin/`, `/legal/`, favicons, robots, sitemap, the CNAME file, and GA4
injection.

**It does not cover:** edge functions, database migrations, the
`clapper-moved` repo, or anything in the Supabase dashboard. Those are all by
hand, and each has bitten this project at least once.

---

## Known environment limits

- The Supabase **Management API `database/query` endpoint is blocked** by the
  sandbox this project is usually driven from, as is the Supabase MCP. Schema
  checks and migrations have to be run by a human in the SQL editor. The
  `sbp_` token DOES work for the CLI (`functions deploy`, `functions list`).
- macOS `zsh` has no `timeout`. Use background jobs with a polling loop.
