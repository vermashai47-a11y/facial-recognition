import { requireSession } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import StatusPill from '@/components/StatusPill';
import StatTile from '@/components/StatTile';
import EmptyState from '@/components/EmptyState';
import { dayLabel, minutesToHours, timeIn } from '@/lib/format';
import type { AttendanceDay } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function MyAttendancePage() {
  const { userId, org } = await requireSession();
  const supabase = await createClient();

  const since = new Date();
  since.setDate(since.getDate() - 45);

  const { data } = await supabase
    .from('attendance_days')
    .select('*')
    .eq('user_id', userId)
    .gte('local_day', since.toISOString().slice(0, 10))
    .order('local_day', { ascending: false });

  const days = (data ?? []) as AttendanceDay[];
  const worked = days.filter((d) => ['present', 'late', 'half_day'].includes(d.status));
  const totalMinutes = days.reduce((a, d) => a + d.worked_minutes, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">My attendance</h1>
        <p className="muted mt-0.5 text-sm">Last 45 days</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Days worked" value={worked.length} />
        <StatTile label="On time" value={days.filter((d) => d.status === 'present').length} tone="good" />
        <StatTile label="Late" value={days.filter((d) => d.status === 'late').length} tone="warning" />
        <StatTile label="Total hours" value={minutesToHours(totalMinutes)} />
      </div>

      {days.length === 0 ? (
        <EmptyState title="No attendance yet" body="Your check-ins will appear here once you start marking attendance." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="muted border-b border-[var(--border)] text-left text-xs">
                <th scope="col" className="px-4 py-2.5 font-medium">Day</th>
                <th scope="col" className="px-4 py-2.5 font-medium">In</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Out</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Worked</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2.5">{dayLabel(d.local_day)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{timeIn(org.timezone, d.first_in)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{timeIn(org.timezone, d.last_out)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{minutesToHours(d.worked_minutes)}</td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={d.status} />
                    {d.manually_edited && <span className="muted ml-2 text-xs">edited</span>}
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
