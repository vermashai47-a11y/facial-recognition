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
