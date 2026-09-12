-- ============================================================================
-- 0003  Biometric templates
--
-- A "template" is a 512-float ArcFace embedding, L2-normalised client-side.
-- It is a one-way projection: you cannot reconstruct a recognisable face from
-- it, but it is still biometric personal data under GDPR Art. 9 and India's
-- DPDP Act, so it is treated as the most sensitive table in the schema:
--
--   * No role has a direct SELECT grant on the embedding column.
--   * All reads happen inside SECURITY DEFINER functions that return a score,
--     never a vector.
--   * A non-sensitive metadata view is exposed for the UI.
-- ============================================================================

create table if not exists public.face_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  embedding     extensions.vector(512) not null,
  quality       real not null default 0 check (quality between 0 and 1),
  model_version text not null default 'w600k_mbf@1',
  source        text not null default 'enrollment' check (source in ('enrollment', 'adaptive')),
  created_at    timestamptz not null default now(),
  created_by    uuid references public.profiles(id) on delete set null,
  revoked_at    timestamptz
);

create index if not exists face_templates_user_idx
  on public.face_templates (user_id) where revoked_at is null;

create index if not exists face_templates_org_idx
  on public.face_templates (org_id) where revoked_at is null;

-- HNSW over cosine distance.  For an org of a few hundred people a sequential
-- scan is already sub-millisecond, but the index keeps 1:N kiosk identification
-- flat as the org grows, and costs almost nothing at this size.
create index if not exists face_templates_hnsw
  on public.face_templates
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Hard guarantee: even a mistaken RLS policy cannot leak vectors, because the
-- client roles have no column privileges on the table at all.
revoke all on public.face_templates from anon, authenticated;

-- The non-sensitive metadata view is defined in 0005, once the role helpers it
-- filters on exist.
