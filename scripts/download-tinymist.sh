#!/usr/bin/env bash
# Downloads the Tinymist binary for the current (or specified) platform
# and places it in src-tauri/binaries/ with the triple-suffixed name that
# Tauri's externalBin expects.
#
# Usage:
#   ./scripts/download-tinymist.sh              # auto-detect platform
#   ./scripts/download-tinymist.sh x86_64-unknown-linux-gnu

set -euo pipefail

TINYMIST_VERSION="0.14.16"
BINARIES_DIR="$(cd "$(dirname "$0")/../src-tauri/binaries" && pwd)"

detect_target() {
  local arch os
  arch="$(uname -m)"
  os="$(uname -s)"

  case "$arch" in
    x86_64)  arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
  esac

  case "$os" in
    Linux)  echo "${arch}-unknown-linux-gnu" ;;
    Darwin) echo "${arch}-apple-darwin" ;;
    MINGW*|MSYS*|CYGWIN*) echo "${arch}-pc-windows-msvc" ;;
    *) echo "Unsupported OS: $os" >&2; exit 1 ;;
  esac
}

TARGET="${1:-$(detect_target)}"
BINARY_NAME="tinymist"
EXT=""
ARCHIVE_EXT=".tar.gz"

case "$TARGET" in
  *windows*)
    EXT=".exe"
    ARCHIVE_EXT=".zip"
    ;;
esac

OUT_PATH="${BINARIES_DIR}/tinymist-${TARGET}${EXT}"

if [[ -f "$OUT_PATH" ]]; then
  echo "Tinymist binary already exists at $OUT_PATH"
  echo "Delete it first if you want to re-download."
  exit 0
fi

RELEASE_URL="https://github.com/Myriad-Dreamin/tinymist/releases/download/v${TINYMIST_VERSION}/tinymist-${TARGET}${ARCHIVE_EXT}"

echo "Downloading tinymist v${TINYMIST_VERSION} for ${TARGET}..."
echo "  URL: ${RELEASE_URL}"
echo "  Destination: ${OUT_PATH}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

ARCHIVE_PATH="${TMPDIR}/tinymist${ARCHIVE_EXT}"

if command -v curl &>/dev/null; then
  curl -fSL --progress-bar -o "$ARCHIVE_PATH" "$RELEASE_URL"
elif command -v wget &>/dev/null; then
  wget -q --show-progress -O "$ARCHIVE_PATH" "$RELEASE_URL"
else
  echo "Neither curl nor wget found" >&2
  exit 1
fi

# Extract the binary from the archive
if [[ "$ARCHIVE_EXT" == ".tar.gz" ]]; then
  tar -xzf "$ARCHIVE_PATH" -C "$TMPDIR"
  # The binary is at the top level of the archive
  EXTRACTED="${TMPDIR}/tinymist${EXT}"
  if [[ ! -f "$EXTRACTED" ]]; then
    # Some archives nest in a directory
    EXTRACTED="$(find "$TMPDIR" -name "tinymist${EXT}" -type f | head -1)"
  fi
else
  unzip -q "$ARCHIVE_PATH" -d "$TMPDIR"
  EXTRACTED="$(find "$TMPDIR" -name "tinymist${EXT}" -type f | head -1)"
fi

if [[ -z "${EXTRACTED:-}" || ! -f "$EXTRACTED" ]]; then
  echo "Failed to find tinymist binary in archive" >&2
  exit 1
fi

mv "$EXTRACTED" "$OUT_PATH"
chmod +x "$OUT_PATH"
echo "Done. Binary saved to ${OUT_PATH}"
