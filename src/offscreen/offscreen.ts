import { MessageType, CaptureConfig, DetectionResult } from '../utils/types';
import { DeepfakeDetectorModel } from '../utils/ai-model';
import { FaceDetector } from '../utils/face-detector';
import { createLogger } from '../utils/logger';

const logger = createLogger('Offscreen');

logger.info('🎬 Offscreen Video Processor Loaded');

// DOM elements
const video = document.getElementById('video') as HTMLVideoElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

// AI Components
const aiModel = new DeepfakeDetectorModel();
const faceDetector = new FaceDetector();

// State
let mediaStream: MediaStream | null = null;
let captureInterval: number | null = null;
let config: CaptureConfig | null = null;
let frameCounter = 0;
let isInitialized = false;
let initializationPromise: Promise<void> | null = null;

// Initialize AI models on load
initializationPromise = initializeAI();

async function initializeAI() {
  try {
    updateStatus('⏳ Loading AI models...');
    
    logger.info('Initializing AI components...');
    
    // Initialize in parallel
    await Promise.all([
      aiModel.initialize(),
      faceDetector.initialize()
    ]);
    
    isInitialized = true;
    updateStatus('✅ AI Ready - Waiting for stream...');
    
    // Notify background that models are ready
    chrome.runtime.sendMessage({
      type: MessageType.MODEL_READY,
      data: { backend: aiModel.getBackend() }
    }).catch(() => {});
    
    logger.info('✅ All AI components initialized');
    
  } catch (error) {
    logger.error('Failed to initialize AI:', error);
    updateStatus('❌ AI initialization failed');
    
    chrome.runtime.sendMessage({
      type: MessageType.MODEL_ERROR,
      data: { error: (error as Error).message }
    }).catch(() => {});
    
    throw error;
  }
}

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.debug('Offscreen received:', message.type);
  
  switch (message.type) {
    case MessageType.BEGIN_STREAM:
      // Wait for initialization before starting capture
      if (initializationPromise) {
        initializationPromise
          .then(() => beginCapture(message.data.streamId, message.data.config))
          .then(() => {
            logger.debug('Capture started successfully');
          })
          .catch((error) => {
            logger.error('Capture start failed:', error);
          });
      } else if (isInitialized) {
        beginCapture(message.data.streamId, message.data.config)
          .then(() => {
            logger.debug('Capture started successfully');
          })
          .catch((error) => {
            logger.error('Capture start failed:', error);
          });
      }
      sendResponse({ success: true, message: 'Starting capture' });
      break;
      
    case MessageType.END_STREAM:
      endCapture();
      sendResponse({ success: true, message: 'Capture ended' });
      break;
      
    case MessageType.GET_STATUS:
      sendResponse({ 
        isCapturing: captureInterval !== null,
        frameCounter,
        isInitialized
      });
      break;
      
    default:
      sendResponse({ success: false, message: 'Unknown message type' });
  }
  
  return false;
});

// Begin capturing video stream
async function beginCapture(streamId: string, captureConfig: CaptureConfig) {
  try {
    logger.info('🎥 Beginning capture with stream ID:', streamId);
    
    // Double check models are ready
    if (!isInitialized) {
      logger.warn('Models not ready yet, waiting...');
      await initializationPromise;
    }
    
    config = captureConfig;
    
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      } as any
    });
    
    logger.info('✅ Got media stream');
    
    video.srcObject = mediaStream;
    video.play();
    
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => {
        logger.info(`📺 Video loaded: ${video.videoWidth}x${video.videoHeight}`);
        resolve();
      };
    });
    
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    updateStatus('🔴 ANALYZING WITH AI');
    
    startFrameAnalysis();
    
  } catch (error) {
    logger.error('❌ Capture failed:', error);
    updateStatus('❌ ERROR: ' + (error as Error).message);
    
    chrome.runtime.sendMessage({
      type: MessageType.CAPTURE_ERROR,
      data: { error: (error as Error).message }
    }).catch(() => {});
  }
}

function startFrameAnalysis() {
  if (!config) return;
  
  const intervalMs = 1000 / config.fps;
  
  logger.info(`⏱️ Analyzing frames every ${intervalMs}ms (${config.fps} FPS)`);
  
  captureInterval = window.setInterval(() => {
    analyzeFrame();
  }, intervalMs);
}

async function analyzeFrame() {
  if (!video.videoWidth || !video.videoHeight) {
    return;
  }
  
  frameCounter++;
  
  try {
    // Detect face (BlazeFace is async)
    const faceResult = await faceDetector.detectFaces(video);
    
    if (!faceResult.detected) {
      sendDetectionResult({
        frameNumber: frameCounter,
        timestamp: Date.now(),
        confidence: 0,
        visualArtifactScore: 0,
        faceDetected: false,
        faceCount: 0,
        classification: 'real',
        threatLevel: 'safe',
        inferenceTime: 0
      });
      return;
    }
    
    const aiResult = await aiModel.detect(faceResult.croppedFace!);
    
    const classification = classifyThreat(aiResult.confidence);
    
    const result: DetectionResult = {
      frameNumber: frameCounter,
      timestamp: Date.now(),
      confidence: aiResult.confidence,
      visualArtifactScore: aiResult.visualArtifactScore,
      faceDetected: true,
      faceCount: faceResult.count,
      classification: classification.type,
      threatLevel: classification.level,
      inferenceTime: aiResult.inferenceTime
    };
    
    sendDetectionResult(result);
    
    if (frameCounter % 10 === 0) {
      const confidence = (aiResult.confidence * 100).toFixed(1);
      updateStatus(`🔴 Frame ${frameCounter} | Confidence: ${confidence}% | ${aiResult.inferenceTime.toFixed(0)}ms`);
    }
    
  } catch (error) {
    logger.error('Frame analysis error:', error);
  }
}

function classifyThreat(confidence: number): { 
  type: 'real' | 'suspicious' | 'fake';
  level: 'safe' | 'warning' | 'danger';
} {
  if (confidence < 0.3) {
    return { type: 'real', level: 'safe' };
  } else if (confidence < 0.7) {
    return { type: 'suspicious', level: 'warning' };
  } else {
    return { type: 'fake', level: 'danger' };
  }
}

function sendDetectionResult(result: DetectionResult) {
  chrome.runtime.sendMessage({
    type: MessageType.FRAME_CAPTURED,
    data: result
  }).catch(() => {});
}

function endCapture() {
  logger.info('🛑 Ending capture');
  
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  
  video.srcObject = null;
  frameCounter = 0;
  config = null;
  
  updateStatus('⏸️ Stopped');
}

function updateStatus(text: string) {
  statusDiv.textContent = text;
}

if (!isInitialized) {
  updateStatus('⏳ Initializing AI...');
}