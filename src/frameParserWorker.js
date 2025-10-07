import { parentPort } from 'worker_threads'

console.log('[Worker] Started')

// Internal buffer to accumulate chunks
let buffer = Buffer.alloc(0)
const boundary = Buffer.from('--myboundary')

// Exit logging
process.on('exit', (code) => {
  console.log(`[Worker] Exiting with code ${code}`)
})

// Catch unexpected errors
process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught Exception:', err)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Worker] Unhandled Rejection:', reason)
  process.exit(1)
})

// Handle incoming messages
parentPort.on('message', (msg) => {
  try {
    if (!msg || typeof msg !== 'object') {
      throw new Error('Invalid message received')
    }

    if (msg.type === 'stop') {
      console.log('[Worker] Stop signal received')
      process.exit(0)
    }

    if (msg.type === 'chunk') {
      const chunk = Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data)

      buffer = Buffer.concat([buffer, chunk])
      parseFrames()
    } else {
      throw new Error(`Unknown message type: ${msg.type}`)
    }
  } catch (err) {
    console.error('[Worker] Message handling error:', err)
    process.exit(1)
  }
})


function parseFrames() {
  try {
    let start = buffer.indexOf(boundary)

    while (start !== -1) {
      const end = buffer.indexOf(boundary, start + boundary.length)
      if (end === -1) break

      const frame = buffer.slice(start, end)
      const contentTypeIndex = frame.indexOf('Content-Type: image/jpeg')

      if (contentTypeIndex !== -1) {
        const jpegStart = frame.indexOf('\r\n\r\n') + 4

        if (jpegStart < 4 || jpegStart >= frame.length) {
          console.warn('[Worker] Invalid JPEG start')
          break // corrupt frame, wait for more data
        }

        const jpegData = Buffer.from(frame.slice(jpegStart)) // safe copy

        parentPort.postMessage({
          timestamp: Date.now(),
          data: jpegData,
        })
      }

      start = end
    }

    buffer = buffer.slice(start)
  } catch (err) {
    console.error('[Worker] Frame parsing error:', err)
    process.exit(1)
  }
}
