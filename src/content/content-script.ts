import { MessageType, DetectionResult } from '../utils/types';

console.log('📹 Deepfake Detector content script loaded on:', window.location.href);

// Create floating status indicator with stop button
let statusIndicator: HTMLDivElement | null = null;
let frameCountDisplay: HTMLSpanElement | null = null;
let confidenceDisplay: HTMLSpanElement | null = null;
let threatIndicator: HTMLDivElement | null = null;
let statusText: HTMLDivElement | null = null;
let isIndicatorVisible = false;

// Track detection history for averaging
let detectionHistory: number[] = [];
const HISTORY_SIZE = 10;

// Check detection status on load (in case extension was already running)
chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (response) => {
  if (response && response.isCapturing) {
    console.log('Detection already active on page load, showing overlay');
    showStatusIndicator();
  }
});

// Listen for status updates from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Content script received:', message.type);
  
  if (message.type === MessageType.STATUS_UPDATE) {
    const { status } = message.data;
    
    if (status === 'active') {
      console.log('✅ Status: ACTIVE - Showing overlay');
      showStatusIndicator();
    } else if (status === 'stopped') {
      console.log('🛑 Status: STOPPED - Hiding overlay');
      hideStatusIndicator();
    }
  } else if (message.type === MessageType.DETECTION_RESULT) {
    // Update with AI detection results
    updateDetectionResult(message.data as DetectionResult);
  } else if (message.type === MessageType.MODEL_READY) {
    console.log('✅ AI Model ready:', message.data);
  }
  
  sendResponse({ received: true });
  return true;
});

// Create and show status indicator overlay with AI results
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
    <div style="
      display: flex;
      flex-direction: column;
      gap: 12px;
    ">
      <!-- Status Header -->
      <div style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      ">
        <div style="
          display: flex;
          align-items: center;
          gap: 8px;
        ">
          <div id="pulse-dot" style="
            width: 10px;
            height: 10px;
            background: #10b981;
            border-radius: 50%;
            animation: pulse 2s infinite;
          "></div>
          <span style="font-weight: 600;">AI Protection Active</span>
        </div>
        <button id="minimize-btn" style="
          background: transparent;
          border: none;
          color: white;
          cursor: pointer;
          font-size: 16px;
          padding: 4px 8px;
          border-radius: 4px;
          transition: background 0.2s;
        " title="Minimize">−</button>
      </div>
      
      <!-- Threat Level Indicator -->
      <div id="threat-indicator" style="
        padding: 12px;
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(5, 150, 105, 0.2));
        border: 2px solid #10b981;
        text-align: center;
        transition: all 0.3s;
      ">
        <div style="font-size: 11px; color: rgba(255, 255, 255, 0.7); margin-bottom: 4px;">
          AUTHENTICITY SCORE
        </div>
        <div id="confidence-display" style="font-size: 32px; font-weight: bold; color: #10b981;">
          100%
        </div>
        <div id="status-text" style="font-size: 12px; margin-top: 4px; color: #10b981; font-weight: 600;">
          ✓ VERIFIED REAL
        </div>
      </div>
      
      <!-- Stats -->
      <div style="
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        font-size: 12px;
        padding: 8px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
      ">
        <div>
          <div style="color: rgba(255, 255, 255, 0.6); margin-bottom: 4px;">Frames</div>
          <div id="frame-count" style="font-size: 16px; font-weight: bold; color: #10b981;">0</div>
        </div>
        <div>
          <div style="color: rgba(255, 255, 255, 0.6); margin-bottom: 4px;">Avg Score</div>
          <div id="avg-score" style="font-size: 16px; font-weight: bold; color: #10b981;">100%</div>
        </div>
      </div>
      
      <!-- Actions -->
      <div style="display: flex; gap: 8px;">
        <button id="stop-detection-btn" style="
          flex: 1;
          background: #ef4444;
          color: white;
          border: none;
          padding: 10px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        ">
          ⏹️ Stop Protection
        </button>
      </div>
    </div>
  `;
  
  statusIndicator.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: rgba(0, 0, 0, 0.92);
    backdrop-filter: blur(12px);
    color: white;
    padding: 16px;
    border-radius: 12px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    z-index: 999999;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
    min-width: 300px;
    transition: all 0.3s ease;
    opacity: 0;
    transform: translateX(20px);
  `;
  
  // Add styles if not already added
  if (!document.getElementById('deepfake-detector-styles')) {
    const style = document.createElement('style');
    style.id = 'deepfake-detector-styles';
    style.textContent = `
      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(0.95); }
      }
      
      #deepfake-detector-status.minimized {
        padding: 12px 16px !important;
      }
      
      #deepfake-detector-status.minimized > div > div:not(:first-child) {
        display: none !important;
      }
      
      #stop-detection-btn:hover {
        background: #dc2626 !important;
        transform: translateY(-1px);
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3) !important;
      }
      
      #stop-detection-btn:active {
        transform: translateY(0);
      }
      
      #minimize-btn:hover {
        background: rgba(255, 255, 255, 0.1) !important;
      }
      
      .threat-safe {
        background: linear-gradient(135deg, rgba(16, 185, 129, 0.2), rgba(5, 150, 105, 0.2)) !important;
        border-color: #10b981 !important;
      }
      
      .threat-warning {
        background: linear-gradient(135deg, rgba(251, 191, 36, 0.2), rgba(245, 158, 11, 0.2)) !important;
        border-color: #fbbf24 !important;
      }
      
      .threat-danger {
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(220, 38, 38, 0.2)) !important;
        border-color: #ef4444 !important;
      }
    `;
    document.head.appendChild(style);
  }
  
  document.body.appendChild(statusIndicator);
  
  // Trigger fade-in animation
  setTimeout(() => {
    if (statusIndicator) {
      statusIndicator.style.opacity = '1';
      statusIndicator.style.transform = 'translateX(0)';
    }
  }, 10);
  
  // Store references
  frameCountDisplay = statusIndicator.querySelector('#frame-count');
  confidenceDisplay = statusIndicator.querySelector('#confidence-display');
  threatIndicator = statusIndicator.querySelector('#threat-indicator');
  statusText = statusIndicator.querySelector('#status-text');
  
  // Add event listeners
  const stopBtn = statusIndicator.querySelector('#stop-detection-btn');
  stopBtn?.addEventListener('click', handleStopDetection);
  
  const minimizeBtn = statusIndicator.querySelector('#minimize-btn');
  minimizeBtn?.addEventListener('click', handleMinimize);
  
  isIndicatorVisible = true;
  console.log('✅ AI-powered status indicator shown');
}

// Update UI with detection results from AI
function updateDetectionResult(result: DetectionResult) {
  if (!isIndicatorVisible || !statusIndicator) return;
  
  // Update frame count
  if (frameCountDisplay) {
    frameCountDisplay.textContent = result.frameNumber.toString();
  }
  
  // Update confidence (convert to authenticity percentage)
  const authenticityScore = Math.round((1 - result.confidence) * 100);
  
  if (confidenceDisplay) {
    confidenceDisplay.textContent = `${authenticityScore}%`;
  }
  
  // Add to history for averaging
  detectionHistory.push(authenticityScore);
  if (detectionHistory.length > HISTORY_SIZE) {
    detectionHistory.shift();
  }
  
  // Calculate and display average
  const avgScore = Math.round(
    detectionHistory.reduce((a, b) => a + b, 0) / detectionHistory.length
  );
  
  const avgScoreDisplay = statusIndicator.querySelector('#avg-score');
  if (avgScoreDisplay) {
    avgScoreDisplay.textContent = `${avgScore}%`;
  }
  
  // Update threat level styling
  if (threatIndicator && statusText && confidenceDisplay) {
    // Remove all threat classes
    threatIndicator.classList.remove('threat-safe', 'threat-warning', 'threat-danger');
    
    let statusMessage = '';
    let color = '';
    let pulseColor = '';
    
    switch (result.threatLevel) {
      case 'safe':
        threatIndicator.classList.add('threat-safe');
        statusMessage = '✓ VERIFIED REAL';
        color = '#10b981';
        pulseColor = '#10b981';
        break;
        
      case 'warning':
        threatIndicator.classList.add('threat-warning');
        statusMessage = '⚠ SUSPICIOUS ACTIVITY';
        color = '#fbbf24';
        pulseColor = '#fbbf24';
        break;
        
      case 'danger':
        threatIndicator.classList.add('threat-danger');
        statusMessage = '🚨 DEEPFAKE DETECTED';
        color = '#ef4444';
        pulseColor = '#ef4444';
        break;
    }
    
    statusText.textContent = statusMessage;
    statusText.style.color = color;
    confidenceDisplay.style.color = color;
    
    // Update pulse dot color
    const pulseDot = statusIndicator.querySelector('#pulse-dot') as HTMLDivElement;
    if (pulseDot) {
      pulseDot.style.background = pulseColor;
    }
    
    // Update average score color
    if (avgScoreDisplay) {
      (avgScoreDisplay as HTMLElement).style.color = color;
    }
    
    if (frameCountDisplay) {
      frameCountDisplay.style.color = color;
    }
  }
  
  // Log detection for debugging
  if (result.threatLevel !== 'safe') {
    console.warn(`⚠️ Threat detected: ${result.classification} (${(result.confidence * 100).toFixed(1)}%)`);
  }
}

// Handle stop button click
function handleStopDetection() {
  console.log('🛑 Stop button clicked on overlay');
  
  chrome.runtime.sendMessage({
    type: MessageType.STOP_CAPTURE
  }, (response) => {
    console.log('Stop capture response:', response);
  });
  
  const stopBtn = statusIndicator?.querySelector('#stop-detection-btn') as HTMLButtonElement;
  if (stopBtn) {
    stopBtn.textContent = '✓ Stopping...';
    stopBtn.disabled = true;
    stopBtn.style.background = '#6b7280';
    stopBtn.style.cursor = 'not-allowed';
  }
}

// Handle minimize/expand toggle
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

// Hide and remove status indicator
function hideStatusIndicator() {
  console.log('Hiding status indicator...');
  
  // Reset detection history
  detectionHistory = [];
  
  if (statusIndicator && document.body.contains(statusIndicator)) {
    statusIndicator.style.transition = 'opacity 0.3s, transform 0.3s';
    statusIndicator.style.opacity = '0';
    statusIndicator.style.transform = 'translateX(20px)';
    
    setTimeout(() => {
      if (statusIndicator) {
        statusIndicator.remove();
        statusIndicator = null;
        frameCountDisplay = null;
        confidenceDisplay = null;
        threatIndicator = null;
        statusText = null;
        isIndicatorVisible = false;
        console.log('✅ Status indicator removed from DOM');
      }
    }, 300);
  } else {
    statusIndicator = null;
    frameCountDisplay = null;
    confidenceDisplay = null;
    threatIndicator = null;
    statusText = null;
    isIndicatorVisible = false;
    console.log('Status indicator was not in DOM');
  }
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (isIndicatorVisible) {
    console.log('Page unloading, cleaning up overlay');
    hideStatusIndicator();
  }
});