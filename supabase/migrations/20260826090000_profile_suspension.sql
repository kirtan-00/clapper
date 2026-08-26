-- ============================================================================
-- Clapper - account suspension, three columns on `profiles`. Nothing else.
--
-- WHY THIS FILE EXISTS WHEN 20260822090000_admin_suspension.sql ALREADY DOES
-- THE SAME JOB: that file builds a whole second identity system - a public
-- .admins table, an is_admin() check, and four SECURITY DEFINER RPCs that each
-- take the acting admin's auth.uid() as an argument. That shape was written
-- for admin-api, which authenticates a real Supabase user and can produce an
-- auth.uid() to pass. The mission-control dashboard cannot: it has no Supabase
-- session at all. Its entire identity model is one passphrase and the HS256
-- token dashboard-api signs from it ("dashboard is for only my usage one
-- passrod only"), so there is no uuid to check against an admins table and
-- adding one would mean inventing a second way in. Every RPC in that file
-- would refuse the dashboard on its first line.
--
-- So this migration takes the half of that design the dashboard actually
-- needs - the three columns on profiles - and leaves the admins table, the
-- RPCs and the account_suspensions log out. 20260822090000 is SUPERSEDED for
-- the dashboard's purposes and should not be applied alongside this file
-- without deciding what admin-api is for; it is left on disk rather than
-- deleted because that is the owner's call, not an agent's.
--
-- WHAT IS LOST BY DROPPING account_suspensions: a repeat offender's full
-- toggle history. That is a deliberate trade at this size. The audit trail
-- has not vanished - dashboard-api writes one `admin_action` row into the
-- existing `events` table for every suspend and unsuspend, with the before
-- and after value, which is the same append-only record in the table this
-- project already reads for exactly this kind of question. A separate log
-- table can be added later without touching these columns.
--
-- DO NOT APPLY THIS FILE AUTOMATICALLY. This project's Supabase instance is
-- production with real users. `supabase_migrations.schema_migrations` does
-- not even exist on it - the migration history is empty, so a file sitting in
-- this directory proves nothing about what is live and `db push` cannot be
-- trusted to work out the difference. The owner applies this by hand, in the
-- SQL editor, after reading it.
--
-- VERIFIED AGAINST THE LIVE DATABASE 2026-08-26, not against file history:
-- `public.profiles` currently has exactly user_id, email, is_pro, created_at,
-- pro_until. `is_suspended` is absent, `public.admins` is absent, and
-- admin_suspend_user / admin_unsuspend_user / is_admin are absent from
-- information_schema.routines. Every statement below is additive and
-- re-runnable against that state.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The columns. Same shape as pro_until, which is the precedent this schema
-- already set for "a flag with state hanging off it": one indexed thing the
-- gated edge functions can read on every call, written only by the one
-- surface allowed to write it (razorpay-verify for pro_until, dashboard-api
-- for these).
--
-- is_suspended is NOT NULL DEFAULT false on purpose. A nullable flag would
-- make "not suspended" and "never evaluated" the same value at the call site,
-- and the gate code would have to guess which. Every existing row becomes
-- explicitly not-suspended the moment this runs.
-- ----------------------------------------------------------------------------

alter table public.profiles add column if not exists is_suspended boolean not null default false;
alter table public.profiles add column if not exists suspended_at timestamptz;
alter table public.profiles add column if not exists suspended_reason text;

-- A reason is short by construction, not by hope. The dashboard already caps
-- what it sends, but a length ceiling in the schema is what makes that true
-- for any future writer as well - and it keeps the `events` audit row that
-- copies this value inside the existing events_sane constraint (props must be
-- under 4096 bytes).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_suspended_reason_len') then
    alter table public.profiles
      add constraint profiles_suspended_reason_len
      check (suspended_reason is null or length(suspended_reason) <= 200);
  end if;
end $$;

comment on column public.profiles.is_suspended is
  'Anti-abuse flag, written only by supabase/functions/dashboard-api. Read by breakdown and export-gate to refuse the gated features. NOT a security boundary: those call sites deliberately fail OPEN if this lookup errors, because locking out every paying user costs more than letting one abuser through for an hour.';
comment on column public.profiles.suspended_at is
  'When the CURRENT suspension took effect. NULL when not suspended. Current state, not history - the history is the admin_action rows in public.events.';
comment on column public.profiles.suspended_reason is
  'Short free text, required by dashboard-api when suspending, cleared on unsuspend. A suspension nobody can explain six months later is one nobody can safely reverse.';

-- Partial index: the only question ever asked of this column is "is THIS user
-- suspended", and suspended accounts are the rare case, so the index only
-- carries them. Matches the profiles_suspended_idx in 20260822090000 exactly,
-- so applying that file afterwards is a no-op for the index rather than a
-- conflict.
create index if not exists profiles_suspended_idx on public.profiles (user_id) where is_suspended;

-- ----------------------------------------------------------------------------
-- No RLS change is needed and none is made. `profiles` already has RLS on
-- with a single SELECT-own policy and no insert/update/delete policy at all
-- (20260715120000_accounts_quotas.sql), so these three columns inherit
-- exactly the right posture: a signed-in user can read their own suspension
-- state, nobody but a service_role client can write it. Adding a policy here
-- would be the only way to get that wrong.
-- ----------------------------------------------------------------------------
