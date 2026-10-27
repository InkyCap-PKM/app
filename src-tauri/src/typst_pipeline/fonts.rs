//! Fonts for the Typst compile pipeline: embedded (typst-assets and InkyCap's
//! bundled fonts), system (via fontdb) and notebox fonts from
//! `<notebox>/fonts/`. Used by NoteboxWorld and by the `list_system_fonts`
//! command for the font picker.
//!
//! ## Memory: metadata now, bytes on demand
//!
//! Embedded fonts are always loaded; their bytes are `'static`, so this costs
//! binary size, not heap.
//!
//! Reading every system font into memory would cost hundreds of MB, mostly
//! unused. Instead:
//!
//! 1. **Every face is listed, bytes load later.** Each face gets a [`FontInfo`]
//!    (family, variant, coverage) so the `FontBook` is complete; Typst's glyph
//!    fallback searches the whole book, so a missing face breaks fallback (tofu
//!    for CJK, emoji, other scripts). Only the parsed `Font` is deferred.
//! 2. **Faces are memory-mapped.** Each [`FontSlot`] holds a shared mmap and a
//!    face index, and parses the `Font` on first use in [`FontSlot::get`].
//!    Mapped pages belong to the file and the kernel can reclaim them.
//!
//! This follows `typst-kit`'s approach (not a dependency, so the slot type is
//! our own). Per CLAUDE.md's Typst-first principle: providing fonts is the
//! host's job in a `World`, so there is no Typst feature to use instead.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use typst::foundations::Bytes;
use typst::text::{Font, FontBook, FontInfo};

/// A shared memory map of a font file. Cheap to clone, so all faces and aliases
/// from one file share it. `AsRef<[u8]>` lets it go to `Bytes::new` without
/// copying.
#[derive(Clone)]
struct SharedMmap(Arc<memmap2::Mmap>);

impl AsRef<[u8]> for SharedMmap {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// One slot per face, in the same order as the `FontBook` (Typst calls
/// `World::font(index)`). Embedded fonts store the parsed `Font`; system and
/// notebox fonts keep a shared mmap and face index and parse on first use.
pub struct FontSlot {
    /// Source bytes + face index for lazy parsing. `None` for eager slots,
    /// whose `Font` is already present in `font`.
    lazy: Option<(SharedMmap, u32)>,
    font: OnceLock<Option<Font>>,
}

impl FontSlot {
    /// An eagerly-resolved slot whose `Font` is already parsed.
    fn eager(font: Font) -> Self {
        Self {
            lazy: None,
            font: OnceLock::from(Some(font)),
        }
    }

    /// A lazy slot that parses its `Font` from `data` at `index` on first use.
    fn lazy(data: SharedMmap, index: u32) -> Self {
        Self {
            lazy: Some((data, index)),
            font: OnceLock::new(),
        }
    }

    pub fn get(&self) -> Option<Font> {
        self.font
            .get_or_init(|| {
                let (data, index) = self.lazy.as_ref()?;
                Font::new(Bytes::new(data.clone()), *index)
            })
            .clone()
    }
}

/// Memory-map a font file, or `None` if it can't be opened (the face is
/// skipped).
fn mmap_path(path: &Path) -> Option<SharedMmap> {
    let file = std::fs::File::open(path).ok()?;
    // SAFETY: font files are treated as read-only. A file truncated under the
    // mapping could fault on a later glyph read; typst-kit's loader accepts the
    // same risk, and font files don't change during a session in practice.
    let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
    Some(SharedMmap(Arc::new(mmap)))
}

/// Load the embedded fonts into a `FontBook` and a matching `Vec<FontSlot>`:
/// typst-assets plus InkyCap's bundled fonts from `src-tauri/assets/fonts/`
/// (Inter, Junicode, JuliaMono, iA Writer Duo S). Parsed straight away, since
/// their bytes are static.
pub fn load_embedded() -> (FontBook, Vec<FontSlot>) {
    let mut book = FontBook::new();
    let mut slots = Vec::new();

    for data in typst_assets::fonts() {
        let buffer = Bytes::new(data);
        for font in Font::iter(buffer) {
            book.push(font.info().clone());
            slots.push(FontSlot::eager(font));
        }
    }

    for (data, family_override) in inkycap_bundled_fonts() {
        let buffer = Bytes::new(*data);
        for font in Font::iter(buffer) {
            let mut info = font.info().clone();
            // Register a file under another family name, to merge families
            // shipped as separate files (iA Writer's italic is registered as
            // "<family> Italic", which `text(font: "<family>", style:
            // "italic")` wouldn't find). The file's own weight and slant are
            // kept, so Typst still picks the right face.
            if let Some(name) = family_override {
                info.family = (*name).to_string();
            }
            book.push(info);
            slots.push(FontSlot::eager(font));
        }
    }

    (book, slots)
}

/// Fonts shipped with InkyCap, from `src-tauri/assets/fonts/` via
/// `include_bytes!`. The second element overrides the registered family name,
/// to merge families like iA Writer's separate italic so `text(style:
/// "italic")` finds it; `None` keeps the file's own name. To add a face, put
/// the file in that folder and add it here.
fn inkycap_bundled_fonts() -> &'static [(&'static [u8], Option<&'static str>)] {
    static FONTS: &[(&[u8], Option<&str>)] = &[
        (include_bytes!("../../assets/fonts/Inter-Regular.ttf"), None),
        (include_bytes!("../../assets/fonts/Inter-Italic.ttf"), None),
        (include_bytes!("../../assets/fonts/Inter-Bold.ttf"), None),
        (
            include_bytes!("../../assets/fonts/Inter-BoldItalic.ttf"),
            None,
        ),
        (
            include_bytes!("../../assets/fonts/Junicode-Regular.ttf"),
            None,
        ),
        (
            include_bytes!("../../assets/fonts/Junicode-Italic.ttf"),
            None,
        ),
        (include_bytes!("../../assets/fonts/Junicode-Bold.ttf"), None),
        (
            include_bytes!("../../assets/fonts/Junicode-BoldItalic.ttf"),
            None,
        ),
        (
            include_bytes!("../../assets/fonts/JuliaMono-Regular.ttf"),
            None,
        ),
        (
            include_bytes!("../../assets/fonts/JuliaMono-RegularItalic.ttf"),
            None,
        ),
        (
            include_bytes!("../../assets/fonts/JuliaMono-Bold.ttf"),
            None,
        ),
        (
            include_bytes!("../../assets/fonts/JuliaMono-BoldItalic.ttf"),
            None,
        ),
        // iA Writer Duo S, static cuts: Typst doesn't apply variable-font axes
        // in output, so the weight options would do nothing with the variable
        // files. Light, Medium and Semibold map to the nearer of Regular and
        // Bold.
        (
            include_bytes!("../../assets/fonts/iAWriterDuoS-Regular.ttf"),
            None,
        ),
        (
            include_bytes!("../../assets/fonts/iAWriterDuoS-Italic.ttf"),
            None,
        ),
        (
            include_bytes!("../../assets/fonts/iAWriterDuoS-Bold.ttf"),
            None,
        ),
        (
            include_bytes!("../../assets/fonts/iAWriterDuoS-BoldItalic.ttf"),
            None,
        ),
    ];
    FONTS
}

/// Load fonts from the system font folders. Every face is listed; bytes load on
/// first use (see the module docs).
///
/// Each face is registered under every family name fontdb reports (e.g.
/// `"Newsreader"` and `"Newsreader 16pt"`), because:
///
/// 1. Typst's `FontInfo::family` comes from `nameID 1`, which for fonts with
///    sub-families (Newsreader, Source Sans 3, many Adobe families) is the full
///    name (`"Newsreader 16pt"`), not the preferred family (`nameID 16`).
/// 2. The font picker lists fontdb's preferred names, so the user picks
///    `"Newsreader"` and Typst wouldn't find it otherwise.
///
/// This also covers Typst 0.15 dropping "Variable"/"VF"/"Var" from variable-font
/// family names: the name the picker shows is still registered.
fn load_system_fonts(book: &mut FontBook, slots: &mut Vec<FontSlot>) {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    // One mmap per distinct file, shared across that file's faces/aliases.
    let mut mmaps: HashMap<PathBuf, SharedMmap> = HashMap::new();

    for face in db.faces() {
        let path = match &face.source {
            fontdb::Source::File(path) | fontdb::Source::SharedFile(path, _) => path.clone(),
            fontdb::Source::Binary(_) => continue,
        };

        let index = face.index;
        let mmap = match mmaps.get(&path) {
            Some(m) => m.clone(),
            None => {
                let Some(m) = mmap_path(&path) else {
                    continue;
                };
                mmaps.insert(path.clone(), m.clone());
                m
            }
        };

        // Build metadata (family, variant, coverage) without retaining a
        // parsed `Font` — the bytes stay in the mmap and are parsed lazily.
        let Some(info) = FontInfo::new(mmap.as_ref(), index) else {
            continue;
        };

        // Typst's family plus every fontdb name, without duplicates (ignoring
        // case).
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
            slots.push(FontSlot::lazy(mmap.clone(), index));
        }
    }
}

/// Load fonts from `<notebox_root>/fonts/` if it exists, listed now and loaded
/// on use like system fonts.
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
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !extensions.contains(&ext) {
            continue;
        }

        let Some(mmap) = mmap_path(&path) else {
            continue;
        };
        for (index, info) in FontInfo::iter(mmap.as_ref()).enumerate() {
            book.push(info);
            slots.push(FontSlot::lazy(mmap.clone(), index as u32));
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
