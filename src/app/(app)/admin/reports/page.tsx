import Link from 'next/link';
import { requireManager } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import StatTile from '@/components/StatTile';
import EmptyState from '@/components/EmptyState';
import { minutesToHours } from '@/lib/format';
import type { MonthlySummaryRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { org } = await requireManager();
  const supabase = await createClient();
  const params = await searchParams;

  const month = params.month ?? new Date().toLocaleDateString('en-CA', { timeZone: org.timezone }).slice(0, 7);
  const monthStart = `${month}-01`;

  const { data } = await supabase
    .from('v_monthly_summary')
    .select('*')
    .eq('month', monthStart)
    .order('full_name');

  const rows = (data ?? []) as MonthlySummaryRow[];
  const totalMinutes = rows.reduce((a, r) => a + (r.total_minutes ?? 0), 0);
  const totalLate = rows.reduce((a, r) => a + r.days_late, 0);
  const totalAbsent = rows.reduce((a, r) => a + r.days_absent, 0);

  const months = lastMonths(6, org.timezone);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Monthly report</h1>
          <p className="muted mt-0.5 text-sm">{formatMonth(monthStart)}</p>
        </div>
        <div className="flex items-center gap-2">
          <nav className="flex flex-wrap gap-1" aria-label="Select month">
            {months.map((m) => (
              <Link
                key={m}
                href={`/admin/reports?month=${m}`}
                className={`rounded-lg px-2.5 py-1.5 text-xs ${
                  m === month
                    ? 'bg-brand-600 text-white'
                    : 'hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                {formatMonth(`${m}-01`, true)}
              </Link>
            ))}
          </nav>
          <a href={`/api/reports/export?month=${month}`} className="btn-ghost text-sm" download>
            Export CSV
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Employees" value={rows.length} />
        <StatTile label="Total hours" value={minutesToHours(totalMinutes)} />
        <StatTile label="Late days" value={totalLate} tone={totalLate > 0 ? 'warning' : 'neutral'} />
        <StatTile label="Absent days" value={totalAbsent} tone={totalAbsent > 0 ? 'critical' : 'neutral'} />
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Nothing recorded for this month" body="Attendance rows appear here as soon as people start checking in." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="muted border-b border-[var(--border)] text-left text-xs">
                <th scope="col" className="px-4 py-2.5 font-medium">Employee</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Worked</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">On time</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Late</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Half</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Absent</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Leave</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Hours</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((r) => (
                <tr key={r.user_id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{r.full_name}</span>
                    {r.department && <span className="muted ml-2 text-xs">{r.department}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">{r.days_worked}</td>
                  <td className="px-4 py-2.5 text-right">{r.days_present}</td>
                  <td className="px-4 py-2.5 text-right">{r.days_late}</td>
                  <td className="px-4 py-2.5 text-right">{r.days_half}</td>
                  <td className="px-4 py-2.5 text-right">{r.days_absent}</td>
                  <td className="px-4 py-2.5 text-right">{r.days_leave}</td>
                  <td className="px-4 py-2.5 text-right">{minutesToHours(r.total_minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function lastMonths(n: number, tz: string): string[] {
  const out: string[] = [];
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function formatMonth(iso: string, short = false): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', {
    month: short ? 'short' : 'long',
    year: 'numeric',
  });
}
