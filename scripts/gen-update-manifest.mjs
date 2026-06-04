// Generate the Tauri v2 updater manifest (`latest.json`) for a release.
//
// The updater plugin fetches this JSON, compares its `version` to the running
// app, and — if newer — downloads the matching platform artifact, verifies its
// minisign signature, and installs. This script assembles that manifest from
// whatever signed artifacts a release build produced: it scans a directory for
// the `.sig` files Tauri emits (one per updater artifact when
// `createUpdaterArtifacts` is on), maps each to a Tauri platform key, and pairs
// it with a download URL under the given base.
//
// It is platform-set agnostic: run it over a Linux-only build and you get a
// Linux-only manifest; collect Windows/macOS artifacts into the same directory
// (e.g. from self-hosted runners) and re-run to get a complete one.
//
// Usage:
//   node scripts/gen-update-manifest.mjs \
//     --base-url https://codeberg.org/joch/InkyCap-Notes/releases/download/v202606.1.1 \
//     --artifacts src-tauri/target/release/bundle \
//     --notes "See the release page." \
//     --out latest.json
//
// --version defaults to package.json; --date defaults to now (override for
// reproducibility). See documentation/developer/releasing.md.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const baseUrl = arg("base-url");
if (!baseUrl) {
  console.error("Missing --base-url (where release assets are downloadable).");
  process.exit(1);
}
const artifactsDir = arg("artifacts", join(ROOT, "src-tauri", "target", "release", "bundle"));
const version = arg("version", JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
const notes = arg("notes", "");
const pubDate = arg("date", "");
const outFile = arg("out", join(ROOT, "latest.json"));

/** Recursively list every file under a directory. */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Map an updater artifact filename to a Tauri platform key (`os-arch`). */
function platformKey(file) {
  const lower = file.toLowerCase();
  const arch = /aarch64|arm64/.test(lower) ? "aarch64" : "x86_64";
  if (lower.endsWith(".appimage")) return `linux-${arch}`;
  if (lower.endsWith(".app.tar.gz")) return `darwin-${arch}`;
  if (lower.endsWith("-setup.exe") || lower.endsWith(".msi") || lower.endsWith(".nsis.zip")) {
    return `windows-${arch}`;
  }
  return null;
}

const platforms = {};
for (const sigPath of walk(artifactsDir).filter((f) => f.endsWith(".sig"))) {
  const artifact = sigPath.slice(0, -4); // drop ".sig"
  const key = platformKey(artifact);
  if (!key) {
    console.warn(`Skipping unrecognized artifact: ${basename(artifact)}`);
    continue;
  }
  if (platforms[key]) {
    console.warn(`Duplicate platform ${key}; keeping ${basename(platforms[key].url)}, ignoring ${basename(artifact)}`);
    continue;
  }
  platforms[key] = {
    signature: readFileSync(sigPath, "utf8").trim(),
    url: `${baseUrl.replace(/\/$/, "")}/${basename(artifact)}`,
  };
}

if (Object.keys(platforms).length === 0) {
  console.error(`No .sig artifacts found under ${artifactsDir}. Did the build run with createUpdaterArtifacts enabled?`);
  process.exit(1);
}

const manifest = { version, notes, pub_date: pubDate || undefined, platforms };
writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${outFile} for v${version} with platforms: ${Object.keys(platforms).join(", ")}`);
