// Signs a release's installers and writes the feed files that tell installed
// copies of InkyCap about it. Uploading the feeds is done by hand afterwards.
//
//   npm run release:feeds                 sign and write the feeds (release still a draft)
//   npm run release:feeds -- --partial    allow some installers to be missing
//   npm run release:feeds -- --in FILE    merge into FILE instead of the live latest.json
//   npm run release:feeds -- --test-base https://inkycap.org/releases/test
//                                         private test: feeds whose downloads point at
//                                         <base>/files/ instead of CodeFloe, written to
//                                         feeds-test/; point a test copy at it with the
//                                         `updates.feed_url` setting
//   npm run release:feeds -- --verify-with OLD.pub
//                                         check signatures against OLD.pub instead of
//                                         tauri.conf.json (only for the release that
//                                         replaces the key)
//   npm run release:feeds:check           after publishing and uploading: confirm the
//                                         download links serve the signed files and
//                                         inkycap.org serves feeds naming this version
//
// Input: every installer for the version in package.json, anywhere under
// release-artifacts/<version>/, plus release-artifacts/<version>/RELEASE-NOTES.md
// (plain text, shown in the in-app update notice).
// Output: release-artifacts/<version>/feeds/, to upload into releases/ on
// inkycap.org. Run it while the CodeFloe release is still a draft. Signing
// leaves the installers unchanged, so the files attached to the draft stay
// valid as long as they are these same files.
//
// The private signing key lives outside the repository, at
// ~/.config/inkycap-release/updater.key on each computer used for releases;
// `npm run release:check-setup` checks that computer's setup. The password is
// never stored: this command asks for it.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ARTIFACTS,
  KEY_FILE,
  LATEST_FEED_URL,
  ROOT,
  TAURI_CLI,
  artifactsDir,
  assetUrl,
  channelOf,
  readUpdaterPubkey,
  readVersion,
  updaterFeedUrl,
} from "./release/config.mjs";
import { buildLatestFeed, buildUpdaterFeed, findArtifacts, updaterChannelsFor } from "./release/feeds.mjs";
import { parsePublicKey, verifySignature } from "./release/minisign.mjs";
import { checkSetup, printResults } from "./release/check-setup.mjs";

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

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

/** Ask for a password without showing what is typed. */
function askHidden(question) {
  if (!process.stdin.isTTY) fail("Can't ask for the signing password: this isn't an interactive terminal.");
  process.stdout.write(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let typed = "";
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          done();
          resolve(typed);
          return;
        }
        if (c === "\u0003") {
          done();
          process.exit(130);
        }
        typed = c === "\u007f" || c === "\b" ? typed.slice(0, -1) : typed + c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store", headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

/**
 * Size of the file served at `url`, or an error string. Asks for one byte so
 * nothing large is downloaded; the total size comes back in Content-Range.
 */
async function remoteSize(url) {
  try {
    const res = await fetch(url, { headers: { range: "bytes=0-0" } });
    await res.body?.cancel();
    if (res.status === 206) return Number(res.headers.get("content-range")?.split("/")[1]);
    if (res.status === 200) return Number(res.headers.get("content-length"));
    return `answered ${res.status}`;
  } catch (e) {
    return e.message;
  }
}

function sign(path, password) {
  rmSync(`${path}.sig`, { force: true });
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
  delete env.TAURI_SIGNING_PRIVATE_KEY;
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  const run = spawnSync(TAURI_CLI, ["signer", "sign", "--private-key-path", KEY_FILE, path], {
    env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (run.status !== 0 || !existsSync(`${path}.sig`)) {
    fail(
      `Signing ${relative(ROOT, path)} failed. If the password was wrong, run the command again.\n\n` +
        `${(run.stderr || run.stdout || "").trim()}`,
    );
  }
  return readFileSync(`${path}.sig`, "utf8").trim();
}

async function makeFeeds(args, version, channel) {
  const testBase = typeof args["test-base"] === "string" ? args["test-base"].replace(/\/+$/, "") : null;
  if (testBase !== null && !testBase.startsWith("https://")) fail("--test-base must start with https://");
  const dir = artifactsDir(version);
  if (!existsSync(dir)) {
    fail(`No folder ${relative(ROOT, dir)}/. Put this release's installers there (the .deb, .rpm, Windows and macOS files).`);
  }

  console.log("Checking this computer's release setup:");
  if (!printResults(checkSetup(), ["signing"])) fail("Fix the items marked FIX, then run this again.");

  const notesPath = typeof args.notes === "string" ? args.notes : join(dir, "RELEASE-NOTES.md");
  if (!existsSync(notesPath)) {
    fail(`No release notes at ${relative(ROOT, notesPath)}. Write the text users should see in the update notice there.`);
  }
  const notes = readFileSync(notesPath, "utf8").trim();

  const { found, missing } = findArtifacts(dir, version);
  console.log(`\nInstallers for ${version} (${channel}):`);
  for (const a of ARTIFACTS) {
    const hit = found.find((f) => f.artifact === a);
    console.log(`  ${hit ? "ok     " : "MISSING"} ${a.label}${hit ? "" : `: expected a file named ${a.file(version)}`}`);
  }
  if (found.length === 0) fail("No installers found, so there is nothing to sign.");
  if (missing.length && !args.partial && testBase === null) {
    fail(
      "Some installers are missing. Add them, or run again with --partial to publish without them\n" +
        "(people on those platforms will see the update and use the Download button).",
    );
  }

  // Signatures must satisfy the public key that *installed* copies carry. That
  // is the one in tauri.conf.json, except in the single release that brings in
  // a new key, which is still signed with the old one.
  const pubkey = parsePublicKey(
    typeof args["verify-with"] === "string" ? readFileSync(args["verify-with"], "utf8") : readUpdaterPubkey(),
  );
  const password =
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? (await askHidden("\nUpdater key password: "));

  console.log("\nSigning and checking signatures:");
  const entries = [];
  for (const { artifact, path } of found) {
    const signature = sign(path, password);
    const check = verifySignature(readFileSync(path), signature, pubkey);
    if (!check.ok) {
      fail(
        `${artifact.label}: ${check.reason}.\n` +
          "The key file on this computer may be out of date: paste the current private key text into it again.\n" +
          "(Replacing the key? That one release is signed with the old key and checked with --verify-with.)",
      );
    }
    if (check.signedVersion && check.signedVersion.replace(/^v/, "") !== version) {
      fail(`${artifact.label}: the signature records version ${check.signedVersion}, but this release is ${version}.`);
    }
    const file = artifact.file(version);
    const url = testBase === null ? assetUrl(version, file) : `${testBase}/files/${file}`;
    entries.push({ artifact, path, signature, url });
    console.log(`  ok   ${artifact.label}`);
  }

  // A test feed starts from nothing: it must never carry the real releases.
  let base = {};
  if (testBase !== null) {
    // (nothing to merge)
  } else if (typeof args.in === "string") {
    base = JSON.parse(readFileSync(args.in, "utf8"));
  } else {
    try {
      base = await fetchJson(LATEST_FEED_URL);
    } catch (e) {
      fail(`Couldn't download the current latest.json (${e.message}).\nDownload it by hand and pass it with --in FILE.`);
    }
  }

  const now = new Date();
  const outDir = join(dir, testBase === null ? "feeds" : "feeds-test");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "updater"), { recursive: true });
  const write = (name, value) => writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);

  const date = now.toISOString().slice(0, 10);
  // A test release is offered on both channels, so the test copy finds it
  // whatever its "Include development releases" setting.
  const channels = testBase === null ? updaterChannelsFor(channel) : ["stable", "beta"];
  let latest = buildLatestFeed(base, { version, channel, notes, date });
  if (testBase !== null) latest = buildLatestFeed(latest, { version, channel: channel === "beta" ? "stable" : "beta", notes, date });
  write("latest.json", latest);
  const updater = buildUpdaterFeed({ version, notes, pubDate: now.toISOString().replace(/\.\d+Z$/, "Z"), entries });
  for (const c of channels) write(join("updater", `${c}.json`), updater);

  if (testBase !== null) {
    const shown = relative(ROOT, outDir);
    const folder = new URL(testBase).pathname.replace(/^\//, "");
    console.log(`
Test feeds written. Upload through cPanel's File Manager into the website's
${folder}/ folder (it is not linked from anywhere):

  ${shown}/latest.json       ->  ${folder}/latest.json
  ${shown}/updater/*.json    ->  ${folder}/updater/
${entries.map(({ path }) => `  ${relative(ROOT, path)}  ->  ${folder}/files/`).join("\n")}

Then point the test copy at it: in its settings.json, under "updates", set
  "feed_url": "${testBase}/latest.json"
Delete the ${folder}/ folder when the test is done.`);
    return;
  }

  const shown = relative(ROOT, outDir);
  console.log(`
Signed and written. Next:

  1. Make sure the files attached to the CodeFloe draft are exactly the ones
     signed above (from ${relative(ROOT, dir)}/), then publish the release.
  2. Upload these files through cPanel's File Manager, replacing the old ones:

     ${`${shown}/latest.json`.padEnd(`${shown}/latest.json`.length + 10)}  ->  releases/latest.json
${channels.map((c) => `     ${`${shown}/updater/${c}.json`.padEnd(`${shown}/latest.json`.length + 10)}  ->  releases/updater/${c}.json`).join("\n")}

  3. Confirm everything with:  npm run release:feeds:check`);
}

/**
 * After publishing and uploading: do the download links serve the signed
 * files, and does inkycap.org serve feeds naming this version?
 */
async function checkLive(version, channel) {
  const problems = [];

  // Downloads. Compared by size against the signed files in this computer's
  // release folder; a different file (for example a rebuild attached by
  // mistake) would fail the signature check on users' computers. From a
  // computer without that folder, the links are only checked to exist.
  console.log("Download links on CodeFloe:");
  const dir = artifactsDir(version);
  const local = existsSync(dir) ? findArtifacts(dir, version).found : [];
  let links = local.map(({ artifact, path }) => ({ artifact, size: statSync(path).size }));
  if (links.length === 0) {
    console.log(`  (no ${relative(ROOT, dir)}/ on this computer, so sizes can't be compared)`);
    links = ARTIFACTS.map((artifact) => ({ artifact, size: null }));
  }
  for (const { artifact, size } of links) {
    const url = assetUrl(version, artifact.file(version));
    const served = await remoteSize(url);
    const ok = size === null ? typeof served === "number" : served === size;
    console.log(`  ${ok ? "ok  " : "FIX "} ${artifact.label}`);
    if (ok) continue;
    const why =
      typeof served === "number"
        ? `the file on CodeFloe (${served} bytes) is not the one that was signed (${size} bytes)`
        : `${url} ${served}`;
    problems.push(`${artifact.label}: ${why}`);
  }

  // Feeds.
  console.log("\nFeeds on inkycap.org:");
  const checkFeed = async (name, url, listed) => {
    try {
      const found = listed(await fetchJson(url));
      const ok = found === version;
      console.log(`  ${ok ? "ok  " : "FIX "} ${name}${ok ? "" : ` lists ${found ?? "(nothing)"}`}`);
      if (!ok) problems.push(`${name} lists ${found ?? "(nothing)"}, not ${version}`);
    } catch (e) {
      console.log(`  FIX  ${name}: ${e.message}`);
      problems.push(`${name}: ${e.message}`);
    }
  };
  await checkFeed("latest.json", LATEST_FEED_URL, (f) => f?.channels?.[channel]?.version);
  for (const c of updaterChannelsFor(channel)) {
    await checkFeed(`updater/${c}.json`, updaterFeedUrl(c), (f) => f?.version);
  }

  if (problems.length) {
    fail(
      "Not finished yet:\n  " +
        problems.join("\n  ") +
        "\n\nDownload links: publish the release, with the signed files attached.\n" +
        "Feeds: upload the files from release-artifacts/<version>/feeds/ into releases/ on inkycap.org.\n" +
        "Until this passes, the Upgrade button may fail; the Download button still works.",
    );
  }
  console.log(`\nAll done: installed copies will now find ${channel} ${version}.`);
}

const args = parseArgs(process.argv.slice(2));
const version = readVersion();
const channel = channelOf(version);
if (args.check) await checkLive(version, channel);
else await makeFeeds(args, version, channel);
