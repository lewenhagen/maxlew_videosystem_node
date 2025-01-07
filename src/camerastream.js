import fetch from 'node-fetch'
import { setTimeout } from 'timers/promises'

class CameraStream {
  constructor (url, fps, name) {
    this.frames = []
    this.dataBuffer = Buffer.alloc(0)
    this.streamActive = false
    this.url = url
    this.fps = fps
    this.name = name
    this.stream = null

    // Start fetching the camera stream
    this.fetchCameraStream()
  }

  async fetchCameraStream () {
    if (this.streamActive) {
      console.log(`${this.name} - Stream already active.`)
      return
    }

    console.log(`${this.name} - Starting camera stream...`)
    this.streamActive = true

    try {
      const response = await fetch(this.url)
      if (!response.ok) {
        console.error(`${this.name} - Failed to fetch camera stream: ${response.statusText}`)
        this.streamActive = false
        return
      }

      console.log(`${this.name} - Camera stream started`)
      this.stream = response.body
      this.dataBuffer = Buffer.alloc(0)

      this.stream.on('data', (chunk) => {
        this.dataBuffer = Buffer.concat([this.dataBuffer, chunk])
        const { frames: newFrames, unprocessed } = this.extractFrames(this.dataBuffer)
        this.frames = this.frames.concat(newFrames)
        this.dataBuffer = unprocessed

        // Maintain a buffer of up to 200 seconds of frames
        const maxFrames = this.fps * 200
        if (this.frames.length > maxFrames) {
          this.frames.splice(0, this.frames.length - maxFrames)
        }
      })

      this.stream.on('error', (err) => {
        console.error(`${this.name} - Error in stream:`, err)
        this.streamActive = false
      })

      this.stream.on('end', () => {
        console.log(`${this.name} - Stream ended.`)
        this.streamActive = false
      })

      this.stream.on('close', () => {
        console.log(`${this.name} - Stream closed.`)
        this.streamActive = false
      })
    } catch (err) {
      console.error(`${this.name} - Error fetching stream:`, err)
      this.streamActive = false
    }
  }

  extractFrames (theBuffer) {
    const frames = []
    const boundary = Buffer.from('--myboundary')
    let frameStart = this.dataBuffer.indexOf(boundary)

    while (frameStart !== -1) {
      const frameEnd = theBuffer.indexOf(boundary, frameStart + boundary.length)
      if (frameEnd === -1) break

      const frame = theBuffer.slice(frameStart, frameEnd)
      const contentTypeIndex = frame.indexOf('Content-Type: image/jpeg')
      if (contentTypeIndex !== -1) {
        const jpegData = frame.slice(frame.indexOf('\r\n\r\n') + 4)
        frames.push({ timestamp: Date.now(), data: jpegData })
      }

      frameStart = frameEnd
    }

    return { frames, unprocessed: theBuffer.slice(frameStart) }
  }

  async * getDelayedFrames (delayInSeconds) {
    const delayMilliseconds = delayInSeconds * 1000
    const frameInterval = 1000 / this.fps

    while (true) {
      const now = Date.now()

      // Look for a frame older than the desired delay
      const delayedFrameIndex = this.frames.findIndex(
        (frame) => now - frame.timestamp >= delayMilliseconds
      )

      if (delayedFrameIndex >= 0) {
        // const delayedFrame = this.frames[delayedFrameIndex];

        // Remove all frames before the delayed frame to save memory
        this.frames.splice(0, delayedFrameIndex)

        // Yield the delayed frame
        // yield delayedFrame.data;
        yield this.frames.shift().data

        // Wait for the next frame interval to maintain consistent FPS
        await setTimeout(frameInterval)
      } else {
        // If no delayed frame is found, wait briefly and try again
        await setTimeout(frameInterval)
      }
    }
  }

  stopCameraStream () {
    if (this.stream) {
      console.log(`${this.name} - Stopping camera stream...`)
      this.stream.destroy()
      this.stream = null
    }
    this.frames = []
    this.dataBuffer = Buffer.alloc(0) // Clear the data buffer
    this.streamActive = false
    console.log(`${this.name} - Camera stream stopped and state reset.`)
  }
}

// CameraStreamManager to manage multiple camera streams
class CameraStreamManager {
  constructor () {
    this.cameraStreams = {} // Holds the streams for all cameras
  }

  // Initialize and start a stream for a specific camera
  addCameraStream (cameraName, url, fps) {
    if (this.cameraStreams[cameraName]) {
      console.log(`${cameraName} - Stream already exists.`)
      return
    }

    this.cameraStreams[cameraName] = new CameraStream(url, fps, cameraName)
    console.log(`${cameraName} - Camera stream added.`)
  }

  // Fetch the camera stream from the global cameraStreams object
  getCameraStream (cameraName) {
    return this.cameraStreams[cameraName]
  }

  // Stop the camera stream for a specific camera
  async stopCameraStream (cameraName) {
    if (this.cameraStreams[cameraName]) {
      this.cameraStreams[cameraName].stopCameraStream()
      delete this.cameraStreams[cameraName]
      console.log(`${cameraName} - Camera stream stopped.`)
    } else {
      console.log(`${cameraName} - Stream not found.`)
    }
  }

  // Get all streams available in the manager
  getAllStreams () {
    return this.cameraStreams
  }

  getStreamNames () {
    const result = []
    for (const stream in this.cameraStreams) {
      result.push(stream)
    }

    return result
  }
}

export { CameraStreamManager }
