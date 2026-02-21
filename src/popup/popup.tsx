import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageType, DetectionStatus, DetectionResult } from '../utils/types';

// ─── Types ────────────────────────────────────────────────────────────────────

type VideoState = 'checking' | 'not-found' | 'found' | 'not-meet';
type AppState = 'idle' | 'starting' | 'active' | 'stopping';

interface PopupState {
  appState: AppState;
  videoState: VideoState;
  modelLoaded: boolean;
  framesProcessed: number;
  latestResult: DetectionResult | null;
  averageConfidence: number | null;
  activeTabId: number | null;
  isMeetTab: boolean;
  backend: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getThreatColor(level: string): string {
  switch (level) {
    case 'danger':  return '#ef4444';
    case 'warning': return '#f59e0b';
    default:        return '#10b981';
  }
}

function getAuthenticityScore(confidence: number): number {
  return Math.round((1 - confidence) * 100);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const PulseDot = ({ color = '#10b981', animate = true }: { color?: string; animate?: boolean }) => (
  <span style={{
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
    animation: animate ? 'pulse 2s infinite' : 'none',
    flexShrink: 0,
  }} />
);

const VideoStatusBadge = ({ state }: { state: VideoState }) => {
  const config: Record<VideoState, { icon: string; label: string; color: string; bg: string }> = {
    checking:  { icon: '⏳', label: 'Checking for video...', color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' },
    'not-found': { icon: '⚠️', label: 'No video detected',     color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
    found:     { icon: '✅', label: 'Video detected',          color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
    'not-meet':{ icon: '🔗', label: 'Open Google Meet first',  color: '#6366f1', bg: 'rgba(99,102,241,0.1)' },
  };
  const c = config[state];

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 12px',
      borderRadius: 8,
      background: c.bg,
      border: `1px solid ${c.color}33`,
      fontSize: 12,
      color: c.color,
      fontWeight: 500,
    }}>
      <span>{c.icon}</span>
      <span>{c.label}</span>
    </div>
  );
};

const ModelBadge = ({ loaded, backend }: { loaded: boolean; backend: string }) => (
  <div style={{
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: loaded ? '#10b981' : '#94a3b8',
  }}>
    <PulseDot color={loaded ? '#10b981' : '#94a3b8'} animate={!loaded} />
    {loaded ? `AI Ready · ${backend.toUpperCase()}` : 'Loading AI model...'}
  </div>
);

const ThreatMeter = ({ result }: { result: DetectionResult }) => {
  const score = getAuthenticityScore(result.confidence);
  const color = getThreatColor(result.threatLevel);
  const labels: Record<string, string> = {
    safe: '✓ VERIFIED REAL',
    warning: '⚠ SUSPICIOUS',
    danger: '🚨 DEEPFAKE DETECTED',
  };

  return (
    <div style={{
      padding: '12px 16px',
      borderRadius: 10,
      border: `2px solid ${color}`,
      background: `${color}15`,
      textAlign: 'center',
      transition: 'all 0.4s ease',
    }}>
      <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 4, letterSpacing: 1 }}>
        AUTHENTICITY SCORE
      </div>
      <div style={{ fontSize: 36, fontWeight: 800, color, lineHeight: 1 }}>
        {score}%
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color, marginTop: 4 }}>
        {labels[result.threatLevel]}
      </div>
      {/* Progress bar */}
      <div style={{
        marginTop: 8,
        height: 4,
        background: 'rgba(255,255,255,0.1)',
        borderRadius: 2,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${score}%`,
          background: color,
          borderRadius: 2,
          transition: 'width 0.5s ease',
        }} />
      </div>
    </div>
  );
};

const StatPill = ({ label, value, color = '#10b981' }: { label: string; value: string; color?: string }) => (
  <div style={{
    flex: 1,
    padding: '8px 12px',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.08)',
  }}>
    <div style={{ fontSize: 10, color: '#64748b', marginBottom: 2 }}>{label}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
  </div>
);

// ─── Main Popup Component ─────────────────────────────────────────────────────

function Popup() {
  const [state, setState] = useState<PopupState>({
    appState: 'idle',
    videoState: 'checking',
    modelLoaded: false,
    framesProcessed: 0,
    latestResult: null,
    averageConfidence: null,
    activeTabId: null,
    isMeetTab: false,
    backend: 'webgl',
  });

  // ── Boot: get current tab and check if it's Meet ──────────────────────────
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;

      const isMeet = !!tab.url?.includes('meet.google.com');
      setState(s => ({
        ...s,
        activeTabId: tab.id!,
        isMeetTab: isMeet,
        videoState: isMeet ? 'checking' : 'not-meet',
      }));

      // Check background status (may already be capturing)
      chrome.runtime.sendMessage({ type: MessageType.GET_STATUS }, (status: DetectionStatus) => {
        if (status?.isCapturing) {
          setState(s => ({
            ...s,
            appState: 'active',
            framesProcessed: status.framesProcessed,
            modelLoaded: !!status.modelLoaded,
            videoState: status.videoRegionDetected ? 'found' : s.videoState,
          }));
        }
        if (status?.modelLoaded) {
          setState(s => ({ ...s, modelLoaded: true }));
        }
      });

      // If on Meet, check for video element
      if (isMeet) {
        checkForVideo(tab.id!);
      }
    });
  }, []);

  // ── Poll for video detection every 2s when idle on Meet ──────────────────
  useEffect(() => {
    if (!state.isMeetTab || state.appState !== 'idle') return;
    const interval = setInterval(() => {
      if (state.activeTabId) checkForVideo(state.activeTabId);
    }, 2000);
    return () => clearInterval(interval);
  }, [state.isMeetTab, state.appState, state.activeTabId]);

  // ── Listen for messages from background ─────────────────────────────────
  useEffect(() => {
    const handler = (message: any) => {
      if (message.type === MessageType.DETECTION_RESULT) {
        const result: DetectionResult = message.data;
        setState(s => {
          const prev = s.averageConfidence ?? result.confidence;
          return {
            ...s,
            latestResult: result,
            framesProcessed: result.frameNumber,
            averageConfidence: prev * 0.85 + result.confidence * 0.15,
          };
        });
      }
      if (message.type === MessageType.MODEL_READY) {
        setState(s => ({ ...s, modelLoaded: true, backend: message.data?.backend ?? 'webgl' }));
      }
      if (message.type === MessageType.VIDEO_DETECTED) {
        setState(s => ({ ...s, videoState: 'found' }));
      }
      if (message.type === MessageType.VIDEO_LOST) {
        setState(s => ({ ...s, videoState: 'not-found' }));
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // ── Check video in content script ────────────────────────────────────────
  const checkForVideo = useCallback((tabId: number) => {
    chrome.tabs.sendMessage(tabId, { type: 'CHECK_VIDEO' }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script not ready yet
        setState(s => ({ ...s, videoState: 'not-found' }));
        return;
      }
      setState(s => ({
        ...s,
        videoState: response?.videoDetected ? 'found' : 'not-found',
      }));
    });
  }, []);

  // ── Start protection ──────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (!state.activeTabId || state.videoState !== 'found') return;
    setState(s => ({ ...s, appState: 'starting' }));

    chrome.runtime.sendMessage(
      { type: MessageType.START_CAPTURE, data: { tabId: state.activeTabId } },
      (response) => {
        if (response?.success) {
          setState(s => ({
            ...s,
            appState: 'active',
            framesProcessed: 0,
            latestResult: null,
            averageConfidence: null,
          }));
        } else {
          setState(s => ({ ...s, appState: 'idle' }));
        }
      }
    );
  }, [state.activeTabId, state.videoState]);

  // ── Stop protection ───────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    setState(s => ({ ...s, appState: 'stopping' }));
    chrome.runtime.sendMessage({ type: MessageType.STOP_CAPTURE }, () => {
      setState(s => ({
        ...s,
        appState: 'idle',
        latestResult: null,
        averageConfidence: null,
        framesProcessed: 0,
      }));
    });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  const canStart = state.videoState === 'found' && state.isMeetTab && state.appState === 'idle';
  const isActive = state.appState === 'active';
  const color = state.latestResult ? getThreatColor(state.latestResult.threatLevel) : '#10b981';

  return (
    <div style={{
      width: 320,
      background: '#0f172a',
      color: '#f1f5f9',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px 12px',
        background: 'linear-gradient(135deg, #1e293b, #0f172a)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>🛡️</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: -0.3 }}>Deepfake Detector</div>
            <ModelBadge loaded={state.modelLoaded} backend={state.backend} />
          </div>
        </div>

        {isActive && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 5,
            fontSize: 11, color: '#10b981', fontWeight: 600,
          }}>
            <PulseDot color="#10b981" />
            LIVE
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Video status — always visible */}
        <VideoStatusBadge state={state.videoState} />

        {/* Not on Meet — CTA */}
        {!state.isMeetTab && (
          <div style={{
            textAlign: 'center',
            padding: '20px 12px',
            color: '#64748b',
            fontSize: 12,
            lineHeight: 1.6,
          }}>
            Navigate to <strong style={{ color: '#6366f1' }}>meet.google.com</strong> and join
            a call, then open this popup.
          </div>
        )}

        {/* On Meet, idle: show start button */}
        {state.isMeetTab && !isActive && (
          <>
            {/* Start button */}
            <button
              onClick={handleStart}
              disabled={!canStart || state.appState === 'starting'}
              style={{
                width: '100%',
                padding: '12px 0',
                borderRadius: 10,
                border: 'none',
                fontSize: 14,
                fontWeight: 700,
                cursor: canStart ? 'pointer' : 'not-allowed',
                transition: 'all 0.2s ease',
                background: canStart
                  ? 'linear-gradient(135deg, #10b981, #059669)'
                  : 'rgba(255,255,255,0.06)',
                color: canStart ? '#fff' : '#475569',
                boxShadow: canStart ? '0 4px 16px rgba(16,185,129,0.3)' : 'none',
              }}
            >
              {state.appState === 'starting' ? (
                '⏳ Starting...'
              ) : state.videoState === 'checking' ? (
                '⏳ Waiting for video...'
              ) : state.videoState === 'not-found' ? (
                '⚠ No video — join a call first'
              ) : state.videoState === 'not-meet' ? (
                '🔗 Open Google Meet'
              ) : (
                '▶ Start Protection'
              )}
            </button>

            {/* Helper hint */}
            {state.videoState === 'found' && (
              <p style={{ margin: 0, fontSize: 11, color: '#475569', textAlign: 'center' }}>
                Video detected ✓  — click Start to begin AI analysis
              </p>
            )}
            {state.videoState === 'not-found' && state.isMeetTab && (
              <p style={{ margin: 0, fontSize: 11, color: '#f59e0b', textAlign: 'center' }}>
                Join a call and enable your camera, then try again.
              </p>
            )}
          </>
        )}

        {/* Active — show live results */}
        {isActive && (
          <>
            {state.latestResult ? (
              <ThreatMeter result={state.latestResult} />
            ) : (
              <div style={{
                padding: '20px',
                textAlign: 'center',
                color: '#475569',
                fontSize: 12,
                border: '1px dashed rgba(255,255,255,0.08)',
                borderRadius: 10,
              }}>
                ⏳ Analyzing frames...
              </div>
            )}

            {/* Stats row */}
            <div style={{ display: 'flex', gap: 8 }}>
              <StatPill
                label="Frames"
                value={state.framesProcessed.toString()}
                color={color}
              />
              <StatPill
                label="Avg Score"
                value={state.averageConfidence !== null
                  ? `${getAuthenticityScore(state.averageConfidence)}%`
                  : '—'}
                color={color}
              />
              <StatPill
                label="Faces"
                value={state.latestResult?.faceCount?.toString() ?? '0'}
                color={color}
              />
            </div>

            {/* Stop button */}
            <button
              onClick={handleStop}
              disabled={state.appState === 'stopping'}
              style={{
                width: '100%',
                padding: '11px 0',
                borderRadius: 10,
                border: '1px solid rgba(239,68,68,0.4)',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                background: 'rgba(239,68,68,0.1)',
                color: '#ef4444',
                transition: 'all 0.2s ease',
              }}
            >
              {state.appState === 'stopping' ? '⏳ Stopping...' : '⏹ Stop Protection'}
            </button>
          </>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '8px 16px 12px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderTop: '1px solid rgba(255,255,255,0.05)',
      }}>
        <span style={{ fontSize: 10, color: '#334155' }}>
          Deepfake Detector v0.2.0
        </span>
        <button
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') })}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#475569',
            fontSize: 11,
            cursor: 'pointer',
            padding: '2px 6px',
            borderRadius: 4,
          }}
        >
          ⚙ Settings
        </button>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.5; transform: scale(1.3); }
        }
        button:hover:not(:disabled) { filter: brightness(1.1); }
      `}</style>
    </div>
  );
}

const container = document.getElementById('root')!;
createRoot(container).render(<Popup />);