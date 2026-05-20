//! Tauri IPC for installing Typst packages.
//!
//! Two entry points:
//! - [`install_typst_package_by_spec`] — fetch `@<ns>/<name>:<ver>` from
//!   `packages.typst.org` and extract.
//! - [`install_typst_package_from_file`] — extract a local `.tar.gz` the
//!   user already has on disk.
//!
//! Both land in `<notebox>/.inkycap/packages/<namespace>/<name>/<version>/`,
//! which the Typst compile pipeline already resolves at
//! `typst_pipeline/world.rs::resolve_package_path`.

use std::io::Cursor;
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::errors::InkyCapError;
use crate::state::AppState;
use crate::typst_packages::{self, PackageSpec};

#[derive(Debug, Serialize)]
pub struct InstalledPackage {
    pub spec: String,
    pub install_dir: String,
    pub files_written: usize,
}

/// Install a Typst package by spec (`@preview/cetz:0.2.0` style). Fetches
/// `https://packages.typst.org/<ns>/<name>-<ver>.tar.gz` and extracts into
/// the canonical `.inkycap/packages/` layout.
#[tauri::command]
pub async fn install_typst_package_by_spec(
    state: State<'_, AppState>,
    spec: String,
) -> Result<InstalledPackage, InkyCapError> {
    let parsed = PackageSpec::parse(&spec).ok_or_else(|| {
        InkyCapError::BadRequest(format!(
            "Invalid package spec '{}'. Use '@namespace/name:version'.",
            spec
        ))
    })?;

    let notebox_root = state.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?.clone();
    drop(notebox_root);

    let install_dir = parsed.install_dir(&root);
    if install_dir.exists() && install_dir.read_dir().map(|mut d| d.next().is_some()).unwrap_or(false)
    {
        return Err(InkyCapError::BadRequest(format!(
            "{} is already installed.",
            parsed.canonical()
        )));
    }

    let url = parsed.download_url();
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| InkyCapError::BadRequest(format!("Download failed: {}", e)))?
        .error_for_status()
        .map_err(|e| InkyCapError::BadRequest(format!("Universe HTTP error: {}", e)))?
        .bytes()
        .await
        .map_err(|e| InkyCapError::BadRequest(format!("Download read failed: {}", e)))?;

    let written = tokio::task::spawn_blocking({
        let install_dir = install_dir.clone();
        let bytes = bytes.to_vec();
        move || typst_packages::extract_tar_gz(Cursor::new(bytes), &install_dir)
    })
    .await
    .map_err(|e| InkyCapError::BadRequest(format!("Extraction task crashed: {}", e)))?
    .map_err(InkyCapError::Io)?;

    Ok(InstalledPackage {
        spec: parsed.canonical(),
        install_dir: crate::storage::to_frontend_string(&install_dir),
        files_written: written,
    })
}

/// Install a Typst package from a local `.tar.gz` file. Reads
/// `typst.toml` from the extracted archive to determine the canonical
/// install path. Falls back to a user-supplied spec when the archive
/// lacks a manifest.
#[tauri::command]
pub async fn install_typst_package_from_file(
    state: State<'_, AppState>,
    archive_path: String,
    override_spec: Option<String>,
) -> Result<InstalledPackage, InkyCapError> {
    let archive = PathBuf::from(&archive_path);
    if !archive.exists() {
        return Err(InkyCapError::FileNotFound(archive_path));
    }

    let notebox_root = state.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?.clone();
    drop(notebox_root);

    // Extract into a temp dir first, then promote into the canonical
    // location once we know the package's name/version. This avoids
    // writing a partial archive to the canonical path if extraction
    // fails halfway, and lets us name the destination from the manifest.
    let temp = tempfile::tempdir().map_err(InkyCapError::Io)?;
    let temp_root = temp.path().to_path_buf();

    let written = tokio::task::spawn_blocking({
        let temp_root = temp_root.clone();
        let archive = archive.clone();
        move || -> std::io::Result<usize> {
            let file = std::fs::File::open(&archive)?;
            typst_packages::extract_tar_gz(file, &temp_root)
        }
    })
    .await
    .map_err(|e| InkyCapError::BadRequest(format!("Extraction task crashed: {}", e)))?
    .map_err(InkyCapError::Io)?;

    let spec = if let Some(raw) = override_spec.as_deref().filter(|s| !s.trim().is_empty()) {
        PackageSpec::parse(raw).ok_or_else(|| {
            InkyCapError::BadRequest(format!(
                "Invalid override spec '{}'. Use '@namespace/name:version'.",
                raw
            ))
        })?
    } else {
        typst_packages::read_package_manifest(&temp_root).ok_or_else(|| {
            InkyCapError::BadRequest(
                "Archive has no typst.toml at root and no override spec provided.".to_string(),
            )
        })?
    };

    let install_dir = spec.install_dir(&root);
    if install_dir.exists()
        && install_dir
            .read_dir()
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    {
        return Err(InkyCapError::BadRequest(format!(
            "{} is already installed.",
            spec.canonical()
        )));
    }

    if let Some(parent) = install_dir.parent() {
        std::fs::create_dir_all(parent).map_err(InkyCapError::Io)?;
    }
    // Move the temp dir into place. Falls back to copy+remove across
    // mount points (tempdir often lives on a different filesystem).
    if let Err(rename_err) = std::fs::rename(&temp_root, &install_dir) {
        log::debug!(
            "package install: cross-mount move, falling back to copy ({})",
            rename_err
        );
        copy_dir_all(&temp_root, &install_dir).map_err(InkyCapError::Io)?;
    }

    Ok(InstalledPackage {
        spec: spec.canonical(),
        install_dir: crate::storage::to_frontend_string(&install_dir),
        files_written: written,
    })
}

#[derive(Debug, Serialize)]
pub struct InstalledPackageEntry {
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub spec: String,
    pub install_dir: String,
    /// "template" if `typst.toml` declares `[template]`, otherwise "library".
    pub kind: String,
    pub description: Option<String>,
}

/// List every package installed under `<notebox>/.inkycap/packages/`.
///
/// Walks the canonical three-level tree (`<ns>/<name>/<ver>/`) and reads
/// each `typst.toml` to (a) confirm it's a real package and (b) classify
/// it as a Universe-style "template" or a plain "library" based on whether
/// the manifest declares `[template]`. Skips directories that aren't
/// actually packages so the function tolerates stale subdirs without
/// surfacing them as broken entries.
#[tauri::command]
pub async fn list_installed_packages(
    state: State<'_, AppState>,
) -> Result<Vec<InstalledPackageEntry>, InkyCapError> {
    let notebox_root = state.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?.clone();
    drop(notebox_root);

    let packages_dir = root.join(".inkycap").join("packages");
    if !packages_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    let Ok(ns_iter) = std::fs::read_dir(&packages_dir) else {
        return Ok(out);
    };
    for ns_entry in ns_iter.flatten() {
        if !ns_entry.path().is_dir() {
            continue;
        }
        let namespace = ns_entry.file_name().to_string_lossy().to_string();
        let Ok(name_iter) = std::fs::read_dir(ns_entry.path()) else {
            continue;
        };
        for name_entry in name_iter.flatten() {
            if !name_entry.path().is_dir() {
                continue;
            }
            let name = name_entry.file_name().to_string_lossy().to_string();
            let Ok(ver_iter) = std::fs::read_dir(name_entry.path()) else {
                continue;
            };
            for ver_entry in ver_iter.flatten() {
                let ver_path = ver_entry.path();
                if !ver_path.is_dir() {
                    continue;
                }
                let toml_path = ver_path.join("typst.toml");
                let Ok(toml_contents) = std::fs::read_to_string(&toml_path) else {
                    continue;
                };
                let version = ver_entry.file_name().to_string_lossy().to_string();
                let kind = if crate::typst_packages::manifest_declares_template(&toml_contents)
                {
                    "template"
                } else {
                    "library"
                };
                let (description, _authors) =
                    crate::typst_packages::read_package_meta(&toml_contents);
                out.push(InstalledPackageEntry {
                    namespace: namespace.clone(),
                    name: name.clone(),
                    version: version.clone(),
                    spec: format!("@{}/{}:{}", namespace, name, version),
                    install_dir: crate::storage::to_frontend_string(&ver_path),
                    kind: kind.to_string(),
                    description,
                });
            }
        }
    }

    out.sort_by(|a, b| {
        a.namespace
            .cmp(&b.namespace)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.version.cmp(&b.version))
    });
    Ok(out)
}

/// Uninstall a package by spec. Deletes the version directory; if that
/// leaves the name directory empty, removes it too (and the namespace
/// directory if *that* is empty). Best-effort tree cleanup so the
/// `<ns>/<name>/<version>/` shape doesn't accumulate empty stubs.
#[tauri::command]
pub async fn uninstall_typst_package(
    state: State<'_, AppState>,
    spec: String,
) -> Result<(), InkyCapError> {
    let parsed = PackageSpec::parse(&spec).ok_or_else(|| {
        InkyCapError::BadRequest(format!("Invalid package spec '{}'.", spec))
    })?;

    let notebox_root = state.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?.clone();
    drop(notebox_root);

    let install_dir = parsed.install_dir(&root);
    if !install_dir.exists() {
        return Err(InkyCapError::FileNotFound(install_dir.display().to_string())); // path-stringification-ok: error message, not IPC
    }
    std::fs::remove_dir_all(&install_dir).map_err(InkyCapError::Io)?;

    // Cascade-remove empty parents.
    if let Some(name_dir) = install_dir.parent() {
        if dir_is_empty(name_dir) {
            let _ = std::fs::remove_dir(name_dir);
            if let Some(ns_dir) = name_dir.parent() {
                if dir_is_empty(ns_dir) {
                    let _ = std::fs::remove_dir(ns_dir);
                }
            }
        }
    }
    Ok(())
}

fn dir_is_empty(p: &std::path::Path) -> bool {
    std::fs::read_dir(p)
        .map(|mut r| r.next().is_none())
        .unwrap_or(false)
}

#[derive(Debug, Serialize)]
pub struct CreatedPackage {
    pub spec: String,
    pub install_dir: String,
    pub entrypoint_path: String,
}

/// Scaffold a brand-new local package at
/// `<notebox>/.inkycap/packages/<ns>/<name>/<version>/`. Defaults to the
/// `@local/` namespace and version `0.1.0` when the user passes a bare name.
/// When `as_template` is true, declares `[template]` in the manifest and
/// generates `template/main.typ`.
#[tauri::command]
pub async fn create_local_package(
    state: State<'_, AppState>,
    spec: String,
    as_template: bool,
) -> Result<CreatedPackage, InkyCapError> {
    let parsed = PackageSpec::parse_local_default(&spec).ok_or_else(|| {
        InkyCapError::BadRequest(format!(
            "Invalid package spec '{}'. Use a bare name like 'letter-layout' or '@namespace/name:version'.",
            spec
        ))
    })?;

    let notebox_root = state.notebox_root.read().await;
    let root = notebox_root.as_ref().ok_or(InkyCapError::NoteboxNotOpen)?.clone();
    drop(notebox_root);

    let install_dir = parsed.install_dir(&root);
    if install_dir.exists()
        && install_dir
            .read_dir()
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
    {
        return Err(InkyCapError::BadRequest(format!(
            "{} already exists.",
            parsed.canonical()
        )));
    }

    std::fs::create_dir_all(&install_dir).map_err(InkyCapError::Io)?;

    let manifest = build_local_manifest(&parsed.name, &parsed.version, as_template);
    let toml_path = install_dir.join("typst.toml");
    std::fs::write(&toml_path, manifest).map_err(InkyCapError::Io)?;

    let lib_body = if as_template {
        TEMPLATE_LIB_TYP
    } else {
        PACKAGE_LIB_TYP
    };
    let lib_path = install_dir.join("lib.typ");
    std::fs::write(&lib_path, lib_body).map_err(InkyCapError::Io)?;

    let entrypoint_path = if as_template {
        let template_dir = install_dir.join("template");
        std::fs::create_dir_all(&template_dir).map_err(InkyCapError::Io)?;
        let main_path = template_dir.join("main.typ");
        std::fs::write(&main_path, TEMPLATE_MAIN_TYP).map_err(InkyCapError::Io)?;
        // Opening lib.typ is the more useful entrypoint for editing — the
        // user-facing thing they iterate on is the library, not the starter
        // doc. Returning lib.typ here matches the panel's "open entrypoint"
        // expectation in the plan doc.
        lib_path
    } else {
        lib_path
    };

    Ok(CreatedPackage {
        spec: parsed.canonical(),
        install_dir: crate::storage::to_frontend_string(&install_dir),
        entrypoint_path: crate::storage::to_frontend_string(&entrypoint_path),
    })
}

fn build_local_manifest(name: &str, version: &str, as_template: bool) -> String {
    let mut out = String::new();
    out.push_str("[package]\n");
    out.push_str(&format!("name = \"{}\"\n", name));
    out.push_str(&format!("version = \"{}\"\n", version));
    out.push_str("entrypoint = \"lib.typ\"\n");
    out.push_str("# Optional — fill in if you plan to publish to Typst Universe:\n");
    out.push_str("# authors = [\"Your Name <you@example.com>\"]\n");
    out.push_str("# license = \"CC BY\"\n");
    out.push_str("# description = \"What this package does.\"\n");
    out.push_str("# repository = \"https://...\"\n");
    if as_template {
        out.push_str("\n[template]\n");
        out.push_str("path = \"template\"\n");
        out.push_str("entrypoint = \"main.typ\"\n");
        out.push_str("# thumbnail = \"thumbnail.png\"\n");
    }
    out
}

const PACKAGE_LIB_TYP: &str = "// Local Typst package. Import in a note with:\n//   #import \"@local/<name>:<version>\": *\n\n#let hello(name) = [Hello, #name!]\n";

const TEMPLATE_LIB_TYP: &str = "// Local Typst document template. Apply at the top of a note:\n//   #import \"@local/<name>:<version>\": apply\n//   #show: apply.with(title: \"My document\")\n\n#let apply(title: none, body) = {\n  set page(margin: 1in)\n  set text(font: \"Inter\", size: 11pt)\n  if title != none {\n    align(center)[#text(size: 18pt, weight: \"bold\", title)]\n    v(1em)\n  }\n  body\n}\n";

const TEMPLATE_MAIN_TYP: &str = "#import \"../lib.typ\": *\n\n#show: apply.with(title: \"Untitled\")\n\nStart writing here.\n";

fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), dst_path)?;
        }
    }
    Ok(())
}
