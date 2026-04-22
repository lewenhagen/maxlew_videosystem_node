// import fetch from 'node-fetch'
// import { Worker, isMainThread, parentPort } from 'worker_threads'
// import path from 'path'
// import { fileURLToPath } from 'url'

// const __filename = fileURLToPath(import.meta.url)
// const __dirname = path.dirname(__filename)

// class CameraStream {
//   constructor(url, fps, name) {
//     this.aborted = false
//     this.frames = []
//     this.frameStartIndex = 0
//     this.streamActive = false
//     this.url = url
//     this.fps = fps
//     this.name = name
//     this.stream = null
//     this.worker = null

//     this.start()
//   }

//   async start() {
//     if (this.streamActive) return
//     this.streamActive = true

//     try {
//       const response = await fetch(this.url)
//       if (!response.ok) {
//         console.error(`${this.name} - Failed to fetch stream`)
//         this.streamActive = false
//         return
//       }

//       this.stream = response.body
//       this.stream.pause() // pause until worker is ready

//       this.worker = new Worker(path.resolve(__dirname, 'frameParserWorker.js'), { type: 'module' })

//       // Wait until worker is ready
//       this.worker.once('online', () => {
//         console.log(`${this.name} - Worker online, resuming stream`)
//         this.stream.resume()
//       })

//       this.worker.on('message', (frame) => {
//         this.frames.push(frame)
//         const maxFrames = this.fps * 200
//         const activeFrames = this.frames.length - this.frameStartIndex
//         if (activeFrames > maxFrames) {
//           this.frames = this.frames.slice(this.frameStartIndex)
//           this.frameStartIndex = 0
//         }
//       })

//       this.worker.on('error', (err) => {
//         console.error(`${this.name} - Worker error:`, err)
//       })

//       this.worker.on('exit', (code) => {
//         console.log(`${this.name} - Worker exited with code ${code}`)
//       })

//       this.stream.on('data', (chunk) => {
//         const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
//         // Send the buffer as a transferable to avoid copy overhead
//         this.worker.postMessage({ type: 'chunk', data: bufferChunk.buffer }, [bufferChunk.buffer])
//       })

//       this.stream.on('end', () => {
//         console.log(`${this.name} - Stream ended`)
//         this.streamActive = false
//       })

//       this.stream.on('error', (err) => {
//         console.error(`${this.name} - Stream error:`, err)
//         this.streamActive = false
//       })

//     } catch (err) {
//       console.error(`${this.name} - Stream fetch error:`, err)
//       this.streamActive = false
//     }
//   }

//   async *getDelayedFrames(delayInSeconds) {
//     const delayMs = delayInSeconds * 1000
//     const interval = 1000 / this.fps

//     while (!this.aborted) {
//       const now = Date.now()
//       for (let i = this.frameStartIndex; i < this.frames.length; i++) {
//         const frame = this.frames[i]
//         if (now - frame.timestamp >= delayMs) {
//           this.frameStartIndex = i + 1
//           yield frame.data
//           break
//         }
//       }
//       await new Promise(resolve => setTimeout(resolve, interval))
//     }

//     console.log(`${this.name} - Frame generator exited cleanly.`)
//   }

//   stop() {
//     this.aborted = true

//     if (this.stream) {
//       this.stream.removeAllListeners('data')
//       this.stream.removeAllListeners('end')
//       this.stream.removeAllListeners('error')
//       this.stream.destroy()
//       this.stream = null
//     }

//     if (this.worker) {
//       console.log(`${this.name} - Sending stop signal to worker...`)
//       this.worker.postMessage({ type: 'stop' })

//       setTimeout(() => {
//         if (this.worker) {
//           this.worker.terminate().then(() => {
//             console.log(`${this.name} - Worker forcefully terminated`)
//           }).catch((err) => {
//             console.error(`${this.name} - Worker termination failed:`, err)
//           })
//           this.worker = null
//         }
//       }, 1000)
//     }

//     this.frames = []
//     this.frameStartIndex = 0
//     this.streamActive = false
//     console.log(`${this.name} - Stream stopped.`)
//   }
// }

// export { CameraStream }
import fetch from 'node-fetch'
import { Worker } from 'worker_threads'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

class CameraStream {
  constructor(url, fps, name) {
    this.url = url
    this.fps = fps
    this.name = name

    this.aborted = false
    this.streamActive = false
    this.frames = []

    // Tracks the minimum frame index still needed by any consumer.
    // Updated periodically to allow garbage collection of old frames.
    this._minConsumerIndex = 0

    // Set of active consumer delay values (in seconds), used to calculate
    // how many frames need to be retained in the buffer.
    this._consumers = new Set()

    this.stream = null
    this.worker = null

    this._gcInterval = setInterval(() => this._garbageCollect(), 5000)

    this.start()
  }

  // ---------------------------------------------------------------------------
  // Consumer registration
  // ---------------------------------------------------------------------------

  /**
   * Register a consumer with a given delay.
   * This informs the buffer how far back it needs to retain frames.
   * @param {number} delaySeconds
   */
  addConsumer(delaySeconds) {
    this._consumers.add(delaySeconds)
  }

  /**
   * Unregister a consumer when it disconnects.
   * @param {number} delaySeconds
   */
  removeConsumer(delaySeconds) {
    this._consumers.delete(delaySeconds)
  }

  /**
   * Returns the maximum delay (in seconds) across all registered consumers.
   * Used to determine how much history the buffer must retain.
   */
  get maxDelaySeconds() {
    if (this._consumers.size === 0) return 10
    return Math.max(...this._consumers)
  }

  // ---------------------------------------------------------------------------
  // Stream lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    if (this.streamActive) return
    this.streamActive = true

    try {
      const response = await fetch(this.url)
      if (!response.ok) {
        console.error(`${this.name} - Failed to fetch stream: ${response.status}`)
        this.streamActive = false
        this._scheduleReconnect()
        return
      }

      this.stream = response.body
      this.stream.pause()

      this.worker = new Worker(path.resolve(__dirname, 'frameParserWorker.js'), { type: 'module' })

      this.worker.once('online', () => {
        console.log(`${this.name} - Worker online, resuming stream`)
        this.stream.resume()
      })

      this.worker.on('message', (frame) => {
        this.frames.push(frame)
      })

      this.worker.on('error', (err) => {
        console.error(`${this.name} - Worker error:`, err)
      })

      this.worker.on('exit', (code) => {
        console.log(`${this.name} - Worker exited with code ${code}`)
      })

      this.stream.on('data', (chunk) => {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const timestamp = Date.now() // stamp at network arrival, not after parsing
        this.worker.postMessage(
          { type: 'chunk', data: bufferChunk.buffer, timestamp },
          [bufferChunk.buffer]
        )
      })

      this.stream.on('end', () => {
        console.log(`${this.name} - Stream ended`)
        this.streamActive = false
        if (!this.aborted) this._scheduleReconnect()
      })

      this.stream.on('error', (err) => {
        console.error(`${this.name} - Stream error:`, err)
        this.streamActive = false
        if (!this.aborted) this._scheduleReconnect()
      })

    } catch (err) {
      console.error(`${this.name} - Stream fetch error:`, err)
      this.streamActive = false
      if (!this.aborted) this._scheduleReconnect()
    }
  }

  _scheduleReconnect(delayMs = 5000) {
    console.log(`${this.name} - Reconnecting in ${delayMs / 1000}s...`)
    setTimeout(() => {
      if (!this.aborted) this.start()
    }, delayMs)
  }

  // ---------------------------------------------------------------------------
  // Frame delivery
  // ---------------------------------------------------------------------------

  /**
   * Async generator that yields frames with the given delay applied.
   * Each consumer gets its own local index into the shared frames array,
   * so multiple consumers with different delays can read from the same buffer.
   *
   * @param {number} delayInSeconds
   */
  // async *getDelayedFrames(delayInSeconds) {
  //   const delayMs = delayInSeconds * 1000
  //   const interval = 1000 / this.fps

  //   this.addConsumer(delayInSeconds)

  //   // Start from the current end of the buffer so we don't replay old frames
  //   let localIndex = this.frames.length

  //   try {
  //     while (!this.aborted) {
  //       const now = Date.now()
  //       let yielded = false

  //       for (let i = localIndex; i < this.frames.length; i++) {
  //         if (now - this.frames[i].timestamp >= delayMs) {
  //           localIndex = i + 1
  //           yield this.frames[i].data
  //           yielded = true
  //           break
  //         }
  //       }

  //       if (!yielded) {
  //         await new Promise(resolve => setTimeout(resolve, interval))
  //       }
  //     }
  //   } finally {
  //     // Always unregister consumer, even if generator is aborted mid-stream
  //     this.removeConsumer(delayInSeconds)
  //     console.log(`${this.name} - Consumer with delay ${delayInSeconds}s disconnected.`)
  //   }
  // }
  async *getDelayedFrames(delayInSeconds) {
  const delayMs = delayInSeconds * 1000
  const interval = 1000 / this.fps

  this.addConsumer(delayInSeconds)

  // Track position by timestamp, not index — GC-safe
  let lastYieldedTimestamp = 0

  try {
    while (!this.aborted) {
      const now = Date.now()
      let yielded = false

      for (let i = 0; i < this.frames.length; i++) {
        const frame = this.frames[i]

        // Skip frames we've already yielded
        if (frame.timestamp <= lastYieldedTimestamp) continue

        // Skip frames that aren't old enough yet
        if (now - frame.timestamp < delayMs) break

        lastYieldedTimestamp = frame.timestamp
        yield frame.data
        yielded = true
      }

      if (!yielded) {
        await new Promise(resolve => setTimeout(resolve, interval))
      }
    }
  } finally {
    this.removeConsumer(delayInSeconds)
    console.log(`${this.name} - Consumer with delay ${delayInSeconds}s disconnected.`)
  }
}

  // ---------------------------------------------------------------------------
  // Buffer garbage collection
  // ---------------------------------------------------------------------------

  /**
   * Periodically trims frames from the front of the buffer that are older
   * than the longest active consumer delay + a small safety margin.
   */
  _garbageCollect() {
    if (this.frames.length === 0) return

    const maxRetainMs = (this.maxDelaySeconds + 15) * 1000  // generous margin
    const cutoff = Date.now() - maxRetainMs

    let trimIndex = 0
    while (trimIndex < this.frames.length && this.frames[trimIndex].timestamp < cutoff) {
      trimIndex++
    }

    if (trimIndex > 0) {
      this.frames = this.frames.slice(trimIndex)
      console.log(`${this.name} - GC: trimmed ${trimIndex} frames, buffer size: ${this.frames.length}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  stop() {
    this.aborted = true

    clearInterval(this._gcInterval)

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
          this.worker.terminate()
            .then(() => console.log(`${this.name} - Worker terminated`))
            .catch(err => console.error(`${this.name} - Worker termination failed:`, err))
          this.worker = null
        }
      }, 1000)
    }

    this.frames = []
    this.streamActive = false
    this._consumers.clear()
    console.log(`${this.name} - Stream stopped.`)
  }
}

export { CameraStream }