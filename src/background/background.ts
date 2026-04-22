/**
 * src/background/background.ts  —  Chunk 4 (Edge Cases & Polish)
 * ================================================================
 *
 * Changes vs Chunk 3:
 *
 * 1. TAB SWITCH THROTTLE
 *    chrome.tabs.onActivated: when user switches away from the captured
 *    Meet tab → THROTTLE_FPS { fps: 1 }
 *    When they switch back → THROTTLE_FPS { fps: userSettings.fps }
 *
 * 2. WINDOW FOCUS THROTTLE
 *    chrome.windows.onFocusChanged: when the browser window loses OS
 *    focus (minimised, alt-tabbed to another app) → THROTTLE_FPS { fps: 1 }
 *    When focus returns → THROTTLE_FPS { fps: userSettings.fps }
 *
 *    Combined effect: a deepfake call running in the background uses
 *    ~1/5 the CPU of an active call, while still monitoring at 1 FPS.
 *
 * 3. All Chunk 3 changes retained:
 *    • detectionStatus.averageConfidence mirrors result.smoothedConfidence
 *    • backendEnabled + backendUrl forwarded in CaptureConfig
 */

import {
  MessageType,
  DetectionStatus,
  CaptureConfig,
  DetectionResult,
  VideoRegion,
} from '../utils/types';
import { createLogger } from '../utils/logger';

const logger = createLogger('Background');

// ─── Global state ─────────────────────────────────────────────────────────────

let detectionStatus: DetectionStatus = {
  isCapturing:         false,
  framesProcessed:     0,
  modelLoaded:         false,
  videoRegionDetected: false,
};

let offscreenDocumentExists = false;
let currentVideoRegion: VideoRegion | null = null;

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
      targetTabId:    tabId,
      fps:            userSettings.fps,
      quality:        userSettings.quality,
      videoRegion:    currentVideoRegion ?? undefined,
      backendEnabled: userSettings.backendEnabled,
      backendUrl:     userSettings.backendUrl,
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
    setTimeout(() => notifyContentScript(tabId, 'active'), 100);

    // ── Chunk 4: check whether the tab is already in the background ────────
    // If startCapture is called while the user is on a different tab
    // (e.g. autoStart), begin throttled immediately.
    chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
      const activeTabId = activeTabs[0]?.id;
      if (activeTabId && activeTabId !== tabId) {
        logger.info('Capture started on background tab — throttling to 1 FPS');
        sendThrottleFps(1);
      }
    });

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

// ─── Tab / Window throttle (Chunk 4) ─────────────────────────────────────────

/**
 * Send a THROTTLE_FPS message to the offscreen document.
 * The offscreen document calls setFps(fps) which restarts its setInterval.
 */
function sendThrottleFps(fps: number): void {
  if (!detectionStatus.isCapturing) return;
  chrome.runtime.sendMessage({
    type: MessageType.THROTTLE_FPS,
    data: { fps },
  }).catch(() => {});
  logger.info(`⏱ Throttle signal → ${fps} FPS`);
}

/**
 * When the user switches tabs, drop to 1 FPS if the captured tab is
 * no longer active; restore full FPS when they switch back.
 *
 * This fires on EVERY tab switch — even in other windows — so we check
 * whether the currently-active tab is our captured tab.
 */
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!detectionStatus.isCapturing || !detectionStatus.currentTab) return;

  if (tabId === detectionStatus.currentTab) {
    logger.info('Captured tab is now active — restoring full FPS');
    sendThrottleFps(userSettings.fps);
  } else {
    logger.info('Captured tab moved to background — throttling to 1 FPS');
    sendThrottleFps(1);
  }
});

/**
 * When the Chrome window itself loses OS focus (minimised, another app
 * brought to foreground), drop to 1 FPS.
 * WINDOW_ID_NONE means no Chrome window has focus.
 */
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!detectionStatus.isCapturing) return;

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    logger.info('Window lost OS focus — throttling to 1 FPS');
    sendThrottleFps(1);
  } else {
    // Window regained focus — but only restore full FPS if our tab is active
    chrome.tabs.query({ active: true, windowId }, (activeTabs) => {
      const activeTabId = activeTabs[0]?.id;
      const fps = (activeTabId === detectionStatus.currentTab)
        ? userSettings.fps
        : 1;
      logger.info(`Window focused (tab=${activeTabId}) — FPS → ${fps}`);
      sendThrottleFps(fps);
    });
  }
});

// ─── Content script notification ─────────────────────────────────────────────

async function notifyContentScript(tabId: number, status: 'active' | 'stopped') {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MessageType.STATUS_UPDATE,
      data: { status },
    });
    logger.info('✅ Content script notified:', status);
  } catch {
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

// ─── Offscreen document management ───────────────────────────────────────────

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
    url:           'offscreen.html',
    reasons:       ['USER_MEDIA' as chrome.offscreen.Reason],
    justification: 'Processing video stream for deepfake detection',
  });

  offscreenDocumentExists = true;
  logger.info('✅ Offscreen document created');
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logger.debug('Message received:', message.type);

  try {
    switch (message.type) {

      case MessageType.GET_STATUS:
        sendResponse(detectionStatus);
        return false;

      case MessageType.START_CAPTURE:
        if (message.data?.tabId) {
          startCapture(message.data.tabId)
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: err.message }));
          return true;
        }
        sendResponse({ success: false, error: 'No tab ID' });
        return false;

      case MessageType.STOP_CAPTURE:
        stopCapture().then(() => sendResponse({ success: true }));
        return true;

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

      case MessageType.VIDEO_LOST:
        logger.warn('⚠️ Video lost');
        currentVideoRegion = null;
        detectionStatus.videoRegionDetected = false;
        sendResponse({ received: true });
        return false;

      case MessageType.MODEL_READY:
        logger.info('✅ Models ready:', message.data);
        detectionStatus.modelLoaded = true;
        chrome.runtime.sendMessage({ type: MessageType.MODEL_READY, data: message.data }).catch(() => {});
        sendResponse({ received: true });
        return false;

      case MessageType.MODEL_ERROR:
        logger.error('❌ Model error:', message.data);
        sendResponse({ received: true });
        return false;

      case MessageType.FRAME_CAPTURED: {
        detectionStatus.framesProcessed++;
        const result = message.data as DetectionResult;

        // Chunk 3+4: mirror smoothed value — no local EMA
        detectionStatus.averageConfidence = result.smoothedConfidence ?? result.confidence;

        // Forward to popup
        chrome.runtime.sendMessage({ type: MessageType.DETECTION_RESULT, data: result }).catch(() => {});

        // Forward to content script overlay
        if (detectionStatus.currentTab) {
          chrome.tabs.sendMessage(detectionStatus.currentTab, {
            type: MessageType.DETECTION_RESULT,
            data: result,
          }).catch(() => {});
        }

        // Notify only on threat level change, using smoothed value
        // (threatLevel already derived from hysteresis — not per-frame noise)
        if (result.threatLevel === 'danger' && userSettings.notifyDanger) {
          chrome.notifications?.create({
            type:    'basic',
            iconUrl: 'icons/icon48.png',
            title:   '🚨 Deepfake Detected!',
            message: `Confidence: ${((result.smoothedConfidence ?? result.confidence) * 100).toFixed(0)}%`,
          });
        } else if (result.threatLevel === 'warning' && userSettings.notifyWarning) {
          chrome.notifications?.create({
            type:    'basic',
            iconUrl: 'icons/icon48.png',
            title:   '⚠️ Suspicious Activity',
            message: `Authenticity: ${((1 - (result.smoothedConfidence ?? result.confidence)) * 100).toFixed(0)}%`,
          });
        }

        sendResponse({ received: true });
        return false;
      }

      case MessageType.CAPTURE_ERROR:
        logger.error('Capture error:', message.data);
        stopCapture();
        sendResponse({ received: true });
        return false;

      case 'CHECK_VIDEO':
        sendResponse({
          videoDetected: currentVideoRegion !== null,
          region:        currentVideoRegion,
        });
        return false;

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

chrome.storage.onChanged.addListener((changes) => {
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in userSettings) {
      (userSettings as any)[key] = newValue;
    }
  }
});