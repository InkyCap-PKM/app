#!/usr/bin/env bash
# Build portable InkyCap Linux artifacts (deb/AppImage/rpm) inside an Ubuntu
# 22.04 container, so the binaries link against an old glibc (2.35) and run on
# Ubuntu 22.04+ / Debian 12+ and every newer distro. Building on the host's
# bleeding-edge glibc instead silently produces binaries that install but then
# crash on older systems with "GLIBC_x.yz not found".
#
# Prerequisites: Docker installed and usable without sudo
#   sudo systemctl enable --now docker
#   sudo usermod -aG docker "$USER"   # then log out/in
#
# Usage:
#   scripts/build-linux-docker.sh                    # deb + rpm, amd64
#   scripts/build-linux-docker.sh --bundles deb      # just the deb
#   scripts/build-linux-docker.sh --bundles appimage # AppImage (best-effort; see note)
#   scripts/build-linux-docker.sh --rebuild-image    # force toolchain rebuild
#   scripts/build-linux-docker.sh --target aarch64-unknown-linux-gnu
#
# Note on bundles: deb + rpm use the host's WebKitGTK and are the reliable
# native targets. The AppImage bundles GUI/GPU libs and is fragile on hosts
# much newer than the 22.04 build base — Flatpak (scripts/build-flatpak.sh) is
# the robust "runs anywhere" option, so AppImage is no longer built by default.
#
# Artifacts are copied to ./dist-linux/. Cross-arch (aarch64) requires an
# arm64-capable Docker (native arm host, or `docker buildx` with QEMU) — on an
# amd64-only setup the default amd64 target is what works.
set -euo pipefail

IMAGE="inkycap-builder"
TARGET="x86_64-unknown-linux-gnu"
BUNDLES="deb,rpm"
REBUILD_IMAGE=0
VERBOSE=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)        TARGET="$2"; shift 2 ;;
    --bundles)       BUNDLES="$2"; shift 2 ;;
    --rebuild-image) REBUILD_IMAGE=1; shift ;;
    --verbose)       VERBOSE=1; shift ;;
    -h|--help)       awk 'NR>1 && /^#/{sub(/^# ?/,""); print; next} NR>1{exit}' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)" >&2; exit 1 ;;
  esac
done

cd "$REPO_ROOT"

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable. Start it and ensure your user is in the" >&2
  echo "'docker' group (see the prerequisites at the top of this script)." >&2
  exit 1
fi

# 1. Build the toolchain image if missing (or when forced). Docker caches the
#    layers, so re-runs are instant unless Dockerfile.build changed. The first
#    build pulls ubuntu:22.04 and installs Rust/Node/WebKitGTK (~2-3 GB).
if [[ "$REBUILD_IMAGE" == 1 ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> Building $IMAGE image (first run pulls ubuntu:22.04 + toolchain)…"
  # DOCKER_BUILDKIT=1 routes through the modern BuildKit/buildx engine instead
  # of the deprecated legacy builder (Ubuntu's docker.io defaults to legacy
  # unless this is set). buildx is already installed; this just selects it.
  DOCKER_BUILDKIT=1 docker build -t "$IMAGE" -f Dockerfile.build .
fi

# 2. Run the build inside the container.
#    -v source:           live-mounts the repo; outputs land back on the host
#    CARGO_TARGET_DIR:    kept separate from the host's src-tauri/target so the
#                         container's glibc-2.35 objects never mix with the
#                         host's glibc-2.43 objects (which would corrupt builds)
#    inkycap-cargo:       named volume caching the crate registry between runs
#                         (mounted at the registry subdir, NOT all of /root/.cargo,
#                         which would hide the rustup toolchain the image installed)
#    inkycap-node:        named volume giving the container its own node_modules,
#                         so npm ci here doesn't clobber the host's dev install
# A full transcript is tee'd to this log so failures can be inspected after the
# fact (screenshots can't hold enough scrollback). -i without -t so the combined
# stream pipes cleanly into tee; the build is non-interactive so no pseudo-TTY
# is needed.
mkdir -p "$REPO_ROOT/dist-linux"
BUILD_LOG="$REPO_ROOT/dist-linux/build.log"
echo "==> Building InkyCap ($BUNDLES) for $TARGET…  (full log: $BUILD_LOG)"
# Pass the updater signing key into the container ONLY when it's actually set on
# the host. Passing `-e VAR=""` makes the var present-but-empty inside, which
# Tauri (with createUpdaterArtifacts on) then tries to decode and rejects with
# "Missing comment in secret key". deb/rpm are not updater artifacts and need no
# signing, so for them these stay unset; only an AppImage build would want them.
# The `${arr[@]+...}` form expands to nothing on an empty array, safe under set -u.
SIGN_ENV=()
[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && \
  SIGN_ENV+=(-e "TAURI_SIGNING_PRIVATE_KEY=$TAURI_SIGNING_PRIVATE_KEY")
[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ] && \
  SIGN_ENV+=(-e "TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$TAURI_SIGNING_PRIVATE_KEY_PASSWORD")

# Without a signing key, turn OFF updater-artifact generation for this build.
# tauri.conf.json sets `createUpdaterArtifacts: true` + a `pubkey` (needed for
# the signed Windows build), and that combination makes Tauri DEMAND a private
# key on every build — it errors "a public key has been found, but no private
# key" even for .deb/.rpm, which are manual installs that never get an updater
# artifact. The `--config` override merges over the base config to disable it.
# (When a key IS present, leave the config untouched so an AppImage build could
# still produce a signed updater artifact.) Expanded UNQUOTED in the container
# so it splits into two args; the JSON's quotes survive as literals.
NOUPDATER=""
[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && \
  NOUPDATER='--config {"bundle":{"createUpdaterArtifacts":false}}'

docker run --rm -i \
  -v "$REPO_ROOT":/app \
  -v inkycap-cargo:/root/.cargo/registry \
  -v inkycap-node:/app/node_modules \
  -e CARGO_TARGET_DIR=/app/target-docker \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -e TARGET="$TARGET" -e BUNDLES="$BUNDLES" -e VERBOSE="$VERBOSE" \
  -e NOUPDATER="$NOUPDATER" \
  ${SIGN_ENV[@]+"${SIGN_ENV[@]}"} \
  "$IMAGE" \
  bash -lc '
    set -euo pipefail
    git config --global --add safe.directory /app
    ./scripts/download-tinymist.sh "$TARGET"
    npm ci
    # Force the app crate to recompile so the version in tauri.conf.json is
    # re-baked into the binary. Without this, an incremental build against the
    # persistent target-docker cache can reuse a binary compiled under the
    # PREVIOUS version — yielding packages whose metadata says the new version
    # while the binary (and Settings -> Overview) still reports the old one.
    # Cleaning just this package keeps every dependency crate cached, so the
    # rebuild stays fast. (CARGO_TARGET_DIR points at target-docker.)
    cargo clean -p inkycap --manifest-path src-tauri/Cargo.toml || true
    VERBOSE_FLAG=""
    [ "$VERBOSE" = "1" ] && VERBOSE_FLAG="--verbose"
    npm run tauri build -- $VERBOSE_FLAG --bundles "$BUNDLES" $NOUPDATER
    # Guard against a stale binary slipping through: the version the binary
    # reports at runtime must match tauri.conf.json. --version exits before any
    # GUI init, so this runs safely headless.
    EXPECT="$(node -p "require(\"./src-tauri/tauri.conf.json\").version")"
    GOT="$(/app/target-docker/release/inkycap --version)"
    if [ "$GOT" != "$EXPECT" ]; then
      echo "ERROR: built binary reports $GOT but tauri.conf.json is $EXPECT." >&2
      echo "       The compile reused a stale cached binary; clean and rebuild." >&2
      exit 1
    fi
    echo "==> Verified: built binary reports version $EXPECT"
    # The container runs as root; hand the build outputs back to the host user.
    chown -R "$HOST_UID:$HOST_GID" /app/target-docker
  ' 2>&1 | tee "$BUILD_LOG"

# 3. Collect artifacts into a predictable location.
OUT="$REPO_ROOT/dist-linux"
mkdir -p "$OUT"
find target-docker/release/bundle -type f \
  \( -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) \
  -exec cp -v {} "$OUT/" \;

echo
echo "==> Done. Artifacts in: $OUT"
ls -lh "$OUT"
