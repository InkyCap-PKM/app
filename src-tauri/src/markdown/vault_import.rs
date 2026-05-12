use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;
use zip::ZipArchive;

use crate::typst_pipeline::path_rebase::rebase_relative_paths;
use crate::vault_package;

use super::md_to_typst::{markdown_to_typst, MarkdownToTypstOptions};

/// Rewrite relative path arguments in `image`/`read`/`embed`/`bibliography`
/// calls to vault-root-absolute paths anchored at the note's location.
/// Markdown commonly emits `![](images/foo.png)` which `markdown_to_typst`
/// turns into `#image("images/foo.png")`. Left alone, that path is fragile
/// (breaks on note move, breaks under merged export). Rebasing at import
/// time produces stable `#image("/notes/images/foo.png")`-style calls.
/// Per CLAUDE.md's portable-paths principle.
fn rebase_for_note(typst_content: &str, relative_note_path: &Path) -> String {
    let note_dir = relative_note_path.parent().unwrap_or_else(|| Path::new(""));
    rebase_relative_paths(typst_content, note_dir)
}

/// Result of a vault import operation.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportResult {
    pub notes_converted: u32,
    pub files_copied: u32,
    pub errors: Vec<String>,
}

/// Import a markdown vault from a directory into the target vault location.
/// Converts .md files to .typ, copies other files as-is, and scaffolds the
/// inkycap-vault package.
pub fn import_from_directory(source: &Path, target: &Path) -> ImportResult {
    let options = MarkdownToTypstOptions::default();
    let mut result = ImportResult {
        notes_converted: 0,
        files_copied: 0,
        errors: Vec::new(),
    };

    // Scaffold the inkycap-vault package in the target.
    vault_package::scaffold(target);

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
            copy_asset_file(path, relative, target, &mut result);
        }
    }

    result
}

/// Import a markdown vault from a zip archive into the target vault location.
pub fn import_from_zip(zip_path: &Path, target: &Path) -> ImportResult {
    let options = MarkdownToTypstOptions::default();
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

    // Scaffold the inkycap-vault package in the target.
    vault_package::scaffold(target);

    // Detect if the zip has a single root directory wrapping everything.
    let root_prefix = detect_zip_root_prefix(&mut archive);

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
            copy_asset_bytes(&content, &relative, target, &mut result);
        }
    }

    result
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

        // Create a simple vault structure.
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

        let result = import_from_directory(source.path(), target.path());

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

        // Vault library scaffolded.
        assert!(target.path().join(".inkycap/vault.typ").exists());
    }

    #[test]
    fn import_rebases_relative_image_paths_to_vault_root_absolute() {
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

        let result = import_from_directory(source.path(), target.path());
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
    fn import_zip_converts_files() {
        let target = TempDir::new().unwrap();

        // Create a zip in memory.
        let zip_path = target.path().join("test_vault.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip_writer = zip::ZipWriter::new(file);

            let options = zip::write::SimpleFileOptions::default();
            zip_writer
                .start_file("vault/hello.md", options)
                .unwrap();
            zip_writer
                .write_all(b"# Hello\n\nWorld.")
                .unwrap();
            zip_writer
                .start_file("vault/assets/pic.jpg", options)
                .unwrap();
            zip_writer.write_all(b"fake jpg").unwrap();
            zip_writer.finish().unwrap();
        }

        let import_target = TempDir::new().unwrap();
        let result = import_from_zip(&zip_path, import_target.path());

        assert_eq!(result.notes_converted, 1);
        assert_eq!(result.files_copied, 1);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);

        // The root prefix "vault/" should be stripped.
        let note = fs::read_to_string(import_target.path().join("hello.typ")).unwrap();
        assert!(note.contains("= Hello"));
        assert!(import_target.path().join("assets/pic.jpg").exists());
    }
}
