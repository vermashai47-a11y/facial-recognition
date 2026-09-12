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
