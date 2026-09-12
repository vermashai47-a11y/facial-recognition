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
