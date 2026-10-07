import dotenv from 'dotenv'
import express from 'express'
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { readFile, writeFile, rename } from 'fs/promises'
import open from 'open'
import { CameraStreamManager } from './src/cameraStreamManager.js'
import { URL } from 'url'
import { exec } from 'node:child_process'
import { checkValidity, testCode } from './src/licensecheck.js'


dotenv.config()

async function loadCamerasConfig() {
  try {
    const data = await readFile('./config/cameras.json', 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File does not exist — create default
      const defaultData = [];
      await writeFile('./config/cameras.json', JSON.stringify(defaultData, null, 2));
      console.log('[INFO] cameras.json not found, created default file.');
      return defaultData;
    } else {
      // Other errors — rethrow
      throw err;
    }
  }
}

let config = await loadCamerasConfig()

// ---------------------------------------------------------------------------
// Camera list (config/cameras.json) editing
// ---------------------------------------------------------------------------
const CAMERAS_FILE = './config/cameras.json'

// Re-reads the file so edits made outside the app (maxlew.sh) are picked up.
// A broken file keeps the previous list instead of taking the pages down.
async function reloadCameras () {
  try {
    const list = await loadCamerasConfig()
    if (!Array.isArray(list)) throw new Error('cameras.json is not a list')
    config = list
  } catch (err) {
    console.error('[ERROR] Could not read cameras.json, keeping the previous list:', err.message)
  }
  return config
}

// Writes the whole file to a temporary name first so a power cut cannot leave half a file
async function saveCameras (list) {
  const tmp = `${CAMERAS_FILE}.tmp`
  await writeFile(tmp, JSON.stringify(list, null, 2) + '\n')
  await rename(tmp, CAMERAS_FILE)
  config = list
}

// Read-modify-write cycles run one at a time
let cameraLock = Promise.resolve()
function withCameraLock (fn) {
  const run = cameraLock.then(fn)
  cameraLock = run.catch(() => {})
  return run
}

// Returns { camera } with cleaned values or { error } with a message to show
function validateCamera (body) {
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ')
  const ip = String(body.ip ?? '').trim()

  if (!name) return { error: 'Namn saknas.' }
  if (name.length > 40) return { error: 'Namnet är för långt (max 40 tecken).' }

  const octets = ip.split('.')
  const validIp = octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  if (!validIp) return { error: 'Ogiltig IP-adress (t.ex. 192.168.0.10).' }

  // Numbers only, so a typed leading zero can never be read as octal
  return { camera: { name, ip: octets.map(Number).join('.') } }
}

// Index from a URL parameter, or -1 if there is no such camera
function cameraIndex (param, list) {
  const i = Number.parseInt(param, 10)
  return String(i) === param && i >= 0 && i < list.length ? i : -1
}

const LOCAL_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
function requireLocal (req, res, next) {
  if (!LOCAL_IPS.includes(req.ip)) return res.status(403).send('Forbidden')
  next()
}

// Express 4 does not catch errors from async handlers by itself
function asyncRoute (fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

let tries = 3

// A bad request or a stray error must never take the kiosk down
process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[ERROR] Uncaught exception:', err)
})

// Longest delay the server will buffer for (the pages themselves cap at 36s)
const MAX_DELAY_SECONDS = 60

// Returns the camera for a query/param index, or null if it does not exist
function getCamera (index) {
  const i = Number.parseInt(index, 10)
  return Number.isInteger(i) && i >= 0 && i < config.length ? config[i] : null
}

// Resolves when the response can take more data, or when the client is gone
function waitForDrain (res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

const streamManager = new CameraStreamManager()
const dualcams = {
  left: {},
  right: {}
}

// const url = 'http://localhost:3000/splashscreen'
// const url = 'http://localhost:3000'
// const __dirname = new URL('.', import.meta.url).pathname

const app = express()

app.use(express.static(path.join(__dirname, 'public')));
// app.use(express.static(__dirname + '/public'))
// app.use(express.static(path.resolve('./public')));

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.set('view engine', 'ejs')

async function checkLicense (req, res, next) {
  if (await checkValidity()) {
    next()
  } else {
    res.render("license-expired", {message: "Er licens har gått ut tyvärr."})
  }
}

app.post("/checkcode", async function (req, res) {
  let enteredCode = req.body.code
  let validCheck = await testCode(enteredCode)

  if (validCheck) {
    console.log("correct code")
    res.redirect('/')
  } else {
    console.log("incorrect code")
    res.render('license-expired', {message: "Fel kod."})
  }
  
})

app.get('/splashscreen', function (req, res) {
  res.setHeader('Content-Language', 'sv')
  res.render('splashscreen')
})

app.get('/', checkLicense, async function (req, res) {
  for (const stream of streamManager.getStreamNames()) {
    await streamManager.stopCameraStream(stream)
  }
  await reloadCameras()
  res.setHeader('Content-Language', 'sv')
  res.render('index', { config })
})

app.get('/shutdown', function (req, res) {
  let data = {
    secret: Math.floor(Math.random() * (9999 - 1000 + 1)) + 1000
  }
  res.render('shutdown', data)
})

// app.post("/shutdown", async (req, res) => {
//   if (req.ip !== '127.0.0.1' && req.ip !== '::1') {
//     return res.status(403).send("Forbidden");
//   }
//   if (parseInt(req.body.shutdown) === parseInt(req.body.secret)) {
//     exec("sudo ./shutdown-system.sh", (error) => {
//       if (error) {
//         console.error("Shutdown failed:", error);
//         return res.status(500).send("Failed to shut down");
//       }
//       res.send("Shutting down...");
//     })
//   } else {
//     console.log("Wrong number")
//   }
// })
// app.post("/shutdown", (req, res) => {
//   const { shutdown, secret } = req.body;
//   if (req.ip !== '127.0.0.1' && req.ip !== '::1') {
//     res.send("Forbidden")
//   }
//   if (parseInt(shutdown) === parseInt(secret)) {
//     res.send("<h1>Shutting down system...</h1>");

//     // Wait a moment so response completes before poweroff
//     setTimeout(() => {
//       exec("sudo /bin/systemctl poweroff", (error) => {
//         if (error) console.error("Shutdown failed:", error);
//       });
//     }, 1000);
//   } else {
//     console.log("Wrong number");
//     res.redirect("/shutdown")
//   }
// });
app.post("/shutdown", (req, res) => {
  const { shutdown, secret } = req.body;

  // Bug 1: missing return — falls through to shutdown logic even when forbidden
  const localIPs = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
  if (!localIPs.includes(req.ip)) {
    return res.status(403).send("Forbidden")
  }

  if (parseInt(shutdown) === parseInt(secret)) {
    res.send("<h1>Shutting down system...</h1>");

    setTimeout(() => {
      exec("sudo /bin/systemctl poweroff", (error) => {
        if (error) console.error("Shutdown failed:", error);
      });
    }, 1000);
  } else {
    // Bug 2: missing return — if somehow both branches run, res.redirect after res.send crashes
    console.log("Wrong number");
    return res.redirect("/shutdown")
  }
});

// ---------------------------------------------------------------------------
// Admin: add / edit / remove cameras (this machine only)
// ---------------------------------------------------------------------------
const ADMIN_MESSAGES = new Map([
  ['added', 'Kameran är tillagd.'],
  ['edited', 'Kameran är sparad.'],
  ['removed', 'Kameran är borttagen.']
])

app.use('/admin', requireLocal)

app.get('/admin', asyncRoute(async (req, res) => {
  const cameras = await reloadCameras()
  const last = Math.max(cameras.length - 1, 0)
  const selected = Math.min(Math.max(Number.parseInt(req.query.sel, 10) || 0, 0), last)
  res.render('admin', {
    cameras,
    selected,
    message: ADMIN_MESSAGES.get(req.query.msg) || null
  })
}))

app.get('/admin/add', (req, res) => {
  res.render('admin-edit', { mode: 'add', id: null, camera: { name: '', ip: '' }, error: null })
})

app.post('/admin/add', asyncRoute(async (req, res) => {
  const { camera, error } = validateCamera(req.body)
  if (error) {
    const typed = { name: String(req.body.name ?? '').slice(0, 100), ip: String(req.body.ip ?? '').slice(0, 100) }
    return res.status(400).render('admin-edit', { mode: 'add', id: null, camera: typed, error })
  }

  const index = await withCameraLock(async () => {
    const list = [...await reloadCameras(), camera]
    await saveCameras(list)
    return list.length - 1
  })
  console.log(`[ADMIN] Added camera "${camera.name}" (${camera.ip})`)
  res.redirect(`/admin?msg=added&sel=${index}`)
}))

app.get('/admin/edit/:id', asyncRoute(async (req, res) => {
  const cameras = await reloadCameras()
  const i = cameraIndex(req.params.id, cameras)
  if (i === -1) return res.redirect('/admin')
  res.render('admin-edit', { mode: 'edit', id: i, camera: cameras[i], error: null })
}))

app.post('/admin/edit/:id', asyncRoute(async (req, res) => {
  const { camera, error } = validateCamera(req.body)
  if (error) {
    const typed = { name: String(req.body.name ?? '').slice(0, 100), ip: String(req.body.ip ?? '').slice(0, 100) }
    return res.status(400).render('admin-edit', { mode: 'edit', id: req.params.id, camera: typed, error })
  }

  const i = await withCameraLock(async () => {
    const list = [...await reloadCameras()]
    const index = cameraIndex(req.params.id, list)
    if (index === -1) return -1
    list[index] = camera
    await saveCameras(list)
    return index
  })
  if (i === -1) return res.redirect('/admin')
  console.log(`[ADMIN] Changed camera ${i + 1} to "${camera.name}" (${camera.ip})`)
  res.redirect(`/admin?msg=edited&sel=${i}`)
}))

// Confirmation is a page, not a browser dialog: the kiosk must never show popups
app.get('/admin/remove/:id', asyncRoute(async (req, res) => {
  const cameras = await reloadCameras()
  const i = cameraIndex(req.params.id, cameras)
  if (i === -1) return res.redirect('/admin')
  res.render('admin-remove', { id: i, camera: cameras[i] })
}))

app.post('/admin/remove/:id', asyncRoute(async (req, res) => {
  const result = await withCameraLock(async () => {
    const list = [...await reloadCameras()]
    const index = cameraIndex(req.params.id, list)
    if (index === -1) return null
    const [removed] = list.splice(index, 1)
    await saveCameras(list)
    return { index, removed, remaining: list.length }
  })
  if (!result) return res.redirect('/admin')
  console.log(`[ADMIN] Removed camera "${result.removed.name}" (${result.removed.ip})`)
  res.redirect(`/admin?msg=removed&sel=${Math.min(result.index, Math.max(result.remaining - 1, 0))}`)
}))

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

// app.post('/stream-dual', function (req, res) {
//   dualcams.right.delay = req.body.delay

//   streamManager.addCameraStream('stream1', dualcams.left.url, 30)
//   streamManager.addCameraStream('stream2', dualcams.right.url, 30)

//   res.render('stream-dual', dualcams)
// })
// ---------------------------------------------------------------------------
// Dual camera stream
// ---------------------------------------------------------------------------
app.post('/stream-dual', function (req, res) {
  dualcams.right.delay = req.body.delay
 
  // Each camera gets its own stream (different URLs = different connections)
  streamManager.addCameraStream('stream1', dualcams.left.url, 30, false)
  streamManager.addCameraStream('stream2', dualcams.right.url, 30, false)
 
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

// app.get('/stream', async function (req, res) {
//   const ip = config[req.query.cam].ip
//   const name = config[req.query.cam].name
//   const user = process.env.VS_USER
//   const pass = process.env.VS_PASS
//   const url = `http://${ip}/axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`
//   const data = {
//     delay: req.query.delay,
//     url,
//     name
//   }
//   streamManager.addCameraStream('stream1', url, 30)

//   res.render('stream', data)
// })
// ---------------------------------------------------------------------------
// Single camera stream (with delay)
// ---------------------------------------------------------------------------
app.get('/stream', async function (req, res) {
  const camera = getCamera(req.query.cam)
  if (!camera) return res.redirect('/')
  const ip = camera.ip
  const name = camera.name
  const url = `http://${ip}/axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`
  const data = {
    delay: req.query.delay,
    url,
    name
  }
 
  // getOrCreateStream ensures only one HTTP connection per camera URL
  // streamManager.getOrCreateStream(url, 30)
  streamManager.addCameraStream('stream1', url, 30, false)

  res.render('stream', data)
})

// app.get('/stream-quad', async function (req, res) {
//   const ip = config[req.query.cam].ip
//   const name = config[req.query.cam].name
//   const user = process.env.VS_USER
//   const pass = process.env.VS_PASS
//   const url = `http://${ip}/axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`
//   const data = {
//     delay: req.query.delay,
//     delta: req.query.delta,
//     url,
//     name
//   }

//   streamManager.addCameraStream('stream1', url, 30)
//   streamManager.addCameraStream('stream2', url, 30)
//   streamManager.addCameraStream('stream3', url, 30)
//   streamManager.addCameraStream('stream4', url, 30)

//   res.render('stream-quad', data)
// })
// ---------------------------------------------------------------------------
// Quad view — same camera, up to 4 different delays
// ---------------------------------------------------------------------------
app.get('/stream-quad', async function (req, res) {
  const camera = getCamera(req.query.cam)
  if (!camera) return res.redirect('/')
  const ip = camera.ip
  const name = camera.name
  const url = `http://${ip}/axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`
  const data = {
    delay: req.query.delay,
    delta: req.query.delta,
    url,
    name,
    streamName: 'stream1'
  }
 
  // One connection to the camera — all 4 quad panels read from the same buffer
  // streamManager.getOrCreateStream(url, 30)
  streamManager.addCameraStream('stream1', url, 30, false)
 
  res.render('stream-quad', data)
})

app.get('/stream/:streamName/:delay', async (req, res) => {
  const streamName = req.params.streamName
  const delay = Number.parseFloat(req.params.delay)

  if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_SECONDS) {
    return res.status(400).send(`Invalid delay, must be between 0 and ${MAX_DELAY_SECONDS} seconds.`)
  }

  const stream = streamManager.getCameraStream(streamName)

  if (!stream) {
    return res.status(404).send(`Stream '${streamName}' not found.`)
  }

  console.log(`${streamName} - Client connected, delay: ${delay}s`)

  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=--myboundary')
  res.setHeader('Cache-Control', 'no-cache')

  // Aborting ends the frame generator even if the camera is not sending frames
  const clientGone = new AbortController()
  req.on('close', () => {
    console.log(`${streamName} - Client disconnected (delay: ${delay}s)`)
    clientGone.abort()
  })

  // getDelayedFrames registers/unregisters the consumer automatically
  const delayedFramesGenerator = stream.getDelayedFrames(delay, clientGone.signal)

  try {
    for await (const frame of delayedFramesGenerator) {
      if (res.destroyed || res.writableEnded) break

      res.write('--myboundary\r\n')
      res.write('Content-Type: image/jpeg\r\n')
      res.write(`Content-Length: ${frame.length}\r\n\r\n`)
      res.write(frame)
      const canContinue = res.write('\r\n')

      // Respect backpressure so a slow client cannot make memory grow without limit
      if (!canContinue) await waitForDrain(res)
    }
  } catch (err) {
    console.error(`${streamName} - Streaming error:`, err)
  } finally {
    res.end()
  }
})

// ---------------------------------------------------------------------------
// Health check endpoint — useful for monitoring on the NUC
// ---------------------------------------------------------------------------
app.get('/health', function (req, res) {
  res.json(streamManager.getStreamHealth())
})

// Last resort for errors thrown inside route handlers
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, err)
  if (res.headersSent) return res.end()
  res.status(500).send('Internal error')
})

// Start server
// app.listen(3000, ExecuteChromium)
app.listen(3000)

// Open browser
// await open(url)

function ExecuteChromium() {
  exec("/usr/bin/chromium-browser --kiosk --disable-restore-session-state --disable-features=TranslateUI --disable-session-crashed-bubble --app=http://localhost:3000/splashscreen", function(error, stdout, stderr) {
      // console.log("stdout: " + stdout);
      console.log("stderr: " + stderr);
      if (error !== null) {
          console.log("exec errror: " + error);
      }
  });
}
