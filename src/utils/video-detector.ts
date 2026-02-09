import { createLogger } from './logger';

const logger = createLogger('VideoDetector');

export interface VideoRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  element: HTMLVideoElement;
  isPlaying: boolean;
}

export class VideoDetector {
  private detectedVideos: VideoRegion[] = [];
  private observer: MutationObserver | null = null;

  /**
   * Find all visible, playing video elements on the page
   */
  detectVideos(): VideoRegion[] {
    logger.debug('Scanning for video elements...');

    // Find all video elements
    const videoElements = document.querySelectorAll('video');
    const regions: VideoRegion[] = [];

    videoElements.forEach((video) => {
      // Check if video is visible and playing
      if (this.isVideoValid(video)) {
        const rect = video.getBoundingClientRect();
        
        // Only include if it has reasonable dimensions
        if (rect.width > 100 && rect.height > 100) {
          regions.push({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            element: video as HTMLVideoElement,
            isPlaying: !video.paused && !video.ended
          });
          
          logger.debug(`Found video: ${rect.width}x${rect.height} at (${rect.x}, ${rect.y})`);
        }
      }
    });

    this.detectedVideos = regions;
    logger.info(`Found ${regions.length} valid video(s)`);
    
    return regions;
  }

  /**
   * Get the largest video (usually the main participant)
   */
  getLargestVideo(): VideoRegion | null {
    const videos = this.detectVideos();
    
    if (videos.length === 0) {
      return null;
    }

    // Sort by area (width * height), largest first
    videos.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    
    return videos[0];
  }

  /**
   * Check if a video element is valid for capture
   */
  private isVideoValid(video: HTMLVideoElement): boolean {
    // Must be in viewport
    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    // Must be visible (not display:none or visibility:hidden)
    const style = window.getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    // Must have video content loaded
    if (video.readyState < 2) { // HAVE_CURRENT_DATA
      return false;
    }

    // Check if video is actually playing or has content
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      return false;
    }

    return true;
  }

  /**
   * Start watching for video changes
   */
  startWatching(callback: (videos: VideoRegion[]) => void) {
    logger.info('Starting video element observer...');

    // Initial detection
    const videos = this.detectVideos();
    callback(videos);

    // Watch for DOM changes (new videos added/removed)
    this.observer = new MutationObserver(() => {
      const newVideos = this.detectVideos();
      
      // Only call callback if videos changed
      if (this.hasVideosChanged(newVideos)) {
        logger.debug('Video elements changed, notifying...');
        callback(newVideos);
      }
    });

    // Observe the entire document
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class']
    });

    // Also check periodically (in case MutationObserver misses something)
    setInterval(() => {
      const currentVideos = this.detectVideos();
      if (this.hasVideosChanged(currentVideos)) {
        callback(currentVideos);
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Stop watching for changes
   */
  stopWatching() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
      logger.info('Stopped watching video elements');
    }
  }

  /**
   * Check if detected videos have changed
   */
  private hasVideosChanged(newVideos: VideoRegion[]): boolean {
    if (newVideos.length !== this.detectedVideos.length) {
      return true;
    }

    // Check if any coordinates changed significantly (>10px)
    for (let i = 0; i < newVideos.length; i++) {
      const old = this.detectedVideos[i];
      const newV = newVideos[i];
      
      if (Math.abs(old.x - newV.x) > 10 ||
          Math.abs(old.y - newV.y) > 10 ||
          Math.abs(old.width - newV.width) > 10 ||
          Math.abs(old.height - newV.height) > 10) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get specific video regions for Google Meet
   * (Handles Meet's specific layout)
   */
  getMeetVideoRegions(): VideoRegion[] {
    const videos = this.detectVideos();
    
    // Filter out very small videos (thumbnails)
    return videos.filter(v => v.width > 200 && v.height > 150);
  }
}