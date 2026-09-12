import Link from 'next/link';
import { requireManager } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import StatTile from '@/components/StatTile';
import StatusPill from '@/components/StatusPill';
import AttendanceChart, { type DayBreakdown } from '@/components/AttendanceChart';
import { minutesToHours, timeIn } from '@/lib/format';
import type { AttendanceDay, TodayBoardRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function AdminDashboard() {
  const { org } = await requireManager();
  const supabase = await createClient();

  const today = new Date().toLocaleDateString('en-CA', { timeZone: org.timezone });
  const since = new Date();
  since.setDate(since.getDate() - 13);
  const sinceIso = since.toLocaleDateString('en-CA', { timeZone: org.timezone });

  const [{ data: board }, { data: history }, { count: flags }] = await Promise.all([
    supabase.from('v_today_board').select('*').order('full_name'),
    supabase
      .from('attendance_days')
      .select('local_day,status')
      .gte('local_day', sinceIso)
      .lte('local_day', today),
    supabase
      .from('v_anomalies')
      .select('id', { count: 'exact', head: true })
      .gte('local_day', sinceIso),
  ]);

  const rows = (board ?? []) as TodayBoardRow[];
  const present = rows.filter((r) => ['present', 'late', 'half_day'].includes(r.status));
  const inNow = rows.filter((r) => r.currently_in);
  const notEnrolled = rows.filter((r) => !r.enrolled);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{org.name}</h1>
          <p className="muted mt-0.5 text-sm">
            {new Date().toLocaleDateString('en-GB', {
              timeZone: org.timezone,
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
        </div>
        <Link href="/admin/reports" className="btn-ghost">
          Reports
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label="Headcount" value={rows.length} />
        <StatTile
          label="Marked today"
          value={present.length}
          hint={rows.length ? `${Math.round((present.length / rows.length) * 100)}% of the team` : undefined}
          tone="good"
        />
        <StatTile label="On site now" value={inNow.length} />
        <StatTile
          label="Not enrolled"
          value={notEnrolled.length}
          tone={notEnrolled.length > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Flagged attempts"
          value={flags ?? 0}
          hint="Last 14 days"
          tone={(flags ?? 0) > 0 ? 'critical' : 'neutral'}
        />
      </div>

      <AttendanceChart data={buildSeries((history ?? []) as Pick<AttendanceDay, 'local_day' | 'status'>[], sinceIso, today)} />

      <section className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="text-sm font-semibold">Today</h2>
          <Link href="/admin/employees" className="muted text-xs underline underline-offset-4">
            Manage people
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="muted border-b border-[var(--border)] text-left text-xs">
                <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                <th scope="col" className="px-4 py-2.5 font-medium">In</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Out</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Worked</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{r.full_name}</span>
                    {r.employee_code && <span className="muted ml-2 text-xs">{r.employee_code}</span>}
                    {!r.enrolled && (
                      <span className="pill ml-2 bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20">
                        not enrolled
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{timeIn(org.timezone, r.first_in)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{timeIn(org.timezone, r.last_out)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{minutesToHours(r.worked_minutes)}</td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={r.status} />
                    {r.currently_in && <span className="muted ml-2 text-xs">on site</span>}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted px-4 py-8 text-center text-sm">
                    No active employees yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** Buckets 14 days of daily rows into the chart's present/late/absent series. */
function buildSeries(
  rows: Pick<AttendanceDay, 'local_day' | 'status'>[],
  from: string,
  to: string,
): DayBreakdown[] {
  const byDay = new Map<string, DayBreakdown>();

  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, { day: key, present: 0, late: 0, absent: 0 });
  }

  for (const r of rows) {
    const bucket = byDay.get(r.local_day);
    if (!bucket) continue;
    if (r.status === 'present' || r.status === 'half_day') bucket.present++;
    else if (r.status === 'late') bucket.late++;
    else if (r.status === 'absent') bucket.absent++;
  }

  return [...byDay.values()];
}
