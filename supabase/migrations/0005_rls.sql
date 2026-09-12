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
