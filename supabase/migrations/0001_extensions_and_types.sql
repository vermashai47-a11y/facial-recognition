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
