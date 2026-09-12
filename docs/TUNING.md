# Tuning

## The match threshold

`org_settings.match_threshold` is the cosine similarity a capture must reach
against the employee's own enrolled templates. It is the single most consequential
number in the system.

| Threshold | Behaviour |
|---|---|
| 0.30 | Almost nobody is rejected. A stranger has a real chance of passing. |
| 0.36 | InsightFace's published operating point for this model family. |
| **0.42** | The default here — deliberately stricter, because a false accept is worse than a retry. |
| 0.50 | Noticeably strict. Poor lighting starts failing legitimate people. |
| 0.60+ | Most check-ins fail. Not useful. |

### How to pick yours

Run at the default for a week, then look at the Flags page. Each rejected
attempt records the similarity it achieved.

- Legitimate people failing in the **0.38–0.45** band means the threshold is a
  little high for your lighting, or those individuals need to re-enrol.
- Nothing ever appearing in the flags list at all is not necessarily good news —
  check that people are actually using the system before concluding the
  threshold is well calibrated.
- Anything succeeding near the threshold is worth opening the stored photo for.

Raise the threshold if attendance matters for pay or compliance. Lower it if
your team works in dim light or wears safety equipment.

### Re-enrolment beats threshold-fiddling

If one person is consistently borderline, the fix is almost always their
templates, not the global number. Clearing their enrolment from the People page
and having them redo it somewhere bright typically moves their similarity by
more than any threshold change would.

## Liveness strictness

`liveness_mode` and `min_liveness_score` trade security against friction.

| Setting | Adds | Suits |
|---|---|---|
| `active` + 0.60 | Two randomised prompts, ~5 s per check-in | Phone check-in, the default |
| `passive` + 0.60 | Nothing visible; silent checks only | A supervised kiosk |
| `passive` + 0.45 | Nothing visible, more forgiving | Small trusted teams tired of retries |
| `off` | Nothing | Only where spoofing genuinely is not a concern |

If `rejected_liveness` dominates your flags, people are holding the phone too
still, or the session ends before the challenge completes. Dropping
`min_liveness_score` to 0.5 usually clears it without giving much up.

## Quality gating

`min_quality_score` defaults to 0.55. The gate weights the *weakest* dimension
heavily, so one bad axis — usually light or motion blur — dominates the score.

Enrolment always runs stricter than check-in, by design. A blurry template is a
permanent tax on every future comparison.

`rejected_quality` clustering in the early morning or late evening almost always
means lighting at the entrance, not a settings problem.

## Working hours

- `late_grace_minutes` (default 15) — the window after `workday_start` before a
  day is marked late.
- `full_day_min_minutes` (default 480) — minutes needed for `present`.
- `half_day_max_minutes` (default 300) — at or below this, the day is
  `half_day`.
- `workdays` — ISO weekday numbers, Monday is 1. `{1,2,3,4,5}` by default; use
  `{1,2,3,4,5,6}` for a six-day week.

Worked minutes sum check-in/check-out *pairs*, so lunch breaks are excluded if
people punch out for them. If your team does not, `full_day_min_minutes` should
account for the break rather than assuming a clean eight hours at desk.

## Anti-abuse

- `min_punch_gap_seconds` (default 60) — stops double-taps creating spurious
  check-outs. Raise it to 300 if people are accidentally punching twice.
- `require_device_binding` — the first device an account uses becomes its only
  device. Effective against account sharing; annoying when someone gets a new
  phone, since an admin must clear `bound_device_hash` on their profile.
- `store_punch_photo` — keep this on. It is the difference between a disputed
  record you can settle and one you cannot.
- `photo_retention_days` (default 30) — long enough for a payroll cycle dispute,
  short enough to be defensible. Longer retention needs a stated justification
  under most privacy regimes.
