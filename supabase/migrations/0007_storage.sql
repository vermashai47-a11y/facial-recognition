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
