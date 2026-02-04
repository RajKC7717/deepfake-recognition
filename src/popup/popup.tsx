import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageType, DetectionStatus } from '../utils/types';

const Popup: React.FC = () => {
  const [status, setStatus] = useState<DetectionStatus>({
    isCapturing: false,
    framesProcessed: 0
  });
  const [currentTab, setCurrentTab] = useState<chrome.tabs.Tab | null>(null);
  const [lastFrame, setLastFrame] = useState<string | null>(null);
  
  // Ref to track if we're actively polling
  const pollingRef = useRef<number | null>(null);

  useEffect(() => {
    // Get current tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      setCurrentTab(tabs[0]);
    });
    
    // Get initial status from background
    chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (response) => {
      if (response) {
        setStatus(response);
      }
    });
    
    // Listen for updates from background
    const messageListener = (message: any) => {
      if (message.type === MessageType.DETECTION_RESULT) {
        setLastFrame(message.data.imageData || null);
        
        // Update frame count from detection results
        chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (response) => {
          if (response) setStatus(response);
        });
      } else if (message.type === MessageType.STATUS_UPDATE) {
        // Status changed (started or stopped externally)
        chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (response) => {
          if (response) setStatus(response);
        });
      }
    };
    
    chrome.runtime.onMessage.addListener(messageListener);
    
    // Poll status while capturing (every 500ms)
    const startPolling = () => {
      if (pollingRef.current) return;
      
      pollingRef.current = window.setInterval(() => {
        chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (response) => {
          if (response) {
            setStatus(response);
            
            // If stopped externally, stop polling
            if (!response.isCapturing && pollingRef.current) {
              clearInterval(pollingRef.current);
              pollingRef.current = null;
            }
          }
        });
      }, 500);
    };
    
    const stopPolling = () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
    
    // Start polling if already capturing
    if (status.isCapturing) {
      startPolling();
    }
    
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      stopPolling();
    };
  }, []);
  
  // Start/stop polling when capture status changes
  useEffect(() => {
    if (status.isCapturing && !pollingRef.current) {
      pollingRef.current = window.setInterval(() => {
        chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (response) => {
          if (response) {
            setStatus(response);
            
            if (!response.isCapturing && pollingRef.current) {
              clearInterval(pollingRef.current);
              pollingRef.current = null;
            }
          }
        });
      }, 500);
    } else if (!status.isCapturing && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, [status.isCapturing]);

  const handleToggleCapture = async () => {
    if (!currentTab?.id) return;
    
    if (status.isCapturing) {
      // Stop capture
      chrome.runtime.sendMessage({
        type: MessageType.STOP_CAPTURE
      }, (response) => {
        console.log('Stop response:', response);
      });
    } else {
      // Check if on Google Meet
      if (!currentTab.url?.includes('meet.google.com')) {
        alert('⚠️ Please open a Google Meet call first!\n\nThis extension currently works on meet.google.com');
        return;
      }
      
      // Start capture
      chrome.runtime.sendMessage({
        type: MessageType.START_CAPTURE,
        data: { tabId: currentTab.id }
      }, (response) => {
        console.log('Start response:', response);
      });
    }
  };

  const isOnMeet = currentTab?.url?.includes('meet.google.com');
  const captureTime = status.startTime 
    ? Math.floor((Date.now() - status.startTime) / 1000) 
    : 0;

  return (
    <div style={{ width: '360px', padding: '16px', fontFamily: 'system-ui' }}>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <h1 style={{ 
          fontSize: '20px', 
          margin: '0 0 4px 0', 
          display: 'flex', 
          alignItems: 'center',
          gap: '8px'
        }}>
          🛡️ Deepfake Detector
          {status.isCapturing && (
            <span style={{
              fontSize: '10px',
              background: '#ef4444',
              color: 'white',
              padding: '2px 6px',
              borderRadius: '4px',
              fontWeight: 'normal'
            }}>
              LIVE
            </span>
          )}
        </h1>
        <p style={{ fontSize: '12px', color: '#666', margin: 0 }}>
          Privacy-First Real-Time Detection
        </p>
      </div>

      {/* Current Tab Status */}
      <div style={{
        background: isOnMeet ? '#dcfce7' : '#fee2e2',
        border: `1px solid ${isOnMeet ? '#86efac' : '#fca5a5'}`,
        borderRadius: '8px',
        padding: '12px',
        marginBottom: '16px',
        fontSize: '13px'
      }}>
        <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
          {isOnMeet ? '✅ Google Meet Detected' : '⚠️ Not on Google Meet'}
        </div>
        <div style={{ fontSize: '11px', color: '#666', wordBreak: 'break-all' }}>
          {currentTab?.url || 'No URL'}
        </div>
      </div>

      {/* Stats (when capturing) */}
      {status.isCapturing && (
        <div style={{
          background: '#f3f4f6',
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '16px'
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '11px', color: '#666' }}>Frames Analyzed</div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#10b981' }}>
                {status.framesProcessed}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#666' }}>Duration</div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#3b82f6' }}>
                {captureTime}s
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Action Button */}
      <button
        onClick={handleToggleCapture}
        disabled={!isOnMeet && !status.isCapturing}
        style={{
          width: '100%',
          padding: '14px',
          fontSize: '15px',
          fontWeight: 'bold',
          border: 'none',
          borderRadius: '8px',
          cursor: (!isOnMeet && !status.isCapturing) ? 'not-allowed' : 'pointer',
          background: status.isCapturing 
            ? '#ef4444' 
            : (!isOnMeet ? '#d1d5db' : '#10b981'),
          color: 'white',
          transition: 'all 0.2s',
          opacity: (!isOnMeet && !status.isCapturing) ? 0.5 : 1
        }}
        onMouseEnter={(e) => {
          if (isOnMeet || status.isCapturing) {
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = 'none';
        }}
      >
        {status.isCapturing ? '⏹️ Stop Detection' : '▶️ Start Detection'}
      </button>

      {/* Hint when capturing */}
      {status.isCapturing && (
        <div style={{
          marginTop: '12px',
          padding: '10px',
          background: '#fff7ed',
          border: '1px solid #fed7aa',
          borderRadius: '6px',
          fontSize: '12px',
          color: '#c2410c'
        }}>
          💡 <strong>Tip:</strong> You can also stop detection using the button on the Meet page.
        </div>
      )}

      {/* Privacy Notice */}
      <div style={{
        marginTop: '16px',
        padding: '12px',
        background: '#eff6ff',
        borderRadius: '6px',
        fontSize: '11px',
        color: '#1e40af',
        lineHeight: '1.5'
      }}>
        <strong>🔒 Privacy First:</strong> All analysis happens locally on your device. 
        No video leaves your browser. No cloud upload. No tracking.
      </div>

      {/* Debug Info (development only) */}
      {process.env.NODE_ENV === 'development' && lastFrame && (
        <div style={{ marginTop: '12px' }}>
          <div style={{ fontSize: '11px', color: '#666', marginBottom: '4px' }}>
            Last Captured Frame:
          </div>
          <img 
            src={lastFrame} 
            alt="Last frame" 
            style={{ 
              width: '100%', 
              borderRadius: '4px',
              border: '1px solid #ddd'
            }} 
          />
        </div>
      )}
    </div>
  );
};

// Render
const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<Popup />);