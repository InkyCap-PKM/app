#!/usr/bin/env bash
# Build a downloadable single-file Flatpak bundle of InkyCap from the
# Docker-built .deb.
#
# Runs on the HOST, not in Docker: Flatpak's premise is that the app runs
# against the org.gnome.Platform runtime regardless of host, so building here is
# correct and far simpler than flatpak-in-Docker. The .deb's glibc-2.35 binary
# runs fine against the runtime's newer glibc.
#
# Output: dist-linux/InkyCap-<version>.flatpak
#   Users install with:  flatpak install ./InkyCap-<version>.flatpak
#   (requires Flatpak with the Flathub remote, which supplies the runtime —
#   the app itself is not on Flathub.)
#
# Prereqs (one-time):
#   sudo apt install flatpak flatpak-builder
#   flatpak remote-add --if-not-exists --user flathub https://flathub.org/repo/flathub.flatpakrepo
#
# Run ./scripts/build-linux-docker.sh first so a .deb exists to package.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

APP_ID="com.inkycap.editor"
MANIFEST="flatpak/$APP_ID.yml"
RUNTIME_VER="48"
FFMPEG_VER="24.08"

command -v flatpak >/dev/null 2>&1 || {
  echo "flatpak not found. Install it:  sudo apt install flatpak flatpak-builder" >&2; exit 1; }
command -v flatpak-builder >/dev/null 2>&1 || {
  echo "flatpak-builder not found. Install it:  sudo apt install flatpak-builder" >&2; exit 1; }

# Select the .deb by EXACT version (the single source of truth is
# tauri.conf.json), not "newest mtime". The old mtime approach could grab the
# wrong build when several .debs share a timestamp (a `cp` stamps them together)
# or when stale versions linger — while still NAMING the output from
# tauri.conf.json, yielding a bundle whose filename lies about its contents.
# build-linux-docker.sh verifies the binary's reported version at build time, so
# a .deb of the matching name is trusted to contain the matching binary.
VERSION="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
DEB_NAME="InkyCap_${VERSION}_amd64.deb"
DEB=""
for cand in "dist-linux/$DEB_NAME" "target-docker/release/bundle/deb/$DEB_NAME"; do
  [ -f "$cand" ] && { DEB="$cand"; break; }
done
[ -n "$DEB" ] || {
  echo "No $DEB_NAME found for version $VERSION." >&2
  echo "Build it first:  ./scripts/build-linux-docker.sh --bundles deb" >&2
  exit 1; }
echo "==> Packaging version $VERSION from: $DEB"

# Ensure the Flathub remote and the runtime/SDK/codecs are present (user
# install, no sudo). Harmless if already installed.
flatpak remote-add --if-not-exists --user flathub \
  https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user --noninteractive flathub \
  "org.gnome.Platform//$RUNTIME_VER" \
  "org.gnome.Sdk//$RUNTIME_VER" \
  "org.freedesktop.Platform.ffmpeg-full//$FFMPEG_VER"

# Stage the .deb where the manifest's source path expects it.
cp "$DEB" flatpak/inkycap.deb
trap 'rm -f flatpak/inkycap.deb' EXIT

BUILD_DIR="flatpak/.build"
REPO_DIR="flatpak/.repo"
OUT="dist-linux/InkyCap-${VERSION}.flatpak"

# Build the app into a local OSTree repo…
flatpak-builder --user --force-clean --install-deps-from=flathub \
  --repo="$REPO_DIR" "$BUILD_DIR" "$MANIFEST"

# …then collapse that repo into a single distributable file.
mkdir -p dist-linux
flatpak build-bundle "$REPO_DIR" "$OUT" "$APP_ID"

echo
echo "==> Done: $OUT"
echo "    Users install with:  flatpak install ./$(basename "$OUT")"
echo "    (then it appears in their app menu; or double-click the file)"
