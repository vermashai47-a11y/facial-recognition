-- ============================================================================
--  FACE ATTENDANCE — POST-SETUP VERIFICATION
--
--  Paste into the Supabase SQL Editor and Run, after setup.sql.
--  Every row should read PASS. Anything else tells you what is missing.
-- ============================================================================

with checks as (

  select 1 as ord, 'pgvector extension' as check_name,
         case when exists (select 1 from pg_extension where extname = 'vector')
              then 'PASS' else 'FAIL' end as status,
         coalesce((select 'v' || extversion from pg_extension where extname = 'vector'),
                  'not installed') as detail

  union all
  select 2, 'core tables',
         case when count(*) = 9 then 'PASS' else 'FAIL' end,
         count(*) || ' of 9 present'
    from pg_tables
   where schemaname = 'public'
     and tablename in ('organizations','org_settings','profiles','face_templates',
                       'punch_events','attendance_days','holidays','leave_records','audit_log')

  union all
  select 3, 'row level security enabled',
         case when count(*) = 0 then 'PASS' else 'FAIL' end,
         case when count(*) = 0 then 'on for every table'
              else 'MISSING on: ' || string_agg(c.relname, ', ') end
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
     and c.relname in ('organizations','org_settings','profiles','face_templates',
                       'punch_events','attendance_days','holidays','leave_records','audit_log')

  union all
  select 4, 'RLS policies installed',
         case when count(*) >= 18 then 'PASS' else 'FAIL' end,
         count(*) || ' policies on public tables'
    from pg_policies where schemaname = 'public'

  union all
  -- The single most important one: no API role may read raw biometric vectors.
  select 5, 'embeddings unreadable by API roles',
         case when has_table_privilege('authenticated', 'public.face_templates', 'SELECT')
               or has_table_privilege('anon', 'public.face_templates', 'SELECT')
              then 'FAIL' else 'PASS' end,
         'authenticated + anon have no SELECT on face_templates'

  union all
  select 6, 'attendance is write-protected',
         case when has_table_privilege('authenticated', 'public.punch_events', 'INSERT')
               or has_table_privilege('authenticated', 'public.attendance_days', 'INSERT')
              then 'FAIL' else 'PASS' end,
         'rows can only be created through record_punch()'

  union all
  select 7, 'business logic functions',
         case when count(*) = 5 then 'PASS' else 'FAIL' end,
         count(*) || ' of 5: ' || coalesce(string_agg(proname, ', ' order by proname), 'none')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and proname in ('record_punch','enroll_face','identify_face',
                     'revoke_face_templates','admin_correct_day')

  union all
  select 8, 'profile column guard',
         case when exists (select 1 from pg_trigger
                            where tgname = 'guard_profiles' and not tgisinternal)
              then 'PASS' else 'FAIL' end,
         'stops an employee promoting themselves'

  union all
  select 9, 'new-user trigger on auth.users',
         case when exists (select 1 from pg_trigger
                            where tgname = 'on_auth_user_created' and not tgisinternal)
              then 'PASS' else 'FAIL' end,
         'creates a profile when someone signs up'

  union all
  select 10, 'dashboard views',
         case when count(*) = 4 then 'PASS' else 'FAIL' end,
         count(*) || ' of 4 present'
    from pg_views
   where schemaname = 'public'
     and viewname in ('v_today_board','v_monthly_summary','v_anomalies','face_template_meta')

  union all
  select 11, 'storage buckets',
         case when count(*) = 2 then 'PASS' else 'FAIL' end,
         case when count(*) = 2 then 'punch-photos + avatars'
              else count(*) || ' of 2 — create the missing one under Storage' end
    from storage.buckets where id in ('punch-photos','avatars')

  union all
  select 12, 'storage policies',
         case when count(*) >= 5 then 'PASS' else 'WARN' end,
         count(*) || ' policies on storage.objects'
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('punch_photo_insert','punch_photo_read','punch_photo_delete',
                        'avatar_write','avatar_read')

  union all
  select 13, 'organization bootstrapped',
         case when exists (select 1 from public.organizations) then 'PASS' else 'FAIL' end,
         coalesce((select name || '  ·  ' || timezone from public.organizations
                    order by created_at limit 1), 'no organization row')

  union all
  select 14, 'settings row',
         case when exists (select 1 from public.org_settings) then 'PASS' else 'FAIL' end,
         coalesce((select 'match threshold ' || match_threshold
                        || ', liveness ' || liveness_mode
                     from public.org_settings limit 1), 'missing')

  union all
  select 15, 'accounts so far',
         'INFO',
         (select count(*)::text from public.profiles) || ' profile(s) — the first signup becomes owner'
)

select
  case when status = 'PASS' then '✅' when status = 'INFO' then 'ℹ️' else '❌' end as " ",
  check_name  as "Check",
  status      as "Status",
  detail      as "Detail"
from checks
order by ord;
