//! Commands for installing Typst packages:
//!
//! - [`install_typst_package_by_spec`]: download `@<ns>/<name>:<ver>` from
//!   `packages.typst.org` and extract it.
//! - [`install_typst_package_from_file`]: extract a local `.tar.gz`.
//!
//! Both install into
//! `<notebox>/.inkycap/packages/<namespace>/<name>/<version>/`, where
//! `typst_pipeline/world.rs::resolve_package_path` finds them.

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

/// Install a package by spec (`@preview/cetz:0.2.0`): download
/// `https://packages.typst.org/<ns>/<name>-<ver>.tar.gz` and extract it into
/// `.inkycap/packages/`.
#[tauri::command]
pub async fn install_typst_package_by_spec(
    state: State<'_, AppState>,
    spec: String,
    window: tauri::WebviewWindow,
) -> Result<InstalledPackage, InkyCapError> {
    let session = state.session(window.label()).await;
    let parsed = PackageSpec::parse(&spec).ok_or_else(|| {
        InkyCapError::BadRequest(format!(
            "Invalid package spec '{}'. Use '@namespace/name:version'.",
            spec
        ))
    })?;

    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
    drop(notebox_root);

    let install_dir = parsed.install_dir(&root);
    if install_dir.exists()
        && install_dir
            .read_dir()
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
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

/// Install a package from a local `.tar.gz`, using its `typst.toml` to decide
/// where it goes, or a spec from the user when there is no manifest.
#[tauri::command]
pub async fn install_typst_package_from_file(
    state: State<'_, AppState>,
    archive_path: String,
    override_spec: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<InstalledPackage, InkyCapError> {
    let session = state.session(window.label()).await;
    let archive = PathBuf::from(&archive_path);
    if !archive.exists() {
        return Err(InkyCapError::FileNotFound(archive_path));
    }

    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
    drop(notebox_root);

    // Extract to a temporary folder first, then move it into place once the
    // name and version are known, so a failed extraction leaves nothing behind.
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
        typst_packages::copy_dir_all(&temp_root, &install_dir).map_err(InkyCapError::Io)?;
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

/// Every package installed under `<notebox>/.inkycap/packages/`. Reads each
/// `<ns>/<name>/<ver>/typst.toml` to confirm it is a package and classify it as
/// a "template" (with `[template]`) or a "library". Folders that aren't
/// packages are skipped.
#[tauri::command]
pub async fn list_installed_packages(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<InstalledPackageEntry>, InkyCapError> {
    let session = state.session(window.label()).await;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
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
                let kind = if crate::typst_packages::manifest_declares_template(&toml_contents) {
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

/// Details of an installed package for the Templates panel: its manifest
/// facts and the README, starter file and thumbnail found in its folder (see
/// [`typst_packages::details::read_details`]).
#[tauri::command]
pub async fn get_package_details(
    state: State<'_, AppState>,
    spec: String,
    window: tauri::WebviewWindow,
) -> Result<typst_packages::details::PackageDetails, InkyCapError> {
    let parsed = PackageSpec::parse(&spec)
        .ok_or_else(|| InkyCapError::BadRequest(format!("Invalid package spec '{}'.", spec)))?;
    let session = state.session(window.label()).await;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
    drop(notebox_root);

    let dir = parsed.install_dir(&root);
    typst_packages::details::read_details(&dir, &parsed)
        .ok_or_else(|| InkyCapError::BadRequest(format!("No valid typst.toml for '{}'.", spec)))
}

/// For each of `specs` that has functions named like InkyCap's own, those
/// names: what `#import "<spec>": *` below the notebox import would replace
/// (see [`crate::typst_pipeline::package_imports::replaced_notebox_names`]).
/// Specs without clashes, or not installed, are left out.
#[tauri::command]
pub async fn list_package_name_clashes(
    state: State<'_, AppState>,
    specs: Vec<String>,
    window: tauri::WebviewWindow,
) -> Result<std::collections::HashMap<String, Vec<String>>, InkyCapError> {
    use crate::typst_pipeline::package_imports::{package_facts, replaced_notebox_names};

    let session = state.session(window.label()).await;
    let mut guard = session.typst_compiler.lock().await;
    let compiler = guard.as_mut().ok_or(InkyCapError::NoteboxNotOpen)?;
    let mut clashes = std::collections::HashMap::new();
    for spec in specs {
        let Some(facts) = package_facts(compiler, &spec) else {
            continue;
        };
        let names = replaced_notebox_names(&facts);
        if !names.is_empty() {
            clashes.insert(spec, names);
        }
    }
    Ok(clashes)
}

/// Longest Tinymist may take to document a package.
const DOCS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Largest documentation file read back from Tinymist.
const MAX_DOCS_BYTES: u64 = 64 * 1024 * 1024;

/// Documentation of `@preview` packages, which never change once published, so
/// each is generated once per run.
fn published_docs_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, typst_packages::docs::PackageDocs>>
{
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, typst_packages::docs::PackageDocs>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Reference documentation for a package available locally (in the notebox,
/// the Typst data folder or the shared cache): its top-level functions and
/// their parameters, as Tinymist reads them (see
/// [`typst_packages::docs::parse_package_docs`]).
///
/// Runs the bundled Tinymist from Rust, so the webview's own permission to
/// start it stays limited to the language server. The spec is validated, and
/// every argument is passed directly, never through a shell.
#[tauri::command]
pub async fn get_package_docs(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    spec: String,
    window: tauri::WebviewWindow,
) -> Result<typst_packages::docs::PackageDocs, InkyCapError> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    let parsed = PackageSpec::parse(&spec)
        .ok_or_else(|| InkyCapError::BadRequest(format!("Invalid package spec '{}'.", spec)))?;
    let canonical = parsed.canonical();
    let published = parsed.namespace == "preview";
    if published {
        if let Ok(cache) = published_docs_cache().lock() {
            if let Some(docs) = cache.get(&canonical) {
                return Ok(docs.clone());
            }
        }
    }

    let session = state.session(window.label()).await;
    let root = session
        .notebox_root
        .read()
        .await
        .clone()
        .ok_or(InkyCapError::NoteboxNotOpen)?;
    let dir =
        typst_packages::locate_package_dir(&root, &parsed.namespace, &parsed.name, &parsed.version)
            .ok_or_else(|| InkyCapError::FileNotFound(canonical.clone()))?;
    // `<packages>/<namespace>/<name>/<version>`: Tinymist looks packages up
    // under `<packages>`.
    let packages_dir = dir
        .ancestors()
        .nth(3)
        .ok_or_else(|| InkyCapError::InvalidPath(canonical.clone()))?
        .to_path_buf();

    let out_dir = tempfile::tempdir()?;
    let out_file = out_dir.path().join("docs.md");
    let (mut events, child) = app
        .shell()
        .sidecar("inkycap-tinymist")
        .map_err(|e| InkyCapError::Typst(e.to_string()))?
        .arg("query")
        .arg("packageDocs")
        .arg("--id")
        .arg(&canonical)
        .arg("--output")
        .arg(&out_file)
        .arg("--root")
        .arg(&root)
        .arg("--package-path")
        .arg(&packages_dir)
        .arg("--ignore-system-fonts")
        // Without an input file, Tinymist takes `main.typ` in the working
        // folder as its entry and refuses one outside `--root`.
        .current_dir(&root)
        .spawn()
        .map_err(|e| InkyCapError::Typst(e.to_string()))?;

    let mut stderr = Vec::new();
    let finished = tokio::time::timeout(DOCS_TIMEOUT, async {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => stderr.extend(bytes),
                CommandEvent::Terminated(_) => return true,
                _ => {}
            }
        }
        false
    })
    .await;
    if finished.is_err() {
        let _ = child.kill();
        return Err(InkyCapError::Typst(format!(
            "Tinymist took too long to document {canonical}"
        )));
    }

    let size = tokio::fs::metadata(&out_file).await.map(|m| m.len()).ok();
    match size {
        Some(n) if n <= MAX_DOCS_BYTES => {}
        Some(_) => {
            return Err(InkyCapError::Typst(format!(
                "The documentation for {canonical} is too large to show"
            )))
        }
        None => {
            let detail = String::from_utf8_lossy(&stderr);
            log::warn!("tinymist packageDocs failed for {canonical}: {detail}");
            return Err(InkyCapError::Typst(format!(
                "Tinymist could not document {canonical}"
            )));
        }
    }
    let markdown = tokio::fs::read_to_string(&out_file).await?;
    let mut docs = typst_packages::docs::parse_package_docs(&markdown);
    docs.is_template = std::fs::read_to_string(dir.join("typst.toml"))
        .is_ok_and(|m| typst_packages::manifest_declares_template(&m));
    if published {
        if let Ok(mut cache) = published_docs_cache().lock() {
            cache.insert(canonical, docs.clone());
        }
    }
    Ok(docs)
}

/// What a collection's template supplies to its Custom Typst.
enum TemplateNames {
    /// No template is set.
    None,
    /// A package template: the names it exports.
    Exports(std::collections::HashSet<String>),
    /// A notebox-path template, or a package that isn't installed: its names
    /// can't be known, so nothing is judged stale.
    Unknown,
}

async fn template_names(
    session: &crate::state::NoteboxSession,
    template: Option<&str>,
) -> TemplateNames {
    let Some(template) = template.map(str::trim).filter(|t| !t.is_empty()) else {
        return TemplateNames::None;
    };
    let resolved = crate::commands::export::resolve_template_path(template);
    if !resolved.starts_with('@') {
        return TemplateNames::Unknown;
    }
    let mut guard = session.typst_compiler.lock().await;
    let Some(compiler) = guard.as_mut() else {
        return TemplateNames::Unknown;
    };
    match crate::typst_pipeline::package_imports::package_facts(compiler, &resolved) {
        Some(facts) => TemplateNames::Exports(facts.exports.clone()),
        None => TemplateNames::Unknown,
    }
}

/// `custom_typst` without the template rules the collection's `template`
/// can't supply (see
/// [`crate::typst_pipeline::template_setup::stale_template_rule_names`]): a
/// rule left from an earlier template, or one with no template set, would
/// stop every export with an unknown name. `None` when nothing is left.
pub(crate) async fn usable_custom_typst(
    session: &crate::state::NoteboxSession,
    custom_typst: Option<&str>,
    template: Option<&str>,
) -> Option<String> {
    use crate::typst_pipeline::template_setup::without_stale_template_rules;
    let custom = custom_typst.filter(|c| !c.trim().is_empty())?;
    let usable = match template_names(session, template).await {
        TemplateNames::None => without_stale_template_rules(custom, None),
        TemplateNames::Exports(names) => without_stale_template_rules(custom, Some(&names)),
        TemplateNames::Unknown => custom.to_string(),
    };
    Some(usable).filter(|c| !c.trim().is_empty())
}

/// The functions that `custom_typst`'s template rules apply but the
/// collection's `template` doesn't supply, for the Appearance tab to point out.
#[tauri::command]
pub async fn stale_template_rules(
    state: State<'_, AppState>,
    custom_typst: String,
    template: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<Vec<String>, InkyCapError> {
    use crate::typst_pipeline::template_setup::stale_template_rule_names;
    let session = state.session(window.label()).await;
    Ok(match template_names(&session, template.as_deref()).await {
        TemplateNames::None => stale_template_rule_names(&custom_typst, None),
        TemplateNames::Exports(names) => stale_template_rule_names(&custom_typst, Some(&names)),
        TemplateNames::Unknown => Vec::new(),
    })
}

/// `custom_typst` without the rules [`stale_template_rules`] finds.
#[tauri::command]
pub async fn remove_stale_template_rules(
    state: State<'_, AppState>,
    custom_typst: String,
    template: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<String, InkyCapError> {
    let session = state.session(window.label()).await;
    Ok(
        usable_custom_typst(&session, Some(&custom_typst), template.as_deref())
            .await
            .unwrap_or_default(),
    )
}

/// `custom_typst` with the `#show: <fn>.with(…)` rule from an installed
/// template's starter applied: added at the top, or in place of the rule an
/// earlier template left, and kept as is if already there (see
/// [`apply_template_starter`](crate::typst_pipeline::template_setup::apply_template_starter)).
/// `None` if the spec isn't an installed template package or has no such rule;
/// the caller treats that as no starter.
#[tauri::command]
pub async fn apply_template_starter(
    state: State<'_, AppState>,
    spec: String,
    custom_typst: String,
    collection_path: Option<String>,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, InkyCapError> {
    let session = state.session(window.label()).await;
    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
    drop(notebox_root);

    let snippet = typst_packages::template_starter_snippet(&root, &spec);
    // Point the starter's `bibliography("…")` at the collection's generated
    // bibliography (rebuilt at export from the works cited), so the user has no
    // file to maintain.
    let snippet = match (snippet, collection_path.as_deref()) {
        (Some(s), Some(cp)) => {
            let stem = std::path::Path::new(cp)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned());
            Some(match stem {
                Some(stem) => typst_packages::rewrite_show_rule_bibliography(
                    &s,
                    &format!("/.inkycap/collection-bibs/{stem}.bib"),
                ),
                None => s,
            })
        }
        (s, _) => s,
    };
    Ok(snippet.map(|starter| {
        crate::typst_pipeline::template_setup::apply_template_starter(&custom_typst, &starter)
    }))
}

/// Uninstall a package by spec: delete its version folder, then the name and
/// namespace folders if they are left empty.
#[tauri::command]
pub async fn uninstall_typst_package(
    state: State<'_, AppState>,
    spec: String,
    window: tauri::WebviewWindow,
) -> Result<(), InkyCapError> {
    let session = state.session(window.label()).await;
    let parsed = PackageSpec::parse(&spec)
        .ok_or_else(|| InkyCapError::BadRequest(format!("Invalid package spec '{}'.", spec)))?;

    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
    drop(notebox_root);

    let install_dir = parsed.install_dir(&root);
    if !install_dir.exists() {
        return Err(InkyCapError::FileNotFound(
            install_dir.display().to_string(), // path-stringification-ok: error message, not IPC
        ));
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

/// What depends on a package version, so the uninstall confirmation can warn.
/// Only reported; uninstalling is allowed.
#[derive(Debug, Serialize)]
pub struct PackageDependents {
    /// Display names of creation rules whose `typst_template` is this spec.
    pub rules: Vec<String>,
    /// Notebox-root-relative paths of notes importing this exact spec, capped
    /// at [`NOTE_DEPENDENT_CAP`] for display. `note_total` is the full count.
    pub notes: Vec<String>,
    /// Total notes importing the spec (may exceed `notes.len()` when capped).
    pub note_total: usize,
}

/// Cap on the number of dependent notes returned for display. The confirmation
/// shows "and N more" using `note_total` beyond this.
const NOTE_DEPENDENT_CAP: usize = 15;

/// Find creation rules and notes that depend on a package version. Used to
/// populate the uninstall confirmation; it neither blocks nor mutates anything.
#[tauri::command]
pub async fn find_package_dependents(
    state: State<'_, AppState>,
    spec: String,
    window: tauri::WebviewWindow,
) -> Result<PackageDependents, InkyCapError> {
    let session = state.session(window.label()).await;
    let parsed = PackageSpec::parse(&spec)
        .ok_or_else(|| InkyCapError::BadRequest(format!("Invalid package spec '{}'.", spec)))?;
    let canonical = parsed.canonical();

    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
    drop(notebox_root);

    // Creation rules whose template is this package. Compared canonically so a
    // bare-name or differently-spaced stored spec still matches.
    let rules: Vec<String> = crate::creation_rules::load_rules(&root)
        .into_iter()
        .filter(|r| {
            PackageSpec::parse(&r.typst_template)
                .map(|s| s.canonical() == canonical)
                .unwrap_or(false)
        })
        .map(|r| r.name)
        .collect();

    // Notes that import the exact version (Typst-AST scan).
    let mut notes = crate::typst_pipeline::package_vendor::notes_importing(&root, &canonical);
    notes.sort();
    let note_total = notes.len();
    notes.truncate(NOTE_DEPENDENT_CAP);

    Ok(PackageDependents {
        rules,
        notes,
        note_total,
    })
}

#[derive(Debug, Serialize)]
pub struct CreatedPackage {
    pub spec: String,
    pub install_dir: String,
    pub entrypoint_path: String,
}

/// Create a new local package in
/// `<notebox>/.inkycap/packages/<ns>/<name>/<version>/`, defaulting to the
/// `@local/` namespace and `0.1.0` for a bare name. With `as_template`, the
/// manifest declares `[template]` and `template/main.typ` is created.
#[tauri::command]
pub async fn create_local_package(
    state: State<'_, AppState>,
    spec: String,
    as_template: bool,
    window: tauri::WebviewWindow,
) -> Result<CreatedPackage, InkyCapError> {
    let session = state.session(window.label()).await;
    let parsed = PackageSpec::parse_local_default(&spec).ok_or_else(|| {
        InkyCapError::BadRequest(format!(
            "Invalid package spec '{}'. Use a bare name like 'letter-layout' or '@namespace/name:version'.",
            spec
        ))
    })?;

    let notebox_root = session.notebox_root.read().await;
    let root = notebox_root
        .as_ref()
        .ok_or(InkyCapError::NoteboxNotOpen)?
        .clone();
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
        // Open lib.typ, the file the user edits, rather than the starter
        // document.
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

const TEMPLATE_MAIN_TYP: &str =
    "#import \"../lib.typ\": *\n\n#show: apply.with(title: \"Untitled\")\n\nStart writing here.\n";
