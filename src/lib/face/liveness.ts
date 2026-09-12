'use client';

/**
 * Presentation-attack deterrence.
 *
 * An honest framing of what this is: a set of cheap, software-only signals that
 * make a casual attack (holding up a photo of a colleague, or a printout)
 * reliably fail. It is *not* certified presentation-attack detection. A
 * determined attacker replaying a high-quality video on a good screen, in the
 * right lighting, can defeat every check in this file. Defeating that class of
 * attack needs depth or infrared hardware, which a browser cannot reach.
 *
 * The design therefore leans on two things a flat replay is bad at:
 *
 *   1. Micro-expression variety. A real face is never perfectly still — brows,
 *      jaw and eyelids jitter constantly. A photo's blendshape vector is frozen;
 *      a looping video repeats. We measure temporal variance across channels.
 *
 *   2. Responding on demand. The active challenge asks for a specific action in
 *      a random order within a short window. A static photo cannot comply at
 *      all, and a pre-recorded video only complies by luck.
 *
 * Everything is scored 0..1 and combined; the server compares the result
 * against `org_settings.min_liveness_score` and never trusts the client's own
 * pass/fail opinion.
 */

import { BS } from './constants';
import { clamp01, mean, ramp, stdDev } from './math';
import type { FaceObservation } from './landmarker';

export type LivenessMode = 'off' | 'passive' | 'active';

export type ChallengeKind = 'blink' | 'turn_left' | 'turn_right' | 'smile' | 'open_mouth';

export const CHALLENGE_PROMPTS: Record<ChallengeKind, string> = {
  blink: 'Blink twice',
  turn_left: 'Slowly turn your head left',
  turn_right: 'Slowly turn your head right',
  smile: 'Give a small smile',
  open_mouth: 'Open your mouth',
};

/** Channels whose jitter distinguishes a living face from a printed one. */
const VARIANCE_CHANNELS = [
  BS.blinkLeft,
  BS.blinkRight,
  BS.browUpLeft,
  BS.browUpRight,
  BS.jawOpen,
  BS.smileLeft,
  BS.smileRight,
  BS.squintLeft,
  BS.squintRight,
];

const WINDOW_MS = 4000;

interface Sample {
  t: number;
  blendshapes: Record<string, number>;
  yaw: number;
  pitch: number;
  roll: number;
  /** Standard deviation of mesh z, normalised by face width: a flat-ish depth cue. */
  relief: number;
}

export interface LivenessSignals {
  blinked: boolean;
  expressionVariance: number;
  poseVariance: number;
  depthRelief: number;
  frames: number;
  challengesPassed: number;
  challengesTotal: number;
}

export interface LivenessResult {
  score: number;
  passed: boolean;
  signals: LivenessSignals;
  hint: string | null;
}

export interface ChallengeState {
  kind: ChallengeKind;
  prompt: string;
  satisfied: boolean;
  startedAt: number;
}

export class LivenessTracker {
  private samples: Sample[] = [];
  private blinkPhase: 'open' | 'closing' = 'open';
  private blinkCount = 0;
  private challenges: ChallengeState[] = [];
  private cursor = 0;
  private readonly mode: LivenessMode;
  private readonly challengeTimeoutMs: number;

  constructor(mode: LivenessMode = 'active', challengeTimeoutMs = 8000) {
    this.mode = mode;
    this.challengeTimeoutMs = challengeTimeoutMs;
    if (mode === 'active') this.challenges = buildChallengeSequence();
  }

  reset(): void {
    this.samples = [];
    this.blinkPhase = 'open';
    this.blinkCount = 0;
    this.cursor = 0;
    if (this.mode === 'active') this.challenges = buildChallengeSequence();
  }

  get currentChallenge(): ChallengeState | null {
    return this.challenges[this.cursor] ?? null;
  }

  get allChallengesPassed(): boolean {
    return this.mode !== 'active' || this.cursor >= this.challenges.length;
  }

  get progress(): { done: number; total: number } {
    return { done: this.cursor, total: this.challenges.length };
  }

  /** Feed one detected face. Call once per animation frame while the camera is live. */
  push(face: FaceObservation): void {
    const now = face.timestamp;

    // MediaPipe's z is already expressed relative to face scale, so the spread
    // across the mesh is directly comparable between near and far captures.
    const relief =
      face.landmarks.length > 0 ? stdDev(face.landmarks.map((l) => l.z ?? 0)) : 0;

    this.samples.push({
      t: now,
      blendshapes: face.blendshapes,
      yaw: face.pose.yaw,
      pitch: face.pose.pitch,
      roll: face.pose.roll,
      relief,
    });

    const cutoff = now - WINDOW_MS;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) this.samples.shift();

    this.trackBlinks(face);
    if (this.mode === 'active') this.advanceChallenge(face, now);
  }

  /** A blink is a full close-then-open cycle, not merely a low eye-open value. */
  private trackBlinks(face: FaceObservation): void {
    const blink = Math.max(
      face.blendshapes[BS.blinkLeft] ?? 0,
      face.blendshapes[BS.blinkRight] ?? 0,
    );
    if (this.blinkPhase === 'open' && blink > 0.55) {
      this.blinkPhase = 'closing';
    } else if (this.blinkPhase === 'closing' && blink < 0.18) {
      this.blinkPhase = 'open';
      this.blinkCount++;
    }
  }

  private advanceChallenge(face: FaceObservation, now: number): void {
    const current = this.challenges[this.cursor];
    if (!current) return;

    if (current.startedAt === 0) current.startedAt = now;

    const bs = face.blendshapes;
    let satisfied = false;

    switch (current.kind) {
      case 'blink':
        satisfied = this.blinkCount >= 2;
        break;
      case 'turn_left':
        satisfied = face.pose.yaw > 18;
        break;
      case 'turn_right':
        satisfied = face.pose.yaw < -18;
        break;
      case 'smile':
        satisfied = ((bs[BS.smileLeft] ?? 0) + (bs[BS.smileRight] ?? 0)) / 2 > 0.35;
        break;
      case 'open_mouth':
        satisfied = (bs[BS.jawOpen] ?? 0) > 0.4;
        break;
    }

    if (satisfied) {
      current.satisfied = true;
      this.cursor++;
      // Blink counting restarts so a later blink challenge cannot be satisfied
      // by blinks that happened during an earlier step.
      this.blinkCount = 0;
      const next = this.challenges[this.cursor];
      if (next) next.startedAt = now;
    } else if (now - current.startedAt > this.challengeTimeoutMs) {
      // Timed out: rotate this step to a different action rather than failing
      // outright, since people often just misread the first prompt.
      const replacement = pickChallenge(new Set(this.challenges.map((c) => c.kind)));
      current.kind = replacement;
      current.prompt = CHALLENGE_PROMPTS[replacement];
      current.startedAt = now;
    }
  }

  evaluate(): LivenessResult {
    const frames = this.samples.length;

    if (this.mode === 'off') {
      return {
        score: 1,
        passed: true,
        signals: {
          blinked: false,
          expressionVariance: 0,
          poseVariance: 0,
          depthRelief: 0,
          frames,
          challengesPassed: 0,
          challengesTotal: 0,
        },
        hint: null,
      };
    }

    if (frames < 12) {
      return {
        score: 0,
        passed: false,
        signals: {
          blinked: false,
          expressionVariance: 0,
          poseVariance: 0,
          depthRelief: 0,
          frames,
          challengesPassed: this.cursor,
          challengesTotal: this.challenges.length,
        },
        hint: 'Hold still for a moment longer',
      };
    }

    // 1. Micro-expression variety — the single most useful passive signal.
    const expressionVariance = mean(
      VARIANCE_CHANNELS.map((ch) => stdDev(this.samples.map((s) => s.blendshapes[ch] ?? 0))),
    );

    // 2. Head micro-motion. Weak on its own (a shaking hand moves a photo too)
    //    but it distinguishes a face from a perfectly static tripod-mounted print.
    const poseVariance = mean([
      stdDev(this.samples.map((s) => s.yaw)),
      stdDev(this.samples.map((s) => s.pitch)),
      stdDev(this.samples.map((s) => s.roll)),
    ]);

    // 3. Depth relief from the fitted mesh. A flat surface yields a noticeably
    //    shallower and noisier z profile than a real head.
    const depthRelief = mean(this.samples.map((s) => s.relief));

    const blinked = this.blinkCount > 0 || this.challenges.some((c) => c.kind === 'blink' && c.satisfied);

    const passive = clamp01(
      0.45 * ramp(expressionVariance, 0.004, 0.045) +
        0.2 * ramp(poseVariance, 0.25, 2.5) +
        0.2 * ramp(depthRelief, 0.008, 0.03) +
        0.15 * (blinked ? 1 : 0),
    );

    let score = passive;
    let hint: string | null = null;

    if (this.mode === 'active') {
      const total = this.challenges.length || 1;
      const fraction = this.cursor / total;
      // Completing the challenges carries most of the weight; the passive
      // signals then stop a video replay that happens to contain the action.
      score = clamp01(0.6 * fraction + 0.4 * passive);
      if (this.cursor < total) {
        hint = this.challenges[this.cursor]?.prompt ?? null;
      }
    }

    if (hint === null && passive < 0.4) {
      hint = 'Move a little — the camera cannot tell this is a live face';
    }

    return {
      score,
      passed: score >= 0.6 && this.allChallengesPassed,
      signals: {
        blinked,
        expressionVariance,
        poseVariance,
        depthRelief,
        frames,
        challengesPassed: this.cursor,
        challengesTotal: this.challenges.length,
      },
      hint,
    };
  }
}

function pickChallenge(exclude: Set<ChallengeKind>): ChallengeKind {
  const pool: ChallengeKind[] = ['blink', 'turn_left', 'turn_right', 'smile', 'open_mouth'];
  const options = pool.filter((k) => !exclude.has(k));
  const from = options.length > 0 ? options : pool;
  return from[randomInt(from.length)];
}

/**
 * Two challenges, always including one head turn (which a flat photo cannot
 * fake at all) and one facial action. Order is randomised so a recording made
 * yesterday does not line up with today's prompts.
 */
function buildChallengeSequence(): ChallengeState[] {
  const turns: ChallengeKind[] = ['turn_left', 'turn_right'];
  const actions: ChallengeKind[] = ['blink', 'smile', 'open_mouth'];

  const picked: ChallengeKind[] = [turns[randomInt(2)], actions[randomInt(actions.length)]];
  if (randomInt(2) === 1) picked.reverse();

  return picked.map((kind) => ({
    kind,
    prompt: CHALLENGE_PROMPTS[kind],
    satisfied: false,
    startedAt: 0,
  }));
}

/** Unbiased small-range random int from the CSPRNG, so prompts are not predictable. */
function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    let v: number;
    do {
      crypto.getRandomValues(buf);
      v = buf[0];
    } while (v >= limit);
    return v % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}
