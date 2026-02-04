// This is the extension's background script (always running)
console.log('🚀 Deepfake Detector Extension Loaded!');

// Listen for extension icon clicks
chrome.action.onClicked.addListener(async (tab) => {
  console.log('Extension icon clicked on tab:', tab.id);
  
  // For now, just show an alert
  // Later we'll start video capture here
  chrome.tabs.sendMessage(tab.id!, {
    type: 'EXTENSION_CLICKED',
    message: 'Ready to detect deepfakes!'
  });
});

// Listen for messages from other parts of the extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message);
  
  if (message.type === 'GET_STATUS') {
    sendResponse({ status: 'active', version: '0.1.0' });
  }
  
  return true; // Keep channel open for async responses
});

// Extension installed/updated
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('✅ Extension installed successfully!');
  } else if (details.reason === 'update') {
    console.log('🔄 Extension updated to version', chrome.runtime.getManifest().version);
  }
});