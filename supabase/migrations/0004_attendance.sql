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
