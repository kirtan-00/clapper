-- ============================================================================
-- Clapper — Cloud Sync (outbox mirror for projects/slates/takes/moments)
-- Design: last-write-wins keyed on a SERVER-stamped updated_at. Single-writer
-- usage (one person, one device, one project during a shoot) means this is
-- deliberately NOT a CRDT / version-vector scheme — see the sync engine at
-- src/net/sync.ts for the client side of this contract.
--
-- Each entity is stored as a JSONB blob (`data`) rather than mapped column by
-- column: the app's data model (Project/Slate/Take/Moment in src/types.ts) is
-- rich, nested, and still evolving, and the server never queries INTO the
-- blob — it only needs id / owner / project scoping / timestamps to drive
-- RLS, cascade deletes, and delta pulls. Mapping every field here would be a
-- bug farm that drifts from src/types.ts on the very next feature.
--
-- This migration is IDEMPOTENT / re-runnable: create-if-not-exists tables,
-- drop-then-create policies/triggers, guarded constraint/index creation.
-- Apply with the Supabase CLI (`supabase db push`) — not applied by the agent
-- that wrote this file; no DB access was available while authoring it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. id columns are TEXT, not UUID
-- ----------------------------------------------------------------------------
-- Every entity's `id` is the CLIENT-generated id from src/store/util.ts's
-- newId() (crypto.randomUUID(), or a manual v4 fallback when that API is
-- unavailable — both currently emit standard UUIDv4 TEXT). We still declare
-- the column `text`, not `uuid`: the client is the sole source of truth for
-- ids (upsert is keyed on `id`, onConflict: 'id'), older/imported data is not
-- guaranteed to be UUID-shaped, and a `uuid` column would silently reject any
-- id that doesn't parse as one instead of just storing it. `text primary key`
-- accepts anything the client ever produced or will produce, with an ordinary
-- btree unique index underneath — no functional cost to this choice at
-- Clapper's data volumes (a shoot day is a few KB of text).

-- ----------------------------------------------------------------------------
-- 1. Tables
-- ----------------------------------------------------------------------------
-- Column shape is IDENTICAL across all four tables on purpose (id/owner/data/
-- timestamps), so the sync engine can treat them uniformly in a loop rather
-- than special-casing each one. `project_id` is the one column that differs:
-- present (and FK'd) on the three child tables for scoped queries + cascade
-- delete; always NULL on `projects` itself, since a project has no parent.

create table if not exists public.projects (
  id         text        primary key,
  owner_id   uuid        not null default auth.uid(),
  project_id text,                          -- always NULL here; column kept for a uniform shape across the 4 tables
  data       jsonb       not null,          -- the full Project object (src/types.ts), verbatim
  updated_at timestamptz not null default now(),
  deleted_at timestamptz                     -- projects are HARD-deleted by the client (FK cascade removes children); this column is not expected to be used, but kept for shape symmetry / forward compatibility
);

create table if not exists public.slates (
  id         text        primary key,
  owner_id   uuid        not null default auth.uid(),
  project_id text        not null references public.projects (id) on delete cascade,
  data       jsonb       not null,          -- the full Slate object, verbatim
  updated_at timestamptz not null default now(),
  deleted_at timestamptz                     -- soft-delete tombstone; NULL = live row
);

create table if not exists public.takes (
  id         text        primary key,
  owner_id   uuid        not null default auth.uid(),
  project_id text        not null references public.projects (id) on delete cascade,
  data       jsonb       not null,          -- the full Take object, verbatim
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.moments (
  id         text        primary key,
  owner_id   uuid        not null default auth.uid(),
  project_id text        not null references public.projects (id) on delete cascade,
  data       jsonb       not null,          -- the full Moment object, verbatim
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ----------------------------------------------------------------------------
-- 2. Row Level Security — one user's rows are visible/writable only by them
-- ----------------------------------------------------------------------------

alter table public.projects enable row level security;
alter table public.slates   enable row level security;
alter table public.takes    enable row level security;
alter table public.moments  enable row level security;

-- One identical policy per table, per operation: `owner_id = auth.uid()`.
-- `owner_id` defaults to auth.uid() on insert, but we still assert it in the
-- WITH CHECK so a client can never upsert a row it stamps with someone else's
-- owner_id. `to authenticated` only — sync requires a signed-in session
-- (src/net/sync.ts gates the whole engine on getAccessToken() being
-- non-null), so there is deliberately no anon policy on any of these tables.

drop policy if exists projects_owner_select on public.projects;
create policy projects_owner_select on public.projects for select
  to authenticated using (owner_id = auth.uid());
drop policy if exists projects_owner_insert on public.projects;
create policy projects_owner_insert on public.projects for insert
  to authenticated with check (owner_id = auth.uid());
drop policy if exists projects_owner_update on public.projects;
create policy projects_owner_update on public.projects for update
  to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists projects_owner_delete on public.projects;
create policy projects_owner_delete on public.projects for delete
  to authenticated using (owner_id = auth.uid());

drop policy if exists slates_owner_select on public.slates;
create policy slates_owner_select on public.slates for select
  to authenticated using (owner_id = auth.uid());
drop policy if exists slates_owner_insert on public.slates;
create policy slates_owner_insert on public.slates for insert
  to authenticated with check (owner_id = auth.uid());
drop policy if exists slates_owner_update on public.slates;
create policy slates_owner_update on public.slates for update
  to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists slates_owner_delete on public.slates;
create policy slates_owner_delete on public.slates for delete
  to authenticated using (owner_id = auth.uid());

drop policy if exists takes_owner_select on public.takes;
create policy takes_owner_select on public.takes for select
  to authenticated using (owner_id = auth.uid());
drop policy if exists takes_owner_insert on public.takes;
create policy takes_owner_insert on public.takes for insert
  to authenticated with check (owner_id = auth.uid());
drop policy if exists takes_owner_update on public.takes;
create policy takes_owner_update on public.takes for update
  to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists takes_owner_delete on public.takes;
create policy takes_owner_delete on public.takes for delete
  to authenticated using (owner_id = auth.uid());

drop policy if exists moments_owner_select on public.moments;
create policy moments_owner_select on public.moments for select
  to authenticated using (owner_id = auth.uid());
drop policy if exists moments_owner_insert on public.moments;
create policy moments_owner_insert on public.moments for insert
  to authenticated with check (owner_id = auth.uid());
drop policy if exists moments_owner_update on public.moments;
create policy moments_owner_update on public.moments for update
  to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists moments_owner_delete on public.moments;
create policy moments_owner_delete on public.moments for delete
  to authenticated using (owner_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 3. updated_at trigger — SERVER time only, never client-supplied
-- ----------------------------------------------------------------------------
-- The client never sends `updated_at` in its upserts (only id/owner_id/
-- project_id/data/deleted_at), but even if it did, this trigger stomps
-- whatever arrived with `now()` on every insert AND update. This is what lets
-- last-write-wins be keyed on updated_at safely: a phone with a drifted or
-- wrong clock can never claim a write happened earlier/later than it really
-- did, and the delta-pull cursor (max updated_at seen) always advances
-- monotonically with real wall-clock server time.

create or replace function public.clapper_sync_set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.projects;
create trigger set_updated_at
  before insert or update on public.projects
  for each row execute function public.clapper_sync_set_updated_at();

drop trigger if exists set_updated_at on public.slates;
create trigger set_updated_at
  before insert or update on public.slates
  for each row execute function public.clapper_sync_set_updated_at();

drop trigger if exists set_updated_at on public.takes;
create trigger set_updated_at
  before insert or update on public.takes
  for each row execute function public.clapper_sync_set_updated_at();

drop trigger if exists set_updated_at on public.moments;
create trigger set_updated_at
  before insert or update on public.moments
  for each row execute function public.clapper_sync_set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Indexes
-- ----------------------------------------------------------------------------
-- (owner_id, updated_at) is the index the delta-pull query drives on:
--   select * from <table> where updated_at > :cursor order by updated_at
-- RLS already restricts rows to owner_id = auth.uid() under the hood, so this
-- composite index serves both the implicit RLS filter and the ORDER BY in one
-- pass. A plain project_id index backs the FK + the (currently unused but
-- cheap to have ready) scoped-per-project query path.

create index if not exists projects_owner_updated_idx on public.projects (owner_id, updated_at);
create index if not exists slates_owner_updated_idx   on public.slates   (owner_id, updated_at);
create index if not exists takes_owner_updated_idx    on public.takes   (owner_id, updated_at);
create index if not exists moments_owner_updated_idx  on public.moments (owner_id, updated_at);

create index if not exists slates_project_idx  on public.slates  (project_id);
create index if not exists takes_project_idx   on public.takes   (project_id);
create index if not exists moments_project_idx on public.moments (project_id);
