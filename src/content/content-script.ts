import { MessageType } from '../utils/types';

console.log('📹 Deepfake Detector content script loaded on:', window.location.href);

// Create floating status indicator with stop button
let statusIndicator: HTMLDivElement | null = null;
let frameCountDisplay: HTMLSpanElement | null = null;
let isIndicatorVisible = false;

// Check detection status on load (in case extension was already running)
chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (response) => {
  if (response && response.isCapturing) {
    console.log('Detection already active on page load, showing overlay');
    showStatusIndicator();
  }
});

// Listen for status updates from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Content script received:', message.type, message.data);
  
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
    // Update frame count on overlay
    if (message.data.frameNumber) {
      updateFrameCount(message.data.frameNumber);
    }
  }
  
  sendResponse({ received: true });
  return true;
});

// Create and show status indicator overlay with stop button
function showStatusIndicator() {
  // If already showing, don't create duplicate
  if (isIndicatorVisible && statusIndicator && document.body.contains(statusIndicator)) {
    console.log('Overlay already visible, skipping...');
    return;
  }
  
  // Remove old indicator if it exists but isn't in DOM
  if (statusIndicator && !document.body.contains(statusIndicator)) {
    statusIndicator = null;
  }
  
  console.log('Creating status indicator overlay...');
  
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
            background: #ef4444;
            border-radius: 50%;
            animation: pulse 2s infinite;
          "></div>
          <span style="font-weight: 600;">Deepfake Detection Active</span>
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
      
      <!-- Stats -->
      <div style="
        display: flex;
        gap: 16px;
        font-size: 12px;
        padding: 8px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      ">
        <div>
          <div style="color: rgba(255, 255, 255, 0.6); margin-bottom: 4px;">Frames</div>
          <div id="frame-count" style="font-size: 18px; font-weight: bold; color: #10b981;">0</div>
        </div>
        <div>
          <div style="color: rgba(255, 255, 255, 0.6); margin-bottom: 4px;">Status</div>
          <div style="font-size: 14px; font-weight: 600; color: #10b981;">✓ Monitoring</div>
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
          ⏹️ Stop Detection
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
    min-width: 280px;
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
  
  // Store reference to frame count display
  frameCountDisplay = statusIndicator.querySelector('#frame-count');
  
  // Add event listeners
  const stopBtn = statusIndicator.querySelector('#stop-detection-btn');
  stopBtn?.addEventListener('click', handleStopDetection);
  
  const minimizeBtn = statusIndicator.querySelector('#minimize-btn');
  minimizeBtn?.addEventListener('click', handleMinimize);
  
  isIndicatorVisible = true;
  console.log('✅ Status indicator shown and visible');
}

// Handle stop button click
function handleStopDetection() {
  console.log('🛑 Stop button clicked on overlay');
  
  // Send message to background to stop capture
  chrome.runtime.sendMessage({
    type: MessageType.STOP_CAPTURE
  }, (response) => {
    console.log('Stop capture response:', response);
  });
  
  // Show temporary feedback
  const stopBtn = statusIndicator?.querySelector('#stop-detection-btn') as HTMLButtonElement;
  if (stopBtn) {
    stopBtn.textContent = '✓ Stopping...';
    stopBtn.disabled = true;
    stopBtn.style.background = '#6b7280';
    stopBtn.style.cursor = 'not-allowed';
  }
  
  // The STATUS_UPDATE message will trigger hideStatusIndicator
}

// Handle minimize/expand toggle
function handleMinimize() {
  if (!statusIndicator) return;
  
  const isMinimized = statusIndicator.classList.contains('minimized');
  const minimizeBtn = statusIndicator.querySelector('#minimize-btn');
  
  if (isMinimized) {
    // Expand
    statusIndicator.classList.remove('minimized');
    if (minimizeBtn) minimizeBtn.textContent = '−';
  } else {
    // Minimize
    statusIndicator.classList.add('minimized');
    if (minimizeBtn) minimizeBtn.textContent = '+';
  }
}

// Update frame count display
function updateFrameCount(count: number) {
  if (frameCountDisplay) {
    frameCountDisplay.textContent = count.toString();
  }
}

// Hide and remove status indicator
function hideStatusIndicator() {
  console.log('Hiding status indicator...');
  
  if (statusIndicator && document.body.contains(statusIndicator)) {
    // Fade out animation
    statusIndicator.style.transition = 'opacity 0.3s, transform 0.3s';
    statusIndicator.style.opacity = '0';
    statusIndicator.style.transform = 'translateX(20px)';
    
    setTimeout(() => {
      if (statusIndicator) {
        statusIndicator.remove();
        statusIndicator = null;
        frameCountDisplay = null;
        isIndicatorVisible = false;
        console.log('✅ Status indicator removed from DOM');
      }
    }, 300);
  } else {
    // Already removed or never existed
    statusIndicator = null;
    frameCountDisplay = null;
    isIndicatorVisible = false;
    console.log('Status indicator was not in DOM');
  }
}

// Check if we're in an active Google Meet call
function isInActiveMeetCall(): boolean {
  // Check URL structure
  const isInCall = window.location.pathname.length > 1 && 
                   window.location.pathname !== '/';
  
  // Also check for video elements (more reliable)
  const hasVideo = document.querySelectorAll('video').length > 0;
  
  return isInCall && hasVideo;
}

// Initial check
if (isInActiveMeetCall()) {
  console.log('✅ Active Google Meet call detected');
} else {
  console.log('ℹ️ Not in an active call yet');
}

// Monitor for when user joins/leaves call
const observer = new MutationObserver(() => {
  const inCall = isInActiveMeetCall();
  // Just log, don't auto-show overlay
  // Overlay should only show when user explicitly starts detection
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (isIndicatorVisible) {
    console.log('Page unloading, cleaning up overlay');
    hideStatusIndicator();
  }
});