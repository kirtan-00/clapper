-- ============================================================================
-- Clapper — Accounts, Quotas & Abuse Protection
-- Design spec: docs/specs/2026-07-15-accounts-quotas-design.md  (§4 + §5)
-- Supabase project: sqqdivfgdfaztfzrzkhu
--
-- This migration is IDEMPOTENT / re-runnable: create-if-not-exists tables,
-- drop-then-create policies, create-or-replace functions, drop-then-create
-- trigger, on-conflict-do-nothing seed, and guarded pg_cron scheduling.
--
-- RLS is default-deny on every table. service_role bypasses RLS by design and
-- is the sole writer of the authoritative counters.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables (§4)
-- ----------------------------------------------------------------------------

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text,
  is_pro     boolean     not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.usage (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  script_uses   int         not null default 0,
  premiere_uses int         not null default 0,
  csv_uses      int         not null default 0,
  updated_at    timestamptz not null default now()
);

create table if not exists public.events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users (id) on delete set null,   -- NULLABLE (anon events)
  name       text,
  props      jsonb       not null default '{}'::jsonb,
  ip_hash    text,
  created_at timestamptz not null default now()
);

create table if not exists public.rate_events (
  id         bigint generated always as identity primary key,
  key        text,
  created_at timestamptz not null default now()
);

create index if not exists rate_events_key_created_idx
  on public.rate_events (key, created_at desc);

create table if not exists public.config (
  key   text primary key,
  value jsonb
);

create table if not exists public.script_mode_daily (
  day   date primary key,
  count int not null default 0
);

-- ----------------------------------------------------------------------------
-- 2. Row Level Security — enable on ALL six tables (default-deny)
-- ----------------------------------------------------------------------------

alter table public.profiles          enable row level security;
alter table public.usage             enable row level security;
alter table public.events            enable row level security;
alter table public.rate_events       enable row level security;
alter table public.config            enable row level security;
alter table public.script_mode_daily enable row level security;

-- profiles: SELECT own row only. NO update/insert/delete policy → is_pro is
-- server-only (all writes via service_role).
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- usage: SELECT own row only ("N of 5 left"). NO insert/update/delete policy →
-- edge functions (service_role) are the sole writer.
drop policy if exists usage_select_own on public.usage;
create policy usage_select_own
  on public.usage
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- events: INSERT only. Authenticated must stamp their own user_id; anon must
-- leave user_id null. NO SELECT policy (analytics read via service_role/SQL).
drop policy if exists events_insert_authenticated on public.events;
create policy events_insert_authenticated
  on public.events
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists events_insert_anon on public.events;
create policy events_insert_anon
  on public.events
  for insert
  to anon
  with check (user_id is null);

-- Bound what the public anon INSERT policy can write: cap the event name and the
-- props payload so the open insert path can't be used to bloat the table.
-- Guarded so re-running the migration doesn't error on an existing constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_sane'
  ) then
    alter table public.events
      add constraint events_sane
      check (length(name) <= 64 and pg_column_size(props) <= 4096);
  end if;
end $$;

-- rate_events, config, script_mode_daily: RLS enabled, NO policies → default
-- deny → service_role only.

-- ----------------------------------------------------------------------------
-- 3. Functions (§5) — SECURITY DEFINER, search_path='', schema-qualified
-- ----------------------------------------------------------------------------

-- handle_new_user: on new auth user, idempotently seed profiles + usage rows.
-- Body kept minimal — a throw here would block signups.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email)
    values (new.id, new.email)
    on conflict (user_id) do nothing;

  insert into public.usage (user_id)
    values (new.id)
    on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill: seed profiles + usage for any auth.users that predate the trigger
-- (e.g. users created before this migration first ran). Idempotent.
insert into public.profiles (user_id, email)
  select id, email from auth.users
  on conflict (user_id) do nothing;

insert into public.usage (user_id)
  select id from auth.users
  on conflict (user_id) do nothing;

-- consume_quota: single atomic UPDATE. Returns the new count, or -1 if the row
-- is at/over the limit (or absent). One UPDATE = race-proof.
--   p_kind ∈ {'script','premiere','csv'} → script_uses | premiere_uses | csv_uses
create or replace function public.consume_quota(p_user uuid, p_kind text, p_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_col text;
  v_new int;
begin
  v_col := case p_kind
    when 'script'   then 'script_uses'
    when 'premiere' then 'premiere_uses'
    when 'csv'      then 'csv_uses'
    else null
  end;

  if v_col is null then
    raise exception 'consume_quota: invalid kind %', p_kind;
  end if;

  execute format(
    'update public.usage set %1$I = %1$I + 1, updated_at = now() '
    || 'where user_id = $1 and %1$I < $2 returning %1$I',
    v_col
  )
  into v_new
  using p_user, p_limit;

  if v_new is null then
    return -1;
  end if;

  return v_new;
end;
$$;

revoke execute on function public.consume_quota(uuid, text, int) from public, anon, authenticated;
grant  execute on function public.consume_quota(uuid, text, int) to service_role;

-- refund_quota: give one slot back when a consume was followed by a downstream
-- failure (Groq outage, paused gate). Clamped at 0 so it can never go negative.
--   p_kind ∈ {'script','premiere','csv'} → script_uses | premiere_uses | csv_uses
create or replace function public.refund_quota(p_user uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_col text;
begin
  v_col := case p_kind
    when 'script'   then 'script_uses'
    when 'premiere' then 'premiere_uses'
    when 'csv'      then 'csv_uses'
    else null
  end;

  if v_col is null then
    raise exception 'refund_quota: invalid kind %', p_kind;
  end if;

  execute format(
    'update public.usage set %1$I = greatest(%1$I - 1, 0), updated_at = now() '
    || 'where user_id = $1',
    v_col
  )
  using p_user;
end;
$$;

revoke execute on function public.refund_quota(uuid, text) from public, anon, authenticated;
grant  execute on function public.refund_quota(uuid, text) to service_role;

-- rate_limit_check: sliding window over rate_events. Advisory xact lock on the
-- key first for strict no-overallow on the same key, then GC old rows, count in
-- window, insert + true or false. service_role only.
create or replace function public.rate_limit_check(p_key text, p_window_secs int, p_max int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext(p_key));

  delete from public.rate_events
    where key = p_key
      and created_at < now() - make_interval(secs => p_window_secs);

  select count(*) into v_count
    from public.rate_events
    where key = p_key
      and created_at >= now() - make_interval(secs => p_window_secs);

  if v_count >= p_max then
    return false;
  end if;

  insert into public.rate_events (key) values (p_key);
  return true;
end;
$$;

revoke execute on function public.rate_limit_check(text, int, int) from public, anon, authenticated;
grant  execute on function public.rate_limit_check(text, int, int) to service_role;

-- script_mode_gate: reserve-before-Groq global gate. Reads config (enabled +
-- daily cap), then atomically bumps today's counter only while under cap.
-- Returns {allow:true,count} or {allow:false, reason:'disabled'|'daily_cap'}.
-- service_role only.
create or replace function public.script_mode_gate()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_cap     int;
  v_count   int;
begin
  select (value #>> '{}')::boolean into v_enabled
    from public.config where key = 'script_mode_enabled';
  select (value #>> '{}')::int into v_cap
    from public.config where key = 'script_mode_daily_cap';

  v_enabled := coalesce(v_enabled, false);
  v_cap     := coalesce(v_cap, 0);

  if not v_enabled then
    return jsonb_build_object('allow', false, 'reason', 'disabled');
  end if;

  insert into public.script_mode_daily as smd (day, count)
    values ((now() at time zone 'utc')::date, 1)
    on conflict (day) do update
      set count = smd.count + 1
      where smd.count < v_cap
    returning smd.count into v_count;

  if v_count is null then
    return jsonb_build_object('allow', false, 'reason', 'daily_cap');
  end if;

  return jsonb_build_object('allow', true, 'count', v_count);
end;
$$;

revoke execute on function public.script_mode_gate() from public, anon, authenticated;
grant  execute on function public.script_mode_gate() to service_role;

-- ----------------------------------------------------------------------------
-- 4. Config seed
-- ----------------------------------------------------------------------------

insert into public.config (key, value) values
  ('script_mode_enabled',   'true'::jsonb),
  ('script_mode_daily_cap', '500'::jsonb)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- 5. Housekeeping — pg_cron purge jobs (§5)
--    cron.schedule errors if a job name already exists, so unschedule first.
-- ----------------------------------------------------------------------------

create extension if not exists pg_cron;

-- purge rate_events older than 10 min, every 10 min
select cron.unschedule('clapper_purge_rate_events')
  where exists (select 1 from cron.job where jobname = 'clapper_purge_rate_events');
select cron.schedule(
  'clapper_purge_rate_events',
  '*/10 * * * *',
  $cron$delete from public.rate_events where created_at < now() - interval '10 minutes'$cron$
);

-- purge events older than 90 days, daily
select cron.unschedule('clapper_purge_events')
  where exists (select 1 from cron.job where jobname = 'clapper_purge_events');
select cron.schedule(
  'clapper_purge_events',
  '0 3 * * *',
  $cron$delete from public.events where created_at < now() - interval '90 days'$cron$
);
