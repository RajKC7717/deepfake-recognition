import { MessageType, DetectionStatus, CaptureConfig, DetectionResult, VideoRegion } from '../utils/types';
import { createLogger } from '../utils/logger';

const logger = createLogger('Background');

// ─── Global state ─────────────────────────────────────────────────────────────

let detectionStatus: DetectionStatus = {
  isCapturing:          false,
  framesProcessed:      0,
  modelLoaded:          false,
  videoRegionDetected:  false,
};

let offscreenDocumentExists = false;
let currentVideoRegion: VideoRegion | null = null;

// User settings (loaded from chrome.storage on boot)
let userSettings = {
  fps:            5,
  quality:        'medium' as 'low' | 'medium' | 'high',
  backendEnabled: false,
  backendUrl:     'http://localhost:8000',
  notifyDanger:   true,
  notifyWarning:  false,
  autoStart:      false,
};

logger.info('🛡️ Deepfake Detector Service Worker Loaded');

// Load settings on boot
chrome.storage.sync.get(userSettings, (stored) => {
  Object.assign(userSettings, stored);
  logger.info('Settings loaded:', userSettings);
});

// ─── Extension icon click ─────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  if (!tab.url?.includes('meet.google.com')) {
    chrome.notifications?.create({
      type:    'basic',
      iconUrl: 'icons/icon48.png',
      title:   'Deepfake Detector',
      message: 'Please open a Google Meet call first.',
    });
    return;
  }

  if (detectionStatus.isCapturing) {
    await stopCapture();
  } else {
    await startCapture(tab.id);
  }
});

// ─── Start / Stop ─────────────────────────────────────────────────────────────

async function startCapture(tabId: number) {
  logger.info('🎥 Starting capture for tab:', tabId);

  try {
    await ensureOffscreenDocument();

    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    logger.info('Got stream ID:', streamId);

    const config: CaptureConfig = {
      targetTabId:  tabId,
      fps:          userSettings.fps,
      quality:      userSettings.quality,
      videoRegion:  currentVideoRegion ?? undefined,
    };

    chrome.runtime.sendMessage({
      type: MessageType.BEGIN_STREAM,
      data: { streamId, config },
    }).catch((err) => logger.warn('Could not send BEGIN_STREAM:', err.message));

    detectionStatus = {
      isCapturing:         true,
      framesProcessed:     0,
      startTime:           Date.now(),
      currentTab:          tabId,
      modelLoaded:         detectionStatus.modelLoaded,
      videoRegionDetected: currentVideoRegion !== null,
    };

    chrome.action.setTitle({ title: 'Deepfake Detector — ACTIVE' });

    // Notify content script with retry
    setTimeout(() => notifyContentScript(tabId, 'active'), 100);

  } catch (error) {
    logger.error('❌ Failed to start capture:', error);
    detectionStatus.isCapturing = false;
  }
}

async function stopCapture() {
  logger.info('🛑 Stopping capture');

  chrome.runtime.sendMessage({ type: MessageType.END_STREAM }).catch(() => {});

  const prevTab = detectionStatus.currentTab;

  detectionStatus = {
    isCapturing:         false,
    framesProcessed:     detectionStatus.framesProcessed,
    modelLoaded:         detectionStatus.modelLoaded,
    videoRegionDetected: currentVideoRegion !== null,
  };

  chrome.action.setTitle({ title: 'Deepfake Detector — Click to Start' });

  if (prevTab) {
    chrome.tabs.sendMessage(prevTab, {
      type: MessageType.STATUS_UPDATE,
      data: { status: 'stopped' },
    }).catch(() => {});
  }
}

async function notifyContentScript(tabId: number, status: 'active' | 'stopped') {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MessageType.STATUS_UPDATE,
      data: { status },
    });
    logger.info('✅ Content script notified:', status);
  } catch {
    // Content script not injected yet — inject it
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, {
          type: MessageType.STATUS_UPDATE,
          data: { status },
        }).catch(() => {});
      }, 150);
    } catch (injErr) {
      logger.error('Failed to inject content script:', injErr);
    }
  }
}

async function ensureOffscreenDocument() {
  if (offscreenDocumentExists) return;

  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });

  if (existing.length > 0) {
    offscreenDocumentExists = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url:          'offscreen.html',
    reasons:      ['USER_MEDIA' as chrome.offscreen.Reason],
    justification:'Processing video stream for deepfake detection',
  });

  offscreenDocumentExists = true;
  logger.info('✅ Offscreen document created');
}

// ─── Message listener (single, consolidated) ──────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.debug('Message received:', message.type);

  try {
    switch (message.type) {

      // ── Popup asking for current status ─────────────────────────────────
      case MessageType.GET_STATUS:
        sendResponse(detectionStatus);
        return false;

      // ── Popup: start capture ─────────────────────────────────────────────
      case MessageType.START_CAPTURE:
        if (message.data?.tabId) {
          startCapture(message.data.tabId)
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: err.message }));
          return true; // async
        }
        sendResponse({ success: false, error: 'No tab ID' });
        return false;

      // ── Popup: stop capture ──────────────────────────────────────────────
      case MessageType.STOP_CAPTURE:
        stopCapture().then(() => sendResponse({ success: true }));
        return true; // async

      // ── Content script: video detected ───────────────────────────────────
      case MessageType.VIDEO_DETECTED:
        currentVideoRegion = message.data as VideoRegion;
        detectionStatus.videoRegionDetected = true;
        logger.info('✅ Video region:', `${currentVideoRegion.width}x${currentVideoRegion.height}`);

        if (detectionStatus.isCapturing) {
          chrome.runtime.sendMessage({
            type: MessageType.UPDATE_VIDEO_REGION,
            data: currentVideoRegion,
          }).catch(() => {});
        }
        sendResponse({ received: true });
        return false;

      // ── Content script: video lost ───────────────────────────────────────
      case MessageType.VIDEO_LOST:
        logger.warn('⚠️ Video lost');
        currentVideoRegion = null;
        detectionStatus.videoRegionDetected = false;
        sendResponse({ received: true });
        return false;

      // ── Offscreen: models ready ──────────────────────────────────────────
      case MessageType.MODEL_READY:
        logger.info('✅ Models ready:', message.data);
        detectionStatus.modelLoaded = true;
        // Forward to popup
        chrome.runtime.sendMessage({ type: MessageType.MODEL_READY, data: message.data }).catch(() => {});
        sendResponse({ received: true });
        return false;

      case MessageType.MODEL_ERROR:
        logger.error('❌ Model error:', message.data);
        sendResponse({ received: true });
        return false;

      // ── Offscreen: frame analyzed ────────────────────────────────────────
      case MessageType.FRAME_CAPTURED: {
        detectionStatus.framesProcessed++;
        const result = message.data as DetectionResult;

        detectionStatus.averageConfidence = detectionStatus.averageConfidence === undefined
          ? result.confidence
          : detectionStatus.averageConfidence * 0.9 + result.confidence * 0.1;

        // Forward to popup
        chrome.runtime.sendMessage({ type: MessageType.DETECTION_RESULT, data: result }).catch(() => {});

        // Forward to content script overlay
        if (detectionStatus.currentTab) {
          chrome.tabs.sendMessage(detectionStatus.currentTab, {
            type: MessageType.DETECTION_RESULT,
            data: result,
          }).catch(() => {});
        }

        // Show notification if needed
        if (result.threatLevel === 'danger' && userSettings.notifyDanger) {
          chrome.notifications?.create({
            type:    'basic',
            iconUrl: 'icons/icon48.png',
            title:   '🚨 Deepfake Detected!',
            message: `Confidence: ${(result.confidence * 100).toFixed(0)}% — Video may be AI-generated.`,
          });
        } else if (result.threatLevel === 'warning' && userSettings.notifyWarning) {
          chrome.notifications?.create({
            type:    'basic',
            iconUrl: 'icons/icon48.png',
            title:   '⚠️ Suspicious Activity',
            message: `Authenticity score: ${((1 - result.confidence) * 100).toFixed(0)}%`,
          });
        }

        sendResponse({ received: true });
        return false;
      }

      // ── Offscreen: capture error ─────────────────────────────────────────
      case MessageType.CAPTURE_ERROR:
        logger.error('Capture error:', message.data);
        stopCapture();
        sendResponse({ received: true });
        return false;

      // ── Content script: check video (direct query) ───────────────────────
      case 'CHECK_VIDEO':
        sendResponse({
          videoDetected: currentVideoRegion !== null,
          region:        currentVideoRegion,
        });
        return false;

      // ── Settings page: settings updated ─────────────────────────────────
      case 'SETTINGS_UPDATED':
        Object.assign(userSettings, message.data);
        logger.info('Settings updated:', userSettings);
        sendResponse({ received: true });
        return false;

      default:
        logger.debug('Unknown message type:', message.type);
        sendResponse({ success: false, error: 'Unknown type' });
        return false;
    }
  } catch (err) {
    logger.error('Message handler error:', err);
    sendResponse({ success: false, error: (err as Error).message });
    return false;
  }
});

// ─── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    logger.info('✅ Installed');
    chrome.tabs.create({ url: 'https://meet.google.com/' });
  } else if (details.reason === 'update') {
    logger.info('🔄 Updated to', chrome.runtime.getManifest().version);
  }
});

chrome.runtime.onSuspend.addListener(() => {
  logger.info('Suspending — cleaning up');
  if (detectionStatus.isCapturing) stopCapture();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (detectionStatus.currentTab === tabId && detectionStatus.isCapturing) {
    logger.info('Active tab closed — stopping capture');
    stopCapture();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    detectionStatus.currentTab === tabId &&
    detectionStatus.isCapturing &&
    changeInfo.url &&
    !changeInfo.url.includes('meet.google.com')
  ) {
    logger.info('Navigated away from Meet — stopping');
    stopCapture();
  }
});

// Listen for settings changes from settings page
chrome.storage.onChanged.addListener((changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in userSettings) {
      (userSettings as any)[key] = newValue;
    }
  }
});