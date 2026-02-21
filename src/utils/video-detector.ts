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

  // Debounce timers
  private scanDebounceTimer: number | null = null;

  // Missed scan counter — VIDEO_LOST only fires after this many consecutive misses
  private missedScans = 0;
  private readonly MISSED_SCAN_THRESHOLD = 3;

  // ─── Public API ─────────────────────────────────────────────────────────────

  detectVideos(): VideoRegion[] {
    logger.debug('Scanning for video elements...');

    const videoElements = document.querySelectorAll('video');
    const regions: VideoRegion[] = [];

    videoElements.forEach((video) => {
      if (this.isVideoValid(video)) {
        const rect = video.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 100) {
          regions.push({
            x:         rect.x,
            y:         rect.y,
            width:     rect.width,
            height:    rect.height,
            element:   video as HTMLVideoElement,
            isPlaying: !video.paused && !video.ended,
          });
          logger.debug(`Found video: ${rect.width}x${rect.height} readyState=${video.readyState} srcObject=${!!video.srcObject}`);
        }
      }
    });

    logger.info(`Found ${regions.length} valid video(s) out of ${videoElements.length} total`);
    return regions;
  }

  getLargestVideo(): VideoRegion | null {
    const videos = this.detectVideos();
    if (videos.length === 0) return null;
    videos.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return videos[0];
  }

  /**
   * Force an immediate fresh scan — used by CHECK_VIDEO from popup.
   * Resets the missed-scan counter so a single popup open can't trigger VIDEO_LOST.
   */
  forceDetect(): VideoRegion[] {
    this.missedScans = 0;
    const videos = this.detectVideos();
    if (videos.length > 0) {
      this.detectedVideos = videos;
    }
    return videos;
  }

  /**
   * Start watching for video changes.
   * @param onFound  — called when video is detected or its region changes
   * @param onLost   — called only after MISSED_SCAN_THRESHOLD consecutive misses (~9s)
   */
  startWatching(
    onFound: (videos: VideoRegion[]) => void,
    onLost:  () => void
  ) {
    logger.info('Starting video element observer...');

    // Try immediately, then retry with backoff (Meet loads video async)
    this.retryInitialDetection(onFound, 0);

    // MutationObserver — debounced 500ms to avoid DOM-reflow thrashing
    this.observer = new MutationObserver(() => {
      if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
      this.scanDebounceTimer = window.setTimeout(() => {
        this.checkAndNotify(onFound, onLost);
      }, 500);
    });

    this.observer.observe(document.body, {
      childList:       true,
      subtree:         true,
      attributes:      true,
      attributeFilter: ['style', 'class', 'src'],
    });

    // Periodic safety-net check every 3 seconds
    setInterval(() => {
      this.checkAndNotify(onFound, onLost);
    }, 3000);
  }

  stopWatching() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
    logger.info('Stopped watching video elements');
  }

  getMeetVideoRegions(): VideoRegion[] {
    return this.detectVideos().filter(v => v.width > 200 && v.height > 150);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * FIXED: Relaxed validation for Google Meet WebRTC streams.
   *
   * Old code broke Meet because:
   *   readyState < 2  → WebRTC streams stay at readyState=1 (HAVE_METADATA) while live
   *   videoWidth === 0 → WebRTC streams report 0 until first frame is rendered
   *
   * Fix: check srcObject (primary WebRTC signal) + visible on screen + not errored.
   */
  private isVideoValid(video: HTMLVideoElement): boolean {
    const rect = video.getBoundingClientRect();

    // Must have size on screen
    if (rect.width === 0 || rect.height === 0) return false;

    // Must not be explicitly hidden
    const style = window.getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

    // Must be within the viewport vertically
    if (rect.bottom < 0 || rect.top > window.innerHeight) return false;

    // Must have a source — srcObject = WebRTC stream, src = regular video
    const hasSource = video.srcObject !== null || (video.src && video.src !== '');
    if (!hasSource) return false;

    // Must not be in an error state
    if (video.error !== null) return false;

    // readyState >= 1 (HAVE_METADATA) — covers live WebRTC streams
    // Old threshold was >= 2, which excluded most Meet streams
    if (video.readyState < 1) return false;

    return true;
  }

  private checkAndNotify(onFound: (v: VideoRegion[]) => void, onLost: () => void) {
    const videos = this.detectVideos();

    if (videos.length > 0) {
      // Video present — reset missed counter
      this.missedScans = 0;

      if (this.hasVideosChanged(videos)) {
        this.detectedVideos = videos;
        onFound(videos);
      }
    } else {
      // Increment missed scan counter
      this.missedScans++;
      logger.debug(`Missed scan #${this.missedScans}/${this.MISSED_SCAN_THRESHOLD}`);

      // Only report lost after threshold consecutive misses
      if (this.missedScans >= this.MISSED_SCAN_THRESHOLD && this.detectedVideos.length > 0) {
        logger.warn('Video truly lost after multiple missed scans');
        this.detectedVideos = [];
        onLost();
      }
    }
  }

  /**
   * Retry initial detection at increasing intervals.
   * Meet loads video elements asynchronously after joining a call.
   */
  private retryInitialDetection(onFound: (v: VideoRegion[]) => void, attempt: number) {
    const delays = [300, 800, 1500, 3000, 6000, 10000];
    const videos = this.detectVideos();

    if (videos.length > 0) {
      this.detectedVideos = videos;
      onFound(videos);
      return;
    }

    if (attempt < delays.length) {
      setTimeout(() => {
        this.retryInitialDetection(onFound, attempt + 1);
      }, delays[attempt]);
    }
  }

  private hasVideosChanged(newVideos: VideoRegion[]): boolean {
    if (newVideos.length !== this.detectedVideos.length) return true;

    for (let i = 0; i < newVideos.length; i++) {
      const old = this.detectedVideos[i];
      const nv  = newVideos[i];
      if (
        Math.abs(old.x - nv.x) > 10 ||
        Math.abs(old.y - nv.y) > 10 ||
        Math.abs(old.width - nv.width) > 10 ||
        Math.abs(old.height - nv.height) > 10
      ) return true;
    }
    return false;
  }
}