import fetch from 'node-fetch'
import { Worker } from 'worker_threads'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

class CameraStream {
  constructor(url, fps, name) {
    this.frames = []
    this.frameStartIndex = 0 // ⬅️ Ny pekare för effektiv "queue"
    this.streamActive = false
    this.url = url
    this.fps = fps
    this.name = name
    this.stream = null

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
      this.worker = new Worker(path.join(__dirname, 'frameParserWorker.js'))

      this.worker.on('message', (frame) => {
        this.frames.push(frame)

        // Max antal frames att behålla
        const maxFrames = this.fps * 200
        const activeFrames = this.frames.length - this.frameStartIndex

        if (activeFrames > maxFrames) {
          // Trimma arrayen fysiskt bara ibland
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
        this.worker.postMessage({ type: 'chunk', data: chunk })
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

    while (true) {
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
  }

  stop() {
    if (this.stream) {
      this.stream.destroy()
      this.stream = null
    }

    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }

    this.frames = []
    this.frameStartIndex = 0
    this.streamActive = false
    console.log(`${this.name} - Stream stopped.`)
  }
}

export { CameraStream }
