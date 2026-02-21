"""
backend/app/ppg.py — Photoplethysmography (PPG) Heart-Rate Analysis
====================================================================
Real human faces exhibit subtle colour changes in skin as blood pulses
through capillaries. Deepfake-generated faces often lack this signal or
produce an irregular/absent pulse.

Method: rPPG (remote PPG) using the CHROM algorithm on the forehead ROI.
Reference: de Haan & Jeanne, "Robust pulse rate from chrominance-based rPPG"
           IEEE TBME, 2013.
"""

from __future__ import annotations

import logging
from collections import deque
from typing import Optional

import numpy as np

logger = logging.getLogger("backend.ppg")


class PPGSession:
    """
    Per-session buffer of colour samples for rPPG computation.
    """
    MAX_LEN = 300   # ~10 seconds at 30 fps

    def __init__(self):
        self.r: deque[float] = deque(maxlen=self.MAX_LEN)
        self.g: deque[float] = deque(maxlen=self.MAX_LEN)
        self.b: deque[float] = deque(maxlen=self.MAX_LEN)

    def append(self, r: float, g: float, b: float):
        self.r.append(r)
        self.g.append(g)
        self.b.append(b)

    def as_array(self):
        return (
            np.array(self.r, dtype=np.float64),
            np.array(self.g, dtype=np.float64),
            np.array(self.b, dtype=np.float64),
        )

    def __len__(self):
        return len(self.r)


class PPGAnalyzer:
    """
    Extracts the mean forehead RGB from each frame, accumulates a time-series,
    then checks whether a plausible cardiac rhythm (40–200 BPM) exists.

    Returns a score in [0, 1]:
      0 = strong physiological signal (real)
      1 = absent or anomalous signal (suspicious deepfake)
    """

    FPS              = 30           # assumed capture rate
    MIN_FRAMES       = 60           # need ≥ 2 s of signal
    FOREHEAD_FRAC_Y  = 0.15         # top 15% of face bbox = forehead
    FOREHEAD_FRAC_X  = (0.25, 0.75) # middle 50% horizontally

    def __init__(self):
        self._sessions: dict[str, PPGSession] = {}

    def _get_session(self, sid: str) -> PPGSession:
        if sid not in self._sessions:
            self._sessions[sid] = PPGSession()
        return self._sessions[sid]

    def analyze(
        self,
        img_bgr:    np.ndarray,
        face_bbox:  Optional[dict],
        session_id: str = "default",
    ) -> float:
        """
        Update the session buffer with this frame and return the current PPG score.

        Args:
            img_bgr:   Full BGR frame from OpenCV
            face_bbox: {"x", "y", "w", "h"} or None
            session_id: Per-stream identifier for multi-participant support
        Returns:
            float in [0, 1]  (0 = real, 1 = anomalous)
        """
        session = self._get_session(session_id)

        rgb = self._extract_forehead_rgb(img_bgr, face_bbox)
        if rgb is None:
            return 0.5  # unknown, be neutral

        session.append(*rgb)

        if len(session) < self.MIN_FRAMES:
            return 0.0  # not enough data yet

        return self._compute_score(session)

    # ── Private ──────────────────────────────────────────────────────────────

    def _extract_forehead_rgb(
        self,
        img_bgr: np.ndarray,
        face_bbox: Optional[dict],
    ) -> Optional[tuple[float, float, float]]:
        """Return mean (R, G, B) of the forehead ROI, or None on failure."""
        try:
            h_img, w_img = img_bgr.shape[:2]

            if face_bbox:
                fx  = int(face_bbox.get("x", 0))
                fy  = int(face_bbox.get("y", 0))
                fw  = int(face_bbox.get("w", w_img))
                fh  = int(face_bbox.get("h", h_img))
            else:
                fx, fy, fw, fh = 0, 0, w_img, h_img

            # Forehead sub-region
            roi_y1 = fy
            roi_y2 = fy + max(1, int(fh * self.FOREHEAD_FRAC_Y))
            roi_x1 = fx + int(fw * self.FOREHEAD_FRAC_X[0])
            roi_x2 = fx + int(fw * self.FOREHEAD_FRAC_X[1])

            roi_y1 = max(0, roi_y1); roi_y2 = min(h_img, roi_y2)
            roi_x1 = max(0, roi_x1); roi_x2 = min(w_img, roi_x2)

            if roi_y2 <= roi_y1 or roi_x2 <= roi_x1:
                return None

            roi = img_bgr[roi_y1:roi_y2, roi_x1:roi_x2].astype(np.float64)
            b, g, r = roi[:, :, 0].mean(), roi[:, :, 1].mean(), roi[:, :, 2].mean()
            return float(r), float(g), float(b)

        except Exception as e:
            logger.debug("Forehead extraction failed: %s", e)
            return None

    def _compute_score(self, session: PPGSession) -> float:
        """
        Apply CHROM rPPG, band-pass to cardiac frequencies, check for signal.
        Returns 0 (real) to 1 (anomalous).
        """
        r, g, b = session.as_array()

        # Normalise channels
        r_n = r / (r.mean() + 1e-6)
        g_n = g / (g.mean() + 1e-6)
        b_n = b / (b.mean() + 1e-6)

        # CHROM: X = 3R - 2G,  Y = 1.5R + G - 1.5B
        X = 3 * r_n - 2 * g_n
        Y = 1.5 * r_n + g_n - 1.5 * b_n

        alpha = X.std() / (Y.std() + 1e-9)
        ppg   = X - alpha * Y

        # Band-pass: keep 40–200 BPM = 0.67–3.33 Hz at ~30fps
        fft   = np.fft.rfft(ppg)
        freqs = np.fft.rfftfreq(len(ppg), d=1.0 / self.FPS)

        lo, hi = 0.67, 3.33
        mask   = (freqs >= lo) & (freqs <= hi)

        power_in  = np.abs(fft[mask]).sum()
        power_all = np.abs(fft).sum() + 1e-9
        snr       = power_in / power_all   # 0–1 (higher = stronger HR signal)

        # Invert: high SNR → low anomaly score
        anomaly = float(np.clip(1.0 - snr * 3, 0.0, 1.0))

        logger.debug("PPG SNR=%.3f → anomaly=%.3f", snr, anomaly)
        return anomaly