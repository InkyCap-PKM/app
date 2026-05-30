//! On-demand Typst package resolution (tier B).
//!
//! When a compile references a `@preview` package — or a transitive dependency
//! of one — that isn't present in any local package directory, the World
//! records it (see [`crate::typst_pipeline::world::NoteboxWorld::take_missing_packages`]).
//! This module downloads those packages into the shared Typst cache, exactly
//! where `typst-cli` and Tinymist look, and the caller recompiles.
//!
//! Each compile pass surfaces the *next* missing transitive dependency (lilaq
//! → elembic → …), so [`compile_with_auto_packages`] loops until the document
//! resolves fully or no further package can be fetched (offline, 404, or a
//! non-downloadable `@local` package).
//!
//! Downloads go to the **shared cache**, not into the notebox: a notebox is not
//! made self-contained by default — that is a deliberate, opt-in "vendor
//! packages for sharing" action (collaboration export). This mirrors standard
//! Typst behaviour, so what compiles in InkyCap compiles in any Typst tool on
//! the machine.
//!
//! Per CLAUDE.md's Typst-first principle: Typst has no package-fetching logic
//! of its own (every editor ships its own), so the download itself is
//! unavoidable Rust glue. The layout we read and write, however, is the
//! Typst-canonical `<cache>/typst/packages/<ns>/<name>/<ver>/`.

use std::io::Cursor;

use typst::syntax::package::PackageSpec;

use crate::typst_packages::{self, typst_packages_cache_dir};
use crate::typst_pipeline::compiler::TypstCompiler;

/// Maximum compile passes. Each pass resolves one "layer" of transitive
/// dependencies; real dependency chains are shallow, so this is a generous
/// backstop against a pathological cycle, not a tuning knob.
const MAX_PASSES: usize = 16;

/// Run `compile` (a synchronous compile closure) and, if it left any remote
/// packages unresolved, download them into the shared Typst cache and retry.
///
/// The closure is called at least once and re-invoked after each successful
/// download round. It returns the compile result unchanged; the only thing
/// this wrapper adds is the fetch-and-retry loop. When nothing new can be
/// fetched (offline, registry 404, or an `@local` package with no registry),
/// the most recent result is returned as-is — carrying its `NotFound`
/// diagnostic — so the user still sees a meaningful error.
pub async fn compile_with_auto_packages<T>(
    compiler: &mut TypstCompiler,
    mut compile: impl FnMut(&mut TypstCompiler) -> T,
) -> T {
    let mut out = compile(compiler);
    for _ in 0..MAX_PASSES {
        let missing = compiler.world().take_missing_packages();
        if missing.is_empty() {
            break;
        }
        if fetch_into_cache(&missing).await == 0 {
            // Nothing new landed — recompiling would surface the same misses.
            break;
        }
        out = compile(compiler);
    }
    out
}

/// Download every spec into the shared Typst cache directory. Returns the
/// count newly written (0 if all were already present or none could be
/// fetched). Per-package failures are logged and skipped: a failed fetch
/// simply leaves the original `NotFound` compile diagnostic in place rather
/// than aborting the whole compile.
///
/// Note contents and filesystem paths are never sent anywhere here — the only
/// outbound request is the public package URL on `packages.typst.org`.
pub async fn fetch_into_cache(specs: &[PackageSpec]) -> usize {
    let mut fetched = 0;
    for spec in specs {
        match download_one(spec).await {
            Ok(true) => fetched += 1,
            Ok(false) => {}
            Err(err) => log::warn!("auto-download of {} failed: {}", spec, err),
        }
    }
    fetched
}

/// Download a single package tarball into `<cache>/typst/packages/<ns>/<name>/<ver>/`.
/// Returns `Ok(true)` when bytes were written, `Ok(false)` when the package was
/// already present (a prior pass, another tool, or a race fetched it).
async fn download_one(spec: &PackageSpec) -> Result<bool, String> {
    let cache = typst_packages_cache_dir()
        .ok_or_else(|| "no Typst cache directory available".to_string())?;
    let dir = cache
        .join(spec.namespace.as_str())
        .join(spec.name.as_str())
        .join(spec.version.to_string());

    if dir.is_dir()
        && std::fs::read_dir(&dir)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    {
        return Ok(false);
    }

    // Universe convention: https://packages.typst.org/<ns>/<name>-<ver>.tar.gz.
    // Non-preview namespaces have no known host and simply 404 here, which is
    // logged and skipped by the caller.
    let url = format!(
        "https://packages.typst.org/{}/{}-{}.tar.gz",
        spec.namespace.as_str(),
        spec.name.as_str(),
        spec.version
    );

    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("registry HTTP error: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("download read failed: {e}"))?;

    let dest = dir.clone();
    tokio::task::spawn_blocking(move || {
        typst_packages::extract_tar_gz(Cursor::new(bytes.to_vec()), &dest)
    })
    .await
    .map_err(|e| format!("extraction task crashed: {e}"))?
    .map_err(|e| format!("extraction failed: {e}"))?;

    Ok(true)
}
