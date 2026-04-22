/**
 * src/utils/temporal-smoother.ts
 * ================================
 * Single-session sliding window smoother for deepfake confidence scores.
 *
 * Problems solved vs raw per-frame scores:
 *   • Lighting glitch → 0.85 spike → back to 0.1  (no alert without smoother)
 *   • Genuine deepfake builds up gradually over 10–20 frames
 *   • Asymmetric hysteresis: fast to escalate, SLOW to de-escalate
 *     (a real deepfake call shouldn't clear on one good frame)
 *
 * Chunk 4 addition:
 *   • peek() — read current state WITHOUT advancing the buffer or state machine.
 *     Used by the no-face branch: holds the last known threat level during brief
 *     occlusions without injecting a fake "clean" sample into the EWMA.
 *
 * Usage:
 *   const smoother = new TemporalSmoother();
 *
 *   // Normal frame with a face:
 *   const result = smoother.update(rawMergedConfidence);
 *
 *   // No-face frame (hold phase):
 *   const result = smoother.peek();
 *
 *   // No-face frame (decay phase — feed a small neutral value):
 *   const result = smoother.update(NO_FACE_DECAY_INPUT);
 *
 *   // On session end:
 *   smoother.reset();
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SmoothedResult {
  /** EWMA-smoothed confidence 0–1 */
  smoothed:       number;
  /** Signal consistency 0–1  (1 = rock-steady, 0 = chaotic) */
  stability:      number;
  /** Directional trend over last 10 frames */
  trend:          'rising' | 'falling' | 'stable';
  /** Derived from hysteresis level — use this for UI, NOT raw classify() */
  classification: 'real' | 'suspicious' | 'fake';
  threatLevel:    'safe' | 'warning' | 'danger';
}

// ─── Hysteresis configuration ─────────────────────────────────────────────────

/**
 * Escalation: consecutive frames above the entry threshold before level rises.
 * Kept small so real deepfakes are caught quickly.
 */
const ESCALATION: Record<string, number> = {
  toWarning: 3,   // 3 frames smoothed > 0.30  → enter WARNING
  toDanger:  5,   // 5 frames smoothed > 0.65  → enter DANGER
};

/**
 * De-escalation: consecutive frames below the exit threshold before level drops.
 * Kept large so one clean frame doesn't clear a DANGER.
 */
const DE_ESCALATION: Record<string, number> = {
  fromDanger:  14,  // 14 frames smoothed < 0.45 → drop to WARNING
  fromWarning:  8,  // 8  frames smoothed < 0.22 → drop to SAFE
};

/**
 * Gap between entry and exit thresholds prevents rapid oscillation.
 *   Enter WARNING at 0.30 → leave only below 0.22
 *   Enter DANGER  at 0.65 → leave only below 0.45
 */
const THRESH = {
  enterWarning: 0.30,
  enterDanger:  0.65,
  exitDanger:   0.45,
  exitWarning:  0.22,
} as const;

// ─── TemporalSmoother ─────────────────────────────────────────────────────────

export class TemporalSmoother {
  private readonly bufferSize: number;
  private buffer: Float32Array;
  /** Points to the NEXT write slot */
  private writeIdx: number = 0;
  /** How many real samples are in the buffer (caps at bufferSize) */
  private count: number = 0;

  /** Exponential weighted moving average */
  private ewma: number = 0;
  /** EMA decay factor (higher = faster response to new samples) */
  private readonly alpha: number;

  /** Current hysteresis level */
  private level: 'safe' | 'warning' | 'danger' = 'safe';

  // ── Consecutive-frame counters for hysteresis state machine ──────────────
  private framesAboveWarning:     number = 0;
  private framesAboveDanger:      number = 0;
  private framesBelowExitDanger:  number = 0;
  private framesBelowExitWarning: number = 0;

  /**
   * @param bufferSize  Circular buffer length (default 30 ≈ 6 seconds at 5 fps)
   * @param alpha       EMA smoothing factor 0–1 (default 0.25)
   */
  constructor(bufferSize = 30, alpha = 0.25) {
    this.bufferSize = bufferSize;
    this.buffer     = new Float32Array(bufferSize);
    this.alpha      = alpha;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Feed one raw confidence value — advances buffer and state machine. */
  update(raw: number): SmoothedResult {
    // Write into circular buffer
    this.buffer[this.writeIdx] = raw;
    this.writeIdx = (this.writeIdx + 1) % this.bufferSize;
    if (this.count < this.bufferSize) this.count++;

    // EWMA — seed on first sample to avoid cold-start bias
    this.ewma = this.count === 1
      ? raw
      : this.alpha * raw + (1 - this.alpha) * this.ewma;

    this._advanceLevel(this.ewma);

    return this._buildResult();
  }

  /**
   * Read the current smoothed state WITHOUT writing to the buffer
   * or advancing the state machine.
   *
   * Use this during no-face hold frames so the EWMA and hysteresis counters
   * are not polluted by injected zeros.
   *
   * Chunk 4 addition.
   */
  peek(): SmoothedResult {
    return this._buildResult();
  }

  /** Call this on endCapture so the next session starts clean. */
  reset(): void {
    this.buffer.fill(0);
    this.writeIdx = 0;
    this.count    = 0;
    this.ewma     = 0;
    this.level    = 'safe';
    this.framesAboveWarning     = 0;
    this.framesAboveDanger      = 0;
    this.framesBelowExitDanger  = 0;
    this.framesBelowExitWarning = 0;
  }

  /** Read the current hysteresis level without side-effects. */
  get currentLevel(): 'safe' | 'warning' | 'danger' {
    return this.level;
  }

  /** Read the current EWMA value without side-effects. */
  get currentSmoothed(): number {
    return this.ewma;
  }

  // ── State machine ─────────────────────────────────────────────────────────

  private _advanceLevel(s: number): void {
    switch (this.level) {

      case 'safe': {
        if (s >= THRESH.enterWarning) {
          this.framesAboveWarning++;
        } else {
          this.framesAboveWarning = 0;
        }
        if (this.framesAboveWarning >= ESCALATION.toWarning) {
          this.level = 'warning';
          this.framesAboveWarning     = 0;
          this.framesBelowExitWarning = 0;
        }
        break;
      }

      case 'warning': {
        // Escalation check (higher priority)
        if (s >= THRESH.enterDanger) {
          this.framesAboveDanger++;
          this.framesBelowExitWarning = 0;
        } else {
          this.framesAboveDanger = 0;
        }
        if (this.framesAboveDanger >= ESCALATION.toDanger) {
          this.level = 'danger';
          this.framesAboveDanger     = 0;
          this.framesBelowExitDanger = 0;
          break;
        }
        // De-escalation check
        if (s < THRESH.exitWarning) {
          this.framesBelowExitWarning++;
        } else {
          this.framesBelowExitWarning = 0;
        }
        if (this.framesBelowExitWarning >= DE_ESCALATION.fromWarning) {
          this.level = 'safe';
          this.framesBelowExitWarning = 0;
          this.framesAboveWarning     = 0;
        }
        break;
      }

      case 'danger': {
        // Can only drop to WARNING, not straight to SAFE
        if (s < THRESH.exitDanger) {
          this.framesBelowExitDanger++;
        } else {
          this.framesBelowExitDanger = 0;
        }
        if (this.framesBelowExitDanger >= DE_ESCALATION.fromDanger) {
          this.level = 'warning';
          this.framesBelowExitDanger  = 0;
          this.framesBelowExitWarning = 0;
          this.framesAboveDanger      = 0;
        }
        break;
      }
    }
  }

  // ── Derived metrics ───────────────────────────────────────────────────────

  private _buildResult(): SmoothedResult {
    return {
      smoothed:  this.ewma,
      stability: this._stability(),
      trend:     this._trend(),
      ...levelToVerdict(this.level),
    };
  }

  /**
   * 1 − normalised σ.  Max possible σ for a [0,1] signal is 0.5.
   */
  private _stability(): number {
    const n = this.count;
    if (n < 2) return 1.0;

    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.buffer[i];
    const mean = sum / n;

    let variance = 0;
    for (let i = 0; i < n; i++) {
      const d = this.buffer[i] - mean;
      variance += d * d;
    }
    variance /= n;

    return Math.max(0, Math.min(1, 1 - Math.sqrt(variance) / 0.5));
  }

  /**
   * Compare mean of last 5 samples vs the 5 before that.
   * Returns 'stable' until at least 10 samples are available.
   */
  private _trend(): 'rising' | 'falling' | 'stable' {
    if (this.count < 10) return 'stable';

    const recent: number[] = [];
    const older:  number[] = [];

    for (let i = 0; i < 10; i++) {
      const idx = (this.writeIdx - 1 - i + this.bufferSize) % this.bufferSize;
      if (i < 5) recent.push(this.buffer[idx]);
      else        older.push(this.buffer[idx]);
    }

    const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
    const avgOlder  = older.reduce((a, b) => a + b, 0)  / older.length;
    const delta     = avgRecent - avgOlder;

    if (delta > 0.05)  return 'rising';
    if (delta < -0.05) return 'falling';
    return 'stable';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function levelToVerdict(level: 'safe' | 'warning' | 'danger'): {
  classification: 'real' | 'suspicious' | 'fake';
  threatLevel:    'safe' | 'warning' | 'danger';
} {
  switch (level) {
    case 'safe':    return { classification: 'real',       threatLevel: 'safe'    };
    case 'warning': return { classification: 'suspicious', threatLevel: 'warning' };
    case 'danger':  return { classification: 'fake',       threatLevel: 'danger'  };
  }
}