// i18n coverage enforcement.
//
// Scans every `.tsx` file for user-facing text that bypasses the translation
// seam — bare JSX text and string literals in the `title`/`placeholder`/
// `aria-label`/`alt` attributes — and fails if any appears in a file that is
// NOT on the unmigrated allowlist below. New components are therefore protected
// from day one, while the existing backlog is tolerated until Phase 3 migrates
// it. This mirrors the source-scanning enforcement the Rust side already uses
// (see src-tauri/tests/utf8_safety.rs, path_safety.rs) and the `// utf8-safe:`
// escape-hatch convention.
//
// Lifecycle: when Phase 3 migrates a file, remove it from `UNMIGRATED` — the
// file flips from "ignored" to "enforced". A genuinely untranslatable literal
// (a brand name, a symbol) gets a `// i18n-exempt: <reason>` comment on its
// line or the line above instead.

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");
const TARGET_ATTRS = new Set(["title", "placeholder", "aria-label", "alt"]);
const EXEMPT_MARKER = "i18n-exempt:";
// "Real" text has at least two consecutive letters — this skips punctuation,
// separators, numbers, single symbols, and empty `alt=""` (decorative images).
const HAS_LETTERS = /\p{L}{2,}/u;

interface Violation {
  line: number;
  kind: string;
  text: string;
}

/** Find hardcoded UI text in a single TSX source string. */
export function scanSource(source: string): Violation[] {
  const sf = ts.createSourceFile("f.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split("\n");
  const out: Violation[] = [];

  // A `// i18n-exempt:` on the flagged line or the line directly above suppresses.
  const exempt = (line1: number) =>
    (lines[line1 - 1] ?? "").includes(EXEMPT_MARKER) ||
    (lines[line1 - 2] ?? "").includes(EXEMPT_MARKER);

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      if (HAS_LETTERS.test(node.text)) {
        // Map to the absolute offset of the first letter so the reported line
        // is where the text actually sits, not the preceding tag.
        const offset = node.pos + source.slice(node.pos, node.end).search(HAS_LETTERS);
        const line = sf.getLineAndCharacterOfPosition(offset).line + 1;
        if (!exempt(line)) out.push({ line, kind: "jsx-text", text: node.text.trim().slice(0, 50) });
      }
    } else if (ts.isJsxAttribute(node) && node.initializer && TARGET_ATTRS.has(node.name.getText(sf))) {
      const init = node.initializer;
      let literal: string | undefined;
      if (ts.isStringLiteral(init)) {
        literal = init.text;
      } else if (ts.isJsxExpression(init) && init.expression) {
        const e = init.expression;
        // Only a bare string literal is a problem; `title={t("…")}` or any
        // other expression is fine.
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) literal = e.text;
      }
      if (literal !== undefined && HAS_LETTERS.test(literal)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        if (!exempt(line)) out.push({ line, kind: `attr:${node.name.getText(sf)}`, text: literal.slice(0, 50) });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return out;
}

/** All `.tsx` files under `src/`, excluding test files. */
function collectTsx(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsx(full, acc);
    } else if (entry.name.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const rel = (abs: string) => relative(ROOT, abs).split(sep).join("/");

// ── Not-yet-migrated backlog (Phase 1/2 baseline) ────────────────────
// EMPTY: Phase 3 migrated every backlog .tsx through t()/useI18n(). Every
// enforced .tsx now stays clean. Do NOT add files here — route their text
// through t()/useI18n(), or annotate `// i18n-exempt: <reason>`.
const UNMIGRATED = new Set<string>([]);

describe("i18n coverage scanner", () => {
  it("flags bare JSX text and target-attribute string literals", () => {
    const v = scanSource(`const C = () => <button title="Save">Click here</button>;`);
    expect(v.map((x) => x.kind).sort()).toEqual(["attr:title", "jsx-text"]);
  });

  it("ignores translated calls, expressions, symbols, and empty alt", () => {
    const v = scanSource(
      `const C = () => <><img alt="" /><i>→</i><button title={t("x")}>{label()}</button></>;`,
    );
    expect(v).toEqual([]);
  });

  it("honours // i18n-exempt: on the same or preceding line", () => {
    expect(scanSource(`const C = () => <span>InkyCap</span>; // i18n-exempt: brand name`)).toEqual([]);
    expect(scanSource(`// i18n-exempt: brand name\nconst C = () => <span>InkyCap</span>;`)).toEqual([]);
  });
});

describe("i18n coverage enforcement", () => {
  it("no hardcoded UI text in enforced (non-allowlisted) .tsx files", () => {
    const offenders: string[] = [];
    for (const abs of collectTsx(SRC_DIR)) {
      const r = rel(abs);
      if (UNMIGRATED.has(r)) continue;
      const violations = scanSource(readFileSync(abs, "utf8"));
      if (violations.length > 0) {
        offenders.push(`${r}  (${violations.length}) e.g. L${violations[0].line} ${violations[0].kind}: "${violations[0].text}"`);
      }
    }
    expect(
      offenders,
      `Route UI text through t()/useI18n(), or annotate "// i18n-exempt: <reason>".\n` +
        `New/migrated .tsx must stay clean (do not add to UNMIGRATED):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("UNMIGRATED has no stale entries (file migrated or renamed)", () => {
    const stale: string[] = [];
    for (const r of UNMIGRATED) {
      try {
        if (scanSource(readFileSync(join(ROOT, r), "utf8")).length === 0) stale.push(`${r} (now clean)`);
      } catch {
        stale.push(`${r} (missing)`);
      }
    }
    expect(stale, `Remove these from UNMIGRATED:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
