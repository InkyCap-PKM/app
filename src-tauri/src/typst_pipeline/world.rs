//! `typst::World` for a notebox folder: how the compiler gets the standard
//! library, fonts, sources, files and today's date. One World per open notebox,
//! reused so comemo memoization stays warm.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Datelike, Local};
use typst::diag::{FileError, FileResult, PackageError};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::package::PackageSpec;
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_library::Feature;

use crate::storage::path::validate_notebox_path;
use crate::typst_packages::package_search_dirs;
use crate::typst_pipeline::fonts::{self, FontSlot};

/// A `FileId`-keyed cache with a fixed size and FIFO eviction. Re-inserting a
/// key updates it in place; to make an entry fresh (e.g. the main file),
/// [`remove`](Self::remove) it first. Both uses are read-through caches of files
/// on disk, so eviction is always safe.
struct BoundedCache<V> {
    map: HashMap<FileId, V>,
    /// Insertion order; front is oldest. Kept in sync with `map`: every key in
    /// `order` is in `map` and vice versa (no duplicates).
    order: VecDeque<FileId>,
    cap: usize,
}

impl<V> BoundedCache<V> {
    fn new(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            cap,
        }
    }

    fn get(&self, id: &FileId) -> Option<&V> {
        self.map.get(id)
    }

    fn put(&mut self, id: FileId, value: V) {
        if self.map.insert(id, value).is_none() {
            // New key: record order and evict the oldest if over capacity.
            self.order.push_back(id);
            while self.order.len() > self.cap {
                if let Some(old) = self.order.pop_front() {
                    self.map.remove(&old);
                }
            }
        }
    }

    fn remove(&mut self, id: &FileId) {
        if self.map.remove(id).is_some() {
            self.order.retain(|x| x != id);
        }
    }

    fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
    }
}

/// Maximum source files kept. Indexing compiles every note, which would
/// otherwise keep every parsed `Source` for the session. A small cap only costs
/// re-reads; a compile whose includes exceed it still works, since Typst holds
/// its sources during the compile.
const SOURCE_CACHE_CAP: usize = 512;

/// Source text per FileId, in a bounded FIFO cache. Behind a Mutex so
/// `World::source` can take `&self`.
struct SourceCache {
    inner: Mutex<BoundedCache<Source>>,
}

impl SourceCache {
    fn new() -> Self {
        Self {
            inner: Mutex::new(BoundedCache::new(SOURCE_CACHE_CAP)),
        }
    }

    /// Return the cached source if present without re-reading from disk.
    fn get(&self, id: FileId) -> Option<Source> {
        self.inner.lock().ok()?.get(&id).cloned()
    }

    /// Insert or replace a source. Returns the inserted clone so the caller
    /// can hand it to typst.
    fn insert(&self, id: FileId, text: String) -> Source {
        let source = Source::new(id, text);
        if let Ok(mut cache) = self.inner.lock() {
            cache.put(id, source.clone());
        }
        source
    }

    /// Drop a source from the cache. Use this when the file has been modified
    /// on disk and we want the next compile to pick up the new content.
    fn invalidate(&self, id: FileId) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.remove(&id);
        }
    }

    /// Wipe the entire cache. See [`NoteboxWorld::forget_cached_files`].
    fn clear(&self) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.clear();
        }
    }
}

/// Maximum binary files kept (images, bibliographies). Lower than the source
/// cap, since images can be large.
const FILE_CACHE_CAP: usize = 128;

/// Cached binary-file bytes (images, bibliography files, etc.) with a bounded,
/// FIFO-evicted working set.
struct FileCache {
    inner: Mutex<BoundedCache<Bytes>>,
}

impl FileCache {
    fn new() -> Self {
        Self {
            inner: Mutex::new(BoundedCache::new(FILE_CACHE_CAP)),
        }
    }

    fn get(&self, id: FileId) -> Option<Bytes> {
        self.inner.lock().ok()?.get(&id).cloned()
    }

    fn insert(&self, id: FileId, bytes: Bytes) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.put(id, bytes);
        }
    }

    fn invalidate(&self, id: FileId) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.remove(&id);
        }
    }

    /// Wipe the entire cache. See [`NoteboxWorld::forget_cached_files`].
    fn clear(&self) {
        if let Ok(mut cache) = self.inner.lock() {
            cache.clear();
        }
    }
}

pub struct NoteboxWorld {
    /// Canonical notebox root, canonicalized by the caller (see
    /// [`crate::storage::path::canonicalize_root`]). [`fs_path`] relies on it
    /// to reject symlink escapes with `validate_notebox_path`.
    canonical_notebox_root: PathBuf,
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<FontSlot>,
    sources: SourceCache,
    files: FileCache,
    /// FileId of the document being compiled. Updated via `set_main`.
    main: Mutex<FileId>,
    /// Captured at compile start so `today()` is stable across the run.
    now: Mutex<Option<DateTime<Local>>>,
    /// Whether system + notebox fonts have been loaded (on-demand, not at startup).
    system_fonts_loaded: bool,
    /// Remote packages that couldn't be found in any package folder (notebox,
    /// Typst data dir, Typst cache dir). The command layer takes them with
    /// [`take_missing_packages`], downloads them and recompiles; each pass
    /// finds the next missing dependency. `@local` packages are never recorded,
    /// as there's nowhere to download them from.
    missing_packages: Mutex<Vec<PackageSpec>>,
}

impl NoteboxWorld {
    /// A World rooted at `canonical_notebox_root`, which must be canonical (no
    /// `..`, no symlinks). [`crate::state::AppState::open_notebox_fast`]
    /// ensures this; tests use [`canonicalize_root`].
    pub fn new(canonical_notebox_root: PathBuf) -> Self {
        let (book, fonts) = fonts::load_embedded();
        // Placeholder main, replaced by set_main before the first compile.
        // `VirtualPath::new` validates and returns a Result.
        let placeholder = FileId::new(RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new("/__placeholder__.typ").expect("static placeholder path is valid"),
        ));
        Self {
            canonical_notebox_root,
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
            missing_packages: Mutex::new(Vec::new()),
        }
    }

    /// Take the remote packages that weren't found since the last call. Only
    /// successful reads are cached, so a recompile after downloading finds
    /// them.
    pub fn take_missing_packages(&self) -> Vec<PackageSpec> {
        self.missing_packages
            .lock()
            .map(|mut v| std::mem::take(&mut *v))
            .unwrap_or_default()
    }

    /// Record a missing package for download. Only remote namespaces: a missing
    /// `@local` package stays an error the user must fix.
    fn record_missing_package(&self, spec: &PackageSpec) {
        if spec.namespace.as_str() == "local" {
            return;
        }
        if let Ok(mut v) = self.missing_packages.lock() {
            if !v.iter().any(|s| s == spec) {
                v.push(spec.clone());
            }
        }
    }

    pub fn notebox_root(&self) -> &Path {
        &self.canonical_notebox_root
    }

    pub fn system_fonts_loaded(&self) -> bool {
        self.system_fonts_loaded
    }

    /// Load system and notebox fonts, rebuilding the font book (embedded,
    /// system, notebox) from scratch.
    pub fn load_system_fonts(&mut self) {
        if self.system_fonts_loaded {
            return;
        }
        let (book, slots) = fonts::load_all(&self.canonical_notebox_root);
        self.book = LazyHash::new(book);
        self.fonts = slots;
        self.system_fonts_loaded = true;
    }

    /// The FileId for a path inside the notebox, or `None` outside it.
    pub fn file_id_for(&self, abs_path: &Path) -> Option<FileId> {
        let rel = abs_path.strip_prefix(&self.canonical_notebox_root).ok()?;
        let mut vpath = String::from("/");
        for (i, comp) in rel.components().enumerate() {
            if i > 0 {
                vpath.push('/');
            }
            vpath.push_str(&comp.as_os_str().to_string_lossy());
        }
        let vpath = VirtualPath::new(vpath).ok()?;
        Some(FileId::new(RootedPath::new(VirtualRoot::Project, vpath)))
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

    /// Empty the source and file caches, e.g. after indexing compiles every
    /// note and leaves them full of files the next compiles won't need.
    pub fn forget_cached_files(&self) {
        self.sources.clear();
        self.files.clear();
    }

    /// Drop one file from both caches, so the next compile reads it again. For
    /// the watcher, whose paths are already canonical.
    #[allow(dead_code)]
    pub fn invalidate(&self, abs_path: &Path) {
        if let Some(id) = self.file_id_for(abs_path) {
            self.sources.invalidate(id);
            self.files.invalidate(id);
        }
    }

    /// The on-disk path for a FileId inside the notebox. Package files
    /// (`@namespace/name:version`) resolve through [`Self::resolve_package_path`]. Goes
    /// through [`validate_notebox_path`], so a symlink pointing outside the canonical
    /// root fails before anything is read.
    fn fs_path(&self, id: FileId) -> FileResult<PathBuf> {
        if let VirtualRoot::Package(spec) = id.root() {
            return self.resolve_package_path(spec, id.vpath());
        }
        let rel = id.vpath().get_without_slash();
        let joined = self.canonical_notebox_root.join(rel);
        validate_notebox_path(&self.canonical_notebox_root, &joined)
            .map_err(|_err| FileError::AccessDenied)
    }

    /// Resolve a package file, searching in order:
    ///
    /// 1. **Notebox**: `<notebox>/.inkycap/packages/<ns>/<name>/<ver>/`, bundled
    ///    with the notebox; first, so a notebox can pin its own copy.
    /// 2. **Typst data dir**: `dirs::data_dir()/typst/packages/...`, for `@local`
    ///    and installed packages.
    /// 3. **Typst cache dir**: `dirs::cache_dir()/typst/packages/...`, where
    ///    downloaded `@preview` packages go (shared with `typst-cli` and
    ///    Tinymist).
    ///
    /// All use Typst's standard `<namespace>/<name>/<version>/` layout. If none
    /// has it, the spec is recorded with [`record_missing_package`] for download
    /// and `NotFound` is returned.
    fn resolve_package_path(&self, spec: &PackageSpec, vpath: &VirtualPath) -> FileResult<PathBuf> {
        let rel_file = vpath.get_without_slash();
        let roots = package_search_dirs(
            &self.canonical_notebox_root,
            spec.namespace.as_str(),
            spec.name.as_str(),
            &spec.version.to_string(),
        );

        for pkg_dir in &roots {
            if !pkg_dir.is_dir() {
                continue;
            }
            // Validate against this package's root (the cache and data dirs are
            // outside the notebox), so a `..` can't escape it. The root is
            // canonicalized first, as `validate_notebox_path` needs.
            let canon_root = match std::fs::canonicalize(pkg_dir) {
                Ok(p) => p,
                Err(err) => return Err(FileError::from_io(err, pkg_dir)),
            };
            let joined = canon_root.join(rel_file);
            return validate_notebox_path(&canon_root, &joined)
                .map_err(|_| FileError::AccessDenied);
        }

        self.record_missing_package(spec);
        Err(FileError::Package(PackageError::NotFound(spec.clone())))
    }

    fn read_source(&self, id: FileId) -> FileResult<Source> {
        if let Some(cached) = self.sources.get(id) {
            return Ok(cached);
        }
        let path = self.fs_path(id)?;
        let text = std::fs::read_to_string(&path).map_err(|err| FileError::from_io(err, &path))?;
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

impl World for NoteboxWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        // Mutex guard returned by lock() can't outlive this fn (FileId is
        // Copy), so it's safe to clone-out here.
        *self.main.lock().expect("main FileId mutex poisoned")
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

    fn today(&self, offset: Option<typst::foundations::Duration>) -> Option<Datetime> {
        let mut guard = self.now.lock().ok()?;
        let now = *guard.get_or_insert_with(Local::now);
        // 0.15: the offset is a Typst `Duration` (was a bare hour count `i64`).
        // Apply it at second granularity to preserve sub-hour offsets.
        let adjusted = match offset {
            Some(d) => now + chrono::Duration::seconds(d.seconds().round() as i64),
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

    /// Smallest valid 1×1 transparent PNG; compiled in the test below.
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60,
        0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01, 0x7a, 0x5e, 0xab, 0x3f, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn fs_path_rejects_traversal_outside_notebox() {
        let tmp = tempdir().expect("tempdir");
        let root = canonicalize_root(tmp.path()).expect("canonicalize");
        let world = NoteboxWorld::new(root.clone());

        // VirtualPath normalizes `..` against the root, so `../../etc/passwd`
        // stays inside. The real risk is a symlink out of the notebox; see
        // `rejects_symlink_escape`.
        let inside = root.join("note.typ");
        let id = world.file_id_for(&inside).expect("inside-notebox id");
        let resolved = world.fs_path(id).expect("inside notebox should resolve");
        assert!(resolved.starts_with(&root));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let notebox = tempdir().expect("notebox tempdir");
        let outside = tempdir().expect("outside tempdir");
        let root = canonicalize_root(notebox.path()).expect("canonicalize notebox");

        // A symlink inside the notebox pointing at a file outside, read with
        // `#read("escape/secret.txt")` (or `#image`): the compile must refuse.
        fs::write(outside.path().join("secret.txt"), "shh").expect("write secret");
        symlink(outside.path(), root.join("escape")).expect("create symlink");

        let world = NoteboxWorld::new(root.clone());
        // FileId with a notebox-relative path that traverses the symlink.
        let id = FileId::new(RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new("/escape/secret.txt").expect("valid test path"),
        ));
        let err = world
            .fs_path(id)
            .expect_err("symlink escape must be rejected");
        assert!(matches!(err, FileError::AccessDenied), "got {err:?}");
    }

    #[test]
    fn world_reads_image_bytes_for_compile() {
        // A note with a notebox PNG compiles and renders; typst-svg embeds the
        // image as a `data:` URL.
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

    fn spec(s: &str) -> PackageSpec {
        s.parse().expect("valid package spec")
    }

    #[test]
    fn resolves_notebox_vendored_package() {
        let tmp = tempdir().expect("tempdir");
        let root = canonicalize_root(tmp.path()).expect("canonicalize");
        // Vendored layout: .inkycap/packages/<ns>/<name>/<ver>/lib.typ
        let pkg = root.join(".inkycap/packages/preview/foo/1.0.0");
        fs::create_dir_all(&pkg).expect("create pkg dir");
        fs::write(pkg.join("lib.typ"), "#let x = 1").expect("write lib");

        let world = NoteboxWorld::new(root);
        let resolved = world
            .resolve_package_path(
                &spec("@preview/foo:1.0.0"),
                &VirtualPath::new("/lib.typ").expect("valid test path"),
            )
            .expect("vendored package should resolve");
        assert!(resolved.ends_with("preview/foo/1.0.0/lib.typ"));
        // A hit must not be recorded as missing.
        assert!(world.take_missing_packages().is_empty());
    }

    #[test]
    fn records_missing_remote_package() {
        let tmp = tempdir().expect("tempdir");
        let root = canonicalize_root(tmp.path()).expect("canonicalize");
        let world = NoteboxWorld::new(root);

        let err = world
            .resolve_package_path(
                &spec("@preview/nope:9.9.9"),
                &VirtualPath::new("/lib.typ").expect("valid test path"),
            )
            .expect_err("absent package must not resolve");
        assert!(matches!(err, FileError::Package(PackageError::NotFound(_))));

        let missing = world.take_missing_packages();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].name.as_str(), "nope");
        // Draining is one-shot.
        assert!(world.take_missing_packages().is_empty());
    }

    #[test]
    fn local_package_miss_is_not_recorded_for_download() {
        // `@local` packages have no registry, so a miss is a genuine
        // unrecoverable error — never queued for download.
        let tmp = tempdir().expect("tempdir");
        let root = canonicalize_root(tmp.path()).expect("canonicalize");
        let world = NoteboxWorld::new(root);

        let _ = world.resolve_package_path(
            &spec("@local/mylib:0.1.0"),
            &VirtualPath::new("/lib.typ").expect("valid test path"),
        );
        assert!(
            world.take_missing_packages().is_empty(),
            "@local misses must not be queued for auto-download"
        );
    }
}
