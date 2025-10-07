import { parentPort } from 'worker_threads'

let buffer = Buffer.alloc(0)
const boundary = Buffer.from('--myboundary')

parentPort.on('message', ({ type, data }) => {
  if (type === 'chunk') {
    buffer = Buffer.concat([buffer, data])
    parseFrames()
  }
})

function parseFrames() {
  let start = buffer.indexOf(boundary)

  while (start !== -1) {
    const end = buffer.indexOf(boundary, start + boundary.length)
    if (end === -1) break

    const frame = buffer.slice(start, end)
    const contentIndex = frame.indexOf('Content-Type: image/jpeg')

    if (contentIndex !== -1) {
      const jpegStart = frame.indexOf('\r\n\r\n') + 4
      const jpegData = frame.slice(jpegStart)

      parentPort.postMessage({
        timestamp: Date.now(),
        data: jpegData,
      })
    }

    start = end
  }

  buffer = buffer.slice(start)
}
