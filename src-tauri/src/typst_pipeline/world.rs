//! `typst::World` implementation backed by a notebox directory on disk.
//!
//! The World is the interface Typst's compiler uses to resolve everything it
//! needs from the host: the standard library, fonts, source files, binary
//! files, and "today". We keep one World per open notebox and re-use it across
//! compiles so comemo memoization stays warm — that's what gets us the
//! sub-millisecond warm-path numbers from the Phase 0 bench.

use std::collections::HashMap;
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

/// Per-FileId cached source text. Held under a Mutex so `World::source` can
/// take `&self` (Typst requires `Sync`).
struct SourceCache {
    sources: Mutex<HashMap<FileId, Source>>,
}

impl SourceCache {
    fn new() -> Self {
        Self {
            sources: Mutex::new(HashMap::new()),
        }
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

    /// Wipe the entire cache. Used on full notebox reload.
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
        Self {
            files: Mutex::new(HashMap::new()),
        }
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

pub struct NoteboxWorld {
    /// Canonical notebox root. The caller is responsible for canonicalizing
    /// before construction (see [`crate::storage::path::canonicalize_root`]);
    /// see also the test helper which does this. Storing the canonical form
    /// is what lets [`fs_path`] use `validate_notebox_path` to reject symlink
    /// escapes — `starts_with` only works against a canonical prefix.
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
    /// Remote-namespace packages the resolver couldn't locate in any known
    /// directory (notebox-vendored, Typst data dir, or Typst cache dir).
    /// Drained by the compile command layer via [`take_missing_packages`],
    /// which downloads them into the shared Typst cache and recompiles. This
    /// is what makes transitive dependencies resolve: each compile pass
    /// surfaces the next missing package. `@local` packages are never recorded
    /// — they have no registry to download from.
    missing_packages: Mutex<Vec<PackageSpec>>,
}

impl NoteboxWorld {
    /// Build a World rooted at `canonical_notebox_root`. The path MUST already
    /// be canonical (no `..`, no symlinks in the prefix). The notebox open path
    /// at [`crate::state::AppState::open_notebox_fast`] ensures this; tests use
    /// the [`canonicalize_root`] helper.
    pub fn new(canonical_notebox_root: PathBuf) -> Self {
        let (book, fonts) = fonts::load_embedded();
        // Placeholder main; set_main replaces it before the first compile.
        // 0.15: FileId wraps a RootedPath (root + vpath); VirtualPath::new now
        // validates (forward-slashes only) and returns a Result.
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

    /// Drain the set of remote packages the resolver failed to find since the
    /// last call. The compile command layer downloads these into the shared
    /// Typst cache and recompiles (the World caches only successful reads, so a
    /// plain recompile picks up a freshly-downloaded package — no explicit
    /// cache eviction needed).
    pub fn take_missing_packages(&self) -> Vec<PackageSpec> {
        self.missing_packages
            .lock()
            .map(|mut v| std::mem::take(&mut *v))
            .unwrap_or_default()
    }

    /// Record a package the resolver couldn't locate, for later download.
    /// Only remote namespaces are recorded — `@local` has no registry URL,
    /// so a missing `@local` package is a genuine "not found" the user must
    /// resolve by providing the files (it stays an unrecoverable compile error).
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

    /// Load system and notebox-local fonts into the font book. Called once on
    /// demand when the user configures a non-embedded font family. Rebuilds
    /// the book and slots from scratch (embedded + system + notebox) so the
    /// index stays consistent.
    pub fn load_system_fonts(&mut self) {
        if self.system_fonts_loaded {
            return;
        }
        let (book, slots) = fonts::load_all(&self.canonical_notebox_root);
        self.book = LazyHash::new(book);
        self.fonts = slots;
        self.system_fonts_loaded = true;
    }

    /// Convert a notebox-absolute filesystem path into the FileId Typst uses to
    /// reference it. The path must be inside the notebox; otherwise we return
    /// `None`.
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

    /// Drop a single file from both source and binary caches. Hook for the
    /// notebox watcher: when a file changes on disk, invalidate it so the next
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

    /// Resolve a FileId to an on-disk path inside the notebox.
    ///
    /// Package imports (`@namespace/name:version`) are resolved against a local
    /// package directory at `<notebox>/.inkycap/packages/<namespace>/<name>/<version>/`.
    /// The entrypoint defaults to the root vpath of the package (typically
    /// `/lib.typ` as declared in `typst.toml`).
    ///
    /// Goes through [`validate_notebox_path`] so a symlink inside the notebox
    /// pointing at `/etc/passwd` (or anywhere outside the canonical root)
    /// fails before bytes leave disk.
    fn fs_path(&self, id: FileId) -> FileResult<PathBuf> {
        if let VirtualRoot::Package(spec) = id.root() {
            return self.resolve_package_path(spec, id.vpath());
        }
        let rel = id.vpath().get_without_slash();
        let joined = self.canonical_notebox_root.join(rel);
        validate_notebox_path(&self.canonical_notebox_root, &joined)
            .map_err(|_err| FileError::AccessDenied)
    }

    /// Resolve a package file to a local path, searching three roots in
    /// priority order:
    ///
    /// 1. **Notebox-vendored** — `<notebox>/.inkycap/packages/<ns>/<name>/<ver>/`.
    ///    Packages bundled with the notebox (travels under sync, highest
    ///    priority so a notebox can pin its own copy).
    /// 2. **Typst data dir** — `dirs::data_dir()/typst/packages/...`, where
    ///    `@local` packages and manually-persisted installs live.
    /// 3. **Typst cache dir** — `dirs::cache_dir()/typst/packages/...`, where
    ///    downloaded `@preview` packages land (shared with `typst-cli` and
    ///    Tinymist).
    ///
    /// The three-level `<namespace>/<name>/<version>/<vpath>` layout under each
    /// root is the Typst-canonical one used by `typst-cli`, Tinymist, and
    /// `typst.ts`, so a package found in any of them compiles identically here.
    ///
    /// On a total miss the spec is recorded via [`record_missing_package`] so
    /// the compile command layer can download it and recompile (tier-B
    /// on-demand resolution), then `NotFound` is returned for this attempt.
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
            // Containment-validate against this package root (not the notebox
            // root — the cache/data dirs live outside it) so a `..` in the
            // package's own vpath can't escape its directory. Canonicalize the
            // root first; `validate_notebox_path` needs a canonical prefix for
            // the `starts_with` check to hold when the path contains symlinks.
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

    /// 1×1 transparent PNG — smallest valid PNG the typst-svg image decoder
    /// will accept end-to-end. Generated by zlib-compressing a one-pixel RGBA
    /// scanline; verified by feeding through Typst's compile pipeline below.
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

        // VirtualPath normalizes `..`/leading-slashes against the virtual root,
        // so a literal escape attempt like `../../etc/passwd` ends up resolving
        // back inside the root before fs_path even runs. That's good — but it's
        // not the case we care about here. The case we *do* care about is a
        // symlink inside the notebox that targets outside of it; see the
        // `rejects_symlink_escape` test below.
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

        // An attacker drops a symlink inside the notebox that points at a
        // sensitive file outside it, then crafts a `.typ` doing
        // `#read("escape/secret.txt")` (or `#image(...)`, etc.). The compile
        // pipeline must refuse to read through it.
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
        // End-to-end: a `.typ` file referencing a notebox-local PNG should
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
