'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import FaceCapture from '@/components/FaceCapture';
import StatusPill from '@/components/StatusPill';
import EmptyState from '@/components/EmptyState';
import { createClient } from '@/lib/supabase/client';
import { getLocation } from '@/lib/geo';
import { getDeviceHash } from '@/lib/device';
import { minutesToHours, timeIn } from '@/lib/format';
import {
  OUTCOME_MESSAGE,
  type AttendanceDay,
  type OrgSettings,
  type Profile,
  type PunchResult,
} from '@/lib/types';
import type { CaptureResult } from '@/lib/face/pipeline';

interface Props {
  profile: Profile;
  timezone: string;
  settings: OrgSettings;
  today: string;
  initialDay: AttendanceDay | null;
  enrolled: boolean;
}

export default function CheckInClient({
  profile,
  timezone,
  settings,
  today,
  initialDay,
  enrolled,
}: Props) {
  const router = useRouter();
  const [day, setDay] = useState(initialDay);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PunchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nextKind = useMemo(
    () => (day?.first_in && !day?.last_out ? 'check_out' : 'check_in'),
    [day],
  );

  const handleCapture = useCallback(
    async (capture: CaptureResult) => {
      setBusy(true);
      setError(null);
      setResult(null);

      try {
        const supabase = createClient();

        // Location and device id are gathered in parallel with nothing blocking
        // on them; if the user declines, the server decides what that means.
        const [fix, deviceHash] = await Promise.all([
          settings.geofence_enabled ? getLocation() : Promise.resolve(null),
          getDeviceHash(),
        ]);

        let photoPath: string | null = null;
        if (settings.store_punch_photo && capture.snapshot) {
          photoPath = await uploadSnapshot(
            supabase,
            profile.org_id,
            profile.id,
            today,
            capture.snapshot,
          );
        }

        const { data, error: rpcError } = await supabase.rpc('record_punch', {
          p_embedding: Array.from(capture.embedding),
          p_liveness: capture.liveness,
          p_quality: capture.quality,
          p_kind: null, // let the server infer in vs out
          p_lat: fix?.lat ?? null,
          p_lng: fix?.lng ?? null,
          p_accuracy_m: fix?.accuracy ?? null,
          p_device_hash: deviceHash,
          p_photo_path: photoPath,
          p_user_agent: navigator.userAgent,
        });

        if (rpcError) throw new Error(rpcError.message);

        const punch = data as unknown as PunchResult;
        setResult(punch);

        if (punch.ok) {
          const { data: fresh } = await supabase
            .from('attendance_days')
            .select('*')
            .eq('user_id', profile.id)
            .eq('local_day', today)
            .maybeSingle();
          setDay((fresh as AttendanceDay) ?? null);
          router.refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not record attendance');
      } finally {
        setBusy(false);
      }
    },
    [profile.id, profile.org_id, router, settings.geofence_enabled, settings.store_punch_photo, today],
  );

  if (!enrolled) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="Register your face first"
          body="You need to enrol before you can mark attendance. It takes about thirty seconds and only has to be done once."
          action={
            <Link href="/enroll" className="btn-primary">
              Start enrolment
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {nextKind === 'check_in' ? 'Check in' : 'Check out'}
        </h1>
        <p className="muted mt-0.5 text-sm">
          {profile.full_name || profile.email} · {today}
        </p>
      </div>

      <div className="card grid grid-cols-3 divide-x divide-[var(--border)] text-center">
        <div className="px-3 py-3">
          <p className="muted text-xs">In</p>
          <p className="mt-0.5 font-medium tabular-nums">{timeIn(timezone, day?.first_in)}</p>
        </div>
        <div className="px-3 py-3">
          <p className="muted text-xs">Out</p>
          <p className="mt-0.5 font-medium tabular-nums">{timeIn(timezone, day?.last_out)}</p>
        </div>
        <div className="px-3 py-3">
          <p className="muted text-xs">Worked</p>
          <p className="mt-0.5 font-medium tabular-nums">{minutesToHours(day?.worked_minutes)}</p>
        </div>
      </div>

      {result && (
        <div
          role="status"
          className={`rounded-xl px-4 py-3 text-sm ${
            result.ok
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300'
          }`}
        >
          <p className="font-medium">
            {result.ok
              ? `${result.kind === 'check_in' ? 'Checked in' : 'Checked out'} at ${timeIn(timezone, result.occurred_at)}`
              : OUTCOME_MESSAGE[result.outcome]}
          </p>
          <p className="mt-0.5 opacity-80">
            Face match {(result.similarity * 100).toFixed(1)}% (needs{' '}
            {(result.threshold * 100).toFixed(0)}%)
            {result.distance_m !== null && ` · ${Math.round(result.distance_m)} m from the office`}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </p>
      )}

      <FaceCapture
        mode="verify"
        livenessMode={settings.liveness_mode}
        actionLabel={nextKind === 'check_in' ? 'Check in' : 'Check out'}
        busy={busy}
        onCapture={handleCapture}
      />

      {day?.status && (
        <p className="text-center text-sm">
          Today: <StatusPill status={day.status} />
        </p>
      )}
    </div>
  );
}

/** Stores the aligned crop under {org}/{user}/{day}/ so storage RLS can key off the path. */
async function uploadSnapshot(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  userId: string,
  day: string,
  dataUrl: string,
): Promise<string | null> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${orgId}/${userId}/${day}/${crypto.randomUUID()}.jpg`;
    const { error } = await supabase.storage
      .from('punch-photos')
      .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    return error ? null : path;
  } catch {
    // A failed photo upload must never block a valid check-in.
    return null;
  }
}
