#!/usr/bin/env python3
"""
convert_and_export.py - Self-contained MesoInception4 to TF.js converter.
No dependency on tensorflowjs package. Generates model.json + .bin files directly.
"""

import os
import sys
import json
import struct
import urllib.request
import ssl
import numpy as np

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"

WEIGHTS_URL = "https://github.com/DariusAf/MesoNet/raw/master/weights/MesoInception_DF.h5"
WEIGHTS_FILE = "MesoInception_DF_real.h5"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "models", "deepfake_detector")


def download_weights():
    if os.path.exists(WEIGHTS_FILE):
        size = os.path.getsize(WEIGHTS_FILE)
        print(f"  Weights file exists: {WEIGHTS_FILE} ({size:,} bytes)")
        return True
    print(f"  Downloading from: {WEIGHTS_URL}")
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(WEIGHTS_URL, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, context=ctx) as response:
            data = response.read()
            with open(WEIGHTS_FILE, "wb") as f:
                f.write(data)
        size = os.path.getsize(WEIGHTS_FILE)
        print(f"  [OK] Downloaded: {size:,} bytes")
        return True
    except Exception as e:
        print(f"  [FAIL] {e}")
        ret = os.system(f'curl -L -o {WEIGHTS_FILE} "{WEIGHTS_URL}"')
        return ret == 0 and os.path.exists(WEIGHTS_FILE)


def build_mesoinception4(input_size=256):
    from tensorflow.keras.models import Model
    from tensorflow.keras.layers import (
        Input, Dense, Flatten, Conv2D, MaxPooling2D,
        BatchNormalization, Dropout, Concatenate, LeakyReLU,
    )
    from tensorflow.keras.optimizers import Adam

    def InceptionLayer(a, b, c, d):
        def func(x):
            x1 = Conv2D(a, (1, 1), padding="same", activation="relu")(x)
            x2 = Conv2D(b, (1, 1), padding="same", activation="relu")(x)
            x2 = Conv2D(b, (3, 3), padding="same", activation="relu")(x2)
            x3 = Conv2D(c, (1, 1), padding="same", activation="relu")(x)
            x3 = Conv2D(c, (3, 3), dilation_rate=2, strides=1, padding="same", activation="relu")(x3)
            x4 = Conv2D(d, (1, 1), padding="same", activation="relu")(x)
            x4 = Conv2D(d, (3, 3), dilation_rate=3, strides=1, padding="same", activation="relu")(x4)
            y = Concatenate(axis=-1)([x1, x2, x3, x4])
            return y
        return func

    x = Input(shape=(input_size, input_size, 3))
    x1 = InceptionLayer(1, 4, 4, 2)(x)
    x1 = BatchNormalization()(x1)
    x1 = MaxPooling2D(pool_size=(2, 2), padding="same")(x1)
    x2 = InceptionLayer(2, 4, 4, 2)(x1)
    x2 = BatchNormalization()(x2)
    x2 = MaxPooling2D(pool_size=(2, 2), padding="same")(x2)
    x3 = Conv2D(16, (5, 5), padding="same", activation="relu")(x2)
    x3 = BatchNormalization()(x3)
    x3 = MaxPooling2D(pool_size=(2, 2), padding="same")(x3)
    x4 = Conv2D(16, (5, 5), padding="same", activation="relu")(x3)
    x4 = BatchNormalization()(x4)
    x4 = MaxPooling2D(pool_size=(4, 4), padding="same")(x4)
    y = Flatten()(x4)
    y = Dropout(0.5)(y)
    y = Dense(16)(y)
    y = LeakyReLU(negative_slope=0.1)(y)
    y = Dropout(0.5)(y)
    y = Dense(1, activation="sigmoid")(y)

    model = Model(inputs=x, outputs=y)
    optimizer = Adam(learning_rate=0.001)
    model.compile(optimizer=optimizer, loss="mean_squared_error", metrics=["accuracy"])
    return model


def keras_layer_to_tfjs_config(layer):
    """Convert a Keras layer config to TF.js compatible format."""
    config = layer.get_config()
    class_name = layer.__class__.__name__
    
    tfjs_config = {"class_name": class_name, "config": config}
    
    # Fix config keys for TF.js compatibility
    if "name" in config:
        tfjs_config["config"]["name"] = config["name"]
    
    return tfjs_config


def export_to_tfjs_manual(model, output_dir):
    """
    Manually export a Keras model to TF.js LayersModel format.
    Generates model.json (topology + weight manifest) and .bin weight files.
    """
    os.makedirs(output_dir, exist_ok=True)
    
    # -- 1) Save model as JSON topology via Keras --
    model_json_str = model.to_json()
    model_topology = json.loads(model_json_str)
    
    # -- 2) Extract all weights and save as binary --
    weight_specs = []
    weight_data = bytearray()
    
    for layer in model.layers:
        weights = layer.get_weights()
        if not weights:
            continue
        
        weight_names = [w.name for w in layer.weights]
        
        for w_array, w_name in zip(weights, weight_names):
            w_array = w_array.astype(np.float32)
            
            spec = {
                "name": w_name,
                "shape": list(w_array.shape),
                "dtype": "float32",
            }
            weight_specs.append(spec)
            weight_data.extend(w_array.tobytes())
    
    # Save binary weights
    bin_filename = "group1-shard1of1.bin"
    bin_path = os.path.join(output_dir, bin_filename)
    with open(bin_path, "wb") as f:
        f.write(weight_data)
    
    # -- 3) Build model.json --
    model_json = {
        "format": "layers-model",
        "generatedBy": "custom-converter",
        "convertedBy": "MesoNet-export-script v1.0",
        "modelTopology": model_topology,
        "weightsManifest": [
            {
                "paths": [bin_filename],
                "weights": weight_specs,
            }
        ],
    }
    
    model_json_path = os.path.join(output_dir, "model.json")
    with open(model_json_path, "w") as f:
        json.dump(model_json, f)
    
    return model_json_path, bin_path


def main():
    print("=" * 60)
    print("MesoInception4 -> TF.js (Self-contained converter)")
    print("=" * 60)

    # Step 1: Download
    print("\n[Step 1] Downloading pretrained weights...")
    if not download_weights():
        print("  FAILED. Exiting.")
        sys.exit(1)

    size = os.path.getsize(WEIGHTS_FILE)
    print(f"  File size: {size:,} bytes ({size/1024:.1f} KB)")

    # Step 2: Build model
    print("\n[Step 2] Building MesoInception4 architecture...")
    model = build_mesoinception4(input_size=256)
    print(f"  Parameters: {model.count_params():,}")

    # Step 3: Load weights
    print("\n[Step 3] Loading pretrained weights...")
    try:
        model.load_weights(WEIGHTS_FILE)
        print("  [OK] Weights loaded!")
    except Exception as e:
        print(f"  [FAIL] {e}")
        sys.exit(1)

    # Step 4: Sanity check
    print("\n[Step 4] Sanity check...")
    dummy = np.random.rand(1, 256, 256, 3).astype(np.float32)
    pred = model.predict(dummy, verbose=0)
    print(f"  Prediction on random input: {pred[0][0]:.6f}")
    
    # Test with all-zeros and all-ones
    zeros = np.zeros((1, 256, 256, 3), dtype=np.float32)
    ones = np.ones((1, 256, 256, 3), dtype=np.float32)
    pred_z = model.predict(zeros, verbose=0)
    pred_o = model.predict(ones, verbose=0)
    print(f"  Prediction on zeros: {pred_z[0][0]:.6f}")
    print(f"  Prediction on ones:  {pred_o[0][0]:.6f}")

    # Step 5: Export to TF.js
    print("\n[Step 5] Exporting to TF.js format...")
    
    # Clean output directory
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for f in os.listdir(OUTPUT_DIR):
        fpath = os.path.join(OUTPUT_DIR, f)
        if os.path.isfile(fpath):
            os.remove(fpath)
    tmp_dir = os.path.join(OUTPUT_DIR, "_tmp")
    if os.path.isdir(tmp_dir):
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
    
    model_json_path, bin_path = export_to_tfjs_manual(model, OUTPUT_DIR)
    
    json_size = os.path.getsize(model_json_path)
    bin_size = os.path.getsize(bin_path)
    print(f"  model.json: {json_size:,} bytes")
    print(f"  weights bin: {bin_size:,} bytes")

    # Step 6: Write config
    print("\n[Step 6] Writing model config...")
    config = {
        "modelPath": "models/deepfake_detector/model.json",
        "inputSize": 256,
        "threshold": {"safe": 0.30, "warning": 0.60, "danger": 0.80},
        "labels": ["real", "fake"],
        "version": "1.0.0",
        "architecture": "MesoInception4",
        "outputType": "sigmoid",
        "notes": "Single sigmoid output. >0.5 = fake, <0.5 = real.",
    }
    cfg_path = os.path.join(OUTPUT_DIR, "model_config.json")
    with open(cfg_path, "w") as f:
        json.dump(config, f, indent=2)
    print(f"  [OK] {cfg_path}")

    # Step 7: Verify
    print("\n[Step 7] Verification...")
    with open(model_json_path) as f:
        mj = json.load(f)
    
    print(f"  format: {mj.get('format')}")
    print(f"  modelTopology: {'YES' if 'modelTopology' in mj else 'NO'}")
    print(f"  weightsManifest: {'YES' if 'weightsManifest' in mj else 'NO'}")
    
    n_weights = sum(len(g.get("weights", [])) for g in mj.get("weightsManifest", []))
    print(f"  Weight entries: {n_weights}")
    
    print("\n  Output files:")
    for f in sorted(os.listdir(OUTPUT_DIR)):
        fpath = os.path.join(OUTPUT_DIR, f)
        if os.path.isfile(fpath):
            s = os.path.getsize(fpath)
            print(f"    {f}: {s:,} bytes")

    print("\n" + "=" * 60)
    print("DONE! Real model exported to TF.js format.")
    print(f"  {os.path.abspath(OUTPUT_DIR)}")
    print("  Next: npm run build")
    print("=" * 60)


if __name__ == "__main__":
    main()
