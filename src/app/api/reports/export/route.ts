import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { toCsv } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Monthly CSV. Runs as the signed-in user, so RLS decides which rows come back:
 * a manager gets their organization, anyone else gets nothing.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse('Unauthorized', { status: 401 });

  const month = new URL(request.url).searchParams.get('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return new NextResponse('Pass ?month=YYYY-MM', { status: 400 });
  }

  const { data, error } = await supabase
    .from('v_monthly_summary')
    .select('*')
    .eq('month', `${month}-01`)
    .order('full_name');

  if (error) return new NextResponse(error.message, { status: 500 });
  if (!data || data.length === 0) return new NextResponse('No data for that month', { status: 404 });

  const csv = toCsv(
    data.map((r) => ({
      employee: r.full_name,
      code: r.employee_code ?? '',
      department: r.department ?? '',
      days_worked: r.days_worked,
      days_present: r.days_present,
      days_late: r.days_late,
      days_half: r.days_half,
      days_absent: r.days_absent,
      days_leave: r.days_leave,
      total_hours: ((r.total_minutes ?? 0) / 60).toFixed(2),
    })),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="attendance-${month}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
