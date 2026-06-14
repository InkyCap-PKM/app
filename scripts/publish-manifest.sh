#!/usr/bin/env bash
# Generate the updater manifest from the signed release artifacts and publish it
# to the `pages` branch, where it is served at
# https://updates.inkycap.org/<channel>/latest.json for the in-app updater.
#
# Only updater-AUTO-install platforms are signed: Windows now (NSIS *-setup.exe),
# macOS later. The .deb/.rpm/Flatpak are package-manager (manual) installs and
# carry NO signature — the manifest's top-level `version` is what drives their
# "a newer version is available" notice. So this script only needs the signed
# Windows artifact's detached `.sig` (a small text file): copy it off the Windows
# build machine into ARTIFACTS_DIR. gen-update-manifest.mjs reads the `.sig`
# contents and derives the download URL from the artifact filename — it does not
# need the multi-megabyte installer itself to be present here.
#
# RUN ORDER (see documentation/developer/releasing.md → "Cutting a release"):
#   1. Push the tag  -> CI builds .deb/.rpm and creates a DRAFT release.
#   2. Build + attach the Windows installer (+.sig) and the Flatpak bundle.
#   3. PUBLISH the release by hand (draft asset URLs 404 until published).
#   4. Run this script. (Publishing the manifest before the release is public
#      would point users at URLs that 404.)
#
# Usage:
#   scripts/publish-manifest.sh [ARTIFACTS_DIR]
#     ARTIFACTS_DIR  directory holding the signed artifact(s) + their .sig files
#                    (default: ./release-artifacts). At minimum the Windows
#                    *-setup.exe.sig must be present.
#
# Version is read from src-tauri/tauri.conf.json; the channel is chosen by the
# RELEASE-component parity (even = stable, odd = beta), matching the CI and
# scripts/version.mjs scheme.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ARTIFACTS_DIR="${1:-./release-artifacts}"
REMOTE="git@codeberg.org:InkyCap/app.git"

[ -d "$ARTIFACTS_DIR" ] || {
  echo "Artifacts dir not found: $ARTIFACTS_DIR" >&2
  echo "Create it and copy the Windows *-setup.exe.sig into it first." >&2
  exit 1; }
if ! ls "$ARTIFACTS_DIR"/*.sig >/dev/null 2>&1; then
  echo "No .sig files in $ARTIFACTS_DIR." >&2
  echo "The manifest needs the signed Windows installer's .sig (auto-install" >&2
  echo "platforms only). Copy it off the Windows build machine." >&2
  exit 1
fi

VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')).version)")"
RELEASE="${VERSION##*.}"
if [ $((RELEASE % 2)) -eq 0 ]; then CHANNEL="stable"; else CHANNEL="beta"; fi

# Resolve the tag the release ACTUALLY lives under on the remote rather than
# assuming a `v` prefix. Releases have historically been cut both ways
# (`v26.6.2` but `26.6.6`), and the manifest's download URLs must match the
# tag the assets live under — a mismatch yields 404s the in-app updater can't
# recover from. Prefer the `v`-prefixed tag when both exist.
resolve_tag() {
  local v="$1" cand
  for cand in "v${v}" "${v}"; do
    if git ls-remote --tags "$REMOTE" "refs/tags/${cand}" | grep -q .; then
      printf '%s' "$cand"; return 0
    fi
  done
  return 1
}
TAG="$(resolve_tag "$VERSION")" || {
  echo "No release tag for ${VERSION} on ${REMOTE} (looked for v${VERSION} and ${VERSION})." >&2
  echo "Push the tag and publish the release before publishing the manifest." >&2
  exit 1; }
echo "==> Using release tag: ${TAG}"
BASE="https://codeberg.org/InkyCap/app/releases/download/${TAG}"
OUT="${REPO_ROOT}/latest.json"

echo "==> Generating manifest for ${TAG} (channel: ${CHANNEL})"
npm run manifest:gen -- \
  --base-url "${BASE}" \
  --version "${VERSION}" \
  --artifacts "${ARTIFACTS_DIR}" \
  --notes "See https://codeberg.org/InkyCap/app/releases/tag/${TAG}" \
  --out "${OUT}"

# Refuse to publish a manifest that points at URLs which 404. This catches the
# two ways a release goes wrong silently: assets still on a DRAFT release (not
# public yet), and a tag/URL mismatch. Without this guard the manifest looks
# fine but every client that tries to update hits a dead link.
echo "==> Verifying release assets resolve before publishing"
mapfile -t URLS < <(node -e '
  const fs = require("fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const p of Object.values(m.platforms || {})) console.log(p.url);
' "$OUT")
[ "${#URLS[@]}" -gt 0 ] || { echo "Generated manifest has no platform URLs." >&2; exit 1; }
for url in "${URLS[@]}"; do
  code="$(curl -sIL -o /dev/null -w '%{http_code}' "$url")"
  if [ "$code" != "200" ]; then
    echo "Asset does not resolve (HTTP ${code}): ${url}" >&2
    echo "The release may still be a draft, or the tag/URL is wrong. Aborting." >&2
    exit 1
  fi
  echo "    ok ${code}  ${url}"
done

echo "==> Publishing to pages:${CHANNEL}/latest.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --depth 1 --branch pages "$REMOTE" "$WORK/pages"
mkdir -p "$WORK/pages/${CHANNEL}"
cp "$OUT" "$WORK/pages/${CHANNEL}/latest.json"
(
  cd "$WORK/pages"
  git add "${CHANNEL}/latest.json"
  if git diff --cached --quiet; then
    echo "No manifest changes — nothing to publish."
    exit 0
  fi
  git commit -m "release: ${CHANNEL} manifest for ${TAG}"
  git push origin pages
)

echo "==> Published. Live shortly at:"
echo "    https://updates.inkycap.org/${CHANNEL}/latest.json"
