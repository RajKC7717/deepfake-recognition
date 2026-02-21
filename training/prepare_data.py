#!/usr/bin/env python3
"""
prepare_data.py — FaceForensics++ Dataset Preparation
======================================================
Downloads (or uses local) FaceForensics++ video clips, extracts face frames,
augments them, and saves a ready-to-train dataset.

Usage:
  python prepare_data.py --data_dir /data/ff++ --output_dir /data/ff++_faces
                         [--max_frames 100] [--compression c23]

Requirements:
  pip install opencv-python facenet-pytorch tqdm albumentations Pillow
"""

import argparse
import os
import json
import random
import shutil
from pathlib import Path

import cv2
import numpy as np
from tqdm import tqdm
from PIL import Image

try:
    from facenet_pytorch import MTCNN
    HAS_MTCNN = True
except ImportError:
    HAS_MTCNN = False
    print("⚠  facenet-pytorch not installed — using OpenCV face detector as fallback")

try:
    import albumentations as A
    HAS_AUG = True
except ImportError:
    HAS_AUG = False
    print("⚠  albumentations not installed — running without augmentation")


# ─── Constants ────────────────────────────────────────────────────────────────

# FaceForensics++ manipulations (the "fake" classes)
FF_FAKE_DIRS = [
    "DeepFakes",
    "FaceSwap",
    "Face2Face",
    "FaceShifter",
    "NeuralTextures",
]
FF_REAL_DIR  = "original_sequences/actors"

FACE_SIZE    = 224   # MesoNet input size
IMG_EXT      = ".jpg"
MAX_PER_VID  = 100   # cap frames per video (speed vs diversity trade-off)
TRAIN_SPLIT  = 0.80
VAL_SPLIT    = 0.10
# test = remainder


# ─── Helpers ─────────────────────────────────────────────────────────────────

def build_augmentation_pipeline() -> A.Compose | None:
    if not HAS_AUG:
        return None
    return A.Compose([
        A.HorizontalFlip(p=0.5),
        A.RandomBrightnessContrast(p=0.4),
        A.GaussNoise(var_limit=(10, 50), p=0.3),
        A.ImageCompression(quality_lower=60, quality_upper=100, p=0.3),
        A.Rotate(limit=15, p=0.4),
        A.CoarseDropout(max_holes=4, max_height=32, max_width=32, p=0.2),
    ])


def get_face_detector():
    """Return (detector_type, detector_object)."""
    if HAS_MTCNN:
        return "mtcnn", MTCNN(
            image_size=FACE_SIZE,
            margin=40,
            keep_all=False,
            device="cpu",
        )
    # OpenCV Haar fallback
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    return "opencv", cv2.CascadeClassifier(cascade_path)


def extract_face_mtcnn(detector, frame_rgb: np.ndarray) -> np.ndarray | None:
    """Use MTCNN to detect & align face."""
    pil = Image.fromarray(frame_rgb)
    face = detector(pil)  # returns aligned tensor or None
    if face is None:
        return None
    # tensor → numpy (CHW float → HWC uint8)
    arr = face.permute(1, 2, 0).numpy()
    arr = ((arr * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)
    return arr


def extract_face_opencv(detector, frame_bgr: np.ndarray) -> np.ndarray | None:
    """OpenCV Haar fallback face extraction."""
    gray   = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    faces  = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80))
    if len(faces) == 0:
        return None
    # largest face
    x, y, w, h = max(faces, key=lambda r: r[2] * r[3])
    pad   = int(max(w, h) * 0.2)
    x1    = max(0, x - pad)
    y1    = max(0, y - pad)
    x2    = min(frame_bgr.shape[1], x + w + pad)
    y2    = min(frame_bgr.shape[0], y + h + pad)
    crop  = frame_bgr[y1:y2, x1:x2]
    crop  = cv2.resize(crop, (FACE_SIZE, FACE_SIZE))
    return cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)


def extract_faces_from_video(
    video_path: Path,
    out_dir: Path,
    detector_type: str,
    detector,
    augmenter,
    max_frames: int,
    label: int,
    split: str,
) -> int:
    """Extract face frames from a single video. Returns number saved."""
    cap = cv2.VideoCapture(str(video_path))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if total_frames == 0:
        cap.release()
        return 0

    # Sample frame indices
    step   = max(1, total_frames // max_frames)
    idxs   = list(range(0, total_frames, step))[:max_frames]

    saved  = 0
    vid_id = video_path.stem

    for fi in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
        ok, frame = cap.read()
        if not ok:
            continue

        if detector_type == "mtcnn":
            rgb  = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            face = extract_face_mtcnn(detector, rgb)
        else:
            face = extract_face_opencv(detector, frame)

        if face is None:
            continue

        # Resize to standard
        face = cv2.resize(face, (FACE_SIZE, FACE_SIZE))

        # Save original
        fname = out_dir / split / str(label) / f"{vid_id}_{fi:05d}{IMG_EXT}"
        fname.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(face).save(fname, quality=95)
        saved += 1

        # Augment (only training split)
        if split == "train" and augmenter is not None:
            aug_result = augmenter(image=face)["image"]
            aug_fname  = out_dir / split / str(label) / f"{vid_id}_{fi:05d}_aug{IMG_EXT}"
            Image.fromarray(aug_result).save(aug_fname, quality=90)

    cap.release()
    return saved


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Prepare FaceForensics++ training data")
    parser.add_argument("--data_dir",   required=True, help="Root FaceForensics++ directory")
    parser.add_argument("--output_dir", required=True, help="Where to save processed faces")
    parser.add_argument("--max_frames", type=int, default=MAX_PER_VID)
    parser.add_argument("--compression", default="c23", choices=["raw", "c23", "c40"])
    args = parser.parse_args()

    data_dir   = Path(args.data_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    detector_type, detector = get_face_detector()
    augmenter               = build_augmentation_pipeline()
    print(f"Using detector  : {detector_type}")
    print(f"Augmentation    : {'enabled' if augmenter else 'disabled'}")
    print(f"Max frames/vid  : {args.max_frames}")
    print(f"Compression     : {args.compression}")
    print()

    stats = {"real": 0, "fake": 0}

    # ── Collect video paths ──────────────────────────────────────────────────

    def collect_videos(base: Path):
        return sorted(list(base.rglob("*.mp4")) + list(base.rglob("*.avi")))

    # Real
    real_dir   = data_dir / FF_REAL_DIR / args.compression / "videos"
    real_vids  = collect_videos(real_dir) if real_dir.exists() else []
    print(f"Real videos     : {len(real_vids)}")

    # Fake
    fake_vids  = []
    for mtype in FF_FAKE_DIRS:
        mdir = data_dir / "manipulated_sequences" / mtype / args.compression / "videos"
        vids = collect_videos(mdir)
        fake_vids.extend(vids)
        print(f"  {mtype:<20}: {len(vids)} videos")
    print(f"Fake videos     : {len(fake_vids)}")
    print()

    # ── Shuffle + split ──────────────────────────────────────────────────────

    def split_list(lst):
        random.shuffle(lst)
        n  = len(lst)
        t  = int(n * TRAIN_SPLIT)
        v  = int(n * VAL_SPLIT)
        return {"train": lst[:t], "val": lst[t:t+v], "test": lst[t+v:]}

    real_splits = split_list(real_vids)
    fake_splits = split_list(fake_vids)

    # ── Extract ──────────────────────────────────────────────────────────────

    for split in ("train", "val", "test"):
        print(f"Processing split: {split}")

        for vpath in tqdm(real_splits[split], desc=f"  real/{split}"):
            n = extract_faces_from_video(
                vpath, output_dir, detector_type, detector, augmenter,
                args.max_frames, label=0, split=split,
            )
            stats["real"] += n

        for vpath in tqdm(fake_splits[split], desc=f"  fake/{split}"):
            n = extract_faces_from_video(
                vpath, output_dir, detector_type, detector, augmenter,
                args.max_frames, label=1, split=split,
            )
            stats["fake"] += n

    # ── Summary ──────────────────────────────────────────────────────────────
    print()
    print("=" * 50)
    print("✅  Data preparation complete!")
    print(f"   Real face images : {stats['real']}")
    print(f"   Fake face images : {stats['fake']}")
    print(f"   Output directory : {output_dir}")

    # Save metadata
    meta = {
        "real":        stats["real"],
        "fake":        stats["fake"],
        "face_size":   FACE_SIZE,
        "compression": args.compression,
        "splits":      {"train": TRAIN_SPLIT, "val": VAL_SPLIT},
        "augmented":   HAS_AUG,
    }
    with open(output_dir / "dataset_meta.json", "w") as f:
        json.dump(meta, f, indent=2)
    print("   Metadata saved   : dataset_meta.json")


if __name__ == "__main__":
    main()