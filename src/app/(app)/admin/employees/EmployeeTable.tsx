'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import type { Profile, UserRole, EmploymentStatus } from '@/lib/types';

const ROLES: UserRole[] = ['owner', 'admin', 'manager', 'employee'];
const STATUSES: EmploymentStatus[] = ['active', 'suspended', 'terminated'];

export default function EmployeeTable({
  me,
  people,
  enrolled,
}: {
  me: Profile;
  people: Profile[];
  enrolled: Record<string, number>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const filtered = people.filter((p) =>
    `${p.full_name} ${p.email} ${p.employee_code ?? ''} ${p.department ?? ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  async function patch(id: string, changes: Partial<Profile>) {
    setBusy(id);
    setError(null);
    const supabase = createClient();
    const { error: err } = await supabase.from('profiles').update(changes).eq('id', id);
    if (err) setError(err.message);
    else router.refresh();
    setBusy(null);
  }

  async function clearFace(id: string, name: string) {
    if (!confirm(`Delete ${name}'s enrolled face data? They will need to enrol again.`)) return;
    setBusy(id);
    const supabase = createClient();
    const { error: err } = await supabase.rpc('revoke_face_templates', { p_user: id });
    if (err) setError(err.message);
    else router.refresh();
    setBusy(null);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">People</h1>
          <p className="muted mt-0.5 text-sm">
            {people.length} accounts · new employees join by signing up with their work email
          </p>
        </div>
        <input
          className="input max-w-xs"
          placeholder="Search name, code or team"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search employees"
        />
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </p>
      )}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="muted border-b border-[var(--border)] text-left text-xs">
              <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Code</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Team</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Role</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Face</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const self = p.id === me.id;
              const count = enrolled[p.id] ?? 0;
              return (
                <tr key={p.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{p.full_name || '—'}</div>
                    <div className="muted text-xs">{p.email}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <input
                      className="input py-1 text-xs"
                      defaultValue={p.employee_code ?? ''}
                      onBlur={(e) =>
                        e.target.value !== (p.employee_code ?? '') &&
                        patch(p.id, { employee_code: e.target.value || null })
                      }
                      aria-label={`Employee code for ${p.full_name}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <input
                      className="input py-1 text-xs"
                      defaultValue={p.department ?? ''}
                      onBlur={(e) =>
                        e.target.value !== (p.department ?? '') &&
                        patch(p.id, { department: e.target.value || null })
                      }
                      aria-label={`Team for ${p.full_name}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <select
                      className="input py-1 text-xs"
                      value={p.role}
                      disabled={self || busy === p.id}
                      onChange={(e) => patch(p.id, { role: e.target.value as UserRole })}
                      aria-label={`Role for ${p.full_name}`}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2.5">
                    <select
                      className="input py-1 text-xs"
                      value={p.status}
                      disabled={self || busy === p.id}
                      onChange={(e) => patch(p.id, { status: e.target.value as EmploymentStatus })}
                      aria-label={`Status for ${p.full_name}`}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {count > 0 ? (
                      <button
                        type="button"
                        className="muted text-xs underline underline-offset-4"
                        onClick={() => clearFace(p.id, p.full_name || p.email)}
                        disabled={busy === p.id}
                      >
                        {count} template{count === 1 ? '' : 's'} · reset
                      </button>
                    ) : (
                      <span className="muted text-xs">not enrolled</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="muted text-xs">
        You cannot change your own role or status — that prevents an organization locking itself out.
      </p>
    </div>
  );
}
