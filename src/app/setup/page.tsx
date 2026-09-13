import { checkSupabaseEnv } from '@/lib/env';

export const dynamic = 'force-dynamic';

/**
 * Shown when the Supabase environment variables are missing or malformed.
 * Reports presence and shape — never a secret value.
 */
export default function SetupPage() {
  const report = checkSupabaseEnv();

  if (report.ok) {
    return (
      <main className="mx-auto max-w-xl px-5 py-16">
        <h1 className="text-xl font-semibold tracking-tight">Configuration looks good</h1>
        <p className="muted mt-2 text-sm">
          Both Supabase variables are set and well-formed. If you were sent here, try the{' '}
          <a href="/login" className="underline underline-offset-4">
            sign-in page
          </a>{' '}
          again.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-12">
      <h1 className="text-xl font-semibold tracking-tight">Not configured yet</h1>
      <p className="muted mt-2 text-sm">
        This deployment cannot reach Supabase. Nothing is broken in the code — these values just
        need to be set on the host and the project redeployed.
      </p>

      <ul className="mt-6 space-y-3">
        {report.vars.map((v) => (
          <li key={v.name} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <code className="text-sm font-medium">{v.name}</code>
              <span
                className={`pill ${
                  v.present && !v.problem
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300'
                }`}
              >
                {v.present && !v.problem ? 'OK' : v.present ? 'Problem' : 'Missing'}
              </span>
            </div>
            <p className="muted mt-1.5 font-mono text-xs break-all">{v.hint}</p>
            {v.problem && <p className="mt-1.5 text-sm text-rose-600 dark:text-rose-400">{v.problem}</p>}
          </li>
        ))}
      </ul>

      <section className="card mt-6 p-4 text-sm">
        <p className="font-medium">On Vercel</p>
        <ol className="muted mt-2 list-decimal space-y-1.5 pl-5">
          <li>
            Settings → Environment Variables. Both names above must match exactly, and their Type
            must be <strong>Config</strong>, not Secret — secrets are write-only and are not
            available to the build, so a <code>NEXT_PUBLIC_</code> variable marked Secret arrives
            undefined.
          </li>
          <li>Set Environments to All Environments.</li>
          <li>
            Deployments → latest → ⋯ → Redeploy, with <strong>Use existing Build Cache unticked</strong>.
            A cached build keeps the old, empty values.
          </li>
        </ol>
      </section>

      <p className="muted mt-5 text-xs">
        These two values are meant to be public — they ship in the browser bundle of every Supabase
        app. Row level security is what protects your data. The service role key is the one that
        must stay secret, and it is never read here.
      </p>
    </main>
  );
}
