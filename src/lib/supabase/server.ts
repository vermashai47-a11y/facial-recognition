import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { supabaseConfig } from '@/lib/env';
import type { Database } from '@/lib/types';

/**
 * Request-scoped Supabase client. Every query it makes runs as the signed-in
 * user, so RLS is what enforces access — the app never has to remember to add
 * `where org_id = ...` by hand.
 */
export async function createClient() {
  const cookieStore = await cookies();

  const config = supabaseConfig();
  if (!config) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and either ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. ' +
        'Open /setup for details.',
    );
  }

  return createServerClient<Database>(
    config.url,
    config.key,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // The middleware refreshes the session instead, so this is benign.
          }
        },
      },
    },
  );
}

/**
 * Service-role client. Bypasses RLS entirely, so it is confined to the cron
 * route and never imported into anything that renders.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');

  return createServerClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    cookies: { getAll: () => [], setAll: () => {} },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
