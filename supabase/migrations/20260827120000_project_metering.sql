-- Project + podcast metering. NOT APPLIED. Read it before you run it.
--
-- THE MODEL THIS BUILDS, IN ONE PARAGRAPH. Clapper used to meter EXPORTS: 2
-- Premiere XML, 5 PDF, 5 CSV, 1 shot-list import, 5 call sheets, all counted
-- per account, forever. That gates the lightest user first - a film student
-- on one short hits the 2-XML cap on their only project, while a production
-- house running twenty shoots pays the same nothing. The meter is now
-- PROJECTS, not exports. CSV export is free and uncounted for every signed-in
-- account, always. PDF and Premiere/Resolve XML require the PROJECT to be
-- unlocked (a credit spent via unlock_project, in 20260826170000) - the free
-- grant below does not turn them on. Script Mode (shots + call sheet) is
-- what the free grant DOES gate: an account gets free Script Mode access on
-- its first two projects, ever, and every project beyond that needs a
-- credit. Podcast mode is metered separately, by recording TIME, not by
-- project.
--
-- WHY THE FREE GRANT IS NOT MORE project_credits. unlock_project spends a
-- credit and sets project_entitlements.unlocked_at, which is what turns on
-- PDF/XML forever. Seeding two free credits into project_credits would give
-- a free project the exact same paid export access a purchase buys - which
-- is the one thing the owner explicitly ruled out. So the free grant is a
-- SEPARATE counter (`free_projects_used`) that only ever unlocks Script Mode,
-- through a separate function (`claim_project_access`), and never touches
-- project_credits, unlock_project or project_entitlements.unlocked_at.
--
-- WHY A PERIOD FLAG EXISTS ON A GRANT THE OWNER CALLED ONE-TIME. He said,
-- explicitly, that the two free projects never refill. Two independent
-- pricing passes argued for a monthly refill instead, on the grounds that a
-- permanent dead end lands the paywall exactly when a returning user is
-- busiest, and he has not overruled his own instruction in so many words.
-- Rather than guess, this migration builds the one-time grant - his explicit
-- word stands - but the reset is driven by ONE NUMBER,
-- FREE_PROJECT_RESET_DAYS in supabase/functions/_shared/products.ts, passed
-- into claim_project_access as p_period_days. It is 0 today, which this
-- function reads as "never reset". Changing it to 30 turns the same grant
-- into a monthly refill with no other code change, in either the database or
-- the edge function - see claim_project_access below for exactly where that
-- number is read. A project that already claimed a free slot (its
-- project_entitlements.free_at is set) is unaffected either way: a period
-- reset only refills the ACCOUNT counter that gates a NEW project's first
-- claim, it never revokes access already granted to a project claimed
-- earlier.
--
-- WHY PODCAST TIME IS A DIFFERENT SHAPE FROM PROJECTS. A project unlock is a
-- permanent yes/no per project. Podcast roll time is consumption of a
-- resource that must reset on a clock even for a subscriber who is not
-- buying more projects, so it is its own counter with its own lazy monthly
-- reset (consume_podcast_seconds below), sized off which subscription
-- product (if any) the account is on.
--
-- WHAT THIS DOES NOT DO. Nothing here writes free_projects_used,
-- project_entitlements.free_at, subscription_product or podcast_seconds_used
-- until the edge functions that call these new RPCs are deployed - same
-- posture as 20260826170000, additive and inert until read. And nothing
-- calls consume_podcast_seconds at all yet: podcast roll time is not tracked
-- anywhere in this codebase today (RollingScreen.tsx has no timer that
-- reports to a server), so this RPC is schema and enforcement ready for the
-- day the recording flow is wired to call it, and the Account screen's
-- podcast meter will honestly read "0 of N hours used" until that day. That
-- wiring is a separate task, outside the files this migration's author owns.
--
-- is_pro AND pro_until STAY, exactly as 20260826170000 said. Nothing below
-- drops or rewrites either one, and both new gates (project access and
-- export access) treat is_pro (undemoted by a lapsed pro_until) as a full
-- bypass - every project this account touches behaves as already unlocked.
-- That is the same guarantee is_pro has always carried; the mechanics under
-- it changed, the promise to the one legacy account did not.

-- ---------------------------------------------------------------------------
-- 1. The free project grant
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists free_projects_used int not null default 0;
alter table public.profiles
  add column if not exists free_projects_period_start timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_free_projects_nonneg') then
    alter table public.profiles
      add constraint profiles_free_projects_nonneg
      check (free_projects_used >= 0);
  end if;
end $$;

comment on column public.profiles.free_projects_used is
  'How many of this account''s free Script Mode project slots are spent. Written only by claim_project_access / refund_project_access. Does NOT gate PDF or Premiere/Resolve export - only unlock_project (project_entitlements.unlocked_at) does that. Existing accounts start at 0 the moment this column is added, regardless of exports or Script Mode uses under the old model: the meter changed shape, so a fresh count is the honest number, not an error.';
comment on column public.profiles.free_projects_period_start is
  'When the current free-project counting period began. Read by claim_project_access only when FREE_PROJECT_RESET_DAYS (products.ts) is greater than zero; ignored while it is 0, which is the one-time-grant setting live today.';

-- ---------------------------------------------------------------------------
-- 2. Per-project free-grant marker, and the read policy project_entitlements
--    has needed since it was created and never got.
-- ---------------------------------------------------------------------------
-- unlocked_at (from 20260826170000) means paid, forever. free_at means this
-- project spent one of the account's free slots - also forever, but it never
-- turns on PDF/XML the way unlocked_at does. Both live on the same row for
-- the same reason breakdown_uploads does: the cap and the grant are both
-- properties of (account, project), not of the account alone.
alter table public.project_entitlements
  add column if not exists free_at timestamptz;

comment on column public.project_entitlements.free_at is
  'Set once this project has spent one of the account''s free Script Mode slots. Distinct from unlocked_at: a free-granted project gets Script Mode (subject to breakdown_uploads) but NOT PDF/Premiere/Resolve export - those need unlocked_at. Written by claim_project_access, cleared by refund_project_access on a same-call Groq failure.';

-- project_entitlements has carried RLS with NO select policy since it was
-- created - default-deny, so a signed-in client could not read its own
-- unlock state at all. That was fine while nothing read it; the Account and
-- Project screens now need "is this project unlocked / free-granted" for
-- display, so it needs the same select-own shape profiles and usage already
-- have. Still no insert/update/delete policy for authenticated: every write
-- goes through a SECURITY DEFINER function, exactly as before.
drop policy if exists project_entitlements_select_own on public.project_entitlements;
create policy project_entitlements_select_own
  on public.project_entitlements
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 3. Podcast roll time
-- ---------------------------------------------------------------------------
-- subscription_product mirrors WHICH subscription product this account is on
-- (a products.ts key: 'pro_monthly' is Studio, 'studio_plus' is Studio Plus),
-- because subscription_status (20260826170000) only says active/cancelled/
-- etc, not which tier - and Studio and Studio Plus grant different podcast
-- hours (and different monthly project credits) off the SAME subscription
-- object. Same posture as subscription_status: a plain mirror, written by
-- nothing in this migration, intended to be set by the webhook alongside it.
-- NULL means never subscribed OR not yet wired - either way this account
-- reads as free-tier podcast minutes, which is the safe default for money
-- nobody has confirmed arrived.
alter table public.profiles
  add column if not exists subscription_product text;
comment on column public.profiles.subscription_product is
  'Mirror of which products.ts subscription key this account last subscribed to (''pro_monthly'' = Studio, ''studio_plus'' = Studio Plus). NULL = never subscribed, or the webhook write for this column has not shipped yet - both read as free-tier podcast minutes. Display and podcast-limit lookup only; project credits are unaffected by this column, they are just a balance.';

alter table public.profiles
  add column if not exists podcast_seconds_used int not null default 0;
alter table public.profiles
  add column if not exists podcast_period_start timestamptz not null default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_podcast_seconds_nonneg') then
    alter table public.profiles
      add constraint profiles_podcast_seconds_nonneg
      check (podcast_seconds_used >= 0);
  end if;
end $$;

comment on column public.profiles.podcast_seconds_used is
  'Podcast roll time spent in the current period, in whole seconds. Reset lazily by consume_podcast_seconds when the period has elapsed. NOTHING CALLS consume_podcast_seconds YET - see the header of this file. Reads as 0 for every account until the recording flow is wired to report time.';
comment on column public.profiles.podcast_period_start is
  'When the current podcast-minutes period began. Always a monthly reset (see PODCAST_PERIOD_DAYS in products.ts) - podcast time is a subscription-style resource, unlike the free project grant, which the owner has kept one-time.';

-- ---------------------------------------------------------------------------
-- 4. Functions. SECURITY DEFINER, search_path = '', service_role only, every
--    guard in a WHERE clause so concurrency cannot double spend - same shape
--    as every function in 20260826170000.
-- ---------------------------------------------------------------------------

-- claim_project_access: does this project have free Script Mode access, and
-- if not, can the account's free grant pay for it. Called from `breakdown`
-- for BOTH modes (shots and callsheet) before any Groq call.
--
-- Returns exactly one of:
--   'unlocked'      the project was bought (unlocked_at set) - unlimited
--                    Script Mode, subject only to breakdown_uploads on shots
--   'free_existing' this project already spent a free slot on an earlier
--                    call - allow, and DO NOT consume another
--   'free_new'       this call just spent one of the account's free slots -
--                    allow, and the caller must be ready to call
--                    refund_project_access if the Groq call then fails
--   'blocked'        no free slots left and the project is not unlocked -
--                    refuse, tell the user to unlock this project
--
-- p_project may be '' or null: the id-less path. Script Mode's shots mode
-- has exactly one caller today (src/ui/ShotlistSheet.tsx's DocumentStage),
-- and it runs BEFORE the project exists - importScriptPack, which mints the
-- project, only runs later once the user confirms fps/camera/name. Minting
-- the id early and threading it through both call sites was judged too big a
-- change for this pass (it touches scriptpack.ts, ShotlistSheet.tsx AND
-- NewProjectSheet.tsx, which reuses the same picker). So today, EVERY shots
-- call takes the id-less branch: it spends straight off the account counter
-- with no per-project bookkeeping. The consequence, spelled out because it
-- is easy to miss: a free user's SECOND shots upload to the SAME project
-- (legal under breakdown_uploads, which allows two) burns a SECOND free
-- project slot, because the server cannot tell it is the same project. This
-- is a known, accepted gap until the client sends a real id - see the
-- comment on enrichShotMoments in src/ui/breakdown.ts for the wire format,
-- which already exists for exactly this.
create or replace function public.claim_project_access(
  p_user uuid,
  p_project text,
  p_free_limit int,
  p_period_days int
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_start timestamptz;
  v_used         int;
  v_hit          int;
begin
  if p_user is null then
    raise exception 'claim_project_access: user is required';
  end if;
  if p_free_limit is null or p_free_limit < 0 then
    raise exception 'claim_project_access: free limit must be >= 0';
  end if;

  -- LAZY RESET. p_period_days = 0 (today's setting, FREE_PROJECT_RESET_DAYS
  -- in products.ts) means never reset - the one-time grant the owner asked
  -- for. A positive number resets the counter to zero once that many days
  -- have elapsed since the tracked period began, and moves the period
  -- forward to now, so an account that never returns never resets and one
  -- that comes back after two silent periods resets exactly once. A race
  -- between two concurrent calls both deciding to reset is harmless: the
  -- reset always sets a fixed value (0, now()), never an increment, so
  -- running it twice is identical to running it once.
  if p_period_days > 0 then
    select free_projects_period_start into v_period_start
      from public.profiles where user_id = p_user;
    if v_period_start is not null
       and v_period_start <= now() - make_interval(days => p_period_days) then
      update public.profiles
         set free_projects_used = 0,
             free_projects_period_start = now()
       where user_id = p_user;
    end if;
  end if;

  if p_project is null or length(trim(p_project)) = 0 then
    update public.profiles
       set free_projects_used = free_projects_used + 1
     where user_id = p_user and free_projects_used < p_free_limit
    returning free_projects_used into v_used;

    if v_used is null then
      return 'blocked';
    end if;
    return 'free_new';
  end if;

  insert into public.project_entitlements (user_id, project_id)
  values (p_user, p_project)
  on conflict (user_id, project_id) do nothing;

  if exists (
    select 1 from public.project_entitlements
     where user_id = p_user and project_id = p_project and unlocked_at is not null
  ) then
    return 'unlocked';
  end if;

  if exists (
    select 1 from public.project_entitlements
     where user_id = p_user and project_id = p_project and free_at is not null
  ) then
    return 'free_existing';
  end if;

  update public.profiles
     set free_projects_used = free_projects_used + 1
   where user_id = p_user and free_projects_used < p_free_limit
  returning free_projects_used into v_used;

  if v_used is null then
    return 'blocked';
  end if;

  update public.project_entitlements
     set free_at = now(), updated_at = now()
   where user_id = p_user and project_id = p_project and free_at is null;

  get diagnostics v_hit = row_count;
  if v_hit = 0 then
    -- Lost a race with another claim on the same project (two tabs, a
    -- retried request). Give the slot back - the project has free access
    -- either way, granted by whichever call won.
    update public.profiles
       set free_projects_used = greatest(free_projects_used - 1, 0)
     where user_id = p_user;
    return 'free_existing';
  end if;

  return 'free_new';
end;
$$;

revoke execute on function public.claim_project_access(uuid, text, int, int) from public, anon, authenticated;
grant  execute on function public.claim_project_access(uuid, text, int, int) to service_role;

-- refund_project_access: give back a free slot this SAME request just spent,
-- when the Groq call that followed then failed. Mirrors refund_quota /
-- refund_project_breakdown exactly. The caller must only call this when its
-- own claim_project_access call returned 'free_new' - refunding a
-- 'free_existing' or 'unlocked' verdict would hand back a slot nobody spent.
create or replace function public.refund_project_access(p_user uuid, p_project text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null then
    raise exception 'refund_project_access: user is required';
  end if;

  if p_project is null or length(trim(p_project)) = 0 then
    update public.profiles
       set free_projects_used = greatest(free_projects_used - 1, 0)
     where user_id = p_user;
    return;
  end if;

  update public.project_entitlements
     set free_at = null, updated_at = now()
   where user_id = p_user and project_id = p_project and free_at is not null;

  if found then
    update public.profiles
       set free_projects_used = greatest(free_projects_used - 1, 0)
     where user_id = p_user;
  end if;
end;
$$;

revoke execute on function public.refund_project_access(uuid, text) from public, anon, authenticated;
grant  execute on function public.refund_project_access(uuid, text) to service_role;

-- consume_podcast_seconds: NOT CALLED BY ANYTHING YET. Shipped ready so the
-- recording flow can call it the day it reports roll time; see the header of
-- this file for why that wiring is out of scope here. Same lazy-reset shape
-- as claim_project_access, sized in seconds rather than a count, and the
-- limit is passed in (p_limit_seconds) rather than looked up here, exactly
-- like consume_quota's p_limit - the caller derives it from
-- podcastMinutesForPlan in products.ts off subscription_product, so
-- re-pricing podcast minutes never needs a migration.
create or replace function public.consume_podcast_seconds(
  p_user uuid,
  p_seconds int,
  p_limit_seconds int,
  p_period_days int
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_start timestamptz;
  v_new          int;
begin
  if p_user is null or p_seconds is null or p_seconds <= 0 then
    raise exception 'consume_podcast_seconds: user and a positive duration are required';
  end if;
  if p_limit_seconds is null or p_limit_seconds < 0 then
    raise exception 'consume_podcast_seconds: limit must be >= 0';
  end if;

  if p_period_days > 0 then
    select podcast_period_start into v_period_start
      from public.profiles where user_id = p_user;
    if v_period_start is not null
       and v_period_start <= now() - make_interval(days => p_period_days) then
      update public.profiles
         set podcast_seconds_used = 0,
             podcast_period_start = now()
       where user_id = p_user;
    end if;
  end if;

  update public.profiles
     set podcast_seconds_used = podcast_seconds_used + p_seconds
   where user_id = p_user and podcast_seconds_used + p_seconds <= p_limit_seconds
  returning podcast_seconds_used into v_new;

  if v_new is null then
    return -1;
  end if;
  return v_new;
end;
$$;

revoke execute on function public.consume_podcast_seconds(uuid, int, int, int) from public, anon, authenticated;
grant  execute on function public.consume_podcast_seconds(uuid, int, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- 5. What is deliberately NOT here
-- ---------------------------------------------------------------------------
-- No change to consume_quota, refund_quota, or the usage table's five
-- columns (script_uses, callsheet_uses, premiere_uses, pdf_uses, csv_uses).
-- Deployed clients keep issuing the old select against `usage` until they are
-- replaced; dropping a column PostgREST is still selecting 42703s the WHOLE
-- select on every one of those clients, exactly the failure this codebase has
-- already been bitten by twice (see src/net/quota.ts's callsheetUsed and
-- _shared/suspension.ts). The new client simply stops reading `usage`; the
-- old counters are not read by anything server-side any more but are left in
-- place rather than risk that class of bug for zero benefit.
--
-- No trigger, no cron job, no policy that lets a client write any of the new
-- columns - every write goes through claim_project_access,
-- refund_project_access or consume_podcast_seconds, all service_role only.
-- No RPC that writes subscription_product: it is a plain mirror, same
-- posture as subscription_status, meant to be set by the webhook with a
-- plain UPDATE alongside the columns 20260826170000 already added that way.
