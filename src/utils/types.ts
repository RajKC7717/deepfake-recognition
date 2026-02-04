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
  DETECTION_RESULT = 'DETECTION_RESULT'
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
}