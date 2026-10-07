import fetch from 'node-fetch'
import { Worker } from 'worker_threads'
import { performance } from 'perf_hooks'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// No data from the camera for this long (also while connecting) = connection is dead
const STALL_TIMEOUT_MS = 10000
const STALL_CHECK_INTERVAL_MS = 2000

// Reconnect backoff: 0.5s, 1s, 2s, 4s, then 5s
const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 5000

// Extra history kept on top of the longest delay
const BUFFER_MARGIN_SECONDS = 15

// If the buffer is no older than the requested delay plus this, a new consumer
// starts at the oldest frame instead of skipping ahead
const START_GRACE_MS = 2000

const noop = () => {}

class CameraStream {
  constructor (url, fps, name) {
    this.url = url
    this.fps = fps
    this.name = name

    this.aborted = false
    this.streamActive = false

    // Frames are { seq, timestamp, data }. seq increases by one per frame and
    // timestamps use a monotonic clock, so neither wall-clock changes nor
    // frames arriving in the same network chunk can cause frames to be skipped.
    this.frames = []
    this._nextSeq = 0
    this._lastFrameAt = null

    // delaySeconds -> number of connected consumers using that delay
    this._consumers = new Map()

    // Longest delay requested during this stream's lifetime. The buffer is
    // never trimmed below it, so a consumer that reconnects still finds its history.
    this._peakDelaySeconds = 0

    this._conn = null
    this._retries = 0
    this._reconnectTimer = null

    this._gcInterval = setInterval(() => this._garbageCollect(), 5000)

    this.start()
  }

  // ---------------------------------------------------------------------------
  // Consumer registration
  // ---------------------------------------------------------------------------

  addConsumer (delaySeconds) {
    this._consumers.set(delaySeconds, (this._consumers.get(delaySeconds) || 0) + 1)
    this._peakDelaySeconds = Math.max(this._peakDelaySeconds, delaySeconds)
  }

  removeConsumer (delaySeconds) {
    const count = this._consumers.get(delaySeconds)
    if (count === undefined) return
    if (count <= 1) this._consumers.delete(delaySeconds)
    else this._consumers.set(delaySeconds, count - 1)
  }

  get consumerCount () {
    let total = 0
    for (const count of this._consumers.values()) total += count
    return total
  }

  /**
   * Maximum delay (in seconds) the buffer must be able to serve.
   */
  get maxDelaySeconds () {
    return Math.max(10, this._peakDelaySeconds, ...this._consumers.keys())
  }

  // ---------------------------------------------------------------------------
  // Stream lifecycle
  // ---------------------------------------------------------------------------

  async start () {
    if (this.streamActive || this.aborted) return
    this.streamActive = true

    // Everything belonging to one connection attempt lives in conn, so late
    // events from an old connection can never affect a newer one.
    const conn = {
      closed: false,
      controller: new AbortController(),
      stream: null,
      worker: null,
      watchdog: null,
      lastActivity: performance.now(),
      gotData: false
    }
    this._conn = conn

    // Detects both a camera that never answers and a stream that goes silent
    conn.watchdog = setInterval(() => {
      if (performance.now() - conn.lastActivity > STALL_TIMEOUT_MS) {
        this._connectionLost(conn, `no data for ${STALL_TIMEOUT_MS / 1000}s`)
      }
    }, STALL_CHECK_INTERVAL_MS)

    try {
      const response = await fetch(this.url, { signal: conn.controller.signal })
      if (conn.closed) return // stopped or timed out while connecting

      if (!response.ok) {
        this._connectionLost(conn, `HTTP ${response.status}`)
        return
      }

      conn.stream = response.body
      conn.stream.on('error', (err) => this._connectionLost(conn, err))
      conn.stream.on('end', () => this._connectionLost(conn, 'stream ended'))
      conn.stream.on('close', () => this._connectionLost(conn, 'stream closed'))

      conn.worker = new Worker(path.resolve(__dirname, 'frameParserWorker.js'), { type: 'module' })
      conn.worker.on('error', (err) => this._connectionLost(conn, err))
      conn.worker.on('exit', (code) => this._connectionLost(conn, `worker exited with code ${code}`))
      conn.worker.on('message', (frame) => {
        if (conn.closed) return
        this._lastFrameAt = performance.now()
        this.frames.push({
          seq: this._nextSeq++,
          timestamp: frame.timestamp,
          data: Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
        })
      })

      // Attached last: flowing starts here and the worker queues messages until it is up
      conn.stream.on('data', (chunk) => {
        if (conn.closed) return
        const timestamp = performance.now() // stamp at network arrival, not after parsing
        conn.lastActivity = timestamp
        if (!conn.gotData) {
          conn.gotData = true
          this._retries = 0
          console.log(`${this.name} - Receiving data`)
        }

        // Copy exactly this chunk: chunk.buffer can be larger than the chunk
        // (pooled memory) and must not be transferred as a whole.
        const data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
        conn.worker.postMessage({ type: 'chunk', data, timestamp }, [data])
      })
    } catch (err) {
      this._connectionLost(conn, err)
    }
  }

  /**
   * Called for every kind of connection failure (HTTP error, end of stream,
   * socket error, stalled stream, worker crash). Only the first call for a
   * given connection does anything.
   */
  _connectionLost (conn, reason) {
    if (conn.closed) return
    this._closeConnection(conn)

    if (this._conn === conn) {
      this._conn = null
      this.streamActive = false
    }
    if (this.aborted) return

    console.error(`${this.name} - Connection lost: ${reason instanceof Error ? reason.message : reason}`)
    this._scheduleReconnect()
  }

  _closeConnection (conn) {
    conn.closed = true
    clearInterval(conn.watchdog)

    if (conn.stream) {
      // Keep a no-op error handler: a late error on a destroyed stream must not crash the process
      conn.stream.removeAllListeners()
      conn.stream.on('error', noop)
      conn.stream.destroy()
      conn.stream = null
    }

    conn.controller.abort()

    if (conn.worker) {
      conn.worker.removeAllListeners()
      conn.worker.on('error', noop)
      conn.worker.terminate().catch((err) => {
        console.error(`${this.name} - Worker termination failed:`, err)
      })
      conn.worker = null
    }
  }

  _scheduleReconnect () {
    if (this._reconnectTimer || this.aborted) return
    const delayMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this._retries)
    this._retries++
    console.log(`${this.name} - Reconnecting in ${delayMs / 1000}s...`)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this.start()
    }, delayMs)
  }

  // ---------------------------------------------------------------------------
  // Frame delivery
  // ---------------------------------------------------------------------------

  /**
   * Async generator that yields frames with the given delay applied.
   * Each consumer tracks its own position (by frame sequence number) in the
   * shared buffer, so consumers with different delays can read the same buffer.
   *
   * @param {number} delayInSeconds
   * @param {AbortSignal} [signal] - ends the generator promptly, also when no frames arrive
   */
  async * getDelayedFrames (delayInSeconds, signal) {
    const delayMs = delayInSeconds * 1000
    const interval = 1000 / this.fps

    this.addConsumer(delayInSeconds)

    let nextSeq = null

    try {
      while (!this.aborted && !signal?.aborted) {
        if (nextSeq === null) nextSeq = this._startSeq(delayMs)

        for (;;) {
          const frames = this.frames
          if (frames.length === 0 || nextSeq === null) break

          // Frames are consecutive, so the position of a frame follows from its seq
          let index = nextSeq - frames[0].seq
          if (index < 0) {
            // Frames before nextSeq were trimmed: continue with the oldest available
            index = 0
          }
          if (index >= frames.length) break

          const frame = frames[index]
          if (performance.now() - frame.timestamp < delayMs) break // not old enough yet

          nextSeq = frame.seq + 1
          yield frame.data
          if (this.aborted || signal?.aborted) return
        }

        await new Promise(resolve => setTimeout(resolve, interval))
      }
    } finally {
      this.removeConsumer(delayInSeconds)
      console.log(`${this.name} - Consumer with delay ${delayInSeconds}s disconnected.`)
    }
  }

  /**
   * Sequence number a new consumer should start at: the frame that is exactly
   * `delayMs` old, or the oldest buffered frame when the buffer is not much
   * older than the delay. Returns null while the buffer is empty.
   */
  _startSeq (delayMs) {
    const frames = this.frames
    if (frames.length === 0) return null

    const now = performance.now()
    if (now - frames[0].timestamp < delayMs + START_GRACE_MS) return frames[0].seq

    for (let i = frames.length - 1; i >= 0; i--) {
      if (now - frames[i].timestamp >= delayMs) return frames[i].seq
    }
    return frames[0].seq
  }

  // ---------------------------------------------------------------------------
  // Buffer garbage collection
  // ---------------------------------------------------------------------------

  /**
   * Periodically trims frames from the front of the buffer that are older
   * than the longest delay + a safety margin.
   */
  _garbageCollect () {
    if (this.frames.length === 0) return

    const cutoff = performance.now() - (this.maxDelaySeconds + BUFFER_MARGIN_SECONDS) * 1000

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

  stop () {
    this.aborted = true

    clearInterval(this._gcInterval)
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null

    if (this._conn) {
      const conn = this._conn
      this._conn = null
      this._closeConnection(conn)
    }

    this.frames = []
    this.streamActive = false
    this._consumers.clear()
    console.log(`${this.name} - Stream stopped.`)
  }
}

export { CameraStream }
