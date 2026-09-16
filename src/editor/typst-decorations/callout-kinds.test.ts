// The editor's callout table and the notebox library's must agree.
//
// `inkycap-notebox/lib.typ` decides what a compiled callout looks like; this
// module's copy decides what the visual editor draws while you write. When the
// two drifted apart, six kinds rendered one colour on screen and a different
// one in the exported PDF. These tests read lib.typ and compare, so the next
// change to either side has to touch both.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CALLOUT_KINDS,
  CALLOUT_COLORS,
  calloutColor,
  calloutColorLiteral,
  parseCalloutColorLiteral,
  readCalloutColorArg,
} from "./callout-kinds";
import en from "../../locales/en.json";

// Vitest runs from the repo root (see the other source-scanning tests).
const LIB_TYP = readFileSync(join(process.cwd(), "inkycap-notebox/lib.typ"), "utf8");

/** The `key: rgb("#hex")` pairs of a dictionary in lib.typ. */
function typstColorDict(name: string): Record<string, string> {
  const start = LIB_TYP.indexOf(`#let ${name} = (`);
  expect(start, `${name} not found in lib.typ`).toBeGreaterThanOrEqual(0);
  const body = LIB_TYP.slice(start, LIB_TYP.indexOf("\n)", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*([a-z-]+):\s*rgb\("(#[0-9a-fA-F]{3,8})"\)/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

describe("callout kinds", () => {
  it("lists exactly the kinds the notebox library defines", () => {
    expect(Object.keys(typstColorDict("_callout-colors")).sort()).toEqual(
      [...CALLOUT_KINDS].sort(),
    );
  });

  it("draws each kind in the colour the notebox library compiles it in", () => {
    expect(CALLOUT_COLORS).toEqual(typstColorDict("_callout-colors"));
  });

  it("has a heading word for every kind in the UI language", () => {
    for (const kind of CALLOUT_KINDS) {
      expect(en, `missing locale key for ${kind}`).toHaveProperty("callout.kind." + kind);
    }
  });

  it("reads and writes the colour override in the form lib.typ accepts", () => {
    expect(calloutColorLiteral("#ff9100")).toBe('rgb("#ff9100")');
    expect(parseCalloutColorLiteral('rgb("#ff9100")')).toBe("#ff9100");
    expect(parseCalloutColorLiteral("red")).toBeNull();
    expect(parseCalloutColorLiteral(null)).toBeNull();
    // Written form round-trips out of a whole argument list.
    expect(readCalloutColorArg('#callout("note", color: rgb("#ff9100"))[')).toBe("#ff9100");
    expect(readCalloutColorArg('#callout("note")[')).toBeNull();
  });

  it("falls back to the kind's colour, and to note's for an unknown kind", () => {
    expect(calloutColor("warning", null)).toBe(CALLOUT_COLORS.warning);
    expect(calloutColor("warning", "#123456")).toBe("#123456");
    expect(calloutColor("ponder", null)).toBe(CALLOUT_COLORS.note);
  });
});
