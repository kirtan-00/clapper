-- ============================================================================
-- Clapper - Admin: engagement analytics (screens, tagging, moments, GOLD,
-- clip-number edits, wrap day, session end, returning users)
--
-- A NEW FILE, not an edit of 20260824090000_admin_analytics.sql - that
-- migration's own header says every migration in this directory is additive
-- and idempotent by convention, and the owner reviews each file before
-- applying it. Editing an already-written file in place would make a diff
-- that already shipped (or is already under review) silently change shape.
--
-- `create or replace function` REPLACES THE WHOLE BODY. Postgres does not
-- merge two definitions of the same function by name+signature - the second
-- `create or replace` simply wins. That means this file must restate every
-- key 20260824090000_admin_analytics.sql already returns (totals, app_opens,
-- projects_created, exports, cap_hits_other, pro_interest, pro_purchased) as
-- well as the new ones below, IN FULL, with the exact same signature
-- (`p_cutoff timestamptz default '2026-08-20T00:00:00+00'::timestamptz` -
-- change the argument list and Postgres creates a second overloaded function
-- instead of replacing this one, and the dashboard's single `.rpc()` call
-- would hit whichever one it resolves to, not necessarily this one). Apply
-- THIS file after 20260824090000 lands; applying this one alone (without
-- 20260822090000_admin_suspension.sql's public.is_admin) fails the same way
-- that file's own header already documents.
--
-- WHAT'S NEW, and why each one is safe under the no-PII rule already
-- governing public.events (see src/net/analytics.ts's own comment on props
-- being counts/enums/booleans only - nothing here aggregates anything that
-- could carry user-typed text):
--
--   screens            screen_view, grouped by the `screen` enum (a nav
--                       route NAME - 'home'/'project'/'rolling'/etc, never a
--                       project or scene) - "which parts do they use".
--   app_opens.*_signed_in
--                       distinct signed-in users bucketed by whether they
--                       opened on more than one distinct UTC calendar day -
--                       "how often do they come back", for the only
--                       population this schema can dedupe at all (see the
--                       existing distinct_signed_in_users comment: no
--                       device id, so anonymous opens stay uncounted here).
--   tags_used           tag_used, split by the `gold` boolean. Never the tag
--                       TEXT - a project's tags are free text an operator
--                       typed (tagdefaults.ts), `gold` is a fixed boolean
--                       asking only "was this the one tag with its own
--                       button", which can never carry a name or a note.
--   moments_marked      moment_marked - MARK IN/OUT ranges, whether closed
--                       by a second tap or folded in automatically at CUT.
--   clip_number_edits   clip_number_edited, split by `surface`
--                       ('counter' - the live per-camera/project counter -
--                       vs 'take' - correcting an already-logged take).
--   wrap_days           wrap_day, split by `action` ('wrap'/'undo'). A PRESS
--                       count, not a shoot-day count - see this file's
--                       comment on the key itself and the dashboard's own
--                       label for why the two are not the same number.
--   session_ends        session_end, grouped by the `screen` that was
--                       showing when the tab backgrounded. An approximation
--                       of "which screen do people fall out on", NOT a
--                       session count - see the key's own comment.
--
-- Same pollution cutoff, same SECURITY DEFINER + is_admin gate, same
-- "pre-aggregated counts only, never a row of events" contract as
-- 20260824090000_admin_analytics.sql. This migration is IDEMPOTENT /
-- re-runnable: create-or-replace function, guarded revoke/grant.
--
-- Apply with the Supabase CLI (`supabase db push`) - NOT applied by the agent
-- that wrote this file. Only the owner applies migrations, after review.
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
  if v_uid is null or not public.is_admin(v_uid) then
    raise exception 'admin_analytics_summary: % is not an admin', v_uid;
  end if;

  select jsonb_build_object(
    'cutoff', p_cutoff,
    'cutoff_day', to_char(p_cutoff at time zone 'utc', 'YYYY-MM-DD'),
    'generated_at', now(),

    'totals', jsonb_build_object(
      'all_time_events', (select count(*) from public.events),
      'excluded_pre_cutoff_events', (select count(*) from public.events where created_at < p_cutoff),
      'clean_events', (select count(*) from public.events where created_at >= p_cutoff)
    ),

    -- App opens over time, distinct SIGNED-IN users, and (new) how many of
    -- those signed-in users came back on a LATER day rather than only ever
    -- opening on one. Still cannot say anything about anonymous opens - no
    -- device/session id exists in this schema, only an optional account id -
    -- so "how often do they come back" only ever answers for accounts.
    'app_opens', jsonb_build_object(
      'total', (
        select count(*) from public.events
        where name = 'app_open' and created_at >= p_cutoff
      ),
      'distinct_signed_in_users', (
        select count(distinct user_id) from public.events
        where name = 'app_open' and created_at >= p_cutoff and user_id is not null
      ),
      -- These two split distinct_signed_in_users and always sum back to it.
      -- "Opened on 2+ days" is a FLOOR on returning use, not the true rate:
      -- an installed PWA left open across days fires no second `app_open`,
      -- so a real returning user can still land in the single-day bucket.
      'returning_signed_in_users', (
        select count(*) from (
          select user_id from public.events
          where name = 'app_open' and created_at >= p_cutoff and user_id is not null
          group by user_id
          having count(distinct (created_at at time zone 'utc')::date) > 1
        ) t
      ),
      'single_day_signed_in_users', (
        select count(*) from (
          select user_id from public.events
          where name = 'app_open' and created_at >= p_cutoff and user_id is not null
          group by user_id
          having count(distinct (created_at at time zone 'utc')::date) = 1
        ) t
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

    'exports', jsonb_build_object(
      'by_format', coalesce((
        select jsonb_agg(jsonb_build_object(
          'format', fmts.format,
          'exported', coalesce(e.cnt, 0),
          'cap_hits', coalesce(c.cnt, 0)
        ) order by fmts.format)
        from (
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
    ),

    -- NEW BELOW THIS LINE (20260824150000). Everything above is restated
    -- verbatim from 20260824090000_admin_analytics.sql - see this file's
    -- header for why create-or-replace requires that.

    -- screen_view, grouped by the screen NAME (a fixed nav-route enum, see
    -- src/ui/nav.ts's Route type and AppShell.tsx's tracking effect - never
    -- a project name or anything a user typed). Answers "which parts do
    -- people actually use" at the screen level; the feature-level events
    -- below answer it at the action level.
    'screens', jsonb_build_object(
      'by_screen', coalesce((
        select jsonb_agg(jsonb_build_object('screen', screen, 'count', cnt) order by cnt desc)
        from (
          select coalesce(props->>'screen', 'unknown') as screen, count(*) as cnt
          from public.events
          where name = 'screen_view' and created_at >= p_cutoff
          group by 1
        ) t
      ), '[]'::jsonb)
    ),

    -- Quick-tag taps (src/ui/RollingScreen.tsx's tapTag), split only by the
    -- `gold` boolean - never the tag text itself, which is free-text house
    -- vocabulary a crew typed into Settings or the New Project sheet
    -- (tagdefaults.ts) and is never sent to this table at all.
    'tags_used', jsonb_build_object(
      'total', (
        select count(*) from public.events
        where name = 'tag_used' and created_at >= p_cutoff
      ),
      'gold', (
        select count(*) from public.events
        where name = 'tag_used' and created_at >= p_cutoff and props->>'gold' = 'true'
      )
    ),

    -- MARK IN / MARK OUT ranges (src/ui/RollingScreen.tsx's markInOut, plus
    -- the same event fired when CUT folds a still-armed MARK IN into a range
    -- automatically). No further split - the event carries no other props.
    'moments_marked', (
      select count(*) from public.events
      where name = 'moment_marked' and created_at >= p_cutoff
    ),

    -- Clip-number corrections, split by WHERE the number was changed:
    -- 'counter' is the live per-camera/project counter (RollingScreen's
    -- MultiClipSheet/ClipNumberSheet, steering where the NEXT clip lands),
    -- 'take' is TakeEditSheet correcting a number on a take already logged.
    'clip_number_edits', jsonb_build_object(
      'by_surface', coalesce((
        select jsonb_agg(jsonb_build_object('surface', surface, 'count', cnt) order by cnt desc)
        from (
          select coalesce(props->>'surface', 'unknown') as surface, count(*) as cnt
          from public.events
          where name = 'clip_number_edited' and created_at >= p_cutoff
          group by 1
        ) t
      ), '[]'::jsonb)
    ),

    -- Wrap day PRESSES (src/ui/ProjectScreen.tsx's doWrap/doUndo) - counted
    -- separately from the dashboard's existing "shoot days" refusal (see
    -- the Not-shown card): this is real, but it is a count of an operator's
    -- button press, not a count of shoot days. A crew that forgets to press
    -- it keeps logging under the day that never closed, and this number has
    -- no way to tell that apart from a day that genuinely ran long - the
    -- dashboard must label this "presses", never "days".
    'wrap_days', jsonb_build_object(
      'wrapped', (
        select count(*) from public.events
        where name = 'wrap_day' and created_at >= p_cutoff and props->>'action' = 'wrap'
      ),
      'undone', (
        select count(*) from public.events
        where name = 'wrap_day' and created_at >= p_cutoff and props->>'action' = 'undo'
      )
    ),

    -- session_end, grouped by the screen recorded when the tab went to the
    -- background (src/net/analytics.ts's visibilitychange listener). An
    -- APPROXIMATION of "where people fall out", not a session count: on set
    -- the phone locks between takes constantly, so one real sitting throws
    -- off several of these rows, not one. The dashboard must render this
    -- only as a distribution ("last screen seen before backgrounding"),
    -- never total it as "N sessions".
    'session_ends', jsonb_build_object(
      'total', (
        select count(*) from public.events
        where name = 'session_end' and created_at >= p_cutoff
      ),
      'by_screen', coalesce((
        select jsonb_agg(jsonb_build_object('screen', screen, 'count', cnt) order by cnt desc)
        from (
          select coalesce(props->>'screen', 'unknown') as screen, count(*) as cnt
          from public.events
          where name = 'session_end' and created_at >= p_cutoff
          group by 1
        ) t
      ), '[]'::jsonb)
    )
  )
  into v_result;

  return v_result;
end;
$$;

revoke execute on function public.admin_analytics_summary(timestamptz) from public, anon;
grant  execute on function public.admin_analytics_summary(timestamptz) to authenticated;
