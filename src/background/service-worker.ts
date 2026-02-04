import { MessageType, DetectionStatus, CaptureConfig } from '../utils/types';
import { createLogger } from '../utils/logger';

const logger = createLogger('Background');

// Global state
let detectionStatus: DetectionStatus = {
  isCapturing: false,
  framesProcessed: 0
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
    // Show notification
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
    // Step 1: Create offscreen document if needed
    await ensureOffscreenDocument();
    
    // Step 2: Request tab capture permission and get stream ID
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId
    });
    
    logger.info('✅ Got stream ID:', streamId);
    
    // Step 3: Configure capture settings
    const config: CaptureConfig = {
      targetTabId: tabId,
      fps: 5,
      quality: 'medium'
    };
    
    // Step 4: Send to offscreen document to begin capture
    chrome.runtime.sendMessage({
      type: MessageType.BEGIN_STREAM,
      data: { streamId, config }
    }).catch((error) => {
      logger.warn('Could not send to offscreen (might not be ready yet):', error.message);
    });
    
    // Update status
    detectionStatus = {
      isCapturing: true,
      framesProcessed: 0,
      startTime: Date.now(),
      currentTab: tabId
    };
    
    // Update extension icon
    chrome.action.setIcon({ path: 'icons/icon48.png' });
    chrome.action.setTitle({ title: 'Deepfake Detector - ACTIVE' });
    
    // CRITICAL: Wait a bit for content script to be ready, then notify
    logger.info('Notifying content script to show overlay...');
    
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, {
        type: MessageType.STATUS_UPDATE,
        data: { status: 'active' }
      }).then(() => {
        logger.info('✅ Content script notified successfully');
      }).catch((error) => {
        logger.error('❌ Failed to notify content script:', error);
        
        // Try injecting content script if it's not loaded
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['content-script.js']
        }).then(() => {
          logger.info('Content script injected, retrying notification...');
          
          // Retry notification after injection
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, {
              type: MessageType.STATUS_UPDATE,
              data: { status: 'active' }
            }).then(() => {
              logger.info('✅ Retry successful');
            }).catch((err) => {
              logger.error('❌ Retry failed:', err);
            });
          }, 100);
        }).catch((injectionError) => {
          logger.error('Failed to inject content script:', injectionError);
        });
      });
    }, 100); // Small delay to ensure content script is ready
    
  } catch (error) {
    logger.error('❌ Failed to start capture:', error);
    detectionStatus.isCapturing = false;
  }
}

// Stop video capture
async function stopCapture() {
  logger.info('🛑 Stopping capture');
  
  // Send to offscreen document
  chrome.runtime.sendMessage({
    type: MessageType.END_STREAM
  }).catch(() => {
    // Offscreen might be closed, that's fine
    logger.debug('Offscreen document may already be closed');
  });
  
  const currentTab = detectionStatus.currentTab;
  
  // Update status
  detectionStatus = {
    isCapturing: false,
    framesProcessed: detectionStatus.framesProcessed
  };
  
  chrome.action.setTitle({ title: 'Deepfake Detector - Click to Start' });
  
  // IMPORTANT: Notify content script to hide overlay
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
  // Check if already exists
  if (offscreenDocumentExists) {
    return;
  }
  
  // Check if any offscreen documents exist
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType]
  });
  
  if (existingContexts.length > 0) {
    offscreenDocumentExists = true;
    logger.debug('Offscreen document already exists');
    return;
  }
  
  // Create new offscreen document
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
    justification: 'Processing video stream for deepfake detection'
  });
  
  offscreenDocumentExists = true;
  logger.info('✅ Offscreen document created');
}

// Listen for messages from offscreen document and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.debug('Background received message:', message.type);
  
  switch (message.type) {
    case MessageType.GET_STATUS:
      sendResponse(detectionStatus);
      break;
      
    case MessageType.FRAME_CAPTURED:
      // Frame successfully captured
      detectionStatus.framesProcessed++;
      
      logger.debug('Frame captured:', detectionStatus.framesProcessed);
      
      // Send to popup if it's open
      chrome.runtime.sendMessage({
        type: MessageType.DETECTION_RESULT,
        data: {
          frameNumber: detectionStatus.framesProcessed,
          timestamp: message.data.timestamp,
          // Will add: confidence, artifactScore, ppgScore in Chunk 3
        }
      }).catch(() => {
        // Popup might be closed, that's fine
      });
      
      // IMPORTANT: Also send to content script for overlay update
      if (detectionStatus.currentTab) {
        chrome.tabs.sendMessage(detectionStatus.currentTab, {
          type: MessageType.DETECTION_RESULT,
          data: {
            frameNumber: detectionStatus.framesProcessed,
            timestamp: message.data.timestamp,
          }
        }).catch((error) => {
          // Content script might not be ready yet
          logger.debug('Could not send to content script:', error.message);
        });
      }
      break;
      
    case MessageType.CAPTURE_ERROR:
      logger.error('Capture error:', message.data);
      stopCapture();
      break;
      
    case MessageType.START_CAPTURE:
      if (message.data?.tabId) {
        startCapture(message.data.tabId);
      }
      sendResponse({ success: true });
      break;
      
    case MessageType.STOP_CAPTURE:
      stopCapture();
      sendResponse({ success: true });
      break;
      
    default:
      logger.debug('Unknown message type:', message.type);
  }
  
  return true; // Keep channel open for async responses
});

// Extension installed
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    logger.info('✅ Deepfake Detector installed!');
    
    // Open welcome page (optional)
    chrome.tabs.create({
      url: 'https://meet.google.com/'
    });
  } else if (details.reason === 'update') {
    logger.info('🔄 Extension updated to version', chrome.runtime.getManifest().version);
  }
});

// Clean up when extension unloads
chrome.runtime.onSuspend.addListener(() => {
  logger.info('Extension suspending, cleaning up...');
  stopCapture();
});

// Handle when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (detectionStatus.currentTab === tabId && detectionStatus.isCapturing) {
    logger.info('Active tab closed, stopping capture');
    stopCapture();
  }
});

// Handle when tab URL changes (user navigates away from Meet)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (detectionStatus.currentTab === tabId && 
      detectionStatus.isCapturing && 
      changeInfo.url && 
      !changeInfo.url.includes('meet.google.com')) {
    logger.info('User navigated away from Meet, stopping capture');
    stopCapture();
  }
});