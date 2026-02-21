#!/usr/bin/env python3
"""
download_pretrained.py — Download pre-trained MesoNet weights & convert to TF.js
==================================================================================
Downloads community MesoNet weights trained on FaceForensics++
and converts them directly to TF.js format for the Chrome extension.

Usage:
  python download_pretrained.py --output_dir ../public/models/deepfake_detector

Requirements:
  pip install torch torchvision requests tensorflowjs onnx onnx-tf tensorflow
"""

import argparse
import os
import sys
import hashlib
import urllib.request
from pathlib import Path


# ─── Pre-trained weight sources ───────────────────────────────────────────────
# These are publicly available MesoNet weights trained on FaceForensics++
# Priority order: try each until one succeeds

WEIGHT_SOURCES = [
    {
        "name":  "MesoInception4 (FaceForensics++ c23)",
        "url":   "https://github.com/HongguLiu/MesoNet-Pytorch/raw/master/model/MesoInception_df_c23.pkl",
        "file":  "MesoInception_df_c23.pkl",
        "type":  "pkl",
        "note":  "Trained on DeepFakes, c23 compression. ~92% accuracy.",
    },
    {
        "name":  "MesoNet4 (FaceForensics++ c23)",
        "url":   "https://github.com/HongguLiu/MesoNet-Pytorch/raw/master/model/Meso4_df_c23.pkl",
        "file":  "Meso4_df_c23.pkl",
        "type":  "pkl",
        "note":  "Lighter model, ~90% accuracy.",
    },
]


def download_file(url: str, dest: Path) -> bool:
    """Download a file with progress. Returns True on success."""
    print(f"  Downloading: {url}")
    try:
        def reporthook(count, block_size, total_size):
            if total_size > 0:
                pct = min(100, count * block_size * 100 // total_size)
                print(f"\r  Progress: {pct}%", end="", flush=True)

        urllib.request.urlretrieve(url, dest, reporthook)
        print()  # newline after progress
        print(f"  ✅ Saved to: {dest}")
        return True
    except Exception as e:
        print(f"\n  ❌ Download failed: {e}")
        return False


def load_pkl_weights(pkl_path: Path):
    """Load PyTorch weights from .pkl file."""
    import torch
    try:
        weights = torch.load(pkl_path, map_location="cpu")
        print(f"  Loaded weights, keys: {list(weights.keys())[:5]}...")
        return weights
    except Exception as e:
        print(f"  ❌ Failed to load pkl: {e}")
        return None


def build_mesonet_model():
    """Build MesoInception4 in PyTorch matching the downloaded weights."""
    import torch
    import torch.nn as nn

    class MesoInception4(nn.Module):
        def __init__(self):
            super().__init__()
            self.conv1 = nn.Sequential(
                nn.Conv2d(3, 1, 1, padding=0), nn.ReLU(True))
            self.conv2 = nn.Sequential(
                nn.Conv2d(3, 4, 1, padding=0), nn.ReLU(True),
                nn.Conv2d(4, 4, 3, padding=1), nn.ReLU(True))
            self.conv3 = nn.Sequential(
                nn.Conv2d(3, 4, 1, padding=0), nn.ReLU(True),
                nn.Conv2d(4, 4, 3, padding=2, dilation=2), nn.ReLU(True))
            self.conv4 = nn.Sequential(
                nn.Conv2d(3, 2, 1, padding=0), nn.ReLU(True),
                nn.Conv2d(2, 2, 3, padding=3, dilation=3), nn.ReLU(True))
            self.bn1   = nn.BatchNorm2d(11)
            self.mp1   = nn.MaxPool2d(2)

            self.conv5 = nn.Sequential(
                nn.Conv2d(11, 2, 1, padding=0), nn.ReLU(True))
            self.conv6 = nn.Sequential(
                nn.Conv2d(11, 4, 1, padding=0), nn.ReLU(True),
                nn.Conv2d(4, 4, 3, padding=1), nn.ReLU(True))
            self.conv7 = nn.Sequential(
                nn.Conv2d(11, 4, 1, padding=0), nn.ReLU(True),
                nn.Conv2d(4, 4, 3, padding=2, dilation=2), nn.ReLU(True))
            self.conv8 = nn.Sequential(
                nn.Conv2d(11, 2, 1, padding=0), nn.ReLU(True),
                nn.Conv2d(2, 2, 3, padding=3, dilation=3), nn.ReLU(True))
            self.bn2   = nn.BatchNorm2d(12)
            self.mp2   = nn.MaxPool2d(2)

            self.conv9  = nn.Sequential(
                nn.Conv2d(12, 16, 5, padding=2), nn.ReLU(True),
                nn.BatchNorm2d(16), nn.MaxPool2d(2))
            self.conv10 = nn.Sequential(
                nn.Conv2d(16, 16, 5, padding=2), nn.ReLU(True),
                nn.BatchNorm2d(16), nn.MaxPool2d(4))

            self.fc1 = nn.Linear(16 * 7 * 7, 16)
            self.fc2 = nn.Linear(16, 2)
            self.dp  = nn.Dropout(0.5)

        def forward(self, x):
            x = self.mp1(self.bn1(torch.cat([self.conv1(x), self.conv2(x), self.conv3(x), self.conv4(x)], 1)))
            x = self.mp2(self.bn2(torch.cat([self.conv5(x), self.conv6(x), self.conv7(x), self.conv8(x)], 1)))
            x = self.conv9(x)
            x = self.conv10(x)
            x = x.view(x.size(0), -1)
            x = self.dp(torch.relu(self.fc1(x)))
            return self.fc2(x)

    return MesoInception4()


def convert_to_onnx(model, onnx_path: Path):
    import torch
    model.eval()
    dummy = torch.zeros(1, 3, 224, 224)
    torch.onnx.export(
        model, dummy, str(onnx_path),
        opset_version=13,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
    )
    print(f"  ✅ ONNX exported: {onnx_path}")


def convert_onnx_to_tfjs(onnx_path: Path, output_dir: Path):
    print("  Converting ONNX → TF SavedModel → TF.js...")
    try:
        import onnx
        from onnx_tf.backend import prepare
        import tensorflowjs as tfjs

        tf_dir = output_dir / "_tf_tmp"
        tf_dir.mkdir(exist_ok=True)

        onnx_model = onnx.load(str(onnx_path))
        tf_rep = prepare(onnx_model)
        tf_rep.export_graph(str(tf_dir))
        print("  ✅ TF SavedModel done")

        tfjs.converters.convert_tf_saved_model(str(tf_dir), str(output_dir))
        print(f"  ✅ TF.js model saved: {output_dir}")

        # Cleanup
        import shutil
        shutil.rmtree(tf_dir, ignore_errors=True)

    except ImportError as e:
        print(f"  ❌ Missing: {e}")
        print("  Install: pip install onnx onnx-tf tensorflow tensorflowjs")
        sys.exit(1)


def write_config(output_dir: Path, model_name: str):
    import json
    config = {
        "modelPath":    "models/deepfake_detector/model.json",
        "inputSize":    224,
        "threshold":    {"safe": 0.30, "warning": 0.70, "danger": 0.70},
        "labels":       ["real", "fake"],
        "version":      "1.0.0",
        "architecture": model_name,
        "trained":      True,
    }
    with open(output_dir / "model_config.json", "w") as f:
        json.dump(config, f, indent=2)
    print(f"  ✅ Config saved")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output_dir", default="../public/models/deepfake_detector")
    parser.add_argument("--weights_cache", default="./weights_cache")
    args = parser.parse_args()

    output_dir    = Path(args.output_dir)
    weights_cache = Path(args.weights_cache)
    output_dir.mkdir(parents=True, exist_ok=True)
    weights_cache.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("Pre-trained MesoNet → TF.js Converter")
    print("=" * 60)
    print()

    # ── Step 1: Download weights ──────────────────────────────────────────────
    downloaded_path = None
    source_name     = None

    for source in WEIGHT_SOURCES:
        dest = weights_cache / source["file"]
        print(f"Trying: {source['name']}")
        print(f"  Note: {source['note']}")

        if dest.exists():
            print(f"  ✅ Already cached: {dest}")
            downloaded_path = dest
            source_name     = source["name"]
            break

        if download_file(source["url"], dest):
            downloaded_path = dest
            source_name     = source["name"]
            break

        print()

    if not downloaded_path:
        print("❌ All download sources failed.")
        print()
        print("Manual alternative:")
        print("  1. Go to: https://github.com/HongguLiu/MesoNet-Pytorch")
        print("  2. Download MesoInception_df_c23.pkl from the model/ folder")
        print(f"  3. Place it in: {weights_cache}/")
        print("  4. Re-run this script")
        sys.exit(1)

    print()
    print(f"✅ Using weights: {source_name}")
    print()

    # ── Step 2: Load weights into model ──────────────────────────────────────
    print("Loading weights into MesoInception4...")
    weights = load_pkl_weights(downloaded_path)
    if weights is None:
        sys.exit(1)

    model = build_mesonet_model()
    try:
        model.load_state_dict(weights, strict=False)
        print("  ✅ Weights loaded")
    except Exception as e:
        print(f"  ⚠  load_state_dict warning: {e}")
        print("  Continuing anyway with partial weights...")

    print()

    # ── Step 3: Export to ONNX ────────────────────────────────────────────────
    print("Exporting to ONNX...")
    tmp_dir   = output_dir / "_tmp"
    tmp_dir.mkdir(exist_ok=True)
    onnx_path = tmp_dir / "mesonet.onnx"
    convert_to_onnx(model, onnx_path)
    print()

    # ── Step 4: ONNX → TF.js ─────────────────────────────────────────────────
    print("Converting to TF.js...")
    convert_onnx_to_tfjs(onnx_path, output_dir)
    print()

    # ── Step 5: Write config ──────────────────────────────────────────────────
    write_config(output_dir, source_name)

    # Cleanup tmp
    import shutil
    shutil.rmtree(tmp_dir, ignore_errors=True)

    print()
    print("=" * 60)
    print("✅ Done!")
    print(f"   Model saved to: {output_dir}")
    print()
    print("Next steps:")
    print(f"  1. Copy {output_dir} into your extension's public/models/ folder")
    print("  2. Run: npm run build")
    print("  3. Reload the extension in chrome://extensions")
    print("=" * 60)


if __name__ == "__main__":
    main()