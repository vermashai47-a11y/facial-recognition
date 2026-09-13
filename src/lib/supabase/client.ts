'use client';

import { createBrowserClient } from '@supabase/ssr';
import { supabaseConfig } from '@/lib/env';
import type { Database } from '@/lib/types';

export function createClient() {
  const config = supabaseConfig();

  // Supabase's own error for this is "supabaseUrl is required", which sends
  // people looking for a bug in the code rather than at their host config.
  if (!config) {
    throw new Error(
      'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and either ' +
        'NEXT_PUBLIC_SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. ' +
        'Open /setup for details.',
    );
  }

  return createBrowserClient<Database>(config.url, config.key);
}
