"""
backend/app/preprocessing.py — Face Detection & Preprocessing
=============================================================
Detects the largest face in a BGR frame using OpenCV's Haar cascade
(no external model download needed), crops it, converts to RGB numpy
array ready for the deepfake model.

Returns:
  face_rgb  : np.ndarray (H, W, 3) uint8 — or None if no face found
  face_bbox : dict {"x", "y", "w", "h"}  — or None
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

logger = logging.getLogger("backend.preprocessing")

# ── Haar cascade bundled with OpenCV ─────────────────────────────────────────
_CASCADE_PATH = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
_face_cascade: Optional[cv2.CascadeClassifier] = None


def _get_cascade() -> cv2.CascadeClassifier:
    global _face_cascade
    if _face_cascade is None:
        _face_cascade = cv2.CascadeClassifier(_CASCADE_PATH)
        if _face_cascade.empty():
            raise RuntimeError(f"Failed to load Haar cascade from {_CASCADE_PATH}")
        logger.info("✅ Haar cascade loaded")
    return _face_cascade


def preprocess_frame(
    img_bgr: np.ndarray,
    target_size: int = 224,
    padding_frac: float = 0.20,
) -> tuple[Optional[np.ndarray], Optional[dict]]:
    """
    Detect the largest face in img_bgr, add padding, resize to target_size.

    Args:
        img_bgr:      Full BGR frame from OpenCV / cv2.imdecode
        target_size:  Output square size (pixels) — must match model input
        padding_frac: Fractional padding around the detected bbox

    Returns:
        (face_rgb, bbox_dict)  — face_rgb is None when no face detected
    """
    cascade = _get_cascade()

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)

    faces = cascade.detectMultiScale(
        gray,
        scaleFactor  = 1.1,
        minNeighbors = 4,
        minSize      = (60, 60),
        flags        = cv2.CASCADE_SCALE_IMAGE,
    )

    if len(faces) == 0:
        # Retry with looser params (helps with compressed / low-res frames)
        faces = cascade.detectMultiScale(
            gray,
            scaleFactor  = 1.2,
            minNeighbors = 2,
            minSize      = (40, 40),
        )

    if len(faces) == 0:
        logger.debug("No face detected in frame")
        return None, None

    # Pick largest face
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])

    bbox = {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}

    # Add padding
    pad_x = int(w * padding_frac)
    pad_y = int(h * padding_frac)

    H, W = img_bgr.shape[:2]
    x1 = max(0, x - pad_x)
    y1 = max(0, y - pad_y)
    x2 = min(W, x + w + pad_x)
    y2 = min(H, y + h + pad_y)

    face_bgr = img_bgr[y1:y2, x1:x2]
    if face_bgr.size == 0:
        return None, None

    face_rgb = cv2.cvtColor(face_bgr, cv2.COLOR_BGR2RGB)
    face_rgb = cv2.resize(face_rgb, (target_size, target_size),
                          interpolation=cv2.INTER_LINEAR)

    return face_rgb, bbox