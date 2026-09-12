import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import EmptyState from '@/components/EmptyState';
import { timeIn } from '@/lib/format';
import { OUTCOME_MESSAGE, type AnomalyRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

const TONE: Record<string, string> = {
  rejected_no_match: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20',
  rejected_liveness: 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20',
  rejected_geofence: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20',
  rejected_duplicate: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20',
  rejected_quality: 'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-500/10 dark:text-slate-400 dark:ring-slate-400/20',
  rejected_not_enrolled: 'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-500/10 dark:text-slate-400 dark:ring-slate-400/20',
};

export default async function AnomaliesPage() {
  const { org } = await requireAdmin();
  const supabase = await createClient();

  const { data } = await supabase.from('v_anomalies').select('*').limit(200);
  const rows = (data ?? []) as AnomalyRow[];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Flagged attempts</h1>
        <p className="muted mt-0.5 text-sm">
          Every rejected check-in, newest first. Most are innocent — bad light, a moving phone,
          someone standing outside the geofence. Look for a pattern rather than a single row.
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Nothing flagged" body="No rejected check-in attempts have been recorded." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="muted border-b border-[var(--border)] text-left text-xs">
                <th scope="col" className="px-4 py-2.5 font-medium">When</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Who</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Reason</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Match</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Liveness</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Distance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2.5 whitespace-nowrap tabular-nums">
                    {r.local_day} {timeIn(org.timezone, r.occurred_at)}
                  </td>
                  <td className="px-4 py-2.5 font-medium">{r.full_name}</td>
                  <td className="px-4 py-2.5">
                    <span className={`pill ${TONE[r.outcome] ?? TONE.rejected_quality}`}>
                      {OUTCOME_MESSAGE[r.outcome]}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {r.similarity === null ? '—' : `${(r.similarity * 100).toFixed(0)}%`}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {r.liveness_score === null ? '—' : `${(r.liveness_score * 100).toFixed(0)}%`}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {r.distance_m === null ? '—' : `${Math.round(r.distance_m)} m`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
