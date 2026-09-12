-- ============================================================================
--  FACE ATTENDANCE — COMPLETE DATABASE SETUP
--
--  Paste this whole file into the Supabase SQL Editor and press Run.
--  It is every migration concatenated in order, and is safe to re-run.
--
--  ---------------------------------------------------------------------
--  BEFORE YOU RUN IT: scroll to the very bottom (STEP 9) and change the
--  organization name, slug and timezone. That block only executes once,
--  on an empty database, so getting it right now saves a trip to the
--  settings page later.
--  ---------------------------------------------------------------------
--
--  Expected runtime: about 2 seconds. You should see "Success. No rows
--  returned", plus a NOTICE confirming the organization was created.
--
--  Afterwards, run supabase/verify.sql to confirm everything landed.
-- ============================================================================



-- ############################################################################
-- #  STEP 1 — Extensions, enums and shared helpers
-- ############################################################################

-- ============================================================================
-- 0001  Extensions, enums and shared helpers
-- ============================================================================

create extension if not exists "pgcrypto"  with schema extensions;
create extension if not exists "vector"    with schema extensions;
create extension if not exists "pg_trgm"   with schema extensions;

-- Everything the app owns lives in public; helper functions that must not be
-- callable by clients live in a private schema with no grants.
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.user_role as enum ('owner', 'admin', 'manager', 'employee');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.employment_status as enum ('active', 'suspended', 'terminated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.punch_kind as enum ('check_in', 'check_out');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.punch_outcome as enum (
    'accepted',
    'rejected_no_match',      -- face did not match the signed-in user
    'rejected_liveness',      -- failed the anti-spoofing checks
    'rejected_quality',       -- blur / pose / lighting below threshold
    'rejected_geofence',      -- outside the allowed radius
    'rejected_duplicate',     -- too soon after the previous punch
    'rejected_not_enrolled'   -- no face templates on file
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.day_status as enum (
    'present', 'late', 'half_day', 'absent', 'holiday', 'weekend', 'on_leave'
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function app_private.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;



-- ############################################################################
-- #  STEP 2 — Organizations, profiles, policy settings
-- ############################################################################

-- ============================================================================
-- 0002  Organizations, profiles, policy settings
-- ============================================================================

create table if not exists public.organizations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(trim(name)) between 2 and 120),
  slug              text unique not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  timezone          text not null default 'Asia/Kolkata',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One row per org. Kept separate from `organizations` so admins can be given
-- write access to policy without write access to org identity.
create table if not exists public.org_settings (
  org_id                  uuid primary key references public.organizations(id) on delete cascade,

  -- Working hours (local to organizations.timezone)
  workday_start           time not null default '09:30',
  workday_end             time not null default '18:30',
  late_grace_minutes      int  not null default 15 check (late_grace_minutes between 0 and 240),
  half_day_max_minutes    int  not null default 300 check (half_day_max_minutes between 0 and 1440),
  full_day_min_minutes    int  not null default 480 check (full_day_min_minutes between 0 and 1440),
  workdays                int[] not null default '{1,2,3,4,5}',  -- ISO dow, 1 = Monday

  -- Face matching.  Cosine similarity on L2-normalised 512-d ArcFace vectors.
  -- 0.36 is the InsightFace-recommended operating point for w600k_mbf; we
  -- default a little stricter because a false accept is worse than a retry.
  match_threshold         real not null default 0.42 check (match_threshold between 0.20 and 0.90),
  min_quality_score       real not null default 0.55 check (min_quality_score between 0 and 1),

  -- Liveness. 'off' | 'passive' | 'active'
  liveness_mode           text not null default 'active'
                          check (liveness_mode in ('off', 'passive', 'active')),
  min_liveness_score      real not null default 0.60 check (min_liveness_score between 0 and 1),

  -- Location
  geofence_enabled        boolean not null default false,
  geofence_lat            double precision,
  geofence_lng            double precision,
  geofence_radius_m       int not null default 200 check (geofence_radius_m between 20 and 20000),

  -- Anti-abuse
  min_punch_gap_seconds   int not null default 60 check (min_punch_gap_seconds between 0 and 3600),
  max_templates_per_user  int not null default 8 check (max_templates_per_user between 1 and 25),
  store_punch_photo       boolean not null default true,
  photo_retention_days    int not null default 30 check (photo_retention_days between 1 and 365),
  require_device_binding  boolean not null default false,

  updated_at              timestamptz not null default now(),

  constraint geofence_needs_coords check (
    not geofence_enabled or (geofence_lat is not null and geofence_lng is not null)
  )
);

create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  org_id            uuid not null references public.organizations(id) on delete cascade,
  email             text not null,
  full_name         text not null default '',
  employee_code     text,
  department        text,
  job_title         text,
  role              public.user_role not null default 'employee',
  status            public.employment_status not null default 'active',
  avatar_path       text,
  bound_device_hash text,           -- optional device pinning
  joined_on         date not null default current_date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, employee_code)
);

create index if not exists profiles_org_idx     on public.profiles (org_id, status);
create index if not exists profiles_name_trgm   on public.profiles using gin (full_name extensions.gin_trgm_ops);

create table if not exists public.holidays (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  day         date not null,
  name        text not null,
  created_at  timestamptz not null default now(),
  unique (org_id, day)
);

create table if not exists public.leave_records (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  start_day   date not null,
  end_day     date not null,
  reason      text not null default '',
  approved_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  check (end_day >= start_day)
);

create index if not exists leave_lookup_idx on public.leave_records (org_id, user_id, start_day, end_day);

drop trigger if exists touch_organizations on public.organizations;
create trigger touch_organizations before update on public.organizations
  for each row execute function app_private.touch_updated_at();

drop trigger if exists touch_org_settings on public.org_settings;
create trigger touch_org_settings before update on public.org_settings
  for each row execute function app_private.touch_updated_at();

drop trigger if exists touch_profiles on public.profiles;
create trigger touch_profiles before update on public.profiles
  for each row execute function app_private.touch_updated_at();



-- ############################################################################
-- #  STEP 3 — Biometric templates (pgvector)
-- ############################################################################

-- ============================================================================
-- 0003  Biometric templates
--
-- A "template" is a 512-float ArcFace embedding, L2-normalised client-side.
-- It is a one-way projection: you cannot reconstruct a recognisable face from
-- it, but it is still biometric personal data under GDPR Art. 9 and India's
-- DPDP Act, so it is treated as the most sensitive table in the schema:
--
--   * No role has a direct SELECT grant on the embedding column.
--   * All reads happen inside SECURITY DEFINER functions that return a score,
--     never a vector.
--   * A non-sensitive metadata view is exposed for the UI.
-- ============================================================================

create table if not exists public.face_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  embedding     extensions.vector(512) not null,
  quality       real not null default 0 check (quality between 0 and 1),
  model_version text not null default 'w600k_mbf@1',
  source        text not null default 'enrollment' check (source in ('enrollment', 'adaptive')),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null,
  revoked_at    timestamptz
);

create index if not exists face_templates_user_idx
  on public.face_templates (user_id) where revoked_at is null;

create index if not exists face_templates_org_idx
  on public.face_templates (org_id) where revoked_at is null;

-- HNSW over cosine distance.  For an org of a few hundred people a sequential
-- scan is already sub-millisecond, but the index keeps 1:N kiosk identification
-- flat as the org grows, and costs almost nothing at this size.
create index if not exists face_templates_hnsw
  on public.face_templates
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Hard guarantee: even a mistaken RLS policy cannot leak vectors, because the
-- client roles have no column privileges on the table at all.
revoke all on public.face_templates from anon, authenticated;

-- The non-sensitive metadata view is defined in 0005, once the role helpers it
-- filters on exist.



-- ############################################################################
-- #  STEP 4 — Attendance events and the daily roll-up
-- ############################################################################

-- ============================================================================
-- 0004  Attendance: raw punch events and the derived daily roll-up
-- ============================================================================

-- Every capture attempt is recorded, including rejections.  Rejections are the
-- interesting rows during an incident review, so they are never discarded.
create table if not exists public.punch_events (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  kind              public.punch_kind not null,
  outcome           public.punch_outcome not null,
  occurred_at       timestamptz not null default now(),
  local_day         date not null,

  similarity        real,            -- cosine similarity against the best template
  liveness_score    real,
  quality_score     real,
  matched_template  uuid references public.face_templates(id) on delete set null,

  lat               double precision,
  lng               double precision,
  accuracy_m        real,
  distance_m        real,            -- from the configured geofence centre

  device_hash       text,
  user_agent        text,
  ip                inet,
  photo_path        text,            -- Supabase Storage object, may be purged
  note              text,

  created_at        timestamptz not null default now()
);

create index if not exists punch_events_user_day_idx on public.punch_events (user_id, local_day desc);
create index if not exists punch_events_org_day_idx  on public.punch_events (org_id, local_day desc);
create index if not exists punch_events_outcome_idx  on public.punch_events (org_id, outcome, occurred_at desc)
  where outcome <> 'accepted';

-- One row per employee per day.  Maintained by trigger from accepted punches,
-- so reports never have to re-derive it and admins can hand-correct it.
create table if not exists public.attendance_days (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  local_day         date not null,
  first_in          timestamptz,
  last_out          timestamptz,
  worked_minutes    int not null default 0,
  status            public.day_status not null default 'absent',
  punches           int not null default 0,
  manually_edited   boolean not null default false,
  edited_by         uuid references public.profiles(id) on delete set null,
  edit_reason       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, local_day)
);

create index if not exists attendance_days_org_idx on public.attendance_days (org_id, local_day desc);
create index if not exists attendance_days_status_idx on public.attendance_days (org_id, local_day desc, status);

create table if not exists public.audit_log (
  id          bigserial primary key,
  org_id      uuid references public.organizations(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null,
  target_type text,
  target_id   text,
  detail      jsonb not null default '{}'::jsonb,
  ip          inet,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_org_idx on public.audit_log (org_id, created_at desc);

drop trigger if exists touch_attendance_days on public.attendance_days;
create trigger touch_attendance_days before update on public.attendance_days
  for each row execute function app_private.touch_updated_at();

-- Clients never write attendance directly; they call record_punch().
revoke insert, update, delete on public.punch_events    from anon, authenticated;
revoke insert, update, delete on public.attendance_days from anon, authenticated;
revoke all on public.audit_log from anon, authenticated;



-- ############################################################################
-- #  STEP 5 — Row level security, grants, column guard
-- ############################################################################

-- ============================================================================
-- 0005  Row level security
--
-- Helper predicates are SECURITY DEFINER so that reading `profiles` from
-- inside a policy on `profiles` does not recurse.
-- ============================================================================

create or replace function app_private.current_org()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select org_id from public.profiles where id = auth.uid() $$;

create or replace function app_private.current_role()
returns public.user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select role from public.profiles where id = auth.uid() $$;

create or replace function app_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select role in ('owner', 'admin') from public.profiles where id = auth.uid()),
    false)
$$;

create or replace function app_private.is_manager_or_above()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select role in ('owner', 'admin', 'manager') from public.profiles where id = auth.uid()),
    false)
$$;

grant execute on function app_private.current_org, app_private.current_role,
                         app_private.is_admin, app_private.is_manager_or_above
  to authenticated;

-- ---------------------------------------------------------------------------
alter table public.organizations   enable row level security;
alter table public.org_settings    enable row level security;
alter table public.profiles        enable row level security;
alter table public.holidays        enable row level security;
alter table public.leave_records   enable row level security;
alter table public.face_templates  enable row level security;
alter table public.punch_events    enable row level security;
alter table public.attendance_days enable row level security;
alter table public.audit_log       enable row level security;

-- organizations -------------------------------------------------------------
drop policy if exists org_read on public.organizations;
create policy org_read on public.organizations
  for select to authenticated
  using (id = app_private.current_org());

drop policy if exists org_write on public.organizations;
create policy org_write on public.organizations
  for update to authenticated
  using (id = app_private.current_org() and app_private.is_admin())
  with check (id = app_private.current_org());

-- org_settings --------------------------------------------------------------
drop policy if exists settings_read on public.org_settings;
create policy settings_read on public.org_settings
  for select to authenticated
  using (org_id = app_private.current_org());

drop policy if exists settings_write on public.org_settings;
create policy settings_write on public.org_settings
  for update to authenticated
  using (org_id = app_private.current_org() and app_private.is_admin())
  with check (org_id = app_private.current_org());

-- profiles ------------------------------------------------------------------
drop policy if exists profile_read_self on public.profiles;
create policy profile_read_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists profile_read_org on public.profiles;
create policy profile_read_org on public.profiles
  for select to authenticated
  using (org_id = app_private.current_org() and app_private.is_manager_or_above());

drop policy if exists profile_update_self on public.profiles;
create policy profile_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Which COLUMNS a non-admin may change is enforced by the trigger below rather
-- than in this policy.
--
-- The obvious-looking policy — `with check (role = (select role from profiles
-- where id = auth.uid()))` — does not work: the subquery re-reads the same row
-- the statement is updating, so it does not reliably yield the pre-update value,
-- and an employee can promote themselves to owner. A BEFORE UPDATE trigger sees
-- OLD and NEW directly and has no such ambiguity.
create or replace function app_private.guard_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- No JWT means service_role or a direct SQL session: both are already trusted
  -- and are how an operator fixes things, so the guard does not apply.
  if auth.uid() is null then
    return new;
  end if;

  -- Identity and tenancy are never editable through the API, by anyone.
  new.id     := old.id;
  new.org_id := old.org_id;

  if app_private.is_admin() then
    -- An admin may change anyone's role and status except their own. Without
    -- this, the last owner can demote themselves and lock the org out.
    if new.id = auth.uid() then
      new.role   := old.role;
      new.status := old.status;
    end if;
  else
    new.role   := old.role;
    new.status := old.status;
  end if;

  return new;
end;
$$;

drop trigger if exists guard_profiles on public.profiles;
create trigger guard_profiles
  before update on public.profiles
  for each row execute function app_private.guard_profile_columns();

drop policy if exists profile_admin_write on public.profiles;
create policy profile_admin_write on public.profiles
  for update to authenticated
  using (org_id = app_private.current_org() and app_private.is_admin())
  with check (org_id = app_private.current_org());

drop policy if exists profile_admin_insert on public.profiles;
create policy profile_admin_insert on public.profiles
  for insert to authenticated
  with check (org_id = app_private.current_org() and app_private.is_admin());

-- holidays / leave ----------------------------------------------------------
drop policy if exists holidays_read on public.holidays;
create policy holidays_read on public.holidays
  for select to authenticated using (org_id = app_private.current_org());

drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays
  for all to authenticated
  using (org_id = app_private.current_org() and app_private.is_admin())
  with check (org_id = app_private.current_org() and app_private.is_admin());

drop policy if exists leave_read on public.leave_records;
create policy leave_read on public.leave_records
  for select to authenticated
  using (user_id = auth.uid()
         or (org_id = app_private.current_org() and app_private.is_manager_or_above()));

drop policy if exists leave_write on public.leave_records;
create policy leave_write on public.leave_records
  for all to authenticated
  using (org_id = app_private.current_org() and app_private.is_manager_or_above())
  with check (org_id = app_private.current_org() and app_private.is_manager_or_above());

-- face_templates ------------------------------------------------------------
-- No SELECT policy is defined on purpose, and the table grants were revoked in
-- 0003. Reads happen only through SECURITY DEFINER functions. Admins may revoke
-- (soft-delete) a template so an employee can re-enrol.
drop policy if exists templates_admin_revoke on public.face_templates;
create policy templates_admin_revoke on public.face_templates
  for update to authenticated
  using (org_id = app_private.current_org() and app_private.is_admin())
  with check (org_id = app_private.current_org());

drop policy if exists templates_self_delete on public.face_templates;
create policy templates_self_delete on public.face_templates
  for delete to authenticated
  using (user_id = auth.uid()
         or (org_id = app_private.current_org() and app_private.is_admin()));

-- punch_events --------------------------------------------------------------
drop policy if exists punches_read_self on public.punch_events;
create policy punches_read_self on public.punch_events
  for select to authenticated using (user_id = auth.uid());

drop policy if exists punches_read_org on public.punch_events;
create policy punches_read_org on public.punch_events
  for select to authenticated
  using (org_id = app_private.current_org() and app_private.is_manager_or_above());

-- attendance_days -----------------------------------------------------------
drop policy if exists days_read_self on public.attendance_days;
create policy days_read_self on public.attendance_days
  for select to authenticated using (user_id = auth.uid());

drop policy if exists days_read_org on public.attendance_days;
create policy days_read_org on public.attendance_days
  for select to authenticated
  using (org_id = app_private.current_org() and app_private.is_manager_or_above());

-- audit_log -----------------------------------------------------------------
drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log
  for select to authenticated
  using (org_id = app_private.current_org() and app_private.is_admin());

-- ---------------------------------------------------------------------------
-- Explicit privileges
--
-- Supabase grants the API roles broad access to `public` by default. Relying on
-- that makes the schema non-portable and makes it easy to add a table that is
-- accidentally world-readable, so the grants are spelled out here instead.
-- RLS then narrows what these grants expose, row by row.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

grant select, update           on public.organizations   to authenticated;
grant select, update           on public.org_settings    to authenticated;
grant select, insert, update   on public.profiles        to authenticated;
grant select, insert, update, delete on public.holidays      to authenticated;
grant select, insert, update, delete on public.leave_records to authenticated;
grant select                   on public.punch_events    to authenticated;
grant select                   on public.attendance_days to authenticated;
grant select                   on public.audit_log       to authenticated;

-- face_templates gets UPDATE (to set revoked_at) and DELETE, but deliberately
-- no SELECT and no INSERT: reads happen only inside SECURITY DEFINER functions,
-- and rows are created only by enroll_face().
grant update (revoked_at), delete on public.face_templates to authenticated;

-- ---------------------------------------------------------------------------
-- Biometric metadata view
--
-- security_invoker is OFF here on purpose. An invoker view would require the
-- caller to hold SELECT on face_templates — exactly the privilege the design
-- withholds from everyone. So the view runs as its owner and does its own
-- filtering, which it can do precisely because it exposes no vector column.
-- ---------------------------------------------------------------------------
create or replace view public.face_template_meta
with (security_invoker = false) as
  select id, org_id, user_id, quality, model_version, source,
         created_at, created_by, revoked_at
    from public.face_templates t
   where t.org_id = app_private.current_org()
     and (t.user_id = auth.uid() or app_private.is_manager_or_above());

grant select on public.face_template_meta to authenticated;



-- ############################################################################
-- #  STEP 6 — Business logic (record_punch, enroll_face, ...)
-- ############################################################################

-- ============================================================================
-- 0006  Business logic
--
-- Design rule: the browser is treated as a sensor, not as an authority.  It
-- submits an embedding plus its own liveness/quality measurements; every
-- decision about whether that constitutes attendance is made here, inside the
-- database, where the client cannot reach around it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Great-circle distance in metres
-- ---------------------------------------------------------------------------
create or replace function app_private.haversine_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable parallel safe
as $$
  select 6371000 * 2 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2))
    * power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- ---------------------------------------------------------------------------
-- New auth user -> profile.  The first user in a brand-new org becomes owner.
-- ---------------------------------------------------------------------------
create or replace function app_private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org   uuid;
  v_role  public.user_role := 'employee';
  v_count int;
begin
  v_org := nullif(new.raw_user_meta_data ->> 'org_id', '')::uuid;

  -- Fall back to the single existing org (the common single-tenant install).
  if v_org is null then
    select id into v_org from public.organizations order by created_at limit 1;
  end if;

  if v_org is null then
    raise exception 'No organization exists yet. Run the bootstrap seed first.';
  end if;

  select count(*) into v_count from public.profiles where org_id = v_org;
  if v_count = 0 then
    v_role := 'owner';
  end if;

  insert into public.profiles (id, org_id, email, full_name, role)
  values (
    new.id,
    v_org,
    new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)),
    v_role
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app_private.handle_new_user();

-- ---------------------------------------------------------------------------
-- enroll_face
-- ---------------------------------------------------------------------------
create or replace function public.enroll_face(
  p_embedding float8[],
  p_quality   real,
  p_target    uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_caller  uuid := auth.uid();
  v_target  uuid;
  v_org     uuid;
  v_max     int;
  v_live    int;
  v_id      uuid;
begin
  if v_caller is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  v_target := coalesce(p_target, v_caller);

  if v_target <> v_caller and not app_private.is_admin() then
    raise exception 'Only an admin may enrol another employee' using errcode = '42501';
  end if;

  select org_id into v_org from public.profiles where id = v_target;
  if v_org is null then
    raise exception 'Unknown employee' using errcode = 'P0002';
  end if;
  if v_org <> app_private.current_org() then
    raise exception 'Cross-organization enrolment is not permitted' using errcode = '42501';
  end if;

  if array_length(p_embedding, 1) is distinct from 512 then
    raise exception 'Embedding must have exactly 512 dimensions, got %',
      coalesce(array_length(p_embedding, 1), 0) using errcode = '22000';
  end if;

  select max_templates_per_user into v_max from public.org_settings where org_id = v_org;
  select count(*) into v_live
    from public.face_templates
   where user_id = v_target and revoked_at is null;

  if v_live >= coalesce(v_max, 8) then
    raise exception 'Enrolment limit reached (% templates). Revoke one first.', v_max
      using errcode = '23514';
  end if;

  insert into public.face_templates (org_id, user_id, embedding, quality, created_by)
  values (v_org, v_target, p_embedding::extensions.vector(512), greatest(0, least(1, p_quality)), v_caller)
  returning id into v_id;

  insert into public.audit_log (org_id, actor_id, action, target_type, target_id, detail)
  values (v_org, v_caller, 'face.enroll', 'profile', v_target::text,
          jsonb_build_object('template_id', v_id, 'quality', p_quality));

  return jsonb_build_object('template_id', v_id, 'templates', v_live + 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- record_punch  --  the single entry point for marking attendance
-- ---------------------------------------------------------------------------
create or replace function public.record_punch(
  p_embedding      float8[],
  p_liveness       real    default null,
  p_quality        real    default null,
  p_kind           public.punch_kind default null,   -- null = infer
  p_lat            double precision default null,
  p_lng            double precision default null,
  p_accuracy_m     real    default null,
  p_device_hash    text    default null,
  p_photo_path     text    default null,
  p_user_agent     text    default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_prof      public.profiles%rowtype;
  v_cfg       public.org_settings%rowtype;
  v_tz        text;
  v_now       timestamptz := now();
  v_day       date;
  v_sim       real;
  v_tpl       uuid;
  v_dist      double precision;
  v_kind      public.punch_kind;
  v_outcome   public.punch_outcome := 'accepted';
  v_last      timestamptz;
  v_open      boolean;
  v_count     int;
  v_event     uuid;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  select * into v_prof from public.profiles where id = v_user;
  select * into v_cfg  from public.org_settings where org_id = v_prof.org_id;
  select timezone into v_tz from public.organizations where id = v_prof.org_id;

  v_day := (v_now at time zone coalesce(v_tz, 'UTC'))::date;

  if v_prof.status <> 'active' then
    raise exception 'Employee record is %, attendance is disabled', v_prof.status
      using errcode = '42501';
  end if;

  if array_length(p_embedding, 1) is distinct from 512 then
    raise exception 'Embedding must have exactly 512 dimensions' using errcode = '22000';
  end if;

  -- 1. enrolment ------------------------------------------------------------
  select count(*) into v_count
    from public.face_templates
   where user_id = v_user and revoked_at is null;

  if v_count = 0 then
    v_outcome := 'rejected_not_enrolled';
  end if;

  -- 2. capture quality ------------------------------------------------------
  if v_outcome = 'accepted'
     and p_quality is not null
     and p_quality < v_cfg.min_quality_score then
    v_outcome := 'rejected_quality';
  end if;

  -- 3. liveness -------------------------------------------------------------
  if v_outcome = 'accepted' and v_cfg.liveness_mode <> 'off' then
    if p_liveness is null or p_liveness < v_cfg.min_liveness_score then
      v_outcome := 'rejected_liveness';
    end if;
  end if;

  -- 4. geofence -------------------------------------------------------------
  if v_cfg.geofence_enabled and p_lat is not null and p_lng is not null then
    v_dist := app_private.haversine_m(v_cfg.geofence_lat, v_cfg.geofence_lng, p_lat, p_lng);
    if v_outcome = 'accepted' and v_dist > v_cfg.geofence_radius_m then
      v_outcome := 'rejected_geofence';
    end if;
  elsif v_cfg.geofence_enabled then
    if v_outcome = 'accepted' then
      v_outcome := 'rejected_geofence';   -- location required but not supplied
    end if;
  end if;

  -- 5. device binding -------------------------------------------------------
  if v_outcome = 'accepted' and v_cfg.require_device_binding then
    if v_prof.bound_device_hash is null then
      update public.profiles set bound_device_hash = p_device_hash where id = v_user;
    elsif v_prof.bound_device_hash is distinct from p_device_hash then
      v_outcome := 'rejected_duplicate';
    end if;
  end if;

  -- 6. rate limit -----------------------------------------------------------
  select max(occurred_at) into v_last
    from public.punch_events
   where user_id = v_user and outcome = 'accepted';

  if v_outcome = 'accepted' and v_last is not null
     and v_now - v_last < make_interval(secs => v_cfg.min_punch_gap_seconds) then
    v_outcome := 'rejected_duplicate';
  end if;

  -- 7. the actual face match ------------------------------------------------
  -- Runs even for some rejections so the audit trail shows whether the face
  -- was right but the context was wrong (e.g. correct person, wrong location).
  if v_count > 0 then
    select t.id, (1 - (t.embedding <=> p_embedding::extensions.vector(512)))::real
      into v_tpl, v_sim
      from public.face_templates t
     where t.user_id = v_user and t.revoked_at is null
     order by t.embedding <=> p_embedding::extensions.vector(512)
     limit 1;

    if v_outcome = 'accepted' and coalesce(v_sim, 0) < v_cfg.match_threshold then
      v_outcome := 'rejected_no_match';
    end if;
  end if;

  -- 8. in or out? -----------------------------------------------------------
  select (first_in is not null and last_out is null) into v_open
    from public.attendance_days
   where user_id = v_user and local_day = v_day;

  -- The CASE arms need explicit casts: bare string literals are `unknown`, and
  -- COALESCE refuses to match `unknown` against the punch_kind enum.
  v_kind := coalesce(
    p_kind,
    case when coalesce(v_open, false)
         then 'check_out'::public.punch_kind
         else 'check_in'::public.punch_kind
    end);

  insert into public.punch_events (
    org_id, user_id, kind, outcome, occurred_at, local_day,
    similarity, liveness_score, quality_score, matched_template,
    lat, lng, accuracy_m, distance_m, device_hash, user_agent, photo_path
  ) values (
    v_prof.org_id, v_user, v_kind, v_outcome, v_now, v_day,
    v_sim, p_liveness, p_quality, v_tpl,
    p_lat, p_lng, p_accuracy_m, v_dist, p_device_hash, left(coalesce(p_user_agent, ''), 400), p_photo_path
  ) returning id into v_event;

  if v_outcome = 'accepted' then
    perform app_private.recompute_day(v_user, v_day);
  end if;

  return jsonb_build_object(
    'ok',          v_outcome = 'accepted',
    'outcome',     v_outcome,
    'kind',        v_kind,
    'event_id',    v_event,
    'similarity',  round(coalesce(v_sim, 0)::numeric, 4),
    'threshold',   v_cfg.match_threshold,
    'distance_m',  case when v_dist is null then null else round(v_dist::numeric, 1) end,
    'local_day',   v_day,
    'occurred_at', v_now
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- recompute_day  --  derive the daily roll-up from accepted punches
-- ---------------------------------------------------------------------------
create or replace function app_private.recompute_day(p_user uuid, p_day date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org      uuid;
  v_cfg      public.org_settings%rowtype;
  v_tz       text;
  v_first    timestamptz;
  v_last     timestamptz;
  v_n        int;
  v_minutes  int := 0;
  v_status   public.day_status;
  v_start    timestamptz;
  v_manual   boolean;
  v_on_leave boolean;
  v_holiday  boolean;
  v_dow      int;
begin
  select org_id into v_org from public.profiles where id = p_user;
  select * into v_cfg from public.org_settings where org_id = v_org;
  select timezone into v_tz from public.organizations where id = v_org;
  v_tz := coalesce(v_tz, 'UTC');

  select manually_edited into v_manual
    from public.attendance_days where user_id = p_user and local_day = p_day;
  if coalesce(v_manual, false) then
    return;   -- never stomp on a human correction
  end if;

  -- Filtered by kind, not a plain min/max: taking max(occurred_at) over every
  -- punch would set last_out from the check-in itself, making a day look closed
  -- the moment it opened — and the next punch would then be read as another
  -- check-in rather than the check-out it is.
  select min(occurred_at) filter (where kind = 'check_in'),
         max(occurred_at) filter (where kind = 'check_out'),
         count(*)
    into v_first, v_last, v_n
    from public.punch_events
   where user_id = p_user and local_day = p_day and outcome = 'accepted';

  -- Sum in/out pairs rather than first-to-last, so lunch breaks are excluded.
  select coalesce(sum(extract(epoch from (out_at - in_at)) / 60), 0)::int
    into v_minutes
    from (
      select occurred_at as in_at,
             lead(occurred_at) over (order by occurred_at) as out_at,
             kind,
             lead(kind) over (order by occurred_at) as next_kind
        from public.punch_events
       where user_id = p_user and local_day = p_day and outcome = 'accepted'
    ) s
   where s.kind = 'check_in' and s.next_kind = 'check_out' and s.out_at is not null;

  v_dow := extract(isodow from p_day)::int;

  select exists (select 1 from public.holidays where org_id = v_org and day = p_day)
    into v_holiday;

  select exists (
    select 1 from public.leave_records
     where user_id = p_user and p_day between start_day and end_day
  ) into v_on_leave;

  if v_n = 0 then
    v_status := case
      when v_holiday                             then 'holiday'
      when v_on_leave                            then 'on_leave'
      when not (v_dow = any (v_cfg.workdays))    then 'weekend'
      else 'absent'
    end;
  else
    v_start := (p_day + v_cfg.workday_start) at time zone v_tz;
    v_status := case
      when v_minutes >= v_cfg.full_day_min_minutes
           and v_first <= v_start + make_interval(mins => v_cfg.late_grace_minutes) then 'present'
      when v_minutes <= v_cfg.half_day_max_minutes then 'half_day'
      when v_first > v_start + make_interval(mins => v_cfg.late_grace_minutes) then 'late'
      else 'present'
    end;
  end if;

  insert into public.attendance_days (
    org_id, user_id, local_day, first_in, last_out, worked_minutes, status, punches
  ) values (v_org, p_user, p_day, v_first, v_last, v_minutes, v_status, v_n)
  on conflict (user_id, local_day) do update
    set first_in       = excluded.first_in,
        last_out       = excluded.last_out,
        worked_minutes = excluded.worked_minutes,
        status         = excluded.status,
        punches        = excluded.punches,
        updated_at     = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- identify_face  --  1:N lookup, for an optional shared kiosk. Admin only.
-- ---------------------------------------------------------------------------
create or replace function public.identify_face(p_embedding float8[])
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_org uuid := app_private.current_org();
  v_rec record;
begin
  if not app_private.is_admin() then
    raise exception 'Identification requires an admin session' using errcode = '42501';
  end if;
  if array_length(p_embedding, 1) is distinct from 512 then
    raise exception 'Embedding must have exactly 512 dimensions' using errcode = '22000';
  end if;

  select p.id, p.full_name, p.employee_code,
         (1 - (t.embedding <=> p_embedding::extensions.vector(512)))::real as sim
    into v_rec
    from public.face_templates t
    join public.profiles p on p.id = t.user_id
   where t.org_id = v_org and t.revoked_at is null and p.status = 'active'
   order by t.embedding <=> p_embedding::extensions.vector(512)
   limit 1;

  if v_rec is null then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true, 'user_id', v_rec.id, 'full_name', v_rec.full_name,
    'employee_code', v_rec.employee_code, 'similarity', round(v_rec.sim::numeric, 4)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_correct_day  --  manual override with a mandatory reason
-- ---------------------------------------------------------------------------
create or replace function public.admin_correct_day(
  p_user uuid, p_day date, p_status public.day_status,
  p_worked_minutes int, p_reason text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_org uuid := app_private.current_org();
begin
  if not app_private.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required for a manual correction' using errcode = '22000';
  end if;
  if not exists (select 1 from public.profiles where id = p_user and org_id = v_org) then
    raise exception 'Employee is not in your organization' using errcode = '42501';
  end if;

  insert into public.attendance_days (
    org_id, user_id, local_day, status, worked_minutes,
    manually_edited, edited_by, edit_reason
  ) values (v_org, p_user, p_day, p_status, greatest(0, p_worked_minutes), true, auth.uid(), p_reason)
  on conflict (user_id, local_day) do update
    set status = excluded.status, worked_minutes = excluded.worked_minutes,
        manually_edited = true, edited_by = auth.uid(),
        edit_reason = excluded.edit_reason, updated_at = now();

  insert into public.audit_log (org_id, actor_id, action, target_type, target_id, detail)
  values (v_org, auth.uid(), 'attendance.correct', 'attendance_day', p_user || ':' || p_day,
          jsonb_build_object('status', p_status, 'minutes', p_worked_minutes, 'reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- revoke_face_templates  --  clears enrolment so the employee can redo it
-- ---------------------------------------------------------------------------
create or replace function public.revoke_face_templates(p_user uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_org uuid := app_private.current_org(); v_n int;
begin
  if p_user <> auth.uid() and not app_private.is_admin() then
    raise exception 'Admin only' using errcode = '42501';
  end if;

  update public.face_templates
     set revoked_at = now()
   where user_id = p_user and org_id = v_org and revoked_at is null;
  get diagnostics v_n = row_count;

  insert into public.audit_log (org_id, actor_id, action, target_type, target_id, detail)
  values (v_org, auth.uid(), 'face.revoke', 'profile', p_user::text,
          jsonb_build_object('revoked', v_n));
  return v_n;
end;
$$;

-- Only these are callable from a browser session.
revoke all on function public.enroll_face            from public, anon;
revoke all on function public.record_punch           from public, anon;
revoke all on function public.identify_face          from public, anon;
revoke all on function public.admin_correct_day      from public, anon;
revoke all on function public.revoke_face_templates  from public, anon;

grant execute on function public.enroll_face(float8[], real, uuid)                  to authenticated;
grant execute on function public.record_punch(float8[], real, real, public.punch_kind,
       double precision, double precision, real, text, text, text)                  to authenticated;
grant execute on function public.identify_face(float8[])                            to authenticated;
grant execute on function public.admin_correct_day(uuid, date, public.day_status, int, text) to authenticated;
grant execute on function public.revoke_face_templates(uuid)                        to authenticated;



-- ############################################################################
-- #  STEP 7 — Storage buckets and their policies
-- ############################################################################

-- ============================================================================
-- 0007  Storage buckets
--
-- Punch photos are the practical deterrent against a colleague check-in: the
-- match itself happens on an embedding the client computed, so the photo is
-- what lets a human verify an anomaly after the fact.
-- Object key layout:  {org_id}/{user_id}/{yyyy-mm-dd}/{uuid}.jpg
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('punch-photos', 'punch-photos', false, 400000,  array['image/jpeg', 'image/webp']),
  ('avatars',      'avatars',      false, 1000000, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update
  set file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- punch-photos --------------------------------------------------------------
drop policy if exists punch_photo_insert on storage.objects;
create policy punch_photo_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'punch-photos'
    and (storage.foldername(name))[1] = app_private.current_org()::text
    and (storage.foldername(name))[2] = auth.uid()::text
  );

drop policy if exists punch_photo_read on storage.objects;
create policy punch_photo_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'punch-photos'
    and (storage.foldername(name))[1] = app_private.current_org()::text
    and (
      (storage.foldername(name))[2] = auth.uid()::text
      or app_private.is_manager_or_above()
    )
  );

drop policy if exists punch_photo_delete on storage.objects;
create policy punch_photo_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'punch-photos'
    and (storage.foldername(name))[1] = app_private.current_org()::text
    and app_private.is_admin()
  );

-- avatars -------------------------------------------------------------------
drop policy if exists avatar_write on storage.objects;
create policy avatar_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = app_private.current_org()::text
    and ((storage.foldername(name))[2] = auth.uid()::text or app_private.is_admin())
  );

drop policy if exists avatar_read on storage.objects;
create policy avatar_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = app_private.current_org()::text
  );

-- ---------------------------------------------------------------------------
-- Retention: called nightly by /api/cron/close-open-sessions
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired_photos()
returns int
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare v_n int := 0; v_row record;
begin
  for v_row in
    select e.id, e.photo_path
      from public.punch_events e
      join public.org_settings s on s.org_id = e.org_id
     where e.photo_path is not null
       and e.occurred_at < now() - make_interval(days => s.photo_retention_days)
     limit 500
  loop
    delete from storage.objects where bucket_id = 'punch-photos' and name = v_row.photo_path;
    update public.punch_events set photo_path = null where id = v_row.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.purge_expired_photos from public, anon, authenticated;



-- ############################################################################
-- #  STEP 8 — Read models for the dashboard
-- ############################################################################

-- ============================================================================
-- 0008  Read models for the dashboard and reports
-- security_invoker = true keeps each caller's RLS in force through the view.
-- ============================================================================

create or replace view public.v_today_board
with (security_invoker = true) as
select
  p.id              as user_id,
  p.org_id,
  p.full_name,
  p.employee_code,
  p.department,
  p.avatar_path,
  d.local_day,
  d.first_in,
  d.last_out,
  d.worked_minutes,
  coalesce(d.status, 'absent'::public.day_status) as status,
  d.punches,
  (d.first_in is not null and d.last_out is null)  as currently_in,
  -- Via the metadata view rather than face_templates directly: this view is
  -- security_invoker, and no caller holds SELECT on the raw biometric table.
  exists (select 1 from public.face_template_meta m
           where m.user_id = p.id and m.revoked_at is null) as enrolled
from public.profiles p
left join public.attendance_days d
       on d.user_id = p.id
      and d.local_day = (now() at time zone
            (select timezone from public.organizations o where o.id = p.org_id))::date
where p.status = 'active';

create or replace view public.v_monthly_summary
with (security_invoker = true) as
select
  d.org_id,
  d.user_id,
  p.full_name,
  p.employee_code,
  p.department,
  date_trunc('month', d.local_day)::date              as month,
  count(*) filter (where d.status in ('present', 'late', 'half_day')) as days_worked,
  count(*) filter (where d.status = 'present')        as days_present,
  count(*) filter (where d.status = 'late')           as days_late,
  count(*) filter (where d.status = 'half_day')       as days_half,
  count(*) filter (where d.status = 'absent')         as days_absent,
  count(*) filter (where d.status = 'on_leave')       as days_leave,
  sum(d.worked_minutes)                               as total_minutes,
  round(avg(nullif(d.worked_minutes, 0))::numeric, 1) as avg_minutes
from public.attendance_days d
join public.profiles p on p.id = d.user_id
group by d.org_id, d.user_id, p.full_name, p.employee_code, p.department,
         date_trunc('month', d.local_day);

-- Rejected punches worth a human look: right person, wrong context, or a face
-- that did not match while the person was signed in as themselves.
create or replace view public.v_anomalies
with (security_invoker = true) as
select
  e.id, e.org_id, e.user_id, p.full_name, e.occurred_at, e.local_day,
  e.outcome, e.similarity, e.liveness_score, e.quality_score,
  e.distance_m, e.photo_path, e.device_hash
from public.punch_events e
join public.profiles p on p.id = e.user_id
where e.outcome <> 'accepted'
order by e.occurred_at desc;

grant select on public.v_today_board, public.v_monthly_summary, public.v_anomalies
  to authenticated;



-- ############################################################################
-- #  STEP 9 — Bootstrap your organization  <-- EDIT THIS BLOCK
-- ############################################################################

-- ============================================================================
-- 0009  Bootstrap a single organization.
-- Edit the name/slug/timezone below before the first `supabase db push`, or
-- change them later in Admin -> Settings.
-- ============================================================================

do $$
declare v_org uuid;
begin
  if exists (select 1 from public.organizations) then
    return;
  end if;

  insert into public.organizations (name, slug, timezone)
  values ('My Organization', 'my-org', 'Asia/Kolkata')
  returning id into v_org;

  insert into public.org_settings (org_id) values (v_org);

  raise notice 'Bootstrapped organization %', v_org;
end $$;

