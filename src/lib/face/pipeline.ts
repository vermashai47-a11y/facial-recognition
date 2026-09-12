'use client';

/**
 * The capture engine: one requestAnimationFrame loop that turns a <video>
 * element into either an enrolment template or a check-in attempt.
 *
 * Everything expensive is lazy. The landmarker runs every frame (it is cheap
 * and drives the on-screen guidance); the recogniser runs only on the handful
 * of frames that pass the quality gate.
 */

import { getLandmarker, observeFrame, type FaceObservation } from './landmarker';
import { warpFaceTo112, ALIGNED_SIZE } from './align';
import { embedAligned, warmUpEmbedder } from './embedder';
import { assessQuality, type QualityReport } from './quality';
import { LivenessTracker, type LivenessMode, type LivenessResult } from './liveness';
import { meanEmbedding } from './math';

export interface CaptureFrameState {
  face: FaceObservation | null;
  multipleFaces: boolean;
  quality: QualityReport | null;
  liveness: LivenessResult;
  /** The single line of guidance to show the user right now. */
  hint: string;
  ready: boolean;
}

export interface CaptureResult {
  embedding: Float32Array;
  quality: number;
  liveness: number;
  /** JPEG data URL of the aligned crop, for the audit photo. */
  snapshot: string;
  samples: number;
}

export interface EngineOptions {
  video: HTMLVideoElement;
  mode: 'enroll' | 'verify';
  livenessMode?: LivenessMode;
  /** How many good frames to fuse. More is more robust but slower. */
  targetSamples?: number;
  onFrame?: (state: CaptureFrameState) => void;
}

const DEFAULT_SAMPLES = { enroll: 5, verify: 3 } as const;

export class FaceCaptureEngine {
  private raf = 0;
  private running = false;
  private lastVideoTime = -1;
  private readonly tracker: LivenessTracker;
  private readonly opts: Required<Omit<EngineOptions, 'onFrame'>> & Pick<EngineOptions, 'onFrame'>;
  private collected: Float32Array[] = [];
  private qualities: number[] = [];
  private lastSnapshot = '';
  private lastEmbedAt = 0;
  private embedding = false;
  private workCanvas: HTMLCanvasElement | null = null;

  constructor(options: EngineOptions) {
    this.opts = {
      video: options.video,
      mode: options.mode,
      livenessMode: options.livenessMode ?? (options.mode === 'enroll' ? 'passive' : 'active'),
      targetSamples: options.targetSamples ?? DEFAULT_SAMPLES[options.mode],
      onFrame: options.onFrame,
    };
    this.tracker = new LivenessTracker(this.opts.livenessMode);
  }

  /** Loads both models. Call before showing the camera so the UI can show a spinner. */
  static async preload(): Promise<void> {
    await Promise.all([getLandmarker(), warmUpEmbedder()]);
  }

  async start(): Promise<void> {
    await getLandmarker();
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  reset(): void {
    this.collected = [];
    this.qualities = [];
    this.lastSnapshot = '';
    this.tracker.reset();
  }

  get progress(): { samples: number; target: number; challenge: ReturnType<LivenessTracker['evaluate']> } {
    return {
      samples: this.collected.length,
      target: this.opts.targetSamples,
      challenge: this.tracker.evaluate(),
    };
  }

  /**
   * Resolves once enough good frames have been fused, or rejects on timeout.
   * The fused template is the renormalised mean of the per-frame embeddings,
   * which is markedly more stable than any single frame.
   */
  async capture(timeoutMs = 30000): Promise<CaptureResult> {
    const deadline = Date.now() + timeoutMs;
    return new Promise<CaptureResult>((resolve, reject) => {
      const tick = () => {
        if (!this.running) return reject(new Error('Capture was cancelled'));

        const live = this.tracker.evaluate();
        if (this.collected.length >= this.opts.targetSamples && live.passed) {
          resolve({
            embedding: meanEmbedding(this.collected),
            quality: this.qualities.reduce((a, b) => a + b, 0) / this.qualities.length,
            liveness: live.score,
            snapshot: this.lastSnapshot,
            samples: this.collected.length,
          });
          return;
        }

        if (Date.now() > deadline) {
          reject(
            new Error(
              live.passed
                ? 'Could not get a clear enough view of your face. Try better lighting.'
                : 'Liveness check timed out. Please follow the on-screen prompts.',
            ),
          );
          return;
        }
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  private loop = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);

    const video = this.opts.video;
    if (video.readyState < 2 || video.videoWidth === 0) return;
    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;

    void this.processFrame(video);
  };

  private async processFrame(video: HTMLVideoElement): Promise<void> {
    const landmarker = await getLandmarker();
    const now = performance.now();

    const raw = landmarker.detectForVideo(video, now);
    const { faces, multipleFaces } = observeFrame(raw, video.videoWidth, video.videoHeight, now);
    const face = faces[0] ?? null;

    if (!face) {
      this.emit({
        face: null,
        multipleFaces: false,
        quality: null,
        liveness: this.tracker.evaluate(),
        hint: 'Position your face in the frame',
        ready: false,
      });
      return;
    }

    if (multipleFaces) {
      // Hard stop: a second face in frame is either a bystander or an attack.
      this.emit({
        face,
        multipleFaces: true,
        quality: null,
        liveness: this.tracker.evaluate(),
        hint: 'More than one face is visible — make sure you are alone in frame',
        ready: false,
      });
      return;
    }

    this.tracker.push(face);

    const { canvas } = warpFaceTo112(video, face.five, this.ensureCanvas());
    const ctx = (canvas as HTMLCanvasElement).getContext('2d', { willReadFrequently: true })!;
    const aligned = ctx.getImageData(0, 0, ALIGNED_SIZE, ALIGNED_SIZE);

    const quality = assessQuality({ face, aligned, strict: this.opts.mode === 'enroll' });
    const liveness = this.tracker.evaluate();

    const needMore = this.collected.length < this.opts.targetSamples;
    const cooledDown = now - this.lastEmbedAt > 350; // spread samples over time

    if (quality.ok && needMore && cooledDown && !this.embedding) {
      this.embedding = true;
      this.lastEmbedAt = now;
      try {
        const embedding = await embedAligned(aligned);
        this.collected.push(embedding);
        this.qualities.push(quality.score);
        this.lastSnapshot = (canvas as HTMLCanvasElement).toDataURL('image/jpeg', 0.82);
      } catch {
        // A single failed inference is not fatal; the next frame retries.
      } finally {
        this.embedding = false;
      }
    }

    this.emit({
      face,
      multipleFaces: false,
      quality,
      liveness,
      hint: liveness.hint ?? quality.hint ?? this.captureHint(),
      ready: this.collected.length >= this.opts.targetSamples && liveness.passed,
    });
  }

  private captureHint(): string {
    const n = this.collected.length;
    const t = this.opts.targetSamples;
    return n >= t ? 'Hold still…' : `Hold still — capturing ${n + 1} of ${t}`;
  }

  private ensureCanvas(): HTMLCanvasElement {
    if (!this.workCanvas) {
      this.workCanvas = document.createElement('canvas');
      this.workCanvas.width = ALIGNED_SIZE;
      this.workCanvas.height = ALIGNED_SIZE;
    }
    return this.workCanvas;
  }

  private emit(state: CaptureFrameState): void {
    this.opts.onFrame?.(state);
  }
}

/** Requests the front camera at a resolution that balances detail against decode cost. */
export async function openCamera(preferFront = true): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot access the camera. Try Chrome, Safari or Firefox.');
  }
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: preferFront ? 'user' : 'environment',
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
  });
}

export function closeCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}
