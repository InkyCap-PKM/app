#!/usr/bin/env bash
# Build a self-contained InkyCap AppImage from the Docker-built .deb.
#
# The AppImage carries every library the app loads, glibc and the graphics
# drivers included (the "anylinux" approach, see scripts/appimage/assemble.sh),
# so it doesn't mix its own libraries with the system's. That mixing is what
# made the older Tauri-built AppImage fail on distributions much newer than
# its build system, and it is also why this one runs on musl systems such as
# Alpine. It is assembled in an ubuntu:26.04 container: bundling its own
# glibc means a new base doesn't limit where it runs, while the base's
# WebKitGTK is what ships inside.
#
# Builds for the machine's own architecture (x86_64 or aarch64), from the
# .deb of the same architecture.
#
# Prerequisites: Docker, and a .deb from ./scripts/build-linux-docker.sh
# (run with --target aarch64-unknown-linux-gnu on an ARM machine).
#
# Usage:
#   scripts/build-appimage.sh
#
# Output: dist-linux/InkyCap_<version>_<amd64|aarch64>.AppImage
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

case "$(uname -m)" in
  x86_64)        DEB_ARCH=amd64; APPIMAGE_ARCH=amd64 ;;
  aarch64|arm64) DEB_ARCH=arm64; APPIMAGE_ARCH=aarch64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable (see scripts/build-linux-docker.sh)." >&2
  exit 1
fi

# The version comes from tauri.conf.json, and the .deb is picked by that exact
# name (build-linux-docker.sh has already checked the program inside reports it).
VERSION="$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")"
DEB_NAME="InkyCap_${VERSION}_${DEB_ARCH}.deb"
DEB=""
for cand in "dist-linux/$DEB_NAME" "target-docker/release/bundle/deb/$DEB_NAME"; do
  [ -f "$cand" ] && { DEB="$cand"; break; }
done
[ -n "$DEB" ] || {
  echo "No $DEB_NAME found for version $VERSION." >&2
  echo "Build it first:  ./scripts/build-linux-docker.sh --bundles deb" >&2
  exit 1; }

mkdir -p dist-linux
OUT_NAME="InkyCap_${VERSION}_${APPIMAGE_ARCH}.AppImage"
echo "==> Building $OUT_NAME from $DEB…"

# The repository is mounted read-only; only dist-linux is writable.
docker run --rm -i \
  -v "$REPO_ROOT":/app:ro \
  -v "$REPO_ROOT/dist-linux":/out \
  -e DEB="/app/$DEB" \
  -e OUT="/out/$OUT_NAME" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  ubuntu:26.04 \
  bash /app/scripts/appimage/assemble.sh

echo
echo "==> Done: dist-linux/$OUT_NAME"
ls -lh "dist-linux/$OUT_NAME"
