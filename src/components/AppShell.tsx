import Link from 'next/link';
import type { Profile } from '@/lib/types';

const EMPLOYEE_NAV = [
  { href: '/check-in', label: 'Check in' },
  { href: '/me', label: 'My attendance' },
  { href: '/enroll', label: 'My face' },
];

const ADMIN_NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/employees', label: 'People' },
  { href: '/admin/reports', label: 'Reports' },
  { href: '/admin/anomalies', label: 'Flags' },
  { href: '/admin/settings', label: 'Settings' },
];

export default function AppShell({
  profile,
  children,
}: {
  profile: Profile;
  children: React.ReactNode;
}) {
  const isAdmin = profile.role === 'owner' || profile.role === 'admin';
  const isManager = isAdmin || profile.role === 'manager';

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--surface)]/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-600 text-xs text-white">
              AT
            </span>
            Attendance
          </Link>

          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {EMPLOYEE_NAV.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="rounded-lg px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
              >
                {l.label}
              </Link>
            ))}
            {isManager &&
              ADMIN_NAV.filter((l) => isAdmin || l.href === '/admin' || l.href === '/admin/reports').map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="rounded-lg px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
                >
                  {l.label}
                </Link>
              ))}
          </nav>

          <div className="flex items-center gap-3">
            <span className="muted hidden text-sm sm:inline">{profile.full_name || profile.email}</span>
            <form action="/auth/signout" method="post">
              <button type="submit" className="btn-ghost px-3 py-1.5 text-sm">
                Sign out
              </button>
            </form>
          </div>
        </div>

        {/* Mobile nav: the primary surface for employees, who live on /check-in */}
        <nav className="flex gap-1 overflow-x-auto border-t border-[var(--border)] px-3 py-2 md:hidden" aria-label="Main">
          {[...EMPLOYEE_NAV, ...(isManager ? ADMIN_NAV : [])].map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/10"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
