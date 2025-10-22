import { CameraStream } from './camerastream.js'

class CameraStreamManager {
  constructor() {
    this.cameraStreams = {} 
  }

  /**
   * Lägg till en ny kamera-stream
   * @param {string} cameraName - Namn/ID på kameran
   * @param {string} url - MJPEG-ström (URL)
   * @param {number} fps - Antal bilder per sekund (för delay-sync)
   */
  addCameraStream(cameraName, url, fps = 10, force = false) {
    if (this.cameraStreams[cameraName]) {
        if (!force) {
        console.log(`${cameraName} - Stream already exists.`)
        return
        }

        console.log(`${cameraName} - Replacing existing stream.`)
        this.stopCameraStream(cameraName)
    }

    const stream = new CameraStream(url, fps, cameraName)
    this.cameraStreams[cameraName] = stream
    console.log(`${cameraName} - Stream started.`)
    }


  /**
   * Hämta en aktiv kamera-stream
   * @param {string} cameraName
   * @returns {CameraStream | undefined}
   */
  getCameraStream(cameraName) {
    return this.cameraStreams[cameraName]
  }

  /**
   * Stoppa och ta bort en kamera-stream
   * @param {string} cameraName
   */
  stopCameraStream(cameraName) {
    const stream = this.cameraStreams[cameraName]
    if (stream) {
      stream.stop()
      delete this.cameraStreams[cameraName]
      console.log(`${cameraName} - Stream stopped and removed.`)
    } else {
      console.log(`${cameraName} - No active stream found.`)
    }
  }

  /**
   * Stoppa alla kamera-streams (t.ex. vid avslut)
   */
  stopAllStreams() {
    for (const name of Object.keys(this.cameraStreams)) {
      this.stopCameraStream(name)
    }
  }

  /**
   * Lista alla aktiva kameror
   * @returns {string[]}
   */
  getStreamNames() {
    return Object.keys(this.cameraStreams)
  }

  /**
   * Returnera alla aktiva stream-objekt
   * @returns {Record<string, CameraStream>}
   */
  getAllStreams() {
    return this.cameraStreams
  }
}

export { CameraStreamManager }
