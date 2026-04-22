"""
backend/app/temporal.py — Temporal Consistency Checker
=======================================================
Deepfake models often produce per-frame scores that jump wildly on real video
but stay consistently high on deepfakes. This module tracks a sliding window
of per-frame deepfake confidence scores per session and returns an anomaly
score based on:

  1. Mean score in window — high mean → likely deepfake
  2. Low variance       — suspiciously flat scores signal a synthetic face
  3. Monotone runs      — real faces fluctuate; fakes tend to be steady

Score returned: float in [0, 1]
  0 = temporally consistent with a real face
  1 = temporally consistent with a deepfake / anomalous pattern
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Deque

import numpy as np

logger = logging.getLogger("backend.temporal")


@dataclass
class _SessionBuffer:
    scores:        Deque[float] = field(default_factory=lambda: deque(maxlen=300))
    frame_numbers: Deque[int]   = field(default_factory=lambda: deque(maxlen=300))
    last_frame:    int          = -1


class TemporalConsistencyChecker:
    """
    Tracks per-session sliding windows of frame-level deepfake scores.

    Args:
        window: number of recent frames to keep for analysis
    """

    def __init__(self, window: int = 30):
        self.window   = window
        self._sessions: dict[str, _SessionBuffer] = {}

    # ── Public API ─────────────────────────────────────────────────────────

    def update(
        self,
        session_id:   str,
        score:        float,
        frame_number: int = -1,
    ) -> float:
        """
        Add a new score and return the current temporal anomaly score.

        Args:
            session_id:   Per-stream identifier (same as PPG session_id)
            score:        Per-frame deepfake confidence from the visual model (0–1)
            frame_number: Frame index (used for ordering, not strictly required)

        Returns:
            float in [0, 1] — temporal anomaly score
        """
        buf = self._get_buf(session_id)
        buf.scores.append(float(score))
        buf.frame_numbers.append(frame_number)
        buf.last_frame = frame_number

        if len(buf.scores) < 5:
            # Not enough data — return the raw score as a neutral estimate
            return float(score)

        return self._compute(buf)

    def reset(self, session_id: str) -> None:
        """Clear the buffer for a session (call on stream restart)."""
        if session_id in self._sessions:
            del self._sessions[session_id]

    # ── Internal ──────────────────────────────────────────────────────────

    def _get_buf(self, sid: str) -> _SessionBuffer:
        if sid not in self._sessions:
            self._sessions[sid] = _SessionBuffer(
                scores=deque(maxlen=self.window),
                frame_numbers=deque(maxlen=self.window),
            )
        return self._sessions[sid]

    def _compute(self, buf: _SessionBuffer) -> float:
        arr = np.array(buf.scores, dtype=np.float64)

        # ── Component 1: smoothed mean ────────────────────────────────────
        # Exponential-weighted mean emphasises recent frames
        weights   = np.exp(np.linspace(-1.0, 0.0, len(arr)))
        weights  /= weights.sum()
        ema_score = float(np.dot(weights, arr))

        # ── Component 2: variance anomaly ────────────────────────────────
        # Real faces → moderate variance as lighting/pose shifts.
        # Very LOW variance on a consistently high-scoring stream = deepfake.
        # Very HIGH variance = model is uncertain = lean toward real.
        std = arr.std()
        # Ideal real-face std ≈ 0.05–0.15 (some fluctuation expected)
        # Penalise flatness only when mean score is already high
        flatness_penalty = 0.0
        if ema_score > 0.40 and std < 0.04:
            flatness_penalty = (0.04 - std) / 0.04 * 0.25   # max +0.25

        # ── Component 3: trend ───────────────────────────────────────────
        # Rising trend in scores over the window = increasingly fake
        if len(arr) >= 8:
            x     = np.arange(len(arr), dtype=np.float64)
            slope = float(np.polyfit(x, arr, 1)[0])
            # Positive slope (getting more fake) adds up to +0.10
            trend_penalty = float(np.clip(slope * 5, -0.05, 0.10))
        else:
            trend_penalty = 0.0

        raw = ema_score + flatness_penalty + trend_penalty
        result = float(np.clip(raw, 0.0, 1.0))

        logger.debug(
            "Temporal | ema=%.3f std=%.3f flat_pen=%.3f trend_pen=%.3f → %.3f",
            ema_score, std, flatness_penalty, trend_penalty, result,
        )
        return result