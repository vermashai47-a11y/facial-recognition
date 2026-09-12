# Deployment

## 1. Supabase

Create a free project at [supabase.com](https://supabase.com). Pick a region
near your employees — for India, Mumbai (`ap-south-1`).

From **Project Settings → API** you need three values:

| Value | Goes in | Exposed to the browser? |
|---|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` | yes |
| `anon` public key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes, by design — RLS is what protects the data |
| `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` | **never** |

Before pushing the schema, edit `supabase/migrations/0009_bootstrap.sql` to set
your organization name, slug and timezone. Then:

```bash
npx --yes supabase@latest login          # one time per machine
npm run db:link -- --project-ref YOUR_PROJECT_REF
npm run db:push
```

The CLI is deliberately not a project dependency — Supabase's own docs advise
against installing it via npm globally — so the `db:*` scripts invoke it through
`npx`. The first run downloads it and takes a moment.

Your project ref is the subdomain of the project URL:
`https://abcdefghijk.supabase.co` → `abcdefghijk`. It is also on
**Project Settings → General**.

That creates the tables, enables pgvector, installs the RLS policies, and
creates the `punch-photos` and `avatars` storage buckets with their policies.

### Auth settings

Under **Authentication → Providers → Email**, decide on confirmations. For a
small organization where you are creating accounts anyway, turning confirmation
off makes onboarding much smoother. Leave it on if people sign up themselves.

Under **Authentication → URL Configuration**, set the Site URL to your deployed
origin and add `https://your-domain/auth/callback` to the redirect allow-list.

### First account

The first account created becomes the organization **owner** — see
`app_private.handle_new_user()`. Create yours before sharing the link.

## 2. Vercel

```bash
npm i -g vercel
vercel link
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add CRON_SECRET        # openssl rand -hex 32
vercel --prod
```

`vercel.json` already declares the nightly cron that purges expired photos, and
pins the region to `bom1` (Mumbai) — change it if your team is elsewhere.

### The commercial-use caveat

**Vercel's Hobby plan is for non-commercial use.** An internal attendance system
for an organization is commercial use, however small the organization. Options:

- Vercel Pro, currently $20/user/month.
- Cloudflare, below — no such clause.
- Self-host, below.

### Cloudflare: the commercially clear free option

Cloudflare Pages and Workers permit commercial use on the free plan, and the
free bandwidth is effectively unmetered — which suits this project, since its
main cost is shipping ~43 MB of model assets to each device.

```bash
npm i -D @opennextjs/cloudflare
npx opennextjs-cloudflare build
npx wrangler deploy
```

Two adjustments:

1. Move the `crons` entry from `vercel.json` into `wrangler.toml` as a
   [Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
   pointing at the same route.
2. Set the same environment variables with `wrangler secret put`.

### Self-hosting

```bash
npm run build
npm start          # or PM2, or a container behind nginx
```

Two requirements the app depends on:

- **HTTPS.** `getUserMedia` refuses to run on plain HTTP outside `localhost`.
- **The COOP/COEP headers** from `next.config.ts` must survive your reverse
  proxy. They are what make `SharedArrayBuffer` available; without them
  onnxruntime-web silently drops to a single thread and inference gets roughly
  three times slower.

## 3. After deploying

1. Sign in as the owner and enrol your own face — the fastest way to confirm
   models load and the camera works on a real device.
2. Set working hours, timezone and the late grace period in **Settings**.
3. Decide on the geofence. "Use my current location" while standing in the
   office is the easy way; 150–250 m suits most sites, given phone GPS accuracy.
4. Leave `match_threshold` at 0.42 for a week, then read
   [TUNING.md](TUNING.md) with real data in hand.
5. Send people the link. They sign up, enrol, and start checking in.

## Verifying a deployment

```bash
npm run typecheck
npm test            # 32 unit tests
npm run db:verify   # 35 assertions against a scratch Postgres
```

`db:verify` needs a local Postgres with pgvector:

```bash
sudo apt-get install postgresql-16 postgresql-16-pgvector
```

On Windows, `db:verify` is a shell script — run it from Git Bash or WSL, not
`cmd` or PowerShell.

It creates a throwaway database, applies every migration in order, and asserts
the security properties hold — that an employee cannot read a colleague's
attendance, that nobody can `SELECT` raw embeddings, that a non-matching face is
rejected, that an employee cannot promote themselves. Run it in CI; it is what
catches an RLS regression before it ships.

## Troubleshooting

**"Could not load the recognition model"** — the model files did not download.
Run `npm run verify:models` to see what is missing, then
`npm run fetch:models -- --force` and read the output. If your network
blocks the mirrors, download `buffalo_s` from the InsightFace model zoo by hand
and drop `w600k_mbf.onnx` into `public/models/recognition/`.

**The camera never starts on iOS** — Safari requires a user gesture before
`play()`. The "Turn on camera" button provides one. If it still fails, check
that the page is on HTTPS and that Settings → Safari → Camera is set to Ask or
Allow.

**Everyone is being rejected as `rejected_no_match`** — usually a threshold set
too high, or enrolment done in poor light. Have one person re-enrol somewhere
bright and watch their similarity score on the check-in screen.

**Slow inference on mid-range Android** — confirm the COOP/COEP headers are
reaching the browser (`crossOriginIsolated` should be `true` in the console).
If they are stripped by a proxy, threading is off.

**`'supabase' is not recognized as an internal or external command`** — you are
on an older copy of this repo where the `db:*` scripts called the CLI directly.
Either update the scripts to the `npx --yes supabase@latest ...` form, or install
the CLI for your platform (`scoop install supabase` on Windows,
`brew install supabase/tap/supabase` on macOS).

**Supabase project paused** — free projects pause after a week of inactivity.
Open the dashboard to resume. A daily-use attendance system will not hit this
outside a long shutdown.
