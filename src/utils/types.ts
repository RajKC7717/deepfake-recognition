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
  MODEL_ERROR = 'MODEL_ERROR',
  
  // Video detection messages
  VIDEO_DETECTED = 'VIDEO_DETECTED',
  VIDEO_LOST = 'VIDEO_LOST',
  UPDATE_VIDEO_REGION = 'UPDATE_VIDEO_REGION'
}

export interface VideoRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  isPlaying: boolean;
}

export interface CaptureConfig {
  targetTabId: number;
  fps: number;
  quality: 'low' | 'medium' | 'high';
  videoRegion?: VideoRegion; // Optional video region to focus on
}

export interface FrameData {
  imageData: string;
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
  videoRegionDetected?: boolean; // NEW
}

export interface DetectionResult {
  frameNumber: number;
  timestamp: number;
  confidence: number;
  visualArtifactScore: number;
  temporalScore?: number;
  ppgScore?: number;
  faceDetected: boolean;
  faceCount: number;
  classification: 'real' | 'suspicious' | 'fake';
  threatLevel: 'safe' | 'warning' | 'danger';
  inferenceTime: number;
}

export interface ModelConfig {
  modelPath: string;
  inputSize: number;
  threshold: {
    safe: number;
    warning: number;
    danger: number;
  };
}