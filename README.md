# 🕵️ Deepfake Detector — Real-Time Deepfake Detection for Google Meet

> **A Chrome Extension + FastAPI backend that detects AI-generated deepfake faces in real-time during Google Meet video calls. All primary processing happens on-device, ensuring your video never leaves your browser.**

[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](https://github.com/RajKC7717/deepfake-recognition)
[![License](https://img.shields.io/badge/license-ISC-green.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.10%2B-yellow.svg)](https://python.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://typescriptlang.org)

---

## 📖 Table of Contents

- [Overview](#-overview)
- [How It Works](#-how-it-works)
- [Architecture](#-architecture)
- [Detection Pipeline](#-detection-pipeline)
- [Project Structure](#-project-structure)
- [Tech Stack](#-tech-stack)
- [Installation & Setup](#-installation--setup)
- [Training the Model](#-training-the-model)
- [API Reference](#-api-reference)
- [Scoring & Classification](#-scoring--classification)
- [Privacy](#-privacy)

---

## 🔍 Overview

With the rise of sophisticated AI tools capable of generating hyper-realistic fake video faces (deepfakes), trusted video conferencing is increasingly at risk. **Deepfake Detector** is a Chrome browser extension that runs directly within Google Meet, silently analyzing participant video streams in real-time to flag potentially AI-generated faces.

### Key Features

- 🧠 **On-device AI** — Uses TensorFlow.js (WebGPU/WebGL) so your video stream never leaves the browser
- 🖥️ **Backend validation** — An optional FastAPI server performs heavier analysis for high-stakes scenarios
- 💓 **Biometric liveness check** — Detects the absence of physiological heartbeat signals (rPPG) that deepfakes lack
- 🎥 **Temporal consistency** — Tracks deepfake confidence over time to filter false positives
- 📊 **Real-time popup UI** — React-based popup shows live confidence scores integrated into Google Meet
- 🔔 **Threat alerts** — Browser notifications for high-confidence deepfake detections

---

## 🔧 How It Works

When you join a Google Meet call, the extension activates and begins the detection pipeline. Here is the end-to-end flow:

```
Google Meet Video Stream
        │
        ▼
[Content Script] ──── detects <video> elements on the page
        │
        ▼
[Offscreen Document / Background Service Worker]
  ├── Captures video frames (tabCapture API)
  ├── Face detection (MediaPipe BlazeFace)
  └── Crops face region → 224×224 px
        │
        ▼
[TensorFlow.js — In-Browser Inference]
  └── MesoInception4 CNN → fake probability score
        │
        ▼
[Optional: FastAPI Backend]
  ├── Visual CNN (PyTorch MesoInception4)
  ├── rPPG Heart-Rate Analysis (CHROM algorithm)
  └── Temporal Consistency Checker (sliding window)
        │
        ▼
[Weighted Score Fusion]
  60% Visual CNN + 20% PPG Anomaly + 20% Temporal
        │
        ▼
[Classification]
  ├── Score < 0.30 → ✅ REAL   (safe)
  ├── Score 0.30–0.70 → ⚠️ SUSPICIOUS (warning)
  └── Score > 0.70 → 🚨 FAKE  (danger)
        │
        ▼
[Popup UI + Browser Notification]
```

---

## 🏗️ Architecture

The project is divided into two independently functional tiers:

### Tier 1 — Chrome Extension (Client-Side)

Runs entirely in the browser. No data leaves the device.

| Component | Technology | Role |
|---|---|---|
| `background.js` | TypeScript Service Worker | Orchestrates tab capture and messaging |
| `content-script.js` | TypeScript | Injected into Meet pages, discovers live `<video>` elements |
| `offscreen.html` | TypeScript | Runs TensorFlow.js inference on captured frames |
| `popup.html` | React + TypeScript | Extension popup showing live detection results |
| `settings.html` | HTML | User configuration (threshold, backend URL, etc.) |

### Tier 2 — FastAPI Backend (Server-Side, Optional)

A Python server for heavier analysis, designed for DRM-protected or high-stakes scenarios.

| Component | File | Role |
|---|---|---|
| REST API | `backend/app/main.py` | Exposes `/analyze` and `/analyze/batch` endpoints |
| CNN Model | `backend/app/models.py` | PyTorch `MesoInception4` loaded from trained weights |
| PPG Analysis | `backend/app/ppg.py` | Remote photoplethysmography (rPPG) heart-rate detection |
| Temporal Logic | `backend/app/temporal.py` | Sliding-window consistency across frames |
| Preprocessing | `backend/app/preprocessing.py` | Face cropping and normalization pipeline |

---

## 🧬 Detection Pipeline

### 1. Face Detection

Uses **MediaPipe BlazeFace** (bundled in the extension) combined with a custom `VideoDetector` class that:
- Queries all `<video>` elements in Google Meet's DOM
- Validates WebRTC video streams (different from regular `<video>` — uses `srcObject`, not `src`)
- Handles async Meet video loading with exponential backoff retries
- Uses `MutationObserver` + periodic polling to track participant streams

### 2. Visual CNN — MesoInception4

The heart of the detection system is **MesoInception4**, a lightweight CNN specifically designed for deepfake detection (paper: [arXiv:1809.00888](https://arxiv.org/abs/1809.00888)).

#### Architecture

```
Input: 224×224 RGB image
    │
    ├─ Inception Block 1 (multi-scale convolutions: 1×1, 3×3, dilated 3×3 dilation=2, dilated 3×3 dilation=3)
    │  └─ BatchNorm → MaxPool(2×2) → 11 channels
    │
    ├─ Inception Block 2 (same multi-scale pattern on 11-ch input)
    │  └─ BatchNorm → MaxPool(2×2) → 12 channels
    │
    ├─ Conv Block 3: Conv(5×5, 16ch) → BN → MaxPool(2×2)
    │
    ├─ Conv Block 4: Conv(5×5, 16ch) → BN → MaxPool(4×4)
    │
    └─ Classifier: Flatten → Dropout(0.5) → FC(784→16) → ReLU → Dropout(0.5) → FC(16→2) → Softmax
```

- **In-browser (TF.js):** Runs via WebGPU (10x faster) or WebGL (3x faster) fallback
- **Server-side (PyTorch):** Loaded from `backend/weights/best_model.pt`, runs on CUDA/MPS/CPU

### 3. PPG Heart-Rate Analysis (Server-Side Only)

Real faces contain subtle skin colour oscillations caused by blood pulsing through capillaries — **deepfake-generated faces lack this signal**.

The backend implements **rPPG** (remote Photoplethysmography) using the **CHROM algorithm** (*de Haan & Jeanne, 2013*):

1. Isolates the **forehead ROI** (top 15% × middle 50% of the face bounding box)
2. Accumulates mean RGB values per frame in a rolling 10-second buffer (~300 frames at 30 fps)
3. Applies CHROM signal extraction: `X = 3R - 2G`, `Y = 1.5R + G - 1.5B`
4. FFT band-pass filters to cardiac frequencies: **0.67–3.33 Hz (40–200 BPM)**
5. Measures Signal-to-Noise Ratio in the cardiac band — low SNR → anomalous → higher score

### 4. Temporal Consistency Check

Deepfake detectors can occasionally misfire on individual frames. The temporal checker:
- Maintains a **sliding window** of the last 30 deepfake confidence scores per session
- Computes rolling standard deviation — if confidence is erratic, flags higher anomaly score
- Separate sessions per video stream enable multi-participant tracking simultaneously

### 5. Score Fusion & Classification

```
Combined Score = 0.60 × Visual CNN + 0.20 × PPG Anomaly + 0.20 × Temporal Score

Score < 0.30   → "real"       → threat_level: "safe"
Score 0.30–0.70 → "suspicious" → threat_level: "warning"
Score > 0.70   → "fake"       → threat_level: "danger"
```

---

## 📁 Project Structure

```
deepfake-recognition/
├── public/                        # Static Chrome extension files
│   ├── manifest.json              # Extension manifest (Manifest V3)
│   ├── icons/                     # Extension icons (16, 48, 128px)
│   ├── models/                    # TF.js model weights (model.json + shards)
│   └── mediapipe/                 # MediaPipe WASM + model assets
│
├── src/                           # TypeScript source (compiled → dist/)
│   ├── background/                # Service worker (tab capture, message broker)
│   ├── content/                   # Content script (Google Meet DOM integration)
│   ├── offscreen/                 # Offscreen document (TF.js inference)
│   ├── popup/                     # React popup UI (live confidence display)
│   ├── settings/                  # Settings page
│   └── utils/
│       ├── ai-model.ts            # TensorFlow.js model wrapper
│       ├── face-detector.ts       # MediaPipe BlazeFace integration
│       ├── video-detector.ts      # Google Meet <video> discovery
│       ├── types.ts               # Shared TypeScript interfaces
│       └── logger.ts              # Structured logger
│
├── backend/                       # Python FastAPI server (optional)
│   ├── Dockerfile                 # Docker image for the backend
│   ├── requirements.txt           # Python dependencies
│   └── app/
│       ├── main.py                # FastAPI app + endpoints
│       ├── models.py              # PyTorch MesoInception4 + inference wrapper
│       ├── ppg.py                 # rPPG heart-rate analysis (CHROM algorithm)
│       ├── temporal.py            # Temporal consistency checker
│       └── preprocessing.py      # Face crop & normalization
│
├── training/                      # Model training scripts
│   ├── train_mesonet.py           # Train MesoInception4 on FaceForensics++
│   ├── prepare_data.py            # Dataset preparation and face extraction
│   ├── download_pretrained.py     # Download pre-trained weights
│   ├── convert_to_tfjs.py         # Convert PyTorch → TF.js for browser
│   ├── MesoInception4.h5          # Keras reference weights
│   └── weights_cache/             # Cached downloaded weights
│
├── dist/                          # Webpack build output (load this in Chrome)
├── package.json                   # Node.js dependencies
├── webpack.config.js              # Webpack bundler configuration
└── tsconfig.json                  # TypeScript compiler config
```

---

## 🛠️ Tech Stack

### Frontend (Chrome Extension)

| Technology | Version | Purpose |
|---|---|---|
| TypeScript | 5.9 | Type-safe extension code |
| React | 19.2 | Popup UI components |
| TensorFlow.js | 4.22 | In-browser CNN inference |
| TF.js WebGPU backend | 4.22 | GPU-accelerated inference |
| MediaPipe Tasks Vision | 0.10 | BlazeFace face detection |
| Webpack | 5 | Module bundler |
| Chrome Extension MV3 | — | Extension platform |

### Backend (Python Server)

| Technology | Version | Purpose |
|---|---|---|
| FastAPI | 0.111 | REST API framework |
| Uvicorn | 0.30 | ASGI server |
| PyTorch | ≥2.1 | CNN model training & inference |
| TorchVision | ≥0.16 | Image transforms |
| OpenCV Headless | ≥4.9 | Frame decoding & face processing |
| NumPy | ≥1.26 | Signal processing (rPPG FFT) |
| Pillow | ≥10.0 | Image manipulation |
| ONNX | ≥1.16 | Model export for portability |
| Pydantic | 2.7 | Request/response validation |

---

## 🚀 Installation & Setup

### Prerequisites

- Google Chrome (or Chromium-based browser)
- Node.js ≥ 18 and npm
- Python ≥ 3.10 (for the backend)

### 1. Build the Chrome Extension

```bash
# Clone the repository
git clone https://github.com/RajKC7717/deepfake-recognition.git
cd deepfake-recognition

# Install Node.js dependencies
npm install

# Build the extension
npm run build

# For development with live rebuild:
npm run watch
```

### 2. Load the Extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder in the project root
5. The extension icon will appear in your toolbar

### 3. Set Up the Backend (Optional)

The backend is required for PPG and temporal analysis. Skip this if you want browser-only detection.

#### Using Docker (Recommended)

```bash
cd backend
docker build -t deepfake-backend .
docker run -p 8000:8000 deepfake-backend
```

#### Manual Setup

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Place trained weights at: backend/weights/best_model.pt
# (see Training section below)

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

The API will be available at `http://localhost:8000`. Verify with:
```bash
curl http://localhost:8000/health
```

### 4. Using the Extension

1. Join a Google Meet call at `https://meet.google.com`
2. Click the **Deepfake Detector** icon in the Chrome toolbar
3. The popup will display live detection results for participant video streams
4. Color-coded threat levels will update in real-time:
   - 🟢 **Safe** — score < 0.30 (likely real)
   - 🟡 **Warning** — score 0.30–0.70 (suspicious)
   - 🔴 **Danger** — score > 0.70 (likely deepfake)

---

## 🧑‍🔬 Training the Model

The model is trained on the **FaceForensics++** dataset, achieving **92–95% test accuracy**.

### Step 1: Prepare the Dataset

```bash
cd training

# Download and extract faces from FaceForensics++
python prepare_data.py --input_dir /path/to/ff++ --output_dir /data/ff++_faces
```

The script extracts face crops from raw video and organizes them into:
```
/data/ff++_faces/
  train/  real/  fake/
  val/    real/  fake/
  test/   real/  fake/
```

### Step 2: Train MesoInception4

```bash
python train_mesonet.py \
  --data_dir /data/ff++_faces \
  --output_dir ./trained_model \
  --epochs 30 \
  --batch_size 64 \
  --lr 0.001
```

Training uses **CosineAnnealingLR** scheduler and **AdamW** optimizer. The best checkpoint (by validation accuracy) is saved as `trained_model/best_model.pt`.

Monitor training with TensorBoard:
```bash
tensorboard --logdir trained_model/runs
```

### Step 3: Convert to TF.js for Browser Use

```bash
python convert_to_tfjs.py \
  --model trained_model/best_model.pt \
  --output public/models/deepfake_detector
```

### Step 4: Download Pre-trained Weights (Alternative)

```bash
python download_pretrained.py
```

---

## 📡 API Reference

The FastAPI backend exposes the following endpoints. Visit `http://localhost:8000/docs` for the interactive Swagger UI.

### `GET /health`

Returns service health and model status.

```json
{
  "status": "ok",
  "model": "MesoInception4-trained",
  "uptime_s": 142.3
}
```

### `POST /analyze`

Analyzes a single video frame.

**Request body:**
```json
{
  "frame_b64": "<base64-encoded JPEG/PNG>",
  "frame_number": 42,
  "timestamp_ms": 14200,
  "session_id": "participant-abc123"
}
```

**Response:**
```json
{
  "frame_number": 42,
  "deepfake_confidence": 0.8234,
  "ppg_score": 0.7100,
  "temporal_score": 0.6500,
  "combined_score": 0.7753,
  "classification": "fake",
  "threat_level": "danger",
  "inference_time_ms": 18.4,
  "detail": {
    "face_bbox": {"x": 120, "y": 80, "w": 200, "h": 210},
    "model_name": "MesoInception4-trained"
  }
}
```

### `POST /analyze/batch`

Analyzes a sequence of frames with full temporal context.

**Request body:**
```json
{
  "frames": [ ...array of FrameRequest objects... ],
  "session_id": "participant-abc123"
}
```

**Response:**
```json
{
  "results": [ ...array of AnalysisResult... ],
  "session_id": "participant-abc123",
  "avg_combined_score": 0.7421,
  "overall_verdict": "danger"
}
```

---

## 📊 Scoring & Classification

| Signal | Weight | Description |
|---|---|---|
| **Visual CNN** | 60% | MesoInception4 deepfake probability from face image |
| **PPG Anomaly** | 20% | Absence of physiological heartbeat signal (rPPG/CHROM) |
| **Temporal** | 20% | Inconsistency of CNN scores over a sliding 30-frame window |

| Combined Score | Classification | Threat Level |
|---|---|---|
| `< 0.30` | ✅ Real | 🟢 Safe |
| `0.30 – 0.70` | ⚠️ Suspicious | 🟡 Warning |
| `> 0.70` | 🚨 Fake | 🔴 Danger |

---

## 🔒 Privacy

> **Your video never leaves your browser for the primary detection pipeline.**

- The Chrome extension performs all inference locally using TensorFlow.js
- The optional backend server only receives frames you explicitly configure it to analyze
- No data is sent to any third-party services
- The extension only runs on `https://meet.google.com/*` as declared in `manifest.json`
- Permissions used: `tabCapture`, `activeTab`, `storage`, `offscreen`, `scripting`, `notifications`

---

## 📚 References

- Afchar, D., et al. — *MesoNet: a Compact Facial Video Forgery Detection Network* — [arXiv:1809.00888](https://arxiv.org/abs/1809.00888)
- de Haan, G. & Jeanne, V. — *Robust pulse rate from chrominance-based rPPG* — IEEE TBME, 2013
- Rössler, A., et al. — *FaceForensics++: Learning to Detect Manipulated Facial Images* — ICCV 2019

---

## 🤝 Contributing

Pull requests and issues are welcome! Please open an issue first to discuss what you would like to change.

```bash
# Run the extension in watch mode for development
npm run watch

# Start the backend in reload mode
uvicorn app.main:app --reload --port 8000
```

---

*Built with ❤️ for safer, more trustworthy video communication.*