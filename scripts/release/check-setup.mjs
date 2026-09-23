// Checks that this computer is ready to cut an InkyCap release, and says in
// plain words how to fix anything that isn't. Run it first on a new computer:
//
//   npm run release:check-setup
//
// release-feeds.mjs runs the "signing" checks itself before it starts.
// The private key lives outside the repository, at ~/.config/inkycap-release/
// updater.key (made with `npm run tauri signer generate -- -w <that path>`);
// its public half is `plugins.updater.pubkey` in src-tauri/tauri.conf.json.

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KEY_FILE, TAURI_CLI, readUpdaterPubkey } from "./config.mjs";
import { parsePublicKey, keyIdHex } from "./minisign.mjs";

const hasCommand = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;

/**
 * Every check, grouped: "signing" (needed by `npm run release:feeds`) and
 * "building" (needed by the Linux build scripts).
 * Each result is `{ group, label, ok, fix? , note? }`.
 */
export function checkSetup() {
  const results = [];
  const add = (group, label, ok, fix, note) => results.push({ group, label, ok, fix, note });

  const [major] = process.versions.node.split(".").map(Number);
  add("signing", "Node.js 20 or newer", major >= 20, "Install a current Node.js (version 20 or newer).");

  add("signing", "Tauri command-line tool installed", existsSync(TAURI_CLI), "Run `npm install` in the repository.");

  let keyOk = existsSync(KEY_FILE);
  add(
    "signing",
    `Updater key file at ${KEY_FILE}`,
    keyOk,
    "Create that file and paste the private key text into it (a new key is made with `npm run tauri signer generate`).",
  );
  if (keyOk) {
    const text = Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "base64").toString("utf8");
    keyOk = text.startsWith("untrusted comment:") && text.includes("secret key");
    add(
      "signing",
      "Updater key file contains a private key",
      keyOk,
      "The file doesn't hold a Tauri private key. Paste the private key text into it again: the whole text, nothing else.",
    );
    if (keyOk && process.platform !== "win32") {
      const private_ = (statSync(KEY_FILE).mode & 0o077) === 0;
      add("signing", "Updater key file readable only by you", private_, `Run: chmod 600 "${KEY_FILE}"`);
    }
  }

  const pubkey = readUpdaterPubkey();
  let pubOk = false;
  let note;
  let pubFix = "Put the public key text in src-tauri/tauri.conf.json under plugins.updater.pubkey.";
  if (pubkey) {
    try {
      note = `key ${keyIdHex(parsePublicKey(pubkey).keyId)}`;
      pubOk = true;
    } catch (e) {
      pubFix = `${e.message}. Copy the public key text into it again.`;
    }
  }
  add("signing", "Updater public key in tauri.conf.json", pubOk, pubFix, note);

  add("building", "Docker (Linux .deb/.rpm build)", hasCommand("docker"), "Install Docker and make sure your user can run it.");
  add("building", "flatpak (Flatpak build)", hasCommand("flatpak"), "Run: sudo apt install flatpak");
  add("building", "flatpak-builder (Flatpak build)", hasCommand("flatpak-builder"), "Run: sudo apt install flatpak-builder");

  return results;
}

/** Print results; returns true when every check in `groups` passed. */
export function printResults(results, groups = ["signing", "building"]) {
  let allOk = true;
  for (const r of results.filter((r) => groups.includes(r.group))) {
    console.log(`  ${r.ok ? "ok  " : "FIX "} ${r.label}${r.ok && r.note ? ` (${r.note})` : ""}`);
    if (!r.ok) {
      console.log(`       ${r.fix}`);
      allOk = false;
    }
  }
  return allOk;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log("Checking this computer's release setup:\n");
  const ok = printResults(checkSetup());
  console.log(ok ? "\nAll set: this computer can cut releases." : "\nFix the items marked FIX, then run this again.");
  process.exit(ok ? 0 : 1);
}
