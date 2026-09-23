// Builds the release feed files and finds a release's installers on disk.
// Pure apart from `findArtifacts`, which only reads the folder it is given, so
// release-feeds.mjs can do all network and signing work around these.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACTS, DOWNLOAD_URL, RELEASES_URL, releaseTagUrl } from "./config.mjs";

/** Schema of `latest.json`. Bumping it strands installed copies; see config.mjs. */
export const LATEST_SCHEMA = 1;

/**
 * Look for each shippable installer of `version` anywhere under `dir`
 * (so unzipped CI artifact folders can be dropped in as they are).
 * Returns `{ found: [{ artifact, path }], missing: [artifact] }`.
 */
export function findArtifacts(dir, version) {
  const byName = new Map();
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "feeds") walk(path);
      } else if (!byName.has(entry.name)) {
        byName.set(entry.name, path);
      }
    }
  };
  walk(dir);

  const found = [];
  const missing = [];
  for (const artifact of ARTIFACTS) {
    const path = byName.get(artifact.file(version));
    if (path) found.push({ artifact, path });
    else missing.push(artifact);
  }
  return { found, missing };
}

/**
 * The notify-only feed (`latest.json`, schema 1): `base` is the currently
 * published feed, whose other channel is kept so a beta never erases the
 * stable entry.
 */
export function buildLatestFeed(base, { version, channel, notes, date }) {
  return {
    schema: LATEST_SCHEMA,
    releases_url: RELEASES_URL,
    download_url: DOWNLOAD_URL,
    channels: {
      ...(base?.channels ?? {}),
      [channel]: { version, published: date, url: releaseTagUrl(version), notes },
    },
  };
}

/**
 * One updater-plugin feed. `entries` are `{ artifact, url, signature }`;
 * each artifact is listed under every platform key it answers to.
 */
export function buildUpdaterFeed({ version, notes, pubDate, entries }) {
  const platforms = {};
  for (const { artifact, url, signature } of entries) {
    for (const key of artifact.platforms) platforms[key] = { url, signature };
  }
  return { version, notes, pub_date: pubDate, platforms };
}

/**
 * Which updater feeds a release goes into. Versions only increase, so every
 * release is the newest one available to beta testers; only stable releases
 * go into the stable feed.
 */
export function updaterChannelsFor(channel) {
  return channel === "stable" ? ["stable", "beta"] : ["beta"];
}
