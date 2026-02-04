import { MessageType, CaptureConfig, FrameData } from '../utils/types';

console.log('🎬 Offscreen Video Processor Loaded');

// DOM elements
const video = document.getElementById('video') as HTMLVideoElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

// State
let mediaStream: MediaStream | null = null;
let captureInterval: number | null = null;
let config: CaptureConfig | null = null;
let frameCounter = 0;

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen received:', message.type);
  
  switch (message.type) {
    case MessageType.BEGIN_STREAM:
      beginCapture(message.data.streamId, message.data.config);
      sendResponse({ success: true });
      break;
      
    case MessageType.END_STREAM:
      endCapture();
      sendResponse({ success: true });
      break;
  }
  
  return true;
});

// Begin capturing video stream
async function beginCapture(streamId: string, captureConfig: CaptureConfig) {
  try {
    console.log('🎥 Beginning capture with stream ID:', streamId);
    config = captureConfig;
    
    // Get media stream using the stream ID
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      } as any // TypeScript doesn't have types for Chrome-specific constraints
    });
    
    console.log('✅ Got media stream');
    
    // Attach to video element
    video.srcObject = mediaStream;
    video.play();
    
    // Wait for video metadata to load
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => {
        console.log(`📺 Video loaded: ${video.videoWidth}x${video.videoHeight}`);
        resolve();
      };
    });
    
    // Setup canvas with video dimensions
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    // Update status
    updateStatus('🔴 CAPTURING');
    
    // Start frame extraction
    startFrameExtraction();
    
  } catch (error) {
    console.error('❌ Capture failed:', error);
    updateStatus('❌ ERROR: ' + (error as Error).message);
    
    // Notify background of error
    chrome.runtime.sendMessage({
      type: MessageType.CAPTURE_ERROR,
      data: { error: (error as Error).message }
    });
  }
}

// Start extracting frames at configured FPS
function startFrameExtraction() {
  if (!config) return;
  
  const intervalMs = 1000 / config.fps; // Convert FPS to milliseconds
  
  console.log(`⏱️ Extracting frames every ${intervalMs}ms (${config.fps} FPS)`);
  
  captureInterval = window.setInterval(() => {
    extractFrame();
  }, intervalMs);
}

// Extract a single frame from video
function extractFrame() {
  if (!video.videoWidth || !video.videoHeight) {
    console.warn('Video not ready yet');
    return;
  }
  
  frameCounter++;
  
  // Draw current video frame to canvas
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
  // Get image data (RGBA pixel array)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  // Convert to base64 for easier transfer
  // (In production, you might want to send raw ImageData or use OffscreenCanvas)
  const base64Image = canvas.toDataURL('image/jpeg', 0.8); // 80% quality
  
  // Create frame data
  const frameData: FrameData = {
    imageData: base64Image,
    timestamp: Date.now(),
    tabId: config!.targetTabId,
    frameNumber: frameCounter
  };
  
  // Send to background for processing
  chrome.runtime.sendMessage({
    type: MessageType.FRAME_CAPTURED,
    data: frameData
  });
  
  // Update status every 30 frames
  if (frameCounter % 30 === 0) {
    updateStatus(`🔴 CAPTURING - Frame ${frameCounter}`);
  }
}

// End capture and cleanup
function endCapture() {
  console.log('🛑 Ending capture');
  
  // Stop interval
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  
  // Stop media stream
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  
  // Clear video
  video.srcObject = null;
  
  // Reset state
  frameCounter = 0;
  config = null;
  
  updateStatus('⏸️ Stopped');
}

// Update status display
function updateStatus(text: string) {
  statusDiv.textContent = text;
}

// Initial status
updateStatus('⏸️ Ready');