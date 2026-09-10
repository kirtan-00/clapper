-- Email send log. NOT APPLIED until run by hand or via the CLI - same posture
-- as every other migration in this directory (this project's
-- schema_migrations table is empty; a file in this directory proves nothing
-- about what is live - see feedback_supabase_untracked_migrations.md).
--
-- WHAT THIS IS FOR. dashboard-api's Email tab needs one thing no table in
-- this schema currently holds: "which email address was sent which campaign,
-- when, and under what Brevo message id" - the join key between a send and
-- (a) that person's Clapper account, via email, and (b) that message's own
-- delivery/open/click stats in Brevo, via message_id. Without this table the
-- dashboard can ask Brevo "how many opens for tag X" but can never answer
-- "did email land ME a signed-up, active user" - the whole point of the tab.
--
-- ONE ROW PER SEND, NOT PER RECIPIENT. A recipient who receives the same
-- campaign twice (a resend after a bounce, a second cold-outreach pass) gets
-- two rows - that is a real fact ("we emailed them twice") the dashboard
-- should be able to show, not something to dedupe away at write time. Anyone
-- who needs "distinct recipients" reads distinct(email) over this table
-- instead.
create table if not exists public.email_sends (
  id         bigint generated always as identity primary key,
  email      text        not null,
  campaign   text        not null,
  message_id text,
  -- Brevo today; a text column (not an enum) because a future provider swap
  -- should not need a migration, same reasoning as purchases.provider.
  provider   text        not null default 'brevo',
  -- 'sent' | 'failed' - what send-thankyou.mjs / send-cold.mjs actually saw
  -- from the Brevo API response for this recipient, not an assumption. A
  -- failed send still gets a row: "we tried to email them and it did not go"
  -- is exactly the kind of silent gap this table exists to make visible.
  status     text        not null default 'sent',
  sent_at    timestamptz not null default now()
);

create index if not exists email_sends_email_idx
  on public.email_sends (lower(email));
create index if not exists email_sends_campaign_idx
  on public.email_sends (campaign, sent_at desc);

comment on table public.email_sends is
  'One row per outbound Brevo send (thank-you / cold outreach / future campaigns). Written by scripts/send-thankyou.mjs and scripts/send-cold.mjs via the Supabase Management API (service-role-equivalent, bypasses RLS) - never by a client. Read by dashboard-api''s Email tab, joined to auth.users by email and to public.events by the resulting user_id.';
comment on column public.email_sends.message_id is
  'The Brevo transactional-email messageId from a successful send. NULL on a failed send, or on a row seeded before this column was tracked. The join key into Brevo''s own per-message stats, when that lookup is added.';

-- RLS, default-deny, no policies - same posture as every other write-only
-- table in this schema (rate_events, config, script_mode_daily). Nothing here
-- is ever read by a signed-in client; only dashboard-api (service-role) and
-- the send scripts (Management API, which runs as the database owner and
-- bypasses RLS the same way service_role does) ever touch this table.
alter table public.email_sends enable row level security;
