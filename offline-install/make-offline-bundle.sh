#!/usr/bin/env bash
#
# Builds the offline bundle used by install.sh.
#
# Run this ONCE on a computer WITH internet. It produces two files:
#
#   dist/maxlew-offline-bundle.tar   the app, Node.js and every Debian package needed
#   dist/install.sh                  the only thing you run on the target machine
#
# Copy both to the USB stick.
#
# Needs: bash, apt-get, apt-ftparchive (package apt-utils), curl, tar, xz, sha256sum.
# It does not need root, does not touch the system, and does not have to run on
# Debian: packages are resolved straight against the Debian 13 (trixie) archive
# with a private apt state. DEBIAN_RELEASE=bookworm builds a Debian 12 bundle.
#
# Usage: ./make-offline-bundle.sh [output-dir]

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$HERE/.." && pwd)"
OUT_DIR="${1:-$HERE/dist}"

NODE_MAJOR="${NODE_MAJOR:-24}"
DEBIAN_RELEASE="${DEBIAN_RELEASE:-trixie}"   # Debian 13; bookworm = Debian 12
ARCH="amd64"
MIRROR="${DEBIAN_MIRROR:-https://deb.debian.org/debian}"
SECURITY_MIRROR="${DEBIAN_SECURITY_MIRROR:-https://security.debian.org/debian-security}"

# Everything install.sh installs with apt. Dependencies are added automatically.
PACKAGES=(
  # X and kiosk
  xorg xinit x11-xserver-utils xserver-xorg-legacy
  openbox chromium chromium-sandbox unclutter
  fonts-liberation fonts-dejavu-core
  # sound (the splash screen plays audio)
  alsa-utils pipewire-audio dbus-user-session libpam-systemd
  # sudo: the shutdown page. curl: the kiosk waits for the app. xz-utils: unpacks Node.js.
  sudo curl xz-utils
)

log () { printf '\n==> %s\n' "$*"; }
die () { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

for tool in apt-get apt-ftparchive curl tar xz sha256sum awk; do
  command -v "$tool" >/dev/null || die "Missing tool: $tool (apt-ftparchive is in the package apt-utils)"
done
[[ -f "$REPO_DIR/package.json" ]] || die "Cannot find the app next to this script ($REPO_DIR)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BUNDLE="$WORK/bundle/maxlew-offline"
mkdir -p "$BUNDLE/app" "$BUNDLE/node" "$BUNDLE/apt-repo/pool" "$OUT_DIR"

# -----------------------------------------------------------------------------
# 1. Node.js (official Linux x64 binary, checksum verified)
# -----------------------------------------------------------------------------
log "Downloading Node.js ${NODE_MAJOR}.x"
NODE_BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
curl -fsSL "$NODE_BASE/SHASUMS256.txt" -o "$WORK/SHASUMS256.txt"
NODE_FILE="$(awk '/linux-x64\.tar\.xz$/ {print $2}' "$WORK/SHASUMS256.txt")"
[[ -n "$NODE_FILE" && "$NODE_FILE" != *$'\n'* ]] || die "Could not determine the Node.js ${NODE_MAJOR} download"
curl -fSL "$NODE_BASE/$NODE_FILE" -o "$BUNDLE/node/$NODE_FILE"
(cd "$BUNDLE/node" && grep " ${NODE_FILE}\$" "$WORK/SHASUMS256.txt" | sha256sum -c -) \
  || die "Node.js checksum mismatch"
NODE_VERSION="${NODE_FILE#node-v}"
NODE_VERSION="${NODE_VERSION%-linux-x64.tar.xz}"

# A private copy of node, only used here to run npm
tar -xJf "$BUNDLE/node/$NODE_FILE" -C "$WORK"
NODE_BIN="$WORK/${NODE_FILE%.tar.xz}/bin"

# -----------------------------------------------------------------------------
# 2. The app with production dependencies
# -----------------------------------------------------------------------------
log "Copying the app and installing production dependencies"
# Left out on purpose: machine specific or secret files (.env, cameras.json,
# the license date, which install.sh sets per machine, and developer notes),
# dev dependencies (reinstalled below) and this folder.
tar -C "$REPO_DIR" \
  --exclude=.git --exclude=node_modules --exclude=.env --exclude=cameras.json \
  --exclude=.expiration.json --exclude=CLAUDE.md --exclude=.claude \
  --exclude=offline-install --exclude='*.tgz' --exclude='*Zone.Identifier' \
  -cf - . | tar -C "$BUNDLE/app" -xf -

(cd "$BUNDLE/app" && PATH="$NODE_BIN:$PATH" npm ci --omit=dev --no-audit --no-fund)
[[ -d "$BUNDLE/app/node_modules/express" ]] || die "npm ci did not install the dependencies"

APP_VERSION="$(PATH="$NODE_BIN:$PATH" node -p "require('$BUNDLE/app/package.json').version")"

# -----------------------------------------------------------------------------
# 3. Debian packages: resolve against an EMPTY dpkg state so the bundle holds
#    the complete dependency closure, whatever the target already has.
# -----------------------------------------------------------------------------
log "Resolving and downloading Debian ${DEBIAN_RELEASE} packages"
APT_DIR="$WORK/apt"
mkdir -p "$APT_DIR/state/lists/partial" "$APT_DIR/cache/archives/partial" "$APT_DIR/empty"
: > "$APT_DIR/status"

KEYRING=/usr/share/keyrings/debian-archive-keyring.gpg
write_sources () {
  local sign="$1"
  cat > "$APT_DIR/sources.list" <<EOF
deb [arch=$ARCH $sign] $MIRROR $DEBIAN_RELEASE main
deb [arch=$ARCH $sign] $MIRROR $DEBIAN_RELEASE-updates main
deb [arch=$ARCH $sign] $SECURITY_MIRROR $DEBIAN_RELEASE-security main
EOF
}

APT=(apt-get
  -o Dir::Etc::sourcelist="$APT_DIR/sources.list"
  -o Dir::Etc::sourceparts="$APT_DIR/empty"
  -o Dir::Etc::preferences=/dev/null
  -o Dir::Etc::preferencesparts="$APT_DIR/empty"
  -o Dir::State="$APT_DIR/state"
  -o Dir::State::status="$APT_DIR/status"
  -o Dir::Cache="$APT_DIR/cache"
  -o Debug::NoLocking=1
  -o APT::Architecture="$ARCH"
  -o APT::Architectures="$ARCH"
  -o APT::Sandbox::User=
  -o Acquire::Languages=none
  -o Acquire::Check-Date=false
  -o APT::Install-Recommends=false
  -o APT::Install-Suggests=false
)

# apt-get update can finish "successfully" while skipping a repository whose
# signature it cannot verify, so with verification on (strict) the output is
# checked as well as the exit code. With trusted=yes apt still prints key
# warnings but uses the repository, so there only the exit code counts.
update_checked () {
  local mode="$1" log="$WORK/apt-update.log" rc=0
  "${APT[@]}" update 2>&1 | tee "$log" || rc=$?
  (( rc == 0 )) || return 1
  [[ "$mode" == lenient ]] || ! grep -qE 'GPG error|NO_PUBKEY|is not signed|could not be verified' "$log"
}

# Verify signatures when this machine's Debian keyring knows the release's keys.
# An old keyring (or none) cannot, so fall back to trusting the https mirrors
# (apt still checks every file against the hashes in the release files).
if [[ -f "$KEYRING" ]]; then
  write_sources "signed-by=$KEYRING"
  if ! update_checked strict; then
    printf '\nNOTE: signature check failed (old Debian keyring on this machine?), trusting the https mirrors instead.\n'
    write_sources "trusted=yes"
    update_checked lenient || die "apt update failed"
  fi
else
  printf 'NOTE: debian-archive-keyring not found, trusting the https mirrors instead of verifying signatures.\n'
  write_sources "trusted=yes"
  update_checked lenient || die "apt update failed"
fi
compgen -G "$APT_DIR/state/lists/*Packages*" >/dev/null || die "apt update fetched no package lists"

"${APT[@]}" install -y --download-only "${PACKAGES[@]}"

shopt -s nullglob
debs=("$APT_DIR"/cache/archives/*.deb)
shopt -u nullglob
(( ${#debs[@]} > 0 )) || die "No packages were downloaded"
mv "${debs[@]}" "$BUNDLE/apt-repo/pool/"

log "Building the local package repository (${#debs[@]} packages)"
(
  cd "$BUNDLE/apt-repo"
  apt-ftparchive packages pool > Packages
  apt-ftparchive \
    -o APT::FTPArchive::Release::Origin=maxlew-offline \
    -o APT::FTPArchive::Release::Suite=offline \
    -o APT::FTPArchive::Release::Architectures="$ARCH" \
    release . > Release
)

# -----------------------------------------------------------------------------
# 4. Manifest, checksums, tar
# -----------------------------------------------------------------------------
cat > "$BUNDLE/MANIFEST" <<EOF
BUNDLE_BUILT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEBIAN_RELEASE="$DEBIAN_RELEASE"
ARCH="$ARCH"
APP_VERSION="$APP_VERSION"
NODE_VERSION="$NODE_VERSION"
NODE_FILE="$NODE_FILE"
PACKAGES="${PACKAGES[*]}"
EOF

log "Writing checksums and the tar file"
(cd "$BUNDLE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

TAR_FILE="$OUT_DIR/maxlew-offline-bundle.tar"
tar -C "$WORK/bundle" -cf "$TAR_FILE" maxlew-offline
cp "$HERE/install.sh" "$OUT_DIR/install.sh"
chmod +x "$OUT_DIR/install.sh"

cat <<EOF

Done.
  $TAR_FILE ($(du -h "$TAR_FILE" | cut -f1))
  $OUT_DIR/install.sh

Copy both files to the USB stick. On the target machine (fresh Debian ${DEBIAN_RELEASE}, no desktop):

  sudo bash /path/to/usb/install.sh

App version $APP_VERSION, Node.js $NODE_VERSION.
EOF
