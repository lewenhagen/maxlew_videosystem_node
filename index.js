import dotenv from 'dotenv'
import express from 'express'
import { readFile } from 'fs/promises'
import open from 'open'
import { CameraStreamManager } from './src/camerastream.js'
import { URL } from 'url'
import { exec } from 'node:child_process'

dotenv.config()

const config = JSON.parse(
  await readFile('./config/cameras.json', 'utf-8')
)

const streamManager = new CameraStreamManager()
const dualcams = {
  left: {},
  right: {}
}

// const url = 'http://localhost:3000/splashscreen'
const url = 'http://localhost:3000'
const __dirname = new URL('.', import.meta.url).pathname

const app = express()

app.use(express.static(__dirname + '/public'))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.set('view engine', 'ejs')

app.get('/splashscreen', function (req, res) {
  res.render('splashscreen')
})

app.get('/', async function (req, res) {
  for (const stream of streamManager.getStreamNames()) {
    await streamManager.stopCameraStream(stream)
  }

  res.render('index', { config })
})

app.get('/shutdown', function (req, res) {
  let data = {
    secret: Math.floor(Math.random() * (9999 - 1000 + 1)) + 1000
  }
  res.render('shutdown', data)
})

app.post('/shutdown', function (req, res) {
  if (parseInt(req.body.shutdown) === parseInt(req.body.secret)) {
    console.log("Shutting down")
    exec('sudo shutdown -h now')
    process.exit()
    
  } else {
    console.log("Wrong number motherfucker")
  }
  res.redirect('/shutdown')
})

app.get('/singlecam', function (req, res) {
  res.render('single-cam', { config })
})

app.get('/singlecam-quad', function (req, res) {
  res.render('single-cam-quad', { config })
})

app.get('/doublecam', function (req, res) {
  res.render('double-cam', { config })
})

app.get('/selectbox/:cam', function (req, res) {
  const cam = parseInt(req.params.cam) - 1
  const data = {
    chosenCamera: config[cam],
    cam
  }
  res.render('selectbox', data)
})

app.get('/selectbox-quad/:cam', function (req, res) {
  const cam = parseInt(req.params.cam) - 1
  const data = {
    chosenCamera: config[cam],
    cam
  }
  res.render('selectbox-delay-quad', data)
})

app.get('/selectbox-delta-quad', function (req, res) {
  const cam = parseInt(req.query.cam)
  const delay = parseInt(req.query.delay)
  const data = {
    chosenCamera: config[cam],
    cam,
    delay
  }
  res.render('selectbox-delta-quad', data)
})

app.get('/selectbox-delay-dual-left/:left/:right?', function (req, res) {
  const left = req.params.left
  let right = req.params.right
  if (req.params.right === undefined) {
    right = left
  }

  dualcams.left.cam = config[left]
  dualcams.left.url = `http://${dualcams.left.cam.ip}/axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`
  dualcams.right.cam = config[right]
  dualcams.right.url = `http://${dualcams.right.cam.ip}/axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`

  res.render('selectbox-delay-dual-left', dualcams.left)
})

app.post('/selectbox-delay-dual-left/', function (req, res) {
  dualcams.left.delay = req.body.delay
  res.render('selectbox-delay-dual-right', dualcams.right)
})

app.post('/stream-dual', function (req, res) {
  dualcams.right.delay = req.body.delay

  streamManager.addCameraStream('stream1', dualcams.left.url, 30)
  streamManager.addCameraStream('stream2', dualcams.right.url, 30)

  res.render('stream-dual', dualcams)
})

app.get('/selectbox-delay-dual-right/:left/:right?', function (req, res) {
  const left = req.params.left
  let right = req.params.right
  if (req.params.right === undefined) {
    right = left
  }

  const data = {
    left: config[left],
    right: config[right]
  }

  res.render('selectbox-delay-dual-left', data)
})

app.get('/stream', async function (req, res) {
  const ip = config[req.query.cam].ip
  const name = config[req.query.cam].name
  const user = process.env.VS_USER
  const pass = process.env.VS_PASS
  const url = `http://${ip}/axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`
  const data = {
    delay: req.query.delay,
    url,
    name
  }
  streamManager.addCameraStream('stream1', url, 30)

  res.render('stream', data)
})

app.get('/stream-quad', async function (req, res) {
  const ip = config[req.query.cam].ip
  const name = config[req.query.cam].name
  const user = process.env.VS_USER
  const pass = process.env.VS_PASS
  const url = `http://${ip}/axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`
  const data = {
    delay: req.query.delay,
    delta: req.query.delta,
    url,
    name
  }

  streamManager.addCameraStream('stream1', url, 30)
  streamManager.addCameraStream('stream2', url, 30)
  streamManager.addCameraStream('stream3', url, 30)
  streamManager.addCameraStream('stream4', url, 30)

  res.render('stream-quad', data)
})

app.get('/stream/:streamName/:delay', async (req, res) => {
  const streamName = req.params.streamName
  const delay = req.params.delay
  const stream = streamManager.getCameraStream(streamName)

  if (!stream) {
    return res.status(404).send(`Stream for ${streamName} not found.`)
  }

  console.log(`Stream requested for ${streamName}.`)

  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=--myboundary; Cache-Control: no-cache;')

  const delayedFramesGenerator = stream.getDelayedFrames(delay)

  let isClientConnected = true

  req.on('close', () => {
    console.log(`Client disconnected from ${streamName} stream.`)
    isClientConnected = false
  })

  try {
    for await (const frame of delayedFramesGenerator) {
      if (!isClientConnected) break

      res.write('--myboundary\r\n')
      res.write(`Content-Length: ${frame.length}\r\n\r\n`)
      res.write(frame)
      res.write('\r\n')
    }
  } catch (error) {
    console.error(`Error streaming frames for ${streamName}:`, error)
  } finally {
    res.end()
  }
})

// Start server
// app.listen(3000, ExecuteChromium)
app.listen(3000)

// Open browser
await open(url)

// function ExecuteChromium() {
//   exec("chromium --kiosk --disable-restore-session-state --disable-features=TranslateUI --disable-session-crashed-bubble --app=http://localhost:3000", function(error, stdout, stderr) {
//       // console.log("stdout: " + stdout);
//       console.log("stderr: " + stderr);
//       if (error !== null) {
//           console.log("exec errror: " + error);
//       }
//   });
// }
