/** Where the fetch-models script puts things, relative to the site root. */
export const MODEL_PATHS = {
  mediapipeWasm: '/models/mediapipe/wasm',
  faceLandmarker: '/models/mediapipe/face_landmarker.task',
  recognizer: '/models/recognition/w600k_mbf.onnx',
  ortWasm: '/ort/',
} as const;

export const EMBEDDING_DIM = 512;
export const MODEL_VERSION = 'w600k_mbf@1';

/**
 * MediaPipe FaceLandmarker emits 478 points. These are the ones we care about.
 * Names follow MediaPipe's own convention, which is from the *subject's*
 * point of view — so `LEFT_IRIS` lands on the right-hand side of a
 * non-mirrored image. We never rely on that: `extractFiveLandmarks` sorts by
 * x so the five points always come out in image order.
 */
export const LM = {
  LEFT_IRIS: 468,
  RIGHT_IRIS: 473,
  LEFT_EYE_OUTER: 33,
  LEFT_EYE_INNER: 133,
  RIGHT_EYE_INNER: 362,
  RIGHT_EYE_OUTER: 263,
  NOSE_TIP: 1,
  MOUTH_LEFT: 61,
  MOUTH_RIGHT: 291,
  CHIN: 152,
  FOREHEAD: 10,
} as const;

/** Blendshape channel names we read out of the 52-category output. */
export const BS = {
  blinkLeft: 'eyeBlinkLeft',
  blinkRight: 'eyeBlinkRight',
  smileLeft: 'mouthSmileLeft',
  smileRight: 'mouthSmileRight',
  jawOpen: 'jawOpen',
  browUpLeft: 'browOuterUpLeft',
  browUpRight: 'browOuterUpRight',
  squintLeft: 'eyeSquintLeft',
  squintRight: 'eyeSquintRight',
} as const;

/** Capture gating. Tuned for a hand-held phone at arm's length. */
export const QUALITY = {
  minFaceRatio: 0.18, // face box width / frame width
  maxFaceRatio: 0.85,
  maxYawDeg: 22,
  maxPitchDeg: 20,
  maxRollDeg: 18,
  minSharpness: 55, // variance of Laplacian on the aligned crop
  minBrightness: 55,
  maxBrightness: 205,
  maxBlinkAtCapture: 0.45,
} as const;
