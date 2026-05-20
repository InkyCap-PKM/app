use std::collections::HashSet;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;
use zip::ZipArchive;

use crate::typst_pipeline::path_rebase::rebase_relative_paths;
use crate::notebox_package;

use super::md_to_typst::{
    extract_embed_filenames, markdown_to_typst, MarkdownDialect, MarkdownToTypstOptions,
};

/// Rewrite relative path arguments in `image`/`read`/`embed`/`bibliography`
/// calls to notebox-root-absolute paths anchored at the note's location.
/// Markdown commonly emits `![](images/foo.png)` which `markdown_to_typst`
/// turns into `#image("images/foo.png")`. Left alone, that path is fragile
/// (breaks on note move, breaks under merged export). Rebasing at import
/// time produces stable `#image("/notes/images/foo.png")`-style calls.
/// Per CLAUDE.md's portable-paths principle.
fn rebase_for_note(typst_content: &str, relative_note_path: &Path) -> String {
    let note_dir = relative_note_path.parent().unwrap_or_else(|| Path::new(""));
    rebase_relative_paths(typst_content, note_dir)
}

/// Result of a notebox import operation.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportResult {
    pub notes_converted: u32,
    pub files_copied: u32,
    pub errors: Vec<String>,
}

/// Import a markdown notebox from a directory into the target notebox location.
/// Converts .md files to .typ, copies other files as-is, and scaffolds the
/// inkycap-notebox package.
///
/// Obsidian-style image embeds `![[name.png]]` carry no path — the file
/// could live anywhere in the source notebox. To resolve them faithfully
/// the importer makes a first pre-pass to scan every markdown file for
/// embed references, then routes the matching source files into the
/// user's configured `attachment_folder` (instead of preserving their
/// original relative paths) so the emitted
/// `#image("/<attachment_folder>/name.png")` calls land on the actual
/// file. Files referenced by embeds but absent from the source notebox
/// produce broken paths — surfaced to the user instead of silently
/// rewritten — so they can be hand-fixed post-import.
pub fn import_from_directory(
    source: &Path,
    target: &Path,
    dialect: MarkdownDialect,
) -> ImportResult {
    // Import creates a fresh notebox at `target` with no settings yet, so
    // attachment-folder routing uses the per-notebox default. The new
    // notebox's settings file will be seeded at first open.
    let attachment_folder = crate::notebox_settings::NoteboxFileSettings::default()
        .attachment_folder;
    let options = MarkdownToTypstOptions {
        attachment_folder: attachment_folder.clone(),
        dialect,
        ..MarkdownToTypstOptions::default()
    };
    let mut result = ImportResult {
        notes_converted: 0,
        files_copied: 0,
        errors: Vec::new(),
    };

    // Scaffold the inkycap-notebox package in the target.
    notebox_package::scaffold(target);

    // Pre-pass: scan every .md file for `![[filename]]` embed references.
    // The resulting set drives file-routing in the main pass: anything
    // referenced this way goes into `attachment_folder`, anything else
    // keeps its original relative path.
    let embed_targets = scan_directory_embed_targets(source);

    for entry in WalkDir::new(source).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let relative = match path.strip_prefix(source) {
            Ok(r) => r,
            Err(_) => continue,
        };

        // Skip hidden directories (.obsidian, .trash, etc.)
        if relative
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        {
            continue;
        }

        if entry.file_type().is_dir() {
            if relative.as_os_str().is_empty() {
                continue;
            }
            let target_dir = target.join(relative);
            if let Err(e) = fs::create_dir_all(&target_dir) {
                result
                    .errors
                    .push(format!("Failed to create directory {}: {}", relative.display(), e));
            }
            continue;
        }

        if !entry.file_type().is_file() {
            continue;
        }

        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");

        if extension == "md" {
            convert_markdown_file(path, relative, target, &options, &mut result);
        } else {
            let filename = relative
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if !filename.is_empty() && embed_targets.contains(filename) {
                copy_asset_to_attachment_folder(
                    path,
                    filename,
                    target,
                    &attachment_folder,
                    &mut result,
                );
            } else {
                copy_asset_file(path, relative, target, &mut result);
            }
        }
    }

    result
}

/// Walk every `.md` file under `source` and collect the filenames
/// (e.g. `"Pasted image 20240412113956.png"`) referenced by Obsidian-
/// style embed syntax `![[…]]`. Filenames are intentionally bare —
/// the same name in different folders collapses to one entry, matching
/// Obsidian's notebox-wide-by-name lookup semantics.
fn scan_directory_embed_targets(source: &Path) -> HashSet<String> {
    let mut targets = HashSet::new();
    for entry in WalkDir::new(source).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if let Ok(content) = fs::read_to_string(path) {
            for name in extract_embed_filenames(&content) {
                targets.insert(name);
            }
        }
    }
    targets
}

/// Copy an asset file into `<target>/<attachment_folder>/<filename>`,
/// creating the attachment directory as needed. Used for files
/// referenced by `![[name]]` embed syntax so the emitted Typst
/// `#image("/<attachment_folder>/<name>")` paths resolve.
fn copy_asset_to_attachment_folder(
    source_path: &Path,
    filename: &str,
    target_root: &Path,
    attachment_folder: &str,
    result: &mut ImportResult,
) {
    let folder = attachment_folder.trim_matches('/');
    let attach_dir = if folder.is_empty() {
        target_root.to_path_buf()
    } else {
        target_root.join(folder)
    };
    if let Err(e) = fs::create_dir_all(&attach_dir) {
        result.errors.push(format!(
            "Failed to create attachment folder {}: {}",
            attach_dir.display(),
            e
        ));
        return;
    }
    let target_path = attach_dir.join(filename);
    match fs::copy(source_path, &target_path) {
        Ok(_) => result.files_copied += 1,
        Err(e) => result.errors.push(format!(
            "Failed to copy {} → {}: {}",
            source_path.display(),
            target_path.display(),
            e
        )),
    }
}

/// Import a markdown notebox from a zip archive into the target notebox location.
///
/// Mirrors [`import_from_directory`]'s pre-scan-then-route strategy for
/// `![[name]]` image embeds: a first pass collects embed-referenced
/// filenames from every `.md` entry in the archive, then the main pass
/// routes those files into the configured `attachment_folder` instead
/// of preserving their original paths.
pub fn import_from_zip(
    zip_path: &Path,
    target: &Path,
    dialect: MarkdownDialect,
) -> ImportResult {
    let attachment_folder = crate::notebox_settings::NoteboxFileSettings::default()
        .attachment_folder;
    let options = MarkdownToTypstOptions {
        attachment_folder: attachment_folder.clone(),
        dialect,
        ..MarkdownToTypstOptions::default()
    };
    let mut result = ImportResult {
        notes_converted: 0,
        files_copied: 0,
        errors: Vec::new(),
    };

    let file = match fs::File::open(zip_path) {
        Ok(f) => f,
        Err(e) => {
            result
                .errors
                .push(format!("Failed to open zip: {}", e));
            return result;
        }
    };

    let mut archive = match ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => {
            result
                .errors
                .push(format!("Failed to read zip archive: {}", e));
            return result;
        }
    };

    // Scaffold the inkycap-notebox package in the target.
    notebox_package::scaffold(target);

    // Detect if the zip has a single root directory wrapping everything.
    let root_prefix = detect_zip_root_prefix(&mut archive);

    // Pre-pass over the archive: collect every filename referenced by
    // `![[…]]` embed syntax across all .md entries. Reading entries
    // here advances each entry's read state, so the main pass below
    // re-opens by index to start fresh.
    let embed_targets = scan_zip_embed_targets(&mut archive);

    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(e) => {
                result.errors.push(format!("Failed to read zip entry {}: {}", i, e));
                continue;
            }
        };

        let raw_name = match entry.enclosed_name() {
            Some(n) => n.to_path_buf(),
            None => continue,
        };

        // Strip the root prefix if present.
        let relative = if let Some(ref prefix) = root_prefix {
            match raw_name.strip_prefix(prefix) {
                Ok(r) => r.to_path_buf(),
                Err(_) => raw_name.clone(),
            }
        } else {
            raw_name.clone()
        };

        // Skip hidden paths.
        if relative
            .components()
            .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
        {
            continue;
        }

        if entry.is_dir() {
            let target_dir = target.join(&relative);
            if let Err(e) = fs::create_dir_all(&target_dir) {
                result
                    .errors
                    .push(format!("Failed to create directory {}: {}", relative.display(), e));
            }
            continue;
        }

        // Read file content.
        let mut content = Vec::new();
        if let Err(e) = entry.read_to_end(&mut content) {
            result
                .errors
                .push(format!("Failed to read {}: {}", relative.display(), e));
            continue;
        }

        let extension = relative
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        if extension == "md" {
            convert_markdown_bytes(&content, &relative, target, &options, &mut result);
        } else {
            let filename = relative
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if !filename.is_empty() && embed_targets.contains(filename) {
                copy_asset_bytes_to_attachment_folder(
                    &content,
                    filename,
                    target,
                    &attachment_folder,
                    &mut result,
                );
            } else {
                copy_asset_bytes(&content, &relative, target, &mut result);
            }
        }
    }

    result
}

/// Pre-pass over a zip archive: collect filenames referenced by
/// `![[…]]` embed syntax across every `.md` entry. Each call to
/// `archive.by_index(i)` returns a fresh read handle on the entry,
/// so this is independent of the main pass below.
fn scan_zip_embed_targets(archive: &mut ZipArchive<fs::File>) -> HashSet<String> {
    let mut targets = HashSet::new();
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = match entry.enclosed_name() {
            Some(n) => n,
            None => continue,
        };
        if name.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let mut buf = Vec::new();
        if entry.read_to_end(&mut buf).is_err() {
            continue;
        }
        if let Ok(text) = std::str::from_utf8(&buf) {
            for name in extract_embed_filenames(text) {
                targets.insert(name);
            }
        }
    }
    targets
}

/// Bytes variant of [`copy_asset_to_attachment_folder`] for the zip
/// import path. Writes a file already read into memory into
/// `<target_root>/<attachment_folder>/<filename>`.
fn copy_asset_bytes_to_attachment_folder(
    content: &[u8],
    filename: &str,
    target_root: &Path,
    attachment_folder: &str,
    result: &mut ImportResult,
) {
    let folder = attachment_folder.trim_matches('/');
    let attach_dir = if folder.is_empty() {
        target_root.to_path_buf()
    } else {
        target_root.join(folder)
    };
    if let Err(e) = fs::create_dir_all(&attach_dir) {
        result.errors.push(format!(
            "Failed to create attachment folder {}: {}",
            attach_dir.display(),
            e
        ));
        return;
    }
    let target_path = attach_dir.join(filename);
    match fs::write(&target_path, content) {
        Ok(()) => result.files_copied += 1,
        Err(e) => result.errors.push(format!(
            "Failed to write {}: {}",
            target_path.display(),
            e
        )),
    }
}

fn convert_markdown_file(
    source_path: &Path,
    relative: &Path,
    target: &Path,
    options: &MarkdownToTypstOptions,
    result: &mut ImportResult,
) {
    let content = match fs::read_to_string(source_path) {
        Ok(c) => c,
        Err(e) => {
            result
                .errors
                .push(format!("Failed to read {}: {}", relative.display(), e));
            return;
        }
    };

    let typst_content = markdown_to_typst(&content, options);
    let typst_content = rebase_for_note(&typst_content, relative);
    let target_path = target.join(relative).with_extension("typ");

    if let Some(parent) = target_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match fs::write(&target_path, &typst_content) {
        Ok(()) => result.notes_converted += 1,
        Err(e) => {
            result
                .errors
                .push(format!("Failed to write {}: {}", target_path.display(), e));
        }
    }
}

fn convert_markdown_bytes(
    content: &[u8],
    relative: &Path,
    target: &Path,
    options: &MarkdownToTypstOptions,
    result: &mut ImportResult,
) {
    let text = match std::str::from_utf8(content) {
        Ok(t) => t,
        Err(e) => {
            result
                .errors
                .push(format!("Non-UTF8 file {}: {}", relative.display(), e));
            return;
        }
    };

    let typst_content = markdown_to_typst(text, options);
    let typst_content = rebase_for_note(&typst_content, relative);
    let target_path = target.join(relative).with_extension("typ");

    if let Some(parent) = target_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match fs::write(&target_path, &typst_content) {
        Ok(()) => result.notes_converted += 1,
        Err(e) => {
            result
                .errors
                .push(format!("Failed to write {}: {}", target_path.display(), e));
        }
    }
}

fn copy_asset_file(
    source_path: &Path,
    relative: &Path,
    target: &Path,
    result: &mut ImportResult,
) {
    let target_path = target.join(relative);

    if let Some(parent) = target_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match fs::copy(source_path, &target_path) {
        Ok(_) => result.files_copied += 1,
        Err(e) => {
            result
                .errors
                .push(format!("Failed to copy {}: {}", relative.display(), e));
        }
    }
}

fn copy_asset_bytes(
    content: &[u8],
    relative: &Path,
    target: &Path,
    result: &mut ImportResult,
) {
    let target_path = target.join(relative);

    if let Some(parent) = target_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match fs::write(&target_path, content) {
        Ok(()) => result.files_copied += 1,
        Err(e) => {
            result
                .errors
                .push(format!("Failed to write {}: {}", target_path.display(), e));
        }
    }
}

/// Auto-detect the markdown dialect of a source notebox.
///
/// Heuristic: presence of an `.obsidian/` directory anywhere in the
/// source means the notebox was authored in Obsidian. Otherwise default
/// to Standard markdown — the safe choice for arbitrary `.md` sources
/// (literal `#` survives, no Obsidian-only preprocessing applied).
///
/// Works for both directory sources and zip archives.
pub fn detect_dialect_for_directory(source: &Path) -> MarkdownDialect {
    if source.join(".obsidian").is_dir() {
        return MarkdownDialect::Obsidian;
    }
    // Also check one level down in case the user pointed at a parent
    // directory containing the notebox (`source/notebox/.obsidian`).
    if let Ok(entries) = fs::read_dir(source) {
        for entry in entries.flatten() {
            if entry.path().join(".obsidian").is_dir() {
                return MarkdownDialect::Obsidian;
            }
        }
    }
    MarkdownDialect::Standard
}

/// Same heuristic for zip archives: scan entry names for an
/// `.obsidian/` component.
pub fn detect_dialect_for_zip(zip_path: &Path) -> MarkdownDialect {
    let Ok(file) = fs::File::open(zip_path) else {
        return MarkdownDialect::Standard;
    };
    let Ok(mut archive) = ZipArchive::new(file) else {
        return MarkdownDialect::Standard;
    };
    for i in 0..archive.len() {
        let Ok(entry) = archive.by_index_raw(i) else {
            continue;
        };
        let name = entry.name();
        if name
            .split('/')
            .any(|component| component == ".obsidian")
        {
            return MarkdownDialect::Obsidian;
        }
    }
    MarkdownDialect::Standard
}

/// Import a markdown notebox from a `.tar.gz` archive. Extracts the tarball
/// to a temp directory and then runs [`import_from_directory`] on that
/// extraction — mirrors the user-visible behavior of the zip path while
/// reusing the directory walker. The temp dir is cleaned up on drop.
pub fn import_from_tarball(
    tar_path: &Path,
    target: &Path,
    dialect: MarkdownDialect,
) -> ImportResult {
    let mut result = ImportResult {
        notes_converted: 0,
        files_copied: 0,
        errors: Vec::new(),
    };

    let file = match fs::File::open(tar_path) {
        Ok(f) => f,
        Err(e) => {
            result.errors.push(format!("Failed to open tarball: {}", e));
            return result;
        }
    };

    let tmp = match tempfile::tempdir() {
        Ok(t) => t,
        Err(e) => {
            result
                .errors
                .push(format!("Failed to create temp dir: {}", e));
            return result;
        }
    };

    if let Err(e) = crate::typst_packages::extract_tar_gz(file, tmp.path()) {
        result.errors.push(format!("Failed to extract tarball: {}", e));
        return result;
    }

    // Tarballs sometimes wrap everything in a single top-level dir
    // (a la GitHub release archives). If the extracted root has exactly
    // one child directory, use that as the source — same convention as
    // detect_zip_root_prefix.
    let source_root = collapse_single_root(tmp.path());

    let inner = import_from_directory(&source_root, target, dialect);
    result.notes_converted += inner.notes_converted;
    result.files_copied += inner.files_copied;
    result.errors.extend(inner.errors);
    result
}

/// If `dir` contains exactly one entry which is itself a directory, return
/// that inner directory; otherwise return `dir`. Mirrors the wrapper-folder
/// stripping that the zip importer does inline.
fn collapse_single_root(dir: &Path) -> PathBuf {
    let entries: Vec<_> = match fs::read_dir(dir) {
        Ok(r) => r.filter_map(|e| e.ok()).collect(),
        Err(_) => return dir.to_path_buf(),
    };
    if entries.len() == 1 {
        let only = &entries[0];
        if only.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            return only.path();
        }
    }
    dir.to_path_buf()
}

/// Dialect detection for a `.tar.gz` source: peek inside without extracting
/// the whole archive — look for any path component named `.obsidian`.
pub fn detect_dialect_for_tarball(tar_path: &Path) -> MarkdownDialect {
    use flate2::read::GzDecoder;

    let Ok(file) = fs::File::open(tar_path) else {
        return MarkdownDialect::Standard;
    };
    let gz = GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    let Ok(entries) = archive.entries() else {
        return MarkdownDialect::Standard;
    };
    for entry in entries.flatten() {
        let Ok(path) = entry.path() else { continue };
        if path
            .components()
            .any(|c| c.as_os_str() == ".obsidian")
        {
            return MarkdownDialect::Obsidian;
        }
    }
    MarkdownDialect::Standard
}

/// Detect if all entries in a zip share a single root directory prefix
/// (common when zipping a folder).
fn detect_zip_root_prefix(archive: &mut ZipArchive<fs::File>) -> Option<PathBuf> {
    if archive.len() == 0 {
        return None;
    }

    let mut candidate: Option<String> = None;

    for i in 0..archive.len() {
        let name = match archive.by_index_raw(i) {
            Ok(entry) => entry.name().to_string(),
            Err(_) => return None,
        };

        let first_component = name.split('/').next().unwrap_or("");
        if first_component.is_empty() {
            continue;
        }

        match &candidate {
            None => candidate = Some(first_component.to_string()),
            Some(c) if c != first_component => return None,
            _ => {}
        }
    }

    candidate.map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use tempfile::TempDir;

    #[test]
    fn import_directory_converts_md_files() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();

        // Create a simple notebox structure.
        fs::write(
            source.path().join("note.md"),
            "---\ntitle: Test\ntags: [foo]\n---\n\n# Hello\n\nSome [[link]].",
        )
        .unwrap();
        fs::create_dir_all(source.path().join("subfolder")).unwrap();
        fs::write(
            source.path().join("subfolder/nested.md"),
            "# Nested\n\nContent here.",
        )
        .unwrap();
        fs::write(source.path().join("image.png"), b"fake png data").unwrap();

        // Create hidden dir that should be skipped.
        fs::create_dir_all(source.path().join(".obsidian")).unwrap();
        fs::write(
            source.path().join(".obsidian/config.json"),
            "{}",
        )
        .unwrap();

        let result = import_from_directory(source.path(), target.path(), MarkdownDialect::Obsidian);

        assert_eq!(result.notes_converted, 2);
        assert_eq!(result.files_copied, 1);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);

        // Verify converted files exist.
        let note_content = fs::read_to_string(target.path().join("note.typ")).unwrap();
        assert!(note_content.contains("#import"));
        assert!(note_content.contains("#note("));
        assert!(note_content.contains("#wikilink(\"link\")"));
        assert!(note_content.contains("= Hello"));

        let nested = fs::read_to_string(target.path().join("subfolder/nested.typ")).unwrap();
        assert!(nested.contains("= Nested"));

        // Asset copied.
        assert!(target.path().join("image.png").exists());

        // Hidden dir skipped.
        assert!(!target.path().join(".obsidian").exists());

        // Notebox library scaffolded.
        assert!(target.path().join(".inkycap/notebox.typ").exists());
    }

    #[test]
    fn import_rebases_relative_image_paths_to_notebox_root_absolute() {
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();

        // Note at notes/foo.md references images/pic.png alongside it.
        // After import: note at notes/foo.typ, asset at notes/images/pic.png.
        // The emitted #image() call must be /notes/images/pic.png so it
        // survives note moves and merged export — see Phase A/D of the
        // portable-paths plan.
        fs::create_dir_all(source.path().join("notes/images")).unwrap();
        fs::write(
            source.path().join("notes/foo.md"),
            "# Foo\n\n![alt](images/pic.png)\n",
        )
        .unwrap();
        fs::write(source.path().join("notes/images/pic.png"), b"fake").unwrap();

        let result = import_from_directory(source.path(), target.path(), MarkdownDialect::Obsidian);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);

        let typ = fs::read_to_string(target.path().join("notes/foo.typ")).unwrap();
        assert!(
            typ.contains("#image(\"/notes/images/pic.png\")"),
            "expected rebased absolute image path, got:\n{typ}"
        );
        assert!(
            !typ.contains("#image(\"images/pic.png\")"),
            "relative image path must be rewritten, got:\n{typ}"
        );
    }

    #[test]
    fn import_routes_embed_referenced_image_to_attachment_folder() {
        // An Obsidian-style `![[Pasted image.png]]` embed in a note
        // should:
        //   1. Emit `#image("/<attachment_folder>/Pasted image.png")`.
        //   2. Route the source file (wherever it lives in the source
        //      notebox) into `<target>/<attachment_folder>/`, NOT preserve
        //      its original relative path.
        // The default attachment folder is "Assets" (FileSettings::
        // default), which is what load_settings() returns absent a
        // saved user setting.
        let source = TempDir::new().unwrap();
        let target = TempDir::new().unwrap();

        fs::write(
            source.path().join("note.md"),
            "# Note\n\nSee ![[Pasted image 20240412113956.png]] please.",
        )
        .unwrap();
        // Put the referenced file in a subfolder of the source notebox to
        // prove that path-preservation is overridden by the embed-routing.
        fs::create_dir_all(source.path().join("Obsidian Attachments")).unwrap();
        fs::write(
            source
                .path()
                .join("Obsidian Attachments/Pasted image 20240412113956.png"),
            b"fake png bytes",
        )
        .unwrap();

        let result = import_from_directory(source.path(), target.path(), MarkdownDialect::Obsidian);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);

        // Emitted call points at the attachment folder, not the
        // source's "Obsidian Attachments/…" location.
        let note = fs::read_to_string(target.path().join("note.typ")).unwrap();
        assert!(
            note.contains("#image(\"/Assets/Pasted image 20240412113956.png\")"),
            "expected #image() at attachment folder, got:\n{note}"
        );
        assert!(
            !note.contains("!#wikilink"),
            "regression: image embed must not fall through to wikilink"
        );

        // The file lives at the attachment-folder target, not the
        // original subfolder.
        assert!(
            target
                .path()
                .join("Assets/Pasted image 20240412113956.png")
                .exists(),
            "file should have been routed into the attachment folder"
        );
        assert!(
            !target
                .path()
                .join("Obsidian Attachments/Pasted image 20240412113956.png")
                .exists(),
            "file should NOT also be copied to the original location"
        );
    }

    #[test]
    fn import_zip_converts_files() {
        let target = TempDir::new().unwrap();

        // Create a zip in memory.
        let zip_path = target.path().join("test_notebox.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip_writer = zip::ZipWriter::new(file);

            let options = zip::write::SimpleFileOptions::default();
            zip_writer
                .start_file("notebox/hello.md", options)
                .unwrap();
            zip_writer
                .write_all(b"# Hello\n\nWorld.")
                .unwrap();
            zip_writer
                .start_file("notebox/Assets/pic.jpg", options)
                .unwrap();
            zip_writer.write_all(b"fake jpg").unwrap();
            zip_writer.finish().unwrap();
        }

        let import_target = TempDir::new().unwrap();
        let result = import_from_zip(&zip_path, import_target.path(), MarkdownDialect::Obsidian);

        assert_eq!(result.notes_converted, 1);
        assert_eq!(result.files_copied, 1);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);

        // The root prefix "notebox/" should be stripped.
        let note = fs::read_to_string(import_target.path().join("hello.typ")).unwrap();
        assert!(note.contains("= Hello"));
        assert!(import_target.path().join("Assets/pic.jpg").exists());
    }
}
