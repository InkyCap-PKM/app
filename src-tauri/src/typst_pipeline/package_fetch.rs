//! Download missing Typst packages on demand.
//!
//! When a compile needs a `@preview` package (or one of its dependencies) not found
//! locally, the World records it (see
//! [`crate::typst_pipeline::world::NoteboxWorld::take_missing_packages`]); this downloads
//! it into the shared Typst cache, where `typst-cli` and Tinymist look, and the caller
//! recompiles. Each pass finds the next missing dependency, so
//! [`compile_with_auto_packages`] loops until the document resolves or nothing more can be
//! fetched (offline, 404, `@local`).
//!
//! Packages go to the shared cache, not the notebox, as Typst normally does; bundling them
//! into the notebox is a separate opt-in for sharing. Per CLAUDE.md's Typst-first
//! principle: Typst has no package fetching of its own, so this is Rust glue, using
//! Typst's standard `<cache>/typst/packages/<ns>/<name>/<ver>/` layout.

use std::io::Cursor;

use typst::syntax::package::PackageSpec;

use crate::typst_packages::{self, typst_packages_cache_dir};
use crate::typst_pipeline::compiler::TypstCompiler;

/// Maximum compile passes. Each resolves one layer of dependencies; real chains
/// are shallow, so this only guards against a cycle.
const MAX_PASSES: usize = 16;

/// Run `compile` and, if it left remote packages missing, download them into
/// the shared cache and run it again. When nothing more can be fetched
/// (offline, 404, `@local`), the last result is returned with its `NotFound`
/// error, so the user sees why.
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

/// Download every spec into the shared cache. Returns how many were newly
/// written. Failures are logged and skipped, leaving the compile's `NotFound`
/// error. The only request is the public package URL on `packages.typst.org`;
/// no note content or paths are sent.
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

/// Download one package into `<cache>/typst/packages/<ns>/<name>/<ver>/`. `Ok(true)`
/// when written, `Ok(false)` when already there.
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

    // Universe URL scheme. Other namespaces have no known host and 404, which
    // the caller logs and skips.
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
