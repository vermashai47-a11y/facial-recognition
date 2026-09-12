import type { NextRequest } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

// Next 16 renamed the `middleware` convention to `proxy`; the behaviour is the
// same — this runs at the edge on every matched request to refresh the Supabase
// session cookie and gate unauthenticated access.

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and the model files, which are large and
    // must not pay for a session round-trip.
    '/((?!_next/static|_next/image|models|ort|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|onnx|task|wasm)$).*)',
  ],
};
