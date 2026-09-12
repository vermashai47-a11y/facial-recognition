#!/usr/bin/env node
/**
 * Puts the three things the browser needs into public/:
 *
 *   public/models/mediapipe/wasm/         copied from node_modules  (~5 MB)
 *   public/models/mediapipe/face_landmarker.task   downloaded       (~3.8 MB)
 *   public/models/recognition/w600k_mbf.onnx       downloaded       (~13 MB)
 *   public/ort/                            copied from node_modules (~12 MB)
 *
 * Model weights are deliberately not committed to git. Two of the four are just
 * copies out of node_modules, so the only real network dependency is the two
 * model files — and each has several mirrors below.
 *
 * Run:  npm run fetch:models
 *       npm run fetch:models -- --force     re-download even if present
 *       npm run fetch:models -- --full      also copy the WebGPU + non-SIMD
 *                                           runtimes (+39 MB, needs a paid plan
 *                                           or self-hosting to stay in limits)
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat, cp, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const args = new Set(process.argv.slice(2));
const QUIET = args.has('--quiet');
const FORCE = args.has('--force');

const log = (...a) => !QUIET && console.log(...a);
const warn = (...a) => console.warn(...a);

/** Files we download, each with mirrors tried in order. */
const DOWNLOADS = [
  {
    name: 'MediaPipe FaceLandmarker',
    dest: 'models/mediapipe/face_landmarker.task',
    minBytes: 2_000_000,
    urls: [
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task',
    ],
  },
  {
    name: 'ArcFace recogniser (buffalo_s / w600k_mbf)',
    dest: 'models/recognition/w600k_mbf.onnx',
    minBytes: 8_000_000,
    urls: [
      'https://huggingface.co/immich-app/buffalo_s/resolve/main/recognition/model.onnx?download=true',
      'https://huggingface.co/maze/faceX/resolve/main/w600k_mbf.onnx?download=true',
      'https://huggingface.co/garavv/arcface-onnx/resolve/main/w600k_mbf.onnx?download=true',
    ],
    manual:
      'Any 112x112 ArcFace ONNX export with a 512-d output works. Download\n' +
      '  InsightFace "buffalo_s" (https://github.com/deepinsight/insightface/tree/master/model_zoo),\n' +
      '  unzip it, and copy recognition/w600k_mbf.onnx to public/models/recognition/.',
  },
];

/**
 * Directories copied straight out of node_modules — no network involved.
 *
 * Both packages ship every backend variant they support, which together come to
 * ~130 MB. That matters: Vercel's Hobby plan caps static uploads at 100 MB, so
 * copying the lot would make the project undeployable on the free tier.
 *
 * The lean default keeps only what the app actually loads:
 *   ort-wasm-simd-threaded.{wasm,mjs}   14 MB  the WASM execution provider
 *   vision_wasm_internal.{wasm,js}      12 MB  MediaPipe's SIMD build
 *
 * `--full` additionally copies the WebGPU (jsep) provider and MediaPipe's
 * non-SIMD fallback, for ~+39 MB. Worth it only if you are self-hosting or on a
 * paid plan and want the extra speed on WebGPU-capable phones.
 */
const FULL = args.has('--full');

const ORT_FILES = FULL
  ? ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs',
     'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']
  : ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

const MP_FILES = FULL
  ? ['vision_wasm_internal.wasm', 'vision_wasm_internal.js',
     'vision_wasm_nosimd_internal.wasm', 'vision_wasm_nosimd_internal.js']
  : ['vision_wasm_internal.wasm', 'vision_wasm_internal.js'];

const COPIES = [
  {
    name: 'MediaPipe WASM runtime',
    from: 'node_modules/@mediapipe/tasks-vision/wasm',
    to: 'models/mediapipe/wasm',
    filter: (f) => MP_FILES.includes(f),
  },
  {
    name: 'onnxruntime-web WASM runtime',
    from: 'node_modules/onnxruntime-web/dist',
    to: 'ort',
    filter: (f) => ORT_FILES.includes(f),
  },
];

async function exists(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function download(entry) {
  const dest = path.join(PUBLIC, entry.dest);
  const current = await exists(dest);

  if (current && current.size >= entry.minBytes && !FORCE) {
    log(`  ✓ ${entry.name} already present (${mb(current.size)})`);
    return true;
  }

  await mkdir(path.dirname(dest), { recursive: true });

  for (const url of entry.urls) {
    try {
      log(`  … fetching ${entry.name}`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const tmp = `${dest}.part`;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));

      const got = await stat(tmp);
      if (got.size < entry.minBytes) {
        await rm(tmp, { force: true });
        throw new Error(`file too small (${got.size} bytes) — probably an error page`);
      }

      await cp(tmp, dest);
      await rm(tmp, { force: true });
      log(`  ✓ ${entry.name} (${mb(got.size)})  sha256:${(await sha256(dest)).slice(0, 12)}`);
      return true;
    } catch (err) {
      warn(`  ! ${new URL(url).host}: ${err.message}`);
    }
  }

  warn(`\n  ✗ Could not download ${entry.name}.`);
  if (entry.manual) warn(`    ${entry.manual}`);
  warn(`    Expected at: public/${entry.dest}\n`);
  return false;
}

async function copyRuntime(entry) {
  const from = path.join(ROOT, entry.from);
  const to = path.join(PUBLIC, entry.to);

  if (!(await exists(from))) {
    warn(`  ! ${entry.name}: ${entry.from} not found — run npm install first`);
    return false;
  }

  // Clear first: a previous `--full` run leaves files behind that the lean
  // build does not need, and they would still be uploaded at deploy time.
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });

  const available = await readdir(from);
  const files = available.filter(entry.filter ?? (() => true));

  const missing = (entry.filter ? [] : []).concat(
    entry.name.startsWith('onnx') ? ORT_FILES : entry.name.startsWith('MediaPipe') ? MP_FILES : [],
  ).filter((f) => !available.includes(f));
  if (missing.length > 0) {
    warn(`  ! ${entry.name}: expected files not in the package: ${missing.join(', ')}`);
  }

  let bytes = 0;
  for (const f of files) {
    const src = path.join(from, f);
    const info = await stat(src);
    if (!info.isFile()) continue;
    await cp(src, path.join(to, f));
    bytes += info.size;
  }

  log(`  ✓ ${entry.name} — ${files.length} files (${mb(bytes)})`);
  return true;
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/** `--check` reports what is present without touching the network. */
async function report() {
  console.log('\nModel assets:\n');
  let ok = true;

  for (const d of DOWNLOADS) {
    const info = await exists(path.join(PUBLIC, d.dest));
    const good = info && info.size >= d.minBytes;
    ok = ok && Boolean(good);
    console.log(`  ${good ? '✓' : '✗'} public/${d.dest}` + (info ? `  (${mb(info.size)})` : '  MISSING'));
  }

  for (const c of COPIES) {
    const dir = path.join(PUBLIC, c.to);
    const info = await exists(dir);
    const n = info ? (await readdir(dir)).length : 0;
    ok = ok && n > 0;
    console.log(`  ${n > 0 ? '✓' : '✗'} public/${c.to}/  (${n} files)`);
  }

  console.log(ok ? '\n  All present.\n' : '\n  Something is missing — run: npm run fetch:models\n');
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (args.has('--check')) return report();
  log('\nFetching browser model assets…\n');

  const results = [];
  for (const c of COPIES) results.push(await copyRuntime(c));
  for (const d of DOWNLOADS) results.push(await download(d));

  const failed = results.filter((r) => !r).length;

  // Always print one line, even under --quiet: during `npm install` a totally
  // silent step is indistinguishable from one that never ran, and the next
  // thing the user sees is a runtime error at capture time.
  if (failed === 0) {
    console.log(`face-attendance: model assets ready (${results.length}/${results.length}).`);
  }

  if (failed > 0) {
    warn(
      `\n${failed} asset(s) missing. The app will build and run, but face capture\n` +
        `will report "Could not load the recognition model" until they are in place.\n`,
    );
    // Never fail the install: a CI box without network should still build.
    process.exit(QUIET ? 0 : 1);
  }

  log('\nAll model assets ready.\n');
}

main().catch((err) => {
  warn(`fetch-models failed: ${err.message}`);
  process.exit(QUIET ? 0 : 1);
});
