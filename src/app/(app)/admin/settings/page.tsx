import { requireAdmin } from '@/lib/session';
import SettingsForm from './SettingsForm';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { org, settings } = await requireAdmin();
  return <SettingsForm org={org} settings={settings} />;
}
