# Chrome Web Store — Submission Package
## Deepfake Detector v0.2.0

---

## Store Listing

### Short Description (132 chars max)
Detect AI-generated deepfakes in real-time Google Meet calls. Privacy-first: all analysis runs on-device.

### Long Description

**Protect yourself from deepfake video fraud in real-time.**

Deepfake Detector uses on-device AI to analyze live video streams in Google Meet calls and alert you when a participant's video shows signs of being AI-generated or manipulated.

**🔒 Privacy-First Design**
- All processing happens in your browser using TensorFlow.js
- Zero video data ever leaves your device
- No account required, no cloud uploads

**🛡️ What It Detects**
- AI face-swap deepfakes (FaceSwap, DeepFakes)
- Neural texture synthesis artifacts
- Temporal inconsistencies across video frames
- Abnormal photoplethysmography (PPG) patterns (missing heartbeat signal)

**⚡ Fast & Lightweight**
- WebGPU / WebGL accelerated inference (~15–30ms per frame)
- Analyzes only the detected video region — 85% fewer pixels processed
- Automatic fallback from DOM detection → computer vision → full screen

**🎯 How It Works**
1. Open Google Meet and join a call
2. Click the extension icon → hit "Start Protection"
3. A green overlay highlights the protected video region
4. The AI runs continuously in the background, showing you a live authenticity score
5. If a deepfake is suspected, you'll see a red warning

**📊 Threat Levels**
- ✅ **VERIFIED REAL** — authenticity score above 70%
- ⚠️ **SUSPICIOUS** — possible manipulation detected
- 🚨 **DEEPFAKE DETECTED** — high-confidence manipulation

**🔬 Technology**
Built on MesoNet, a purpose-built deepfake detection architecture, combined with BlazeFace for real-time face tracking. Optional server-side analysis available for power users (self-hosted).

**⚠️ Important Note**
This tool is an aid, not a guarantee. Deepfake technology evolves rapidly. Always use your own judgment and other verification methods for high-stakes situations.

---

## Category
**Productivity** (primary) / Security

## Tags
deepfake, video security, AI detection, Google Meet, privacy, face detection

---

## Screenshots Checklist (1280×800 or 640×400)

| # | Title | Content |
|---|-------|---------|
| 1 | "Start Protection in one click" | Popup with green "Start Protection" button and video detected badge |
| 2 | "Live authenticity score" | Popup showing 94% VERIFIED REAL score during active analysis |
| 3 | "Instant deepfake alert" | Popup showing 🚨 DEEPFAKE DETECTED at 23% authenticity |
| 4 | "Protected region highlighted" | Google Meet with green glowing rectangle around participant video |
| 5 | "Customizable settings" | Settings page with sensitivity slider and privacy options |

## Promo Tile (440×280)
Text: "🛡️ Deepfake Detector — Protect your video calls with on-device AI"
Background: Dark (#0f172a) with green accent glow

## Small Promo Tile (920×680)  
Same design, larger format for featured placement

---

## Privacy Practices (Store Form Answers)

**Does this extension collect user data?** No

**Justification for permissions:**
- `tabCapture`: Capture video stream from the active Meet tab for local AI analysis. Video is never transmitted.
- `activeTab`: Detect video elements in the Meet DOM and inject the status overlay UI.
- `storage`: Save user settings (sensitivity, fps) locally in Chrome storage.
- `scripting`: Inject content script into meet.google.com to detect video elements.
- `offscreen`: Process video stream in an offscreen document without impacting tab performance.
- `notifications`: Alert the user when a deepfake is detected.

**Remote code?** No — all code is bundled in the extension package.

---

## Pre-Submission Checklist

- [ ] Icons at 16×16, 48×48, 128×128 (PNG, transparent background)
- [ ] At least 2 screenshots (up to 5)
- [ ] Privacy policy URL reachable (host `privacy.html` or link to GitHub)
- [ ] manifest.json version bumped
- [ ] All console.log replaced with logger.debug in production build
- [ ] No `eval()` or remote script loading
- [ ] CSP passes Chrome extension validator
- [ ] Tested on Chrome 120+
- [ ] Tested on Google Meet (live call with camera)
- [ ] Extension ZIP created from `dist/` folder only (no `src/`, `node_modules/`)

## Build for Store

```bash
npm run build           # compiles TS → dist/
cd dist
zip -r ../deepfake-detector-v0.2.0.zip . --exclude "*.map"
```

Upload `deepfake-detector-v0.2.0.zip` at:
https://chrome.google.com/webstore/devconsole/