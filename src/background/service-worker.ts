import { MessageType, DetectionStatus, CaptureConfig, DetectionResult } from '../utils/types';
import { createLogger } from '../utils/logger';

const logger = createLogger('Background');

// Global state
let detectionStatus: DetectionStatus = {
  isCapturing: false,
  framesProcessed: 0,
  modelLoaded: false
};

let offscreenDocumentExists = false;

logger.info('🛡️ Deepfake Detector Service Worker Loaded');

// Handle extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  logger.debug('Extension clicked on tab:', tab.id);
  
  if (!tab.id) {
    logger.error('No tab ID available');
    return;
  }
  
  // Check if on supported site
  if (!tab.url?.includes('meet.google.com')) {
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Deepfake Detector',
      message: 'Please open a Google Meet call first. This extension works on meet.google.com'
    });
    return;
  }
  
  // Toggle capture
  if (detectionStatus.isCapturing) {
    await stopCapture();
  } else {
    await startCapture(tab.id);
  }
});

// Start video capture
async function startCapture(tabId: number) {
  logger.info('🎥 Starting capture for tab:', tabId);
  
  try {
    await ensureOffscreenDocument();
    
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId
    });
    
    logger.info('✅ Got stream ID:', streamId);
    
    const config: CaptureConfig = {
      targetTabId: tabId,
      fps: 5,
      quality: 'medium'
    };
    
    chrome.runtime.sendMessage({
      type: MessageType.BEGIN_STREAM,
      data: { streamId, config }
    }).catch((error) => {
      logger.warn('Could not send to offscreen:', error.message);
    });
    
    detectionStatus = {
      isCapturing: true,
      framesProcessed: 0,
      startTime: Date.now(),
      currentTab: tabId,
      modelLoaded: false
    };
    
    chrome.action.setIcon({ path: 'icons/icon48.png' });
    chrome.action.setTitle({ title: 'Deepfake Detector - ACTIVE' });
    
    logger.info('Notifying content script to show overlay...');
    
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, {
        type: MessageType.STATUS_UPDATE,
        data: { status: 'active' }
      }).then(() => {
        logger.info('✅ Content script notified successfully');
      }).catch((error) => {
        logger.error('❌ Failed to notify content script:', error);
        
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content-script.js']
        }).then(() => {
          logger.info('Content script injected, retrying...');
          
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, {
              type: MessageType.STATUS_UPDATE,
              data: { status: 'active' }
            }).catch((err) => {
              logger.error('❌ Retry failed:', err);
            });
          }, 100);
        }).catch((injectionError) => {
          logger.error('Failed to inject content script:', injectionError);
        });
      });
    }, 100);
    
  } catch (error) {
    logger.error('❌ Failed to start capture:', error);
    detectionStatus.isCapturing = false;
  }
}

// Stop video capture
async function stopCapture() {
  logger.info('🛑 Stopping capture');
  
  chrome.runtime.sendMessage({
    type: MessageType.END_STREAM
  }).catch(() => {
    logger.debug('Offscreen document may already be closed');
  });
  
  const currentTab = detectionStatus.currentTab;
  
  detectionStatus = {
    isCapturing: false,
    framesProcessed: detectionStatus.framesProcessed,
    modelLoaded: detectionStatus.modelLoaded
  };
  
  chrome.action.setTitle({ title: 'Deepfake Detector - Click to Start' });
  
  if (currentTab) {
    chrome.tabs.sendMessage(currentTab, {
      type: MessageType.STATUS_UPDATE,
      data: { status: 'stopped' }
    }).catch((error) => {
      logger.debug('Could not notify content script:', error.message);
    });
  }
}

// Ensure offscreen document exists
async function ensureOffscreenDocument() {
  if (offscreenDocumentExists) {
    return;
  }
  
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType]
  });
  
  if (existingContexts.length > 0) {
    offscreenDocumentExists = true;
    logger.debug('Offscreen document already exists');
    return;
  }
  
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
    justification: 'Processing video stream for deepfake detection'
  });
  
  offscreenDocumentExists = true;
  logger.info('✅ Offscreen document created');
}

// Listen for messages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.debug('Background received message:', message.type);
  
  // Handle each message type
  try {
    switch (message.type) {
      case MessageType.GET_STATUS:
        sendResponse(detectionStatus);
        return false; // Synchronous response
        
      case MessageType.MODEL_READY:
        logger.info('✅ AI models loaded:', message.data);
        detectionStatus.modelLoaded = true;
        
        // Notify popup
        chrome.runtime.sendMessage({
          type: MessageType.MODEL_READY,
          data: message.data
        }).catch(() => {});
        
        sendResponse({ received: true });
        return false;
        
      case MessageType.MODEL_ERROR:
        logger.error('❌ Model loading error:', message.data);
        sendResponse({ received: true });
        return false;
        
      case MessageType.FRAME_CAPTURED:
        // Frame successfully captured and analyzed by AI
        detectionStatus.framesProcessed++;
        
        const result = message.data as DetectionResult;
        
        logger.debug(`Frame ${detectionStatus.framesProcessed}: ${result.classification} (${(result.confidence * 100).toFixed(1)}%)`);
        
        // Calculate running average confidence
        if (!detectionStatus.averageConfidence) {
          detectionStatus.averageConfidence = result.confidence;
        } else {
          detectionStatus.averageConfidence = 
            (detectionStatus.averageConfidence * 0.9) + (result.confidence * 0.1);
        }
        
        // Send to popup
        chrome.runtime.sendMessage({
          type: MessageType.DETECTION_RESULT,
          data: result
        }).catch(() => {});
        
        // Send to content script
        if (detectionStatus.currentTab) {
          chrome.tabs.sendMessage(detectionStatus.currentTab, {
            type: MessageType.DETECTION_RESULT,
            data: result
          }).catch((error) => {
            logger.debug('Could not send to content script:', error.message);
          });
        }
        
        // Log warnings
        if (result.threatLevel === 'danger') {
          logger.warn(`🚨 DEEPFAKE DETECTED! Confidence: ${(result.confidence * 100).toFixed(1)}%`);
        } else if (result.threatLevel === 'warning') {
          logger.warn(`⚠️ Suspicious activity. Confidence: ${(result.confidence * 100).toFixed(1)}%`);
        }
        
        sendResponse({ received: true });
        return false;
        
      case MessageType.CAPTURE_ERROR:
        logger.error('Capture error:', message.data);
        stopCapture();
        sendResponse({ received: true });
        return false;
        
      case MessageType.START_CAPTURE:
        if (message.data?.tabId) {
          startCapture(message.data.tabId).then(() => {
            sendResponse({ success: true });
          }).catch((error) => {
            sendResponse({ success: false, error: error.message });
          });
          return true; // Will respond asynchronously
        }
        sendResponse({ success: false, error: 'No tab ID' });
        return false;
        
      case MessageType.STOP_CAPTURE:
        stopCapture().then(() => {
          sendResponse({ success: true });
        });
        return true; // Will respond asynchronously
        
      default:
        logger.debug('Unknown message type:', message.type);
        sendResponse({ success: false, error: 'Unknown message type' });
        return false;
    }
  } catch (error) {
    logger.error('Error handling message:', error);
    sendResponse({ success: false, error: (error as Error).message });
    return false;
  }
});

// Extension installed
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    logger.info('✅ Deepfake Detector installed!');
    chrome.tabs.create({ url: 'https://meet.google.com/' });
  } else if (details.reason === 'update') {
    logger.info('🔄 Extension updated to version', chrome.runtime.getManifest().version);
  }
});

// Clean up
chrome.runtime.onSuspend.addListener(() => {
  logger.info('Extension suspending, cleaning up...');
  stopCapture();
});

// Handle tab closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (detectionStatus.currentTab === tabId && detectionStatus.isCapturing) {
    logger.info('Active tab closed, stopping capture');
    stopCapture();
  }
});

// Handle navigation away
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (detectionStatus.currentTab === tabId && 
      detectionStatus.isCapturing && 
      changeInfo.url && 
      !changeInfo.url.includes('meet.google.com')) {
    logger.info('User navigated away from Meet, stopping capture');
    stopCapture();
  }
});