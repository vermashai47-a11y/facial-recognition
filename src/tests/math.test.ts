import { describe, it, expect } from 'vitest';
import { l2Normalize, cosineSimilarity, meanEmbedding, ramp, stdDev, clamp01 } from '../lib/face/math';

describe('l2Normalize', () => {
  it('produces a unit vector', () => {
    const v = l2Normalize([3, 4]);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
  });

  it('returns zeros rather than NaN for a degenerate vector', () => {
    const v = l2Normalize([0, 0, 0]);
    expect([...v]).toEqual([0, 0, 0]);
  });

  it('is idempotent', () => {
    const once = l2Normalize([1, 2, 3, 4]);
    const twice = l2Normalize(once);
    for (let i = 0; i < once.length; i++) expect(twice[i]).toBeCloseTo(once[i], 6);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and -1 for opposites', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 9);
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 9);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 9);
  });

  it('is scale invariant', () => {
    expect(cosineSimilarity([1, 2], [10, 20])).toBeCloseTo(1, 9);
  });

  it('matches a plain dot product once both sides are unit length', () => {
    // This is the invariant Postgres relies on: `1 - (a <=> b)` on stored
    // vectors must equal what the browser computed.
    const a = l2Normalize([0.2, -0.5, 0.8, 0.1]);
    const b = l2Normalize([0.9, 0.1, -0.2, 0.4]);
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    // Float32 storage, so 1e-6 is the honest tolerance; the point is that the
    // two formulas agree, which is what keeps client and server verdicts aligned.
    expect(cosineSimilarity(a, b)).toBeCloseTo(dot, 6);
  });

  it('rejects a dimension mismatch instead of silently truncating', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/mismatch/i);
  });
});

describe('meanEmbedding', () => {
  it('fuses samples of the same face closer to each than they are to each other', () => {
    const a = l2Normalize([1, 0.1, 0, 0]);
    const b = l2Normalize([0.9, 0.3, 0.1, 0]);
    const fused = meanEmbedding([a, b]);

    expect(Math.hypot(...fused)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(fused, a)).toBeGreaterThan(cosineSimilarity(a, b));
    expect(cosineSimilarity(fused, b)).toBeGreaterThan(cosineSimilarity(a, b));
  });

  it('refuses an empty set', () => {
    expect(() => meanEmbedding([])).toThrow();
  });
});

describe('ramp and clamp', () => {
  it('clamps to the 0..1 range', () => {
    expect(ramp(-5, 0, 10)).toBe(0);
    expect(ramp(15, 0, 10)).toBe(1);
    expect(ramp(5, 0, 10)).toBeCloseTo(0.5, 9);
  });

  it('treats non-finite input as zero', () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(1 - 1); // Infinity is not finite -> 0
  });
});

describe('stdDev', () => {
  it('is zero for a constant series — the signal a frozen photo produces', () => {
    expect(stdDev([0.3, 0.3, 0.3, 0.3])).toBe(0);
  });

  it('grows with spread', () => {
    expect(stdDev([0, 1, 0, 1])).toBeGreaterThan(stdDev([0.4, 0.5, 0.45, 0.5]));
  });
});
