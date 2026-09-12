'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import FaceCapture from '@/components/FaceCapture';
import { createClient } from '@/lib/supabase/client';
import type { CaptureResult } from '@/lib/face/pipeline';
import type { FaceTemplateMeta, OrgSettings, Profile } from '@/lib/types';

const ANGLES = [
  'Look straight ahead',
  'Turn your head slightly left',
  'Turn your head slightly right',
] as const;

export default function EnrollClient({
  profile,
  settings,
  templates,
}: {
  profile: Profile;
  settings: OrgSettings;
  templates: FaceTemplateMeta[];
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(templates.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const target = Math.min(ANGLES.length, settings.max_templates_per_user);

  const handleCapture = useCallback(
    async (capture: CaptureResult) => {
      setBusy(true);
      setError(null);
      try {
        const supabase = createClient();
        const { error: rpcError } = await supabase.rpc('enroll_face', {
          p_embedding: Array.from(capture.embedding),
          p_quality: capture.quality,
          p_target: null,
        });
        if (rpcError) throw new Error(rpcError.message);

        const next = saved + 1;
        setSaved(next);
        if (next >= target) {
          setDone(true);
          router.refresh();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Enrolment failed');
      } finally {
        setBusy(false);
      }
    },
    [router, saved, target],
  );

  const reset = useCallback(async () => {
    if (!confirm('Delete all your enrolled face data? You will need to enrol again.')) return;
    setBusy(true);
    try {
      const supabase = createClient();
      const { error: rpcError } = await supabase.rpc('revoke_face_templates', {
        p_user: profile.id,
      });
      if (rpcError) throw new Error(rpcError.message);
      setSaved(0);
      setDone(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not clear your face data');
    } finally {
      setBusy(false);
    }
  }, [profile.id, router]);

  return (
    <div className="mx-auto max-w-md space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Your face</h1>
        <p className="muted mt-0.5 text-sm">
          {saved === 0
            ? 'Register three short captures so the system can recognise you.'
            : `${saved} of ${target} captures registered.`}
        </p>
      </div>

      <div className="card space-y-2 p-4 text-sm">
        <p className="font-medium">What gets stored</p>
        <p className="muted">
          Not a photograph — a list of 512 numbers that describes the geometry of your face. It
          cannot be turned back into a picture of you, and no one at your organization can read it
          directly. You can delete it at any time with the button below.
        </p>
      </div>

      {done || saved >= target ? (
        <div className="card space-y-3 p-5 text-center">
          <div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z"
                clipRule="evenodd"
              />
            </svg>
          </div>
          <p className="font-medium">You are enrolled</p>
          <p className="muted text-sm">You can now check in from the attendance page.</p>
          <div className="flex justify-center gap-2 pt-1">
            <a href="/check-in" className="btn-primary">
              Go to check in
            </a>
            <button type="button" className="btn-ghost" onClick={reset} disabled={busy}>
              Delete my face data
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="card px-4 py-3">
            <p className="text-sm font-medium">Step {saved + 1} of {target}</p>
            <p className="muted text-sm">{ANGLES[Math.min(saved, ANGLES.length - 1)]}</p>
          </div>

          {error && (
            <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:bg-rose-500/10 dark:text-rose-300">
              {error}
            </p>
          )}

          <FaceCapture
            mode="enroll"
            livenessMode="passive"
            actionLabel={`Capture ${saved + 1} of ${target}`}
            busy={busy}
            onCapture={handleCapture}
          />

          {saved > 0 && (
            <button type="button" className="btn-ghost w-full" onClick={reset} disabled={busy}>
              Start over
            </button>
          )}
        </>
      )}
    </div>
  );
}
