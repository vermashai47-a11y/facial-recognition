import { redirect } from 'next/navigation';
import { createClient } from './supabase/server';
import type { OrgSettings, Organization, Profile } from './types';

export interface SessionContext {
  userId: string;
  profile: Profile;
  org: Organization;
  settings: OrgSettings;
  isAdmin: boolean;
  isManager: boolean;
}

/**
 * Loads everything a page needs about the signed-in user in one round trip.
 * Redirects rather than throwing, so pages can treat the result as always valid.
 */
export async function requireSession(): Promise<SessionContext> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (!profile) {
    // The auth user exists but the profile trigger has not run (or the org was
    // deleted). Signing out is the only way back to a consistent state.
    redirect('/auth/signout');
  }

  const [{ data: org }, { data: settings }] = await Promise.all([
    supabase.from('organizations').select('*').eq('id', profile.org_id).single(),
    supabase.from('org_settings').select('*').eq('org_id', profile.org_id).single(),
  ]);

  if (!org || !settings) redirect('/login');

  return {
    userId: user.id,
    profile: profile as Profile,
    org: org as Organization,
    settings: settings as OrgSettings,
    isAdmin: profile.role === 'owner' || profile.role === 'admin',
    isManager: ['owner', 'admin', 'manager'].includes(profile.role),
  };
}

export async function requireAdmin(): Promise<SessionContext> {
  const ctx = await requireSession();
  if (!ctx.isAdmin) redirect('/check-in');
  return ctx;
}

export async function requireManager(): Promise<SessionContext> {
  const ctx = await requireSession();
  if (!ctx.isManager) redirect('/check-in');
  return ctx;
}
