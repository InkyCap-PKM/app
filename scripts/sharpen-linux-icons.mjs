// Post-process the icon set for crisp Linux rendering.
//
// `npx tauri icon` rasterizes the master SVG once at 1024px and then DOWNSCALES
// to every size with an image filter. For a detailed mark (the cap's thin
// "rain" lines, the glasses) that downscale turns the small sizes to mush, so
// the launcher/dock/task-switcher icon looks blurry — especially on GNOME with
// fractional scaling, which requests odd pixel sizes and then scales a
// fixed-size PNG again.
//
// Two corrections, both sourced from the same vector master so they never drift
// from what `tauri icon` produced for the other platforms:
//   1. Re-render the Linux PNG sizes DIRECTLY from the SVG at their native
//      resolution (rsvg anti-aliases for the target size instead of squashing a
//      big raster) — crisper fallback bitmaps.
//   2. Emit a scalable `icon.svg`, which the deb installs into
//      hicolor/scalable/apps/. GNOME prefers the vector and renders it sharp at
//      ANY size/scale — the thing every well-behaved GTK app ships and the real
//      cure for the "blurry at every scale" symptom.
//
// The macOS/.icns, Windows/.ico and Store tiles `tauri icon` makes are left
// untouched.
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

// Guard: gdk-pixbuf's SVG loader (GNOME's app-grid/dash/switcher rasterizer)
// sniffs only the first ~256 bytes for the `<svg>` tag. If anything (e.g. a
// leading comment) pushes it past that window the loader rejects the file and
// GNOME renders a blurry fallback. Fail the build rather than ship that.
const svgHead = readFileSync(svgOut).subarray(0, 256).indexOf(Buffer.from("<svg"));
if (svgHead < 0) {
  throw new Error(
    `[sharpen-linux-icons] icon.svg has no <svg> tag within the first 256 bytes ` +
      `— gdk-pixbuf would reject it and GNOME would show a blurry icon. Keep ` +
      `<svg> at the top of the file (no leading comment).`,
  );
}
