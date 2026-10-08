# CLAUDE.md

Guide for working on this repository. Read it before changing anything. It describes
how the system fits together, the invariants that are easy to break, and how the owner
likes to work. If it disagrees with the code, trust the code and fix this file.

## What this is

Maxlew Video System: a kiosk that shows Axis IP camera streams **with a time delay**
(single camera, one camera in four panes with four delays, or two cameras side by
side). Node.js 24 (ES modules), Express 4, EJS, `node-fetch`. It runs on a Debian 13
box without a desktop (Xorg + Openbox + Chromium in kiosk mode), installed offline from
a USB stick. The user interface is **Swedish** and driven only by the keyboard. Code,
comments, commit messages and docs for developers are English.

## Commands

```
npm start                 # node index.js, port 3000 (hard-coded)
npm run eslint            # standard style; the code is not fully conformant, do not mass-reformat
```

There are **no automated tests**. The `test` script is a placeholder.

### How to verify changes (no cameras needed)

* **Stream code**: write a throwaway script in `/tmp` that serves a fake Axis stream
  (`multipart/x-mixed-replace`, boundary `--myboundary`, each part with `Content-Type`
  and `Content-Length`; mix single frames, bursts of several frames in one write, frames
  split across writes, a dropped connection and a silent stall). Import
  `src/camerastream.js`, read `getDelayedFrames(delay)` and check: every frame arrives
  once, in order, byte-identical (hash them), delay is accurate, the stream reconnects.
* **Routes and pages**: run the app **from a temporary copy** (copy `index.js`, `src`,
  `views`, `public`, `config`, `package.json`, symlink `node_modules`), put a valid
  license file and test cameras in the copy, and `curl` the routes. The app writes to
  `config/` (cameras, license renewals), so never test against the real `config/`.
* **Starting and stopping a test server**: use `(cd "$T" && exec node index.js) & PID=$!` and
  `kill $PID`. `cd x && node ... &` backgrounds a subshell, so `$!` is not node and the
  server keeps running on port 3000. `pkill -f "node index.js"` can kill your own shell
  if the command line contains that text.
* **Shell scripts**: `bash -n`, then test the logic in isolation by extracting the block
  and running it under `script -qec` (a pseudo-terminal) for the prompts. `install.sh`
  needs root and changes the system, so it is not run on the dev machine.

## Architecture

```
index.js                      all routes, camera list editing, stream endpoint
src/camerastream.js           CameraStream: one camera connection + frame buffer
src/cameraStreamManager.js    named CameraStream instances
src/frameParserWorker.js      worker thread: MJPEG multipart -> JPEG frames
src/licensecheck.js           license check (see "Policies")
views/*.ejs                   Swedish, keyboard driven pages
public/                       css, images (37 hourglass pictures), sounds
offline-install/              offline installer and bundle builder (own README)
```

### Streams (the core, handle with care)

* One HTTP connection per camera. The worker thread splits the byte stream into JPEG
  frames using the part's `Content-Length`, checks the JPEG start bytes, and never exits
  on a parse error (it resynchronises on the next `--myboundary`).
* Frames are **never re-encoded**; they are passed on byte for byte. Keep it that way.
* `CameraStream.frames` holds `{ seq, timestamp, data }`. `seq` is consecutive, so a
  consumer's position is `nextSeq - frames[0].seq`. Timestamps come from a monotonic
  clock (`performance.now()`), never `Date.now()`. Do not track position by timestamp:
  several frames can arrive in one network chunk and share a timestamp.
* `getDelayedFrames(delay, signal)` is an async generator, one per viewer. It starts at the
  frame that is `delay` old (or the oldest frame if the buffer is not older than the
  delay), and ends when the `AbortSignal` fires, even if the camera sends nothing.
* Consumers are counted per delay (`Map`). The buffer keeps the longest delay seen plus a
  margin, so a quad pane that reconnects still finds its history.
* Each connection is one `conn` object. Every failure (HTTP error, end of stream, socket
  error, 10 s without data, worker exit) goes through `_connectionLost(conn)`, which
  closes it and schedules a reconnect with backoff. Only the first call per connection acts.
  Stale events from an old connection must never touch a new one.
* `res.write` backpressure is respected in the `/stream/:streamName/:delay` route.
* Stream names: single and quad use `stream1`; doublecam uses `stream1` and `stream2`.
  `addCameraStream` replaces a stream when the same name gets a different URL.
  Visiting `/` stops all streams.
* Delays: the pages cap at 36 s; the server accepts 0 to `MAX_DELAY_SECONDS` (60).
  Delay 0 on the single page connects the browser straight to the camera.

### Camera source

The camera URL is built in `index.js` (several places) as
`http://<ip>/axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`. The parser expects
Axis' MJPEG multipart format. Image quality is decided by that URL, not by the app.

### Routes and pages

* `asyncRoute()` wraps async handlers: **Express 4 does not catch rejected promises**, and an
  unhandled one would otherwise hang the request. A last-resort error handler and
  `process.on('unhandledRejection'/'uncaughtException')` log and keep the process alive
  (nothing restarts it except systemd on the real machines).
* Camera indexes from URLs go through `getCamera()` and redirect to the right list when
  they do not exist. Do not index `config[...]` directly.
* `config/cameras.json` is edited at `/admin` (opened with `m` in the main menu). It is
  re-read from disk on `/` and `/admin`, written atomically (temp file + rename) under a
  simple lock, validated (name 1 to 40 chars, IPv4, leading zeros stripped).
* `/admin/*` and `POST /shutdown` accept requests from the machine itself only
  (`requireLocal`). The app listens on all interfaces.
* `GET /health` returns the state of every running stream.

### Views

* The kiosk must **never show a browser dialog or popup**: no `alert`, `confirm`, `prompt`.
  Confirmations are pages (see `admin-remove.ejs`).
* Keyboard driven, mouse cursor hidden by CSS. `+` always means "main menu". Forms need
  `<input type="submit" hidden>` so Enter submits them. Text fields use Esc to cancel, since
  `+` can be typed.
* Use absolute asset paths (`/img/...`, `/css/...`): pages are served from nested URLs.
* Single-key camera selection means at most 9 cameras can be chosen.

## Offline installer (`offline-install/`)

Read `offline-install/README.md` first. In short: `make-offline-bundle.sh` (run with
internet, no root, any apt-based machine) builds `dist/maxlew-offline-bundle.tar` (app
with production `node_modules`, Node.js, and the whole Debian 13 package closure as a
local apt repository). `install.sh` (run as root on the target, no internet) installs it
as a kiosk.

* Target: **Debian 13 (trixie), amd64, no desktop.** `DEBIAN_RELEASE=bookworm` still builds
  for Debian 12. The installer refuses a release mismatch unless `--force`.
* The builder resolves packages with apt against the real archive using private apt
  directories and an empty dpkg state, so the bundle is complete whatever the target has.
* **Check package names against the real package index** (`dists/<release>/main/binary-amd64/Packages.xz`),
  or run the builder's resolution step. An HTTP 200 from packages.debian.org does **not** prove a
  package exists (that is how `xserver-xorg-input-void`, removed in Debian 13, slipped in).
* apt must not depend on the clock (`Acquire::Check-Date=false`): an offline machine may
  have a clock earlier than the bundle's build time. `apt-get update` can succeed while
  skipping a repository it cannot verify, so its output is checked, not only its exit code.
* `install.sh` asks its questions first (license ID, then the clock) and then runs
  unattended. It is safe to run again: it keeps the machine's `config/`, license and ID,
  and moves the old app to `/opt/maxlew_videosystem_node.bak-<date>`.
* On the machine: app in `/opt/maxlew_videosystem_node` run by `videostream.service` as
  user `maxlew`; autologin on tty1 starts X, `.xinitrc` waits for the app and loops
  Chromium in kiosk mode; Chromium policies in `/etc/chromium/policies/managed/`.
* **Verification status:** the first install on a real machine worked. Later changes
  (clock question, license per install, cleanup) and the update/re-run path have not been
  run end to end. Test on a spare machine or VM before relying on them.

## Policies and owner preferences

* **Customer-visible text must not reveal how the license works.** README.md, lathund.md /
  lathund.pdf, offline-install/README.md and the installer's `--help` only say that the
  license is a one-year code from Maxlew Studios. The mechanics live in `src/licensecheck.js`
  only. Keep them out of every document, including this one.
* **Do not commit local changes to the license file in `config/`** (the one `git status` shows as
  modified). The owner keeps a changed copy for development. `config/cameras.json` is
  git-ignored. The installer never uses the license file from the repo or the bundle.
* **Git:** the owner approves commits and pushes one by one. Do not commit or push unless
  asked. Commit messages are English and end with the `Co-Authored-By` trailer. For a
  release: bump the version with `npm version X --no-git-tag-version`, commit
  `release X`, create an annotated tag `vX`, push `main` and the tag. Existing tags: v2.1.0, v2.1.1, v2.1.2.
* **Dev machine:** Ubuntu 22.04 on WSL2, not Debian. The owner does not want Docker or other heavy
  things run on it without asking first. Windows Chrome is reachable from WSL at
  `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe`.
* **lathund.md** is the Swedish user manual; **lathund.pdf** is generated from it (Markdown to HTML
  with CSS, then headless Chrome `--print-to-pdf`). It is not automated: regenerate it when
  the manual changes, and check the pages visually.
* The builder copies the whole repo into the bundle, so everything not excluded (the README,
  the manual and so on) ends up in the app folder on customer machines. This file is excluded.
* Be honest about what was and was not tested. Say so when something has only been
  syntax-checked.

## Known gaps (left as they are on purpose or not yet done)

* The license page only guards `/`; feature routes can be opened directly.
* A missing or corrupt license file makes the main menu hang instead of showing a message.
* `index.js` still has commented-out blocks, an unused `ExecuteChromium`, unused imports
  and `package.json` has an unused dependency (`crypt`) and a misspelled
  `"bundledDependencies "` key.
* No automated tests.
