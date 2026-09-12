import { requireAdmin } from '@/lib/session';
import { createClient } from '@/lib/supabase/server';
import EmployeeTable from './EmployeeTable';
import type { Profile } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function EmployeesPage() {
  const { profile } = await requireAdmin();
  const supabase = await createClient();

  const { data: people } = await supabase
    .from('profiles')
    .select('*')
    .order('full_name');

  const { data: templates } = await supabase
    .from('face_template_meta')
    .select('user_id')
    .is('revoked_at', null);

  const enrolledCount = new Map<string, number>();
  for (const t of templates ?? []) {
    enrolledCount.set(t.user_id, (enrolledCount.get(t.user_id) ?? 0) + 1);
  }

  return (
    <EmployeeTable
      me={profile}
      people={(people ?? []) as Profile[]}
      enrolled={Object.fromEntries(enrolledCount)}
    />
  );
}
