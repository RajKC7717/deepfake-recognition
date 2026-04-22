/**
 * src/offscreen/offscreen.ts  —  Chunk 4 (Edge Cases & Polish)
 * =============================================================
 *
 * Changes vs Chunk 3:
 *
 * 1. NO-FACE BUG FIX (critical)
 *    Before: no-face frame sent smoothedConfidence=0, threatLevel='safe'
 *    → UI would snap to 100% authentic on ANY head turn, even mid-DANGER.
 *    After: two-phase strategy:
 *      Hold phase  (noFaceFrames ≤ 30): smoother.peek() — state frozen,
 *        UI keeps last known threat level, no buffer pollution.
 *      Decay phase (noFaceFrames  > 30): smoother.update(DECAY_INPUT=0.05)
 *        — gradually feeds low confidence so state machine naturally
 *        de-escalates after ~10-15 decay frames, rather than holding
 *        DANGER forever when someone leaves the call entirely.
 *
 * 2. FPS THROTTLE (THROTTLE_FPS message)
 *    setFps(fps) restarts the setInterval at the requested rate.
 *    Background sends this when the captured tab is switched away from
 *    (drops to 1 FPS) or switched back to (restores to config.fps).
 *    Saves CPU/battery on backgrounded calls.
 *
 * 3. ERROR BACKOFF
 *    After ERROR_BACKOFF_THRESHOLD consecutive frame errors, capture
 *    is temporarily slowed to 1 FPS for 10 seconds, then auto-restored.
 *    Prevents tight error loops hammering the model when video format
 *    is broken.
 *
 * 4. MULTI-FACE CONFIDENCE ADJUSTMENT
 *    When BlazeFace detects more than one face in the frame, we apply
 *    a small multiplier (MULTI_FACE_MULTIPLIER = 1.15) to the raw score.
 *    Rationale: deepfake video calls commonly show one primary face;
 *    having multiple face detections may indicate a composited stream.
 *    The adjustment is mild and capped at 1.0.
 */

import { MessageType, CaptureConfig, DetectionResult, VideoRegion } from '../utils/types';
import { DeepfakeDetectorModel }  from '../utils/ai-model';
import { FaceDetector }           from '../utils/face-detector';
import { BackendClient }          from '../utils/backend-client';
import { TemporalSmoother }       from '../utils/temporal-smoother';
import { createLogger }           from '../utils/logger';

const logger = createLogger('Offscreen');
logger.info('🎬 Offscreen Video Processor Loaded');

// ─── DOM ──────────────────────────────────────────────────────────────────────
const video     = document.getElementById('video')  as HTMLVideoElement;
const canvas    = document.getElementById('canvas') as HTMLCanvasElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;

const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

const faceCanvas = document.createElement('canvas');
const faceCtx    = faceCanvas.getContext('2d', { willReadFrequently: true })!;

// ─── AI + smoother ────────────────────────────────────────────────────────────
const aiModel      = new DeepfakeDetectorModel();
const faceDetector = new FaceDetector();

const smoother = new TemporalSmoother(30, 0.25);

// ─── Backend client ───────────────────────────────────────────────────────────
let backendClient: BackendClient | null = null;

// ─── Edge-case constants (Chunk 4) ────────────────────────────────────────────

/**
 * No-face hold phase: how many consecutive no-face frames before we
 * start feeding decay values into the smoother.
 * At 5 FPS → 30 frames ≈ 6 seconds.  At 1 FPS (throttled) → 30 seconds.
 */
const NO_FACE_HOLD_FRAMES = 30;

/**
 * Confidence value fed to smoother during the decay phase.
 * Small positive value (not zero) so the EWMA fades gradually
 * rather than snapping. At alpha=0.25, starting from EWMA=0.8:
 *   after 5 decay frames  → ~0.36  (crosses exitDanger=0.45 at ~frame 4)
 *   after 10 decay frames → ~0.19  (crosses exitWarning=0.22 at ~frame 8)
 * Combined with de-escalation counters (14 frames, 8 frames), the full
 * journey from DANGER→SAFE takes ~35-40 decay frames ≈ 7-8 seconds at 5fps.
 */
const NO_FACE_DECAY_INPUT = 0.05;

/**
 * Mild confidence multiplier when multiple faces are detected.
 * Applied BEFORE the smoother, capped at 1.0.
 */
const MULTI_FACE_MULTIPLIER = 1.15;

/**
 * After this many consecutive frame errors, back off to 1 FPS for
 * ERROR_BACKOFF_DURATION_MS before auto-restoring.
 */
const ERROR_BACKOFF_THRESHOLD   = 10;
const ERROR_BACKOFF_DURATION_MS = 10_000;

// ─── State ────────────────────────────────────────────────────────────────────
let mediaStream:   MediaStream | null   = null;
let captureInterval: number | null      = null;
let config:        CaptureConfig | null = null;
let frameCounter   = 0;
let isInitialized  = false;
let initPromise:   Promise<void> | null = null;

let currentVideoRegion: VideoRegion | null = null;

let totalInferenceTime = 0;
let framesSinceLog     = 0;

// ── Chunk 4 state ─────────────────────────────────────────────────────────────

/** How many consecutive frames have had no face detected. Reset to 0 on face found. */
let consecutiveNoFaceFrames = 0;

/** How many consecutive frames have thrown an exception. Reset to 0 on success. */
let consecutiveErrorFrames  = 0;

/** Currently active FPS (may differ from config.fps when throttled). */
let configuredFps: number = 5;

/** True when the error-backoff timer is running. */
let errorBackoffActive = false;

// ─── Boot ─────────────────────────────────────────────────────────────────────
initPromise = initAI();

async function initAI() {
  try {
    updateStatus('⏳ Loading AI models...');
    await Promise.all([aiModel.initialize(), faceDetector.initialize()]);
    isInitialized = true;
    updateStatus('✅ AI Ready — waiting for stream...');
    chrome.runtime.sendMessage({
      type: MessageType.MODEL_READY,
      data: { backend: aiModel.getBackend() },
    }).catch(() => {});
    logger.info('✅ AI initialized');
  } catch (err) {
    logger.error('AI init failed:', err);
    updateStatus('❌ AI init failed: ' + (err as Error).message);
    chrome.runtime.sendMessage({
      type: MessageType.MODEL_ERROR,
      data: { error: (err as Error).message },
    }).catch(() => {});
    throw err;
  }
}

// ─── Messages ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  logger.debug('Offscreen received:', message.type);

  switch (message.type) {

    case MessageType.BEGIN_STREAM: {
      const start = async () => {
        if (!isInitialized) await initPromise;
        await beginCapture(message.data.streamId, message.data.config);
      };
      start().catch(e => logger.error('beginCapture failed:', e));
      sendResponse({ success: true });
      break;
    }

    case MessageType.END_STREAM:
      endCapture();
      sendResponse({ success: true });
      break;

    case MessageType.UPDATE_VIDEO_REGION:
      currentVideoRegion = message.data as VideoRegion;
      logger.info('📐 Region updated:', `${currentVideoRegion.width}x${currentVideoRegion.height}`);
      sendResponse({ success: true });
      break;

    // ── Chunk 4: FPS throttle ────────────────────────────────────────────────
    case MessageType.THROTTLE_FPS: {
      const fps = (message.data as { fps: number }).fps;
      setFps(fps);
      sendResponse({ success: true });
      break;
    }

    case MessageType.GET_STATUS:
      sendResponse({ isCapturing: captureInterval !== null, frameCounter, isInitialized });
      break;

    default:
      sendResponse({ success: false });
  }
  return false;
});

// ─── Capture ──────────────────────────────────────────────────────────────────
async function beginCapture(streamId: string, cfg: CaptureConfig) {
  logger.info('🎥 beginCapture, streamId:', streamId);
  if (!isInitialized) await initPromise;

  config        = cfg;
  configuredFps = cfg.fps;

  if (cfg.backendEnabled && cfg.backendUrl) {
    backendClient = new BackendClient(cfg.backendUrl);
    const online  = await backendClient.checkHealth();
    if (online) {
      logger.info('🔌 Backend online:', cfg.backendUrl, '— dual-inference mode ACTIVE');
    } else {
      logger.warn('⚠ Backend unreachable — TFjs-only mode');
      backendClient = null;
    }
  }

  if (cfg.videoRegion) {
    currentVideoRegion = cfg.videoRegion as VideoRegion;
    logger.info('Using video region from config:', `${currentVideoRegion.width}x${currentVideoRegion.height}`);
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource:   'tab',
        chromeMediaSourceId: streamId,
      },
    } as any,
  });

  video.srcObject = mediaStream;
  await video.play();

  await new Promise<void>((resolve) => {
    const check = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        logger.info(`📺 Video ready: ${video.videoWidth}x${video.videoHeight}`);
        resolve();
      } else {
        video.addEventListener('loadedmetadata', () => {
          logger.info(`📺 Metadata loaded: ${video.videoWidth}x${video.videoHeight}`);
          resolve();
        }, { once: true });
      }
    };
    check();
  });

  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;

  updateStatus(currentVideoRegion
    ? `🔴 ACTIVE — region ${currentVideoRegion.width}x${currentVideoRegion.height}`
    : '🔴 ACTIVE — full screen');

  startFrameLoop();
}

/**
 * Start (or restart) the capture loop at configuredFps.
 * Calling this while the loop is running replaces the old interval.
 */
function startFrameLoop() {
  if (!config) return;
  setFps(configuredFps);
  logger.info(`⏱ Frame loop started at ${configuredFps} FPS`);
  totalInferenceTime = 0;
  framesSinceLog     = 0;
}

// ─── FPS control (Chunk 4) ────────────────────────────────────────────────────

/**
 * Restart the capture interval at the requested FPS.
 *
 * @param fps         Desired capture rate.
 * @param isTemporary If true, does NOT update configuredFps so
 *                    restoring normal rate later still works.
 *                    (Used by the error-backoff path.)
 */
function setFps(fps: number, isTemporary = false): void {
  if (!isTemporary) configuredFps = fps;

  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  captureInterval = window.setInterval(analyzeFrame, 1000 / fps);
  logger.info(`⏱ FPS → ${fps}${isTemporary ? ' (temporary)' : ''}`);
}

// ─── Per-frame analysis ───────────────────────────────────────────────────────
async function analyzeFrame() {
  if (!video.videoWidth || !video.videoHeight) {
    logger.debug('Video not ready, skipping frame');
    return;
  }

  frameCounter++;
  framesSinceLog++;

  try {
    // ── Step 1: draw full frame ─────────────────────────────────────────────
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // ── Step 2: face detection ──────────────────────────────────────────────
    const faceResult = await detectFaceOnCanvas(canvas);

    // ── NO FACE BRANCH ──────────────────────────────────────────────────────
    if (!faceResult.detected || !faceResult.croppedImageData) {
      consecutiveNoFaceFrames++;
      handleNoFaceFrame();
      // Success path reached — reset error counter
      consecutiveErrorFrames = 0;
      return;
    }

    // Face found — reset no-face counter
    consecutiveNoFaceFrames = 0;

    // ── Step 3: inference (TFjs + optional backend in parallel) ────────────
    const tAI = performance.now();
    const [ai, backendResult] = await Promise.all([
      aiModel.detect(faceResult.croppedImageData),
      backendClient?.analyze(faceCanvas, frameCounter) ?? Promise.resolve(null),
    ]);
    totalInferenceTime += performance.now() - tAI;

    // ── Step 4: merge scores ────────────────────────────────────────────────
    let rawMerged = mergeScores(ai.confidence, backendResult?.combinedScore ?? null);

    // ── Step 5: multi-face adjustment (Chunk 4) ─────────────────────────────
    // When multiple faces are present, apply a mild confidence boost.
    // This handles composited streams where a fake face is placed alongside
    // a real one — both contribute to a slightly elevated risk signal.
    if (faceResult.count > 1) {
      rawMerged = Math.min(1.0, rawMerged * MULTI_FACE_MULTIPLIER);
      logger.debug(`Multi-face (${faceResult.count} faces) → confidence boosted to ${rawMerged.toFixed(3)}`);
    }

    // ── Step 6: temporal smoothing ──────────────────────────────────────────
    const smoothed = smoother.update(rawMerged);

    // ── Step 7: send result ─────────────────────────────────────────────────
    sendResult({
      frameNumber:         frameCounter,
      timestamp:           Date.now(),
      confidence:          rawMerged,
      smoothedConfidence:  smoothed.smoothed,
      stability:           smoothed.stability,
      trend:               smoothed.trend,
      noFaceFrames:        0,
      visualArtifactScore: ai.visualArtifactScore,
      temporalScore:       backendResult?.temporalScore,
      ppgScore:            backendResult?.ppgScore,
      faceDetected:        true,
      faceCount:           faceResult.count,
      classification:      smoothed.classification,
      threatLevel:         smoothed.threatLevel,
      inferenceTime:       ai.inferenceTime,
    });

    // ── Perf log every 30 frames ────────────────────────────────────────────
    if (framesSinceLog >= 30) {
      const mode = backendResult ? 'dual' : 'TFjs';
      logger.info(
        `📊 avg ${(totalInferenceTime / framesSinceLog).toFixed(1)}ms/frame` +
        ` | frame=${frameCounter} | mode=${mode}` +
        ` | level=${smoother.currentLevel} | s=${smoothed.smoothed.toFixed(3)}` +
        ` | fps=${configuredFps}`,
      );
      totalInferenceTime = 0;
      framesSinceLog     = 0;
    }

    if (frameCounter % 10 === 0) {
      const score = ((1 - smoothed.smoothed) * 100).toFixed(0);
      updateStatus(`🔴 Frame ${frameCounter} | ${score}% real | ${ai.inferenceTime.toFixed(0)}ms`);
    }

    // Reset error counter on success
    consecutiveErrorFrames = 0;

  } catch (err) {
    logger.error('Frame error:', err);
    handleFrameError();
  }
}

// ─── No-face handling (Chunk 4) ───────────────────────────────────────────────

/**
 * Two-phase no-face strategy.
 *
 * Phase 1 — Hold (noFaceFrames ≤ NO_FACE_HOLD_FRAMES):
 *   The smoother is not advanced. smoother.peek() returns the last computed
 *   SmoothedResult with no side-effects. The UI keeps the last known threat
 *   level. This handles: head turns, momentary occlusions, lighting flashes.
 *
 * Phase 2 — Decay (noFaceFrames > NO_FACE_HOLD_FRAMES):
 *   We feed a small neutral value (0.05) into the smoother each frame.
 *   The EWMA fades gradually, and the hysteresis state machine's de-escalation
 *   counters increment naturally. This handles: person leaving the call,
 *   camera cut to screenshare, etc. — where holding DANGER forever would
 *   be wrong.
 *
 * Timeline from DANGER at 5 FPS (approximately):
 *   Frames  0–30  (0–6s):   Hold at DANGER  — no change
 *   Frames 31–44  (6–9s):   Decay feeds start; EWMA crosses exitDanger (0.45)
 *   Frames 44–58  (9–12s):  14-frame de-escalation counter reaches threshold
 *   Frame  58     (~12s):   Level drops to WARNING
 *   (Similar journey from WARNING → SAFE takes another ~20 frames)
 */
function handleNoFaceFrame(): void {
  let currentState;

  if (consecutiveNoFaceFrames <= NO_FACE_HOLD_FRAMES) {
    // Phase 1: freeze the smoother, read without advancing
    currentState = smoother.peek();

    if (consecutiveNoFaceFrames === 1) {
      logger.debug(`Face lost — holding smoother state (level=${smoother.currentLevel})`);
    }
  } else {
    // Phase 2: slowly decay toward safe
    currentState = smoother.update(NO_FACE_DECAY_INPUT);

    if (consecutiveNoFaceFrames === NO_FACE_HOLD_FRAMES + 1) {
      logger.info(`Face absent for ${NO_FACE_HOLD_FRAMES} frames — starting decay`);
    }
  }

  sendResult({
    frameNumber:         frameCounter,
    timestamp:           Date.now(),
    confidence:          0,
    smoothedConfidence:  currentState.smoothed,    // locked / decaying — NOT 0
    stability:           currentState.stability,
    trend:               currentState.trend,
    noFaceFrames:        consecutiveNoFaceFrames,
    visualArtifactScore: 0,
    faceDetected:        false,
    faceCount:           0,
    classification:      currentState.classification,  // locked / decaying
    threatLevel:         currentState.threatLevel,      // locked / decaying
    inferenceTime:       0,
  });

  if (consecutiveNoFaceFrames % 30 === 0) {
    logger.debug(`No face for ${consecutiveNoFaceFrames} frames | level=${smoother.currentLevel}`);
  }
}

// ─── Error backoff (Chunk 4) ──────────────────────────────────────────────────

/**
 * After ERROR_BACKOFF_THRESHOLD consecutive errors, temporarily drop to 1 FPS
 * for ERROR_BACKOFF_DURATION_MS then auto-restore.
 *
 * Prevents tight error loops (e.g. broken video format, OOM) from spinning
 * the model at full FPS while producing no useful output.
 */
function handleFrameError(): void {
  consecutiveErrorFrames++;

  if (consecutiveErrorFrames >= ERROR_BACKOFF_THRESHOLD && !errorBackoffActive) {
    errorBackoffActive = true;
    logger.warn(
      `⚠ ${ERROR_BACKOFF_THRESHOLD} consecutive errors — slowing to 1 FPS for ${ERROR_BACKOFF_DURATION_MS / 1000}s`,
    );
    setFps(1, /* isTemporary */ true);

    window.setTimeout(() => {
      if (captureInterval) {
        // Only restore if still capturing (user hasn't stopped in the meantime)
        logger.info('🔄 Error backoff lifted — restoring FPS to', configuredFps);
        setFps(configuredFps, false);
      }
      consecutiveErrorFrames = 0;
      errorBackoffActive     = false;
    }, ERROR_BACKOFF_DURATION_MS);
  }
}

// ─── Score merging ────────────────────────────────────────────────────────────

function mergeScores(tfjsScore: number, backendScore: number | null): number {
  if (backendScore === null) return tfjsScore;
  return 0.35 * tfjsScore + 0.65 * backendScore;
}

// ─── Face detection on canvas ─────────────────────────────────────────────────
async function detectFaceOnCanvas(sourceCanvas: HTMLCanvasElement): Promise<{
  detected: boolean;
  count: number;
  croppedImageData?: ImageData;
}> {
  try {
    const result = await faceDetector.detectFacesOnCanvas(sourceCanvas);

    if (!result.detected || !result.boundingBox) {
      return { detected: false, count: 0 };
    }

    const bb  = result.boundingBox;
    const pad = 0.20;
    const pw  = bb.width  * (1 + pad);
    const ph  = bb.height * (1 + pad);
    const px  = Math.max(0, bb.x - (pw - bb.width)  / 2);
    const py  = Math.max(0, bb.y - (ph - bb.height) / 2);

    const sx = Math.max(0, Math.floor(px));
    const sy = Math.max(0, Math.floor(py));
    const sw = Math.min(Math.floor(pw), sourceCanvas.width  - sx);
    const sh = Math.min(Math.floor(ph), sourceCanvas.height - sy);

    if (sw < 10 || sh < 10) return { detected: false, count: 0 };

    faceCanvas.width  = 256;
    faceCanvas.height = 256;
    faceCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, 256, 256);

    return {
      detected:          true,
      count:             result.count,
      croppedImageData:  faceCtx.getImageData(0, 0, 256, 256),
    };
  } catch (err) {
    logger.error('detectFaceOnCanvas error:', err);
    return { detected: false, count: 0 };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendResult(result: DetectionResult) {
  chrome.runtime.sendMessage({ type: MessageType.FRAME_CAPTURED, data: result }).catch(() => {});
}

function endCapture() {
  logger.info('🛑 endCapture');
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  if (mediaStream)     { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }

  video.srcObject          = null;
  frameCounter             = 0;
  config                   = null;
  currentVideoRegion       = null;
  totalInferenceTime       = 0;
  framesSinceLog           = 0;
  backendClient            = null;
  consecutiveNoFaceFrames  = 0;
  consecutiveErrorFrames   = 0;
  errorBackoffActive       = false;

  smoother.reset();
  logger.info('🔄 Temporal smoother reset');

  updateStatus('⏸️ Stopped');
}

function updateStatus(text: string) {
  statusDiv.textContent = text;
}

updateStatus('⏳ Initializing AI...');