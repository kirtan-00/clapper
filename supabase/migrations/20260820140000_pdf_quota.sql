-- The PDF export joins the quota system, and the free tier stops being one
-- number.
--
-- PDF has been completely ungated since it shipped: `ProjectScreen` calls it
-- straight through with no gate call at all, while Script Mode, Premiere/Resolve
-- XML and CSV each burned a counter. So the one export a producer actually
-- prints and hands round a unit was the only one nobody paid for.
--
-- The free tier is now per-format rather than a flat 5 across the board:
--
--   script    1    the expensive one - it calls Groq, and it is the feature
--                  Pro exists to sell
--   premiere  3    XML, POOLED across Premiere and DaVinci Resolve. They share
--                  one counter deliberately: they are the same handoff to the
--                  same editor, and charging twice for choosing a different NLE
--                  would be arbitrary
--   pdf       5    new here
--   csv       5    unchanged
--
-- The numbers themselves live in the edge function, not in this file. This
-- migration only teaches the database that `pdf` is a thing that can be
-- counted; `consume_quota` still takes its limit as an argument, so re-pricing
-- the tier never needs a migration again.

alter table public.usage add column if not exists pdf_uses int not null default 0;

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
    when 'script'   then 'script_uses'
    when 'premiere' then 'premiere_uses'
    when 'csv'      then 'csv_uses'
    when 'pdf'      then 'pdf_uses'
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
    when 'script'   then 'script_uses'
    when 'premiere' then 'premiere_uses'
    when 'csv'      then 'csv_uses'
    when 'pdf'      then 'pdf_uses'
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

comment on column public.usage.pdf_uses is
  'Free-tier PDF call sheets used. Added 2026-08-20; PDF was ungated before that.';
