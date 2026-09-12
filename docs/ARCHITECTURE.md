# Architecture

## The governing idea

**The browser is a sensor, not an authority.**

The phone is the only thing with a camera, so it has to do the perception: find
the face, check it is alive, turn it into a vector. But perception is all it
does. It reports measurements — an embedding, a liveness score, a quality score,
a location — and has no say in whether any of that constitutes attendance.

Every decision lives in one Postgres function, `record_punch()`. That function
is `SECURITY DEFINER`, the client roles have no write privileges on the
attendance tables at all, and the only way to create a row is to go through it.
A tampered client can lie about its inputs; it cannot skip the judge.

This shapes everything else. Thresholds live in `org_settings`, not in
TypeScript constants. Rejections are rows, not exceptions. The client's own
opinion about whether a capture passed is never consulted.

## Data model

```
organizations ─┬─ org_settings        one row, all policy knobs
               ├─ profiles            one per auth.users row, carries role
               ├─ holidays
               └─ leave_records

profiles ──────┬─ face_templates      vector(512), no SELECT grant to anyone
               ├─ punch_events        every attempt, accepted or rejected
               └─ attendance_days     derived daily roll-up, one row per person per day

audit_log                             admin actions, append-only
```

### `face_templates` — the sensitive one

A template is a 512-float ArcFace embedding, L2-normalised in the browser before
it is sent. It is a one-way projection: you cannot reconstruct a recognisable
face from it. It is still biometric personal data under GDPR and the DPDP Act,
so it is the most locked-down table in the schema:

- No role holds `SELECT` on it. Not `anon`, not `authenticated`, not an
  organization owner. This is a table-level `REVOKE`, so even a mistaken RLS
  policy cannot leak vectors.
- Reads happen only inside `SECURITY DEFINER` functions that return a
  *similarity score*, never a vector.
- `public.face_template_meta` exposes the non-sensitive columns (quality,
  created_at, revoked_at) for the UI. It is deliberately **not** a
  `security_invoker` view — an invoker view would need the caller to hold
  `SELECT` on the base table, which is exactly the privilege being withheld. It
  runs as its owner and does its own org/role filtering instead.
- Deletion is soft (`revoked_at`) so an audit trail survives, with a hard
  `DELETE` available to the employee themselves.

Similarity is cosine distance over unit vectors, which pgvector computes as
`1 - (a <=> b)`. Because the browser normalises before sending, that is
arithmetically identical to the dot product the client computes — the two agree
to within float32 precision, which `src/tests/math.test.ts` pins down.

An HNSW index sits on the column. For a few hundred employees a sequential scan
is already sub-millisecond; the index is there so 1:N kiosk identification stays
flat as the organization grows.

### `punch_events` — every attempt, including the failures

Rejections are the interesting rows during an incident review, so nothing is
discarded. A row carries the outcome, the similarity that was achieved, the
liveness and quality scores, distance from the geofence centre, device hash,
user agent, and a pointer to the stored face crop.

The `v_anomalies` view surfaces the non-accepted ones on the **Flags** page.

### `attendance_days` — the derived roll-up

Maintained by `recompute_day()` after each accepted punch, so reports never
re-derive anything. Two details worth knowing:

**Worked minutes sum in/out pairs, not first-to-last.** Someone who checks out
for lunch and back in gets their lunch excluded. The query pairs each
`check_in` with the `lead()` row where the next kind is `check_out`.

**`first_in` and `last_out` are filtered by punch kind.** An earlier version used
plain `min()`/`max()` over all punches, which set `last_out` from the check-in
itself — making a day look closed the instant it opened, so the next punch was
read as another check-in rather than the check-out it was. The
`filter (where kind = ...)` clauses are load-bearing.

**A manual correction is never overwritten.** `recompute_day()` returns early if
`manually_edited` is set, so a later punch cannot silently undo an admin's fix.

## The punch pipeline

### In the browser

1. **Detect.** `FaceLandmarker` in VIDEO mode, configured for two faces — not
   one. Seeing a second face is a hard reject, because that is either a
   bystander or someone holding a phone up beside a colleague.

2. **Gate on quality.** Face size, Laplacian variance for sharpness, mean
   luminance, yaw/pitch/roll from the pose matrix, and whether the eyes are open.
   The overall score is weighted toward the *weakest* dimension so one bad axis
   cannot be averaged away by four good ones. Enrolment runs stricter than
   check-in: a blurry template poisons every future comparison.

3. **Check liveness.** Covered in [THREAT-MODEL.md](THREAT-MODEL.md).

4. **Align.** The five alignment points (iris centres, nose tip, mouth corners)
   are fitted to InsightFace's canonical 112×112 template with a least-squares
   *similarity* transform — uniform scale, rotation, translation, no shear, no
   reflection.

   Because that transform is linear in its four parameters, the fit has a closed
   form and needs no SVD. It is then handed straight to `canvas2d.setTransform`,
   so the resampling runs on the GPU with proper bilinear filtering instead of a
   JS pixel loop.

   Left and right are assigned by image x-coordinate rather than by MediaPipe's
   subject-relative landmark names, which makes the result immune to mirroring.

5. **Embed.** The 112×112 crop becomes an NCHW float tensor scaled to [-1, 1],
   then runs through the ONNX recogniser. Input and output names are read off
   the session rather than hard-coded, so swapping in a different ArcFace export
   needs no code change. Three to five good frames are fused by taking the
   renormalised mean, which is markedly more stable than any single frame.

### In the database

`record_punch()` evaluates, in order:

| # | Check | Rejection |
|---|---|---|
| 1 | Is the employee active? | raises — a suspended account cannot punch at all |
| 2 | Are there any templates? | `rejected_not_enrolled` |
| 3 | Quality ≥ `min_quality_score` | `rejected_quality` |
| 4 | Liveness ≥ `min_liveness_score` | `rejected_liveness` |
| 5 | Inside the geofence | `rejected_geofence` |
| 6 | Device matches the pinned one | `rejected_duplicate` |
| 7 | Gap since last accepted punch | `rejected_duplicate` |
| 8 | Cosine similarity ≥ `match_threshold` | `rejected_no_match` |

The face comparison runs even for some earlier rejections, so the audit trail can
distinguish *"wrong person"* from *"right person, wrong place"*.

Then it decides direction: if today's roll-up has a `first_in` and no `last_out`,
this is a check-out; otherwise a check-in. The client can override with an
explicit `p_kind`, but never needs to.

## Access control

Role hierarchy: `owner` > `admin` > `manager` > `employee`.

RLS is on for every table. The predicates call `SECURITY DEFINER` helpers
(`current_org()`, `is_admin()`, `is_manager_or_above()`) — definer functions
bypass RLS, which is what stops a policy on `profiles` recursing when it needs to
read `profiles` to decide.

Grants are spelled out explicitly rather than inherited from Supabase's defaults
for the `public` schema. That makes the schema portable and makes it hard to add
a table that is accidentally world-readable.

### The column guard

Which *columns* a non-admin may change is enforced by a `BEFORE UPDATE` trigger,
not by RLS.

The natural-looking policy — `with check (role = (select role from profiles
where id = auth.uid()))` — does not work. The subquery re-reads the very row the
statement is updating and does not reliably yield the pre-update value, so an
employee can promote themselves to owner. The local assertion suite caught this;
a trigger sees `OLD` and `NEW` directly and has no such ambiguity.

The trigger also stops an admin changing *their own* role or status, so the last
owner cannot lock the organization out. It no-ops when `auth.uid()` is null, so
`service_role` and direct SQL sessions — how an operator fixes things — still
work.

## Model assets

Weights are fetched at install time, never committed. `scripts/fetch-models.mjs`
copies two WASM runtimes out of `node_modules` and downloads two model files,
each with several mirrors.

The copy step is filtered on purpose. Both packages ship every backend variant
they support, about 130 MB together — enough to blow past Vercel's 100 MB
static-upload cap and make the project undeployable on a free tier. The lean
default keeps only what actually loads:

| File | Size |
|---|---|
| `ort-wasm-simd-threaded.wasm` | 14 MB |
| `vision_wasm_internal.wasm` | 12 MB |
| `face_landmarker.task` | ~3.8 MB |
| `w600k_mbf.onnx` | ~13 MB |

`--full` adds the WebGPU provider and MediaPipe's non-SIMD fallback for about
39 MB more. Worth it when self-hosting; not on Hobby.

A failed download never fails the install — a CI box without network still
builds, and the app reports a clear error at capture time instead.

## Why not the alternatives

**Server-side recognition (InsightFace in Python).** Better accuracy, real PAD
models, an embedding the user cannot forge. It also needs a container that does
not sleep, which no free tier offers. Vercel cannot host it at all.

**face-api.js.** One dependency instead of two, but the project has been
unmaintained since 2020 and its 128-d descriptors are meaningfully weaker than
ArcFace's 512-d ones. It also has no blendshape output, which would remove the
main liveness signal.

**A shared kiosk instead of personal phones.** Stronger security — 1:N matching
on a device the organization controls — and no personal-device policy questions.
The database already supports it via `identify_face()`. It was not the mode
requested here, but it is a drop-in second front-end.
