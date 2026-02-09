import * as blazeface from '@tensorflow-models/blazeface';
import { createLogger } from './logger';

const logger = createLogger('FaceDetector');

export interface FaceDetectionResult {
  detected: boolean;
  count: number;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  croppedFace?: ImageData;
}

export class FaceDetector {
  private model: blazeface.BlazeFaceModel | null = null;
  private isInitialized: boolean = false;

  async initialize(): Promise<void> {
    try {
      logger.info('Initializing BlazeFace detector...');

      this.model = await blazeface.load();

      this.isInitialized = true;
      logger.info('✅ Face detector ready (BlazeFace)');

    } catch (error) {
      logger.error('Failed to initialize face detector:', error);
      throw error;
    }
  }

  /**
   * Detect faces in video frame
   */
  async detectFaces(
    videoElement: HTMLVideoElement
  ): Promise<FaceDetectionResult> {
    if (!this.isInitialized || !this.model) {
      throw new Error('Face detector not initialized');
    }

    try {
      const predictions = await this.model.estimateFaces(videoElement, false);

      if (!predictions || predictions.length === 0) {
        return {
          detected: false,
          count: 0
        };
      }

      // Get first face
      const face = predictions[0];
      const [x, y] = face.topLeft as [number, number];
      const [x2, y2] = face.bottomRight as [number, number];
      
      const bbox = {
        x: Math.max(0, x),
        y: Math.max(0, y),
        width: x2 - x,
        height: y2 - y
      };

      const croppedFace = this.cropFace(videoElement, bbox);

      return {
        detected: true,
        count: predictions.length,
        boundingBox: bbox,
        croppedFace
      };
    } catch (error) {
      logger.error('Face detection error:', error);
      return {
        detected: false,
        count: 0
      };
    }
  }

  /**
   * Crop face region from video frame
   */
  private cropFace(
    video: HTMLVideoElement,
    bbox: { x: number; y: number; width: number; height: number }
  ): ImageData {
    const canvas = document.createElement('canvas');
    
    // Add 20% padding
    const padding = 0.2;
    const paddedWidth = bbox.width * (1 + padding);
    const paddedHeight = bbox.height * (1 + padding);
    const paddedX = Math.max(0, bbox.x - (paddedWidth - bbox.width) / 2);
    const paddedY = Math.max(0, bbox.y - (paddedHeight - bbox.height) / 2);
    
    canvas.width = paddedWidth;
    canvas.height = paddedHeight;

    const ctx = canvas.getContext('2d')!;
    
    ctx.drawImage(
      video,
      paddedX,
      paddedY,
      paddedWidth,
      paddedHeight,
      0,
      0,
      paddedWidth,
      paddedHeight
    );

    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  isReady(): boolean {
    return this.isInitialized;
  }

  dispose(): void {
    if (this.model) {
      this.model = null;
      this.isInitialized = false;
      logger.info('Face detector disposed');
    }
  }
}