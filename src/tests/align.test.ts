import { describe, it, expect } from 'vitest';
import {
  estimateSimilarityTransform,
  applyTransform,
  ARCFACE_TEMPLATE_112,
  imageDataToTensor,
  type Point,
} from '../lib/face/align';

/** Applies a known scale/rotation/translation so we can check the fit recovers it. */
function transformPoints(pts: Point[], scale: number, deg: number, tx: number, ty: number): Point[] {
  const r = (deg * Math.PI) / 180;
  const a = scale * Math.cos(r);
  const b = scale * Math.sin(r);
  return pts.map((p) => ({ x: a * p.x - b * p.y + tx, y: b * p.x + a * p.y + ty }));
}

describe('estimateSimilarityTransform', () => {
  it('recovers an exact similarity transform', () => {
    const src = [...ARCFACE_TEMPLATE_112];
    const dst = transformPoints(src, 2.5, 30, 100, -40);

    const t = estimateSimilarityTransform(src, dst);

    expect(t.scale).toBeCloseTo(2.5, 6);
    expect((t.rotation * 180) / Math.PI).toBeCloseTo(30, 6);

    for (let i = 0; i < src.length; i++) {
      const got = applyTransform(t, src[i]);
      expect(got.x).toBeCloseTo(dst[i].x, 6);
      expect(got.y).toBeCloseTo(dst[i].y, 6);
    }
  });

  it('is the identity when source and destination match', () => {
    const t = estimateSimilarityTransform([...ARCFACE_TEMPLATE_112], [...ARCFACE_TEMPLATE_112]);
    expect(t.scale).toBeCloseTo(1, 9);
    expect(t.rotation).toBeCloseTo(0, 9);
    expect(t.e).toBeCloseTo(0, 6);
    expect(t.f).toBeCloseTo(0, 6);
  });

  it('stays a similarity: no shear, no reflection', () => {
    const src: Point[] = [
      { x: 10, y: 10 },
      { x: 90, y: 14 },
      { x: 50, y: 55 },
      { x: 22, y: 88 },
      { x: 78, y: 91 },
    ];
    const t = estimateSimilarityTransform(src, [...ARCFACE_TEMPLATE_112]);

    // d === a and c === -b is exactly the similarity constraint.
    expect(t.d).toBeCloseTo(t.a, 12);
    expect(t.c).toBeCloseTo(-t.b, 12);
    // Positive determinant means orientation is preserved (no mirror flip).
    expect(t.a * t.d - t.b * t.c).toBeGreaterThan(0);
  });

  it('absorbs noise into a least-squares fit rather than failing', () => {
    const src = [...ARCFACE_TEMPLATE_112];
    const dst = transformPoints(src, 1.8, -12, 30, 60).map((p, i) => ({
      x: p.x + (i % 2 === 0 ? 0.7 : -0.7),
      y: p.y + (i % 3 === 0 ? 0.5 : -0.4),
    }));

    const t = estimateSimilarityTransform(src, dst);
    expect(t.scale).toBeCloseTo(1.8, 1);

    const errors = src.map((p, i) => {
      const got = applyTransform(t, p);
      return Math.hypot(got.x - dst[i].x, got.y - dst[i].y);
    });
    expect(Math.max(...errors)).toBeLessThan(1.5);
  });

  it('rejects degenerate input instead of producing NaN', () => {
    const same = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    expect(() => estimateSimilarityTransform(same, same)).toThrow(/degenerate/i);
    expect(() => estimateSimilarityTransform([{ x: 1, y: 1 }], [{ x: 1, y: 1 }])).toThrow();
  });
});

describe('imageDataToTensor', () => {
  it('lays out NCHW and scales to [-1, 1]', () => {
    const w = 2;
    const h = 2;
    const data = new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      127.5, 127.5, 127.5, 255,
    ]);
    const tensor = imageDataToTensor({ width: w, height: h, data } as ImageData);

    expect(tensor.length).toBe(3 * w * h);
    // First pixel is pure red: R at +1, G and B at -1.
    expect(tensor[0]).toBeCloseTo(1, 5);
    expect(tensor[4]).toBeCloseTo(-1, 5);
    expect(tensor[8]).toBeCloseTo(-1, 5);
    // Mid grey sits at zero on every channel.
    expect(tensor[3]).toBeCloseTo(0, 2);
    expect(tensor[7]).toBeCloseTo(0, 2);
    expect(tensor[11]).toBeCloseTo(0, 2);
  });
});
