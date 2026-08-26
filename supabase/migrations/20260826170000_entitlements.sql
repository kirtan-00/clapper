-- Per-project entitlements. NOT APPLIED. Read it before you run it.
--
-- WHAT CHANGED AND WHY THE OLD MODEL CANNOT EXPRESS IT.
-- `profiles.is_pro` + `profiles.pro_until` is a CLOCK: an account is Pro until
-- a date. What is being sold now is not time, it is a project. One credit
-- unlocks one project, permanently, and that project keeps PDF export,
-- Premiere XML export, shot division upload and the folder feature for good.
-- No column on `profiles` can hold "these four projects, forever" - that is a
-- row per project, which is what project_entitlements is.
--
-- is_pro AND pro_until STAY. They are live, ten real accounts depend on them,
-- the dashboard grants comps with them, and export-gate and breakdown both
-- read them. Nothing below drops or rewrites either one. An is_pro account
-- keeps working exactly as it does today; the new tables are additive and are
-- read by nothing until the functions that read them are deployed.
--
-- WHAT A PROJECT ID IS, AND WHY IT IS NOT TRUSTED. Projects live in IndexedDB
-- on the phone and sync up. A project id arriving from a client is a string
-- the client chose. So the primary key here is (user_id, project_id) with the
-- user id taken from the verified JWT and never from the body: a client can
-- name any project it likes, but it can only ever name one of ITS OWN, and the
-- worst it can do by inventing an id is spend its own credit on a project that
-- does not exist. That is the whole trust model, and it is why nothing here
-- references a projects table (there isn't one, and there does not need to be).

-- ---------------------------------------------------------------------------
-- 1. Credit balance
-- ---------------------------------------------------------------------------
-- Two counters, not one. `project_credits` goes down when a project is
-- unlocked; `credits_purchased_total` never goes down, because it answers a
-- different question - "has this person ever bought anything?" - which is what
-- decides whether the introductory price is still on offer. One counter could
-- not answer both: spending your fifth credit would make you a first time
-- buyer again and re-open the 5-for-5 price forever.
alter table public.profiles
  add column if not exists project_credits int not null default 0;
alter table public.profiles
  add column if not exists credits_purchased_total int not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_credits_nonneg') then
    alter table public.profiles
      add constraint profiles_credits_nonneg
      check (project_credits >= 0 and credits_purchased_total >= 0);
  end if;
end $$;

comment on column public.profiles.project_credits is
  'Unspent project unlocks. Decremented by unlock_project, incremented by grant_project_credits. Nothing else should write it.';
comment on column public.profiles.credits_purchased_total is
  'Lifetime credits bought. Never decremented. Decides introductory-price eligibility.';

-- ---------------------------------------------------------------------------
-- 2. The purchase ledger
-- ---------------------------------------------------------------------------
-- One row per gateway EVENT, keyed on (provider, provider_event_id). That
-- composite key IS the idempotency guarantee: a retried webhook cannot insert
-- a second row, and the conditional claim below means only one delivery can
-- ever move a row out of 'received'. Paddle retries a failed delivery up to 60
-- times over three days and a manual replay reuses the same event_id, so this
-- is not a theoretical concern - it is the normal case.
--
-- provider is a column, not an assumption. Razorpay is parked, not deleted,
-- and a second gateway must land in the same ledger rather than in a second
-- table nobody reconciles.
--
-- user_id is NULLABLE and `on delete set null`. A payment we cannot attach to
-- an account is exactly the row that must survive: dropping it would lose the
-- only record that money moved. Deleting the account later must not delete the
-- receipt either.
--
-- The lifecycle:
--   received         recorded, not yet granted
--   granting         claimed by one delivery, grant in flight
--   granted          credits added
--   grant_failed     money taken, credit write failed. Costs a real person real money.
--   user_unknown     paid, but no account resolved from custom_data
--   unknown_product  paid, but the price id matches no product in the catalogue
create table if not exists public.purchases (
  provider          text        not null,
  provider_event_id text        not null,
  user_id           uuid        references auth.users (id) on delete set null,
  provider_txn_id   text,
  product_key       text,
  credits           int         not null default 0,
  amount_cents      int,
  currency          text,
  status            text        not null default 'received',
  note              text,
  occurred_at       timestamptz,
  granted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (provider, provider_event_id)
);

create index if not exists purchases_user_idx on public.purchases (user_id, created_at desc);
-- THE RECONCILIATION QUERY: everything that took money and did not land.
-- Matches NEEDS_ATTENTION_STATUSES in _shared/entitlements.ts exactly; if one
-- list grows, so does the other, or the dashboard panel silently stops using
-- the index.
create index if not exists purchases_attention_idx on public.purchases (status)
  where status in ('received', 'granting', 'grant_failed', 'user_unknown', 'unknown_product');

-- RLS on, and NO policies for anon/authenticated. Everything goes through the
-- service-role key inside the webhook. A client that could write this table
-- could grant itself credits, so it cannot reach it at all.
alter table public.purchases enable row level security;

-- ---------------------------------------------------------------------------
-- 3. Per-project entitlement AND the per-project counter
-- ---------------------------------------------------------------------------
-- One table, two jobs, on purpose. `unlocked_at is null` means the project has
-- been seen but not bought; a timestamp means it is unlocked forever. The
-- upload counter lives on the same row because the cap applies to EVERY
-- project, free or unlocked, and a counter that only existed for unlocked
-- projects would reset itself the moment somebody paid.
--
-- THE CAP THAT SURVIVES PAYING: at most 2 shot division uploads per project,
-- forever, unlocked or not. Without it one unlocked project is a lifetime
-- subscription - keep a single project and upload a new shot division for
-- every shoot. See consume_project_breakdown below; the guard is in the WHERE.
create table if not exists public.project_entitlements (
  user_id           uuid        not null references auth.users (id) on delete cascade,
  project_id        text        not null,
  unlocked_at       timestamptz,
  unlock_source     text,
  breakdown_uploads int         not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (user_id, project_id),
  -- Bounded because it is a client-chosen string. The app's own ids are uuids;
  -- 64 is generous and stops the column being used as storage.
  constraint project_entitlements_id_len check (length(project_id) between 1 and 64),
  constraint project_entitlements_uploads_nonneg check (breakdown_uploads >= 0)
);

create index if not exists project_entitlements_unlocked_idx
  on public.project_entitlements (user_id) where unlocked_at is not null;

alter table public.project_entitlements enable row level security;

comment on table public.project_entitlements is
  'One row per (account, project). unlocked_at set = paid for, permanently. breakdown_uploads is capped per project even after unlocking.';

-- ---------------------------------------------------------------------------
-- 4. Functions. SECURITY DEFINER, search_path = '', service_role only,
--    every guard in a WHERE clause so concurrency cannot double spend.
-- ---------------------------------------------------------------------------

-- grant_project_credits: add bought credits. Returns the new balance, or -1 if
-- there is no such profile (which the caller records as grant_failed rather
-- than swallowing).
create or replace function public.grant_project_credits(p_user uuid, p_credits int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new int;
begin
  if p_credits is null or p_credits <= 0 then
    raise exception 'grant_project_credits: credits must be positive';
  end if;

  update public.profiles
     set project_credits          = project_credits + p_credits,
         credits_purchased_total  = credits_purchased_total + p_credits
   where user_id = p_user
  returning project_credits into v_new;

  if v_new is null then
    return -1;
  end if;
  return v_new;
end;
$$;

revoke execute on function public.grant_project_credits(uuid, int) from public, anon, authenticated;
grant  execute on function public.grant_project_credits(uuid, int) to service_role;

-- unlock_project: spend one credit on one project, forever.
--   >= 0  unlocked, returns the remaining balance
--   -1    no credits
--   -2    already unlocked (idempotent, and NOT an error)
--
-- Both writes are guarded in their WHERE clause. Two taps at once cannot spend
-- two credits: the second UPDATE matches zero rows, and the credit it took is
-- handed straight back.
create or replace function public.unlock_project(p_user uuid, p_project text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_left int;
  v_hit  int;
begin
  if p_user is null or p_project is null or length(trim(p_project)) = 0 then
    raise exception 'unlock_project: user and project are required';
  end if;

  insert into public.project_entitlements (user_id, project_id)
  values (p_user, p_project)
  on conflict (user_id, project_id) do nothing;

  if exists (
    select 1 from public.project_entitlements
     where user_id = p_user and project_id = p_project and unlocked_at is not null
  ) then
    return -2;
  end if;

  update public.profiles
     set project_credits = project_credits - 1
   where user_id = p_user and project_credits > 0
  returning project_credits into v_left;

  if v_left is null then
    return -1;
  end if;

  update public.project_entitlements
     set unlocked_at   = now(),
         unlock_source = 'credit',
         updated_at    = now()
   where user_id = p_user and project_id = p_project and unlocked_at is null;

  get diagnostics v_hit = row_count;
  if v_hit = 0 then
    -- Lost a race with another unlock of the same project. Give the credit
    -- back; the project is unlocked either way.
    update public.profiles
       set project_credits = project_credits + 1
     where user_id = p_user;
    return -2;
  end if;

  return v_left;
end;
$$;

revoke execute on function public.unlock_project(uuid, text) from public, anon, authenticated;
grant  execute on function public.unlock_project(uuid, text) to service_role;

-- consume_project_breakdown: the per-project shot division cap. Same single
-- atomic UPDATE as consume_quota, same contract: the new count, or -1 when the
-- project is at its limit. p_limit is passed by the caller (2, from
-- BREAKDOWNS_PER_PROJECT in _shared/products.ts) rather than hardcoded here,
-- so the number lives in one place that a human reads.
create or replace function public.consume_project_breakdown(p_user uuid, p_project text, p_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new int;
begin
  if p_user is null or p_project is null or length(trim(p_project)) = 0 then
    raise exception 'consume_project_breakdown: user and project are required';
  end if;

  insert into public.project_entitlements (user_id, project_id)
  values (p_user, p_project)
  on conflict (user_id, project_id) do nothing;

  update public.project_entitlements
     set breakdown_uploads = breakdown_uploads + 1,
         updated_at        = now()
   where user_id = p_user
     and project_id = p_project
     and breakdown_uploads < p_limit
  returning breakdown_uploads into v_new;

  if v_new is null then
    return -1;
  end if;
  return v_new;
end;
$$;

revoke execute on function public.consume_project_breakdown(uuid, text, int) from public, anon, authenticated;
grant  execute on function public.consume_project_breakdown(uuid, text, int) to service_role;

-- refund_project_breakdown: give a slot back when the upload was consumed and
-- the work then failed downstream (Groq outage, paused gate). Clamped at zero
-- so it can never go negative. Mirrors refund_quota.
create or replace function public.refund_project_breakdown(p_user uuid, p_project text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.project_entitlements
     set breakdown_uploads = greatest(0, breakdown_uploads - 1),
         updated_at        = now()
   where user_id = p_user and project_id = p_project;
end;
$$;

revoke execute on function public.refund_project_breakdown(uuid, text) from public, anon, authenticated;
grant  execute on function public.refund_project_breakdown(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4b. Subscriptions
-- ---------------------------------------------------------------------------
-- ADDED 2026-08-26, WHEN THE MODEL CHANGED FROM ONE-TIME CREDITS TO A
-- SUBSCRIPTION PLUS A BUNDLE. Nothing above this section is touched: a
-- credit still unlocks one project, permanently, whether it came from a
-- monthly grant or a bundle. What is new is HOW a credit gets granted every
-- month, and the one new failure mode a subscription creates that a one-time
-- purchase never could: the same account collecting the first-month bonus
-- more than once by cancelling and resubscribing.
--
-- subscription_intro_bonus_granted IS THE WHOLE MECHANISM THAT PREVENTS
-- THAT. It is a flag on the ACCOUNT, not on a subscription id, it is set
-- exactly once, and it is never reset - not on cancellation, not on a new
-- subscription starting later. grant_subscription_invoice_credits flips it
-- atomically in the same statement that decides which credit amount to
-- grant, so two first invoices for one account (should never happen - one
-- checkout creates one subscription - but "should never happen" is not
-- something a WHERE clause gets to assume) cannot both win it.
alter table public.profiles
  add column if not exists subscription_intro_bonus_granted boolean not null default false;
comment on column public.profiles.subscription_intro_bonus_granted is
  'True once this account has ever received the 5-credit first-month bonus, on any subscription, ever. Set exactly once, inside grant_subscription_invoice_credits, guard in the WHERE clause. Never reset by cancellation or by starting a second subscription - that is what stops the bonus being collected twice.';

-- subscription_status / subscription_id / subscription_current_period_end
-- are a MIRROR, written by customer.subscription.created/.updated/.deleted,
-- for the dashboard to show at a glance. NOTHING READS THESE THREE COLUMNS
-- TO GATE A FEATURE. project_credits, credits_purchased_total and
-- project_entitlements are the only things export-gate, breakdown and the
-- unlock path ever look at, and none of the three subscription columns
-- appears in any of those checks - a cancelled or unpaid subscription stops
-- FUTURE grants (invoice.paid simply stops arriving) without touching a
-- single credit already spent or a single project already unlocked. That
-- project stays unlocked forever, exactly as a bundle-bought one does.
alter table public.profiles
  add column if not exists subscription_status text;
alter table public.profiles
  add column if not exists subscription_id text;
alter table public.profiles
  add column if not exists subscription_current_period_end timestamptz;
comment on column public.profiles.subscription_status is
  'Mirror of the Stripe Subscription.status field (active, trialing, past_due, canceled, unpaid, incomplete, incomplete_expired, paused), written by customer.subscription.created/.updated/.deleted. Null means never subscribed. Display only for the dashboard Money panel - see the note above about what does and does not gate on it.';
comment on column public.profiles.subscription_id is
  'The Stripe subscription id (sub_...) this account last had. Overwritten if the account starts a second subscription later; the purchase ledger, not this column, is the permanent record.';
comment on column public.profiles.subscription_current_period_end is
  'Best-effort renewal date off the Stripe subscription object, for display. Nothing gates on it.';

-- grant_subscription_invoice_credits: called once per invoice.paid, AFTER
-- the (provider, event_id) claim in `purchases` has already made this the
-- single winning delivery for THAT EVENT (see applySubscriptionCredit in
-- _shared/entitlements.ts). What THIS function guards against is a
-- different, longer-lived problem: whether the ACCOUNT has ever had its
-- first-month bonus before, which the caller cannot safely read and then
-- act on without a race.
--
--   p_is_first_invoice   true only for billing_reason = 'subscription_create'
--   p_intro_credits      5, from products.ts - granted the first time ever
--   p_renewal_credits    2, from products.ts - granted every other time,
--                        INCLUDING a first invoice when the bonus is
--                        already spent. A second subscription still grants
--                        something; it never grants the bonus twice.
--
-- Returns the credits actually granted, whether the bonus was the one
-- applied, and the new balance (-1 if there is no such profile, same
-- sentinel grant_project_credits already uses).
create or replace function public.grant_subscription_invoice_credits(
  p_user uuid,
  p_is_first_invoice boolean,
  p_intro_credits int,
  p_renewal_credits int
)
returns table(granted_credits int, bonus_applied boolean, balance int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hit     int;
  v_bonus   boolean := false;
  v_credits int;
  v_balance int;
begin
  if p_user is null then
    raise exception 'grant_subscription_invoice_credits: user is required';
  end if;
  if p_intro_credits is null or p_intro_credits <= 0
     or p_renewal_credits is null or p_renewal_credits <= 0 then
    raise exception 'grant_subscription_invoice_credits: credits must be positive';
  end if;

  if p_is_first_invoice then
    -- THE GUARD. One conditional UPDATE, guard in the WHERE clause, no read
    -- first - the unlock_project shape. Exactly one caller can ever flip
    -- this false to true for a given account.
    update public.profiles
       set subscription_intro_bonus_granted = true
     where user_id = p_user
       and subscription_intro_bonus_granted = false;
    get diagnostics v_hit = row_count;
    v_bonus := v_hit > 0;
  end if;

  v_credits := case when v_bonus then p_intro_credits else p_renewal_credits end;

  update public.profiles
     set project_credits         = project_credits + v_credits,
         credits_purchased_total = credits_purchased_total + v_credits
   where user_id = p_user
  returning project_credits into v_balance;

  if v_balance is null then
    v_balance := -1;
  end if;

  return query select v_credits, v_bonus, v_balance;
end;
$$;

revoke execute on function public.grant_subscription_invoice_credits(uuid, boolean, int, int) from public, anon, authenticated;
grant  execute on function public.grant_subscription_invoice_credits(uuid, boolean, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- 5. What is deliberately NOT here
-- ---------------------------------------------------------------------------
-- No trigger that grants credits. No policy that lets a client read or write
-- any of this. No drop of is_pro or pro_until. No projects table: the app's
-- projects live on the device, and inventing a server-side copy of them to
-- hang an entitlement on would be a sync problem far bigger than the feature.
-- No RPC that touches subscription_status/subscription_id/
-- subscription_current_period_end: those three are written with a plain
-- UPDATE from stripe-webhook (service role, same posture dashboard-api
-- already uses for is_pro/is_suspended), because setting a mirror to the
-- value Stripe just sent is idempotent by construction and needs no claim.

-- ---------------------------------------------------------------------------
-- 6. One more unique index, for a mistake that is easy to make in the Paddle
--    dashboard and expensive to make in production.
-- ---------------------------------------------------------------------------
-- `transaction.paid` and `transaction.completed` describe the SAME money and
-- carry DIFFERENT event ids, so subscribing to both would defeat the primary
-- key above and grant twice. The subscription is meant to be
-- `transaction.completed` only (see supabase/functions/paddle-webhook), but
-- "meant to" is a checkbox in somebody else's UI. This index makes the second
-- event for the same transaction unable to insert at all, so it is recorded as
-- a duplicate and grants nothing, whatever is ticked over there.
create unique index if not exists purchases_txn_idx
  on public.purchases (provider, provider_txn_id)
  where provider_txn_id is not null;
