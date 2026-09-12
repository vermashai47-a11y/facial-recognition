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
