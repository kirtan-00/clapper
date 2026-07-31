-- Anonymous XML-export allowance.
--
-- WHY A SECOND TABLE: public.usage is keyed `user_id uuid references
-- auth.users`, so it structurally cannot hold a count for someone who has no
-- account. A signed-out caller is identified only by the hash of their IP, so
-- their counter needs its own text-keyed home. Everything else about the
-- mechanism is deliberately identical to consume_quota below it in
-- 20260715120000: one atomic UPDATE, -1 when at/over the limit, service_role
-- as the sole caller. Enforcement never touches the client.
--
-- KNOWN AND ACCEPTED TRADE-OFF: an IP is not a person. A whole crew sharing
-- one set wifi shares ONE allowance, so the first person to export can spend
-- everyone else's; and the same phone on mobile data gets a fresh one. This
-- was chosen with those consequences understood - it is a nudge toward signing
-- in, not an entitlement boundary. Do not tighten anything real onto this key.

create table if not exists public.anon_usage (
  -- sha256(ip + IP_PEPPER), computed in the edge function. The raw IP is never
  -- stored, here or anywhere else.
  ip_hash       text        primary key,
  premiere_uses int         not null default 0,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- No policies, by design: nobody may read or write this table through the API.
-- Only the edge function's service-role client (which bypasses RLS) touches
-- it. Unlike public.usage there is no select-own policy, because there is no
-- "own" - an ip_hash is not an identity, and letting a client read a row keyed
-- by an IP hash would leak how many other people share that connection.
alter table public.anon_usage enable row level security;

-- Reclaimable: an ip_hash that has not been seen in a long time is just noise.
create index if not exists anon_usage_updated_idx on public.anon_usage (updated_at);

-- consume_anon_quota: the signed-out twin of consume_quota. Returns the new
-- count, or -1 if the row is at/over the limit. The INSERT seeds the row on
-- first sight (public.usage gets seeded per-user at signup; there is no such
-- moment for an anonymous caller), and the single UPDATE that follows is what
-- makes the limit check race-proof - two simultaneous exports on one IP cannot
-- both read "2 used" and both write 3.
--   p_kind ∈ {'premiere'} - deliberately narrower than consume_quota. Only the
--   XML editor handoff is offered signed-out; CSV and Script Mode still
--   require an account, so there is no column here for them to spend.
create or replace function public.consume_anon_quota(p_ip_hash text, p_kind text, p_limit int)
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
    when 'premiere' then 'premiere_uses'
    else null
  end;

  if v_col is null then
    raise exception 'consume_anon_quota: invalid kind %', p_kind;
  end if;

  -- An empty key would collapse every un-identifiable caller into one shared
  -- bucket. Refuse rather than pretend: the edge function is expected to have
  -- already rejected this, and this is the second line of that defence.
  if p_ip_hash is null or length(trim(p_ip_hash)) = 0 then
    raise exception 'consume_anon_quota: empty ip_hash';
  end if;

  insert into public.anon_usage (ip_hash) values (p_ip_hash)
  on conflict (ip_hash) do nothing;

  execute format(
    'update public.anon_usage set %1$I = %1$I + 1, updated_at = now() '
    || 'where ip_hash = $1 and %1$I < $2 returning %1$I',
    v_col
  )
  into v_new
  using p_ip_hash, p_limit;

  if v_new is null then
    return -1;
  end if;

  return v_new;
end;
$$;

revoke execute on function public.consume_anon_quota(text, text, int) from public, anon, authenticated;
grant  execute on function public.consume_anon_quota(text, text, int) to service_role;
