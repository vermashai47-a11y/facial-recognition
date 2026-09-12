import { requireSession } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import EnrollClient from './EnrollClient';
import type { FaceTemplateMeta } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function EnrollPage() {
  const { userId, profile, settings } = await requireSession();
  const supabase = await createClient();

  const { data: templates } = await supabase
    .from('face_template_meta')
    .select('*')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false });

  return (
    <EnrollClient
      profile={profile}
      settings={settings}
      templates={(templates ?? []) as FaceTemplateMeta[]}
    />
  );
}
