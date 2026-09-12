import { requireSession } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import CheckInClient from './CheckInClient';

export const dynamic = 'force-dynamic';

export default async function CheckInPage() {
  const { userId, profile, org, settings } = await requireSession();
  const supabase = await createClient();

  const today = new Date().toLocaleDateString('en-CA', { timeZone: org.timezone });

  const [{ data: day }, { count: templateCount }] = await Promise.all([
    supabase
      .from('attendance_days')
      .select('*')
      .eq('user_id', userId)
      .eq('local_day', today)
      .maybeSingle(),
    supabase
      .from('face_template_meta')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('revoked_at', null),
  ]);

  return (
    <CheckInClient
      profile={profile}
      timezone={org.timezone}
      settings={settings}
      today={today}
      initialDay={day ?? null}
      enrolled={(templateCount ?? 0) > 0}
    />
  );
}
