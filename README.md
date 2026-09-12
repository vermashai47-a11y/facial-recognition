# Face Attendance

Attendance marking for an organization, verified by face, running entirely on
free-tier infrastructure. Employees check in from their own phone: the browser
detects their face, runs a few anti-spoofing checks, computes a 512-number
embedding locally, and sends that to Postgres, which decides whether it counts.

Everything in the stack is open source. There is no paid API, no GPU to rent,
and no face data leaving the device except as a mathematical projection.

```
Phone browser                          Supabase (Postgres)
┌──────────────────────────┐          ┌───────────────────────────────┐
│ MediaPipe FaceLandmarker │          │ record_punch()                │
│  → 478 landmarks         │          │  ├ is the person enrolled?    │
│  → 52 blendshapes        │          │  ├ liveness above the floor?  │
│  → head pose matrix      │          │  ├ capture sharp enough?      │
│            ↓             │          │  ├ inside the geofence?       │
│ liveness + quality gate  │          │  ├ not a repeat punch?        │
│            ↓             │          │  ├ pgvector cosine match      │
│ align → 112×112 crop     │  embed   │  └ in or out?                 │
│            ↓             │ ───────► │            ↓                  │
│ ArcFace ONNX → 512 floats│  (512    │  punch_events + attendance_day│
└──────────────────────────┘  floats) └───────────────────────────────┘
```

## What it does

**For employees** — enrol once (three captures, about thirty seconds), then
check in and out from a phone. Randomised liveness prompts. A running view of
their own attendance. A one-click button to delete their face data.

**For admins** — a live board of who is in, a fourteen-day attendance chart,
per-person management, monthly reports with CSV export, a flagged-attempts log
for anything rejected, and settings that are enforced by the database rather
than the browser: match threshold, liveness strictness, working hours, late
grace, geofence, photo retention, device pinning.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Face detection | [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe) | 478 landmarks *and* 52 blendshapes *and* head pose in one pass — the blendshapes are what make liveness detection possible |
| Recognition | ArcFace / MobileFaceNet ONNX via [onnxruntime-web](https://onnxruntime.ai/) | 512-d embeddings, ~13 MB, runs in WASM on a phone in well under 100 ms |
| Database | [Supabase](https://supabase.com) Postgres + [pgvector](https://github.com/pgvector/pgvector) | Cosine search, row-level security, auth and object storage in one free project |
| App | [Next.js 16](https://nextjs.org) + React 19 + Tailwind 4 | One deployable, server components for the dashboards, client components for the camera |
| Hosting | Vercel / Cloudflare / anywhere | Static assets plus a handful of server routes |

Licences: MediaPipe Apache-2.0, ONNX Runtime MIT, pgvector PostgreSQL licence,
Next.js MIT. The recognition weights are the one thing to check — see
[docs/PRIVACY.md](docs/PRIVACY.md#model-licensing).

## Two ways to set this up

**No terminal** — run the schema by pasting one file into Supabase's SQL Editor,
and let Vercel build the app from GitHub. Nothing is installed on your machine.
→ **[WEB-SETUP.md](WEB-SETUP.md)**

**Local development** — the rest of this section.

## Quick start

```bash
git clone <your-fork> face-attendance && cd face-attendance
npm install                 # also fetches ~43 MB of model assets
cp .env.example .env.local  # fill in your Supabase keys
```

Create a free Supabase project at [supabase.com](https://supabase.com), then push
the schema. The Supabase CLI is not a project dependency — every `db:*` script
goes through `npx`, so there is nothing to install globally:

```bash
npx --yes supabase@latest login          # opens a browser, one time per machine
npm run db:link -- --project-ref YOUR_PROJECT_REF
npm run db:push
```

Your project ref is the subdomain of your project URL:
`https://abcdefghijk.supabase.co` → `abcdefghijk`.

Edit the organization name and timezone in
`supabase/migrations/0009_bootstrap.sql` before pushing, or change them later in
**Admin → Settings**.

```bash
npm run dev
```

Open `http://localhost:3000`, create the first account — it automatically
becomes the organization owner — and enrol your face.

> **Camera access requires HTTPS.** `localhost` is exempt, so local development
> works, but testing from a phone on your LAN needs a tunnel
> (`npx localtunnel --port 3000`) or a deployed preview.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm test` | 32 unit tests: embedding maths, alignment geometry, liveness scoring, CSV |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:push` | Apply migrations to the linked Supabase project |
| `npm run db:verify` | Apply every migration to a scratch local Postgres and run 35 security assertions |
| `npm run fetch:models` | Re-download model assets (`-- --force` to overwrite, `-- --full` for WebGPU) |
| `npm run verify:models` | Report which model assets are present, without touching the network |

`db:verify` needs a local Postgres with pgvector and is the useful one to run in
CI — it is what proves the row-level security policies still hold. It is a shell
script, so on Windows run it from Git Bash or WSL rather than `cmd`.

`npm install` fetches the model assets as a postinstall step and prints one
summary line. If you missed it, `npm run verify:models` says what is on disk.

## How verification works, and why it is 1:1

When someone checks in they are already signed in, so the system does not need
to answer *"who is this?"* — only *"is this the person whose account is
posting?"*. That is a 1:1 comparison against that one account's templates.

This matters for more than speed. A 1:N identification endpoint is an oracle:
give it any embedding and it tells you which colleague it belongs to. The 1:N
function exists (`identify_face`, for an optional shared kiosk) but it is
admin-only, and the check-in path never touches it.

## The honest limitation

The embedding is computed in the browser, which means a determined employee
could, in principle, run the model against a photo of a colleague and post the
resulting numbers. Nothing in a client-side architecture can prevent that.

What the system does instead is make it expensive and visible:

- The endpoint is 1:1, so the attacker must already be signed in as the person
  they are impersonating — which is a password problem, not a face problem.
- Every check-in stores an aligned face crop, so a disputed record has evidence.
- Every rejected attempt is kept and surfaced on the **Flags** page.
- Optional geofencing and one-device pinning narrow where it can happen from.

If you need cryptographic assurance rather than deterrence, the embedding has to
be computed somewhere the user does not control — see
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md#if-you-need-more-assurance).

## Free-tier capacity

Sized for **200 employees, two punches a day, 22 working days a month**:

| Resource | Free allowance | This workload | Headroom |
|---|---|---|---|
| Supabase database | 500 MB | ~2.5 MB/month | years |
| Supabase storage | 1 GB | ~53 MB steady state at 30-day photo retention | 18× |
| Supabase egress | 5 GB/month | well under 1 GB | comfortable |
| Supabase MAU | 50,000 | 200 | 250× |
| Vercel invocations | 1,000,000/month | ~45,000 | 20× |
| Vercel data transfer | 100 GB/month | **~8.6 GB of first-load model downloads** | 11× |

The binding constraint is the last row. Model assets are ~43 MB per device,
served `immutable` with a one-year cache, so each phone pays it once. That is
roughly 2,300 cold loads a month before you hit the cap. Put the `/models` and
`/ort` paths behind a CDN, or on Supabase Storage, if you expect more.

Supabase pauses a free project after a week with no activity — fine for a daily
attendance system, awkward for a long holiday shutdown.

> **Vercel's Hobby plan is for non-commercial use.** An organization's internal
> attendance system is commercial use, so a real deployment wants either Vercel
> Pro or a free tier without that restriction. Cloudflare Pages and Workers have
> no such clause and a generous free tier —
> [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#cloudflare-the-commercially-clear-free-option)
> covers that path.

## Before you deploy this for real

Facial recognition on employees is regulated almost everywhere. Under India's
DPDP Act biometric data needs specific, informed, withdrawable consent; under
GDPR Article 9 it is a special category requiring an explicit lawful basis and a
Data Protection Impact Assessment; Illinois' BIPA carries statutory damages per
violation. In several jurisdictions you must offer a non-biometric alternative
to employees who decline.

[docs/PRIVACY.md](docs/PRIVACY.md) covers what the system stores, for how long,
what it deletes, and what you still have to do yourself. It is not legal advice
— talk to someone qualified in your jurisdiction before rollout.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data model, the punch pipeline, why each decision went the way it did
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Supabase setup, Vercel and Cloudflare, self-hosting
- [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) — what each control stops, what it does not
- [docs/PRIVACY.md](docs/PRIVACY.md) — data inventory, retention, deletion, compliance checklist
- [docs/TUNING.md](docs/TUNING.md) — picking a match threshold, reading the flags page

## Licence

MIT for this code. The models carry their own terms; check them before
commercial use.
