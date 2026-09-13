import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseConfig } from '@/lib/env';

const PUBLIC_PATHS = [
  '/login',
  '/auth',
  '/setup',
  '/_next',
  '/models',
  '/ort',
  '/favicon.ico',
  '/manifest.webmanifest',
];

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Without this guard, createServerClient() throws on a missing URL or key —
  // and because this runs on every request, one unset variable turns the whole
  // site into an opaque 500. Sending traffic to /setup instead means the
  // deployment can explain what is wrong with it.
  const config = supabaseConfig();
  if (!config) {
    if (pathname === '/setup' || pathname.startsWith('/_next') || pathname.startsWith('/ort')) {
      return NextResponse.next({ request });
    }
    const url = request.nextUrl.clone();
    url.pathname = '/setup';
    url.search = '';
    return NextResponse.rewrite(url);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    config.url,
    config.key,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser() revalidates the JWT against Supabase; getSession() would trust
  // whatever is in the cookie, which is not safe to gate routes on.
  //
  // Wrapped because a network failure or a wrong-project key surfaces here, and
  // a thrown error would again mean a site-wide 500 rather than a login page.
  let user = null;
  try {
    const result = await supabase.auth.getUser();
    user = result.data.user;
  } catch {
    user = null;
  }

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return response;
}
