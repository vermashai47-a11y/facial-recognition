import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const { isManager } = await requireSession();
  redirect(isManager ? '/admin' : '/check-in');
}
