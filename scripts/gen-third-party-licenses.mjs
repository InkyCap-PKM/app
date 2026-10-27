// Generate the third-party licence notices for everything InkyCap distributes
// (every Rust crate in the binary and npm package in the bundle), reproducing
// each component's copyright and licence text as MIT, BSD, ISC, Apache etc.
// require.
//
// Offline and reproducible: reads the resolved dependency graph (`cargo
// metadata --offline`, `npm ls --omit=dev`) and the licence files already in
// the cargo registry and `node_modules`.
//
// Outputs (bundled via `bundle.resources` in tauri.conf.json):
//   src-tauri/licenses/THIRD-PARTY-rust.txt
//   src-tauri/licenses/THIRD-PARTY-js.txt
//
// Run with `npm run licenses:gen`. Every version bump runs `npm run
// licenses:refresh`, which first fetches crate sources missing locally (`cargo
// fetch`; Linux builds never fetch the Windows- and macOS-only crates), so
// release commits have current notices.
//
// Scope:
//   - Rust: normal and build dependencies, transitively, for all platforms (one
//     file covers every build). Dev-only crates aren't distributed and are left
//     out.
//   - JS: production dependencies only (`--omit=dev`).
//   - The readable acknowledgements are in Settings → Sources; these files are
//     the complete legal list.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const OUT_DIR = join(SRC_TAURI, "licenses");

const SEP = "=".repeat(78);
const SUB = "-".repeat(78);
const MAX_FILE_BYTES = 256 * 1024;

// Files inside a package directory that carry licence/copyright text.
const LICENCE_RE = /^(licen[sc]e|copying|copyright|notice|unlicense|patents)([._-].*)?(\.(txt|md|rst))?$/i;

/** Collect verbatim licence/copyright texts found in a package directory.
 *  `preferred` is an explicit file (Cargo's `license-file`) tried first. */
function collectLicenceTexts(dir, preferred) {
  const blocks = [];
  const tried = new Set();
  const readOne = (name) => {
    const p = isAbsolute(name) ? name : join(dir, name);
    if (tried.has(p)) return;
    tried.add(p);
    try {
      const st = statSync(p);
      if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) return;
      const text = readFileSync(p, "utf8").replace(/\r\n/g, "\n").trimEnd();
      if (text.trim()) blocks.push({ name: name.split("/").pop(), text });
    } catch {
      /* unreadable / missing — skip */
    }
  };
  if (preferred) readOne(preferred);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    /* ignore */
  }
  for (const f of entries.sort()) {
    if (LICENCE_RE.test(f)) readOne(f);
  }
  return blocks;
}

/**
 * Build one notices document for a set of components. Identical licence texts
 * are printed once: many crates ship the same Apache-2.0 text (copyright is in
 * NOTICE files), which would otherwise repeat hundreds of times. MIT/BSD texts
 * carry their own copyright, so they only merge when truly identical.
 *
 * Layout:
 *   PART 1: every component, with its metadata and `License texts: #n`
 *   PART 2: each unique licence text, numbered, with its "Used by" list
 */
function buildDocument(title, scope, components) {
  const sorted = [...components].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );

  // Intern unique licence texts; assign a stable #id on first sight.
  const unique = new Map(); // hash -> { id, name, text, users: [] }
  let nextId = 1;
  for (const c of sorted) {
    const label = `${c.name} ${c.version || ""}`.trim();
    c.refs = [];
    for (const t of c.texts) {
      const hash = createHash("sha1").update(t.text).digest("hex");
      let entry = unique.get(hash);
      if (!entry) {
        entry = { id: nextId++, name: t.name, text: t.text, users: [] };
        unique.set(hash, entry);
      }
      entry.users.push(label);
      if (!c.refs.includes(entry.id)) c.refs.push(entry.id);
    }
  }
  const texts = [...unique.values()].sort((a, b) => a.id - b.id);

  const componentBlocks = sorted.map((c) => {
    const lines = [SEP, `${c.name} ${c.version || ""}`.trim()];
    if (c.license) lines.push(`License: ${c.license}`);
    if (c.authors) lines.push(`Authors: ${c.authors}`);
    if (c.repository) lines.push(`Repository: ${c.repository}`);
    if (c.refs.length) {
      lines.push(`License text${c.refs.length > 1 ? "s" : ""}: ${c.refs.map((n) => `#${n}`).join(", ")}`);
    } else {
      lines.push(
        `(No licence file in package; declares SPDX "${c.license || "UNKNOWN"}" —` +
          ` full text in this folder, named by SPDX identifier.)`,
      );
    }
    return lines.join("\n");
  });

  const textBlocks = texts.map((u) =>
    [
      SEP,
      `[#${u.id}]${u.name ? `  ${u.name}` : ""}`,
      `Used by ${u.users.length} component${u.users.length > 1 ? "s" : ""}: ${u.users.join(", ")}`,
      SUB,
      u.text,
    ].join("\n"),
  );

  return [
    SEP,
    title,
    SEP,
    "",
    "AUTOGENERATED by scripts/gen-third-party-licenses.mjs — do not edit by hand.",
    "Regenerate with: npm run licenses:gen",
    "",
    scope,
    "",
    `Components: ${sorted.length}    Unique licence texts: ${texts.length}`,
    "Identical licence texts are listed once in PART 2 and referenced by #id.",
    "",
    "",
    SEP,
    `PART 1 — COMPONENTS (${sorted.length})`,
    SEP,
    "",
    componentBlocks.join("\n\n"),
    "",
    "",
    SEP,
    `PART 2 — LICENCE TEXTS (${texts.length} unique)`,
    SEP,
    "",
    textBlocks.join("\n\n"),
    "",
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Rust crates (normal + build deps, all targets, transitive; dev excluded)
// ----------------------------------------------------------------------------
function generateRust() {
  const raw = execFileSync("cargo", ["metadata", "--offline", "--format-version=1"], {
    cwd: SRC_TAURI,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "utf8",
  });
  const meta = JSON.parse(raw);
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const root = meta.resolve.root;

  // BFS following only normal (kind === null) and build edges.
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const id = queue.shift();
    const node = nodes.get(id);
    if (!node) continue;
    for (const dep of node.deps) {
      const kinds = dep.dep_kinds || [];
      const distributed = kinds.some((k) => k.kind === null || k.kind === "build");
      if (distributed && !seen.has(dep.pkg)) {
        seen.add(dep.pkg);
        queue.push(dep.pkg);
      }
    }
  }
  seen.delete(root);

  const components = [...seen]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license || (p.license_file ? "see licence file" : ""),
      authors: (p.authors || []).join(", "),
      repository: p.repository || "",
      texts: collectLicenceTexts(dirname(p.manifest_path), p.license_file),
    }))
    .filter(Boolean);

  const body = buildDocument(
    "InkyCap — Third-Party Rust Licences",
    "Scope: every Rust crate compiled into the InkyCap binary (normal + build\n" +
      "dependencies, transitive, across all platform targets). Dev/test-only\n" +
      "crates are excluded — they are not distributed.",
    components,
  );
  writeFileSync(join(OUT_DIR, "THIRD-PARTY-rust.txt"), body);
  return components.length;
}

// ----------------------------------------------------------------------------
// npm packages (production dependencies only)
// ----------------------------------------------------------------------------
function normaliseLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type || l).filter(Boolean).join(" / ");
  return "";
}

function normaliseRepo(pkg) {
  const r = pkg.repository;
  if (!r) return pkg.homepage || "";
  if (typeof r === "string") return r;
  return r.url || pkg.homepage || "";
}

function normaliseAuthors(pkg) {
  const one = (a) => (typeof a === "string" ? a : a && a.name ? a.name : "");
  const list = [one(pkg.author), ...(Array.isArray(pkg.contributors) ? pkg.contributors.map(one) : [])];
  return [...new Set(list.filter(Boolean))].join(", ");
}

// The resolved production dependency tree from npm.
//
// On Windows npm is `npm.cmd`, which Node won't spawn without `shell: true`
// (since the CVE-2024-27980 fix), so a plain `execFileSync("npm", …)` fails
// there. Use `npm_execpath` (npm's own entry point, set under `npm run
// licenses:gen`), which needs no shell. Only without it (a direct `node` run)
// fall back to the shell; the arguments are fixed literals, so nothing
// user-supplied reaches cmd.exe.
function npmLs() {
  const args = ["ls", "--omit=dev", "--all", "--parseable"];
  const opts = { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" };
  const execpath = process.env.npm_execpath;
  if (execpath && execpath.endsWith(".js")) {
    return execFileSync(process.execPath, [execpath, ...args], opts);
  }
  return execFileSync("npm", args, { ...opts, shell: process.platform === "win32" });
}

function generateJs() {
  const out = npmLs();
  const dirs = [...new Set(out.split("\n").map((l) => l.trim()).filter(Boolean))]
    .filter((d) => d !== ROOT && d.includes(`${join("node_modules")}`));

  const components = dirs
    .map((dir) => {
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        return null;
      }
      return {
        name: pkg.name || dir.split("node_modules/").pop(),
        version: pkg.version || "",
        license: normaliseLicense(pkg),
        authors: normaliseAuthors(pkg),
        repository: normaliseRepo(pkg),
        texts: collectLicenceTexts(dir),
      };
    })
    .filter(Boolean);

  const body = buildDocument(
    "InkyCap — Third-Party JavaScript Licences",
    "Scope: every npm production dependency shipped in the front-end bundle\n" +
      "(npm ls --omit=dev). Build-time tooling (Vite, TypeScript, Vitest, …) is\n" +
      "excluded — it is not distributed.",
    components,
  );
  writeFileSync(join(OUT_DIR, "THIRD-PARTY-js.txt"), body);
  return components.length;
}

const rust = generateRust();
const js = generateJs();
console.log(`Wrote THIRD-PARTY-rust.txt (${rust} crates) and THIRD-PARTY-js.txt (${js} packages).`);
