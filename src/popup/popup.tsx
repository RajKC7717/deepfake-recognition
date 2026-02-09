import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageType, DetectionStatus, DetectionResult } from '../utils/types';

const Popup: React.FC = () => {
  const [status, setStatus] = useState<DetectionStatus>({
    isCapturing: false,
    framesProcessed: 0,
    modelLoaded: false
  });
  const [currentTab, setCurrentTab] = useState<chrome.tabs.Tab | null>(null);
  const [lastResult, setLastResult] = useState<DetectionResult | null>(null);
  const [threatStats, setThreatStats] = useState({
    safe: 0,
    warning: 0,
    danger: 0
  });
  
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
        const result = message.data as DetectionResult;
        setLastResult(result);
        
        // Update threat statistics
        setThreatStats(prev => ({
          ...prev,
          [result.threatLevel]: prev[result.threatLevel] + 1
        }));
        
        // Update frame count
        chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (response) => {
          if (response) setStatus(response);
        });
      } else if (message.type === MessageType.STATUS_UPDATE) {
        chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (response) => {
          if (response) setStatus(response);
        });
      } else if (message.type === MessageType.MODEL_READY) {
        setStatus(prev => ({ ...prev, modelLoaded: true }));
      }
    };
    
    chrome.runtime.onMessage.addListener(messageListener);
    
    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, []);
  
  // Poll status while capturing
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
      chrome.runtime.sendMessage({
        type: MessageType.STOP_CAPTURE
      });
    } else {
      if (!currentTab.url?.includes('meet.google.com')) {
        alert('⚠️ Please open a Google Meet call first!\n\nThis extension currently works on meet.google.com');
        return;
      }
      
      chrome.runtime.sendMessage({
        type: MessageType.START_CAPTURE,
        data: { tabId: currentTab.id }
      });
    }
  };

  const isOnMeet = currentTab?.url?.includes('meet.google.com');
  const captureTime = status.startTime 
    ? Math.floor((Date.now() - status.startTime) / 1000) 
    : 0;
  
  // FIX: Only calculate if we have valid detection result
  const authenticityScore = lastResult && typeof lastResult.confidence === 'number'
    ? Math.round((1 - lastResult.confidence) * 100)
    : 100; // Default to 100% (safe) when no results yet
  
  const getThreatColor = (level?: string) => {
    switch (level) {
      case 'safe': return '#10b981';
      case 'warning': return '#fbbf24';
      case 'danger': return '#ef4444';
      default: return '#6b7280';
    }
  };

  return (
    <div style={{ width: '380px', padding: '16px', fontFamily: 'system-ui' }}>
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
          AI-Powered Real-Time Protection
        </p>
      </div>

      {/* AI Model Status */}
      {status.isCapturing && !status.modelLoaded && (
        <div style={{
          background: '#fef3c7',
          border: '1px solid #fbbf24',
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '16px',
          fontSize: '13px',
          color: '#92400e'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>
            ⏳ Loading AI Models...
          </div>
          <div style={{ fontSize: '11px' }}>
            TensorFlow.js and MediaPipe Face Mesh are initializing
          </div>
        </div>
      )}

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

      {/* Real-time Authenticity Score - Only show when we have results */}
      {status.isCapturing && lastResult && status.modelLoaded && (
        <div style={{
          background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
          borderRadius: '12px',
          padding: '16px',
          marginBottom: '16px',
          border: `2px solid ${getThreatColor(lastResult.threatLevel)}`
        }}>
          <div style={{ textAlign: 'center', color: 'white' }}>
            <div style={{ fontSize: '11px', opacity: 0.7, marginBottom: '8px' }}>
              AUTHENTICITY SCORE
            </div>
            <div style={{ 
              fontSize: '48px', 
              fontWeight: 'bold',
              color: getThreatColor(lastResult.threatLevel)
            }}>
              {authenticityScore}%
            </div>
            <div style={{ 
              fontSize: '13px', 
              marginTop: '8px',
              fontWeight: '600',
              color: getThreatColor(lastResult.threatLevel)
            }}>
              {lastResult.threatLevel === 'safe' && '✓ VERIFIED REAL'}
              {lastResult.threatLevel === 'warning' && '⚠ SUSPICIOUS'}
              {lastResult.threatLevel === 'danger' && '🚨 DEEPFAKE DETECTED'}
            </div>
          </div>
        </div>
      )}

      {/* Waiting for AI analysis */}
      {status.isCapturing && !lastResult && status.modelLoaded && (
        <div style={{
          background: 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
          borderRadius: '12px',
          padding: '16px',
          marginBottom: '16px',
          border: '2px solid #6b7280'
        }}>
          <div style={{ textAlign: 'center', color: 'white' }}>
            <div style={{ fontSize: '11px', opacity: 0.7, marginBottom: '8px' }}>
              ANALYZING VIDEO
            </div>
            <div style={{ 
              fontSize: '32px', 
              fontWeight: 'bold',
              color: '#6b7280'
            }}>
              ⏳
            </div>
            <div style={{ 
              fontSize: '13px', 
              marginTop: '8px',
              color: '#9ca3af'
            }}>
              Waiting for faces...
            </div>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      {status.isCapturing && (
        <div style={{
          background: '#f3f4f6',
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '16px'
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '11px', color: '#666' }}>Frames</div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#3b82f6' }}>
                {status.framesProcessed}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#666' }}>Duration</div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#8b5cf6' }}>
                {captureTime}s
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#666' }}>Face</div>
              <div style={{ fontSize: '20px', fontWeight: 'bold', color: lastResult?.faceDetected ? '#10b981' : '#ef4444' }}>
                {lastResult?.faceDetected ? '✓' : '✗'}
              </div>
            </div>
          </div>
          
          {/* Threat Statistics */}
          {(threatStats.safe > 0 || threatStats.warning > 0 || threatStats.danger > 0) && (
            <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #e5e7eb' }}>
              <div style={{ fontSize: '11px', color: '#666', marginBottom: '6px' }}>
                Detection Summary
              </div>
              <div style={{ display: 'flex', gap: '8px', fontSize: '11px' }}>
                <div style={{ color: '#10b981' }}>
                  ✓ Safe: {threatStats.safe}
                </div>
                <div style={{ color: '#fbbf24' }}>
                  ⚠ Warning: {threatStats.warning}
                </div>
                <div style={{ color: '#ef4444' }}>
                  🚨 Danger: {threatStats.danger}
                </div>
              </div>
            </div>
          )}
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
        {status.isCapturing ? '⏹️ Stop Protection' : '▶️ Start Protection'}
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
          💡 <strong>Tip:</strong> Check the overlay on the Meet page for real-time results.
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
        <strong>🔒 Privacy First:</strong> All AI analysis happens locally using TensorFlow.js and MediaPipe. 
        No video leaves your browser. Zero cloud upload. Zero tracking.
      </div>

      {/* Performance Info - Only show when we have results */}
      {lastResult && status.isCapturing && (
        <div style={{
          marginTop: '12px',
          padding: '10px',
          background: '#f9fafb',
          borderRadius: '6px',
          fontSize: '10px',
          color: '#6b7280'
        }}>
          ⚡ Inference: {lastResult.inferenceTime.toFixed(0)}ms/frame
          {lastResult.visualArtifactScore > 0 && (
            <> • Artifact Score: {(lastResult.visualArtifactScore * 100).toFixed(1)}%</>
          )}
        </div>
      )}
    </div>
  );
};

// Render
const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<Popup />);