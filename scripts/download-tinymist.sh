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
# native binary the app spawns. Bump these in lockstep with TINYMIST_VERSION
# (fetch the new `sha256.sum` from the release and copy the matching lines).
declare -A EXPECTED_SHA256=(
  [x86_64-unknown-linux-gnu]="7d6b4b5b83ad81497370419d206b25617d6f5a294b73cf11aa137e041a0242f4"
  [aarch64-unknown-linux-gnu]="3aef71a2c428e25c2ab1e293391c58b842ea22479f502ec5f2eea2e3b6fe85b4"
  [x86_64-apple-darwin]="4456e6a7bff189075dc9c22d51120fc5a88894f8bb2518d2e61b9b695819bdce"
  [aarch64-apple-darwin]="3c077f74d1caa6e2cbb5d4726e5ef4f5f49e7ecb4a6742a2e7a7e72e7133ba87"
  [x86_64-pc-windows-msvc]="dc4ccb2729b48d19e85dd2ce63123ea59f1048424de9d9df44e592eccc072a60"
  [aarch64-pc-windows-msvc]="d4ac13fd5ff8cd84c98d4dc6515fc68caed8329a732874f67f1e506ec2aab5d3"
)

# Verify a downloaded archive against the pinned hash for $TARGET. Aborts if the
# hash is unknown (unrecognized target → fail closed) or doesn't match.
verify_checksum() {
  local archive="$1" target="$2"
  local expected="${EXPECTED_SHA256[$target]:-}"
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
