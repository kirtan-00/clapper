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

**Status 2026-08-24: only `185.199.108.153` is actually present.** The site
works on one A record, but there is no failover: if that single GitHub edge
has a bad day the site is down with nothing to fall back on. The remaining
seven are still to be added.

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

**Four steps to make it work, in order. None are automated.**

1. Apply `supabase/migrations/20260822090000_admin_suspension.sql` — creates
   `public.admins` and `is_admin`.
2. Apply `supabase/migrations/20260824090000_admin_analytics.sql`.
3. Insert your own `auth.users` id into `public.admins`. **Nobody is seeded.**
   Until this row exists every account, including the owner's, sees "This
   account is not an admin". That is fail-closed by design, not a bug.
4. Add `https://clapper.in/admin/` to Supabase Auth's redirect allowlist, or
   Google sign-in bounces to the site root instead of the dashboard.

Deliberately not shown on the dashboard: **takes logged** and **shoot days**.
`ROLL`/`CUT` fire per camera unit, not per saved take (a two-camera take logs
two CUTs; a false start logs a CUT with nothing saved), and there is no event
at all for wrapping a shoot day. A number built on either would look precise
and be wrong.

---

## Deploy checklist

```bash
npm test          # 331 tests
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
