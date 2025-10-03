#!/bin/bash
#
# Run as root

set -e

# === 1. Install required packages ===
apt update
apt install -y --no-install-recommends \
  xorg \
  xserver-xorg-legacy \
  openbox \
  chromium \
  unclutter-xfixes \
  console-data \
  xserver-xorg-input-void

# === 2. Allow X to start without root ===
sed -i 's/^allowed_users.*/allowed_users=anybody/' /etc/X11/Xwrapper.config || echo "allowed_users=anybody" >> /etc/X11/Xwrapper.config

# === 3. Add user to groups (maxlew user) ===
usermod -aG video,audio,input maxlew

# === 4. Enable autologin for kiosk on TTY1 ===
mkdir -p /etc/systemd/system/getty@tty1.service.d
cat >/etc/systemd/system/getty@tty1.service.d/override.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin maxlew --noclear %I $TERM
EOF

# === 5. Setup maxlew .xinitrc ===
cat > ~/.xinitrc <<'EOF'
#!/bin/bash
xset -dpms
xset s off
xset s noblank

# Hide cursor
unclutter --timeout 0 --hide-on-touch &

# Start Openbox
openbox-session &

# Start Chromium in kiosk mode
chromium \
  --noerrdialogs \
  --disable-infobars \
  --start-fullscreen \
  --kiosk "http://example.com"
EOF

chmod +x ~/.xinitrc

# === 6. Autostart X for maxlew user ===
cat > ~/.bash_profile <<'EOF'
if [[ -z \$DISPLAY ]] && [[ \$(tty) == /dev/tty1 ]]; then
  startx
fi
EOF

echo "✅ Maxlew browser setup complete."
