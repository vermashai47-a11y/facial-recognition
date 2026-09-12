/**
 * Small numeric helpers for the face pipeline.
 * Everything here is pure and unit-tested in src/tests/math.test.ts.
 */

/** In-place-safe L2 normalisation. ArcFace embeddings are only comparable once unit length. */
export function l2Normalize(v: Float32Array | number[]): Float32Array {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum);
  if (norm < 1e-12) return out; // degenerate; caller should reject
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * Cosine similarity. For unit vectors this is just the dot product, which is
 * exactly what Postgres computes as `1 - (a <=> b)` — keeping the two in
 * agreement is what makes the client-side preview match the server verdict.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d < 1e-12 ? 0 : dot / d;
}

/** Element-wise mean of several embeddings, renormalised. Used to fuse enrolment samples. */
export function meanEmbedding(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new Error('meanEmbedding needs at least one vector');
  const dim = vectors[0].length;
  const acc = new Float32Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) throw new Error('All embeddings must share a dimension');
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }
  for (let i = 0; i < dim; i++) acc[i] /= vectors.length;
  return l2Normalize(acc);
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/** Maps a raw measurement onto 0..1 with a soft ramp between `lo` and `hi`. */
export function ramp(x: number, lo: number, hi: number): number {
  if (hi === lo) return x >= hi ? 1 : 0;
  return clamp01((x - lo) / (hi - lo));
}

export function degrees(rad: number): number {
  return (rad * 180) / Math.PI;
}
