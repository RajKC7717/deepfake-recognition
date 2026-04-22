// Message types between different parts of extension
export interface Message {
  type: MessageType;
  data?: any;
}

export enum MessageType {
  // From popup/content → background
  START_CAPTURE = 'START_CAPTURE',
  STOP_CAPTURE  = 'STOP_CAPTURE',
  GET_STATUS    = 'GET_STATUS',

  // From background → offscreen
  INIT_OFFSCREEN = 'INIT_OFFSCREEN',
  BEGIN_STREAM   = 'BEGIN_STREAM',
  END_STREAM     = 'END_STREAM',

  /**
   * Background → offscreen: adjust capture rate.
   * data: { fps: number }
   *
   * Sent when:
   *   • The captured tab is switched away from (tab becomes inactive)  → fps = 1
   *   • The captured tab is switched back to (tab becomes active)      → fps = config.fps
   *   • The browser window loses OS focus                              → fps = 1
   *   • The browser window regains OS focus                            → fps = config.fps
   *
   * Added in Chunk 4.
   */
  THROTTLE_FPS = 'THROTTLE_FPS',

  // From offscreen → background
  OFFSCREEN_READY = 'OFFSCREEN_READY',
  FRAME_CAPTURED  = 'FRAME_CAPTURED',
  CAPTURE_ERROR   = 'CAPTURE_ERROR',

  // From background → popup/content
  STATUS_UPDATE    = 'STATUS_UPDATE',
  DETECTION_RESULT = 'DETECTION_RESULT',

  // AI Model related
  MODEL_LOADING = 'MODEL_LOADING',
  MODEL_READY   = 'MODEL_READY',
  MODEL_ERROR   = 'MODEL_ERROR',

  // Video detection messages
  VIDEO_DETECTED      = 'VIDEO_DETECTED',
  VIDEO_LOST          = 'VIDEO_LOST',
  UPDATE_VIDEO_REGION = 'UPDATE_VIDEO_REGION',
}

export interface VideoRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  isPlaying: boolean;
}

export interface CaptureConfig {
  targetTabId:     number;
  fps:             number;
  quality:         'low' | 'medium' | 'high';
  videoRegion?:    VideoRegion;
  // Chunk 2 — backend hybrid inference
  backendEnabled?: boolean;
  backendUrl?:     string;
}

export interface FrameData {
  imageData:   string;
  timestamp:   number;
  tabId:       number;
  frameNumber: number;
}

export interface DetectionStatus {
  isCapturing:          boolean;
  framesProcessed:      number;
  startTime?:           number;
  currentTab?:          number;
  modelLoaded?:         boolean;
  averageConfidence?:   number;
  videoRegionDetected?: boolean;
}

export interface DetectionResult {
  frameNumber:         number;
  timestamp:           number;

  /** Raw per-frame merged confidence (0 = real, 1 = fake). */
  confidence:          number;

  /**
   * EWMA-smoothed confidence from TemporalSmoother.
   * Use this for UI display — immune to single-frame spikes.
   * Added in Chunk 3.
   */
  smoothedConfidence?: number;

  /**
   * Signal consistency score (0–1). 1 = very stable, 0 = chaotic.
   * Added in Chunk 3.
   */
  stability?:          number;

  /**
   * Whether smoothed confidence is rising, falling, or flat
   * over the last 10 frames.
   * Added in Chunk 3.
   */
  trend?:              'rising' | 'falling' | 'stable';

  /**
   * How many consecutive frames have had no face detected.
   * 0 means a face was found this frame.
   * During the hold period (≤ 30): UI keeps last known threat level.
   * During decay (> 30): smoother slowly de-escalates.
   * Added in Chunk 4.
   */
  noFaceFrames?:       number;

  visualArtifactScore: number;
  temporalScore?:      number;
  ppgScore?:           number;
  faceDetected:        boolean;
  faceCount:           number;

  /**
   * Derived from smoother hysteresis state machine — NOT from raw score.
   * Immune to single-frame spikes.
   */
  classification:      'real' | 'suspicious' | 'fake';
  threatLevel:         'safe' | 'warning' | 'danger';

  inferenceTime:       number;
}

export interface ModelConfig {
  modelPath:  string;
  inputSize:  number;
  threshold: {
    safe:    number;
    warning: number;
    danger:  number;
  };
}