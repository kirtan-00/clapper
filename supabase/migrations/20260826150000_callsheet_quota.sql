-- The free tier stops charging two different features out of one pocket.
--
-- `supabase/functions/breakdown` serves two modes and, until now, both spent
-- the same `script_uses` counter at the same limit of 5:
--
--   mode 'shots'      the shot-list breakdown. Sends the already-parsed shot
--                     division to Groq and gets back the tappable key-moment
--                     chips. This is the expensive one, and it is the feature
--                     Pro exists to sell.
--   mode 'callsheet'  given the project's known scenes, works out which are
--                     shooting today. Cheap, and a PER SHOOT DAY action.
--
-- Sharing one counter was wrong in both directions. The app, the Account
-- screen and the whole public site say the shot-list breakdown is 1 free, and
-- the server was quietly allowing 5 - a user could read "4 of 1". Meanwhile
-- capping the call sheet at anything like 1 for the LIFE of an account reads
-- as broken on day two of a shoot, because loading tomorrow's call sheet is
-- something a first AD does every single morning.
--
-- So they split:
--
--   script_uses     1   shot-list breakdown, lifetime, free tier
--   callsheet_uses  5   call-sheet parse, lifetime, free tier
--
-- Pro stays effectively uncapped on both (1000000 in the edge function).
--
-- The numbers themselves are NOT in this file. `consume_quota` still takes its
-- limit as an argument, exactly as 20260820140000_pdf_quota.sql set it up to,
-- so re-pricing the tier never needs a migration. This migration only teaches
-- the database that `callsheet` is a thing that can be counted.
--
-- ORDER OF DEPLOY MATTERS. Until this is applied, `consume_quota` raises
-- `invalid kind callsheet` and the breakdown function's fail-closed branch
-- turns that into an HTTP 500 on every call-sheet parse. Apply this migration
-- FIRST, then deploy the breakdown function, then ship the client.
--
-- Re-runnable: add-column-if-not-exists, create-or-replace functions,
-- idempotent grants.
--
-- EXERCISED MANUALLY, not by vitest. The test suite in src/ is DOM-less
-- TypeScript and cannot reach an RPC; what it pins is that the two counters
-- are independent on the read side (src/net/quota.test.ts). The atomicity of
-- the update below is unchanged from the shipped function - it is still one
-- UPDATE with the limit in its WHERE clause, which is what makes a concurrent
-- double-spend impossible - and the permission posture is unchanged: SECURITY
-- DEFINER, empty search_path, execute granted to service_role alone.

alter table public.usage add column if not exists callsheet_uses int not null default 0;

-- Both functions map a kind onto a column, so both need the new kind. Recreated
-- rather than altered because plpgsql has no way to add a `when` to a case.

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
    when 'script'    then 'script_uses'
    when 'callsheet' then 'callsheet_uses'
    when 'premiere'  then 'premiere_uses'
    when 'csv'       then 'csv_uses'
    when 'pdf'       then 'pdf_uses'
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
    when 'script'    then 'script_uses'
    when 'callsheet' then 'callsheet_uses'
    when 'premiere'  then 'premiere_uses'
    when 'csv'       then 'csv_uses'
    when 'pdf'       then 'pdf_uses'
    else null
  end;

  if v_col is null then
    raise exception 'refund_quota: invalid kind %', p_kind;
  end if;

  -- greatest(...,0) so a double refund can never hand out free credit.
  execute format(
    'update public.usage set %1$I = greatest(%1$I - 1, 0), updated_at = now() '
    'where user_id = $1', v_col)
    using p_user;
end;
$$;

revoke execute on function public.refund_quota(uuid, text) from public, anon, authenticated;
grant  execute on function public.refund_quota(uuid, text) to service_role;

comment on column public.usage.callsheet_uses is
  'Free-tier call-sheet parses used (breakdown mode=callsheet). Added 2026-08-26; before that this shared script_uses with the shot-list breakdown, which meant one counter priced two different features.';

comment on column public.usage.script_uses is
  'Free-tier shot-list breakdowns used (breakdown mode=shots). From 2026-08-26 this counts ONLY the shot-list breakdown; call-sheet parses moved to callsheet_uses.';
