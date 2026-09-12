/**
 * Face alignment.
 *
 * ArcFace-family recognition models are trained on faces warped onto a fixed
 * 112x112 canonical layout. Feeding them an un-warped crop costs several points
 * of accuracy, so this step is not optional.
 *
 * We fit a *similarity* transform (uniform scale + rotation + translation, no
 * shear, no reflection) from five detected landmarks to the canonical template.
 * Because a similarity transform is linear in its four parameters, the
 * least-squares fit has a closed form — no SVD needed, which keeps this fast
 * and dependency-free.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * InsightFace's canonical five-point template for a 112x112 crop, in the order
 * [eye_left, eye_right, nose, mouth_left, mouth_right] where "left" means the
 * left-hand side of the *image*.
 */
export const ARCFACE_TEMPLATE_112: readonly Point[] = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
] as const;

export const ALIGNED_SIZE = 112;

/**
 * Similarity transform as the six numbers canvas2d wants:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 * with the constraint d === a and c === -b, which is what makes it a similarity.
 */
export interface SimilarityTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  /** Uniform scale factor, useful as a quality signal (how big the face is). */
  scale: number;
  /** In-plane rotation in radians. */
  rotation: number;
}

/**
 * Closed-form least-squares similarity transform mapping `src` onto `dst`.
 *
 * Writing the transform as x' = a*x - b*y + tx, y' = b*x + a*y + ty makes it
 * linear in (a, b, tx, ty); differentiating the squared error and solving the
 * resulting 4x4 normal equations collapses to the expressions below.
 */
export function estimateSimilarityTransform(
  src: readonly Point[],
  dst: readonly Point[],
): SimilarityTransform {
  const n = src.length;
  if (n < 2 || dst.length !== n) {
    throw new Error('estimateSimilarityTransform needs >= 2 matched point pairs');
  }

  let sx = 0;
  let sy = 0;
  let sX = 0;
  let sY = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i].x;
    sy += src[i].y;
    sX += dst[i].x;
    sY += dst[i].y;
  }
  const mx = sx / n;
  const my = sy / n;
  const mX = sX / n;
  const mY = sY / n;

  let varSrc = 0; // Σ (x-mx)² + (y-my)²
  let dot = 0; // Σ (x-mx)(X-mX) + (y-my)(Y-mY)
  let cross = 0; // Σ (x-mx)(Y-mY) - (y-my)(X-mX)
  for (let i = 0; i < n; i++) {
    const dx = src[i].x - mx;
    const dy = src[i].y - my;
    const dX = dst[i].x - mX;
    const dY = dst[i].y - mY;
    varSrc += dx * dx + dy * dy;
    dot += dx * dX + dy * dY;
    cross += dx * dY - dy * dX;
  }

  if (varSrc < 1e-9) throw new Error('Degenerate landmark set: all points coincide');

  const a = dot / varSrc;
  const b = cross / varSrc;
  const e = mX - (a * mx - b * my);
  const f = mY - (b * mx + a * my);

  return {
    a,
    b,
    c: -b,
    d: a,
    e,
    f,
    scale: Math.hypot(a, b),
    rotation: Math.atan2(b, a),
  };
}

/** Applies a transform to a single point (used by the tests and the debug overlay). */
export function applyTransform(t: SimilarityTransform, p: Point): Point {
  return { x: t.a * p.x + t.c * p.y + t.e, y: t.b * p.x + t.d * p.y + t.f };
}

/**
 * Warps the face out of a video frame onto a 112x112 canvas.
 *
 * The transform is handed straight to canvas2d, so the resampling runs on the
 * GPU with proper bilinear filtering instead of a hand-rolled JS loop.
 */
export function warpFaceTo112(
  source: CanvasImageSource,
  landmarks5: readonly Point[],
  canvas?: HTMLCanvasElement | OffscreenCanvas,
): { canvas: HTMLCanvasElement | OffscreenCanvas; transform: SimilarityTransform } {
  const t = estimateSimilarityTransform(landmarks5, ARCFACE_TEMPLATE_112);

  const out =
    canvas ??
    (typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(ALIGNED_SIZE, ALIGNED_SIZE)
      : Object.assign(document.createElement('canvas'), {
          width: ALIGNED_SIZE,
          height: ALIGNED_SIZE,
        }));
  out.width = ALIGNED_SIZE;
  out.height = ALIGNED_SIZE;

  const ctx = (out as HTMLCanvasElement).getContext('2d', {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Could not acquire a 2D context for face alignment');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  return { canvas: out, transform: t };
}

/**
 * 112x112 RGBA pixels -> NCHW float tensor scaled to [-1, 1].
 * This matches the preprocessing InsightFace uses for the w600k_* recognisers.
 */
export function imageDataToTensor(img: ImageData): Float32Array {
  const { width: w, height: h, data } = img;
  const plane = w * h;
  const out = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = (data[i] - 127.5) / 127.5; // R
    out[plane + p] = (data[i + 1] - 127.5) / 127.5; // G
    out[2 * plane + p] = (data[i + 2] - 127.5) / 127.5; // B
  }
  return out;
}
