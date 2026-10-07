import { parentPort } from 'worker_threads'

console.log('[Worker] Started')

const boundary = Buffer.from('--myboundary')
const headerEnd = Buffer.from('\r\n\r\n')

// Anything bigger than this is treated as corruption rather than a frame
const MAX_FRAME_BYTES = 16 * 1024 * 1024

// Internal buffer to accumulate chunks. It always starts at (or before) a boundary.
let buffer = Buffer.alloc(0)

// Exit logging
process.on('exit', (code) => {
  console.log(`[Worker] Exiting with code ${code}`)
})

// Catch unexpected errors. The main thread notices the exit and reconnects.
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
  if (!msg || typeof msg !== 'object') {
    console.error('[Worker] Invalid message received')
    return
  }

  if (msg.type === 'stop') {
    console.log('[Worker] Stop signal received')
    process.exit(0)
  }

  if (msg.type !== 'chunk') {
    console.error(`[Worker] Unknown message type: ${msg.type}`)
    return
  }

  try {
    const chunk = Buffer.from(msg.data)
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    parseFrames(msg.timestamp)
  } catch (err) {
    // A parse problem must never kill the stream: drop what we have and
    // resynchronise on the next boundary.
    console.error('[Worker] Frame parsing error:', err)
    buffer = Buffer.alloc(0)
  }
})

function emitFrame (jpeg, timestamp) {
  // Own, exactly sized ArrayBuffer so it can be transferred without copying again
  const out = new Uint8Array(jpeg.length)
  out.set(jpeg)
  parentPort.postMessage({ timestamp, data: out }, [out.buffer])
}

function parseHeaders (text) {
  const lengthMatch = /^content-length:\s*(\d+)/im.exec(text)
  return {
    contentLength: lengthMatch ? parseInt(lengthMatch[1], 10) : null,
    isJpeg: /^content-type:\s*image\/jpeg/im.test(text)
  }
}

/**
 * Extracts every complete multipart part from the buffer. When the camera
 * sends Content-Length the exact number of bytes is used, so a frame is emitted
 * as soon as it has fully arrived and contains no multipart padding. Without
 * Content-Length it falls back to scanning for the next boundary.
 */
function parseFrames (timestamp) {
  for (;;) {
    const start = buffer.indexOf(boundary)

    if (start === -1) {
      // Keep a possible partial boundary at the end, discard the rest
      const keep = boundary.length - 1
      if (buffer.length > keep) buffer = buffer.subarray(buffer.length - keep)
      return
    }

    const headerStart = start + boundary.length
    const headerStop = buffer.indexOf(headerEnd, headerStart)

    if (headerStop === -1) {
      buffer = buffer.subarray(start)
      if (buffer.length > MAX_FRAME_BYTES) buffer = Buffer.alloc(0)
      return // wait for the rest of the headers
    }

    const { contentLength, isJpeg } = parseHeaders(
      buffer.toString('latin1', headerStart, headerStop)
    )
    const dataStart = headerStop + headerEnd.length

    let dataEnd
    let next // where to continue parsing from

    if (contentLength !== null) {
      if (contentLength > MAX_FRAME_BYTES) {
        console.warn('[Worker] Implausible Content-Length, resynchronising')
        buffer = buffer.subarray(headerStart)
        continue
      }
      dataEnd = dataStart + contentLength
      if (buffer.length < dataEnd) {
        buffer = buffer.subarray(start)
        return // frame not fully received yet
      }
      next = dataEnd
    } else {
      const nextBoundary = buffer.indexOf(boundary, dataStart)
      if (nextBoundary === -1) {
        buffer = buffer.subarray(start)
        if (buffer.length > MAX_FRAME_BYTES) buffer = Buffer.alloc(0)
        return
      }
      dataEnd = nextBoundary
      // The part is terminated by CRLF before the next boundary
      if (dataEnd >= 2 && buffer[dataEnd - 2] === 0x0d && buffer[dataEnd - 1] === 0x0a) {
        dataEnd -= 2
      }
      next = nextBoundary
    }

    const jpeg = buffer.subarray(dataStart, dataEnd)
    const looksLikeJpeg = jpeg.length > 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8

    if (isJpeg && looksLikeJpeg) {
      emitFrame(jpeg, timestamp)
      buffer = buffer.subarray(next)
    } else if (isJpeg) {
      // Headers said JPEG but the data is not: skip only the boundary so we resync
      console.warn('[Worker] Corrupt frame skipped')
      buffer = buffer.subarray(headerStart)
    } else {
      buffer = buffer.subarray(next)
    }
  }
}
