#!/usr/bin/env python3
"""Rebuild the Windows .ico and macOS .icns crisply from the vector master.

`npx tauri icon` produces icon.ico / icon.icns by rasterizing the 1024px master
once and DOWNSCALING to every embedded size, which softens the small frames.
This rebuilds both containers with each member image rasterized DIRECTLY from
the SVG at its native resolution (rsvg anti-aliases for the target size instead
of squashing a big raster), so Windows Explorer / the taskbar and the macOS
Dock / Finder show a sharp icon at every size.

The Linux hicolor PNGs + scalable SVG are handled separately by
scripts/sharpen-linux-icons.mjs; this script only touches the two packaged
container formats. Run via `npm run icons`, which invokes it after `tauri icon`.

Dependencies (host-only, dev-time): rsvg-convert (librsvg2-bin) + Pillow. If
either is missing the script warns and exits 0, leaving tauri's icons in place
rather than failing the build.
"""
import io
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASTER = ROOT / "design-assets/inkycap-tile-ink.svg"
ICONS = ROOT / "src-tauri/icons"

# Windows ICO: the sizes Explorer/taskbar/shell pick across DPI settings.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
# macOS ICNS: the standard ladder incl. retina (@2x) variants up to 1024.
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]


def _bail(msg: str) -> None:
    print(f"[sharpen-win-mac-icons] {msg} — skipping (tauri's icons kept).")
    sys.exit(0)


if shutil.which("rsvg-convert") is None:
    _bail("rsvg-convert not found (install librsvg2-bin)")
try:
    from PIL import Image
except ImportError:
    _bail("Pillow not found (pip install Pillow)")


def raster(px: int) -> "Image.Image":
    """Rasterize the master SVG to a px×px RGBA image, straight from vector."""
    png = subprocess.run(
        ["rsvg-convert", "-w", str(px), "-h", str(px), str(MASTER)],
        capture_output=True,
        check=True,
    ).stdout
    return Image.open(io.BytesIO(png)).convert("RGBA")


# Windows .ico — distinct crisp frame per size (append_images keeps each as-is
# rather than downscaling from one source).
ico_frames = [raster(s) for s in ICO_SIZES]
ico_frames[-1].save(ICONS / "icon.ico", format="ICO", append_images=ico_frames[:-1])
print(f"[sharpen-win-mac-icons] icon.ico rebuilt from vector ({', '.join(map(str, ICO_SIZES))} px)")

# macOS .icns — Pillow maps the provided images onto the icns slot ladder.
icns_frames = [raster(s) for s in ICNS_SIZES]
icns_frames[-1].save(ICONS / "icon.icns", format="ICNS", append_images=icns_frames[:-1])
print(f"[sharpen-win-mac-icons] icon.icns rebuilt from vector (up to {ICNS_SIZES[-1]} px)")
