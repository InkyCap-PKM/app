// Generate InkyCap's release feed (`latest.json`).
//
// The in-app "Check for updates" reads one static JSON file on a host InkyCap
// controls, rather than a code forge's API, so the project can move forges
// without stranding installed builds. This script writes that file from the
// version in package.json, so the number can never be mistyped, and merges it
// into any existing feed so publishing a beta doesn't erase the stable entry.
//
// Usage:
//   node scripts/release-manifest.mjs                     # print the merged feed
//   node scripts/release-manifest.mjs --out latest.json   # write it
//   node scripts/release-manifest.mjs --notes NOTES.md    # take notes from a file
//   node scripts/release-manifest.mjs --verify latest.json  # check, change nothing
//
// `--verify` exits non-zero when the published feed doesn't yet name the
// version in package.json for its channel. That is the guard against shipping a
// release and forgetting to upload the feed, which would leave users being told
// they are up to date when they aren't.
//
// npm aliases: release:manifest / release:manifest:verify
//
// The consumer is src-tauri/src/commands/updates.rs; the runbook is
// documentation/developer/releasing.md.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");

// Feed schema this script emits. Bumping it strands every installed build, so
// a breaking change must be published at a NEW url instead, leaving schema 1
// served at the old one. Optional keys can be added freely — the app ignores
// what it doesn't know.
const SCHEMA = 1;

// Where releases live today. These are the only forge-specific strings left in
// the project's shipping path: change them here, regenerate, upload, and every
// installed build follows without an app release.
const RELEASES_URL = "https://codefloe.com/InkyCap/app/releases";
const RELEASE_TAG_URL = (version) => `${RELEASES_URL}/tag/v${version}`;
const DOWNLOAD_URL = "https://inkycap.org/download";

/** RELEASE (patch) parity selects the channel: odd = beta, even = stable. */
function channelOf(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!m) throw new Error(`Version "${version}" is not MAJOR.MINOR.PATCH`);
  return Number(m[3]) % 2 === 1 ? "beta" : "stable";
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Could not read JSON from ${path}: ${e.message}`);
  }
}

/** Parse `--flag value` pairs; a flag with no value is `true`. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? (i++, next) : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const version = JSON.parse(readFileSync(PKG, "utf8")).version;
const channel = channelOf(version);

// --verify: does the published feed already name this version?
if (typeof args.verify === "string") {
  const feed = readJson(args.verify);
  const published = feed?.channels?.[channel]?.version;
  if (published !== version) {
    console.error(
      `Release feed is stale: ${args.verify} lists ${channel} = ` +
        `${published ?? "(nothing)"}, but this checkout is ${version}.\n` +
        `Regenerate it with:  npm run release:manifest -- --out ${args.verify}`,
    );
    process.exit(1);
  }
  console.log(`Release feed is current: ${channel} = ${version}`);
  process.exit(0);
}

const notes =
  typeof args.notes === "string" ? readFileSync(args.notes, "utf8").trim() : "";

// Merge into the existing feed (--in, or --out if it already exists) so the
// other channel's entry survives.
const basePath =
  typeof args.in === "string"
    ? args.in
    : typeof args.out === "string" && existsSync(args.out)
      ? args.out
      : null;
const base = basePath ? readJson(basePath) : {};

const feed = {
  schema: SCHEMA,
  releases_url: RELEASES_URL,
  download_url: DOWNLOAD_URL,
  channels: {
    ...(base.channels ?? {}),
    [channel]: {
      version,
      published: new Date().toISOString().slice(0, 10),
      url: RELEASE_TAG_URL(version),
      notes,
    },
  },
};

const json = `${JSON.stringify(feed, null, 2)}\n`;
if (typeof args.out === "string") {
  writeFileSync(args.out, json);
  console.log(`Wrote ${args.out} — ${channel} ${version}`);
} else {
  process.stdout.write(json);
}
