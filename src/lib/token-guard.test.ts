// Design-token enforcement for component stylesheets.
//
// Scans every file in `src/styles/layout/` and fails if a rule carries a raw
// hex colour or a raw stacking z-index. Colours belong in `src/styles/themes.css`
// as named tokens (so every theme and palette resolves them correctly), and
// stacking uses the `--z-menu` < `--z-modal` < `--z-toast` scale. This mirrors
// the source-scanning enforcement used elsewhere (i18n-coverage.test.ts on the
// frontend; utf8_safety.rs and path_safety.rs on the Rust side).
//
// A genuinely theme-independent value (e.g. the reading view's white "paper"
// page) gets a `/* token-exempt: <reason> */` comment on its line or the line
// above. See documentation/developer/ui-styling.md.

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LAYOUT_DIR = join(process.cwd(), "src", "styles", "layout");
const EXEMPT_MARKER = "token-exempt:";
const RAW_HEX = /#[0-9a-fA-F]{3,8}\b/;
// Raw z-index of 100 or more is a stacking-scale bypass; small local values
// (1, 2, 10…) inside a component's own stacking context are fine.
const RAW_Z = /z-index:\s*(\d{3,})/;
// Corner radii come from the --radius-* scale. 0 and 50% (circles) are
// geometric, not scale values, so they stay allowed as literals.
const RAW_RADIUS = /border-radius:[^;]*?\b\d+(?:\.\d+)?px/;

/** Lines of the file with comment text blanked out (so a hex code mentioned
 *  inside a comment doesn't trip the check), plus the raw lines for the
 *  exemption-marker lookup. */
function codeLines(source: string): { code: string[]; raw: string[] } {
  const raw = source.split("\n");
  const code: string[] = [];
  let inComment = false;
  for (const line of raw) {
    let out = "";
    let i = 0;
    while (i < line.length) {
      if (inComment) {
        const end = line.indexOf("*/", i);
        if (end === -1) {
          i = line.length;
        } else {
          inComment = false;
          i = end + 2;
        }
      } else {
        const start = line.indexOf("/*", i);
        if (start === -1) {
          out += line.slice(i);
          i = line.length;
        } else {
          out += line.slice(i, start);
          inComment = true;
          i = start + 2;
        }
      }
    }
    code.push(out);
  }
  return { code, raw };
}

function isExempt(raw: string[], index: number): boolean {
  return (
    raw[index].includes(EXEMPT_MARKER) ||
    (index > 0 && raw[index - 1].includes(EXEMPT_MARKER))
  );
}

describe("design-token guard (src/styles/layout)", () => {
  const files = readdirSync(LAYOUT_DIR).filter((f) => f.endsWith(".css"));

  it("finds the layout stylesheets", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file} uses tokens, not raw hex colours or stacking z-indexes`, () => {
      const source = readFileSync(join(LAYOUT_DIR, file), "utf8");
      const { code, raw } = codeLines(source);
      const violations: string[] = [];
      code.forEach((line, i) => {
        if (isExempt(raw, i)) return;
        if (RAW_HEX.test(line)) {
          violations.push(`${file}:${i + 1} raw hex colour — use a var(--…) token from themes.css`);
        }
        const z = line.match(RAW_Z);
        if (z) {
          violations.push(`${file}:${i + 1} raw z-index ${z[1]} — use the --z-menu/--z-modal/--z-toast scale`);
        }
        if (RAW_RADIUS.test(line)) {
          violations.push(`${file}:${i + 1} raw px border-radius — use the --radius-* scale`);
        }
      });
      expect(violations, violations.join("\n")).toEqual([]);
    });
  }
});
