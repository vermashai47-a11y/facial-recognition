'use client';

/**
 * ArcFace embedding via onnxruntime-web.
 *
 * The model is MobileFaceNet trained on WebFace600K (InsightFace "buffalo_s"
 * recogniser, ~13 MB). It produces a 512-float vector; two crops of the same
 * person land close together under cosine distance, different people land far
 * apart. Running it in the browser is what keeps this project free to host —
 * there is no GPU to rent because the phone already has one.
 */

import * as ort from 'onnxruntime-web';
import { MODEL_PATHS, EMBEDDING_DIM } from './constants';
import { imageDataToTensor, ALIGNED_SIZE } from './align';
import { l2Normalize } from './math';

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let activeBackend: 'webgpu' | 'wasm' | null = null;

function configureRuntime(): void {
  ort.env.wasm.wasmPaths = MODEL_PATHS.ortWasm;
  // Cross-origin isolation is set up in next.config.ts; without it the runtime
  // reports 1 core and we would happily spawn threads it cannot use.
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 4) : 4;
  ort.env.wasm.numThreads = isolated ? Math.min(4, Math.max(1, cores - 1)) : 1;
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';
}

export async function getEmbedder(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      configureRuntime();

      // WebGPU is roughly 3-5x faster where it works, but its runtime is a
      // separate 28 MB binary that `npm run fetch:models` only copies with
      // `--full` — enough to push a Hobby deployment past Vercel's 100 MB
      // static-upload cap. So it is opt-in, and a failure still falls back
      // rather than throwing, since support is patchy on Android WebViews.
      if (process.env.NEXT_PUBLIC_ENABLE_WEBGPU === 'true') {
        try {
          const s = await ort.InferenceSession.create(MODEL_PATHS.recognizer, {
            executionProviders: ['webgpu'],
            graphOptimizationLevel: 'all',
          });
          activeBackend = 'webgpu';
          return s;
        } catch {
          // fall through to WASM
        }
      }

      const s = await ort.InferenceSession.create(MODEL_PATHS.recognizer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      activeBackend = 'wasm';
      return s;
    })().catch((err) => {
      sessionPromise = null;
      throw new Error(
        `Could not load the recognition model. Did you run \`npm run fetch:models\`? (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    });
  }
  return sessionPromise;
}

export function getActiveBackend(): 'webgpu' | 'wasm' | null {
  return activeBackend;
}

export function disposeEmbedder(): void {
  sessionPromise?.then((s) => s.release()).catch(() => {});
  sessionPromise = null;
  activeBackend = null;
}

/**
 * Runs one aligned 112x112 crop through the recogniser.
 * Input and output names are read from the session rather than hard-coded, so
 * swapping in a different ArcFace export does not require a code change.
 */
export async function embedAligned(aligned: ImageData): Promise<Float32Array> {
  if (aligned.width !== ALIGNED_SIZE || aligned.height !== ALIGNED_SIZE) {
    throw new Error(`Expected a ${ALIGNED_SIZE}x${ALIGNED_SIZE} crop, got ${aligned.width}x${aligned.height}`);
  }

  const session = await getEmbedder();
  const tensor = new ort.Tensor('float32', imageDataToTensor(aligned), [1, 3, ALIGNED_SIZE, ALIGNED_SIZE]);

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const result = await session.run({ [inputName]: tensor });

  const raw = result[outputName].data as Float32Array;
  if (raw.length !== EMBEDDING_DIM) {
    throw new Error(`Model returned ${raw.length} dimensions, expected ${EMBEDDING_DIM}`);
  }

  // Normalising here — not in the database — is what lets Postgres treat
  // cosine distance as a plain dot product.
  return l2Normalize(raw);
}

/** Warms the model so the first real capture is not the one that pays the 1-2 s load. */
export async function warmUpEmbedder(): Promise<void> {
  const session = await getEmbedder();
  const blank = new Float32Array(3 * ALIGNED_SIZE * ALIGNED_SIZE);
  const tensor = new ort.Tensor('float32', blank, [1, 3, ALIGNED_SIZE, ALIGNED_SIZE]);
  await session.run({ [session.inputNames[0]]: tensor });
}
