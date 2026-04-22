import { MessageType, DetectionResult, VideoRegion } from '../utils/types';
import { VideoDetector } from '../utils/video-detector';

console.log('📹 Deepfake Detector content script loaded on:', window.location.href);

// ─── State ────────────────────────────────────────────────────────────────────
const videoDetector = new VideoDetector();
let currentVideoRegion: VideoRegion | null = null;

// UI elements
let statusIndicator:   HTMLDivElement | null  = null;
let frameCountDisplay: HTMLSpanElement | null = null;
let confidenceDisplay: HTMLSpanElement | null = null;
let trendDisplay:      HTMLSpanElement | null = null;
let stabilityBar:      HTMLDivElement | null  = null;
let threatIndicator:   HTMLDivElement | null  = null;
let statusText:        HTMLDivElement | null  = null;
let videoHighlight:    HTMLDivElement | null  = null;
let videoStatusBadge:  HTMLDivElement | null  = null;
let isIndicatorVisible = false;

// ─── Boot ─────────────────────────────────────────────────────────────────────

chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (response) => {
  if (response?.isCapturing) {
    console.log('Detection already active on page load, showing overlay');
    showStatusIndicator();
  }
});

videoDetector.startWatching(
  (videos) => handleVideoFound(videos),
  ()       => handleVideoLost()
);

// ─── Video detection handlers ─────────────────────────────────────────────────

function handleVideoFound(videos: VideoRegion[]) {
  const largestVideo = videos.reduce((prev, current) =>
    current.width * current.height > prev.width * prev.height ? current : prev
  );

  const hasChanged =
    !currentVideoRegion ||
    Math.abs(currentVideoRegion.x      - largestVideo.x)      > 10 ||
    Math.abs(currentVideoRegion.y      - largestVideo.y)      > 10 ||
    Math.abs(currentVideoRegion.width  - largestVideo.width)  > 10 ||
    Math.abs(currentVideoRegion.height - largestVideo.height) > 10;

  currentVideoRegion = largestVideo;

  if (hasChanged) {
    console.log('✅ Video detected:', {
      size:      `${largestVideo.width}x${largestVideo.height}`,
      position:  `(${largestVideo.x}, ${largestVideo.y})`,
      isPlaying: largestVideo.isPlaying,
    });

    chrome.runtime.sendMessage({
      type: MessageType.VIDEO_DETECTED,
      data: {
        x:         largestVideo.x,
        y:         largestVideo.y,
        width:     largestVideo.width,
        height:    largestVideo.height,
        isPlaying: largestVideo.isPlaying,
      },
    }).catch(() => {});
  }

  showVideoStatusBadge(true);

  if (isIndicatorVisible) {
    showVideoHighlight(largestVideo);
  }
}

function handleVideoLost() {
  console.log('⚠️ Video truly lost (confirmed after multiple scans)');
  currentVideoRegion = null;

  chrome.runtime.sendMessage({ type: MessageType.VIDEO_LOST }).catch(() => {});

  showVideoStatusBadge(false);
  hideVideoHighlight();
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('Content script received:', message.type);

  if (message.type === 'CHECK_VIDEO') {
    const videos = videoDetector.forceDetect();

    if (videos.length > 0) {
      const largest = videos.reduce((p, c) =>
        c.width * c.height > p.width * p.height ? c : p
      );
      currentVideoRegion = largest;

      chrome.runtime.sendMessage({
        type: MessageType.VIDEO_DETECTED,
        data: {
          x:         largest.x,
          y:         largest.y,
          width:     largest.width,
          height:    largest.height,
          isPlaying: largest.isPlaying,
        },
      }).catch(() => {});

      console.log('✅ CHECK_VIDEO: found', `${largest.width}x${largest.height}`);
      sendResponse({ videoDetected: true, region: largest });
    } else {
      console.log('⚠️ CHECK_VIDEO: no video found');
      sendResponse({ videoDetected: false, region: null });
    }
    return true;
  }

  if (message.type === MessageType.STATUS_UPDATE) {
    const { status } = message.data;

    if (status === 'active') {
      console.log('✅ Status: ACTIVE - Showing overlay');
      showStatusIndicator();
      if (currentVideoRegion) showVideoHighlight(currentVideoRegion);
    } else if (status === 'stopped') {
      console.log('🛑 Status: STOPPED - Hiding overlay');
      hideStatusIndicator();
      hideVideoHighlight();
    }
  }

  if (message.type === MessageType.DETECTION_RESULT) {
    updateDetectionResult(message.data as DetectionResult);
  }

  if (message.type === MessageType.MODEL_READY) {
    console.log('✅ AI Model ready:', message.data);
  }

  sendResponse({ received: true });
  return true;
});

// ─── Video Status Badge ───────────────────────────────────────────────────────

function showVideoStatusBadge(videoDetected: boolean) {
  if (videoStatusBadge) videoStatusBadge.remove();

  videoStatusBadge = document.createElement('div');
  videoStatusBadge.id = 'deepfake-detector-video-badge';

  if (videoDetected) {
    videoStatusBadge.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <div style="width: 8px; height: 8px; background: #10b981; border-radius: 50%; animation: pulse-dot 2s infinite;"></div>
        <span>✓ Video Detected</span>
      </div>`;
    videoStatusBadge.style.background  = 'linear-gradient(135deg, rgba(16, 185, 129, 0.95), rgba(5, 150, 105, 0.95))';
    videoStatusBadge.style.borderColor = '#10b981';
  } else {
    videoStatusBadge.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <div style="width: 8px; height: 8px; background: #ef4444; border-radius: 50%;"></div>
        <span>⚠ No Video Detected</span>
      </div>`;
    videoStatusBadge.style.background  = 'linear-gradient(135deg, rgba(239, 68, 68, 0.95), rgba(220, 38, 38, 0.95))';
    videoStatusBadge.style.borderColor = '#ef4444';
  }

  videoStatusBadge.style.cssText += `
    position: fixed; bottom: 20px; left: 20px; color: white;
    padding: 12px 16px; border-radius: 8px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px; font-weight: 600; z-index: 999997;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); border: 2px solid;
    backdrop-filter: blur(10px); transition: all 0.3s ease;
    opacity: 0; transform: translateY(10px);`;

  if (!document.getElementById('video-badge-styles')) {
    const style = document.createElement('style');
    style.id = 'video-badge-styles';
    style.textContent = `@keyframes pulse-dot {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.5; transform: scale(1.2); }
    }`;
    document.head.appendChild(style);
  }

  document.body.appendChild(videoStatusBadge);

  setTimeout(() => {
    if (videoStatusBadge) {
      videoStatusBadge.style.opacity   = '1';
      videoStatusBadge.style.transform = 'translateY(0)';
    }
  }, 10);

  setTimeout(() => {
    if (videoStatusBadge && !isIndicatorVisible) {
      videoStatusBadge.style.opacity   = '0';
      videoStatusBadge.style.transform = 'translateY(10px)';
      setTimeout(() => { videoStatusBadge?.remove(); videoStatusBadge = null; }, 300);
    }
  }, 5000);
}

// ─── Video Highlight Box ──────────────────────────────────────────────────────

function showVideoHighlight(region: VideoRegion) {
  hideVideoHighlight();

  videoHighlight = document.createElement('div');
  videoHighlight.id = 'deepfake-detector-video-highlight';
  videoHighlight.innerHTML = `
    <div class="corner corner-tl"></div>
    <div class="corner corner-tr"></div>
    <div class="corner corner-bl"></div>
    <div class="corner corner-br"></div>
    <div class="label">🛡️ Protected Region</div>`;

  videoHighlight.style.cssText = `
    position: fixed;
    left: ${region.x}px; top: ${region.y}px;
    width: ${region.width}px; height: ${region.height}px;
    border: 3px solid #10b981; border-radius: 8px;
    pointer-events: none; z-index: 999998;
    box-shadow: 0 0 0 2px rgba(16,185,129,0.2), 0 0 20px rgba(16,185,129,0.4), inset 0 0 20px rgba(16,185,129,0.1);
    animation: pulse-border 3s ease-in-out infinite; transition: all 0.3s ease;`;

  if (!document.getElementById('video-highlight-styles')) {
    const style = document.createElement('style');
    style.id = 'video-highlight-styles';
    style.textContent = `
      @keyframes pulse-border {
        0%, 100% { border-color: #10b981; box-shadow: 0 0 0 2px rgba(16,185,129,0.2), 0 0 20px rgba(16,185,129,0.4), inset 0 0 20px rgba(16,185,129,0.1); }
        50%       { border-color: #34d399; box-shadow: 0 0 0 3px rgba(16,185,129,0.3), 0 0 30px rgba(16,185,129,0.6), inset 0 0 30px rgba(16,185,129,0.2); }
      }
      #deepfake-detector-video-highlight .corner { position: absolute; width: 20px; height: 20px; border: 3px solid #10b981; background: rgba(16,185,129,0.2); }
      #deepfake-detector-video-highlight .corner-tl { top: -3px;    left: -3px;  border-right: none; border-bottom: none; border-radius: 8px 0 0 0; }
      #deepfake-detector-video-highlight .corner-tr { top: -3px;    right: -3px; border-left: none;  border-bottom: none; border-radius: 0 8px 0 0; }
      #deepfake-detector-video-highlight .corner-bl { bottom: -3px; left: -3px;  border-right: none; border-top: none;    border-radius: 0 0 0 8px; }
      #deepfake-detector-video-highlight .corner-br { bottom: -3px; right: -3px; border-left: none;  border-top: none;    border-radius: 0 0 8px 0; }
      #deepfake-detector-video-highlight .label {
        position: absolute; top: -35px; left: 50%; transform: translateX(-50%);
        background: rgba(16,185,129,0.95); color: white; padding: 6px 12px;
        border-radius: 6px; font-family: system-ui, sans-serif; font-size: 12px;
        font-weight: 600; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        backdrop-filter: blur(10px);
      }`;
    document.head.appendChild(style);
  }

  document.body.appendChild(videoHighlight);
  console.log('✅ Video highlight shown with corners');
}

function hideVideoHighlight() {
  if (videoHighlight) {
    videoHighlight.style.opacity = '0';
    setTimeout(() => { videoHighlight?.remove(); videoHighlight = null; }, 300);
  }
}

// ─── Status Indicator Overlay ─────────────────────────────────────────────────

function showStatusIndicator() {
  if (isIndicatorVisible && statusIndicator && document.body.contains(statusIndicator)) {
    console.log('Overlay already visible, skipping...');
    return;
  }
  if (statusIndicator && !document.body.contains(statusIndicator)) {
    statusIndicator = null;
  }

  console.log('Creating AI-powered status indicator overlay...');

  statusIndicator = document.createElement('div');
  statusIndicator.id = 'deepfake-detector-status';
  statusIndicator.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 12px;">

      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div id="pulse-dot" style="width: 10px; height: 10px; background: #10b981; border-radius: 50%; animation: pulse 2s infinite;"></div>
          <span style="font-weight: 600;">AI Protection Active</span>
        </div>
        <button id="minimize-btn" style="background: transparent; border: none; color: white; cursor: pointer; font-size: 16px; padding: 4px 8px; border-radius: 4px; transition: background 0.2s;" title="Minimize">−</button>
      </div>

      <div id="threat-indicator" style="padding: 12px; border-radius: 8px; background: linear-gradient(135deg, rgba(16,185,129,0.2), rgba(5,150,105,0.2)); border: 2px solid #10b981; text-align: center; transition: background 0.4s ease, border-color 0.3s ease;">
        <div style="font-size: 11px; color: rgba(255,255,255,0.7); margin-bottom: 4px;">AUTHENTICITY SCORE</div>
        <div style="display: flex; align-items: baseline; justify-content: center; gap: 6px;">
          <div id="confidence-display" style="font-size: 32px; font-weight: bold; color: #10b981; transition: color 0.4s ease;">100%</div>
          <div id="trend-display"      style="font-size: 16px; color: #10b981; transition: color 0.4s ease; line-height: 1;">→</div>
        </div>
        <div id="status-text" style="font-size: 12px; margin-top: 4px; color: #10b981; font-weight: 600; transition: color 0.4s ease;">✓ VERIFIED REAL</div>
        <!-- Stability bar -->
        <div style="margin-top: 8px; height: 3px; background: rgba(255,255,255,0.08); border-radius: 2px; overflow: hidden;">
          <div id="stability-bar" style="height: 100%; width: 100%; background: #10b981; border-radius: 2px; transition: width 0.6s ease, background 0.4s ease;"></div>
        </div>
        <div style="font-size: 9px; color: rgba(255,255,255,0.35); margin-top: 3px; letter-spacing: 0.5px;">SIGNAL STABILITY</div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12px; padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.1);">
        <div>
          <div style="color: rgba(255,255,255,0.6); margin-bottom: 4px;">Frames</div>
          <div id="frame-count" style="font-size: 16px; font-weight: bold; color: #10b981; transition: color 0.4s ease;">0</div>
        </div>
        <div>
          <div style="color: rgba(255,255,255,0.6); margin-bottom: 4px;">Smoothed</div>
          <div id="avg-score" style="font-size: 16px; font-weight: bold; color: #10b981; transition: color 0.4s ease;">100%</div>
        </div>
      </div>

      <div style="display: flex; gap: 8px;">
        <button id="stop-detection-btn" style="flex: 1; background: #ef4444; color: white; border: none; padding: 10px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">
          ⏹️ Stop Protection
        </button>
      </div>

    </div>`;

  statusIndicator.style.cssText = `
    position: fixed; top: 20px; right: 20px;
    background: rgba(0, 0, 0, 0.92); backdrop-filter: blur(12px);
    color: white; padding: 16px; border-radius: 12px;
    font-family: system-ui, -apple-system, sans-serif; font-size: 13px;
    z-index: 999999; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    border: 1px solid rgba(255,255,255,0.1); min-width: 300px;
    transition: all 0.3s ease; opacity: 0; transform: translateX(20px);`;

  if (!document.getElementById('deepfake-detector-styles')) {
    const style = document.createElement('style');
    style.id = 'deepfake-detector-styles';
    style.textContent = `
      @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(0.95); } }
      #deepfake-detector-status.minimized { padding: 12px 16px !important; }
      #deepfake-detector-status.minimized > div > div:not(:first-child) { display: none !important; }
      #stop-detection-btn:hover  { background: #dc2626 !important; transform: translateY(-1px); box-shadow: 0 4px 8px rgba(0,0,0,0.3) !important; }
      #stop-detection-btn:active { transform: translateY(0); }
      #minimize-btn:hover { background: rgba(255,255,255,0.1) !important; }
      .threat-safe    { background: linear-gradient(135deg, rgba(16,185,129,0.2), rgba(5,150,105,0.2))  !important; border-color: #10b981 !important; }
      .threat-warning { background: linear-gradient(135deg, rgba(251,191,36,0.2), rgba(245,158,11,0.2)) !important; border-color: #fbbf24 !important; }
      .threat-danger  { background: linear-gradient(135deg, rgba(239,68,68,0.2),  rgba(220,38,38,0.2))  !important; border-color: #ef4444 !important; }`;
    document.head.appendChild(style);
  }

  document.body.appendChild(statusIndicator);

  setTimeout(() => {
    if (statusIndicator) {
      statusIndicator.style.opacity   = '1';
      statusIndicator.style.transform = 'translateX(0)';
    }
  }, 10);

  frameCountDisplay = statusIndicator.querySelector('#frame-count');
  confidenceDisplay = statusIndicator.querySelector('#confidence-display');
  trendDisplay      = statusIndicator.querySelector('#trend-display');
  stabilityBar      = statusIndicator.querySelector('#stability-bar');
  threatIndicator   = statusIndicator.querySelector('#threat-indicator');
  statusText        = statusIndicator.querySelector('#status-text');

  statusIndicator.querySelector('#stop-detection-btn')?.addEventListener('click', handleStopDetection);
  statusIndicator.querySelector('#minimize-btn')?.addEventListener('click', handleMinimize);

  isIndicatorVisible = true;
  console.log('✅ AI-powered status indicator shown');
}

// ─── Detection result updater ─────────────────────────────────────────────────
// Uses result.smoothedConfidence (from temporal-smoother) as single source of truth.
// Local averaging deleted — no detectionHistory[], no HISTORY_SIZE.

function updateDetectionResult(result: DetectionResult) {
  if (!isIndicatorVisible || !statusIndicator) return;

  // smoothedConfidence is the EWMA+hysteresis value from the offscreen smoother.
  // Fall back to raw confidence if a very old offscreen build sends the message
  // before Chunk 3 lands — this guard can be removed once fully deployed.
  const smoothed = result.smoothedConfidence ?? result.confidence;
  const authenticityScore = Math.round((1 - smoothed) * 100);

  if (frameCountDisplay) frameCountDisplay.textContent = result.frameNumber.toString();
  if (confidenceDisplay) confidenceDisplay.textContent = `${authenticityScore}%`;

  // Smoothed score label — same value, explicit label changed from "Avg" to "Smoothed"
  const avgScoreDisplay = statusIndicator.querySelector('#avg-score') as HTMLElement | null;
  if (avgScoreDisplay) avgScoreDisplay.textContent = `${authenticityScore}%`;

  // Trend arrow — ↑ rising fake score (worse), ↓ falling fake score (better), → flat
  if (trendDisplay) {
    switch (result.trend) {
      case 'rising':  trendDisplay.textContent = '↑'; break;
      case 'falling': trendDisplay.textContent = '↓'; break;
      default:        trendDisplay.textContent = '→'; break;
    }
  }

  // Stability bar — result.stability is 0 (chaotic) to 1 (rock-steady)
  if (stabilityBar) {
    const stabilityPct = Math.round((result.stability ?? 1) * 100);
    stabilityBar.style.width = `${stabilityPct}%`;
    // Green when stable, amber when signal is noisy
    stabilityBar.style.background = stabilityPct > 60 ? '#10b981' : '#f59e0b';
  }

  if (threatIndicator && statusText && confidenceDisplay) {
    threatIndicator.classList.remove('threat-safe', 'threat-warning', 'threat-danger');

    let statusMessage = '';
    let color         = '';

    switch (result.threatLevel) {
      case 'safe':
        threatIndicator.classList.add('threat-safe');
        statusMessage = '✓ VERIFIED REAL';
        color         = '#10b981';
        break;
      case 'warning':
        threatIndicator.classList.add('threat-warning');
        statusMessage = '⚠ SUSPICIOUS ACTIVITY';
        color         = '#fbbf24';
        break;
      case 'danger':
        threatIndicator.classList.add('threat-danger');
        statusMessage = '🚨 DEEPFAKE DETECTED';
        color         = '#ef4444';
        break;
    }

    statusText.textContent        = statusMessage;
    statusText.style.color        = color;
    confidenceDisplay.style.color = color;
    if (trendDisplay)      trendDisplay.style.color      = color;
    if (frameCountDisplay) frameCountDisplay.style.color  = color;
    if (avgScoreDisplay)   avgScoreDisplay.style.color    = color;

    const pulseDot = statusIndicator.querySelector('#pulse-dot') as HTMLDivElement | null;
    if (pulseDot) pulseDot.style.background = color;
  }

  if (result.threatLevel !== 'safe') {
    console.warn(`⚠️ Threat: ${result.classification} | smoothed=${smoothed.toFixed(3)} | trend=${result.trend ?? '—'} | stability=${(result.stability ?? 1).toFixed(2)}`);
  }
}

// ─── Button handlers ──────────────────────────────────────────────────────────

function handleStopDetection() {
  console.log('🛑 Stop button clicked on overlay');
  chrome.runtime.sendMessage({ type: MessageType.STOP_CAPTURE }, (response) => {
    console.log('Stop capture response:', response);
  });
  const stopBtn = statusIndicator?.querySelector('#stop-detection-btn') as HTMLButtonElement;
  if (stopBtn) {
    stopBtn.textContent      = '✓ Stopping...';
    stopBtn.disabled         = true;
    stopBtn.style.background = '#6b7280';
    stopBtn.style.cursor     = 'not-allowed';
  }
}

function handleMinimize() {
  if (!statusIndicator) return;
  const isMinimized = statusIndicator.classList.contains('minimized');
  const minimizeBtn = statusIndicator.querySelector('#minimize-btn');
  if (isMinimized) {
    statusIndicator.classList.remove('minimized');
    if (minimizeBtn) minimizeBtn.textContent = '−';
  } else {
    statusIndicator.classList.add('minimized');
    if (minimizeBtn) minimizeBtn.textContent = '+';
  }
}

function hideStatusIndicator() {
  console.log('Hiding status indicator...');

  if (statusIndicator && document.body.contains(statusIndicator)) {
    statusIndicator.style.transition = 'opacity 0.3s, transform 0.3s';
    statusIndicator.style.opacity    = '0';
    statusIndicator.style.transform  = 'translateX(20px)';
    setTimeout(() => {
      if (statusIndicator) {
        statusIndicator.remove();
        statusIndicator = frameCountDisplay = confidenceDisplay = trendDisplay =
          stabilityBar = threatIndicator = statusText = null;
        isIndicatorVisible = false;
        console.log('✅ Status indicator removed from DOM');
      }
    }, 300);
  } else {
    statusIndicator = frameCountDisplay = confidenceDisplay = trendDisplay =
      stabilityBar = threatIndicator = statusText = null;
    isIndicatorVisible = false;
  }
  hideVideoHighlight();
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  if (isIndicatorVisible) hideStatusIndicator();
  videoDetector.stopWatching();
});