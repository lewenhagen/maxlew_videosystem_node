#!/usr/bin/env bash
#
# Maxlew Videosystem - offline kiosk installer
#
# For a fresh Debian (the release the bundle was built for, amd64) WITHOUT a desktop.
# No internet needed.
# Put this file and maxlew-offline-bundle.tar (made by make-offline-bundle.sh)
# in the same folder, for example on a USB stick, and run as root:
#
#   sudo bash install.sh [options]
#
# Options:
#   --bundle FILE   use this bundle instead of maxlew-offline-bundle.tar next to the script
#   --id VALUE      the VIDEOSYSTEM_ID used for license codes (asked for first if left out)
#   --reboot        reboot when the installation is finished
#   --force         do not stop on a Debian release / architecture mismatch
#
# Safe to run again: the machine's cameras, license date and ID are kept.

set -euo pipefail

# ============================================================
# CONFIGURATION
# ============================================================
KIOSK_USER="maxlew"
APP_DIR="/opt/maxlew_videosystem_node"
KIOSK_URL="http://localhost:3000/splashscreen"
SERVICE="videostream"
ENV_FILE="/etc/maxlew/maxlew.env"
WORK="/var/tmp/maxlew-install"
LOG="/var/log/maxlew-install.log"
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_FILE=""
VIDEOSYSTEM_ID="${VIDEOSYSTEM_ID:-}"
DO_REBOOT=0
FORCE=0

while (( $# > 0 )); do
  case "$1" in
    --bundle) BUNDLE_FILE="${2:?--bundle needs a file}"; shift 2 ;;
    --id)     VIDEOSYSTEM_ID="${2:?--id needs a value}"; shift 2 ;;
    --reboot) DO_REBOOT=1; shift ;;
    --force)  FORCE=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

step () { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn () { printf '\033[33mWARNING: %s\033[0m\n' "$*"; }
die ()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash $0"

# ------------------------------------------------------------
# License ID: asked first so the rest of the install can run unattended
# ------------------------------------------------------------
EXISTING_ID=""
if [[ -f "$ENV_FILE" ]]; then
  EXISTING_ID="$(sed -n "s/^VIDEOSYSTEM_ID='\(.*\)'$/\1/p" "$ENV_FILE")"
fi

valid_id () { [[ -n "$1" && "$1" != *"'"* ]]; }

if [[ -n "$VIDEOSYSTEM_ID" ]]; then
  valid_id "$VIDEOSYSTEM_ID" || die "VIDEOSYSTEM_ID may not contain the character '"
elif [[ -t 0 ]]; then
  printf '\n\033[1mLicense ID\033[0m\n'
  while true; do
    if [[ -n "$EXISTING_ID" ]]; then
      read -r -p "VIDEOSYSTEM_ID [Enter keeps $EXISTING_ID]: " answer || die "Aborted"
    else
      read -r -p "VIDEOSYSTEM_ID for this machine: " answer || die "Aborted"
    fi
    answer="${answer#"${answer%%[![:space:]]*}"}"   # trim
    answer="${answer%"${answer##*[![:space:]]}"}"

    if [[ -z "$answer" ]]; then
      [[ -n "$EXISTING_ID" ]] && break              # keep the existing one
      read -r -p "No ID entered. License codes will not work. Continue without one? [y/N] " yn || die "Aborted"
      [[ "$yn" == [yY]* ]] && break
      continue
    fi
    if valid_id "$answer"; then
      VIDEOSYSTEM_ID="$answer"
      break
    fi
    echo "The ID may not contain the character '"
  done
fi

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
echo "Maxlew install started $(date)"

trap 'rm -rf "$WORK"' EXIT

# ------------------------------------------------------------
# 0. Find, unpack and verify the bundle
# ------------------------------------------------------------
step "Checking the bundle"

if [[ -z "$BUNDLE_FILE" ]]; then
  if [[ -f "$SCRIPT_DIR/maxlew-offline-bundle.tar" ]]; then
    BUNDLE_FILE="$SCRIPT_DIR/maxlew-offline-bundle.tar"
  else
    shopt -s nullglob
    tars=("$SCRIPT_DIR"/*.tar)
    shopt -u nullglob
    (( ${#tars[@]} == 1 )) || die "Cannot find maxlew-offline-bundle.tar next to the script (use --bundle FILE)"
    BUNDLE_FILE="${tars[0]}"
  fi
fi
[[ -f "$BUNDLE_FILE" ]] || die "Bundle not found: $BUNDLE_FILE"

mkdir -p /var/tmp
need_kb=$(( $(stat -c %s "$BUNDLE_FILE") / 1024 * 3 + 500000 ))
have_kb=$(df --output=avail -k /var/tmp | tail -1 | tr -d ' ')
(( have_kb >= need_kb )) || die "Not enough free disk space in /var/tmp (need about $(( need_kb / 1024 )) MB)"

rm -rf "$WORK"
install -d -m 755 "$WORK"
tar -xf "$BUNDLE_FILE" -C "$WORK"
SRC="$WORK/maxlew-offline"
[[ -f "$SRC/MANIFEST" && -f "$SRC/SHA256SUMS" ]] || die "$BUNDLE_FILE is not a Maxlew bundle"

echo "Verifying checksums (this can take a minute)..."
(cd "$SRC" && sha256sum --quiet -c SHA256SUMS) || die "Checksum error: the bundle is damaged, copy it to the USB stick again"

# shellcheck disable=SC1091
source "$SRC/MANIFEST"
echo "Bundle: app $APP_VERSION, Node.js $NODE_VERSION, Debian $DEBIAN_RELEASE/$ARCH, built $BUNDLE_BUILT"

system_release="$(. /etc/os-release && echo "${VERSION_CODENAME:-unknown}")"
system_arch="$(dpkg --print-architecture)"
if [[ "$system_release" != "$DEBIAN_RELEASE" || "$system_arch" != "$ARCH" ]]; then
  msg="This machine is $system_release/$system_arch but the bundle is for $DEBIAN_RELEASE/$ARCH"
  (( FORCE )) && warn "$msg" || die "$msg (--force to try anyway)"
fi

if [[ -n "$INITIAL_EXPIRY" && "$INITIAL_EXPIRY" < "$(date +%Y%m%d)" ]]; then
  warn "The license date shipped in the bundle ($INITIAL_EXPIRY) has already passed."
fi

# ------------------------------------------------------------
# 1. Debian packages from the local repository on the stick
# ------------------------------------------------------------
step "Installing Debian packages (offline)"

chmod -R a+rX "$WORK"
echo "deb [trusted=yes] file:$SRC/apt-repo ./" > "$WORK/maxlew-offline.list"

export DEBIAN_FRONTEND=noninteractive
export APT_LISTCHANGES_FRONTEND=none

APT=(apt-get -y
  -o Dir::Etc::sourcelist="$WORK/maxlew-offline.list"
  -o Dir::Etc::sourceparts=-
  -o APT::List-Cleanup=0
  -o APT::Sandbox::User=root
  -o Acquire::Languages=none
  -o Dpkg::Options::=--force-confold
)

"${APT[@]}" update
# shellcheck disable=SC2086  # PACKAGES is a space separated list
"${APT[@]}" install --no-install-recommends $PACKAGES

# ------------------------------------------------------------
# 2. Node.js
# ------------------------------------------------------------
step "Installing Node.js $NODE_VERSION"

NODE_DIR="/opt/${NODE_FILE%.tar.xz}"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  tar -xJf "$SRC/node/$NODE_FILE" -C /opt
fi
for bin in node npm npx; do
  ln -sfn "$NODE_DIR/bin/$bin" "/usr/local/bin/$bin"
done
echo "node $(/usr/local/bin/node --version)"

# ------------------------------------------------------------
# 3. Kiosk user
# ------------------------------------------------------------
step "Preparing user '$KIOSK_USER'"

if ! id "$KIOSK_USER" &>/dev/null; then
  adduser --disabled-password --gecos "Maxlew Videosystem" "$KIOSK_USER"
fi
for grp in video audio input render; do
  getent group "$grp" >/dev/null && usermod -aG "$grp" "$KIOSK_USER"
done
KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"

# ------------------------------------------------------------
# 4. The application
# ------------------------------------------------------------
step "Installing the application to $APP_DIR"

systemctl stop "$SERVICE" 2>/dev/null || true

BACKUP=""
if [[ -d "$APP_DIR" ]]; then
  BACKUP="$APP_DIR.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$APP_DIR" "$BACKUP"
  echo "Previous installation moved to $BACKUP"
fi

cp -a "$SRC/app" "$APP_DIR"
mkdir -p "$APP_DIR/config"

# Keep this machine's cameras and license; the newer license date wins.
read_date () { sed -n 's/.*"date" *: *"\([0-9]\{8\}\)".*/\1/p' "$1" 2>/dev/null || true; }
bundle_date="$(read_date "$APP_DIR/config/.expiration.json")"
if [[ -n "$BACKUP" && -d "$BACKUP/config" ]]; then
  cp -a "$BACKUP/config/." "$APP_DIR/config/"
  kept_date="$(read_date "$APP_DIR/config/.expiration.json")"
  if [[ -n "$bundle_date" && "$bundle_date" > "${kept_date:-0}" ]]; then
    echo "{\"date\":\"$bundle_date\"}" > "$APP_DIR/config/.expiration.json"
    echo "License date taken from the bundle: $bundle_date"
  fi
fi
[[ -f "$APP_DIR/config/cameras.json" ]] || echo '[]' > "$APP_DIR/config/cameras.json"
[[ -f "$APP_DIR/config/.expiration.json" ]] || warn "config/.expiration.json is missing, the app will not start"

chmod +x "$APP_DIR"/*.sh 2>/dev/null || true
chown -R "$KIOSK_USER:$KIOSK_USER" "$APP_DIR"

# ------------------------------------------------------------
# 5. License ID
# ------------------------------------------------------------
step "License ID"

install -d -m 755 "$(dirname "$ENV_FILE")"

if [[ -n "$VIDEOSYSTEM_ID" ]]; then
  printf "VIDEOSYSTEM_ID='%s'\n" "$VIDEOSYSTEM_ID" > "$ENV_FILE"
  echo "Saved to $ENV_FILE"
elif [[ -s "$ENV_FILE" ]]; then
  echo "Keeping the existing $ENV_FILE"
else
  : > "$ENV_FILE"
  warn "No VIDEOSYSTEM_ID set. License codes will not work until it is added to $ENV_FILE"
fi
chown "root:$KIOSK_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# ------------------------------------------------------------
# 6. Application service
# ------------------------------------------------------------
step "Creating the $SERVICE service"

cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=Maxlew Videosystem
After=network.target

[Service]
Type=simple
User=$KIOSK_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
EnvironmentFile=-$ENV_FILE
ExecStart=/usr/local/bin/node index.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Keep the log from filling the disk
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/maxlew.conf <<'EOF'
[Journal]
SystemMaxUse=200M
RuntimeMaxUse=100M
EOF

# The shutdown page runs "sudo systemctl poweroff" as the app user
sudoers_tmp="$(mktemp)"
cat > "$sudoers_tmp" <<EOF
$KIOSK_USER ALL=(ALL) NOPASSWD: /bin/systemctl poweroff, /usr/bin/systemctl poweroff
EOF
chmod 440 "$sudoers_tmp"
visudo -cf "$sudoers_tmp" >/dev/null || die "Generated sudoers rule is invalid"
install -m 440 -o root -g root "$sudoers_tmp" /etc/sudoers.d/maxlew-poweroff
rm -f "$sudoers_tmp"

# ------------------------------------------------------------
# 7. Kiosk: autologin -> X -> Chromium
# ------------------------------------------------------------
step "Configuring the kiosk"

# X may start for a normal user
if [[ -f /etc/X11/Xwrapper.config ]] && grep -q '^allowed_users' /etc/X11/Xwrapper.config; then
  sed -i 's/^allowed_users.*/allowed_users=anybody/' /etc/X11/Xwrapper.config
else
  echo "allowed_users=anybody" >> /etc/X11/Xwrapper.config
fi

# Autologin on tty1
install -d /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/override.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $KIOSK_USER --noclear %I \$TERM
EOF

# Start X on tty1. exec: when X ends the login ends and autologin starts it again.
cat > "$KIOSK_HOME/.bash_profile" <<'EOF'
if [[ -z $DISPLAY ]] && [[ $(tty) == /dev/tty1 ]]; then
  exec startx
fi
EOF

cat > "$KIOSK_HOME/.xinitrc" <<'EOF'
#!/bin/bash
# Maxlew kiosk session (written by install.sh)

# No screen blanking or power saving
xset -dpms
xset s off
xset s noblank

# Hide the mouse cursor (Debian 13 names the program unclutter-classic)
UNCLUTTER="$(command -v unclutter-classic || command -v unclutter || true)"
[ -n "$UNCLUTTER" ] && "$UNCLUTTER" -idle 0 -root &

openbox-session &

URL="__KIOSK_URL__"
PROFILE="$HOME/.config/maxlew-kiosk"

# Wait for the app (up to 60 s)
for i in $(seq 1 60); do
  curl -sf -o /dev/null "$URL" && break
  sleep 1
done

mkdir -p "$PROFILE"
touch "$PROFILE/First Run"

# Chromium is restarted if it ever exits
while true; do
  # After a power cut Chromium would otherwise ask to restore the session
  # or complain that the profile is in use.
  rm -f "$PROFILE"/Singleton*
  if [ -f "$PROFILE/Default/Preferences" ]; then
    sed -i 's/"exited_cleanly": *false/"exited_cleanly":true/; s/"exit_type": *"[^"]*"/"exit_type":"Normal"/' \
      "$PROFILE/Default/Preferences"
  fi

  chromium \
    --user-data-dir="$PROFILE" \
    --kiosk \
    --start-fullscreen \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --no-first-run \
    --no-default-browser-check \
    --disable-translate \
    --disable-features=Translate,TranslateUI,MediaRouter \
    --disable-notifications \
    --disable-sync \
    --disable-breakpad \
    --disable-component-update \
    --disable-background-networking \
    --check-for-update-interval=31536000 \
    --password-store=basic \
    --disable-pinch \
    --overscroll-history-navigation=0 \
    --autoplay-policy=no-user-gesture-required \
    "$URL"
  sleep 2
done
EOF
sed -i "s|__KIOSK_URL__|$KIOSK_URL|" "$KIOSK_HOME/.xinitrc"

chmod 755 "$KIOSK_HOME/.xinitrc"
chown "$KIOSK_USER:$KIOSK_USER" "$KIOSK_HOME/.xinitrc" "$KIOSK_HOME/.bash_profile"

# Chromium policies: no dialogs, prompts or popups of any kind
install -d /etc/chromium/policies/managed
cat > /etc/chromium/policies/managed/maxlew.json <<'EOF'
{
  "AutoplayAllowed": true,
  "DefaultPopupsSetting": 2,
  "DefaultNotificationsSetting": 2,
  "DefaultGeolocationSetting": 2,
  "DefaultWebBluetoothGuardSetting": 2,
  "DefaultWebUsbGuardSetting": 2,
  "DefaultSerialGuardSetting": 2,
  "PasswordManagerEnabled": false,
  "AutofillAddressEnabled": false,
  "AutofillCreditCardEnabled": false,
  "TranslateEnabled": false,
  "SpellcheckEnabled": false,
  "BrowserSignin": 0,
  "SyncDisabled": true,
  "BrowserAddPersonEnabled": false,
  "MetricsReportingEnabled": false,
  "BackgroundModeEnabled": false,
  "DefaultBrowserSettingEnabled": false,
  "PromotionalTabsEnabled": false,
  "ShowHomeButton": false
}
EOF
chmod 644 /etc/chromium/policies/managed/maxlew.json

# ------------------------------------------------------------
# 8. Enable and check
# ------------------------------------------------------------
step "Enabling and starting the services"

systemctl set-default multi-user.target
systemctl daemon-reload
systemctl enable "$SERVICE.service"

started=0
if [[ -d /run/systemd/system ]]; then
  systemctl restart "$SERVICE.service" || true
  for i in $(seq 1 20); do
    if curl -sf -o /dev/null "http://localhost:3000/splashscreen"; then started=1; break; fi
    sleep 1
  done
fi

printf '\n'
echo "node       $(/usr/local/bin/node --version)"
echo "chromium   $(chromium --version 2>/dev/null | head -1 || echo missing)"
if (( started )); then
  echo "app        running, answers on http://localhost:3000"
else
  warn "The app did not answer yet. Check: journalctl -u $SERVICE -n 50"
fi

cat <<EOF

==============================================================
 Installation finished.

 Next steps:
  1. Add cameras (only changes config/cameras.json):
       cd $APP_DIR && sudo -u $KIOSK_USER ./maxlew.sh add
     then restart the app so it reads them:
       sudo systemctl restart $SERVICE
  2. Reboot. The machine logs in as '$KIOSK_USER' and starts the kiosk by itself.
  3. Test sound and the touch screen.

 Useful:
   systemctl status $SERVICE
   journalctl -u $SERVICE -f
   Install log: $LOG
==============================================================
EOF

if (( DO_REBOOT )); then
  echo "Rebooting in 5 seconds..."
  sleep 5
  systemctl reboot
fi
