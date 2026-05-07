//! Font discovery for the Typst compile pipeline.
//!
//! Loads embedded fonts (typst-assets), system fonts (via fontdb), and
//! vault-local fonts from `<vault>/fonts/`. The combined set is used by
//! VaultWorld for compilation and by the `list_system_fonts` command for
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

    (book, slots)
}

/// Load fonts from the operating system's standard font directories.
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

        for (i, font) in Font::iter(buffer).enumerate() {
            if i as u32 == index {
                book.push(font.info().clone());
                slots.push(FontSlot {
                    font: OnceLock::from(Some(font)),
                });
                break;
            }
        }
    }
}

/// Load fonts from `<vault_root>/fonts/` if the directory exists.
fn load_vault_fonts(vault_root: &Path, book: &mut FontBook, slots: &mut Vec<FontSlot>) {
    let fonts_dir = vault_root.join("fonts");
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

/// Load all available fonts: embedded + system + vault-local.
/// This is the primary entry point used by VaultWorld.
pub fn load_all(vault_root: &Path) -> (FontBook, Vec<FontSlot>) {
    let (mut book, mut slots) = load_embedded();
    load_system_fonts(&mut book, &mut slots);
    load_vault_fonts(vault_root, &mut book, &mut slots);
    (book, slots)
}
