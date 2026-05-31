#!/usr/bin/env node
// i18n locale linter — run with `npm run i18n:check`.
//
// `en.json` is the source of truth. This script validates it, then diffs every
// sibling locale file against it so a translator (or CI) can see at a glance
// what still needs work. It checks three things:
//
//   1. en.json health — valid JSON, every value a string, and NO duplicate keys
//      (JSON.parse silently keeps the last of a duplicated key, so a copy-paste
//      slip would otherwise vanish without a trace).
//   2. Key parity — keys in en.json missing from a locale (untranslated), and
//      keys in a locale that no longer exist in en.json (orphaned/renamed).
//   3. Placeholder parity — a translation must carry the SAME `{name}` tokens as
//      its English source. A dropped `{detail}` or a typo'd `{cont}` would
//      otherwise ship a broken string that only fails at runtime.
//
// Exit code is 0 when everything is consistent, 1 otherwise — safe to wire into
// CI. With only en.json present (no translations yet) it validates en.json and
// reports that there is nothing to diff.
//
// The dev-only `en-XX` pseudo-locale is generated at runtime (see i18n.ts) and
// never lives on disk, so it is never checked here.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "locales");
const SOURCE_LOCALE = "en";

/** Pull the set of `{name}` placeholder tokens out of a translation string. */
function placeholders(value) {
  return new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

/** Keys that appear more than once in the raw JSON text. en.json is flat with
 *  one `"key": "value"` per line, so a line scan catches duplicates that
 *  JSON.parse would silently collapse. */
function duplicateKeys(rawText) {
  const seen = new Set();
  const dupes = new Set();
  for (const line of rawText.split("\n")) {
    const m = line.match(/^\s*"((?:[^"\\]|\\.)*)"\s*:/);
    if (!m) continue;
    const key = m[1];
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes];
}

function setDiff(a, b) {
  return [...a].filter((x) => !b.has(x));
}

const problems = [];

// ── 1. Validate the source locale ────────────────────────────────────
const sourcePath = join(LOCALES_DIR, `${SOURCE_LOCALE}.json`);
const sourceRaw = readFileSync(sourcePath, "utf8");
let source;
try {
  source = JSON.parse(sourceRaw);
} catch (e) {
  console.error(`✗ ${SOURCE_LOCALE}.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

const dupes = duplicateKeys(sourceRaw);
if (dupes.length) {
  problems.push(`${SOURCE_LOCALE}.json has ${dupes.length} duplicate key(s): ${dupes.join(", ")}`);
}

const nonString = Object.entries(source).filter(([, v]) => typeof v !== "string");
if (nonString.length) {
  problems.push(
    `${SOURCE_LOCALE}.json must be flat (string values only); offenders: ${nonString
      .map(([k]) => k)
      .join(", ")}`,
  );
}

const sourceKeys = Object.keys(source);
const sourceKeySet = new Set(sourceKeys);

// ── 2 + 3. Diff every other locale against the source ────────────────
const localeFiles = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith(".json") && basename(f, ".json") !== SOURCE_LOCALE)
  .sort();

for (const file of localeFiles) {
  const code = basename(file, ".json");
  let dict;
  try {
    dict = JSON.parse(readFileSync(join(LOCALES_DIR, file), "utf8"));
  } catch (e) {
    problems.push(`${file} is not valid JSON: ${e.message}`);
    continue;
  }

  const keys = new Set(Object.keys(dict));
  const missing = setDiff(sourceKeySet, keys);
  const orphan = setDiff(keys, sourceKeySet);

  const placeholderMismatches = [];
  for (const key of sourceKeys) {
    if (!keys.has(key)) continue;
    const want = placeholders(source[key]);
    const got = placeholders(dict[key]);
    const dropped = setDiff(want, got);
    const added = setDiff(got, want);
    if (dropped.length || added.length) {
      placeholderMismatches.push(
        `    ${key}: ${dropped.length ? `missing {${dropped.join("} {")}}` : ""}${
          dropped.length && added.length ? ", " : ""
        }${added.length ? `unexpected {${added.join("} {")}}` : ""}`,
      );
    }
  }

  const translated = sourceKeys.length - missing.length;
  const pct = sourceKeys.length ? Math.round((translated / sourceKeys.length) * 100) : 100;
  console.log(`\n${code}: ${translated}/${sourceKeys.length} keys translated (${pct}%)`);

  if (missing.length) {
    problems.push(`${file} is missing ${missing.length} key(s)`);
    console.log(`  ✗ missing ${missing.length}:`);
    for (const k of missing.slice(0, 20)) console.log(`    ${k}`);
    if (missing.length > 20) console.log(`    … and ${missing.length - 20} more`);
  }
  if (orphan.length) {
    problems.push(`${file} has ${orphan.length} orphaned key(s) not in ${SOURCE_LOCALE}.json`);
    console.log(`  ✗ orphaned ${orphan.length} (not in ${SOURCE_LOCALE}.json):`);
    for (const k of orphan.slice(0, 20)) console.log(`    ${k}`);
    if (orphan.length > 20) console.log(`    … and ${orphan.length - 20} more`);
  }
  if (placeholderMismatches.length) {
    problems.push(`${file} has ${placeholderMismatches.length} placeholder mismatch(es)`);
    console.log(`  ✗ placeholder mismatches ${placeholderMismatches.length}:`);
    placeholderMismatches.forEach((m) => console.log(m));
  }
}

// ── Report ───────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`\n✗ i18n check failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}

if (localeFiles.length === 0) {
  console.log(
    `\n✓ ${SOURCE_LOCALE}.json is healthy (${sourceKeys.length} keys). No translations on disk yet — nothing to diff.`,
  );
} else {
  console.log(`\n✓ All ${localeFiles.length} locale(s) are consistent with ${SOURCE_LOCALE}.json.`);
}
