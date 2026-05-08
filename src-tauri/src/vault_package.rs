//! Vault-bundled `inkycap-vault` Typst library.
//!
//! The library source is embedded in the binary at compile time. On vault
//! open, [`scaffold`] writes it to a stable, version-less location at
//! `<vault>/.inkycap/vault.typ`. Notes import it with the canonical line
//! returned by [`import_line`]:
//!
//! ```typst
//! #import "/.inkycap/vault.typ": *
//! ```
//!
//! The file content is still versioned at build time so that future migrations
//! can be applied to existing vault content; only the import path users see in
//! their notes is stable.

use std::path::{Path, PathBuf};

/// Library version. Used for diagnostics and as a hint for future migrations
/// of vault content. Not part of the import path.
pub const VERSION: &str = "0.1.0";

/// The canonical import line auto-prepended to new `.typ` notes.
pub fn import_line() -> String {
    "#import \"/.inkycap/vault.typ\": *".to_string()
}

/// The relative path of the embedded library inside a vault.
pub fn library_relpath() -> &'static str {
    ".inkycap/vault.typ"
}

/// Match any line that imports the inkycap-vault library, including legacy
/// versioned paths from earlier releases. Used by detection and migration
/// code so we keep working with notes from older vaults.
pub fn is_vault_import_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    if !trimmed.starts_with("#import") {
        return false;
    }
    trimmed.contains("/.inkycap/vault.typ")
        || trimmed.contains("/.inkycap/packages/inkycap-vault/")
}

/// Ensure the source contains an inkycap-vault import line. If missing,
/// prepend it. Used by export paths to handle notes created outside InkyCap
/// or with a missing preamble.
pub fn ensure_import(source: &str) -> String {
    if source.lines().any(is_vault_import_line) {
        return source.to_string();
    }
    format!("{}\n{}", import_line(), source)
}

static LIB_TYP: &[u8] = include_bytes!("../../inkycap-vault/0.1.0/lib.typ");

/// Expose the raw library bytes for self-contained export inlining.
pub const LIB_TYP_BYTES: &[u8] = LIB_TYP;

/// Absolute path of the embedded library inside a vault.
pub fn library_path(vault_root: &Path) -> PathBuf {
    vault_root.join(library_relpath())
}

/// Ensure the inkycap-vault library is present and up-to-date in the vault.
/// Writes are skipped when the file already matches the embedded bytes.
/// Errors are logged and swallowed — a missing file will surface as a
/// compile error, which is better than blocking vault open.
pub fn scaffold(vault_root: &Path) {
    let inkycap_dir = vault_root.join(".inkycap");
    if let Err(err) = std::fs::create_dir_all(&inkycap_dir) {
        eprintln!(
            "vault library: failed to create {}: {err}",
            inkycap_dir.display()
        );
        return;
    }

    write_if_changed(&library_path(vault_root), LIB_TYP);

    // Ensure the scaffolds directory exists for user-authored note templates.
    let scaffolds_dir = inkycap_dir.join("scaffolds");
    if let Err(err) = std::fs::create_dir_all(&scaffolds_dir) {
        eprintln!(
            "vault library: failed to create {}: {err}",
            scaffolds_dir.display()
        );
    }

    // Best-effort cleanup of the old versioned package layout. Leaving the
    // stale tree in place would not break anything, but keeping the vault
    // tidy after a one-time migration is preferable.
    let old_packages_dir = inkycap_dir.join("packages").join("inkycap-vault");
    if old_packages_dir.exists() {
        let _ = std::fs::remove_dir_all(&old_packages_dir);
        let parent = inkycap_dir.join("packages");
        // Only remove the parent if it is now empty.
        if parent.exists() {
            if let Ok(mut entries) = std::fs::read_dir(&parent) {
                if entries.next().is_none() {
                    let _ = std::fs::remove_dir(&parent);
                }
            }
        }
    }
}

/// Walk the vault and rewrite legacy versioned `#import` lines to the
/// canonical, version-less form. Idempotent. Files under `.inkycap/` are
/// skipped — they are not user notes.
pub fn migrate_vault_imports(vault_root: &Path) {
    let canonical = import_line();
    walk_typ_files(vault_root, &mut |path| {
        let Ok(original) = std::fs::read_to_string(path) else {
            return;
        };
        let mut changed = false;
        let mut out = String::with_capacity(original.len());
        let mut first_canonical_seen = false;
        for line in original.split_inclusive('\n') {
            // Strip trailing newline for matching, preserve it on output.
            let (body, nl) = if let Some(stripped) = line.strip_suffix('\n') {
                (stripped, "\n")
            } else {
                (line, "")
            };
            if is_vault_import_line(body) {
                // Replace the line with the canonical form. If the file had
                // multiple import lines (rare, but possible after manual
                // edits), keep only the first to avoid double imports.
                if first_canonical_seen {
                    changed = true;
                    continue;
                }
                first_canonical_seen = true;
                if body == canonical {
                    out.push_str(body);
                    out.push_str(nl);
                } else {
                    out.push_str(&canonical);
                    out.push_str(nl);
                    changed = true;
                }
            } else {
                out.push_str(body);
                out.push_str(nl);
            }
        }
        if changed {
            if let Err(err) = std::fs::write(path, out) {
                eprintln!(
                    "vault migration: failed to rewrite {}: {err}",
                    path.display()
                );
            }
        }
    });
}

fn walk_typ_files(root: &Path, visit: &mut dyn FnMut(&Path)) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            // Skip the vault's internal storage tree.
            if path.file_name().map_or(false, |n| n == ".inkycap") {
                continue;
            }
            // Skip dotfiles in general; users keep .git etc. there.
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .map_or(false, |n| n.starts_with('.'))
            {
                continue;
            }
            walk_typ_files(&path, visit);
        } else if file_type.is_file() {
            if path.extension().map_or(false, |e| e == "typ") {
                visit(&path);
            }
        }
    }
}

/// Strip the Typst note preamble (`#import` lines and `#note(...)` call)
/// from the top of a note, returning the body content. Used for previews
/// and when merging notes to avoid duplicate preambles.
pub fn strip_note_preamble(content: &str) -> &str {
    let mut rest = content;
    // Skip leading whitespace and #import lines
    loop {
        let trimmed = rest.trim_start();
        if trimmed.starts_with("#import") {
            if let Some(nl) = trimmed.find('\n') {
                rest = &trimmed[nl + 1..];
            } else {
                return "";
            }
        } else {
            rest = trimmed;
            break;
        }
    }
    // Skip #note(...) call if present (may span multiple lines)
    if rest.starts_with("#note(") {
        let mut depth: i32 = 0;
        let mut in_string = false;
        let mut escape = false;
        for (i, ch) in rest.char_indices() {
            if escape {
                escape = false;
                continue;
            }
            if ch == '\\' && in_string {
                escape = true;
                continue;
            }
            if ch == '"' {
                in_string = !in_string;
                continue;
            }
            if in_string {
                continue;
            }
            if ch == '(' {
                depth += 1;
            }
            if ch == ')' {
                depth -= 1;
                if depth == 0 {
                    rest = &rest[i + 1..];
                    break;
                }
            }
        }
    }
    rest.trim_start()
}

fn write_if_changed(path: &Path, expected: &[u8]) {
    let needs_write = match std::fs::read(path) {
        Ok(existing) => existing != expected,
        Err(_) => true,
    };
    if needs_write {
        if let Err(err) = std::fs::write(path, expected) {
            eprintln!(
                "vault library: failed to write {}: {err}",
                path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn scaffold_writes_canonical_file() {
        let dir = tempdir().expect("tempdir");
        scaffold(dir.path());
        let lib = dir.path().join(".inkycap/vault.typ");
        assert!(lib.exists());
        assert_eq!(std::fs::read(&lib).unwrap(), LIB_TYP);
    }

    #[test]
    fn scaffold_is_idempotent() {
        let dir = tempdir().expect("tempdir");
        scaffold(dir.path());
        let lib = library_path(dir.path());
        let mtime_before = std::fs::metadata(&lib).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        scaffold(dir.path());
        let mtime_after = std::fs::metadata(&lib).unwrap().modified().unwrap();
        assert_eq!(mtime_before, mtime_after);
    }

    #[test]
    fn import_line_is_versionless() {
        let line = import_line();
        assert!(!line.contains("0.1.0"));
        assert!(line.contains("/.inkycap/vault.typ"));
    }

    #[test]
    fn detects_legacy_and_canonical_imports() {
        assert!(is_vault_import_line(
            "#import \"/.inkycap/vault.typ\": *"
        ));
        assert!(is_vault_import_line(
            "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *"
        ));
        assert!(is_vault_import_line(
            "#import \"/.inkycap/packages/inkycap-vault/9.9.9/lib.typ\": tag"
        ));
        assert!(!is_vault_import_line("#import \"other.typ\": *"));
        assert!(!is_vault_import_line("= heading"));
    }

    #[test]
    fn migrate_rewrites_legacy_imports() {
        let dir = tempdir().expect("tempdir");
        let note = dir.path().join("a.typ");
        std::fs::write(
            &note,
            "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n#note()\n= Body\n",
        )
        .unwrap();
        migrate_vault_imports(dir.path());
        let after = std::fs::read_to_string(&note).unwrap();
        assert!(after.starts_with("#import \"/.inkycap/vault.typ\": *\n"));
        assert!(after.contains("= Body"));
    }

    #[test]
    fn migrate_skips_inkycap_dir() {
        let dir = tempdir().expect("tempdir");
        let internal = dir.path().join(".inkycap").join("scaffolds").join("x.typ");
        std::fs::create_dir_all(internal.parent().unwrap()).unwrap();
        let original =
            "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n= scaffold\n";
        std::fs::write(&internal, original).unwrap();
        migrate_vault_imports(dir.path());
        // .inkycap/ contents must not be rewritten by the user-content migration.
        assert_eq!(std::fs::read_to_string(&internal).unwrap(), original);
    }

    #[test]
    fn migrate_idempotent_on_canonical() {
        let dir = tempdir().expect("tempdir");
        let note = dir.path().join("a.typ");
        let content = "#import \"/.inkycap/vault.typ\": *\n= Body\n";
        std::fs::write(&note, content).unwrap();
        migrate_vault_imports(dir.path());
        assert_eq!(std::fs::read_to_string(&note).unwrap(), content);
    }
}
