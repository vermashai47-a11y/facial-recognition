-- ============================================================================
-- Minimal stand-in for the parts of a Supabase project the migrations depend on.
-- Loaded only by `npm run db:verify` against a throwaway local Postgres; a real
-- Supabase project already provides all of this.
-- ============================================================================

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;

-- The migrations create their own extensions into `extensions`, exactly as they
-- do on Supabase; the shim only has to make that schema exist first.

do $$ begin create role anon          nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role  nologin bypassrls; exception when duplicate_object then null; end $$;

create table if not exists auth.users (
  id                    uuid primary key default gen_random_uuid(),
  email                 text unique not null,
  raw_user_meta_data    jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now()
);

-- Test harness: set `request.jwt.claim.sub` to impersonate a signed-in user.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table if not exists storage.buckets (
  id                  text primary key,
  name                text not null,
  public              boolean not null default false,
  file_size_limit     bigint,
  allowed_mime_types  text[]
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text not null,
  owner      uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

grant usage on schema auth, storage, extensions, public to anon, authenticated, service_role;
grant select on auth.users to authenticated;
