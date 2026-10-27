// Make the Linux icons sharp.
//
// `npx tauri icon` renders the SVG once at 1024px and scales it down to every
// size, which blurs the small sizes of a detailed logo (the cap's thin lines,
// the glasses), especially on GNOME with fractional scaling, which scales the
// PNG again.
//
// Two fixes, both from the same SVG so they match the other platforms' icons:
//
//   1. Render each Linux PNG size directly from the SVG, anti-aliased for that
//      size.
//   2. Write a scalable `icon.svg`, which the deb installs into
//      hicolor/scalable/apps/. GNOME prefers it and renders it sharp at any
//      size.
//
// The macOS (.icns), Windows (.ico) and Store icons from `tauri icon` are left
// alone.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const MASTER = resolve(root, "design-assets/inkycap-tile-ink.svg");
const ICONS = resolve(root, "src-tauri/icons");

// Sizes the Linux .deb bundles (see bundle.icon + the hicolor mapping). Keyed
// by the exact filenames `tauri icon` emits.
const PNG_SIZES = [
  ["32x32.png", 32],
  ["64x64.png", 64],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
];

try {
  execFileSync("rsvg-convert", ["--version"], { stdio: "ignore" });
} catch {
  console.warn(
    "[sharpen-linux-icons] rsvg-convert not found — skipping. Install " +
      "librsvg2-bin to regenerate crisp Linux icons (the committed PNGs/SVG " +
      "remain in place).",
  );
  process.exit(0);
}

for (const [name, px] of PNG_SIZES) {
  const out = resolve(ICONS, name);
  execFileSync("rsvg-convert", ["-w", String(px), "-h", String(px), MASTER, "-o", out]);
  console.log(`[sharpen-linux-icons] ${name} re-rendered from vector at ${px}px`);
}

// Scalable icon installed into hicolor/scalable/apps via bundle.linux.deb.files.
const svgOut = resolve(ICONS, "icon.svg");
copyFileSync(MASTER, svgOut);
console.log("[sharpen-linux-icons] icon.svg written (scalable hicolor icon)");

// gdk-pixbuf's SVG loader (used by GNOME) only checks the first ~256 bytes for
// `<svg>` and rejects the file otherwise, so fail the build if anything pushes
// it further.
const svgHead = readFileSync(svgOut).subarray(0, 256).indexOf(Buffer.from("<svg"));
if (svgHead < 0) {
  throw new Error(
    `[sharpen-linux-icons] icon.svg has no <svg> tag within the first 256 bytes ` +
      `— gdk-pixbuf would reject it and GNOME would show a blurry icon. Keep ` +
      `<svg> at the top of the file (no leading comment).`,
  );
}
