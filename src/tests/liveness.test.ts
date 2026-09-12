import { describe, it, expect } from 'vitest';
import { LivenessTracker } from '../lib/face/liveness';
import type { FaceObservation } from '../lib/face/landmarker';

/** Builds a synthetic frame. `jitter` simulates the micro-motion of a real face. */
function frame(t: number, jitter: number, overrides: Partial<Record<string, number>> = {}): FaceObservation {
  const n = (base: number) => base + (Math.sin(t / 7) * jitter);
  return {
    landmarks: Array.from({ length: 478 }, (_, i) => ({
      x: 0.5,
      y: 0.5,
      z: jitter > 0 ? Math.sin(i) * 0.02 : 0.0001 * (i % 3),
      visibility: 1,
    })),
    five: [
      { x: 40, y: 50 },
      { x: 74, y: 50 },
      { x: 56, y: 72 },
      { x: 42, y: 92 },
      { x: 70, y: 92 },
    ],
    blendshapes: {
      eyeBlinkLeft: n(0.1),
      eyeBlinkRight: n(0.1),
      browOuterUpLeft: n(0.1),
      browOuterUpRight: n(0.1),
      jawOpen: n(0.05),
      mouthSmileLeft: n(0.05),
      mouthSmileRight: n(0.05),
      eyeSquintLeft: n(0.1),
      eyeSquintRight: n(0.1),
      ...overrides,
    },
    pose: { yaw: jitter > 0 ? Math.sin(t / 5) * 3 : 0, pitch: 0, roll: 0 },
    box: { x: 0, y: 0, w: 300, h: 400 },
    faceRatio: 0.35,
    timestamp: t,
  };
}

describe('LivenessTracker — passive mode', () => {
  it('scores a perfectly still frozen image far below a moving face', () => {
    const still = new LivenessTracker('passive');
    const living = new LivenessTracker('passive');

    for (let i = 0; i < 60; i++) {
      const t = i * 33;
      still.push(frame(t, 0));
      living.push(frame(t, 0.25));
    }

    const frozen = still.evaluate();
    const alive = living.evaluate();

    expect(frozen.score).toBeLessThan(0.3);
    expect(frozen.signals.expressionVariance).toBeLessThan(0.001);
    expect(alive.score).toBeGreaterThan(frozen.score + 0.3);
  });

  it('needs a minimum number of frames before it will score at all', () => {
    const tracker = new LivenessTracker('passive');
    tracker.push(frame(0, 0.3));
    tracker.push(frame(33, 0.3));
    const result = tracker.evaluate();
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('counts a blink only after a full close-then-open cycle', () => {
    const tracker = new LivenessTracker('passive');
    for (let i = 0; i < 20; i++) tracker.push(frame(i * 33, 0.2));
    // Eyes close but never reopen within the window: not yet a blink.
    for (let i = 20; i < 30; i++) {
      tracker.push(frame(i * 33, 0.2, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }));
    }
    expect(tracker.evaluate().signals.blinked).toBe(false);

    for (let i = 30; i < 40; i++) {
      tracker.push(frame(i * 33, 0.2, { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05 }));
    }
    expect(tracker.evaluate().signals.blinked).toBe(true);
  });
});

describe('LivenessTracker — off mode', () => {
  it('passes everything, including a completely static image', () => {
    const tracker = new LivenessTracker('off');
    for (let i = 0; i < 30; i++) tracker.push(frame(i * 33, 0));
    const result = tracker.evaluate();
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
  });
});

describe('LivenessTracker — active mode', () => {
  it('issues challenges and does not pass until they are satisfied', () => {
    const tracker = new LivenessTracker('active');
    expect(tracker.currentChallenge).not.toBeNull();
    expect(tracker.progress.total).toBe(2);

    for (let i = 0; i < 40; i++) tracker.push(frame(i * 33, 0.25));

    const result = tracker.evaluate();
    expect(result.passed).toBe(false);
    expect(result.hint).toBeTruthy();
    expect(tracker.allChallengesPassed).toBe(false);
  });

  it('advances when the requested action is performed', () => {
    const tracker = new LivenessTracker('active');
    const first = tracker.currentChallenge!;

    for (let i = 0; i < 30; i++) {
      const t = i * 33;
      const f = frame(t, 0.25);
      // Satisfy whichever action was asked for.
      if (first.kind === 'turn_left') f.pose.yaw = 25;
      if (first.kind === 'turn_right') f.pose.yaw = -25;
      if (first.kind === 'smile') {
        f.blendshapes.mouthSmileLeft = 0.6;
        f.blendshapes.mouthSmileRight = 0.6;
      }
      if (first.kind === 'open_mouth') f.blendshapes.jawOpen = 0.7;
      if (first.kind === 'blink') {
        f.blendshapes.eyeBlinkLeft = i % 6 < 3 ? 0.9 : 0.05;
        f.blendshapes.eyeBlinkRight = f.blendshapes.eyeBlinkLeft;
      }
      tracker.push(f);
    }

    expect(tracker.progress.done).toBeGreaterThanOrEqual(1);
  });

  it('resets cleanly and issues a fresh sequence', () => {
    const tracker = new LivenessTracker('active');
    for (let i = 0; i < 30; i++) tracker.push(frame(i * 33, 0.25));
    tracker.reset();
    expect(tracker.progress.done).toBe(0);
    expect(tracker.evaluate().signals.frames).toBe(0);
  });
});
