import * as blazeface from '@tensorflow-models/blazeface';
import { createLogger } from './logger';

const logger = createLogger('FaceDetector');

export interface FaceDetectionResult {
  detected: boolean;
  count: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
  croppedFace?: ImageData; // only populated by detectFaces(videoElement)
}

export class FaceDetector {
  private model: blazeface.BlazeFaceModel | null = null;
  private isInitialized = false;

  async initialize(): Promise<void> {
    try {
      logger.info('Initializing BlazeFace...');
      this.model = await blazeface.load();
      this.isInitialized = true;
      logger.info('✅ BlazeFace ready');
    } catch (err) {
      logger.error('BlazeFace init failed:', err);
      throw err;
    }
  }

  /**
   * Detect faces on an HTMLVideoElement.
   * Returns bounding box + cropped ImageData with 20% padding.
   * NOTE: Only use this when video.clientWidth > 0 (visible document).
   * In offscreen docs use detectFacesOnCanvas() instead.
   */
  async detectFaces(videoElement: HTMLVideoElement): Promise<FaceDetectionResult> {
    if (!this.isInitialized || !this.model) throw new Error('Not initialized');

    try {
      const predictions = await this.model.estimateFaces(videoElement, false);
      if (!predictions?.length) return { detected: false, count: 0 };

      const face    = this.largest(predictions);
      const bbox    = this.toBBox(face);
      const cropped = this.cropFromVideo(videoElement, bbox);

      return { detected: true, count: predictions.length, boundingBox: bbox, croppedFace: cropped };
    } catch (err) {
      logger.error('detectFaces error:', err);
      return { detected: false, count: 0 };
    }
  }

  /**
   * Detect faces on an HTMLCanvasElement.
   * Returns ONLY bounding box (no crop) — caller handles cropping.
   *
   * This is the correct method to use from the offscreen document because:
   * - Canvas always has real pixel dimensions (videoWidth × videoHeight)
   * - Video element in offscreen doc has clientWidth=0 (hidden document)
   *   which breaks coordinate scaling in cropFromVideo()
   */
  async detectFacesOnCanvas(canvas: HTMLCanvasElement): Promise<FaceDetectionResult> {
    if (!this.isInitialized || !this.model) throw new Error('Not initialized');

    try {
      const predictions = await this.model.estimateFaces(canvas, false);
      if (!predictions?.length) return { detected: false, count: 0 };

      const face = this.largest(predictions);
      const bbox = this.toBBox(face);

      return { detected: true, count: predictions.length, boundingBox: bbox };
    } catch (err) {
      logger.error('detectFacesOnCanvas error:', err);
      return { detected: false, count: 0 };
    }
  }

  isReady(): boolean { return this.isInitialized; }

  dispose(): void {
    this.model         = null;
    this.isInitialized = false;
    logger.info('FaceDetector disposed');
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private largest(predictions: blazeface.NormalizedFace[]): blazeface.NormalizedFace {
    return predictions.reduce((best, face) => {
      const area = (f: blazeface.NormalizedFace) => {
        const [x,  y]  = f.topLeft    as [number, number];
        const [x2, y2] = f.bottomRight as [number, number];
        return (x2 - x) * (y2 - y);
      };
      return area(face) > area(best) ? face : best;
    });
  }

  private toBBox(face: blazeface.NormalizedFace) {
    const [x,  y]  = face.topLeft    as [number, number];
    const [x2, y2] = face.bottomRight as [number, number];
    return { x: Math.max(0, x), y: Math.max(0, y), width: x2 - x, height: y2 - y };
  }

  /**
   * Crop face from video element with 20% padding.
   * Only call this when video.clientWidth > 0.
   */
  private cropFromVideo(
    video: HTMLVideoElement,
    bbox: { x: number; y: number; width: number; height: number }
  ): ImageData {
    const pad = 0.20;
    const pw  = bbox.width  * (1 + pad);
    const ph  = bbox.height * (1 + pad);
    const px  = Math.max(0, bbox.x - (pw - bbox.width)  / 2);
    const py  = Math.max(0, bbox.y - (ph - bbox.height) / 2);

    const canvas = document.createElement('canvas');
    canvas.width  = pw;
    canvas.height = ph;
    canvas.getContext('2d')!.drawImage(video, px, py, pw, ph, 0, 0, pw, ph);
    return canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  }
}