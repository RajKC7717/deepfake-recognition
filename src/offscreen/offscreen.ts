// This will handle video processing later
console.log('Offscreen document loaded');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen received:', message);
  
  if (message.type === 'PROCESS_VIDEO') {
    // We'll implement video processing here later
    sendResponse({ status: 'Processing started' });
  }
  
  return true;
});