// InkyCap version manager.
//
// Versions are YY.MM.RELEASE:
//   YY       two-digit year
//   MM       month, 1–12
//   RELEASE  release number within the month, which also gives the channel:
//              odd  = development / beta
//              even = stable
//
// The channel is in the last part so the first two stay a calendar date. YY
// (not YYYY) keeps every part within Windows MSI's version limits (major and
// minor ≤ 255, build ≤ 65535), which the WiX bundler enforces.
//
// Stored as plain semver (e.g. 26.6.1) in package.json, src-tauri/Cargo.toml
// and src-tauri/tauri.conf.json, kept the same in all three. The app reads it
// with the `app_version` command and shows it in Settings → Overview.
//
// Usage:
//   node scripts/version.mjs show
//   node scripts/version.mjs release [YYYYMM]   # new monthly release -> YY.MM.1 (beta)
//   node scripts/version.mjs stable             # advance to next user-facing (even)
//   node scripts/version.mjs beta               # advance to next development (odd)
//   node scripts/version.mjs patch              # next release in the current channel (+2)
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
// The RELEASE (patch) component carries the channel: odd = dev/beta, even = stable.
const channel = (patch) => (patch % 2 === 1 ? "development / beta" : "user-facing / stable");

// Split a 6-digit YYYYMM into the scheme's calendar components: a two-digit
// year (the major) and a 1–12 month (the minor).
function splitYearMonth(ym) {
  if (!/^\d{6}$/.test(String(ym))) {
    throw new Error(`expected a 6-digit YYYYMM (got "${ym}")`);
  }
  return { major: Math.trunc(ym / 100) % 100, minor: ym % 100 };
}

function currentYearMonth() {
  const d = new Date();
  return d.getFullYear() * 100 + (d.getMonth() + 1);
}

function compute(cmd, arg, cur) {
  switch (cmd) {
    case "release": {
      const ym = arg !== undefined ? Number(arg) : currentYearMonth();
      // A fresh monthly cycle starts in development: release 1 (odd → beta).
      return { ...splitYearMonth(ym), patch: 1 };
    }
    // To the next EVEN release number (user-facing/stable). From an odd, that's
    // +1; from an even, +2 (a further stable iteration in the same month).
    case "stable":
      return { major: cur.major, minor: cur.minor, patch: cur.patch + (cur.patch % 2 === 0 ? 2 : 1) };
    // To the next ODD release number (development/beta).
    case "beta":
      return { major: cur.major, minor: cur.minor, patch: cur.patch + (cur.patch % 2 === 1 ? 2 : 1) };
    // Next release in the WHATEVER channel we're already in: +2 preserves the
    // odd/even parity (e.g. a bugfix to a stable build stays stable).
    case "patch":
      return { major: cur.major, minor: cur.minor, patch: cur.patch + 2 };
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

  // Only the [package] version starts a line (dependency versions are inside
  // `name = { version = … }`), so replacing the first line-start match is safe.
  const cargo = readFileSync(CARGO, "utf8").replace(/^version\s*=\s*"[^"]*"/m, `version = "${v}"`);
  writeFileSync(CARGO, cargo);
}

const [cmd, arg] = process.argv.slice(2);
const current = parse(JSON.parse(readFileSync(PKG, "utf8")).version);

if (!cmd || cmd === "show") {
  console.log(`Current version: ${fmt(current)}  (${channel(current.patch)})`);
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
console.log(`${fmt(current)}  ->  ${fmt(next)}   (${channel(next.patch)})`);
console.log("Updated package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json.");
