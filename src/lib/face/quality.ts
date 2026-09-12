/**
 * Capture quality gating.
 *
 * Rejecting a bad frame costs the user two seconds. Accepting one costs a false
 * rejection later, when the enrolled template turns out to be a blurry,
 * badly-lit, three-quarter-profile shot. So the gate is deliberately strict at
 * enrolment and a little looser at check-in.
 */

import { QUALITY, BS } from './constants';
import { clamp01, ramp } from './math';
import type { FaceObservation } from './landmarker';

export interface QualityReport {
  score: number; // 0..1, the number sent to the server
  ok: boolean;
  sharpness: number;
  brightness: number;
  faceRatio: number;
  yaw: number;
  pitch: number;
  roll: number;
  eyesOpen: number;
  /** Human-readable reason for the top failing check, or null when the frame is usable. */
  hint: string | null;
}

/**
 * Variance of the Laplacian — the standard cheap focus measure. A sharp face
 * has strong second-order intensity changes at the eyes and lip line; motion
 * blur or a soft webcam smears them away.
 */
export function laplacianVariance(img: ImageData): number {
  const { width: w, height: h, data } = img;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function meanLuminance(img: ImageData): number {
  const { data } = img;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

export interface QualityInput {
  face: FaceObservation;
  aligned: ImageData;
  /** Enrolment is stricter: a bad template poisons every future check-in. */
  strict?: boolean;
}

export function assessQuality({ face, aligned, strict = false }: QualityInput): QualityReport {
  const sharpness = laplacianVariance(aligned);
  const brightness = meanLuminance(aligned);
  const { yaw, pitch, roll } = face.pose;
  const blink = Math.max(
    face.blendshapes[BS.blinkLeft] ?? 0,
    face.blendshapes[BS.blinkRight] ?? 0,
  );
  const eyesOpen = 1 - blink;

  const tighten = strict ? 0.75 : 1;
  const minSharp = QUALITY.minSharpness * (strict ? 1.35 : 1);

  // Each sub-score is 0..1; the overall score is the *weakest link*, softened,
  // so one badly failing dimension cannot be averaged away by four good ones.
  const subs = {
    size: ramp(face.faceRatio, QUALITY.minFaceRatio * 0.8, QUALITY.minFaceRatio * 1.6),
    sharp: ramp(sharpness, minSharp * 0.6, minSharp * 2.2),
    light:
      ramp(brightness, QUALITY.minBrightness * 0.7, QUALITY.minBrightness * 1.4) *
      (1 - ramp(brightness, QUALITY.maxBrightness, 255)),
    yaw: 1 - ramp(Math.abs(yaw), QUALITY.maxYawDeg * tighten * 0.5, QUALITY.maxYawDeg * tighten),
    pitch: 1 - ramp(Math.abs(pitch), QUALITY.maxPitchDeg * tighten * 0.5, QUALITY.maxPitchDeg * tighten),
    roll: 1 - ramp(Math.abs(roll), QUALITY.maxRollDeg * tighten * 0.5, QUALITY.maxRollDeg * tighten),
    eyes: 1 - ramp(blink, QUALITY.maxBlinkAtCapture * 0.6, QUALITY.maxBlinkAtCapture),
  };

  const weakest = Math.min(...Object.values(subs));
  const average = Object.values(subs).reduce((a, b) => a + b, 0) / Object.keys(subs).length;
  const score = clamp01(0.65 * weakest + 0.35 * average);

  let hint: string | null = null;
  if (face.faceRatio < QUALITY.minFaceRatio) hint = 'Move a little closer';
  else if (face.faceRatio > QUALITY.maxFaceRatio) hint = 'Hold the phone further away';
  else if (brightness < QUALITY.minBrightness) hint = 'Find better lighting';
  else if (brightness > QUALITY.maxBrightness) hint = 'Too bright — move out of direct light';
  else if (sharpness < minSharp) hint = 'Hold still, the image is blurry';
  else if (Math.abs(yaw) > QUALITY.maxYawDeg * tighten) hint = 'Look straight at the camera';
  else if (Math.abs(pitch) > QUALITY.maxPitchDeg * tighten) hint = 'Raise or lower your chin a little';
  else if (Math.abs(roll) > QUALITY.maxRollDeg * tighten) hint = 'Straighten your head';
  else if (blink > QUALITY.maxBlinkAtCapture) hint = 'Keep your eyes open';

  return {
    score,
    ok: hint === null && score >= (strict ? 0.7 : 0.5),
    sharpness,
    brightness,
    faceRatio: face.faceRatio,
    yaw,
    pitch,
    roll,
    eyesOpen,
    hint,
  };
}
