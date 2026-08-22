-- ============================================================================
-- Clapper - Admin: account suspension ("boot"), reversible, audited
--
-- The owner wants an admin panel that can "boot users and do other admin
-- stuff." A dashboard that only greys out a row in a local UI has not booted
-- anybody - this migration is the half that makes booting real: the schema,
-- and the identity check that lets an edge function tell a real admin from
-- anyone else holding a JWT.
--
-- "Boot" means SUSPEND, never delete. This project's hard rule against
-- deleting user data without per-item approval applies here too, and nothing
-- in this file drops a row of user data. Every suspend/unsuspend is an INSERT
-- into an append-only audit log (account_suspensions), never an UPDATE-in-
-- place of a single flag - a repeat offender's whole history survives being
-- toggled back and forth, which a lone nullable `suspended_at` column would
-- not.
--
-- `profiles.is_suspended` / `suspended_at` are a CACHE of "what does the log
-- say right now", read on every gated call because replaying the whole audit
-- table on every export would be needless work. This is the exact same shape
-- already in this schema: `profiles.pro_until` caches what `public.payments`
-- records in full, and nothing but razorpay-verify writes it. Here, nothing
-- but admin_suspend_user / admin_unsuspend_user writes is_suspended.
--
-- Apply with the Supabase CLI (`supabase db push`) - NOT applied by the agent
-- that wrote this file. This project's Supabase instance is production with
-- live paying users; only the owner applies migrations, after review.
--
-- This migration is IDEMPOTENT / re-runnable, same conventions as the rest of
-- this directory: create-if-not-exists tables/columns, drop-then-create
-- policies, create-or-replace functions, guarded constraints. Every DDL
-- statement in here is additive and safe against a database whose true
-- applied state is not what the migration history implies (see next
-- paragraph) - nothing here drops or renames anything that already exists.
--
-- REQUIRED APPLY ORDER, verified against the live project's
-- information_schema rather than trusted from file history: production is
-- currently BEHIND this repo. `usage` has no `pdf_uses`, `profiles` has no
-- `pro_until`, and `public.payments` does not exist at all - the three
-- migrations that create them (20260801090000, 20260819120000, 20260820140000)
-- were never applied. `admin_list_accounts` below reads all three
-- (`pro_until`, `payments`, `pdf_uses`) for the dashboard's usage/payment
-- columns. Because it is PL/pgSQL, `create or replace function` will succeed
-- even without them - the body is only syntax-checked at creation, not
-- resolved against the catalog - but the function will error the first time
-- it is CALLED if they are missing. So this file applies cleanly on its own,
-- but must not be treated as usable on its own. Apply in this order:
--   1. 20260819120000_payments.sql      (adds profiles.pro_until, public.payments)
--   2. 20260820140000_pdf_quota.sql     (adds usage.pdf_uses)
--   3. 20260822090000_admin_suspension.sql   (this file)
-- 20260801090000_anon_export_quota.sql is unrelated to this file and can be
-- applied whenever the owner is ready for it; nothing here depends on it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Admin identity - a table, not a hardcoded email or uuid anywhere in
--    source. RLS on, ZERO policies: default-deny for anon AND authenticated.
--    Not even a signed-in admin can read this table through the client API
--    with their own session - the only door in is an edge function's
--    service-role client, which checks membership itself before doing
--    anything privileged. That is the whole point of "the client app must
--    never be able to discover, read or set it": there is no path from
--    src/ to this table at all, by construction, not by convention.
--
--    Nobody is seeded here. After this migration is applied, the owner grants
--    himself admin ONCE, by hand, in the SQL editor - never in a committed
--    migration:
--      insert into public.admins (user_id)
--      select id from auth.users where email = 'owner@example.com';
-- ----------------------------------------------------------------------------

create table if not exists public.admins (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- ----------------------------------------------------------------------------
-- 2. The audit log. Append-only by convention (nothing in this migration
--    grants update/delete to anyone, including service_role's own table
--    grants stay at the default), one row per action, never mutated.
--    RLS on, zero policies - same default-deny as admins above: this is the
--    record of a moderation action, and it can only be trusted as one if
--    nothing outside the admin surface can write or rewrite it.
-- ----------------------------------------------------------------------------

create table if not exists public.account_suspensions (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  action     text        not null check (action in ('suspend', 'unsuspend')),
  -- Free text, required. A suspend with no reason is exactly the kind of
  -- entry nobody can act on six months later when the same account shows up
  -- again.
  reason     text        not null check (length(trim(reason)) > 0),
  -- The admin who acted. Nullable + on delete set null (never cascade) for
  -- the same reason public.events.user_id is: losing the admin's own account
  -- later must not take this history down with it. Same pattern as the rest
  -- of this schema, not a new one.
  actor      uuid        references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists account_suspensions_user_idx
  on public.account_suspensions (user_id, created_at desc);

alter table public.account_suspensions enable row level security;

-- ----------------------------------------------------------------------------
-- 3. profiles gets the fast-lookup cache. Same shape as pro_until: a single
--    indexed column export-gate/breakdown/razorpay-order can check on every
--    call, backed by a full log nobody but the admin surface can touch.
-- ----------------------------------------------------------------------------

alter table public.profiles add column if not exists is_suspended boolean not null default false;
alter table public.profiles add column if not exists suspended_at timestamptz;

comment on column public.profiles.is_suspended is
  'Cache of "does account_suspensions currently say suspended for this user". Written only by admin_suspend_user / admin_unsuspend_user - nothing else should write it. The audit trail is account_suspensions; this column exists purely so a gated edge function can check one indexed row instead of replaying the log on every call.';
comment on column public.profiles.suspended_at is
  'When the CURRENT suspension took effect. NULL when not currently suspended. This is current-state metadata, not history - account_suspensions is the history, and nulling this on unsuspend loses nothing that table does not already keep.';

create index if not exists profiles_suspended_idx on public.profiles (user_id) where is_suspended;

-- ----------------------------------------------------------------------------
-- 4. is_admin - one place the membership check lives, used inside every
--    function below so a caller who is not in public.admins gets refused no
--    matter which entry point they hit. STABLE, not VOLATILE: it only reads.
-- ----------------------------------------------------------------------------

create or replace function public.is_admin(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = p_user);
$$;

revoke execute on function public.is_admin(uuid) from public, anon, authenticated;
grant  execute on function public.is_admin(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 5. admin_suspend_user / admin_unsuspend_user - the only two writers of
--    is_suspended / suspended_at, and the only writers of account_suspensions.
--    Each does its audit-log insert and its profiles update as ONE plpgsql
--    function body so they commit atomically - two separate calls from the
--    edge function (insert, then update) could succeed-then-fail and leave
--    the log and the cache disagreeing, which is exactly the kind of split
--    write this schema avoids everywhere else (see consume_quota's single
--    UPDATE for the same reasoning applied to counters).
--
--    p_admin is the caller's own auth.uid(), resolved from their JWT by the
--    edge function and passed in explicitly - once this runs as service_role
--    inside a SECURITY DEFINER function, auth.uid() no longer reflects who
--    actually called the edge function, so the identity has to travel as an
--    argument and be rechecked here. This is defense in depth: the edge
--    function already refuses a non-admin caller before it gets this far, and
--    this second check means the guarantee holds even for a future caller of
--    this function that forgets to.
-- ----------------------------------------------------------------------------

create or replace function public.admin_suspend_user(p_admin uuid, p_target uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
  v_now    timestamptz := now();
begin
  if not public.is_admin(p_admin) then
    raise exception 'admin_suspend_user: % is not an admin', p_admin;
  end if;

  v_reason := trim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'admin_suspend_user: reason is required';
  end if;

  if not exists (select 1 from public.profiles pr where pr.user_id = p_target) then
    raise exception 'admin_suspend_user: no such user %', p_target;
  end if;

  -- The log entry IS the record of what happened. Recording it even when the
  -- account is already suspended is deliberate: a second suspend with a new
  -- reason (a repeat offense, an escalation) is itself worth keeping, not a
  -- no-op to be swallowed.
  insert into public.account_suspensions (user_id, action, reason, actor)
    values (p_target, 'suspend', v_reason, p_admin);

  update public.profiles
    set is_suspended = true, suspended_at = v_now
    where user_id = p_target;

  return jsonb_build_object('user_id', p_target, 'is_suspended', true, 'suspended_at', v_now);
end;
$$;

revoke execute on function public.admin_suspend_user(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.admin_suspend_user(uuid, uuid, text) to service_role;

create or replace function public.admin_unsuspend_user(p_admin uuid, p_target uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  if not public.is_admin(p_admin) then
    raise exception 'admin_unsuspend_user: % is not an admin', p_admin;
  end if;

  -- Reversal is recorded with the same rigor as the suspend itself - why an
  -- account is being let back in matters just as much as why it was booted,
  -- and is not implied by the suspend reason it is undoing.
  v_reason := trim(coalesce(p_reason, ''));
  if v_reason = '' then
    raise exception 'admin_unsuspend_user: reason is required';
  end if;

  if not exists (select 1 from public.profiles pr where pr.user_id = p_target) then
    raise exception 'admin_unsuspend_user: no such user %', p_target;
  end if;

  insert into public.account_suspensions (user_id, action, reason, actor)
    values (p_target, 'unsuspend', v_reason, p_admin);

  -- suspended_at goes back to NULL here on purpose: it is current-state
  -- metadata, not history. The history this action is part of is the row
  -- just inserted above, which nothing ever deletes.
  update public.profiles
    set is_suspended = false, suspended_at = null
    where user_id = p_target;

  return jsonb_build_object('user_id', p_target, 'is_suspended', false);
end;
$$;

revoke execute on function public.admin_unsuspend_user(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.admin_unsuspend_user(uuid, uuid, text) to service_role;

-- ----------------------------------------------------------------------------
-- 6. Read surface for the dashboard: one row per account with usage and
--    payment state folded in, search, and the full suspension history for one
--    account. Both check admin membership up front and raise if it fails, so
--    even a future caller that skips the edge-function check gets refused
--    here too.
--
--    Every output column is explicitly qualified (p.foo, not foo) - plpgsql
--    puts each `returns table(...)` column name in scope inside the function
--    body, and an unqualified reference that happens to share a table's
--    column name resolves as ambiguous at CALL time, not at CREATE time. A
--    syntax check alone would not have caught that; this was run against a
--    real Postgres instance specifically to catch it.
--
--    admin_list_accounts reads profiles.pro_until, usage.pdf_uses and
--    public.payments - see the REQUIRED APPLY ORDER note at the top of this
--    file. It will CREATE fine without them (lazy PL/pgSQL resolution) and
--    then error the first time it is CALLED, until 20260819120000 and
--    20260820140000 are applied ahead of this file.
-- ----------------------------------------------------------------------------

create or replace function public.admin_list_accounts(
  p_admin  uuid,
  p_search text default null,
  p_limit  int  default 50,
  p_offset int  default 0
)
returns table (
  user_id             uuid,
  email               text,
  created_at          timestamptz,
  is_pro              boolean,
  pro_until           timestamptz,
  is_suspended        boolean,
  suspended_at        timestamptz,
  script_uses         int,
  premiere_uses       int,
  pdf_uses            int,
  csv_uses            int,
  payments_paid_count bigint,
  last_paid_at        timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(p_admin) then
    raise exception 'admin_list_accounts: % is not an admin', p_admin;
  end if;

  return query
    select
      p.user_id,
      p.email,
      p.created_at,
      p.is_pro,
      p.pro_until,
      p.is_suspended,
      p.suspended_at,
      coalesce(u.script_uses, 0)   as script_uses,
      coalesce(u.premiere_uses, 0) as premiere_uses,
      coalesce(u.pdf_uses, 0)      as pdf_uses,
      coalesce(u.csv_uses, 0)      as csv_uses,
      coalesce(pay.paid_count, 0)  as payments_paid_count,
      pay.last_paid_at
    from public.profiles p
    left join public.usage u on u.user_id = p.user_id
    left join (
      select
        pm.user_id,
        count(*) filter (where pm.status = 'paid') as paid_count,
        max(pm.paid_at)                             as last_paid_at
      from public.payments pm
      group by pm.user_id
    ) pay on pay.user_id = p.user_id
    where p_search is null
       or trim(p_search) = ''
       or p.email ilike '%' || p_search || '%'
       or p.user_id::text = p_search
    order by p.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke execute on function public.admin_list_accounts(uuid, text, int, int) from public, anon, authenticated;
grant  execute on function public.admin_list_accounts(uuid, text, int, int) to service_role;

create or replace function public.admin_suspension_history(p_admin uuid, p_target uuid)
returns table (
  id         bigint,
  action     text,
  reason     text,
  actor      uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(p_admin) then
    raise exception 'admin_suspension_history: % is not an admin', p_admin;
  end if;

  return query
    select s.id, s.action, s.reason, s.actor, s.created_at
    from public.account_suspensions s
    where s.user_id = p_target
    order by s.created_at desc;
end;
$$;

revoke execute on function public.admin_suspension_history(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.admin_suspension_history(uuid, uuid) to service_role;

-- ----------------------------------------------------------------------------
-- 7. Rate limiting for admin mutations reuses rate_limit_check - the same RPC
--    razorpay-order already calls - rather than a second mechanism. The
--    admin-api edge function is expected to call it keyed on the admin's own
--    user id before suspend/unsuspend, same shape as every other mutation in
--    this schema.
-- ----------------------------------------------------------------------------
