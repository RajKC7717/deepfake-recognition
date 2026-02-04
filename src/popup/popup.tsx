import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

const Popup: React.FC = () => {
  const [status, setStatus] = useState<string>('Checking...');
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    // Get status from background script
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (response) {
        setStatus(`Extension v${response.version} - ${response.status}`);
      }
    });
  }, []);

  const handleStartDetection = async () => {
    setIsActive(true);
    
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab.url?.includes('meet.google.com')) {
      chrome.tabs.sendMessage(tab.id!, {
        type: 'START_DETECTION',
        message: 'Starting deepfake detection...'
      });
    } else {
      alert('Please open a Google Meet call first!');
      setIsActive(false);
    }
  };

  return (
    <div style={{ padding: '16px' }}>
      <h1 style={{ fontSize: '18px', marginBottom: '12px', color: '#333' }}>
        🛡️ Deepfake Detector
      </h1>
      
      <p style={{ fontSize: '12px', color: '#666', marginBottom: '16px' }}>
        {status}
      </p>
      
      <button
        onClick={handleStartDetection}
        disabled={isActive}
        style={{
          width: '100%',
          padding: '12px',
          backgroundColor: isActive ? '#ccc' : '#4CAF50',
          color: 'white',
          border: 'none',
          borderRadius: '6px',
          fontSize: '14px',
          fontWeight: 'bold',
          cursor: isActive ? 'not-allowed' : 'pointer',
          transition: 'background-color 0.2s'
        }}
      >
        {isActive ? 'Detection Active ✓' : 'Start Detection'}
      </button>
      
      <div style={{
        marginTop: '16px',
        padding: '12px',
        backgroundColor: '#f5f5f5',
        borderRadius: '6px',
        fontSize: '11px',
        color: '#666'
      }}>
        🔒 <strong>Privacy:</strong> All analysis happens locally on your device.
        No video is uploaded.
      </div>
    </div>
  );
};

// Render React app
const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<Popup />);