-- Razorpay payments.
--
-- One row per order, written the moment an order is created rather than when it
-- succeeds. That is deliberate: a payment can succeed at Razorpay and never
-- reach our verify endpoint (the browser was closed, the network dropped during
-- the callback), and when that happens the only way to reconcile the money in
-- the dashboard against a person is a row that already existed.
--
-- The status values are a lifecycle, not a flag:
--   created            order made, modal not yet completed
--   paid               signature verified, Pro granted
--   signature_failed   HMAC did not match. Granted NOTHING. A bug or an attempt.
--   paid_grant_failed  money taken, is_pro write failed. The one that costs a
--                      real person real money. Alert on it.

create table if not exists public.payments (
  order_id   text primary key,
  user_id    uuid        not null references auth.users (id) on delete cascade,
  plan       text        not null,
  amount     int         not null,          -- paise, as sent to Razorpay
  currency   text        not null default 'INR',
  status     text        not null default 'created',
  payment_id text,                          -- razorpay_payment_id, set on completion
  paid_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payments_user_idx on public.payments (user_id, created_at desc);
-- The reconciliation query: everything that took money and did not land.
create index if not exists payments_status_idx on public.payments (status)
  where status in ('created', 'paid_grant_failed', 'signature_failed');

-- RLS on, and NO policies for the anon/authenticated roles. Every read and
-- write goes through the service-role key inside the two edge functions. A
-- client that could write this table could grant itself Pro, so it cannot
-- reach it at all — not even to read its own rows. If a receipts screen is
-- ever wanted, add a SELECT-only policy then, deliberately.
alter table public.payments enable row level security;

-- When Pro actually expires. `is_pro` alone cannot express "paid, ran out in
-- March" — it is a boolean with no clock, so without this the first sale is
-- also the last one that ever needs to be made.
alter table public.profiles add column if not exists pro_until timestamptz;

comment on column public.profiles.pro_until is
  'When the current Pro grant lapses. NULL = never purchased. Set by razorpay-verify; nothing else should write it.';
