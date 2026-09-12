'use client';

/**
 * Thin wrapper around MediaPipe's FaceLandmarker.
 *
 * It does three jobs for us at once, which is why it is worth the ~3 MB:
 *   1. face detection and a 478-point mesh (the 5 points alignment needs),
 *   2. 52 blendshape activations per frame — the basis of the liveness checks,
 *   3. a 4x4 head-pose matrix, used for pose gating and the turn challenges.
 */

import {
  FilesetResolver,
  FaceLandmarker,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import { MODEL_PATHS, LM } from './constants';
import type { Point } from './align';
import { degrees } from './math';

export interface HeadPose {
  yaw: number; // + = turned to the subject's left
  pitch: number; // + = chin up
  roll: number; // + = head tilted clockwise in the image
}

export interface FaceObservation {
  landmarks: NormalizedLandmark[];
  /** Five alignment points in *pixel* coordinates, ordered left-to-right by image x. */
  five: Point[];
  blendshapes: Record<string, number>;
  pose: HeadPose;
  /** Bounding box in pixels. */
  box: { x: number; y: number; w: number; h: number };
  faceRatio: number;
  timestamp: number;
}

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

export async function getLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(MODEL_PATHS.mediapipeWasm);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: MODEL_PATHS.faceLandmarker,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        // Two, not one: we need to notice a second face in frame and refuse,
        // otherwise someone can hold a phone up next to a colleague.
        numFaces: 2,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    })().catch((err) => {
      landmarkerPromise = null;
      throw err;
    });
  }
  return landmarkerPromise;
}

export function disposeLandmarker(): void {
  landmarkerPromise?.then((l) => l.close()).catch(() => {});
  landmarkerPromise = null;
}

/**
 * Decomposes MediaPipe's row-major 4x4 facial transformation matrix into
 * intrinsic ZYX Euler angles, in degrees.
 */
export function poseFromMatrix(m: ArrayLike<number>): HeadPose {
  // R[i][j] = m[i * 4 + j]
  const r20 = m[8];
  const r21 = m[9];
  const r22 = m[10];
  const r10 = m[4];
  const r00 = m[0];

  const pitch = Math.atan2(r21, r22);
  const yaw = Math.atan2(-r20, Math.hypot(r21, r22));
  const roll = Math.atan2(r10, r00);

  return { yaw: degrees(yaw), pitch: degrees(pitch), roll: degrees(roll) };
}

/** Geometric fallback when no transformation matrix is available. */
export function poseFromLandmarks(five: Point[]): HeadPose {
  const [eyeL, eyeR, nose] = five;
  const eyeMidX = (eyeL.x + eyeR.x) / 2;
  const eyeMidY = (eyeL.y + eyeR.y) / 2;
  const interOcular = Math.hypot(eyeR.x - eyeL.x, eyeR.y - eyeL.y) || 1;
  return {
    yaw: degrees(Math.atan2(nose.x - eyeMidX, interOcular)) * 1.6,
    pitch: degrees(Math.atan2(nose.y - eyeMidY, interOcular)) * 0.8 - 22,
    roll: degrees(Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x)),
  };
}

function centroid(pts: Point[]): Point {
  const n = pts.length;
  return {
    x: pts.reduce((a, p) => a + p.x, 0) / n,
    y: pts.reduce((a, p) => a + p.y, 0) / n,
  };
}

/**
 * Pulls the five alignment points out of the 478-point mesh.
 *
 * Eye centres come from the iris landmarks when the refined mesh is present
 * (they are far more stable than eyelid corners), falling back to the midpoint
 * of the eye corners otherwise. Left/right are then assigned by image x, which
 * makes the result independent of mirroring and of MediaPipe's subject-relative
 * naming.
 */
export function extractFiveLandmarks(
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): Point[] {
  const px = (i: number): Point => ({ x: landmarks[i].x * width, y: landmarks[i].y * height });
  const hasIris = landmarks.length >= 478;

  const eyeA = hasIris ? px(LM.LEFT_IRIS) : centroid([px(LM.LEFT_EYE_OUTER), px(LM.LEFT_EYE_INNER)]);
  const eyeB = hasIris
    ? px(LM.RIGHT_IRIS)
    : centroid([px(LM.RIGHT_EYE_INNER), px(LM.RIGHT_EYE_OUTER)]);

  const [eyeLeft, eyeRight] = eyeA.x <= eyeB.x ? [eyeA, eyeB] : [eyeB, eyeA];

  const mouthA = px(LM.MOUTH_LEFT);
  const mouthB = px(LM.MOUTH_RIGHT);
  const [mouthLeft, mouthRight] = mouthA.x <= mouthB.x ? [mouthA, mouthB] : [mouthB, mouthA];

  return [eyeLeft, eyeRight, px(LM.NOSE_TIP), mouthLeft, mouthRight];
}

export function boxFromLandmarks(
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of landmarks) {
    if (l.x < minX) minX = l.x;
    if (l.x > maxX) maxX = l.x;
    if (l.y < minY) minY = l.y;
    if (l.y > maxY) maxY = l.y;
  }
  return {
    x: minX * width,
    y: minY * height,
    w: (maxX - minX) * width,
    h: (maxY - minY) * height,
  };
}

export function blendshapeMap(result: FaceLandmarkerResult, index = 0): Record<string, number> {
  const out: Record<string, number> = {};
  const shapes = result.faceBlendshapes?.[index];
  if (!shapes) return out;
  for (const c of shapes.categories) {
    if (c.categoryName) out[c.categoryName] = c.score;
  }
  return out;
}

export interface DetectionResult {
  faces: FaceObservation[];
  /** True when more than one face is visible — always a hard reject. */
  multipleFaces: boolean;
}

export function observeFrame(
  result: FaceLandmarkerResult,
  width: number,
  height: number,
  timestamp: number,
): DetectionResult {
  const faces: FaceObservation[] = [];

  for (let i = 0; i < result.faceLandmarks.length; i++) {
    const landmarks = result.faceLandmarks[i];
    if (!landmarks?.length) continue;

    const five = extractFiveLandmarks(landmarks, width, height);
    const box = boxFromLandmarks(landmarks, width, height);
    const matrix = result.facialTransformationMatrixes?.[i]?.data;

    faces.push({
      landmarks,
      five,
      blendshapes: blendshapeMap(result, i),
      pose: matrix ? poseFromMatrix(matrix) : poseFromLandmarks(five),
      box,
      faceRatio: box.w / width,
      timestamp,
    });
  }

  // Biggest face first: that is the person actually holding the phone.
  faces.sort((a, b) => b.faceRatio - a.faceRatio);

  return { faces, multipleFaces: faces.length > 1 };
}
