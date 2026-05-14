# InkyCap-bundled fonts

The font files in this directory are baked into the binary at build
time via `include_bytes!` in `src-tauri/src/typst_pipeline/fonts.rs`.
They back the "InkyCap (…)" choice in each font row of the settings
panel — see `font_resolver::BUNDLED_*` constants for the family-name
mapping the resolver injects into CSS and Typst.

## Bundled set

| Role | Family (resolver constant) | Files | Source | License |
|---|---|---|---|---|
| Interface | `BUNDLED_INTERFACE` = `Inter` | Inter-{Regular,Italic,Bold,BoldItalic}.ttf | https://rsms.me/inter/ | OFL |
| Text | `BUNDLED_TEXT` = `Junicode` | Junicode-{Regular,Italic,Bold,BoldItalic}.ttf | https://github.com/psb1558/Junicode-font | OFL |

Monospace has no bundled face — the Monospace row offers System and
Custom only. Code/PKM users routinely have strong opinions about
their mono font, and the System option already produces a sane result
on every desktop (e.g. Ubuntu Mono on GNOME via gsettings, SF Mono on
macOS, Consolas on Windows).

OTF and TTF are interchangeable as far as Typst's font loader is
concerned (both are OpenType containers); the extensions in
`fonts.rs` must match the actual filenames committed here.

## Replacing or adding a face

1. Drop the file into this directory under the exact name listed
   above.
2. If you're changing the family (e.g. picking a different monospace
   font), update both:
   - the `include_bytes!` path in `fonts.rs::inkycap_bundled_fonts`
   - the corresponding `BUNDLED_*` constant in `font_resolver.rs`
     (and its mirror in `src/lib/fontResolver.ts`)
3. Rebuild — `cargo check` from `src-tauri/`.

## Why static instances over variable fonts

Typst's font matcher works reliably against fixed Regular/Italic/Bold/
BoldItalic faces; variable font lookups have caused mis-matches and
fallback-synthesis warnings in past Typst versions. Stick with the
static OTF/TTF instances when adding new faces here.
