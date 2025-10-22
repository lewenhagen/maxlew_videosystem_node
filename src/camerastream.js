import fetch from 'node-fetch'
import { Worker, isMainThread, parentPort } from 'worker_threads'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

class CameraStream {
  constructor(url, fps, name) {
    this.aborted = false
    this.frames = []
    this.frameStartIndex = 0
    this.streamActive = false
    this.url = url
    this.fps = fps
    this.name = name
    this.stream = null
    this.worker = null

    this.start()
  }

  async start() {
    if (this.streamActive) return
    this.streamActive = true

    try {
      const response = await fetch(this.url)
      if (!response.ok) {
        console.error(`${this.name} - Failed to fetch stream`)
        this.streamActive = false
        return
      }

      this.stream = response.body
      this.stream.pause() // pause until worker is ready

      this.worker = new Worker(path.resolve(__dirname, 'frameParserWorker.js'), { type: 'module' })

      // Wait until worker is ready
      this.worker.once('online', () => {
        console.log(`${this.name} - Worker online, resuming stream`)
        this.stream.resume()
      })

      this.worker.on('message', (frame) => {
        this.frames.push(frame)
        const maxFrames = this.fps * 200
        const activeFrames = this.frames.length - this.frameStartIndex
        if (activeFrames > maxFrames) {
          this.frames = this.frames.slice(this.frameStartIndex)
          this.frameStartIndex = 0
        }
      })

      this.worker.on('error', (err) => {
        console.error(`${this.name} - Worker error:`, err)
      })

      this.worker.on('exit', (code) => {
        console.log(`${this.name} - Worker exited with code ${code}`)
      })

      this.stream.on('data', (chunk) => {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        // Send the buffer as a transferable to avoid copy overhead
        this.worker.postMessage({ type: 'chunk', data: bufferChunk.buffer }, [bufferChunk.buffer])
      })

      this.stream.on('end', () => {
        console.log(`${this.name} - Stream ended`)
        this.streamActive = false
      })

      this.stream.on('error', (err) => {
        console.error(`${this.name} - Stream error:`, err)
        this.streamActive = false
      })

    } catch (err) {
      console.error(`${this.name} - Stream fetch error:`, err)
      this.streamActive = false
    }
  }

  async *getDelayedFrames(delayInSeconds) {
    const delayMs = delayInSeconds * 1000
    const interval = 1000 / this.fps

    while (!this.aborted) {
      const now = Date.now()
      for (let i = this.frameStartIndex; i < this.frames.length; i++) {
        const frame = this.frames[i]
        if (now - frame.timestamp >= delayMs) {
          this.frameStartIndex = i + 1
          yield frame.data
          break
        }
      }
      await new Promise(resolve => setTimeout(resolve, interval))
    }

    console.log(`${this.name} - Frame generator exited cleanly.`)
  }

  stop() {
    this.aborted = true

    if (this.stream) {
      this.stream.removeAllListeners('data')
      this.stream.removeAllListeners('end')
      this.stream.removeAllListeners('error')
      this.stream.destroy()
      this.stream = null
    }

    if (this.worker) {
      console.log(`${this.name} - Sending stop signal to worker...`)
      this.worker.postMessage({ type: 'stop' })

      setTimeout(() => {
        if (this.worker) {
          this.worker.terminate().then(() => {
            console.log(`${this.name} - Worker forcefully terminated`)
          }).catch((err) => {
            console.error(`${this.name} - Worker termination failed:`, err)
          })
          this.worker = null
        }
      }, 1000)
    }

    this.frames = []
    this.frameStartIndex = 0
    this.streamActive = false
    console.log(`${this.name} - Stream stopped.`)
  }
}

export { CameraStream }
