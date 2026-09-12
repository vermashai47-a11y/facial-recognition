# Threat model

What each control actually stops, and what it does not. The short version: this
system raises the cost of attendance fraud and makes it visible after the fact.
It does not make it impossible.

## The attacks, honestly assessed

| Attack | Stopped by | Effectiveness |
|---|---|---|
| Holding up a printed photo | Liveness: head-turn challenge, blendshape variance, mesh depth | **High.** A flat print cannot turn its head or produce micro-expressions. |
| Photo on a phone screen | Same, plus the second-face check | **High** for a still image. |
| Replaying a video of a colleague | Randomised challenge order, blendshape variance | **Moderate.** A recording made in advance will not contain today's random prompt sequence. A live deepfake fed through a virtual camera will defeat this. |
| Colleague punches in for you | You must be signed in as them | **High** — this reduces to password security, not face security. |
| Running the model against a colleague's photo offline | Nothing, technically | **Not prevented.** See below. |
| Punching in from home | Geofence + accuracy check | **Moderate.** GPS can be spoofed on a rooted device or with developer tools. |
| Two people sharing one account | Device pinning, stored photos | **Moderate.** Detectable in review rather than blocked. |
| Reading colleagues' attendance | Row-level security | **High** — verified by 35 assertions in `supabase/tests/`. |
| Stealing the face database | No `SELECT` grant on `face_templates` for any API role | **High** against the API. A Postgres superuser or a leaked service-role key reaches everything. |

## The one that is not prevented

The embedding is computed in the browser. A technically capable employee can
open the console, run the same ONNX model against a photograph of a colleague,
and post the resulting 512 numbers to `record_punch()`.

There is no client-side fix for this. Any check the client performs, the client
can skip.

What actually constrains it:

**The endpoint is 1:1, not 1:N.** The attacker must already be authenticated as
the person they are impersonating. If they have their colleague's password, the
face check was never the weak link.

**They cannot obtain the target's template.** No role can read
`face_templates`, so the embedding has to be derived from a photograph they
took themselves, at usable quality.

**Every attempt is photographed.** With `store_punch_photo` on, each check-in
saves the aligned crop. A forged embedding still writes a row — and whatever the
camera was actually pointing at goes into storage next to it.

**Failures accumulate visibly.** Getting a self-made embedding above threshold
usually takes several tries, and every rejection lands on the Flags page with a
similarity score.

The result is an attack that requires technical skill, a good photo of a
colleague, that colleague's password, and leaves a photographic and statistical
trail. For attendance that is a reasonable place to land.

### If you need more assurance

The embedding has to be computed somewhere the user does not control. Ship the
image instead of the vector, and run recognition server-side:

1. Upload the aligned crop to Supabase Storage.
2. Run InsightFace in a container (Hugging Face Spaces and Render both have free
   tiers, both sleep, both cold-start in 10–30 seconds).
3. Have that service compute the embedding and call `record_punch()` with the
   service-role key.

`record_punch()` needs no changes — only its caller does. You gain an
unforgeable embedding and the option of a real PAD model, and you lose the
zero-cost, zero-latency property that made this design work.

A shared kiosk on organization-owned hardware gets you the same assurance
without a server: the device is trusted because you control it. `identify_face()`
is already there for the 1:N matching a kiosk needs.

## Liveness in detail

Three passive signals plus an active challenge, combined into one score the
server compares against `min_liveness_score`.

**Micro-expression variety** (45% of the passive score) — the strongest signal.
A real face is never still: brows, jaw and eyelids jitter constantly. The tracker
takes the temporal standard deviation across nine blendshape channels over a
four-second window. A photograph's blendshape vector is frozen and this
collapses to near zero. `src/tests/liveness.test.ts` asserts that a perfectly
static input scores below 0.3 while a moving face scores at least 0.3 higher.

**Head micro-motion** (20%) — weak alone, since a shaking hand moves a photo
too, but it separates a live face from a tripod-mounted print.

**Mesh depth relief** (20%) — MediaPipe fits a 3D mesh to whatever it sees. A
flat surface yields a shallower, noisier z-profile than a real head.

**A completed blink** (15%) — tracked as a full close-then-open cycle, not
merely a low eye-open value, so a half-closed still frame does not count.

**The active challenge** carries 60% of the final score in `active` mode. Two
prompts: always one head turn (which a flat photo cannot fake at all) plus one
facial action, drawn from the CSPRNG so a recording made yesterday will not line
up with today's prompts. A step that times out rotates to a different action
rather than failing outright, because people misread the first prompt constantly.

### What this is not

This is not certified presentation-attack detection. It has not been tested
against ISO/IEC 30107-3. A determined attacker replaying high-quality video on a
good screen in the right lighting can defeat every check here. Beating that class
of attack needs depth or infrared hardware, which a browser cannot reach.

Set `liveness_mode` honestly for your context. `active` for phone check-in,
where the spoofing surface is widest. `passive` where a kiosk is supervised.
`off` only for a small, trusted team that would find prompts insulting.

## Operational risks worth naming

**A leaked `SUPABASE_SERVICE_ROLE_KEY` is total compromise** — it bypasses RLS
entirely. It belongs only in server-side environment variables, is used by
exactly one route in this codebase (the nightly cron), and must never carry a
`NEXT_PUBLIC_` prefix.

**An admin can see every stored face photo.** That is the point — it is what
makes auditing possible — but it is also a surveillance capability. Keep
`photo_retention_days` short and the admin list small.

**Thresholds set too low silently degrade everything.** At `match_threshold`
0.25 a stranger has a real chance of passing. [TUNING.md](TUNING.md) covers
choosing a defensible value.

**The demographic accuracy gap is real.** Published NIST evaluations have
repeatedly found higher false-non-match rates for darker-skinned faces, women,
and the very young and very old. In practice that means some employees will be
asked to retry more often than others. Watch the Flags page per-person, not just
in aggregate, and always keep a manual-correction path open.
