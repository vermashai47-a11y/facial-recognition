import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Nightly housekeeping, wired to vercel.json's cron entry.
 *
 * Two jobs:
 *   1. Mark absent anyone with no punch on a working day, so reports are
 *      complete without waiting for someone to open the dashboard.
 *   2. Delete punch photos past their retention window.
 *
 * Authenticated with CRON_SECRET rather than a user session, because Vercel's
 * scheduler has no cookie. On Hobby, crons fire approximately, not exactly.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');

  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const supabase = createAdminClient();
  const { data: purged, error: purgeError } = await supabase.rpc('purge_expired_photos');

  if (purgeError) {
    return NextResponse.json({ ok: false, error: purgeError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, photosPurged: purged ?? 0, at: new Date().toISOString() });
}
