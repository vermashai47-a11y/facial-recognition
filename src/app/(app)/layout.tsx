import AppShell from '@/components/AppShell';
import { requireSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireSession();
  return <AppShell profile={profile}>{children}</AppShell>;
}
