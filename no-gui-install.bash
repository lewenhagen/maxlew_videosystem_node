# #!/bin/bash
# #
# # Run as root

# set -e

# # === 1. Install required packages ===
# apt update
# apt install -y --no-install-recommends \
#   xorg \
#   xserver-xorg-legacy \
#   openbox \
#   chromium \
#   unclutter-xfixes \
#   console-data \
#   xserver-xorg-input-void

# # === 2. Allow X to start without root ===
# sed -i 's/^allowed_users.*/allowed_users=anybody/' /etc/X11/Xwrapper.config || echo "allowed_users=anybody" >> /etc/X11/Xwrapper.config

# # === 3. Add user to groups (maxlew user) ===
# usermod -aG video,audio,input maxlew

# # === 4. Enable autologin for kiosk on TTY1 ===
# mkdir -p /etc/systemd/system/getty@tty1.service.d
# cat >/etc/systemd/system/getty@tty1.service.d/override.conf <<'EOF'
# [Service]
# ExecStart=
# ExecStart=-/sbin/agetty --autologin maxlew --noclear %I $TERM
# EOF

# # === 5. Setup maxlew .xinitrc ===
# cat > ~/.xinitrc <<'EOF'
# #!/bin/bash
# xset -dpms
# xset s off
# xset s noblank

# # Hide cursor
# unclutter --timeout 0 --hide-on-touch &

# # Start Openbox
# openbox-session &

# # Start Chromium in kiosk mode
# chromium \
#   --noerrdialogs \
#   --disable-infobars \
#   --start-fullscreen \
#   --kiosk "http://example.com"
# EOF

# chmod +x ~/.xinitrc

# # === 6. Autostart X for maxlew user ===
# cat > ~/.bash_profile <<'EOF'
# if [[ -z \$DISPLAY ]] && [[ \$(tty) == /dev/tty1 ]]; then
#   startx
# fi
# EOF

# echo "✅ Maxlew browser setup complete."

#!/bin/bash
#
# Debian NUC Kiosk Setup Script
# Run as root: sudo bash setup-kiosk.sh
#
# What this does:
#   1. Installs Node.js 20, Xorg, Openbox, Chromium
#   2. Fixes file ownership for the kiosk user
#   3. Configures autologin on TTY1
#   4. Sets up systemd service for the Node.js app
#   5. Autostart X -> Chromium on login

set -e

# ============================================================
# CONFIGURATION — edit these before running
# ============================================================
KIOSK_USER="maxlew"
KIOSK_USER_HOME="/home/${KIOSK_USER}"
APP_DIR="${KIOSK_USER_HOME}/maxlew:videosystem_node"        # path to your Node.js app
APP_ENTRY="index.js"                   # entry point
KIOSK_URL="http://localhost:3000"       # URL Chromium opens
NODE_VERSION="20"                       # Node.js major version
# ============================================================

echo ""
echo "=========================================="
echo "  Debian NUC Kiosk Setup"
echo "  User: ${KIOSK_USER}"
echo "  App:  ${APP_DIR}/${APP_ENTRY}"
echo "  URL:  ${KIOSK_URL}"
echo "=========================================="
echo ""

# Bail out if not root
if [[ $EUID -ne 0 ]]; then
  echo "❌ This script must be run as root (sudo bash setup-kiosk.sh)"
  exit 1
fi

# Bail out if kiosk user doesn't exist
if ! id "${KIOSK_USER}" &>/dev/null; then
  echo "❌ User '${KIOSK_USER}' does not exist. Create it first:"
  echo "   adduser ${KIOSK_USER}"
  exit 1
fi

# ============================================================
# 1. System update
# ============================================================
echo "→ Updating package lists..."
apt update

# ============================================================
# 2. Install Node.js via NodeSource
# ============================================================
echo "→ Installing Node.js ${NODE_VERSION}..."
if ! command -v node &>/dev/null; then
  apt install -y curl
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt install -y nodejs
else
  echo "  Node.js already installed: $(node --version)"
fi

# ============================================================
# 3. Install X / kiosk packages
# ============================================================
echo "→ Installing Xorg, Openbox, Chromium, unclutter..."
apt install -y --no-install-recommends \
  xorg \
  xserver-xorg-legacy \
  openbox \
  chromium \
  unclutter \
  console-data \
  xserver-xorg-input-void

# ============================================================
# 4. Allow X to start without root
# ============================================================
echo "→ Configuring Xwrapper..."
if [ -f /etc/X11/Xwrapper.config ]; then
  sed -i 's/^allowed_users.*/allowed_users=anybody/' /etc/X11/Xwrapper.config
else
  echo "allowed_users=anybody" > /etc/X11/Xwrapper.config
fi

# ============================================================
# 5. Add kiosk user to required groups
# ============================================================
echo "→ Adding ${KIOSK_USER} to video, audio, input groups..."
usermod -aG video,audio,input "${KIOSK_USER}"

# ============================================================
# 6. Autologin on TTY1
# ============================================================
echo "→ Configuring autologin for ${KIOSK_USER} on TTY1..."
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat > /etc/systemd/system/getty@tty1.service.d/override.conf <<EOF
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin ${KIOSK_USER} --noclear %I \$TERM
EOF

# ============================================================
# 7. .xinitrc for kiosk user (owned correctly)
# ============================================================
echo "→ Writing ${KIOSK_USER_HOME}/.xinitrc..."
cat > "${KIOSK_USER_HOME}/.xinitrc" <<EOF
#!/bin/bash

# Disable screensaver and power management
xset -dpms
xset s off
xset s noblank

# Hide cursor when idle
unclutter -idle 0 -root &

# Start Openbox window manager
openbox-session &

# Wait for Node.js app to be ready before opening Chromium
echo "Waiting for app to be ready..."
for i in \$(seq 1 30); do
  if curl -sf "${KIOSK_URL}" > /dev/null 2>&1; then
    echo "App is ready."
    break
  fi
  sleep 1
done

# Launch Chromium in kiosk mode
chromium \\
  --noerrdialogs \\
  --disable-infobars \\
  --start-fullscreen \\
  --kiosk \\
  --disable-session-crashed-bubble \\
  --disable-features=TranslateUI \\
  --check-for-update-interval=31536000 \\
  "${KIOSK_URL}"
EOF

chmod +x "${KIOSK_USER_HOME}/.xinitrc"
chown "${KIOSK_USER}:${KIOSK_USER}" "${KIOSK_USER_HOME}/.xinitrc"

# ============================================================
# 8. .bash_profile — start X on TTY1 login
# ============================================================
echo "→ Writing ${KIOSK_USER_HOME}/.bash_profile..."
cat > "${KIOSK_USER_HOME}/.bash_profile" <<'EOF'
if [[ -z $DISPLAY ]] && [[ $(tty) == /dev/tty1 ]]; then
  startx
fi
EOF

chown "${KIOSK_USER}:${KIOSK_USER}" "${KIOSK_USER_HOME}/.bash_profile"

# ============================================================
# 9. Chromium profile — prevent "restore session" prompt
#    after unclean shutdown (e.g. power loss)
# ============================================================
echo "→ Pre-configuring Chromium profile..."
CHROMIUM_PROFILE="${KIOSK_USER_HOME}/.config/chromium/Default"
mkdir -p "${CHROMIUM_PROFILE}"
cat > "${CHROMIUM_PROFILE}/Preferences" <<'EOF'
{
  "exit_type": "Normal",
  "exited_cleanly": true
}
EOF
chown -R "${KIOSK_USER}:${KIOSK_USER}" "${KIOSK_USER_HOME}/.config"

# ============================================================
# 10. Systemd service for Node.js app
# ============================================================
echo "→ Creating systemd service for Node.js app..."
cat > /etc/systemd/system/videostream.service <<EOF
[Unit]
Description=Video Stream Node.js App
After=network.target

[Service]
Type=simple
User=${KIOSK_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_ENTRY}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable videostream.service

echo ""
echo "=========================================="
echo "  ✅ Setup complete!"
echo ""
echo "  Next steps:"
echo "  1. Copy your app to: ${APP_DIR}"
echo "  2. Run: cd ${APP_DIR} && npm install"
echo "  3. Start the service: sudo systemctl start videostream"
echo "  4. Check service logs: journalctl -u videostream -f"
echo "  5. Reboot to test full kiosk boot: sudo reboot"
echo ""
echo "  Useful commands:"
echo "  sudo systemctl status videostream   — check app status"
echo "  sudo systemctl restart videostream  — restart app"
echo "  journalctl -u videostream -f        — live app logs"
echo "=========================================="