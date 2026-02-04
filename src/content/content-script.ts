// This script runs inside Google Meet pages
console.log('📹 Deepfake Detector content script loaded on:', window.location.href);

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Content script received:', message);
  
  if (message.type === 'EXTENSION_CLICKED') {
    // Show a temporary notification on the page
    showNotification(message.message);
    sendResponse({ received: true });
  }
  
  return true;
});

// Helper function to show notifications on the page
function showNotification(text: string) {
  // Create a simple notification div
  const notification = document.createElement('div');
  notification.textContent = text;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #4CAF50;
    color: white;
    padding: 15px 20px;
    border-radius: 8px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    z-index: 10000;
    font-family: Arial, sans-serif;
    font-size: 14px;
  `;
  
  document.body.appendChild(notification);
  
  // Remove after 3 seconds
  setTimeout(() => {
    notification.style.transition = 'opacity 0.3s';
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Check if we're on a Google Meet call
function isInMeetCall(): boolean {
  // Google Meet call URLs look like: https://meet.google.com/xxx-yyyy-zzz
  return window.location.pathname.length > 1 && window.location.pathname !== '/';
}

if (isInMeetCall()) {
  console.log('✅ Active Google Meet call detected');
  showNotification('Deepfake Detector is ready!');
} else {
  console.log('ℹ️ Not in a call yet. Join a meeting to start detection.');
}