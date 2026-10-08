# Maxlew Videosystem 2.0

A kiosk video-delay system. It reads MJPEG streams from Axis IP cameras and shows
them with a time delay on a touch screen / monitor, in one of three layouts. The
interface is in Swedish and is driven with the keyboard.

For the people who use the system there is a short manual in Swedish: **[lathund.md](lathund.md)**.

## Layouts

| Key in the main menu | Layout |
| --- | --- |
| `1` | **Singlecam**: one camera, one delay |
| `2` | **Singlecam Quadview**: one camera in four panes, each pane with its own delay |
| `3` | **Doublecam**: two cameras, each with its own delay |
| `m` | **Admin**: add, edit and remove cameras |
| `*` | Shut down the machine |

`+` goes back to the main menu from any page. The pages accept delays up to 36 seconds.

## How it works

Node.js (ES modules) with Express and EJS, listening on port 3000.

* Each camera has **one** connection (`src/camerastream.js`). Incoming bytes are
  split into JPEG frames by a worker thread (`src/frameParserWorker.js`) and kept in
  memory. Frames are never re-encoded, so the picture is exactly what the camera sends.
* Every viewer reads the shared buffer at its own delay, which is how one camera can
  be shown in four panes with four delays.
* A lost or stalled camera connection is detected and reconnected automatically.
* `GET /health` shows the state of every running stream as JSON.

Image quality is set by the camera URL in `index.js`
(`.../axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`).

## Configuration

* **Cameras**: `config/cameras.json`, a list of `{ "name": "...", "ip": "..." }`.
  Edit it with `m` in the main menu (add, edit, remove). The file is created empty if
  it is missing and is not committed to git.
* **License**: the system is licensed for one year at a time with a code from
  Maxlew Studios. When the license has ended, the main menu shows a page where a new
  code can be entered.

## Installing on a machine

Production machines are installed offline from a USB stick, as a kiosk on Debian 13
without a desktop. See **[offline-install/README.md](offline-install/README.md)**.

## Running for development

Needs Node.js (24 is what the offline bundle uses).

```
npm install
npm start          # http://localhost:3000/splashscreen
```

The camera streams need real cameras on the network. Without a valid
a valid license the main menu shows the license page.

## Project layout

```
index.js                      routes, camera admin, stream endpoint
src/camerastream.js           one camera: connection, frame buffer, delayed frames
src/cameraStreamManager.js    the running streams
src/frameParserWorker.js      MJPEG parser (worker thread)
src/licensecheck.js           license check
views/                        EJS pages
public/                       css, images, sounds
config/                       camera list
offline-install/              offline kiosk installer and bundle builder
```
