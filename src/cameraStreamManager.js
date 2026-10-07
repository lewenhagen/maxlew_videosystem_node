import { performance } from 'perf_hooks'
import { CameraStream } from './camerastream.js'

class CameraStreamManager {
  constructor() {
    // Map of streamName -> CameraStream
    this.cameraStreams = {}
  }

  // ---------------------------------------------------------------------------
  // Stream management
  // ---------------------------------------------------------------------------

  /**
   * Add a new camera stream. If a stream with the same name and URL already
   * exists it is reused. A stream with the same name but a different URL is
   * replaced, so a name never keeps serving the wrong camera.
   *
   * @param {string} cameraName - Unique name/ID for the stream
   * @param {string} url        - MJPEG stream URL
   * @param {number} fps        - Frames per second of the source stream
   * @param {boolean} force     - Replace existing stream if true
   * @returns {CameraStream}
   */
  addCameraStream(cameraName, url, fps = 10, force = false) {
    const existing = this.cameraStreams[cameraName]
    if (existing) {
      if (!force && existing.url === url) {
        console.log(`${cameraName} - Reusing existing stream.`)
        return existing
      }
      console.log(`${cameraName} - Replacing existing stream.`)
      this.stopCameraStream(cameraName)
    }

    const stream = new CameraStream(url, fps, cameraName)
    this.cameraStreams[cameraName] = stream
    console.log(`${cameraName} - Stream started.`)
    return stream
  }

  /**
   * Get or create a stream by URL. Useful when multiple views share the same
   * camera source — only one HTTP connection will be made to the camera.
   *
   * @param {string} url  - MJPEG stream URL (used as the key)
   * @param {number} fps
   * @returns {CameraStream}
   */
  getOrCreateStream(url, fps = 30) {
    // Use the URL as a stable key so the same camera is never fetched twice
    const key = `url::${url}`
    return this.addCameraStream(key, url, fps, false)
  }

  /**
   * Retrieve an active stream by name.
   * @param {string} cameraName
   * @returns {CameraStream | undefined}
   */
  getCameraStream(cameraName) {
    return this.cameraStreams[cameraName]
  }

  /**
   * Stop and remove a stream by name.
   * @param {string} cameraName
   */
  stopCameraStream(cameraName) {
    const stream = this.cameraStreams[cameraName]
    if (stream) {
      try {
        stream.stop()
      } finally {
        // Always remove the reference even if stop() throws
        delete this.cameraStreams[cameraName]
      }
      console.log(`${cameraName} - Stream stopped and removed.`)
    } else {
      console.log(`${cameraName} - No active stream found.`)
    }
  }

  /**
   * Stop all active streams (e.g. on process exit or page navigation).
   */
  stopAllStreams() {
    // Object.keys() gives a snapshot, safe to delete during iteration
    for (const name of Object.keys(this.cameraStreams)) {
      this.stopCameraStream(name)
    }
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /**
   * Returns a health snapshot of all active streams.
   * @returns {Record<string, object>}
   */
  getStreamHealth() {
    const health = {}
    for (const [name, stream] of Object.entries(this.cameraStreams)) {
      health[name] = {
        active: stream.streamActive,
        bufferedFrames: stream.frames.length,
        consumers: stream.consumerCount,
        lastFrameAgeMs: stream._lastFrameAt === null ? null : Math.round(performance.now() - stream._lastFrameAt),
        maxDelaySeconds: stream.maxDelaySeconds,
        url: stream.url,
      }
    }
    return health
  }

  /**
   * List all active stream names.
   * @returns {string[]}
   */
  getStreamNames() {
    return Object.keys(this.cameraStreams)
  }

  /**
   * Return all active stream objects.
   * @returns {Record<string, CameraStream>}
   */
  getAllStreams() {
    return this.cameraStreams
  }
}

export { CameraStreamManager }