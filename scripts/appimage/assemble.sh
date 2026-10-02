#!/usr/bin/env bash
# Turn an InkyCap .deb into a self-contained AppImage. Runs INSIDE an
# ubuntu:26.04 container started by scripts/build-appimage.sh; see that script
# for why the AppImage is built this way.
#
# Inputs (environment): DEB (path to the .deb), OUT (output file path),
# HOST_UID/HOST_GID (owner to hand the output back to).
#
# quick-sharun (from pkgforge-dev/Anylinux-AppImages) copies the program and
# every library it loads, including glibc and the graphics drivers, into the
# AppImage, so nothing is taken from the user's system except the kernel. It
# is pinned to one commit and checked against the hash below. It in turn pins
# and hash-checks every tool it downloads (sharun, appimagetool, …).
set -euo pipefail

QUICK_SHARUN_COMMIT="5d00649d56d4196e59a632bd47d1660d1ee4acfa"
QUICK_SHARUN_SHA256="8026711b271c0d67d37075cd7e8c50dbd9fa635c012f9edb92a2c0d41573664b"

export DEBIAN_FRONTEND=noninteractive
apt-get update
# Installing the .deb itself pulls in exactly the libraries it declares
# (WebKitGTK, GTK, the GStreamer plugins). The rest is what quick-sharun needs:
# strace and a virtual display to watch which libraries the app loads while
# it runs, bubblewrap and xdg-dbus-proxy for WebKit's sandbox,
# glib-networking for TLS in the webview, and glycin-loaders, the programs
# GTK's image library runs to decode icons and other images.
apt-get install -y --no-install-recommends \
  "$DEB" \
  ca-certificates wget file binutils patchelf strace xvfb xauth dbus-x11 \
  bubblewrap xdg-dbus-proxy glib-networking libnss-mdns \
  gstreamer1.0-gl glycin-loaders

wget -q -O /usr/local/bin/quick-sharun \
  "https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/$QUICK_SHARUN_COMMIT/useful-tools/quick-sharun.sh"
echo "$QUICK_SHARUN_SHA256  /usr/local/bin/quick-sharun" | sha256sum -c -
chmod +x /usr/local/bin/quick-sharun

# Mark the program as an AppImage, which is what lets the in-app Upgrade
# replace it (src-tauri/src/commands/upgrade.rs). Tauri's own bundler marks
# each package the same way: the build leaves a fixed-length marker string in
# the binary and the bundler overwrites it with one of equal length.
sed -i 's/__TAURI_BUNDLE_TYPE_VAR_DEB/__TAURI_BUNDLE_TYPE_VAR_APP/' /usr/bin/inkycap
if ! grep -q __TAURI_BUNDLE_TYPE_VAR_APP /usr/bin/inkycap; then
  echo "The .deb's program has no bundle-type marker to set." >&2
  exit 1
fi

WORK="$(mktemp -d)"
cd "$WORK"
export APPDIR="$WORK/AppDir"
export ICON=/usr/share/icons/hicolor/512x512/apps/inkycap.png
export DESKTOP=/usr/share/applications/InkyCap.desktop
export OUTPATH="$WORK/dist"
export OUTNAME="$(basename "$OUT")"
# Bundle GStreamer, which plays #video and #audio embeds.
export DEPLOY_GSTREAMER=1

# The glycin loaders are named explicitly because quick-sharun only looks for
# them under /usr/lib, and Ubuntu installs them under /usr/libexec. Without
# them GTK aborts the first time it draws a PNG icon from the user's theme.
quick-sharun /usr/bin/inkycap /usr/bin/inkycap-tinymist \
  /usr/libexec/glycin-loaders/*/*

# quick-sharun's test run can't catch a missing loader, because the build
# container has no icon theme that makes GTK decode an image. Check directly
# that every loader the bundled glycin settings name is in the AppImage.
for exec_name in $(sed -n 's/^Exec=//p' "$APPDIR"/share/glycin-loaders/*/conf.d/*.conf | sort -u); do
  if [ ! -e "$APPDIR/bin/$exec_name" ]; then
    echo "Image loader $exec_name is named in the glycin settings but not bundled." >&2
    exit 1
  fi
done

# Tauri looks for bundled resources (the license texts) in ../lib/InkyCap
# next to the program, which quick-sharun places in shared/bin.
mkdir -p "$APPDIR/shared/lib"
cp -a /usr/lib/InkyCap "$APPDIR/shared/lib/InkyCap"

quick-sharun --make-appimage
# Starts the AppImage on a virtual display and fails if it doesn't keep running.
quick-sharun --test "$OUTPATH/$OUTNAME"

install -m755 "$OUTPATH/$OUTNAME" "$OUT"
chown "${HOST_UID:-0}:${HOST_GID:-0}" "$OUT"
