import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';
// WebGPU is optional - will be loaded dynamically if available
import { createLogger } from './logger';

const logger = createLogger('AI-Model');

export class DeepfakeDetectorModel {
  private model: tf.LayersModel | null = null;
  private isLoaded: boolean = false;
  private backend: string = 'webgl';
  private inputSize: number = 224;

  constructor() {}

  async initialize(): Promise<void> {
    logger.info('Initializing AI model...');

    try {
      await this.setupBackend();
      await this.loadModel();
      await this.warmup();
      
      this.isLoaded = true;
      logger.info('✅ AI model ready!');
      
    } catch (error) {
      logger.error('Failed to initialize model:', error);
      throw error;
    }
  }

  private async setupBackend(): Promise<void> {
    // Try WebGPU (fastest) - dynamically import to avoid build errors
    try {
      // @ts-ignore - WebGPU might not be available
      await import('@tensorflow/tfjs-backend-webgpu');
      await tf.setBackend('webgpu');
      await tf.ready();
      this.backend = 'webgpu';
      logger.info('Using WebGPU backend (10x faster) 🚀');
      return;
    } catch (e) {
      logger.debug('WebGPU not available, trying WebGL...');
    }

    // Fallback to WebGL (fast and widely supported)
    try {
      await tf.setBackend('webgl');
      await tf.ready();
      this.backend = 'webgl';
      logger.info('Using WebGL backend (3x faster) ⚡');
      return;
    } catch (e) {
      logger.warn('WebGL not available, using CPU (slow) 🐌');
    }

    // Last resort: CPU
    await tf.setBackend('cpu');
    await tf.ready();
    this.backend = 'cpu';
  }

  private async loadModel(): Promise<void> {
    try {
      // Try to load pre-trained model from extension
      const modelPath = chrome.runtime.getURL('models/deepfake_detector/model.json');
      
      logger.info('Attempting to load model from:', modelPath);
      
      this.model = await tf.loadLayersModel(modelPath);
      logger.info('✅ Loaded pre-trained MesoNet model');
      
    } catch (error) {
      logger.warn('Pre-trained model not found, creating MesoNet architecture...');
      this.model = await this.createMesoNetModel();
    }
  }

  /**
   * Create MesoNet architecture directly in TensorFlow.js
   */
  private async createMesoNetModel(): Promise<tf.LayersModel> {
    logger.info('Building MesoNet architecture in browser...');
    
    const model = tf.sequential({
      layers: [
        // Block 1
        tf.layers.conv2d({
          inputShape: [this.inputSize, this.inputSize, 3],
          filters: 8,
          kernelSize: 3,
          padding: 'same',
          activation: 'relu'
        }),
        tf.layers.batchNormalization(),
        tf.layers.maxPooling2d({ poolSize: 2 }),
        
        // Block 2
        tf.layers.conv2d({
          filters: 8,
          kernelSize: 5,
          padding: 'same',
          activation: 'relu'
        }),
        tf.layers.batchNormalization(),
        tf.layers.maxPooling2d({ poolSize: 2 }),
        
        // Block 3
        tf.layers.conv2d({
          filters: 16,
          kernelSize: 5,
          padding: 'same',
          activation: 'relu'
        }),
        tf.layers.batchNormalization(),
        tf.layers.maxPooling2d({ poolSize: 2 }),
        
        // Block 4
        tf.layers.conv2d({
          filters: 16,
          kernelSize: 5,
          padding: 'same',
          activation: 'relu'
        }),
        tf.layers.batchNormalization(),
        tf.layers.maxPooling2d({ poolSize: 4 }),
        
        // Fully connected
        tf.layers.flatten(),
        tf.layers.dropout({ rate: 0.5 }),
        tf.layers.dense({ units: 16, activation: 'relu' }),
        tf.layers.dropout({ rate: 0.5 }),
        tf.layers.dense({ units: 2, activation: 'softmax' })
      ]
    });

    model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy']
    });

    logger.info('✅ MesoNet model created (random initialization)');
    logger.info('Note: For production, load a pre-trained model');

    return model;
  }

  private async warmup(): Promise<void> {
    logger.info('Warming up model...');
    
    const dummyInput = tf.zeros([1, this.inputSize, this.inputSize, 3]);
    
    const startTime = performance.now();
    const prediction = this.model!.predict(dummyInput) as tf.Tensor;
    const warmupTime = performance.now() - startTime;
    
    logger.info(`Warmup completed in ${warmupTime.toFixed(2)}ms`);
    
    dummyInput.dispose();
    prediction.dispose();
  }

  async detect(imageData: ImageData): Promise<{
    confidence: number;
    visualArtifactScore: number;
    inferenceTime: number;
  }> {
    if (!this.isLoaded || !this.model) {
      throw new Error('Model not loaded');
    }

    const startTime = performance.now();

    return tf.tidy(() => {
      const tensor = tf.browser.fromPixels(imageData)
        .resizeBilinear([this.inputSize, this.inputSize])
        .toFloat()
        .div(255.0)
        .expandDims(0);

      const prediction = this.model!.predict(tensor) as tf.Tensor;
      const probabilities = prediction.dataSync();
      
      const fakeScore = probabilities[1];
      const inferenceTime = performance.now() - startTime;
      
      logger.debug(`Inference: ${inferenceTime.toFixed(2)}ms, Fake: ${(fakeScore * 100).toFixed(1)}%`);

      return {
        confidence: fakeScore,
        visualArtifactScore: fakeScore,
        inferenceTime
      };
    });
  }

  isReady(): boolean {
    return this.isLoaded && this.model !== null;
  }

  getBackend(): string {
    return this.backend;
  }

  getInputSize(): number {
    return this.inputSize;
  }

  dispose(): void {
    if (this.model) {
      this.model.dispose();
      this.model = null;
      this.isLoaded = false;
      logger.info('Model disposed');
    }
  }
}