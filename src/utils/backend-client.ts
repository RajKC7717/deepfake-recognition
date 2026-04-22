/**
 * src/utils/backend-client.ts
 * ============================
 * Handles all POST communication with the FastAPI backend (/analyze).
 *
 * Design principles:
 *   - Non-blocking: every call has a hard 800ms timeout
 *   - Silent fallback: if backend is down, returns null (offscreen uses TFjs only)
 *   - Session-aware: sends a stable session_id so backend PPG + temporal
 *     accumulators work correctly across frames
 *   - Health-checked: offscreen calls checkHealth() once at capture start
 */

export interface BackendResult {
  deepfakeConfidence: number;   // 0 = real, 1 = fake  (visual model only)
  ppgScore:           number;   // 0 = normal HR, 1 = anomalous
  temporalScore:      number;   // 0 = consistent, 1 = inconsistent
  combinedScore:      number;   // weighted fusion — THIS is the score we use
  classification:     'real' | 'suspicious' | 'fake';
  threatLevel:        'safe'  | 'warning'   | 'danger';
  inferenceTimeMs:    number;
}

export class BackendClient {
  private readonly baseUrl:   string;
  private readonly sessionId: string;
  private readonly timeoutMs  = 800;

  /** Set to false when a hard network failure occurs — stops retrying. */
  isAvailable = false;

  constructor(baseUrl: string) {
    this.baseUrl   = baseUrl.replace(/\/$/, '');
    this.sessionId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * GET /health — lightweight check at capture start.
   * Sets this.isAvailable.
   */
  async checkHealth(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 1500);
      const res  = await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      clearTimeout(tid);
      this.isAvailable = res.ok;
      console.log(`[BackendClient] health → ${this.isAvailable ? '✅ online' : '❌ offline'}`);
      return this.isAvailable;
    } catch {
      this.isAvailable = false;
      console.log('[BackendClient] health → ❌ offline (connection refused)');
      return false;
    }
  }

  /**
   * POST the face crop canvas to /analyze.
   * Returns null on any failure — callers fall back to TFjs score.
   */
  async analyze(
    faceCanvas:  HTMLCanvasElement,
    frameNumber: number,
  ): Promise<BackendResult | null> {
    if (!this.isAvailable) return null;

    // Encode face crop as JPEG — ~15-25 KB per frame
    let b64: string;
    try {
      b64 = faceCanvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      if (!b64) return null;
    } catch { return null; }

    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/analyze`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frame_b64:    b64,
          frame_number: frameNumber,
          timestamp_ms: Date.now(),
          session_id:   this.sessionId,
        }),
        signal: ctrl.signal,
      });

      // 422 = no face found server-side — normal, not an error
      if (res.status === 422) return null;
      if (!res.ok) {
        console.warn(`[BackendClient] /analyze ${res.status}`);
        return null;
      }

      const d = await res.json();
      return {
        deepfakeConfidence: d.deepfake_confidence ?? 0.5,
        ppgScore:           d.ppg_score           ?? 0,
        temporalScore:      d.temporal_score      ?? 0,
        combinedScore:      d.combined_score      ?? 0.5,
        classification:     d.classification      ?? 'real',
        threatLevel:        d.threat_level        ?? 'safe',
        inferenceTimeMs:    d.inference_time_ms   ?? 0,
      };
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        // Hard failure — stop trying until next session
        this.isAvailable = false;
        console.warn('[BackendClient] Unreachable — client-side only from now on');
      }
      return null;
    } finally {
      clearTimeout(tid);
    }
  }
}