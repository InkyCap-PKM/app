#!/usr/bin/env bash
# Downloads the Tinymist binary for the current (or specified) platform
# and places it in src-tauri/binaries/ with the triple-suffixed name that
# Tauri's externalBin expects.
#
# Usage:
#   ./scripts/download-tinymist.sh              # auto-detect platform
#   ./scripts/download-tinymist.sh x86_64-unknown-linux-gnu

set -euo pipefail

TINYMIST_VERSION="0.15.2"
# Create the target dir before resolving its absolute path: it is gitignored,
# so on a fresh clone it doesn't exist yet and a bare `cd` would abort under
# `set -e`.
BINARIES_DIR="$(dirname "$0")/../src-tauri/binaries"
mkdir -p "$BINARIES_DIR"
BINARIES_DIR="$(cd "$BINARIES_DIR" && pwd)"

# Pinned SHA-256 of each release archive, keyed by Tauri target triple. These
# are committed to the repo (copied from the release's `sha256.sum`), so they
# are the trust anchor: a tampered or MITM'd download — or a silently-replaced
# release asset — fails verification before we ever `chmod +x` and bundle a
# native binary the app spawns. Bump these in lockstep with TINYMIST_VERSION:
# each release publishes one `<asset>.sha256` file per archive (there is no
# consolidated `sha256.sum`), so fetch the six that match the archive names
# built below and copy their hashes here, e.g.
#   curl -fsSL .../tinymist-x86_64-unknown-linux-gnu.tar.gz.sha256
#
# A `case` rather than an associative array on purpose: macOS still ships bash
# 3.2, which has no `declare -A`, and this script has to run there (both on a
# maintainer's Mac and on the macOS CI runners).
expected_sha256_for() {
  case "$1" in
    x86_64-unknown-linux-gnu)  echo "9b8a1aea6bb3fc9c39cb70496f0082bd518cfede555757bc3cb5225b05abc99b" ;;
    aarch64-unknown-linux-gnu) echo "eba8e14338cf211906d77be6b18102736222da6721e98161133fa0d8ff5ab599" ;;
    x86_64-apple-darwin)       echo "fcfcfd01376394048443f81de349d165c271c17c36579eb9a08b889b30b8c3b2" ;;
    aarch64-apple-darwin)      echo "16241868c6752aa5e8f9c162562293c7cdf69e82f54687d7886336daf2c51915" ;;
    x86_64-pc-windows-msvc)    echo "91edb0d21edca5841b896d702d8086622792d52b71a9b444d8befb0e937969ae" ;;
    aarch64-pc-windows-msvc)   echo "ed120fc474a07c5614bb8a7ecd17a649360cba26c2d9f1f96b14a8bc7b3afc11" ;;
    *)                         echo "" ;;
  esac
}

# Verify a downloaded archive against the pinned hash for $TARGET. Aborts if the
# hash is unknown (unrecognized target → fail closed) or doesn't match.
verify_checksum() {
  local archive="$1" target="$2"
  local expected
  expected="$(expected_sha256_for "$target")"
  if [[ -z "$expected" ]]; then
    echo "No pinned SHA-256 for target '$target' — refusing to install an unverified binary." >&2
    exit 1
  fi
  local actual
  if command -v sha256sum &>/dev/null; then
    actual="$(sha256sum "$archive" | awk '{print $1}')"
  elif command -v shasum &>/dev/null; then
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
  else
    echo "Neither sha256sum nor shasum found — cannot verify download." >&2
    exit 1
  fi
  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum mismatch for $target!" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    echo "Refusing to install a binary that failed verification." >&2
    exit 1
  fi
  echo "Checksum OK ($actual)"
}

# Extract a .zip without assuming `unzip` is installed. The Windows build needs
# this path, and neither a stock Git for Windows install nor GitHub's Windows
# runner image ships `unzip`; they ship 7-Zip and PowerShell instead.
extract_zip() {
  local archive="$1" dest="$2"
  if command -v unzip &>/dev/null; then
    unzip -q "$archive" -d "$dest"
  elif command -v 7z &>/dev/null; then
    7z x -bso0 -bsp0 -o"$dest" "$archive"
  elif command -v powershell &>/dev/null; then
    # PowerShell needs native Windows paths, not the MSYS/Cygwin ones bash uses.
    local win_archive="$archive" win_dest="$dest"
    if command -v cygpath &>/dev/null; then
      win_archive="$(cygpath -w "$archive")"
      win_dest="$(cygpath -w "$dest")"
    fi
    powershell -NoProfile -NonInteractive -Command \
      "Expand-Archive -LiteralPath '${win_archive}' -DestinationPath '${win_dest}' -Force"
  else
    echo "Found none of unzip, 7z or powershell - cannot extract ${archive}" >&2
    exit 1
  fi
}

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

OUT_PATH="${BINARIES_DIR}/inkycap-tinymist-${TARGET}${EXT}"

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

# Verify the download against the pinned hash before trusting it.
verify_checksum "$ARCHIVE_PATH" "$TARGET"

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
  extract_zip "$ARCHIVE_PATH" "$TMPDIR"
  EXTRACTED="$(find "$TMPDIR" -name "tinymist${EXT}" -type f | head -1)"
fi

if [[ -z "${EXTRACTED:-}" || ! -f "$EXTRACTED" ]]; then
  echo "Failed to find tinymist binary in archive" >&2
  exit 1
fi

mv "$EXTRACTED" "$OUT_PATH"
chmod +x "$OUT_PATH"
echo "Done. Binary saved to ${OUT_PATH}"
