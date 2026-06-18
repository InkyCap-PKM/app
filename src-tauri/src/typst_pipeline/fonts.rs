//! Font discovery for the Typst compile pipeline.
//!
//! Loads embedded fonts (typst-assets + InkyCap-bundled), system fonts (via
//! fontdb), and notebox-local fonts from `<notebox>/fonts/`. The combined set
//! is used by NoteboxWorld for compilation and by the `list_system_fonts`
//! command for the frontend font picker.
//!
//! ## Memory model: eager metadata, lazy bytes
//!
//! Embedded fonts (Typst's defaults + InkyCap's bundled families) are the
//! always-resident fallback floor. Their bytes are `'static` (baked into the
//! binary via typst-assets / `include_bytes!`), so loading them eagerly costs
//! binary size, not heap.
//!
//! System and notebox-local fonts are loaded differently. Reading every
//! installed font file into memory was the dominant source of the app's
//! resident set (hundreds of MB on a machine with a normal font collection,
//! most of it never used by any document). Instead we:
//!
//! 1. **Discover eagerly, byte-load lazily.** For every face we build a
//!    [`FontInfo`] (family + variant + unicode coverage) so the `FontBook` is
//!    complete. Typst's glyph fallback walks the *whole* book by coverage, so
//!    the book must list every face or fallback silently breaks (tofu for CJK,
//!    emoji, exotic scripts). `FontInfo` is small; the parsed `Font` (with its
//!    full byte buffer) is what's expensive, and that's what we defer.
//! 2. **Back faces with an mmap, not a heap read.** Each [`FontSlot`] holds a
//!    shared memory-map of the file plus a face index. The actual `Font` is
//!    parsed on first access in [`FontSlot::get`] (i.e. only for faces a
//!    rendered document actually draws with). mmap pages are file-backed and
//!    reclaimable by the kernel, so even touched faces don't pin heap.
//!
//! This mirrors `typst-kit`'s own font-loading strategy (which we don't depend
//! on directly, so the slot type is reimplemented here). Per CLAUDE.md's
//! Typst-first principle: font provision is inherently host glue (the `World`
//! is the host's job), so there's no Typst-native primitive to defer to here.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use typst::foundations::Bytes;
use typst::text::{Font, FontBook, FontInfo};

/// A shared, reference-counted memory map of a font file. Cloning is cheap (an
/// `Arc` bump) and lets every alias/face that resolves to the same file share
/// one mapping. Implements `AsRef<[u8]>` so it can be handed straight to
/// `Bytes::new` without copying the bytes onto the heap.
#[derive(Clone)]
struct SharedMmap(Arc<memmap2::Mmap>);

impl AsRef<[u8]> for SharedMmap {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// One slot per face in the `FontBook` (book index ↔ slot index are parallel;
/// Typst calls `World::font(index)` against this vec).
///
/// Embedded fonts are *eager*: the parsed `Font` is stored directly, since its
/// bytes are static and parsing is the only (small) cost. System and
/// notebox-local fonts are *lazy*: the slot keeps a shared mmap + face index
/// and parses the `Font` on first access, so unused faces never pay the parse
/// or pin their bytes.
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

/// Memory-map a font file, returning a shareable handle. `None` if the file
/// can't be opened or mapped (the caller skips the face, matching the previous
/// read-into-memory behaviour).
fn mmap_path(path: &Path) -> Option<SharedMmap> {
    let file = std::fs::File::open(path).ok()?;
    // SAFETY: font files are treated as read-only. If a file were truncated out
    // from under the mapping a later glyph access could fault; this is the same
    // accepted risk taken by typst-kit's mmap-based loader, and font files do
    // not change during a session in practice.
    let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
    Some(SharedMmap(Arc::new(mmap)))
}

/// Load every embedded font from `typst-assets` into a `FontBook` plus a
/// parallel `Vec<FontSlot>` indexed identically. Typst calls
/// `World::font(index)` against indices into this vec.
///
/// Also includes any TTF/OTF files baked into the binary under
/// `src-tauri/assets/fonts/` via `include_bytes!`. These are the
/// InkyCap-bundled fonts (Inter, Junicode, JuliaMono, iA Writer Duo S) which
/// the resolver references by family name. Embedded fonts are resolved eagerly:
/// the bytes are static so the only cost is `Font::iter` parsing.
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
            slots.push(FontSlot::eager(font));
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
        // iA Writer Duo S — static cuts. Variable equivalents exist (V
        // suffix) but Typst 0.14 doesn't interpolate variable axes in
        // compiled output, so the weight chips would silently no-op.
        // Statics give the Bold chip a real bold face; Light/Medium/
        // Semibold map to whichever of Regular/Bold is closest, which
        // is graceful and predictable.
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

/// Load fonts from the operating system's standard font directories.
///
/// Discovery is eager (every face gets a `FontBook` entry) but byte-loading is
/// lazy (each slot keeps a shared mmap + index and parses on first use). See
/// the module docs for why the book must be complete even though the bytes are
/// deferred.
///
/// Each fontdb face is registered into the typst `FontBook` under every
/// family-name alias that fontdb reports for it (e.g. `"Newsreader"` AND
/// `"Newsreader 16pt"`). This matters for two reasons:
///
/// 1. Typst's `FontInfo::family` reads `nameID 1` from the OpenType
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
/// Pushing one book entry per alias (all backed by the same cheap shared mmap)
/// keeps both views consistent. This also absorbs typst 0.15's variable-font
/// family normalization (it strips "Variable"/"VF"/"Var" suffixes from
/// `info.family`): the un-normalized fontdb name the `FontPicker` displays — and
/// writes into `#set text(font:)` — is still registered as its own alias, so the
/// lookup resolves regardless of which form typst settled on.
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
            slots.push(FontSlot::lazy(mmap.clone(), index));
        }
    }
}

/// Load fonts from `<notebox_root>/fonts/` if the directory exists.
///
/// Like system fonts, these are discovered eagerly and byte-loaded lazily.
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

#[cfg(all(test, target_os = "linux"))]
mod memory_measure {
    //! A/B resident-memory measurement for the lazy vs eager font strategy.
    //! Ignored by default (touches the whole system font collection and prints
    //! to stdout). Run it explicitly to see the win on your own machine:
    //!
    //! ```text
    //! cargo test --release -p inkycap font_memory_ab -- --ignored --nocapture
    //! ```
    use super::*;
    use std::hint::black_box;

    /// Resident set size of this process, in MB. Reads `/proc/self/statm`
    /// (field 1 = resident pages); assumes the standard 4 KiB page.
    fn rss_mb() -> f64 {
        let statm = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
        let pages: f64 = statm
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        pages * 4096.0 / (1024.0 * 1024.0)
    }

    /// Mimics the pre-change loader: read every system font file fully into the
    /// heap and parse it, keeping the `Font` (and therefore its bytes) resident.
    fn eager_load_old_style() -> Vec<Font> {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut fonts = Vec::new();
        for face in db.faces() {
            let path = match &face.source {
                fontdb::Source::File(p) | fontdb::Source::SharedFile(p, _) => p.clone(),
                fontdb::Source::Binary(_) => continue,
            };
            let Ok(data) = std::fs::read(&path) else {
                continue;
            };
            let buffer = Bytes::new(data);
            if let Some(font) = Font::iter(buffer).nth(face.index as usize) {
                fonts.push(font);
            }
        }
        fonts
    }

    #[test]
    #[ignore = "measurement harness; run explicitly with --ignored --nocapture"]
    fn font_memory_ab() {
        let base = rss_mb();

        // NEW: lazy discovery + mmap-backed bytes. Bytes are parsed only on
        // demand, so building the book + slots should add little resident heap.
        let (book, slots) = load_all(Path::new("/nonexistent-notebox"));
        let after_lazy = rss_mb();
        // One slot per book entry (alias), so this is the registered-face count.
        let faces = slots.len();

        // Parse a handful of *system* faces on demand (the embedded ones at the
        // front are already parsed), to show the targeted byte-load cost a real
        // document pays for the few fonts it actually draws with.
        for slot in slots.iter().rev().take(8) {
            black_box(slot.get());
        }
        let after_some = rss_mb();

        // OLD: eager whole-collection read into the heap.
        let eager = eager_load_old_style();
        let after_eager = rss_mb();

        println!("\n=== Font loading resident-memory A/B ===");
        println!("faces discovered (book entries): {faces}");
        println!("baseline RSS:                  {base:8.1} MB");
        println!(
            "NEW lazy load_all (discovery): {after_lazy:8.1} MB  (+{:.1})",
            after_lazy - base
        );
        println!(
            "  + parse 8 faces on demand:   {after_some:8.1} MB  (+{:.1})",
            after_some - after_lazy
        );
        println!(
            "OLD eager whole-collection:    {after_eager:8.1} MB  (+{:.1})",
            after_eager - after_some
        );
        println!(
            "=> eager cost ~{:.1} MB vs lazy ~{:.1} MB for the same {} faces\n",
            after_eager - after_some,
            after_lazy - base,
            eager.len()
        );

        black_box((book, slots, eager));
    }
}
