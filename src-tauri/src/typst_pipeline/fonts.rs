//! Font discovery for the Typst compile pipeline.
//!
//! Loads embedded fonts (typst-assets), system fonts (via fontdb), and
//! notebox-local fonts from `<notebox>/fonts/`. The combined set is used by
//! NoteboxWorld for compilation and by the `list_system_fonts` command for
//! the frontend font picker.

use std::path::Path;
use std::sync::OnceLock;

use typst::foundations::Bytes;
use typst::text::{Font, FontBook};

/// One slot per face. Embedded fonts are resolved eagerly at construction
/// time (the bytes are static so the cost is just `Font::iter` parsing). The
/// `OnceLock` shape exists so a future revision can add lazy filesystem-loaded
/// fonts without changing this struct.
pub struct FontSlot {
    font: OnceLock<Option<Font>>,
}

impl FontSlot {
    pub fn get(&self) -> Option<Font> {
        self.font.get().cloned().flatten()
    }
}

/// Load every embedded font from `typst-assets` into a `FontBook` plus a
/// parallel `Vec<FontSlot>` indexed identically. Typst calls
/// `World::font(index)` against indices into this vec.
///
/// Also includes any TTF/OTF files baked into the binary under
/// `src-tauri/assets/fonts/` via `include_bytes!`. These are the
/// InkyCap-bundled fonts (Inter, Iosevka Sans, Junicode, Atkinson
/// Hyperlegible Next) which the resolver references by family name.
pub fn load_embedded() -> (FontBook, Vec<FontSlot>) {
    let mut book = FontBook::new();
    let mut slots = Vec::new();

    for data in typst_assets::fonts() {
        let buffer = Bytes::new(data);
        for font in Font::iter(buffer) {
            book.push(font.info().clone());
            slots.push(FontSlot {
                font: OnceLock::from(Some(font)),
            });
        }
    }

    for (data, family_override) in inkycap_bundled_fonts() {
        let buffer = Bytes::new(*data);
        for font in Font::iter(buffer) {
            let mut info = font.info().clone();
            // Per-file family rename. Used to merge sibling families that
            // ship as separate binaries (e.g. iA Writer's italic file is
            // registered upstream under "<family> Italic", which would
            // hide it from `text(font: "<family>", style: "italic")`
            // lookups). Renaming the registration keeps the binary's
            // own slant/weight info intact, so Typst's face matcher
            // still picks the right face for the requested style.
            if let Some(name) = family_override {
                info.family = (*name).to_string();
            }
            book.push(info);
            slots.push(FontSlot {
                font: OnceLock::from(Some(font)),
            });
        }
    }

    (book, slots)
}

/// Static byte slices for fonts shipped with InkyCap. The files live
/// under `src-tauri/assets/fonts/` and are `include_bytes!`'d at compile
/// time. The `Option<&str>` second element overrides the family name
/// the font registers under in Typst's `FontBook` — used to merge
/// upstream sibling families (e.g. iA Writer's italic file ships under
/// `"<family> Italic"`) into a single family so that `text(style: "italic")`
/// resolves to the right face. `None` keeps the binary's own family name.
/// To add a new face, drop the TTF/OTF under that directory and append
/// an entry to this list.
fn inkycap_bundled_fonts() -> &'static [(&'static [u8], Option<&'static str>)] {
    static FONTS: &[(&[u8], Option<&str>)] = &[
        (include_bytes!("../../assets/fonts/Inter-Regular.ttf"), None),
        (include_bytes!("../../assets/fonts/Inter-Italic.ttf"), None),
        (include_bytes!("../../assets/fonts/Inter-Bold.ttf"), None),
        (include_bytes!("../../assets/fonts/Inter-BoldItalic.ttf"), None),
        (include_bytes!("../../assets/fonts/Junicode-Regular.ttf"), None),
        (include_bytes!("../../assets/fonts/Junicode-Italic.ttf"), None),
        (include_bytes!("../../assets/fonts/Junicode-Bold.ttf"), None),
        (include_bytes!("../../assets/fonts/Junicode-BoldItalic.ttf"), None),
        (include_bytes!("../../assets/fonts/JuliaMono-Regular.ttf"), None),
        (include_bytes!("../../assets/fonts/JuliaMono-RegularItalic.ttf"), None),
        (include_bytes!("../../assets/fonts/JuliaMono-Bold.ttf"), None),
        (include_bytes!("../../assets/fonts/JuliaMono-BoldItalic.ttf"), None),
        // iA Writer Duo S — static cuts. Variable equivalents exist (V
        // suffix) but Typst 0.14 doesn't interpolate variable axes in
        // compiled output, so the weight chips would silently no-op.
        // Statics give the Bold chip a real bold face; Light/Medium/
        // Semibold map to whichever of Regular/Bold is closest, which
        // is graceful and predictable.
        (include_bytes!("../../assets/fonts/iAWriterDuoS-Regular.ttf"), None),
        (include_bytes!("../../assets/fonts/iAWriterDuoS-Italic.ttf"), None),
        (include_bytes!("../../assets/fonts/iAWriterDuoS-Bold.ttf"), None),
        (include_bytes!("../../assets/fonts/iAWriterDuoS-BoldItalic.ttf"), None),
    ];
    FONTS
}

/// Load fonts from the operating system's standard font directories.
///
/// Each fontdb face is registered into the typst `FontBook` under every
/// family-name alias that fontdb reports for it (e.g. `"Newsreader"` AND
/// `"Newsreader 16pt"`). This matters for two reasons:
///
/// 1. Typst's `Font::info().family` reads `nameID 1` from the OpenType
///    `name` table, which for sub-family-bearing fonts (Newsreader,
///    Source Sans 3, many Adobe families) is the *full* family name
///    like `"Newsreader 16pt"`, not the user-friendly preferred family
///    `"Newsreader"` (`nameID 16`).
/// 2. The frontend `FontPicker` lists fontdb's preferred-family names
///    (via `face.families.first()`), so the user picks `"Newsreader"`,
///    we inject `#set text(font: "Newsreader")` into the source, and
///    typst's lookup against the book fails because no entry has that
///    exact family — even though the bytes are loaded.
///
/// Pushing one book entry per alias (all backed by the same cheap
/// `Arc`-wrapped `Font` clone) keeps both views consistent.
fn load_system_fonts(book: &mut FontBook, slots: &mut Vec<FontSlot>) {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    for face in db.faces() {
        let path = match &face.source {
            fontdb::Source::File(path) | fontdb::Source::SharedFile(path, _) => path.clone(),
            fontdb::Source::Binary(_) => continue,
        };

        let index = face.index;
        let Ok(data) = std::fs::read(&path) else { continue };
        let buffer = Bytes::new(data);

        let Some(font) = Font::iter(buffer).nth(index as usize) else { continue };
        let info = font.info().clone();

        // Collect aliases: typst's own family + every fontdb alias.
        // Dedupe case-insensitively so the same name doesn't get
        // pushed twice when typst and fontdb agree.
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut aliases: Vec<String> = Vec::new();
        let mut push_alias = |name: &str| {
            let key = name.to_lowercase();
            if seen.insert(key) {
                aliases.push(name.to_string());
            }
        };
        push_alias(&info.family);
        for (alias, _) in &face.families {
            push_alias(alias);
        }

        for alias in aliases {
            let mut info_for_alias = info.clone();
            info_for_alias.family = alias;
            book.push(info_for_alias);
            slots.push(FontSlot {
                font: OnceLock::from(Some(font.clone())),
            });
        }
    }
}

/// Load fonts from `<notebox_root>/fonts/` if the directory exists.
fn load_notebox_fonts(notebox_root: &Path, book: &mut FontBook, slots: &mut Vec<FontSlot>) {
    let fonts_dir = notebox_root.join("fonts");
    if !fonts_dir.is_dir() {
        return;
    }

    let extensions = ["ttf", "otf", "ttc", "woff", "woff2"];
    let entries = match std::fs::read_dir(&fonts_dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if !extensions.contains(&ext) {
            continue;
        }

        let Ok(data) = std::fs::read(&path) else { continue };
        let buffer = Bytes::new(data);
        for font in Font::iter(buffer) {
            book.push(font.info().clone());
            slots.push(FontSlot {
                font: OnceLock::from(Some(font)),
            });
        }
    }
}

/// Load all available fonts: embedded + system + notebox-local.
/// This is the primary entry point used by NoteboxWorld.
pub fn load_all(notebox_root: &Path) -> (FontBook, Vec<FontSlot>) {
    let (mut book, mut slots) = load_embedded();
    load_system_fonts(&mut book, &mut slots);
    load_notebox_fonts(notebox_root, &mut book, &mut slots);
    (book, slots)
}
