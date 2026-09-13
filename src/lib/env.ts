/**
 * Environment resolution and validation.
 *
 * Two Supabase key formats are in circulation, and this app accepts both:
 *
 *   NEXT_PUBLIC_SUPABASE_ANON_KEY          the legacy anon JWT ("eyJ...")
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY   the newer publishable key ("sb_publishable_...")
 *
 * The second matters because Vercel's official Supabase integration provisions
 * that name, not the first — so a project wired up through the integration
 * would otherwise come up with no key at all and 500 on every request.
 *
 * The reads below are written out in full (`process.env.NEXT_PUBLIC_...`)
 * rather than destructured, because Next substitutes these at build time by
 * matching the literal text. `const { NEXT_PUBLIC_SUPABASE_URL } = process.env`
 * silently yields undefined in a client bundle.
 */

export interface EnvVarStatus {
  name: string;
  present: boolean;
  /** Never the value itself — only enough to spot a truncated or swapped paste. */
  hint: string;
  problem: string | null;
}

function rawUrl(): string | undefined {
  return process.env.NEXT_PUBLIC_SUPABASE_URL;
}

function rawKey(): { value: string | undefined; source: string } {
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (anon) return { value: anon, source: 'NEXT_PUBLIC_SUPABASE_ANON_KEY' };

  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (publishable) return { value: publishable, source: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY' };

  return { value: undefined, source: 'NEXT_PUBLIC_SUPABASE_ANON_KEY' };
}

/** The resolved pair the Supabase clients are built from. */
export function supabaseConfig(): { url: string; key: string } | null {
  const url = rawUrl()?.trim();
  const key = rawKey().value?.trim();
  return url && key ? { url, key } : null;
}

/** Cheap check for the hot path — the proxy runs on every request. */
export function supabaseEnvConfigured(): boolean {
  return supabaseConfig() !== null;
}

function describeUrl(): EnvVarStatus {
  const name = 'NEXT_PUBLIC_SUPABASE_URL';
  const raw = rawUrl();

  if (!raw) {
    return { name, present: false, hint: '—', problem: 'Not set for this deployment.' };
  }

  const trimmed = raw.trim();
  let problem: string | null = null;

  if (trimmed !== raw) {
    problem = 'Has leading or trailing whitespace — re-paste it without the stray space or newline.';
  } else if (!/^https:\/\//.test(trimmed)) {
    problem = 'Must start with https://';
  } else if (trimmed.endsWith('/')) {
    problem = 'Remove the trailing slash.';
  } else if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/.test(trimmed)) {
    problem = 'Does not look like a Supabase project URL (expected https://<ref>.supabase.co).';
  }

  return { name, present: true, hint: trimmed, problem };
}

function describeKey(): EnvVarStatus {
  const { value: raw, source } = rawKey();
  const name = source;

  if (!raw) {
    return {
      name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      present: false,
      hint: '—',
      problem:
        'Not set. Either this name, or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, must be present. ' +
        'Note that the Vercel Supabase integration provisions SUPABASE_ANON_KEY without the ' +
        'NEXT_PUBLIC_ prefix, which the browser cannot read.',
    };
  }

  const trimmed = raw.trim();
  let problem: string | null = null;

  if (trimmed !== raw) {
    problem = 'Has leading or trailing whitespace — re-paste it.';
  } else if (trimmed.startsWith('sb_secret_')) {
    problem = 'This is a SECRET key. It bypasses row level security and must never be public.';
  } else if (trimmed.startsWith('sb_publishable_')) {
    problem = null; // new-style publishable key, safe in a browser
  } else if (trimmed.startsWith('eyJ')) {
    // The role lives in the JWT payload, so a service_role key pasted here is
    // detectable — and worth catching loudly, since it would be public.
    try {
      const payload = JSON.parse(atob(trimmed.split('.')[1]));
      if (payload.role === 'service_role') {
        problem =
          'This is the SERVICE ROLE key. It bypasses row level security and must never be public. Replace it with the anon key.';
      } else if (payload.role !== 'anon') {
        problem = `Unexpected role "${payload.role}" — expected "anon".`;
      }
    } catch {
      problem = 'Could not decode this as a JWT — it may be truncated.';
    }
  } else {
    problem = 'Unrecognised key format (expected "eyJ..." or "sb_publishable_...").';
  }

  return {
    name,
    present: true,
    hint: `${trimmed.slice(0, 12)}…${trimmed.slice(-6)} (${trimmed.length} chars)`,
    problem,
  };
}

export interface EnvReport {
  ok: boolean;
  vars: EnvVarStatus[];
}

export function checkSupabaseEnv(): EnvReport {
  const vars = [describeUrl(), describeKey()];
  return { ok: vars.every((v) => v.present && v.problem === null), vars };
}
