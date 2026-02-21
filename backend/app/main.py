"""
backend/app/main.py — Deepfake Detector Heavy Validator API
===========================================================
FastAPI server that receives video frames from the extension (for DRM-protected
or high-stakes scenarios) and runs heavier server-side analysis.

Endpoints:
  POST /analyze           — analyze a single base64 frame
  POST /analyze/batch     — analyze multiple frames (temporal consistency)
  GET  /health            — service health check

Run:
  uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
"""

from __future__ import annotations

import base64
import io
import time
import logging
from typing import List, Optional

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .models import get_deepfake_model, DeepfakeModel
from .ppg import PPGAnalyzer
from .temporal import TemporalConsistencyChecker
from .preprocessing import preprocess_frame

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("backend")

# ─── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(
    title       = "Deepfake Detector Backend",
    description = "Server-side heavy analysis for deepfake detection",
    version     = "1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins  = ["chrome-extension://*", "http://localhost:*"],
    allow_methods  = ["POST", "GET"],
    allow_headers  = ["*"],
)

# ─── Singletons (loaded once at startup) ──────────────────────────────────────
_deepfake_model:    Optional[DeepfakeModel]             = None
_ppg_analyzer:      Optional[PPGAnalyzer]               = None
_temporal_checker:  Optional[TemporalConsistencyChecker] = None


@app.on_event("startup")
async def startup():
    global _deepfake_model, _ppg_analyzer, _temporal_checker
    logger.info("Loading models...")
    _deepfake_model   = get_deepfake_model()
    _ppg_analyzer     = PPGAnalyzer()
    _temporal_checker = TemporalConsistencyChecker(window=30)
    logger.info("✅ All models ready")


# ─── Request / Response schemas ───────────────────────────────────────────────

class FrameRequest(BaseModel):
    frame_b64:    str  = Field(..., description="Base64-encoded JPEG/PNG frame")
    frame_number: int  = Field(0)
    timestamp_ms: int  = Field(0)
    session_id:   str  = Field("default")


class BatchFrameRequest(BaseModel):
    frames:     List[FrameRequest]
    session_id: str = "default"


class AnalysisResult(BaseModel):
    frame_number:          int
    deepfake_confidence:   float          # 0 = real, 1 = fake
    ppg_score:             float          # 0 = normal HR, 1 = anomalous
    temporal_score:        float          # 0 = consistent, 1 = inconsistent
    combined_score:        float          # weighted fusion
    classification:        str            # "real" | "suspicious" | "fake"
    threat_level:          str            # "safe" | "warning" | "danger"
    inference_time_ms:     float
    detail:                dict


class BatchAnalysisResult(BaseModel):
    results:           List[AnalysisResult]
    session_id:        str
    avg_combined_score: float
    overall_verdict:   str


class HealthResponse(BaseModel):
    status:    str
    model:     str
    uptime_s:  float


_start_time = time.time()

# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        status   = "ok",
        model    = _deepfake_model.name if _deepfake_model else "loading",
        uptime_s = round(time.time() - _start_time, 1),
    )


@app.post("/analyze", response_model=AnalysisResult)
async def analyze_frame(req: FrameRequest):
    """
    Analyze a single frame for deepfake artifacts.
    Combines: visual model + PPG anomaly + temporal consistency.
    """
    t0 = time.perf_counter()

    img = _decode_frame(req.frame_b64)
    face, face_bbox = preprocess_frame(img)

    if face is None:
        raise HTTPException(status_code=422, detail="No face detected in frame")

    # ── 1. Visual deepfake model ──────────────────────────────────────────────
    deep_conf = _deepfake_model.predict(face)           # float 0–1

    # ── 2. PPG heart-rate analysis ────────────────────────────────────────────
    ppg_score = _ppg_analyzer.analyze(img, face_bbox, req.session_id)

    # ── 3. Temporal consistency ───────────────────────────────────────────────
    temp_score = _temporal_checker.update(req.session_id, deep_conf, req.frame_number)

    # ── 4. Weighted fusion ────────────────────────────────────────────────────
    combined = 0.60 * deep_conf + 0.20 * ppg_score + 0.20 * temp_score

    cls, threat = _classify(combined)
    elapsed_ms  = (time.perf_counter() - t0) * 1000

    return AnalysisResult(
        frame_number        = req.frame_number,
        deepfake_confidence = round(deep_conf, 4),
        ppg_score           = round(ppg_score,  4),
        temporal_score      = round(temp_score, 4),
        combined_score      = round(combined,   4),
        classification      = cls,
        threat_level        = threat,
        inference_time_ms   = round(elapsed_ms, 1),
        detail              = {
            "face_bbox":   face_bbox,
            "model_name":  _deepfake_model.name,
        },
    )


@app.post("/analyze/batch", response_model=BatchAnalysisResult)
async def analyze_batch(req: BatchFrameRequest):
    """Analyze a sequence of frames with temporal context."""
    results = []
    for frame_req in req.frames:
        frame_req.session_id = req.session_id
        try:
            r = await analyze_frame(frame_req)
            results.append(r)
        except HTTPException:
            pass   # skip frames with no face

    if not results:
        raise HTTPException(status_code=422, detail="No faces detected in any frame")

    avg = sum(r.combined_score for r in results) / len(results)
    _, verdict_threat = _classify(avg)

    return BatchAnalysisResult(
        results             = results,
        session_id          = req.session_id,
        avg_combined_score  = round(avg, 4),
        overall_verdict     = verdict_threat,
    )


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _decode_frame(b64: str) -> np.ndarray:
    """Decode a base64 image string to a BGR numpy array."""
    # Strip data URI prefix if present
    if "," in b64:
        b64 = b64.split(",")[1]
    try:
        raw   = base64.b64decode(b64)
        arr   = np.frombuffer(raw, np.uint8)
        img   = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("cv2 returned None")
        return img
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image data: {e}")


def _classify(score: float) -> tuple[str, str]:
    if score < 0.30:
        return "real",       "safe"
    if score < 0.70:
        return "suspicious", "warning"
    return "fake",           "danger"