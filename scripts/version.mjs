// InkyCap version manager.
//
// Versioning scheme:  YYYYMM.RELEASE.PATCH
//   YYYYMM   — year+month of the release (the "major"); bumped per monthly cycle
//   RELEASE  — release type / increment: ODD = user-facing/stable,
//              EVEN = development/beta work
//   PATCH    — bugfixes, patches, iterations within that release
//
// Stored as plain semver (e.g. 202606.1.1 — no leading zeros, so cargo/npm/
// tauri accept it) and kept in lockstep across package.json, src-tauri/
// Cargo.toml, and src-tauri/tauri.conf.json. The app reads it at runtime via
// the `app_version` command and shows it in Settings → Overview.
//
// Usage:
//   node scripts/version.mjs show
//   node scripts/version.mjs release [YYYYMM]   # new monthly release -> <ym>.1.1
//   node scripts/version.mjs stable             # advance to next user-facing (odd)
//   node scripts/version.mjs beta               # advance to next development (even)
//   node scripts/version.mjs patch              # increment the patch component
//
// npm aliases: version:show / version:release / version:stable / version:beta /
// version:patch  (pass a YYYYMM to release with `-- 202607`).

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");
const CARGO = join(ROOT, "src-tauri", "Cargo.toml");
const TAURI = join(ROOT, "src-tauri", "tauri.conf.json");

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) throw new Error(`Version "${v}" is not MAJOR.MINOR.PATCH`);
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

const fmt = ({ major, minor, patch }) => `${major}.${minor}.${patch}`;
const channel = (minor) => (minor % 2 === 0 ? "development / beta" : "user-facing / stable");

function currentYearMonth() {
  const d = new Date();
  return d.getFullYear() * 100 + (d.getMonth() + 1);
}

function compute(cmd, arg, cur) {
  switch (cmd) {
    case "release": {
      const ym = arg !== undefined ? Number(arg) : currentYearMonth();
      if (!/^\d{6}$/.test(String(ym))) {
        throw new Error(`release expects a 6-digit YYYYMM (got "${arg}")`);
      }
      return { major: ym, minor: 1, patch: 1 };
    }
    // To the next ODD release number (stable). From an even, that's +1; from an
    // odd, +2. Patch resets.
    case "stable":
      return { major: cur.major, minor: cur.minor + (cur.minor % 2 === 1 ? 2 : 1), patch: 1 };
    // To the next EVEN release number (development/beta).
    case "beta":
      return { major: cur.major, minor: cur.minor + (cur.minor % 2 === 0 ? 2 : 1), patch: 1 };
    case "patch":
      return { major: cur.major, minor: cur.minor, patch: cur.patch + 1 };
    default:
      return null;
  }
}

function writeAll(next) {
  const v = fmt(next);

  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  pkg.version = v;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");

  const tauri = JSON.parse(readFileSync(TAURI, "utf8"));
  tauri.version = v;
  writeFileSync(TAURI, JSON.stringify(tauri, null, 2) + "\n");

  // Cargo.toml: only the [package] version is at line-start (`^version`);
  // dependency versions live inside `name = { version = … }`, so a single
  // first-match, multiline replace is safe.
  const cargo = readFileSync(CARGO, "utf8").replace(/^version\s*=\s*"[^"]*"/m, `version = "${v}"`);
  writeFileSync(CARGO, cargo);
}

const [cmd, arg] = process.argv.slice(2);
const current = parse(JSON.parse(readFileSync(PKG, "utf8")).version);

if (!cmd || cmd === "show") {
  console.log(`Current version: ${fmt(current)}  (${channel(current.minor)})`);
  if (!cmd) {
    console.log("\nCommands: show | release [YYYYMM] | stable | beta | patch");
  }
  process.exit(0);
}

const next = compute(cmd, arg, current);
if (!next) {
  console.error(`Unknown command "${cmd}". Use: show | release [YYYYMM] | stable | beta | patch`);
  process.exit(1);
}

writeAll(next);
console.log(`${fmt(current)}  ->  ${fmt(next)}   (${channel(next.minor)})`);
console.log("Updated package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json.");
