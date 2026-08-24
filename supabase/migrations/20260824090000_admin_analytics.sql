-- ============================================================================
-- Clapper - Admin: read-only analytics for the /admin/ dashboard
--
-- The dashboard lives at clapper.in/admin/, a STATIC file in a
-- PUBLIC repo, served with no server of its own. It ships only the anon key
-- (already public - see src/net/supabase.ts) and the code that asks for
-- numbers, never a number itself. Whoever decides "does this caller get
-- data back" has to be Postgres, not the page's own JavaScript, because
-- anyone can open devtools and flip a client-side `if (isAdmin)`.
--
-- This migration adds exactly one read path: admin_analytics_summary(),
-- SECURITY DEFINER, callable by any authenticated user but refusing every
-- one of them except the accounts listed in public.admins. A non-admin
-- calling it by hand - same URL, same anon key, their own real session -
-- gets the exact same refusal the dashboard's "not an admin" screen shows.
-- There is no separate, weaker path: this function is the only way the
-- browser can ever get a number out of public.events.
--
-- WHY A FUNCTION, NOT AN RLS SELECT POLICY ON events.
-- events.props carries whatever a call site passed - including trackError's
-- raw error message/stack (src/net/analytics.ts). A SELECT policy would let
-- an admin pull those rows verbatim. This function never returns a row of
-- events; it returns pre-aggregated counts only, so the widest a leak can
-- ever be is "N people did X on day Y" - never a stack trace, never an
-- email, never one user's own props. public.events keeps ZERO select
-- policies after this migration, exactly as it has since 20260715120000 -
-- the only door in is this function, and this function only ever counts.
--
-- REQUIRED APPLY ORDER, same caveat 20260822090000 already raised: this
-- function calls public.is_admin(uuid), which does not exist until
-- 20260822090000_admin_suspension.sql is applied - and that migration's own
-- header states it was NOT applied when it was written (owner reviews and
-- applies it by hand). Nothing here duplicates public.admins or is_admin;
-- duplicating them would be a second copy of "who is an admin" that can
-- drift from the first. Apply in this order:
--   1. 20260822090000_admin_suspension.sql   (creates public.admins, is_admin)
--   2. 20260824090000_admin_analytics.sql    (this file)
-- Applying this file before that one will CREATE fine (the body is only
-- syntax-checked at creation) and then error the first time it is CALLED,
-- same lazy-resolution behaviour documented on admin_list_accounts.
--
-- THE POLLUTION CUTOFF. Roughly 79 percent of every event ever recorded is
-- development traffic - see the long comment in src/net/analytics.ts. The
-- LIVE_HOSTS hostname gate that stops new pollution shipped 2026-08-20
-- (commit 92c31ac); nothing before that date can be trusted. Every count
-- below is computed with `created_at >= p_cutoff`, defaulted to that date,
-- and the function also reports how many rows it excluded so the dashboard
-- can say so on screen rather than silently rendering a smaller number.
--
-- Apply with the Supabase CLI (`supabase db push`) - NOT applied by the
-- agent that wrote this file. Only the owner applies migrations, after
-- review, same rule as every other migration in this directory.
--
-- This migration is IDEMPOTENT / re-runnable: create-or-replace function,
-- guarded revoke/grant.
-- ============================================================================

create or replace function public.admin_analytics_summary(
  p_cutoff timestamptz default '2026-08-20T00:00:00+00'::timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_result jsonb;
begin
  -- No session at all (should not happen - PostgREST already requires a
  -- valid JWT to reach a `to authenticated` function - but checked anyway,
  -- the same defense-in-depth this schema uses everywhere else) and no
  -- admins-table membership both refuse identically. The caller cannot tell
  -- "you're not signed in" from "you're signed in but not an admin" from
  -- this error alone, which is the point - nothing about what exists leaks.
  if v_uid is null or not public.is_admin(v_uid) then
    raise exception 'admin_analytics_summary: % is not an admin', v_uid;
  end if;

  select jsonb_build_object(
    'cutoff', p_cutoff,
    -- Pre-formatted UTC calendar date, not left to the client to derive by
    -- slicing `cutoff`'s own ISO string. jsonb_build_object renders a
    -- timestamptz through the session's `timezone` setting, not always UTC,
    -- so a client-side slice(0, 10) is one GUC change away from reading the
    -- wrong day. This key removes that assumption entirely.
    'cutoff_day', to_char(p_cutoff at time zone 'utc', 'YYYY-MM-DD'),
    'generated_at', now(),

    'totals', jsonb_build_object(
      'all_time_events', (select count(*) from public.events),
      'excluded_pre_cutoff_events', (select count(*) from public.events where created_at < p_cutoff),
      'clean_events', (select count(*) from public.events where created_at >= p_cutoff)
    ),

    -- App opens over time, and distinct SIGNED-IN users. Anonymous opens
    -- (user_id null) count toward the total but cannot be deduplicated -
    -- there is no device/session id in this schema, only an optional
    -- account id - so "distinct users" only ever means distinct accounts.
    'app_opens', jsonb_build_object(
      'total', (
        select count(*) from public.events
        where name = 'app_open' and created_at >= p_cutoff
      ),
      'distinct_signed_in_users', (
        select count(distinct user_id) from public.events
        where name = 'app_open' and created_at >= p_cutoff and user_id is not null
      ),
      'by_day', coalesce((
        select jsonb_agg(jsonb_build_object('day', day, 'count', cnt) order by day)
        from (
          select (created_at at time zone 'utc')::date as day, count(*) as cnt
          from public.events
          where name = 'app_open' and created_at >= p_cutoff
          group by 1
        ) t
      ), '[]'::jsonb)
    ),

    -- Projects created, split by how (normal / script-mode / podcast - the
    -- three values project_created's own `mode` prop actually carries, see
    -- src/ui/NewProjectSheet.tsx and src/ui/ShotlistSheet.tsx).
    'projects_created', jsonb_build_object(
      'total', (
        select count(*) from public.events
        where name = 'project_created' and created_at >= p_cutoff
      ),
      'by_mode', coalesce((
        select jsonb_agg(jsonb_build_object('mode', mode, 'count', cnt) order by cnt desc)
        from (
          select coalesce(props->>'mode', 'unknown') as mode, count(*) as cnt
          from public.events
          where name = 'project_created' and created_at >= p_cutoff
          group by 1
        ) t
      ), '[]'::jsonb)
    ),

    -- Exports by format, paired with how many hit that SAME format's
    -- free-tier cap (the `cap_hit` event's `which` prop is set from the same
    -- FORMAT_LABEL keys as `export`'s `format` prop - see
    -- src/ui/ProjectScreen.tsx's exportGated). A format with exports but no
    -- cap row simply never got capped; the reverse (capped, never
    -- exported that format) is impossible by construction, since a cap can
    -- only fire on an attempt.
    'exports', jsonb_build_object(
      'by_format', coalesce((
        select jsonb_agg(jsonb_build_object(
          'format', fmts.format,
          'exported', coalesce(e.cnt, 0),
          'cap_hits', coalesce(c.cnt, 0)
        ) order by fmts.format)
        from (
          -- every format that was either exported or capped, at least once,
          -- since the cutoff - UNION already dedupes across the two lists.
          select distinct props->>'format' as format from public.events
          where name = 'export' and created_at >= p_cutoff
          union
          select distinct props->>'which' as format from public.events
          where name = 'cap_hit' and created_at >= p_cutoff
            and props->>'which' in ('pdf', 'premiere', 'resolve', 'csv')
        ) fmts
        left join (
          select props->>'format' as format, count(*) as cnt
          from public.events
          where name = 'export' and created_at >= p_cutoff
          group by 1
        ) e using (format)
        left join (
          select props->>'which' as format, count(*) as cnt
          from public.events
          where name = 'cap_hit' and created_at >= p_cutoff
            and props->>'which' in ('pdf', 'premiere', 'resolve', 'csv')
          group by 1
        ) c using (format)
        where fmts.format is not null
      ), '[]'::jsonb)
    ),

    -- Caps that are NOT an export format (Script Mode's own parse cap, the
    -- callsheet cap). Kept separate from `exports.by_format` rather than
    -- folded in, so an export chart never has to explain a row that isn't
    -- an export.
    'cap_hits_other', coalesce((
      select jsonb_agg(jsonb_build_object('which', which, 'count', cnt) order by cnt desc)
      from (
        select coalesce(props->>'which', 'unknown') as which, count(*) as cnt
        from public.events
        where name = 'cap_hit' and created_at >= p_cutoff
          and coalesce(props->>'which', 'unknown') not in ('pdf', 'premiere', 'resolve', 'csv')
        group by 1
      ) t
    ), '[]'::jsonb),

    -- pro_interest by gate (script / premiere / csv / account - ProGate in
    -- src/ui/ProCta.tsx), against pro_purchased. The ratio between these two
    -- numbers is the entire point of pro_interest existing (see the comment
    -- at the top of ProCta.tsx) - this migration does not compute the ratio
    -- itself and leaves that to the dashboard, which also has to carry the
    -- "selling is paused, zero purchases is not a crash" context that a raw
    -- SQL function has no business asserting.
    'pro_interest', jsonb_build_object(
      'total', (
        select count(*) from public.events
        where name = 'pro_interest' and created_at >= p_cutoff
      ),
      'by_gate', coalesce((
        select jsonb_agg(jsonb_build_object('gate', gate, 'count', cnt) order by cnt desc)
        from (
          select coalesce(props->>'gate', 'unknown') as gate, count(*) as cnt
          from public.events
          where name = 'pro_interest' and created_at >= p_cutoff
          group by 1
        ) t
      ), '[]'::jsonb)
    ),
    'pro_purchased', jsonb_build_object(
      'total', (
        select count(*) from public.events
        where name = 'pro_purchased' and created_at >= p_cutoff
      ),
      'by_plan', coalesce((
        select jsonb_agg(jsonb_build_object('plan', plan, 'count', cnt) order by cnt desc)
        from (
          select coalesce(props->>'plan', 'unknown') as plan, count(*) as cnt
          from public.events
          where name = 'pro_purchased' and created_at >= p_cutoff
          group by 1
        ) t
      ), '[]'::jsonb)
    )
  )
  into v_result;

  return v_result;
end;
$$;

-- `to authenticated`, not `to service_role` - unlike admin_suspend_user and
-- friends, nothing sits between this function and the browser. The admin
-- page calls it directly with the signed-in admin's own JWT (no edge
-- function), so auth.uid() inside the function body IS the real caller and
-- needs no p_admin argument to carry identity across a service-role hop.
-- Any authenticated user can attempt the call - the is_admin check above is
-- what actually gates it, same as every RLS policy in this schema gates on
-- auth.uid() rather than on who was allowed to ask.
revoke execute on function public.admin_analytics_summary(timestamptz) from public, anon;
grant  execute on function public.admin_analytics_summary(timestamptz) to authenticated;
