import { MessageType, CaptureConfig, DetectionResult, VideoRegion } from '../utils/types';
import { DeepfakeDetectorModel } from '../utils/ai-model';
import { FaceDetector } from '../utils/face-detector';
import { createLogger } from '../utils/logger';

const logger = createLogger('Offscreen');
logger.info('🎬 Offscreen Video Processor Loaded');

// ─── DOM ──────────────────────────────────────────────────────────────────────
const video     = document.getElementById('video')  as HTMLVideoElement;
const canvas    = document.getElementById('canvas') as HTMLCanvasElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;

// We use ONE canvas for all drawing — no clientWidth dependency
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

// Separate small canvas for face cropping (passed to AI)
const faceCanvas = document.createElement('canvas');
const faceCtx    = faceCanvas.getContext('2d', { willReadFrequently: true })!;

// ─── AI ───────────────────────────────────────────────────────────────────────
const aiModel      = new DeepfakeDetectorModel();
const faceDetector = new FaceDetector();

// ─── State ────────────────────────────────────────────────────────────────────
let mediaStream:   MediaStream | null  = null;
let captureInterval: number | null     = null;
let config:        CaptureConfig | null = null;
let frameCounter   = 0;
let isInitialized  = false;
let initPromise:   Promise<void> | null = null;

let currentVideoRegion: VideoRegion | null = null;
let lastRegionUpdate = 0;
const REGION_TTL = 30_000;

let totalInferenceTime = 0;
let framesSinceLog     = 0;

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
      data: { backend: aiModel.getBackend() }
    }).catch(() => {});
    logger.info('✅ AI initialized');
  } catch (err) {
    logger.error('AI init failed:', err);
    updateStatus('❌ AI init failed: ' + (err as Error).message);
    chrome.runtime.sendMessage({
      type: MessageType.MODEL_ERROR,
      data: { error: (err as Error).message }
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
      lastRegionUpdate   = Date.now();
      logger.info('📐 Region updated:', `${currentVideoRegion.width}x${currentVideoRegion.height}`);
      sendResponse({ success: true });
      break;

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

  config = cfg;
  if (cfg.videoRegion) {
    currentVideoRegion = cfg.videoRegion as VideoRegion;
    lastRegionUpdate   = Date.now();
    logger.info('Using video region from config:', `${currentVideoRegion.width}x${currentVideoRegion.height}`);
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource:   'tab',
        chromeMediaSourceId: streamId,
      }
    } as any,
  });

  video.srcObject = mediaStream;
  await video.play();

  // Wait for video dimensions to be available
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

  // Set canvas to actual video resolution
  canvas.width  = video.videoWidth;
  canvas.height = video.videoHeight;

  updateStatus(currentVideoRegion
    ? `🔴 ACTIVE — region ${currentVideoRegion.width}x${currentVideoRegion.height}`
    : '🔴 ACTIVE — full screen');

  startFrameLoop();
}

function startFrameLoop() {
  if (!config) return;
  const ms = 1000 / config.fps;
  logger.info(`⏱ Frame loop: ${config.fps} FPS`);
  totalInferenceTime = 0;
  framesSinceLog     = 0;
  captureInterval    = window.setInterval(analyzeFrame, ms);
}

// ─── Per-frame analysis ───────────────────────────────────────────────────────
async function analyzeFrame() {
  // Guard: video must have real dimensions
  if (!video.videoWidth || !video.videoHeight) {
    logger.debug('Video not ready yet, skipping frame');
    return;
  }

  frameCounter++;
  framesSinceLog++;
  const t0 = performance.now();

  try {
    // ── Step 1: draw full frame to main canvas ───────────────────────────────
    // Always draw full frame first — this is what BlazeFace will run on
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // ── Step 2: detect face directly on the canvas ───────────────────────────
    // KEY FIX: We pass the canvas (not the video element) to BlazeFace.
    // The video element in the offscreen doc has clientWidth=0 (hidden doc),
    // which broke coordinate scaling in the old cropFace() method.
    // Using the canvas gives us a real, sized ImageBitmap to work with.
    const faceResult = await detectFaceOnCanvas(canvas);

    if (!faceResult.detected || !faceResult.croppedImageData) {
      // No face found — still send a result so frameCounter updates in popup
      sendResult({
        frameNumber:         frameCounter,
        timestamp:           Date.now(),
        confidence:          0,
        visualArtifactScore: 0,
        faceDetected:        false,
        faceCount:           0,
        classification:      'real',
        threatLevel:         'safe',
        inferenceTime:       0,
      });

      if (frameCounter % 30 === 0) {
        logger.debug(`Frame ${frameCounter}: no face detected`);
      }
      return;
    }

    // ── Step 3: run AI on cropped face ───────────────────────────────────────
    const tAI  = performance.now();
    const ai   = await aiModel.detect(faceResult.croppedImageData);
    totalInferenceTime += performance.now() - tAI;

    // ── Step 4: classify ─────────────────────────────────────────────────────
    const cls = classify(ai.confidence);

    sendResult({
      frameNumber:         frameCounter,
      timestamp:           Date.now(),
      confidence:          ai.confidence,
      visualArtifactScore: ai.visualArtifactScore,
      faceDetected:        true,
      faceCount:           faceResult.count,
      classification:      cls.type,
      threatLevel:         cls.level,
      inferenceTime:       ai.inferenceTime,
    });

    // ── Perf log every 30 frames ─────────────────────────────────────────────
    if (framesSinceLog >= 30) {
      logger.info(`📊 Perf: avg ${(totalInferenceTime / framesSinceLog).toFixed(1)}ms/frame | frame=${frameCounter} | face=${faceResult.count}`);
      totalInferenceTime = 0;
      framesSinceLog     = 0;
    }

    if (frameCounter % 10 === 0) {
      const score = ((1 - ai.confidence) * 100).toFixed(0);
      updateStatus(`🔴 Frame ${frameCounter} | ${score}% real | ${ai.inferenceTime.toFixed(0)}ms`);
    }

  } catch (err) {
    logger.error('Frame error:', err);
  }
}

// ─── Face detection on canvas (THE FIX) ──────────────────────────────────────
/**
 * Run BlazeFace on the already-drawn canvas instead of the video element.
 *
 * WHY: The offscreen document's <video> has clientWidth=0 / clientHeight=0
 * because it lives in a hidden document. The old face-detector.ts used
 * clientWidth/clientHeight for scaling the crop coordinates, producing
 * Infinity or 0-sized crops → face never detected → frames always 0.
 *
 * FIX: Draw video→canvas first, then run detection on the canvas.
 * Canvas always has correct pixel dimensions (videoWidth × videoHeight).
 */
async function detectFaceOnCanvas(sourceCanvas: HTMLCanvasElement): Promise<{
  detected: boolean;
  count: number;
  croppedImageData?: ImageData;
}> {
  try {
    // Run BlazeFace on our already-drawn canvas
    const result = await faceDetector.detectFacesOnCanvas(sourceCanvas);

    if (!result.detected || !result.boundingBox) {
      return { detected: false, count: 0 };
    }

    const bb = result.boundingBox;

    // Add 20% padding around the face
    const pad = 0.20;
    const pw  = bb.width  * (1 + pad);
    const ph  = bb.height * (1 + pad);
    const px  = Math.max(0, bb.x - (pw - bb.width)  / 2);
    const py  = Math.max(0, bb.y - (ph - bb.height) / 2);

    // Clamp to canvas bounds
    const sx = Math.max(0, Math.floor(px));
    const sy = Math.max(0, Math.floor(py));
    const sw = Math.min(Math.floor(pw), sourceCanvas.width  - sx);
    const sh = Math.min(Math.floor(ph), sourceCanvas.height - sy);

    if (sw < 10 || sh < 10) return { detected: false, count: 0 };

    // Crop face to faceCanvas at 224×224 (model input size)
    faceCanvas.width  = 224;
    faceCanvas.height = 224;
    faceCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, 224, 224);

    const croppedImageData = faceCtx.getImageData(0, 0, 224, 224);

    return {
      detected:         true,
      count:            result.count,
      croppedImageData,
    };
  } catch (err) {
    logger.error('detectFaceOnCanvas error:', err);
    return { detected: false, count: 0 };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function classify(c: number): { type: 'real' | 'suspicious' | 'fake'; level: 'safe' | 'warning' | 'danger' } {
  if (c < 0.3) return { type: 'real',       level: 'safe'    };
  if (c < 0.7) return { type: 'suspicious', level: 'warning' };
  return              { type: 'fake',       level: 'danger'  };
}

function sendResult(result: DetectionResult) {
  chrome.runtime.sendMessage({ type: MessageType.FRAME_CAPTURED, data: result }).catch(() => {});
}

function endCapture() {
  logger.info('🛑 endCapture');
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  if (mediaStream)     { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  video.srcObject    = null;
  frameCounter       = 0;
  config             = null;
  currentVideoRegion = null;
  totalInferenceTime = 0;
  framesSinceLog     = 0;
  updateStatus('⏸️ Stopped');
}

function updateStatus(text: string) {
  statusDiv.textContent = text;
}

updateStatus('⏳ Initializing AI...');