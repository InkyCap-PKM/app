// Checks the colourblind-friendly colours in src/styles/themes.css (the
// `data-colourblind` blocks, switched on in Settings > Appearance).
//
// For the light and dark versions it checks that:
// - every colour that carries meaning is replaced, so none is left behind
//   when a new one is added to the theme;
// - each colour is readable (at least 4.5:1 contrast) on every background
//   of that theme, in both background palettes;
// - the pairs people need to tell apart (error vs success, and so on) still
//   look clearly different to someone with each of the three main types of
//   colour blindness.
//
// Colour blindness is imitated with the Machado, Oliveira and Fernandes
// (2009) matrices at full strength, and "clearly different" is a distance of
// at least 15 in CIELAB colour space.

/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src", "styles", "themes.css"), "utf8");

/** The custom properties declared in the block that opens with `selector`. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`themes.css has no block for ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const props = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) props.set(m[1], m[2].trim());
  return props;
}

/** A property's hex value, following plain `var(--other)` references within
 *  the same block. */
function hexOf(props: Map<string, string>, name: string): string {
  const value = props.get(name);
  if (!value) throw new Error(`${name} is not set`);
  const alias = value.match(/^var\((--[\w-]+)\)$/);
  if (alias) return hexOf(props, alias[1]);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${name} is not a 6-digit hex: ${value}`);
  return value;
}

type Rgb = [number, number, number];

function linearRgb(hex: string): Rgb {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [channel(0), channel(1), channel(2)];
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const la = luminance(linearRgb(a));
  const lb = luminance(linearRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const SIMULATIONS: Record<string, number[][] | null> = {
  "normal vision": null,
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

function simulate(rgb: Rgb, matrix: number[][] | null): Rgb {
  if (!matrix) return rgb;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return matrix.map((row) => clamp(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])) as Rgb;
}

function lab([r, g, b]: Rgb): Rgb {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function distance(a: string, b: string, matrix: number[][] | null): number {
  const la = lab(simulate(linearRgb(a), matrix));
  const lb = lab(simulate(linearRgb(b), matrix));
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

/** Every colour the colourblind-friendly set must replace. */
const MEANING_COLOURS = [
  "--accent-danger",
  "--accent-warn",
  "--accent-success",
  "--accent-green",
  "--accent-info",
  "--accent-orange",
  "--callout-warning",
  "--mycelial-latent",
  "--mycelial-emergent",
  "--mycelial-kindred",
  "--syntax-string",
  "--syntax-mono",
  "--syntax-number",
];

/** Colours that appear side by side with different meanings. */
const MUST_DIFFER: [string, string][] = [
  ["--accent-danger", "--accent-success"],
  ["--accent-danger", "--accent-warn"],
  ["--accent-warn", "--accent-success"],
  ["--accent-info", "--accent-success"],
  ["--accent-info", "--accent-danger"],
  ["--accent-info", "--accent-warn"],
  ["--mycelial-latent", "--mycelial-emergent"],
  ["--mycelial-latent", "--mycelial-kindred"],
  ["--mycelial-emergent", "--mycelial-kindred"],
  ["--syntax-string", "--syntax-number"],
];

const MIN_CONTRAST = 4.5;
const MIN_DISTANCE = 15;
const BACKGROUNDS = ["--bg-primary", "--bg-secondary", "--bg-editor-toolbar"];

const THEMES = [
  {
    name: "light",
    palette: block(':root[data-colourblind]:not([data-theme="dark"])'),
    backgroundBlocks: [block(':root,\n[data-theme="light"]'), block('[data-palette="warm"]:not([data-theme="dark"])')],
  },
  {
    name: "dark",
    palette: block(':root[data-colourblind][data-theme="dark"]'),
    backgroundBlocks: [block('[data-theme="dark"]'), block('[data-palette="warm"][data-theme="dark"]')],
  },
];

describe.each(THEMES)("colourblind-friendly colours ($name)", ({ palette, backgroundBlocks }) => {
  const backgrounds = backgroundBlocks.flatMap((b) => BACKGROUNDS.map((name) => hexOf(b, name)));

  it("replaces every colour that carries meaning", () => {
    const missing = MEANING_COLOURS.filter((name) => !palette.has(name));
    expect(missing).toEqual([]);
  });

  it("keeps every colour readable on every background", () => {
    const failures: string[] = [];
    for (const name of MEANING_COLOURS) {
      const colour = hexOf(palette, name);
      for (const bg of backgrounds) {
        const ratio = contrast(colour, bg);
        if (ratio < MIN_CONTRAST) failures.push(`${name} ${colour} on ${bg}: ${ratio.toFixed(2)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("keeps paired colours distinct for each type of colour blindness", () => {
    const failures: string[] = [];
    for (const [a, b] of MUST_DIFFER) {
      for (const [vision, matrix] of Object.entries(SIMULATIONS)) {
        const d = distance(hexOf(palette, a), hexOf(palette, b), matrix);
        if (d < MIN_DISTANCE) failures.push(`${a} vs ${b} with ${vision}: ${d.toFixed(1)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
