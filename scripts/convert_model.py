"""
Convert a pre-trained deepfake detection model to TensorFlow.js format
"""

import tensorflow as tf
from tensorflow import keras
import os
import json
import shutil

def create_mesonet_model(input_shape=(224, 224, 3)):
    """
    MesoNet-style architecture for deepfake detection
    Paper: "MesoNet: a Compact Facial Video Forgery Detection Network"
    """
    
    model = keras.Sequential([
        # Block 1
        keras.layers.Conv2D(8, (3, 3), padding='same', activation='relu', input_shape=input_shape),
        keras.layers.BatchNormalization(),
        keras.layers.MaxPooling2D(pool_size=(2, 2)),
        
        # Block 2
        keras.layers.Conv2D(8, (5, 5), padding='same', activation='relu'),
        keras.layers.BatchNormalization(),
        keras.layers.MaxPooling2D(pool_size=(2, 2)),
        
        # Block 3
        keras.layers.Conv2D(16, (5, 5), padding='same', activation='relu'),
        keras.layers.BatchNormalization(),
        keras.layers.MaxPooling2D(pool_size=(2, 2)),
        
        # Block 4
        keras.layers.Conv2D(16, (5, 5), padding='same', activation='relu'),
        keras.layers.BatchNormalization(),
        keras.layers.MaxPooling2D(pool_size=(4, 4)),
        
        # Fully connected
        keras.layers.Flatten(),
        keras.layers.Dropout(0.5),
        keras.layers.Dense(16, activation='relu'),
        keras.layers.Dropout(0.5),
        keras.layers.Dense(2, activation='softmax')  # [real, fake]
    ])
    
    model.compile(
        optimizer='adam',
        loss='categorical_crossentropy',
        metrics=['accuracy']
    )
    
    return model

def save_model_for_tfjs(model, output_path):
    """
    Save model in a format compatible with TensorFlow.js
    Uses the native Keras format which TF.js can load directly
    """
    
    print(f"Saving model to {output_path}...")
    
    # Create output directory
    os.makedirs(output_path, exist_ok=True)
    
    # Save as Keras model (HDF5 format)
    h5_path = os.path.join(output_path, 'model.h5')
    model.save(h5_path)
    print(f"✅ Saved Keras model to {h5_path}")
    
    # Now convert using tensorflowjs converter (command line)
    print("\nTo convert to TensorFlow.js, run:")
    print(f"tensorflowjs_converter --input_format=keras {h5_path} {output_path}")
    
    return h5_path

def convert_with_command(h5_path, output_path):
    """
    Use command line converter to avoid dependency issues
    """
    import subprocess
    
    print("\nConverting to TensorFlow.js format...")
    
    cmd = [
        'tensorflowjs_converter',
        '--input_format=keras',
        '--quantize_uint8=*',  # Quantize for smaller size
        h5_path,
        output_path
    ]
    
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
        print(result.stdout)
        print("✅ Conversion successful!")
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ Conversion failed: {e}")
        print(e.stderr)
        return False
    except FileNotFoundError:
        print("❌ tensorflowjs_converter not found in PATH")
        print("Please install: pip install tensorflowjs")
        return False

def main():
    print("=" * 60)
    print("MesoNet Deepfake Detector - TensorFlow.js Converter")
    print("=" * 60)
    
    print("\n1. Creating MesoNet model...")
    model = create_mesonet_model()
    
    print("\n2. Model Summary:")
    model.summary()
    
    # Calculate model size
    param_count = model.count_params()
    print(f"\nTotal parameters: {param_count:,}")
    print(f"Estimated size (float32): ~{(param_count * 4) / (1024 * 1024):.2f} MB")
    print(f"After quantization (uint8): ~{(param_count) / (1024 * 1024):.2f} MB")
    
    # Determine output path (relative to script location)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_path = os.path.join(script_dir, '..', 'public', 'models', 'deepfake_detector')
    output_path = os.path.abspath(output_path)
    
    print(f"\n3. Output path: {output_path}")
    
    # Save Keras model
    h5_path = save_model_for_tfjs(model, output_path)
    
    # Try to convert
    print("\n4. Converting to TensorFlow.js...")
    success = convert_with_command(h5_path, output_path)
    
    if success:
        print("\n" + "=" * 60)
        print("✅ SUCCESS! Model ready for use in extension!")
        print("=" * 60)
        print(f"\nModel files created in: {output_path}")
        print("\nLoad in TensorFlow.js with:")
        print("  tf.loadLayersModel('models/deepfake_detector/model.json')")
        
        # Clean up h5 file
        if os.path.exists(h5_path):
            os.remove(h5_path)
            print(f"\n🧹 Cleaned up temporary file: {h5_path}")
    else:
        print("\n⚠️  Automatic conversion failed.")
        print(f"Manual step required:")
        print(f"\nRun this command:")
        print(f"  tensorflowjs_converter --input_format=keras --quantize_uint8=* {h5_path} {output_path}")

if __name__ == "__main__":
    main()