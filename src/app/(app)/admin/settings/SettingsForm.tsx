'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { getLocation } from '@/lib/geo';
import type { OrgSettings, Organization } from '@/lib/types';

export default function SettingsForm({
  org,
  settings,
}: {
  org: Organization;
  settings: OrgSettings;
}) {
  const router = useRouter();
  const [form, setForm] = useState<OrgSettings>(settings);
  const [name, setName] = useState(org.name);
  const [timezone, setTimezone] = useState(org.timezone);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof OrgSettings>(key: K, value: OrgSettings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function useMyLocation() {
    const fix = await getLocation();
    if (!fix) {
      setError('Could not read your location. Check browser permissions.');
      return;
    }
    setForm((f) => ({ ...f, geofence_lat: fix.lat, geofence_lng: fix.lng }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = createClient();

    // org_id and updated_at are server-owned; sending them back would either be
    // rejected or clobber the timestamp the touch trigger maintains.
    const patch: Partial<OrgSettings> = { ...form };
    delete patch.org_id;
    delete patch.updated_at;

    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from('org_settings').update(patch).eq('org_id', org.id),
      supabase.from('organizations').update({ name, timezone }).eq('id', org.id),
    ]);

    if (e1 || e2) setError((e1 ?? e2)!.message);
    else {
      setSaved(true);
      router.refresh();
    }
    setBusy(false);
  }

  return (
    <form onSubmit={save} className="max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="muted mt-0.5 text-sm">
          These values are enforced in the database, not in the browser — changing them here changes
          what the server will accept.
        </p>
      </div>

      <Section title="Organization">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Timezone" hint="IANA name, e.g. Asia/Kolkata. Decides what counts as 'today'.">
          <input className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
      </Section>

      <Section title="Working hours">
        <Field label="Day starts">
          <input
            type="time"
            className="input"
            value={form.workday_start.slice(0, 5)}
            onChange={(e) => set('workday_start', `${e.target.value}:00`)}
          />
        </Field>
        <Field label="Day ends">
          <input
            type="time"
            className="input"
            value={form.workday_end.slice(0, 5)}
            onChange={(e) => set('workday_end', `${e.target.value}:00`)}
          />
        </Field>
        <Field label="Late grace (minutes)">
          <input
            type="number"
            className="input"
            min={0}
            max={240}
            value={form.late_grace_minutes}
            onChange={(e) => set('late_grace_minutes', Number(e.target.value))}
          />
        </Field>
        <Field label="Full day needs (minutes)">
          <input
            type="number"
            className="input"
            min={0}
            max={1440}
            value={form.full_day_min_minutes}
            onChange={(e) => set('full_day_min_minutes', Number(e.target.value))}
          />
        </Field>
      </Section>

      <Section title="Face matching">
        <Field
          label={`Match threshold — ${form.match_threshold.toFixed(2)}`}
          hint="Cosine similarity a capture must reach. Higher rejects more impostors and more legitimate users. 0.40–0.45 suits most teams."
          wide
        >
          <input
            type="range"
            min={0.2}
            max={0.9}
            step={0.01}
            value={form.match_threshold}
            onChange={(e) => set('match_threshold', Number(e.target.value))}
            className="w-full accent-brand-600"
          />
        </Field>

        <Field label="Liveness mode" hint="Active adds randomised prompts; passive only watches for micro-movement.">
          <select
            className="input"
            value={form.liveness_mode}
            onChange={(e) => set('liveness_mode', e.target.value as OrgSettings['liveness_mode'])}
          >
            <option value="active">Active — prompt the user</option>
            <option value="passive">Passive — silent checks only</option>
            <option value="off">Off</option>
          </select>
        </Field>

        <Field label={`Minimum liveness — ${form.min_liveness_score.toFixed(2)}`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={form.min_liveness_score}
            onChange={(e) => set('min_liveness_score', Number(e.target.value))}
            className="w-full accent-brand-600"
          />
        </Field>

        <Field label="Captures per person" hint="How many templates a person may enrol.">
          <input
            type="number"
            className="input"
            min={1}
            max={25}
            value={form.max_templates_per_user}
            onChange={(e) => set('max_templates_per_user', Number(e.target.value))}
          />
        </Field>
      </Section>

      <Section title="Location">
        <Field label="Require being on site" wide>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.geofence_enabled}
              onChange={(e) => set('geofence_enabled', e.target.checked)}
              className="h-4 w-4 accent-brand-600"
            />
            Reject check-ins outside the radius below
          </label>
        </Field>
        <Field label="Latitude">
          <input
            className="input"
            value={form.geofence_lat ?? ''}
            onChange={(e) => set('geofence_lat', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
        <Field label="Longitude">
          <input
            className="input"
            value={form.geofence_lng ?? ''}
            onChange={(e) => set('geofence_lng', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
        <Field label="Radius (metres)">
          <input
            type="number"
            className="input"
            min={20}
            max={20000}
            value={form.geofence_radius_m}
            onChange={(e) => set('geofence_radius_m', Number(e.target.value))}
          />
        </Field>
        <Field label=" ">
          <button type="button" className="btn-ghost w-full" onClick={useMyLocation}>
            Use my current location
          </button>
        </Field>
      </Section>

      <Section title="Privacy">
        <Field label="Store a photo with each check-in" wide hint="The photo is what lets you audit a disputed record. Without it you only have a score.">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.store_punch_photo}
              onChange={(e) => set('store_punch_photo', e.target.checked)}
              className="h-4 w-4 accent-brand-600"
            />
            Keep an aligned face crop per punch
          </label>
        </Field>
        <Field label="Delete photos after (days)">
          <input
            type="number"
            className="input"
            min={1}
            max={365}
            value={form.photo_retention_days}
            onChange={(e) => set('photo_retention_days', Number(e.target.value))}
          />
        </Field>
        <Field label="Pin each account to one device" wide>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.require_device_binding}
              onChange={(e) => set('require_device_binding', e.target.checked)}
              className="h-4 w-4 accent-brand-600"
            />
            First device used becomes the only allowed device
          </label>
        </Field>
        <Field label="Minimum gap between punches (seconds)">
          <input
            type="number"
            className="input"
            min={0}
            max={3600}
            value={form.min_punch_gap_seconds}
            onChange={(e) => set('min_punch_gap_seconds', Number(e.target.value))}
          />
        </Field>
      </Section>

      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span className="text-sm text-emerald-600 dark:text-emerald-400">Saved</span>}
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="muted mt-1 text-xs">{hint}</p>}
    </div>
  );
}
