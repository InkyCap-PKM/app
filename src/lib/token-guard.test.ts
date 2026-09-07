// Design-token enforcement for component stylesheets.
//
// Scans every file in `src/styles/layout/` and fails if a rule carries a raw
// hex colour, a raw stacking z-index, a raw px corner radius, or a box-shadow
// with a colour written into it. Colours belong in `src/styles/themes.css`
// as named tokens (so every theme and palette resolves them correctly), and
// stacking uses the `--z-menu` < `--z-modal` < `--z-toast` scale. This mirrors
// the source-scanning enforcement used elsewhere (i18n-coverage.test.ts on the
// frontend; utf8_safety.rs and path_safety.rs on the Rust side).
//
// The box-shadow rule exists because floating surfaces drifted: several menus
// and toasts had hand-rolled shadows that a retune of `--popup-shadow` would
// silently skip. It only rejects a colour *literal* inside the value, so the
// many legitimate shadows built from tokens — accent bars, focus rings,
// keyframe pulses — pass untouched.
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
// A colour written straight into a box-shadow. Hex is already covered by
// RAW_HEX, so this only needs the functional forms.
const RAW_SHADOW_COLOUR = /\brgba?\(/;

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

/** Indices of every line that forms part of a `box-shadow:` declaration. A
 *  shadow value is often spread over several lines, so the colour check can't
 *  look at one line in isolation. Matching on `box-shadow:` with the colon
 *  keeps `transition: box-shadow …` out of the set. */
function shadowDeclarationLines(code: string[]): Set<number> {
  const lines = new Set<number>();
  let open = false;
  code.forEach((line, i) => {
    let rest = line;
    if (!open) {
      const at = rest.indexOf("box-shadow:");
      if (at === -1) return;
      open = true;
      rest = rest.slice(at);
    }
    lines.add(i);
    if (rest.includes(";")) open = false;
  });
  return lines;
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
    it(`${file} uses tokens, not raw colours, z-indexes, radii or shadows`, () => {
      const source = readFileSync(join(LAYOUT_DIR, file), "utf8");
      const { code, raw } = codeLines(source);
      const shadowLines = shadowDeclarationLines(code);
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
        if (shadowLines.has(i) && RAW_SHADOW_COLOUR.test(line)) {
          violations.push(
            `${file}:${i + 1} colour written into a box-shadow — use --popup-shadow / --modal-shadow, or a var(--…) colour token`,
          );
        }
      });
      expect(violations, violations.join("\n")).toEqual([]);
    });
  }
});
