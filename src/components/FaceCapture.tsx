'use client';

/**
 * The camera surface shared by enrolment and check-in.
 *
 * Responsibilities are deliberately narrow: show the preview, run the capture
 * engine, render guidance, and hand the caller a finished CaptureResult. It
 * knows nothing about attendance rules — those live in the database.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FaceCaptureEngine,
  openCamera,
  closeCamera,
  type CaptureFrameState,
  type CaptureResult,
} from '@/lib/face/pipeline';
import type { LivenessMode } from '@/lib/face/liveness';

export interface FaceCaptureProps {
  mode: 'enroll' | 'verify';
  livenessMode?: LivenessMode;
  targetSamples?: number;
  actionLabel: string;
  busy?: boolean;
  onCapture: (result: CaptureResult) => void | Promise<void>;
}

type Phase = 'idle' | 'loading' | 'ready' | 'capturing' | 'error';

export default function FaceCapture({
  mode,
  livenessMode,
  targetSamples,
  actionLabel,
  busy = false,
  onCapture,
}: FaceCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<FaceCaptureEngine | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<CaptureFrameState | null>(null);
  const [captured, setCaptured] = useState(0);

  const teardown = useCallback(() => {
    engineRef.current?.stop();
    engineRef.current = null;
    closeCamera(streamRef.current);
    streamRef.current = null;
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      // Models first: asking for the camera before the model is ready leaves a
      // live preview sitting idle for a couple of seconds, which reads as a bug.
      await FaceCaptureEngine.preload();

      const stream = await openCamera(true);
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) throw new Error('Camera surface is not mounted');
      video.srcObject = stream;
      await video.play();

      const engine = new FaceCaptureEngine({
        video,
        mode,
        livenessMode,
        targetSamples,
        onFrame: (state) => {
          setFrame(state);
          setCaptured(engine.progress.samples);
        },
      });
      engineRef.current = engine;
      await engine.start();
      setPhase('ready');
    } catch (err) {
      teardown();
      setPhase('error');
      setError(messageFor(err));
    }
  }, [mode, livenessMode, targetSamples, teardown]);

  const run = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    setPhase('capturing');
    setError(null);
    engine.reset();
    try {
      const result = await engine.capture();
      await onCapture(result);
      setPhase('ready');
    } catch (err) {
      setPhase('ready');
      setError(messageFor(err));
    }
  }, [onCapture]);

  const total = targetSamples ?? (mode === 'enroll' ? 5 : 3);
  const hint = frame?.hint ?? 'Camera off';
  const ringTone = frame?.multipleFaces
    ? 'ring-rose-500'
    : frame?.ready
      ? 'ring-emerald-500'
      : frame?.quality?.ok
        ? 'ring-brand-500'
        : 'ring-white/25';

  return (
    <div className="space-y-4">
      <div
        className={`relative aspect-[3/4] w-full overflow-hidden rounded-2xl bg-slate-900 ring-4 transition-colors ${ringTone}`}
      >
        <video
          ref={videoRef}
          className="mirror h-full w-full object-cover"
          playsInline
          muted
          // autoPlay is intentionally omitted: play() is called explicitly after
          // the stream is attached, which iOS handles far more reliably.
        />

        {phase === 'idle' && (
          <div className="absolute inset-0 grid place-items-center bg-slate-900/90 px-6 text-center">
            <div>
              <p className="text-sm text-white/80">
                {mode === 'enroll'
                  ? 'We will take a few photos to register your face.'
                  : 'Look at the camera to mark your attendance.'}
              </p>
              <button type="button" className="btn-primary mt-4" onClick={start}>
                Turn on camera
              </button>
            </div>
          </div>
        )}

        {phase === 'loading' && (
          <div className="absolute inset-0 grid place-items-center bg-slate-900/90 px-6 text-center">
            <div className="space-y-3">
              <div
                className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white"
                role="status"
                aria-label="Loading face recognition models"
              />
              <p className="text-sm text-white/70">Loading models (first time only, ~17 MB)…</p>
            </div>
          </div>
        )}

        {(phase === 'ready' || phase === 'capturing') && (
          <>
            {/* Face guide oval */}
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox="0 0 300 400"
              preserveAspectRatio="xMidYMid slice"
              aria-hidden="true"
            >
              <ellipse
                cx="150"
                cy="180"
                rx="96"
                ry="126"
                fill="none"
                stroke="white"
                strokeOpacity="0.35"
                strokeWidth="2"
                strokeDasharray="10 8"
              />
            </svg>

            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-950/90 to-transparent px-4 pb-4 pt-10">
              <p className="text-center text-[15px] font-medium text-white" aria-live="polite">
                {hint}
              </p>

              {phase === 'capturing' && (
                <div className="mt-3 flex justify-center gap-1.5" aria-hidden="true">
                  {Array.from({ length: total }).map((_, i) => (
                    <span
                      key={i}
                      className={`h-1.5 w-6 rounded-full transition-colors ${
                        i < captured ? 'bg-emerald-400' : 'bg-white/25'
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {error}
        </p>
      )}

      {(phase === 'ready' || phase === 'capturing') && (
        <button
          type="button"
          className="btn-primary w-full py-3 text-base"
          onClick={run}
          disabled={phase === 'capturing' || busy}
        >
          {busy ? 'Saving…' : phase === 'capturing' ? 'Hold still…' : actionLabel}
        </button>
      )}

      {phase === 'error' && (
        <button type="button" className="btn-ghost w-full" onClick={start}>
          Try again
        </button>
      )}

      {frame?.quality && process.env.NODE_ENV === 'development' && (
        <details className="muted text-xs">
          <summary className="cursor-pointer">Debug signals</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-black/5 p-2 dark:bg-white/5">
            {JSON.stringify(
              {
                quality: round(frame.quality.score),
                sharpness: Math.round(frame.quality.sharpness),
                brightness: Math.round(frame.quality.brightness),
                yaw: Math.round(frame.quality.yaw),
                pitch: Math.round(frame.quality.pitch),
                liveness: round(frame.liveness.score),
                signals: {
                  expr: round(frame.liveness.signals.expressionVariance, 4),
                  pose: round(frame.liveness.signals.poseVariance, 3),
                  depth: round(frame.liveness.signals.depthRelief, 4),
                  blinked: frame.liveness.signals.blinked,
                },
              },
              null,
              1,
            )}
          </pre>
        </details>
      )}
    </div>
  );
}

const round = (n: number, dp = 2) => Number(n.toFixed(dp));

function messageFor(err: unknown): string {
  if (!(err instanceof Error)) return 'Something went wrong. Please try again.';
  if (err.name === 'NotAllowedError') {
    return 'Camera permission was denied. Enable it in your browser settings and reload.';
  }
  if (err.name === 'NotFoundError') return 'No camera was found on this device.';
  if (err.name === 'NotReadableError') {
    return 'The camera is already in use by another app. Close it and try again.';
  }
  return err.message;
}
