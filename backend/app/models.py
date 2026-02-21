"""
backend/app/models.py — PyTorch model loading and inference
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torchvision.transforms as T
from PIL import Image

logger = logging.getLogger("backend.models")

MODEL_PATH = Path(__file__).parent.parent / "weights" / "best_model.pt"
FACE_SIZE  = 224

_IMAGENET_MEAN = [0.485, 0.456, 0.406]
_IMAGENET_STD  = [0.229, 0.224, 0.225]

_TRANSFORM = T.Compose([
    T.Resize((FACE_SIZE, FACE_SIZE)),
    T.ToTensor(),
    T.Normalize(_IMAGENET_MEAN, _IMAGENET_STD),
])


# ─── Architecture (mirrored from training/train_mesonet.py) ───────────────────

class MesoInception4(nn.Module):
    def __init__(self, num_classes=2, dropout=0.5):
        super().__init__()
        self.inc1_b1 = nn.Sequential(nn.Conv2d(3,1,1),  nn.ReLU(True))
        self.inc1_b2 = nn.Sequential(nn.Conv2d(3,4,1),  nn.ReLU(True), nn.Conv2d(4,4,3,padding=1), nn.ReLU(True))
        self.inc1_b3 = nn.Sequential(nn.Conv2d(3,4,1),  nn.ReLU(True), nn.Conv2d(4,4,3,padding=2,dilation=2), nn.ReLU(True))
        self.inc1_b4 = nn.Sequential(nn.Conv2d(3,2,1),  nn.ReLU(True), nn.Conv2d(2,2,3,padding=3,dilation=3), nn.ReLU(True))
        self.inc1_bn = nn.BatchNorm2d(11); self.inc1_pool = nn.MaxPool2d(2)
        self.inc2_b1 = nn.Sequential(nn.Conv2d(11,2,1), nn.ReLU(True))
        self.inc2_b2 = nn.Sequential(nn.Conv2d(11,4,1), nn.ReLU(True), nn.Conv2d(4,4,3,padding=1), nn.ReLU(True))
        self.inc2_b3 = nn.Sequential(nn.Conv2d(11,4,1), nn.ReLU(True), nn.Conv2d(4,4,3,padding=2,dilation=2), nn.ReLU(True))
        self.inc2_b4 = nn.Sequential(nn.Conv2d(11,2,1), nn.ReLU(True), nn.Conv2d(2,2,3,padding=3,dilation=3), nn.ReLU(True))
        self.inc2_bn = nn.BatchNorm2d(12); self.inc2_pool = nn.MaxPool2d(2)
        self.conv3   = nn.Sequential(nn.Conv2d(12,16,5,padding=2), nn.ReLU(True), nn.BatchNorm2d(16), nn.MaxPool2d(2))
        self.conv4   = nn.Sequential(nn.Conv2d(16,16,5,padding=2), nn.ReLU(True), nn.BatchNorm2d(16), nn.MaxPool2d(4))
        self.classifier = nn.Sequential(nn.Flatten(), nn.Dropout(dropout), nn.Linear(16*7*7,16), nn.ReLU(True), nn.Dropout(dropout), nn.Linear(16,num_classes))

    def inc(self, x, b1,b2,b3,b4,bn,pool):
        return pool(bn(torch.cat([b1(x),b2(x),b3(x),b4(x)],dim=1)))

    def forward(self, x):
        x = self.inc(x,self.inc1_b1,self.inc1_b2,self.inc1_b3,self.inc1_b4,self.inc1_bn,self.inc1_pool)
        x = self.inc(x,self.inc2_b1,self.inc2_b2,self.inc2_b3,self.inc2_b4,self.inc2_bn,self.inc2_pool)
        return self.classifier(self.conv4(self.conv3(x)))


# ─── Wrapper ──────────────────────────────────────────────────────────────────

class DeepfakeModel:
    """Thin wrapper around MesoInception4 for inference."""

    def __init__(self, model: nn.Module, name: str, device: str):
        self.model  = model
        self.name   = name
        self.device = device

    @torch.no_grad()
    def predict(self, face_rgb: np.ndarray) -> float:
        """
        Args:
            face_rgb: HxWx3 uint8 RGB numpy array
        Returns:
            Probability of being a deepfake (0.0 – 1.0)
        """
        pil    = Image.fromarray(face_rgb)
        tensor = _TRANSFORM(pil).unsqueeze(0).to(self.device)
        logits = self.model(tensor)
        probs  = torch.softmax(logits, dim=1)
        return probs[0, 1].item()   # probability of class 1 (fake)


def get_deepfake_model() -> DeepfakeModel:
    device = (
        "cuda" if torch.cuda.is_available()       else
        "mps"  if torch.backends.mps.is_available() else
        "cpu"
    )
    logger.info("Loading deepfake model on %s ...", device)

    net = MesoInception4(num_classes=2)

    if MODEL_PATH.exists():
        ckpt  = torch.load(MODEL_PATH, map_location=device)
        state = ckpt.get("model", ckpt)
        net.load_state_dict(state)
        logger.info("✅ Loaded trained weights from %s", MODEL_PATH)
        name  = "MesoInception4-trained"
    else:
        logger.warning("⚠  No weights at %s — using random init!", MODEL_PATH)
        name  = "MesoInception4-random"

    net.eval().to(device)
    return DeepfakeModel(net, name, device)