//! Vault-bundled `inkycap-vault` Typst package scaffolding.
//!
//! The package source is embedded in the binary at compile time. On vault open,
//! [`scaffold`] ensures `.inkycap/packages/inkycap-vault/<VERSION>/` exists and
//! contains the current `lib.typ` and `typst.toml`. If the files already exist
//! and match, the write is skipped.

use std::path::{Path, PathBuf};

/// Package version. Bumping this creates a new versioned directory; old
/// versions are left in place so existing notes' `#import` lines still resolve.
pub const VERSION: &str = "0.1.0";

/// The import line auto-prepended to new `.typ` notes.
pub fn import_line() -> String {
    format!(
        "#import \"/.inkycap/packages/inkycap-vault/{}/lib.typ\": *",
        VERSION
    )
}

/// Ensure the source contains an inkycap-vault import line. If missing,
/// prepend it. Used by export paths to handle notes created outside InkyCap
/// or with a missing preamble.
pub fn ensure_import(source: &str) -> String {
    if source.contains("inkycap-vault") {
        return source.to_string();
    }
    format!("{}\n{}", import_line(), source)
}

static LIB_TYP: &[u8] = include_bytes!("../../inkycap-vault/0.1.0/lib.typ");
static TYPST_TOML: &[u8] = include_bytes!("../../inkycap-vault/0.1.0/typst.toml");

/// Expose the raw `lib.typ` bytes for self-contained export inlining.
pub const LIB_TYP_BYTES: &[u8] = LIB_TYP;

/// Directory path for the package inside a vault.
pub fn package_dir(vault_root: &Path) -> PathBuf {
    vault_root
        .join(".inkycap")
        .join("packages")
        .join("inkycap-vault")
        .join(VERSION)
}

/// Ensure the inkycap-vault package is present and up-to-date in the vault.
/// Writes are skipped when existing content matches the embedded bytes.
/// Errors are logged and swallowed — a missing package will surface as a
/// compile error, which is better than blocking vault open.
pub fn scaffold(vault_root: &Path) {
    let dir = package_dir(vault_root);

    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "vault package: failed to create {}: {err}",
            dir.display()
        );
        return;
    }

    write_if_changed(&dir.join("lib.typ"), LIB_TYP);
    write_if_changed(&dir.join("typst.toml"), TYPST_TOML);

    // Ensure the scaffolds directory exists
    let scaffolds_dir = vault_root.join(".inkycap").join("scaffolds");
    if let Err(err) = std::fs::create_dir_all(&scaffolds_dir) {
        eprintln!(
            "vault package: failed to create {}: {err}",
            scaffolds_dir.display()
        );
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
                "vault package: failed to write {}: {err}",
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
    fn scaffold_creates_package_files() {
        let dir = tempdir().expect("tempdir");
        scaffold(dir.path());

        let lib = dir
            .path()
            .join(".inkycap/packages/inkycap-vault/0.1.0/lib.typ");
        let toml = dir
            .path()
            .join(".inkycap/packages/inkycap-vault/0.1.0/typst.toml");

        assert!(lib.exists(), "lib.typ should exist");
        assert!(toml.exists(), "typst.toml should exist");
        assert_eq!(std::fs::read(&lib).unwrap(), LIB_TYP);
        assert_eq!(std::fs::read(&toml).unwrap(), TYPST_TOML);
    }

    #[test]
    fn scaffold_is_idempotent() {
        let dir = tempdir().expect("tempdir");
        scaffold(dir.path());
        let lib_path = dir
            .path()
            .join(".inkycap/packages/inkycap-vault/0.1.0/lib.typ");
        let mtime_before = std::fs::metadata(&lib_path)
            .unwrap()
            .modified()
            .unwrap();

        std::thread::sleep(std::time::Duration::from_millis(50));
        scaffold(dir.path());

        let mtime_after = std::fs::metadata(&lib_path)
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(mtime_before, mtime_after, "unchanged file should not be rewritten");
    }

    #[test]
    fn import_line_matches_version() {
        let line = import_line();
        assert!(line.contains(VERSION));
        assert!(line.starts_with("#import"));
    }
}
