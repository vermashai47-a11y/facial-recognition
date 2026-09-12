# Browser-only setup

No terminal, no CLI, no local install. Supabase runs the schema from its SQL
Editor; Vercel installs and builds the app on its own machines.

Total time: about fifteen minutes.

---

## Step 1 — Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. **New project**. Pick a region near your employees — **Mumbai (ap-south-1)**
   for India. Choose a strong database password and save it somewhere; you will
   not need it for this setup, but you will regret losing it later.
3. Wait for provisioning to finish (a minute or two).

## Step 2 — Run the schema

1. In the left sidebar open **SQL Editor** → **New query**.
2. Open `supabase/setup.sql` from the project folder in any text editor
   (Notepad is fine) and copy the whole thing.
3. Paste it into the editor. **Before running**, scroll to the bottom — the
   block marked `STEP 9` — and change these three values:

   ```sql
   insert into public.organizations (name, slug, timezone)
   values ('My Organization', 'my-org', 'Asia/Kolkata')
   ```

   The slug must be lowercase letters, digits and hyphens. The timezone decides
   what counts as "today", so get it right.

4. Press **Run** (or Ctrl+Enter).

You should see *Success. No rows returned* and a notice reading
`Bootstrapped organization <uuid>`. It takes about two seconds.

The file is safe to re-run — every statement is written to be idempotent, and
the bootstrap block skips itself once an organization exists.

## Step 3 — Check it worked

New query → paste `supabase/verify.sql` → **Run**.

You get a fifteen-row table. Every row should show ✅ PASS, except the last
which is informational. It confirms pgvector is live, all nine tables exist, RLS
is on everywhere, the storage buckets were created, and — the important one —
that no API role can read raw face embeddings.

If **storage buckets** or **storage policies** shows ❌, your project restricts
policy creation on `storage.objects` from the SQL Editor. Create them by hand:
**Storage → New bucket** → name `punch-photos`, **Private**, then repeat for
`avatars`. Then re-run just the `STEP 7` portion of `setup.sql`.

## Step 4 — Collect your keys

**Project Settings → API**. You need three values:

| Where it says | Copy it into | Secret? |
|---|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` | no |
| `anon` `public` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no — RLS is what protects the data |
| `service_role` `secret` | `SUPABASE_SERVICE_ROLE_KEY` | **yes, never share or commit it** |

Keep this tab open.

## Step 5 — Get the code onto GitHub

Vercel deploys from a Git repository. Entirely in the browser:

1. [github.com/new](https://github.com/new) → name it `face-attendance` →
   **Private** → **Create repository**.
2. On the empty repo page, click **uploading an existing file**.
3. Unzip `face-attendance.zip` on your computer, then drag the **contents** of
   the folder into the upload area — not the folder itself, or every path gains
   an extra level and the build will not find `package.json`.
4. Wait for the file list to finish appearing, then **Commit changes**.

> **Do not upload `node_modules`**, if you have one from a previous attempt.
> It is tens of thousands of files, GitHub's web uploader will choke, and Vercel
> installs dependencies itself. The included `.gitignore` excludes it when using
> git properly, but the web uploader ignores that file — so just do not drag it
> in. The same goes for `.next` and `.env.local`.

## Step 6 — Deploy on Vercel

1. [vercel.com/new](https://vercel.com/new) → sign in with GitHub → **Import**
   your `face-attendance` repository.
2. Framework preset should auto-detect **Next.js**. Leave the build settings
   alone.
3. Expand **Environment Variables** and add four:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | from Step 4 |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from Step 4 |
   | `SUPABASE_SERVICE_ROLE_KEY` | from Step 4 |
   | `CRON_SECRET` | any long random string — [random.org](https://www.random.org/strings/?num=1&len=32&digits=on&upperalpha=on&loweralpha=on&format=html) will generate one |

4. **Deploy.**

The build takes two to four minutes. During it, Vercel runs `npm ci`, which
triggers the postinstall that downloads the face models (~17 MB) — that is
normal and adds perhaps thirty seconds.

### If the build fails

Open the build log and look for the model fetch near the top. If it reports
`Could not download`, the app still deploys but face capture will not work.
Re-run the deployment; the mirrors are occasionally slow. Everything else in the
log should be clean — this exact commit builds green.

## Step 7 — Point Supabase back at Vercel

Copy your new Vercel URL (something like
`https://face-attendance-abc123.vercel.app`).

In Supabase → **Authentication → URL Configuration**:

- **Site URL**: your Vercel URL
- **Redirect URLs**: add `https://YOUR-URL.vercel.app/auth/callback`

Then **Authentication → Providers → Email**: if you are creating accounts for a
small team, turn **Confirm email** off. Onboarding is much smoother, and the
people signing up are your colleagues.

## Step 8 — Create the owner account

Open your Vercel URL. Choose **Create one**, sign up with your work email.

**The first account created becomes the organization owner.** Do this before
sharing the link with anyone.

Then:

1. Go to **My face** and enrol — three captures, about thirty seconds. This is
   also the fastest proof that the models loaded and the camera works.
2. Go to **Settings** and set working hours, the late grace period, and — if you
   want it — the geofence. Standing in the office, "Use my current location"
   fills in the coordinates; 150–250 m is a sensible radius given phone GPS.
3. Try a check-in.

Then send the link to your team. They sign up, enrol, and start checking in.

---

## Things to know

**Camera requires HTTPS.** Vercel gives you HTTPS automatically, so this just
works — it is only local development that needs a tunnel.

**Vercel's Hobby plan is for non-commercial use.** An internal attendance system
is commercial use, however small the organization. For a real rollout you want
Vercel Pro, or Cloudflare Pages which has no such clause — see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#cloudflare-the-commercially-clear-free-option).

**The model weights are licensed for non-commercial research.** Separate from
the hosting question, and it applies wherever you deploy. Options are in
[docs/PRIVACY.md](docs/PRIVACY.md#model-licensing).

**Free Supabase projects pause after a week of inactivity.** Fine for daily use;
open the dashboard to resume after a long shutdown.

**Consent is not optional.** Facial recognition on employees is regulated under
India's DPDP Act and most other regimes — specific, informed, withdrawable
consent, and a genuine non-biometric alternative for anyone who declines.
[docs/PRIVACY.md](docs/PRIVACY.md) is a starting point, not legal advice.

## Making changes later

Edit a file on GitHub (pencil icon) → **Commit changes** → Vercel redeploys
automatically in a couple of minutes.

For schema changes, paste the new SQL into the Supabase SQL Editor the same way.
`setup.sql` is safe to re-run in full if you are ever unsure of the state.
