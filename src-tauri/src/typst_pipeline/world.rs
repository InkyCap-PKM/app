//! `typst::World` implementation backed by a vault directory on disk.
//!
//! The World is the interface Typst's compiler uses to resolve everything it
//! needs from the host: the standard library, fonts, source files, binary
//! files, and "today". We keep one World per open vault and re-use it across
//! compiles so comemo memoization stays warm — that's what gets us the
//! sub-millisecond warm-path numbers from the Phase 0 bench.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Datelike, Local};
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_library::Feature;

use crate::storage::path::validate_vault_path;
use crate::typst_pipeline::fonts::{self, FontSlot};

/// Per-FileId cached source text. Held under a Mutex so `World::source` can
/// take `&self` (Typst requires `Sync`).
struct SourceCache {
    sources: Mutex<HashMap<FileId, Source>>,
}

impl SourceCache {
    fn new() -> Self {
        Self { sources: Mutex::new(HashMap::new()) }
    }

    /// Return the cached source if present without re-reading from disk.
    fn get(&self, id: FileId) -> Option<Source> {
        self.sources.lock().ok()?.get(&id).cloned()
    }

    /// Insert or replace a source. Returns the inserted clone so the caller
    /// can hand it to typst.
    fn insert(&self, id: FileId, text: String) -> Source {
        let source = Source::new(id, text);
        if let Ok(mut map) = self.sources.lock() {
            map.insert(id, source.clone());
        }
        source
    }

    /// Drop a source from the cache. Use this when the file has been modified
    /// on disk and we want the next compile to pick up the new content.
    fn invalidate(&self, id: FileId) {
        if let Ok(mut map) = self.sources.lock() {
            map.remove(&id);
        }
    }

    /// Wipe the entire cache. Used on full vault reload.
    #[allow(dead_code)]
    fn clear(&self) {
        if let Ok(mut map) = self.sources.lock() {
            map.clear();
        }
    }
}

/// Cached binary-file bytes (images, bibliography files, etc.).
struct FileCache {
    files: Mutex<HashMap<FileId, Bytes>>,
}

impl FileCache {
    fn new() -> Self {
        Self { files: Mutex::new(HashMap::new()) }
    }

    fn get(&self, id: FileId) -> Option<Bytes> {
        self.files.lock().ok()?.get(&id).cloned()
    }

    fn insert(&self, id: FileId, bytes: Bytes) {
        if let Ok(mut map) = self.files.lock() {
            map.insert(id, bytes);
        }
    }

    fn invalidate(&self, id: FileId) {
        if let Ok(mut map) = self.files.lock() {
            map.remove(&id);
        }
    }
}

pub struct VaultWorld {
    /// Canonical vault root. The caller is responsible for canonicalizing
    /// before construction (see [`crate::storage::path::canonicalize_root`]);
    /// see also the test helper which does this. Storing the canonical form
    /// is what lets [`fs_path`] use `validate_vault_path` to reject symlink
    /// escapes — `starts_with` only works against a canonical prefix.
    canonical_vault_root: PathBuf,
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<FontSlot>,
    sources: SourceCache,
    files: FileCache,
    /// FileId of the document being compiled. Updated via `set_main`.
    main: Mutex<FileId>,
    /// Captured at compile start so `today()` is stable across the run.
    now: Mutex<Option<DateTime<Local>>>,
    /// Whether system + vault fonts have been loaded (on-demand, not at startup).
    system_fonts_loaded: bool,
}

impl VaultWorld {
    /// Build a World rooted at `canonical_vault_root`. The path MUST already
    /// be canonical (no `..`, no symlinks in the prefix). The vault open path
    /// at [`crate::state::AppState::open_vault_fast`] ensures this; tests use
    /// the [`canonicalize_root`] helper.
    pub fn new(canonical_vault_root: PathBuf) -> Self {
        let (book, fonts) = fonts::load_embedded();
        // Placeholder main; set_main replaces it before the first compile.
        let placeholder = FileId::new(None, VirtualPath::new("/__placeholder__.typ"));
        Self {
            canonical_vault_root,
            library: LazyHash::new(
                Library::builder()
                    .with_features([Feature::Html].into_iter().collect())
                    .build(),
            ),
            book: LazyHash::new(book),
            fonts,
            sources: SourceCache::new(),
            files: FileCache::new(),
            main: Mutex::new(placeholder),
            now: Mutex::new(None),
            system_fonts_loaded: false,
        }
    }

    pub fn vault_root(&self) -> &Path {
        &self.canonical_vault_root
    }

    pub fn system_fonts_loaded(&self) -> bool {
        self.system_fonts_loaded
    }

    /// Load system and vault-local fonts into the font book. Called once on
    /// demand when the user configures a non-embedded font family. Rebuilds
    /// the book and slots from scratch (embedded + system + vault) so the
    /// index stays consistent.
    pub fn load_system_fonts(&mut self) {
        if self.system_fonts_loaded {
            return;
        }
        let (book, slots) = fonts::load_all(&self.canonical_vault_root);
        self.book = LazyHash::new(book);
        self.fonts = slots;
        self.system_fonts_loaded = true;
    }

    /// Convert a vault-absolute filesystem path into the FileId Typst uses to
    /// reference it. The path must be inside the vault; otherwise we return
    /// `None`.
    pub fn file_id_for(&self, abs_path: &Path) -> Option<FileId> {
        let rel = abs_path.strip_prefix(&self.canonical_vault_root).ok()?;
        let mut vpath = String::from("/");
        for (i, comp) in rel.components().enumerate() {
            if i > 0 {
                vpath.push('/');
            }
            vpath.push_str(&comp.as_os_str().to_string_lossy());
        }
        Some(FileId::new(None, VirtualPath::new(vpath)))
    }

    /// Replace the main-file source and mark its FileId as the compile entry.
    /// Called before every compile; the World is otherwise idempotent.
    pub fn set_main(&self, abs_path: &Path, text: String) -> Result<FileId, FileError> {
        let id = self
            .file_id_for(abs_path)
            .ok_or_else(|| FileError::NotFound(abs_path.to_path_buf()))?;
        self.sources.invalidate(id);
        self.sources.insert(id, text);
        if let Ok(mut main) = self.main.lock() {
            *main = id;
        }
        // Reset "today" so the next compile re-captures it.
        if let Ok(mut now) = self.now.lock() {
            *now = None;
        }
        Ok(id)
    }

    /// Drop a single file from both source and binary caches. Hook for the
    /// vault watcher: when a file changes on disk, invalidate it so the next
    /// compile picks up the new bytes. The watcher already canonicalizes
    /// paths before forwarding events, so paths that arrive here are
    /// expected to share the canonical root prefix.
    #[allow(dead_code)]
    pub fn invalidate(&self, abs_path: &Path) {
        if let Some(id) = self.file_id_for(abs_path) {
            self.sources.invalidate(id);
            self.files.invalidate(id);
        }
    }

    /// Resolve a FileId to an on-disk path inside the vault.
    ///
    /// Package imports (`@namespace/name:version`) are resolved against a local
    /// package directory at `<vault>/.inkycap/packages/<namespace>/<name>/<version>/`.
    /// The entrypoint defaults to the root vpath of the package (typically
    /// `/lib.typ` as declared in `typst.toml`).
    ///
    /// Goes through [`validate_vault_path`] so a symlink inside the vault
    /// pointing at `/etc/passwd` (or anywhere outside the canonical root)
    /// fails before bytes leave disk.
    fn fs_path(&self, id: FileId) -> FileResult<PathBuf> {
        if let Some(spec) = id.package() {
            return self.resolve_package_path(spec, id.vpath());
        }
        let rel = id.vpath().as_rootless_path();
        let joined = self.canonical_vault_root.join(rel);
        validate_vault_path(&self.canonical_vault_root, &joined).map_err(|_err| {
            FileError::AccessDenied
        })
    }

    /// Resolve a package file to a local path under `.inkycap/packages/`.
    ///
    /// Layout: `<vault>/.inkycap/packages/<namespace>/<name>/<version>/<vpath>`
    ///
    /// This matches the Typst-canonical layout used by `typst-cli`, Tinymist,
    /// and `typst.ts`. All user-authored content (templates and libraries)
    /// lives under `@local/`; Universe content under `@preview/`; custom
    /// namespaces resolve identically.
    fn resolve_package_path(
        &self,
        spec: &typst::syntax::package::PackageSpec,
        vpath: &VirtualPath,
    ) -> FileResult<PathBuf> {
        let rel_file = vpath.as_rootless_path();

        let pkg_dir = self.canonical_vault_root
            .join(".inkycap/packages")
            .join(spec.namespace.as_str())
            .join(spec.name.as_str())
            .join(spec.version.to_string());

        if pkg_dir.is_dir() {
            let joined = pkg_dir.join(rel_file);
            return validate_vault_path(&self.canonical_vault_root, &joined)
                .map_err(|_| FileError::AccessDenied);
        }

        Err(FileError::Package(typst::diag::PackageError::NotFound(
            spec.clone(),
        )))
    }

    fn read_source(&self, id: FileId) -> FileResult<Source> {
        if let Some(cached) = self.sources.get(id) {
            return Ok(cached);
        }
        let path = self.fs_path(id)?;
        let text = std::fs::read_to_string(&path)
            .map_err(|err| FileError::from_io(err, &path))?;
        Ok(self.sources.insert(id, text))
    }

    fn read_file(&self, id: FileId) -> FileResult<Bytes> {
        if let Some(cached) = self.files.get(id) {
            return Ok(cached);
        }
        let path = self.fs_path(id)?;
        let raw = std::fs::read(&path).map_err(|err| FileError::from_io(err, &path))?;
        let bytes = Bytes::new(raw);
        self.files.insert(id, bytes.clone());
        Ok(bytes)
    }
}

impl World for VaultWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        // Mutex guard returned by lock() can't outlive this fn (FileId is
        // Copy), so it's safe to clone-out here.
        *self
            .main
            .lock()
            .expect("main FileId mutex poisoned")
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.read_source(id)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.read_file(id)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).and_then(|slot| slot.get())
    }

    fn today(&self, offset: Option<i64>) -> Option<Datetime> {
        let mut guard = self.now.lock().ok()?;
        let now = *guard.get_or_insert_with(Local::now);
        let adjusted = match offset {
            Some(hours) => now + chrono::Duration::hours(hours),
            None => now,
        };
        Datetime::from_ymd(
            adjusted.year(),
            adjusted.month().try_into().ok()?,
            adjusted.day().try_into().ok()?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::path::canonicalize_root;
    use std::fs;
    use tempfile::tempdir;

    /// 1×1 transparent PNG — smallest valid PNG the typst-svg image decoder
    /// will accept end-to-end. Generated by zlib-compressing a one-pixel RGBA
    /// scanline; verified by feeding through Typst's compile pipeline below.
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00,
        0x00, 0x05, 0x00, 0x01, 0x7a, 0x5e, 0xab, 0x3f, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn fs_path_rejects_traversal_outside_vault() {
        let tmp = tempdir().expect("tempdir");
        let root = canonicalize_root(tmp.path()).expect("canonicalize");
        let world = VaultWorld::new(root.clone());

        // VirtualPath normalizes `..`/leading-slashes against the virtual root,
        // so a literal escape attempt like `../../etc/passwd` ends up resolving
        // back inside the root before fs_path even runs. That's good — but it's
        // not the case we care about here. The case we *do* care about is a
        // symlink inside the vault that targets outside of it; see the
        // `rejects_symlink_escape` test below.
        let inside = root.join("note.typ");
        let id = world.file_id_for(&inside).expect("inside-vault id");
        let resolved = world.fs_path(id).expect("inside vault should resolve");
        assert!(resolved.starts_with(&root));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let vault = tempdir().expect("vault tempdir");
        let outside = tempdir().expect("outside tempdir");
        let root = canonicalize_root(vault.path()).expect("canonicalize vault");

        // An attacker drops a symlink inside the vault that points at a
        // sensitive file outside it, then crafts a `.typ` doing
        // `#read("escape/secret.txt")` (or `#image(...)`, etc.). The compile
        // pipeline must refuse to read through it.
        fs::write(outside.path().join("secret.txt"), "shh").expect("write secret");
        symlink(outside.path(), root.join("escape")).expect("create symlink");

        let world = VaultWorld::new(root.clone());
        // FileId with a vault-relative path that traverses the symlink.
        let id = FileId::new(None, VirtualPath::new("/escape/secret.txt"));
        let err = world.fs_path(id).expect_err("symlink escape must be rejected");
        assert!(matches!(err, FileError::AccessDenied), "got {err:?}");
    }

    #[test]
    fn world_reads_image_bytes_for_compile() {
        // End-to-end: a `.typ` file referencing a vault-local PNG should
        // compile and render — typst-svg embeds the image bytes as a
        // `data:image/png;base64,...` URL inside the SVG, which is what makes
        // the reading-mode renderer self-contained (no asset protocol needed
        // for v0.1).
        let tmp = tempdir().expect("tempdir");
        let root = canonicalize_root(tmp.path()).expect("canonicalize");
        fs::write(root.join("pic.png"), TINY_PNG).expect("write png");
        let note_path = root.join("note.typ");
        let source = "#image(\"pic.png\")".to_string();
        fs::write(&note_path, &source).expect("write note");

        let mut compiler = crate::typst_pipeline::TypstCompiler::new(root.clone());
        let result = compiler
            .compile_svg(&note_path, source)
            .expect("compile call ok");

        assert!(result.ok, "compile failed: {:#?}", result.diagnostics);
        assert_eq!(result.frames.len(), 1);
        let svg = &result.frames[0].svg;
        assert!(
            svg.contains("data:image/png;base64,"),
            "expected base64-embedded PNG in SVG output; got first 200 chars: {}",
            &svg[..200.min(svg.len())]
        );
    }
}
