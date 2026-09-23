// Shared facts for the release scripts: where things live, which files a
// release ships, and the addresses the feeds are published at.
//
// The feed addresses below are read by installed copies of InkyCap and are
// therefore permanent. A breaking change to a feed's format goes to a NEW
// address, with the old one left serving the old format.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TAURI_CONF = join(ROOT, "src-tauri", "tauri.conf.json");
export const TAURI_CLI = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
export const KEYS_DOC = "documentation/developer/releasing.md (\"The signing key\")";

/** Per-computer folder holding the private updater key. Never inside the repo. */
export const RELEASE_HOME = join(homedir(), ".config", "inkycap-release");
export const KEY_FILE = join(RELEASE_HOME, "updater.key");

/** Where a release's downloaded build outputs are gathered (git-ignored). */
export const artifactsDir = (version) => join(ROOT, "release-artifacts", version);

// Where releases live today. Change these, regenerate the feeds, upload, and
// every installed copy follows without an app release.
export const RELEASES_URL = "https://codefloe.com/InkyCap/app/releases";
export const releaseTagUrl = (version) => `${RELEASES_URL}/tag/v${version}`;
export const assetUrl = (version, file) => `${RELEASES_URL}/download/v${version}/${file}`;
export const DOWNLOAD_URL = "https://inkycap.org/download";

// Published feeds. `latest.json` is read by the notify-only check
// (src-tauri/src/commands/updates.rs); the updater feeds are read by the
// Tauri updater plugin behind the Upgrade button.
export const FEED_BASE_URL = "https://inkycap.org/releases";
export const LATEST_FEED_URL = `${FEED_BASE_URL}/latest.json`;
export const updaterFeedUrl = (channel) => `${FEED_BASE_URL}/updater/${channel}.json`;

/**
 * The installers the Upgrade button can install, and the updater-feed keys
 * each one answers to. The plugin looks up `{os}-{arch}-{installer}` first and
 * falls back to `{os}-{arch}`. The plain key is listed only for macOS, where
 * `.app` is the one install type; on Linux and Windows a plain key would hand
 * an unknown install type the wrong package.
 *
 * The Flatpak is deliberately absent: it cannot update itself from a bundle
 * file, and the updater must never run inside it.
 */
export const ARTIFACTS = [
  { label: "Linux .deb", file: (v) => `InkyCap_${v}_amd64.deb`, platforms: ["linux-x86_64-deb"] },
  { label: "Linux .rpm", file: (v) => `InkyCap-${v}-1.x86_64.rpm`, platforms: ["linux-x86_64-rpm"] },
  { label: "Windows installer (.exe)", file: (v) => `InkyCap_${v}_x64-setup.exe`, platforms: ["windows-x86_64-nsis"] },
  { label: "Windows installer (.msi)", file: (v) => `InkyCap_${v}_x64_en-US.msi`, platforms: ["windows-x86_64-msi"] },
  {
    label: "macOS Apple silicon (.app.tar.gz)",
    file: (v) => `InkyCap_${v}_aarch64.app.tar.gz`,
    platforms: ["darwin-aarch64-app", "darwin-aarch64"],
  },
  {
    label: "macOS Intel (.app.tar.gz)",
    file: (v) => `InkyCap_${v}_x64.app.tar.gz`,
    platforms: ["darwin-x86_64-app", "darwin-x86_64"],
  },
];

export function readVersion() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

/** The last version component's parity selects the channel: odd = beta, even = stable. */
export function channelOf(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!m) throw new Error(`Version "${version}" is not MAJOR.MINOR.PATCH`);
  return Number(m[3]) % 2 === 1 ? "beta" : "stable";
}

/** The updater public key from tauri.conf.json, or null when not set yet. */
export function readUpdaterPubkey() {
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  const key = conf?.plugins?.updater?.pubkey;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}
