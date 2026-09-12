-- ============================================================================
-- Behavioural assertions.
--
-- These are the claims the README makes about the security model, expressed as
-- something a machine can check. Each block raises an exception on failure, so
-- `psql -v ON_ERROR_STOP=1` turns any regression into a non-zero exit.
-- ============================================================================

\set ON_ERROR_STOP on
\timing off

-- pgvector lives in `extensions` (as it does on Supabase), so the `<=>` operator
-- needs that schema on the path for the assertions that compare vectors directly.
set search_path = public, extensions;

-- A deterministic unit vector standing in for a face embedding.
--
-- Drawn from a seeded PRNG rather than a trig function: phase-shifted sine
-- vectors share every frequency component and so stay ~0.8 correlated, which
-- would make "a different person" indistinguishable from "the same person".
-- Independent draws in 512 dimensions land near-orthogonal, like real ArcFace
-- embeddings of different people.
--
-- `noise` mixes in a second independent draw, modelling a second capture of the
-- SAME person: similarity works out to about 1/sqrt(1 + noise^2).
create or replace function public.tvec(seed int, noise float8 default 0)
returns float8[]
language plpgsql
as $$
declare
  base  float8[];
  jitter float8[];
  out_v float8[];
  nrm   float8 := 0;
begin
  perform setseed(((seed % 9973)::float8) / 9973.0);
  select array_agg(random() * 2 - 1) into base from generate_series(1, 512);

  perform setseed((((seed + 4441) % 9973)::float8) / 9973.0);
  select array_agg(random() * 2 - 1) into jitter from generate_series(1, 512);

  out_v := array(select base[i] + noise * jitter[i] from generate_series(1, 512) i);
  select sqrt(sum(x * x)) into nrm from unnest(out_v) x;
  return array(select x / nrm from unnest(out_v) x);
end $$;

create or replace function public.assert(cond boolean, msg text)
returns void language plpgsql as $$
begin
  if cond is not true then
    raise exception 'ASSERTION FAILED: %', msg;
  end if;
  raise notice '  ok  %', msg;
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures: one org, an owner and two employees.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'asha@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'bo@example.com');

select public.assert(
  (select count(*) from public.profiles) = 3,
  'auth.users insert creates a profile for each user'
);

select public.assert(
  (select role from public.profiles where email = 'owner@example.com') = 'owner',
  'the first account in an org becomes owner, later ones do not'
);

select public.assert(
  (select role from public.profiles where email = 'asha@example.com') = 'employee',
  'the second account defaults to employee'
);

-- ---------------------------------------------------------------------------
-- Enrolment
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  select public.enroll_face(public.tvec(1), 0.9::real, null);
  select public.enroll_face(public.tvec(1, 0.10), 0.85::real, null);
commit;

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
  select public.enroll_face(public.tvec(42), 0.9::real, null);
commit;

select public.assert(
  (select count(*) from public.face_templates) = 3,
  'enroll_face stores templates for each employee'
);

-- An employee must not be able to enrol a face on someone else's account.
do $$
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  perform public.enroll_face(public.tvec(99), 0.9::real,
                             '33333333-3333-3333-3333-333333333333');
  reset role;
  raise exception 'ASSERTION FAILED: an employee enrolled a face onto another account';
exception
  when insufficient_privilege then
    reset role;
    raise notice '  ok  an employee cannot enrol a face onto another account';
end $$;

-- ---------------------------------------------------------------------------
-- The biometric table is unreadable, by anyone, through the API roles
-- ---------------------------------------------------------------------------
do $$
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';  -- the owner
  perform 1 from public.face_templates limit 1;
  reset role;
  raise exception 'ASSERTION FAILED: face_templates was readable by an admin session';
exception
  when insufficient_privilege then
    reset role;
    raise notice '  ok  not even an owner can SELECT raw embeddings';
end $$;

select public.assert(
  has_table_privilege('authenticated', 'public.face_template_meta', 'SELECT'),
  'the metadata view (no vector column) is readable'
);

-- ---------------------------------------------------------------------------
-- record_punch: the happy path
-- ---------------------------------------------------------------------------
\set QUIET on
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  create temp table r1 as select public.record_punch(public.tvec(1, 0.05), 0.9, 0.9) as j;
commit;

select public.assert((select (j->>'ok')::boolean from r1), 'a matching live face is accepted');
select public.assert((select j->>'kind' from r1) = 'check_in', 'the first punch of the day is a check-in');
select public.assert((select (j->>'similarity')::real from r1) > 0.9,
                     'a second capture of the same face scores above 0.9 similarity');
select public.assert(
  (1 - (public.tvec(1)::extensions.vector(512) <=> public.tvec(42)::extensions.vector(512))) < 0.2,
  'two different faces are near-orthogonal, well under the 0.42 threshold'
);

select public.assert(
  (select count(*) from public.attendance_days
    where user_id = '22222222-2222-2222-2222-222222222222') = 1,
  'an accepted punch rolls up into attendance_days'
);

-- ---------------------------------------------------------------------------
-- record_punch: every rejection path
--
-- The happy path above left an accepted punch on record, and the rate limit is
-- evaluated before the face comparison — so it has to come off for the checks
-- that are about the face itself, then back on for its own test.
-- ---------------------------------------------------------------------------
update public.org_settings set min_punch_gap_seconds = 0;

-- Someone else's face, submitted from Asha's session.
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  create temp table r2 as select public.record_punch(public.tvec(42), 0.9, 0.9) as j;
commit;

select public.assert((select j->>'outcome' from r2) = 'rejected_no_match',
                     'a different face is rejected even with a valid session');

-- Liveness below the configured floor.
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
  create temp table r3 as select public.record_punch(public.tvec(42, 0.05), 0.1, 0.9) as j;
commit;

select public.assert((select j->>'outcome' from r3) = 'rejected_liveness',
                     'a low liveness score is rejected before the face is trusted');

-- Blurry capture.
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
  create temp table r4 as select public.record_punch(public.tvec(42, 0.05), 0.9, 0.05) as j;
commit;

select public.assert((select j->>'outcome' from r4) = 'rejected_quality',
                     'a capture below the quality floor is rejected');

-- Rate limit: a second accepted punch inside min_punch_gap_seconds.
update public.org_settings set min_punch_gap_seconds = 60;
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  create temp table r5 as select public.record_punch(public.tvec(1, 0.05), 0.9, 0.9) as j;
commit;

select public.assert((select j->>'outcome' from r5) = 'rejected_duplicate',
                     'punches inside the minimum gap are rejected');

-- Geofence.
update public.org_settings
   set geofence_enabled = true, geofence_lat = 19.0760, geofence_lng = 72.8777,
       geofence_radius_m = 200, min_punch_gap_seconds = 0;

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  -- Pune, ~120 km from the configured Mumbai office.
  create temp table r6 as
    select public.record_punch(public.tvec(1, 0.05), 0.9, 0.9, null, 18.5204, 73.8567) as j;
commit;

select public.assert((select j->>'outcome' from r6) = 'rejected_geofence',
                     'a punch from outside the radius is rejected');
select public.assert((select (j->>'distance_m')::float8 from r6) > 100000,
                     'the recorded distance matches the real separation');

-- Inside the radius, the same punch succeeds and is inferred as a check-out.
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  create temp table r7 as
    select public.record_punch(public.tvec(1, 0.05), 0.9, 0.9, null, 19.0761, 72.8778) as j;
commit;

select public.assert((select (j->>'ok')::boolean from r7), 'a punch inside the radius is accepted');
select public.assert((select j->>'kind' from r7) = 'check_out',
                     'with an open check-in, the next punch is inferred as a check-out');

select public.assert(
  (select last_out is not null from public.attendance_days
    where user_id = '22222222-2222-2222-2222-222222222222') ,
  'the check-out lands on the daily roll-up'
);

-- Every attempt, accepted or not, is retained for audit.
select public.assert(
  (select count(*) from public.punch_events where outcome <> 'accepted') = 5,
  'rejected attempts are recorded rather than discarded'
);

-- ---------------------------------------------------------------------------
-- RLS: cross-employee isolation
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';  -- Bo
  create temp table vis as
    select (select count(*) from public.attendance_days) as days,
           (select count(*) from public.punch_events)    as punches,
           (select count(*) from public.profiles)        as profiles;
commit;

select public.assert((select days = 0 from vis),
                     'an employee cannot see a colleague''s attendance days');
select public.assert((select punches = 2 from vis),
                     'an employee sees only their own punch events');
select public.assert((select profiles = 1 from vis),
                     'an employee sees only their own profile row');

-- A manager sees the whole organization.
update public.profiles set role = 'manager'
 where id = '33333333-3333-3333-3333-333333333333';

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
  create temp table vis2 as select (select count(*) from public.profiles) as profiles;
commit;

select public.assert((select profiles = 3 from vis2), 'a manager sees every profile in the org');

-- ---------------------------------------------------------------------------
-- Privilege escalation
-- ---------------------------------------------------------------------------
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  update public.profiles set role = 'owner' where id = auth.uid();
commit;

select public.assert(
  (select role from public.profiles where id = '22222222-2222-2222-2222-222222222222') = 'employee',
  'an employee cannot promote themselves'
);

-- An admin may change someone else's role...
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
  update public.profiles set role = 'manager', status = 'suspended'
   where id = '22222222-2222-2222-2222-222222222222';
commit;

select public.assert(
  (select role = 'manager' and status = 'suspended' from public.profiles
    where id = '22222222-2222-2222-2222-222222222222'),
  'an admin can change another employee''s role and status'
);

-- ...but not their own, or the last owner could lock the organization out.
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
  update public.profiles set role = 'employee' where id = auth.uid();
commit;

select public.assert(
  (select role from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'owner',
  'an admin cannot demote themselves'
);

-- A suspended employee cannot punch at all.
do $$
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  perform public.record_punch(public.tvec(1, 0.05), 0.9, 0.9);
  reset role;
  raise exception 'ASSERTION FAILED: a suspended employee recorded attendance';
exception
  when insufficient_privilege then
    reset role;
    raise notice '  ok  a suspended employee cannot record attendance';
end $$;

-- Put them back for the remaining assertions.
update public.profiles set role = 'employee', status = 'active'
 where id = '22222222-2222-2222-2222-222222222222';

-- identify_face (1:N) is admin-only: an oracle in an employee's hands would let
-- them probe whether an arbitrary face belongs to a colleague.
do $$
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  perform public.identify_face(public.tvec(1));
  reset role;
  raise exception 'ASSERTION FAILED: identify_face was callable by an employee';
exception
  when insufficient_privilege then
    reset role;
    raise notice '  ok  identify_face refuses a non-admin session';
end $$;

-- ---------------------------------------------------------------------------
-- Manual correction requires a reason and survives recomputation
-- ---------------------------------------------------------------------------
do $$
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
  perform public.admin_correct_day('22222222-2222-2222-2222-222222222222',
                                   current_date, 'present', 480, '');
  reset role;
  raise exception 'ASSERTION FAILED: a correction was accepted without a reason';
exception
  when data_exception then
    reset role;
    raise notice '  ok  a manual correction without a reason is refused';
end $$;

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
  select public.admin_correct_day('22222222-2222-2222-2222-222222222222',
                                   current_date, 'present', 480, 'Forgot to check out');
commit;

select public.assert(
  (select manually_edited and worked_minutes = 480 from public.attendance_days
    where user_id = '22222222-2222-2222-2222-222222222222'),
  'an admin correction is applied and flagged as manual'
);

-- A later punch must not silently overwrite the human decision.
update public.org_settings set geofence_enabled = false;
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  select public.record_punch(public.tvec(1, 0.05), 0.9, 0.9);
commit;

select public.assert(
  (select worked_minutes = 480 from public.attendance_days
    where user_id = '22222222-2222-2222-2222-222222222222'),
  'recomputation leaves a manually corrected day alone'
);

-- ---------------------------------------------------------------------------
-- Dimension guard
-- ---------------------------------------------------------------------------
do $$
begin
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  perform public.record_punch(array[0.1, 0.2, 0.3]::float8[], 0.9, 0.9);
  reset role;
  raise exception 'ASSERTION FAILED: a 3-dimensional embedding was accepted';
exception
  when data_exception then
    reset role;
    raise notice '  ok  a wrong-sized embedding is refused';
end $$;

\echo ''
\echo '  All policy assertions passed.'
