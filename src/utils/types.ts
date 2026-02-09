// Message types between different parts of extension
export interface Message {
  type: MessageType;
  data?: any;
}

export enum MessageType {
  // From popup/content → background
  START_CAPTURE = 'START_CAPTURE',
  STOP_CAPTURE = 'STOP_CAPTURE',
  GET_STATUS = 'GET_STATUS',
  
  // From background → offscreen
  INIT_OFFSCREEN = 'INIT_OFFSCREEN',
  BEGIN_STREAM = 'BEGIN_STREAM',
  END_STREAM = 'END_STREAM',
  
  // From offscreen → background
  OFFSCREEN_READY = 'OFFSCREEN_READY',
  FRAME_CAPTURED = 'FRAME_CAPTURED',
  CAPTURE_ERROR = 'CAPTURE_ERROR',
  
  // From background → popup/content
  STATUS_UPDATE = 'STATUS_UPDATE',
  DETECTION_RESULT = 'DETECTION_RESULT',
  
  // AI Model related
  MODEL_LOADING = 'MODEL_LOADING',
  MODEL_READY = 'MODEL_READY',
  MODEL_ERROR = 'MODEL_ERROR'
}

export interface CaptureConfig {
  targetTabId: number;
  fps: number; // Frames per second to analyze (not capture)
  quality: 'low' | 'medium' | 'high';
}

export interface FrameData {
  imageData: string; // Base64 encoded image
  timestamp: number;
  tabId: number;
  frameNumber: number;
}

export interface DetectionStatus {
  isCapturing: boolean;
  framesProcessed: number;
  startTime?: number;
  currentTab?: number;
  modelLoaded?: boolean;
  averageConfidence?: number;
}

// AI Detection Result
export interface DetectionResult {
  frameNumber: number;
  timestamp: number;
  
  // Overall confidence (0-1, higher = more likely deepfake)
  confidence: number;
  
  // Individual scores
  visualArtifactScore: number;  // GAN fingerprints
  temporalScore?: number;        // Frame consistency (needs history)
  ppgScore?: number;             // Heart rate detection (future)
  
  // Face detection
  faceDetected: boolean;
  faceCount: number;
  
  // Classification
  classification: 'real' | 'suspicious' | 'fake';
  threatLevel: 'safe' | 'warning' | 'danger';
  
  // Performance metrics
  inferenceTime: number; // ms
}

// Model configuration
export interface ModelConfig {
  modelPath: string;
  inputSize: number;
  threshold: {
    safe: number;      // < 0.3 = safe
    warning: number;   // 0.3-0.7 = suspicious
    danger: number;    // > 0.7 = fake
  };
}