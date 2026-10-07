# Offline install (Debian 13, no desktop)

Installs Maxlew Videosystem as a kiosk on a machine **without internet**. You build
one bundle on a computer with internet, copy it to a USB stick, and run one script
on the target machine.

```
 computer with internet                 USB stick                  target (offline)
 make-offline-bundle.sh  ──────►  maxlew-offline-bundle.tar  ──►  bash install.sh
                                  install.sh
```

## 1. Build the bundle (once, with internet)

On any Debian/Ubuntu computer with `apt-ftparchive` (package `apt-utils`), `curl`
and `xz` installed. No root needed, nothing on the computer is changed.

```
./offline-install/make-offline-bundle.sh
```

Before you build:

* Set the license date you want in `config/.expiration.json`. The bundle ships the
  file as it is in your working tree, and the builder warns if the date has passed.
* The bundle is made from your working tree, so commit or check what you have.

The result is in `offline-install/dist/` (not committed to git):

| File | What it is |
| --- | --- |
| `maxlew-offline-bundle.tar` | The app, Node.js and every Debian package needed (several hundred MB) |
| `install.sh` | The only thing you run on the target machine |

Rebuild whenever the app or `install.sh` changes. The bundle gets the Debian
package versions that are current on the day you build it.

Build settings (environment variables): `NODE_MAJOR` (default `24`),
`DEBIAN_RELEASE` (default `trixie`; `bookworm` builds for Debian 12).

## 2. Install Debian on the target machine

Use the **DVD** image, not the netinst, so it installs without internet:
`debian-13.x.x-amd64-DVD-1.iso` from <https://cdimage.debian.org/debian-cd/current/amd64/iso-dvd/>.

In the installer:

* Skip network setup and answer **No** to "Use a network mirror?".
* In software selection, untick **Debian desktop environment** and **GNOME**. Keep
  **standard system utilities**.
* Creating a user called `maxlew` is fine. `install.sh` creates it if it is missing.

## 3. Run the installer

Copy `maxlew-offline-bundle.tar` and `install.sh` to a USB stick, in the same folder.
On the target machine, as root:

```
su -
mount /dev/sdX1 /mnt        # find the right device with: lsblk
bash /mnt/install.sh
```

Use `bash install.sh`, not `./install.sh`, so it works on a FAT stick too.

It first asks for the machine's `VIDEOSYSTEM_ID` (used for license codes). After
that it runs without questions. When it is done, reboot.

Options:

| Option | Meaning |
| --- | --- |
| `--id VALUE` | Use this `VIDEOSYSTEM_ID` and skip the question |
| `--bundle FILE` | Use this bundle instead of `maxlew-offline-bundle.tar` next to the script |
| `--reboot` | Reboot when finished |
| `--force` | Continue on a Debian release or architecture mismatch |

You need a few GB free in `/var/tmp` (about three times the size of the tar).

## What it sets up

* Debian packages from the stick (Xorg, Openbox, Chromium, sound, tools) and Node.js.
* User `maxlew` (no password), automatic login on tty1, X started on login.
* The app in `/opt/maxlew_videosystem_node`, run by the `videostream` systemd service
  (restarted automatically if it stops).
* A Chromium kiosk that opens `http://localhost:3000/splashscreen`, restarts if it
  exits, and is configured to show no dialogs or popups.
* `/etc/maxlew/maxlew.env` with the `VIDEOSYSTEM_ID`.
* A sudo rule so the shutdown page can run `systemctl poweroff`.

## After the install

* Reboot. The machine starts the kiosk by itself.
* Add cameras: press **m** in the main menu (add / edit / remove with the keyboard),
  or run `cd /opt/maxlew_videosystem_node && sudo -u maxlew ./maxlew.sh add`.
* Check the sound and the touch screen.

Useful commands:

```
systemctl status videostream
journalctl -u videostream -f
cat /var/log/maxlew-install.log
```

## Running it again

Safe to run again (for a new version). The machine's cameras, license date and
`VIDEOSYSTEM_ID` are kept; the newer license date wins. The old app folder is
moved to `/opt/maxlew_videosystem_node.bak-<date>` and can be deleted when you are
happy with the new version.

## First time

Test the whole chain on a spare machine or VM before the real machines: install,
reboot, sound, touch, a power cut, and real cameras (including pulling a camera's
network cable and plugging it back in).
