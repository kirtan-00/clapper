# Clapper accounts + quotas — GO-LIVE steps

Everything is built, reviewed, and committed on branch `feat/accounts-quotas`. The
database is already applied to Supabase (`sqqdivfgdfaztfzrzkhu`). Two dashboard
setups are the only thing that needs a human — do A and B, hand me the two Turnstile
keys, and I finish D (deploy + go live).

Until the real Turnstile secret is set, the backend runs in dev-open Turnstile mode
(bots aren't blocked, but auth + rate-limits + per-user quota + the 500/day Groq cap
still protect cost). Do B before the Reddit post.

---

## A. Google sign-in (~5 min) — console.cloud.google.com

1. Create or pick a project.
2. **APIs & Services → OAuth consent screen** → **External**. App name `Clapper`,
   your support email + developer email. Scopes: `openid`, `email`, `profile`
   (all non-sensitive — **no Google verification / review needed**). You can Publish;
   these scopes go live immediately.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Web application**:
   - **Authorized JavaScript origins:** `https://kirtan-00.github.io`
   - **Authorized redirect URIs:** `https://sqqdivfgdfaztfzrzkhu.supabase.co/auth/v1/callback`
     (this is the SUPABASE callback, NOT your site URL — common mistake)
   - Create → copy the **Client ID** + **Client secret**.
4. **Supabase → Authentication → Providers → Google** → enable → paste Client ID +
   Secret → save. (You paste these here yourself; I don't need them.)
5. **Supabase → Authentication → URL Configuration:**
   - **Site URL:** `https://kirtan-00.github.io/clapper/`
   - **Redirect URLs:** add `https://kirtan-00.github.io/clapper/` and
     `http://localhost:5173/**`

## B. Cloudflare Turnstile (~3 min) — dash.cloudflare.com → Turnstile

1. **Add widget.** Name `Clapper`, **Widget mode: Managed**, **Hostname:
   `kirtan-00.github.io`**.
2. Copy the **Site key** (public) and **Secret key** (private).

## C. Hand me two values (paste in chat — I store them in `credentials.md`, chmod 600)

- **Turnstile Site key** → baked into the client build (`VITE_TURNSTILE_SITE_KEY`).
- **Turnstile Secret key** → set as the Supabase edge secret `TURNSTILE_SECRET`.

(Google Client ID/Secret you paste straight into Supabase in step A4 — I never see them.)

## D. I finish (once A + B are done and you've sent the two keys)

1. Set `TURNSTILE_SECRET` on Supabase + deploy the edge functions:
   `SUPABASE_ACCESS_TOKEN=<sbp> TURNSTILE_SECRET=<secret> bash supabase/setup-backend.sh`
2. Build the client with `VITE_TURNSTILE_SITE_KEY=<site key>` and deploy to gh-pages
   (`./deploy.sh`).
3. End-to-end test: Google sign-in → run a breakdown → quota ticks 1/5 → exhaust to
   5/5 and confirm the "Free limit reached — more coming soon." wall → Premiere/CSV
   export gating (5 each) → PDF + logging still free/offline.
4. Merge `feat/accounts-quotas` → `main`.

---

## Reading traction after launch (paste-able SQL, same style as before)

```sql
-- unique signed-in users + total events per day
select created_at::date d, count(*) filter (where name='app_open') opens,
       count(distinct user_id) users
from public.events group by 1 order by 1 desc;

-- the funnel + who hits the wall (your demand signal)
select name, count(*) from public.events group by 1 order by 2 desc;

-- who to email later (your monetizable list)
select email, created_at from public.profiles order by created_at desc;
```

## Kill-switch / cap controls (SQL, instant)

```sql
update public.config set value='false' where key='script_mode_enabled';   -- pause Script Mode now
update public.config set value='1000'  where key='script_mode_daily_cap';  -- raise the daily Groq cap
```
