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

/// Reserved directory for `.collection` files. Collections are an InkyCap
/// architectural concept (not user-arrangeable like notes), so they live
/// under `.inkycap/` alongside the vault library and scaffolds. No user
/// setting; the path is fixed by design.
pub fn collections_relpath() -> &'static str {
    ".inkycap/collections"
}

/// Absolute path of the reserved collections directory inside a vault.
pub fn collections_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(collections_relpath())
}

/// Reserved directory for scaffold (`.typ` note-template) files. Like
/// collections, scaffolds are an InkyCap architectural concept and live in a
/// fixed `.inkycap/` subdirectory — naturally excluded from search and the
/// note browser, editable in-app via the Templates panel.
pub fn scaffolds_relpath() -> &'static str {
    ".inkycap/scaffolds"
}

/// Absolute path of the reserved scaffolds directory inside a vault.
pub fn scaffolds_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(scaffolds_relpath())
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

/// Default scaffold seeded for the built-in "New Note" creation rule.
/// Written to `<vault>/.inkycap/scaffolds/new-note.typ` on first vault open
/// and only when the file is absent — never overwritten so user edits stick.
pub const DEFAULT_NEW_NOTE_SCAFFOLD: &str = r#"#import "/.inkycap/vault.typ": *

#note(
  title: "{{filename}}",
  date: "{{date:YYYY-MM-DD}}",
  zid: "{{zid}}",
  tags: (),
  aliases: (),
  description: "",
)

= {{title}}
{{cursor}}
"#;

/// Default scaffold seeded for the built-in "Daily Note" creation rule.
/// Same write-once semantics as [`DEFAULT_NEW_NOTE_SCAFFOLD`].
pub const DEFAULT_DAILY_NOTE_SCAFFOLD: &str = r#"#import "/.inkycap/vault.typ": *

#note(
  title: "Notes for {{date:D MMMM YYYY}}",
  date: "{{date:YYYY-MM-DD}}",
  zid: "{{zid}}",
  tags: (),
)

= {{title}}
{{cursor}}
"#;

/// File basename for the seeded New Note scaffold.
pub const NEW_NOTE_SCAFFOLD_FILE: &str = "new-note.typ";
/// File basename for the seeded Daily Note scaffold.
pub const DAILY_NOTE_SCAFFOLD_FILE: &str = "daily-note.typ";

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
        log::warn!(
            "vault library: failed to create {}: {err}",
            inkycap_dir.display()
        );
        return;
    }

    write_if_changed(&library_path(vault_root), LIB_TYP);

    // Ensure the scaffolds directory exists for user-authored note templates.
    let scaffolds = scaffolds_dir(vault_root);
    if let Err(err) = std::fs::create_dir_all(&scaffolds) {
        log::warn!(
            "vault library: failed to create {}: {err}",
            scaffolds.display()
        );
    } else {
        // Seed the default scaffolds for the built-in rules. Write-once:
        // if a user has edited or deleted these files, leave them alone.
        write_if_absent(
            &scaffolds.join(NEW_NOTE_SCAFFOLD_FILE),
            DEFAULT_NEW_NOTE_SCAFFOLD.as_bytes(),
        );
        write_if_absent(
            &scaffolds.join(DAILY_NOTE_SCAFFOLD_FILE),
            DEFAULT_DAILY_NOTE_SCAFFOLD.as_bytes(),
        );
    }

    // Reserved location for `.collection` files. Created on every vault open
    // so the directory exists before the scanner runs; collections never
    // live anywhere else.
    let collections_dir = collections_dir(vault_root);
    if let Err(err) = std::fs::create_dir_all(&collections_dir) {
        log::warn!(
            "vault library: failed to create {}: {err}",
            collections_dir.display()
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

/// Write `bytes` to `path` only if no file exists there. Used to seed
/// user-editable templates: once a user has touched the file (or
/// intentionally deleted it), we don't recreate it on the next vault open.
fn write_if_absent(path: &Path, bytes: &[u8]) {
    if path.exists() {
        return;
    }
    if let Err(err) = std::fs::write(path, bytes) {
        log::warn!(
            "vault library: failed to seed default scaffold {}: {err}",
            path.display()
        );
    }
}

fn write_if_changed(path: &Path, expected: &[u8]) {
    let needs_write = match std::fs::read(path) {
        Ok(existing) => existing != expected,
        Err(_) => true,
    };
    if needs_write {
        if let Err(err) = std::fs::write(path, expected) {
            log::warn!(
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
    fn scaffold_seeds_default_scaffolds() {
        let dir = tempdir().expect("tempdir");
        scaffold(dir.path());
        let new_note = scaffolds_dir(dir.path()).join(NEW_NOTE_SCAFFOLD_FILE);
        let daily = scaffolds_dir(dir.path()).join(DAILY_NOTE_SCAFFOLD_FILE);
        assert!(new_note.exists());
        assert!(daily.exists());
        assert_eq!(
            std::fs::read_to_string(&new_note).unwrap(),
            DEFAULT_NEW_NOTE_SCAFFOLD
        );
        assert_eq!(
            std::fs::read_to_string(&daily).unwrap(),
            DEFAULT_DAILY_NOTE_SCAFFOLD
        );
    }

    #[test]
    fn scaffold_seeding_preserves_user_edits() {
        let dir = tempdir().expect("tempdir");
        scaffold(dir.path());
        let user_path = scaffolds_dir(dir.path()).join(NEW_NOTE_SCAFFOLD_FILE);
        // Simulate the user editing the scaffold after first open.
        let user_content = "// my edit\n#note()\n\n= Hello\n";
        std::fs::write(&user_path, user_content).unwrap();
        // Re-running scaffold() must NOT overwrite the user's version.
        scaffold(dir.path());
        assert_eq!(
            std::fs::read_to_string(&user_path).unwrap(),
            user_content
        );
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

}
