#!/usr/bin/env python3
"""
convert_to_tfjs.py — Convert trained PyTorch MesoNet → TensorFlow.js
=====================================================================
Exports the trained model to a format usable by the Chrome extension.

Pipeline:
  PyTorch (.pt) → ONNX (.onnx) → TensorFlow SavedModel → TF.js LayersModel

Usage:
  python convert_to_tfjs.py --checkpoint ./trained_model/best_model.pt \
                            --output_dir ../public/models/deepfake_detector

Requirements:
  pip install torch torchvision onnx onnx-tf tensorflow tensorflowjs
"""

import argparse
import json
import os
import sys
from pathlib import Path

import torch
import torch.nn as nn


# ── Inline MesoInception4 (keep self-contained) ──────────────────────────────

class MesoInception4(nn.Module):
    def __init__(self, num_classes=2, dropout=0.5):
        super().__init__()
        # Inc block 1
        self.inc1_b1 = nn.Sequential(nn.Conv2d(3,1,1),  nn.ReLU(True))
        self.inc1_b2 = nn.Sequential(nn.Conv2d(3,4,1),  nn.ReLU(True), nn.Conv2d(4,4,3,padding=1), nn.ReLU(True))
        self.inc1_b3 = nn.Sequential(nn.Conv2d(3,4,1),  nn.ReLU(True), nn.Conv2d(4,4,3,padding=2,dilation=2), nn.ReLU(True))
        self.inc1_b4 = nn.Sequential(nn.Conv2d(3,2,1),  nn.ReLU(True), nn.Conv2d(2,2,3,padding=3,dilation=3), nn.ReLU(True))
        self.inc1_bn = nn.BatchNorm2d(11); self.inc1_pool = nn.MaxPool2d(2)
        # Inc block 2
        self.inc2_b1 = nn.Sequential(nn.Conv2d(11,2,1), nn.ReLU(True))
        self.inc2_b2 = nn.Sequential(nn.Conv2d(11,4,1), nn.ReLU(True), nn.Conv2d(4,4,3,padding=1), nn.ReLU(True))
        self.inc2_b3 = nn.Sequential(nn.Conv2d(11,4,1), nn.ReLU(True), nn.Conv2d(4,4,3,padding=2,dilation=2), nn.ReLU(True))
        self.inc2_b4 = nn.Sequential(nn.Conv2d(11,2,1), nn.ReLU(True), nn.Conv2d(2,2,3,padding=3,dilation=3), nn.ReLU(True))
        self.inc2_bn = nn.BatchNorm2d(12); self.inc2_pool = nn.MaxPool2d(2)
        # Conv blocks
        self.conv3 = nn.Sequential(nn.Conv2d(12,16,5,padding=2), nn.ReLU(True), nn.BatchNorm2d(16), nn.MaxPool2d(2))
        self.conv4 = nn.Sequential(nn.Conv2d(16,16,5,padding=2), nn.ReLU(True), nn.BatchNorm2d(16), nn.MaxPool2d(4))
        self.classifier = nn.Sequential(nn.Flatten(), nn.Dropout(dropout), nn.Linear(16*7*7,16), nn.ReLU(True), nn.Dropout(dropout), nn.Linear(16,num_classes))

    def inc(self, x, b1, b2, b3, b4, bn, pool):
        return pool(bn(torch.cat([b1(x),b2(x),b3(x),b4(x)], dim=1)))

    def forward(self, x):
        x = self.inc(x, self.inc1_b1,self.inc1_b2,self.inc1_b3,self.inc1_b4, self.inc1_bn,self.inc1_pool)
        x = self.inc(x, self.inc2_b1,self.inc2_b2,self.inc2_b3,self.inc2_b4, self.inc2_bn,self.inc2_pool)
        return self.classifier(self.conv4(self.conv3(x)))


# ── Step 1: PyTorch → ONNX ───────────────────────────────────────────────────

def export_onnx(checkpoint_path: Path, onnx_path: Path):
    print("Step 1: Exporting PyTorch → ONNX...")
    device = "cpu"
    model  = MesoInception4()

    ckpt = torch.load(checkpoint_path, map_location=device)
    state = ckpt["model"] if "model" in ckpt else ckpt
    model.load_state_dict(state)
    model.eval()

    dummy = torch.zeros(1, 3, 224, 224)

    torch.onnx.export(
        model,
        dummy,
        str(onnx_path),
        opset_version      = 13,
        input_names        = ["input"],
        output_names       = ["output"],
        dynamic_axes       = {"input": {0: "batch"}, "output": {0: "batch"}},
        do_constant_folding = True,
    )
    print(f"  ✅ ONNX saved: {onnx_path}")
    return onnx_path


# ── Step 2: ONNX → TensorFlow SavedModel ─────────────────────────────────────

def export_tf(onnx_path: Path, tf_path: Path):
    print("Step 2: Converting ONNX → TensorFlow SavedModel...")
    try:
        import onnx
        from onnx_tf.backend import prepare

        onnx_model = onnx.load(str(onnx_path))
        tf_rep     = prepare(onnx_model)
        tf_rep.export_graph(str(tf_path))
        print(f"  ✅ TF SavedModel saved: {tf_path}")
    except ImportError as e:
        print(f"  ❌ Missing dependency: {e}")
        print("     Install: pip install onnx onnx-tf tensorflow")
        sys.exit(1)


# ── Step 3: TensorFlow → TF.js ───────────────────────────────────────────────

def export_tfjs(tf_path: Path, tfjs_path: Path):
    print("Step 3: Converting TensorFlow → TF.js...")
    try:
        import tensorflowjs as tfjs
        tfjs.converters.convert_tf_saved_model(
            str(tf_path),
            str(tfjs_path),
            skip_op_check = False,
        )
        print(f"  ✅ TF.js model saved: {tfjs_path}")
    except ImportError:
        print("  ❌ tensorflowjs not installed: pip install tensorflowjs")
        sys.exit(1)


# ── Step 4: Generate model config ────────────────────────────────────────────

def write_model_config(tfjs_path: Path):
    config = {
        "modelPath":  "models/deepfake_detector/model.json",
        "inputSize":  224,
        "threshold": {
            "safe":    0.30,
            "warning": 0.70,
            "danger":  0.70,
        },
        "labels":    ["real", "fake"],
        "version":   "1.0.0",
        "architecture": "MesoInception4",
    }
    cfg_path = tfjs_path / "model_config.json"
    with open(cfg_path, "w") as f:
        json.dump(config, f, indent=2)
    print(f"  ✅ Model config: {cfg_path}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint",  required=True, help="Path to best_model.pt")
    parser.add_argument("--output_dir",  default="../public/models/deepfake_detector")
    parser.add_argument("--keep_intermediate", action="store_true")
    args   = parser.parse_args()

    checkpoint = Path(args.checkpoint)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    tmp_dir   = output_dir / "_tmp"
    tmp_dir.mkdir(exist_ok=True)

    onnx_path = tmp_dir / "mesonet.onnx"
    tf_path   = tmp_dir / "tf_savedmodel"

    print("=" * 55)
    print("MesoNet → TF.js Conversion Pipeline")
    print("=" * 55)
    print(f"Input  : {checkpoint}")
    print(f"Output : {output_dir}")
    print()

    export_onnx(checkpoint, onnx_path)
    export_tf(onnx_path, tf_path)
    export_tfjs(tf_path, output_dir)
    write_model_config(output_dir)

    if not args.keep_intermediate:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
        print("  🗑  Cleaned up intermediate files")

    print()
    print("=" * 55)
    print("✅ Conversion complete!")
    print(f"Copy {output_dir} → your extension's public/models/ folder")
    print("Update manifest web_accessible_resources if needed.")
    print("=" * 55)


if __name__ == "__main__":
    main()