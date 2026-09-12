'use client';

/**
 * A stable-ish per-device identifier.
 *
 * This is deliberately *not* a fingerprinting library. It is a random id minted
 * once and kept in localStorage, hashed before it leaves the browser. It stops
 * the same account being punched from two phones at once when device binding is
 * enabled; it does not attempt to survive a cleared browser, and it collects
 * nothing about the user.
 */

const KEY = 'fa.device.id';

export async function getDeviceHash(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  let id: string | null = null;
  try {
    id = window.localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(KEY, id);
    }
  } catch {
    return null; // private mode, storage blocked — device binding simply won't apply
  }

  const bytes = new TextEncoder().encode(`${id}:face-attendance`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}
