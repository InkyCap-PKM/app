//! The `inkycap-notebox` Typst library bundled with each notebox. Built into the
//! binary; on notebox open, [`scaffold`] writes it to
//! `<notebox>/.inkycap/notebox.typ`, and notes import it with [`import_line`]:
//!
//! ```typst
//! #import "/.inkycap/notebox.typ": *
//! ```
//!
//! The library is still versioned at build time, so existing noteboxes can be
//! migrated; only the import path is fixed.

use std::path::{Path, PathBuf};

/// Library version. Used for diagnostics and as a hint for future migrations
/// of notebox content. Not part of the import path.
pub const VERSION: &str = "0.5.0";

/// Version of the on-disk notebox format, for tools that work on a notebox
/// without InkyCap. Separate from [`VERSION`] (the library's build version).
/// Bump only for a breaking change to the `.inkycap/` layout or the labels and
/// their dicts, with a migration note. Written to `.inkycap/format.json` (see
/// `write_format_marker`) and documented in
/// `documentation/developer/extending/notebox-format.md`.
pub const FORMAT_VERSION: &str = "1";

/// The Typst labels InkyCap emits and queries (e.g. `typst query <file>
/// "<inkycap-note>"`). Part of the documented format and copied into
/// `.inkycap/format.json`. Keep in sync with `inkycap-notebox/lib.typ`.
pub const QUERY_LABELS: &[&str] = &[
    "inkycap-note",
    "inkycap-tag",
    "inkycap-link",
    "inkycap-agenda",
    "inkycap-annotation",
    "inkycap-suggestion",
];

/// Relative path of the on-disk format marker inside a notebox.
pub fn format_marker_relpath() -> &'static str {
    ".inkycap/format.json"
}

/// The canonical import line auto-prepended to new `.typ` notes.
pub fn import_line() -> String {
    "#import \"/.inkycap/notebox.typ\": *".to_string()
}

/// The language directive for a UI language, or `None` for English (Typst's
/// default) or an unparseable code. The first subtag is the language and a
/// two-letter subtag the region (script subtags like `Hant` are skipped):
/// `"fr-CA"` → `#set text(lang: "fr", region: "CA")`, `"zh-Hant-TW"` → `lang:
/// "zh", region: "TW"`.
///
/// Added to new notes after the import when "Use corresponding language
/// typesetting" is on, so non-English prose hyphenates and spaces correctly.
/// The visual editor hides it with the imports.
pub fn locale_typesetting_directive(ui_locale: &str) -> Option<String> {
    let subtags: Vec<&str> = ui_locale
        .trim()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect();
    let lang = subtags.first()?.to_ascii_lowercase();
    if lang.is_empty() || lang == "en" {
        return None;
    }
    // Region: a trailing two-letter subtag (alpha-2). Searching from the end
    // skips an intervening script subtag (e.g. `zh-Hant-TW` → `TW`, not `Hant`).
    let region = subtags
        .iter()
        .skip(1)
        .rev()
        .find(|s| s.len() == 2 && s.chars().all(|c| c.is_ascii_alphabetic()));
    Some(match region {
        Some(r) => format!(
            "#set text(lang: \"{}\", region: \"{}\")",
            lang,
            r.to_ascii_uppercase()
        ),
        None => format!("#set text(lang: \"{}\")", lang),
    })
}

/// The relative path of the embedded library inside a notebox.
pub fn library_relpath() -> &'static str {
    ".inkycap/notebox.typ"
}

/// Folder for `.collection` files, fixed inside `.inkycap/` since collections
/// aren't arranged by the user like notes.
pub fn collections_relpath() -> &'static str {
    ".inkycap/collections"
}

/// Absolute path of the reserved collections directory inside a notebox.
pub fn collections_dir(notebox_root: &Path) -> PathBuf {
    notebox_root.join(collections_relpath())
}

/// Folder for scaffolds (note templates), fixed inside `.inkycap/` like
/// collections, so they stay out of search and the note list. Edited through
/// the Templates panel.
pub fn scaffolds_relpath() -> &'static str {
    ".inkycap/scaffolds"
}

/// Absolute path of the reserved scaffolds directory inside a notebox.
pub fn scaffolds_dir(notebox_root: &Path) -> PathBuf {
    notebox_root.join(scaffolds_relpath())
}

/// Whether `line` is the notebox library import ([`import_line`]).
pub fn is_notebox_import_line(line: &str) -> bool {
    // A file's first line may begin with a byte order mark, which
    // `trim_start` doesn't treat as whitespace.
    let trimmed = line.trim_start_matches('\u{feff}').trim_start();
    if !trimmed.starts_with("#import") {
        return false;
    }
    trimmed.contains("/.inkycap/notebox.typ")
}

/// Add the notebox import if missing. Used by export for notes made outside
/// InkyCap.
pub fn ensure_import(source: &str) -> String {
    if source.lines().any(is_notebox_import_line) {
        return source.to_string();
    }
    // Keep a leading byte order mark at the very start of the file.
    match source.strip_prefix('\u{feff}') {
        Some(rest) => format!("\u{feff}{}\n{}", import_line(), rest),
        None => format!("{}\n{}", import_line(), source),
    }
}

static LIB_TYP: &[u8] = include_bytes!("../../inkycap-notebox/lib.typ");

/// Default scaffold for the built-in "New Note" rule, written to
/// `<notebox>/.inkycap/scaffolds/new-note.typ` only when absent, so user edits
/// are kept.
pub const DEFAULT_NEW_NOTE_SCAFFOLD: &str = r#"#import "/.inkycap/notebox.typ": *

#note(
  title: "{{filename}}",
  date: "{{date:YYYY-MM-DD}}",
  zid: "{{zid}}",
  tags: (),
  aliases: (),
  description: "",
)
= {{title}}
"#;

/// Default scaffold seeded for the built-in "Daily Note" creation rule.
/// Same write-once semantics as [`DEFAULT_NEW_NOTE_SCAFFOLD`].
pub const DEFAULT_DAILY_NOTE_SCAFFOLD: &str = r#"#import "/.inkycap/notebox.typ": *

#note(
  title: "{{date:D MMMM YYYY}}",
  date: "{{date:YYYY-MM-DD}}",
  zid: "{{zid}}",
  tags: (),
)
= {{title}}
"#;

/// File basename for the seeded New Note scaffold.
pub const NEW_NOTE_SCAFFOLD_FILE: &str = "new-note.typ";
/// File basename for the seeded Daily Note scaffold.
pub const DAILY_NOTE_SCAFFOLD_FILE: &str = "daily-note.typ";

/// Expose the raw library bytes for self-contained export inlining.
pub const LIB_TYP_BYTES: &[u8] = LIB_TYP;

/// Absolute path of the embedded library inside a notebox.
pub fn library_path(notebox_root: &Path) -> PathBuf {
    notebox_root.join(library_relpath())
}

/// Make sure the notebox library is present and current, writing only when it
/// differs. Errors are logged; a missing file shows up as a compile error
/// rather than blocking the open.
pub fn scaffold(notebox_root: &Path) {
    let inkycap_dir = notebox_root.join(".inkycap");
    if let Err(err) = std::fs::create_dir_all(&inkycap_dir) {
        log::warn!(
            "notebox library: failed to create {}: {err}",
            inkycap_dir.display()
        );
        return;
    }

    write_if_changed(&library_path(notebox_root), LIB_TYP);

    // Refresh the externally-readable format marker so out-of-app tools can
    // detect the format contract version and the queryable label set.
    write_format_marker(notebox_root);

    // Ensure the scaffolds directory exists for user-authored note templates.
    let scaffolds = scaffolds_dir(notebox_root);
    if let Err(err) = std::fs::create_dir_all(&scaffolds) {
        log::warn!(
            "notebox library: failed to create {}: {err}",
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

    // The collections folder, created on every open so it exists before the
    // scanner runs.
    let collections_dir = collections_dir(notebox_root);
    if let Err(err) = std::fs::create_dir_all(&collections_dir) {
        log::warn!(
            "notebox library: failed to create {}: {err}",
            collections_dir.display()
        );
    }

    // Remove the old versioned package folder, if any.
    let old_packages_dir = inkycap_dir.join("packages").join("inkycap-notebox");
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

/// The body of a note without its `#import` lines and `#note(...)` call, for
/// previews and merged documents.
pub fn strip_note_preamble(content: &str) -> &str {
    // Find the `#note(...)` call with Typst's parser (`note_call_span`) and
    // return what follows. Per CLAUDE.md's Typst-first principle the parser
    // decides the call's extent, so comments or the locale `#set text(...)`
    // between the import and the call are handled.
    if let Some(span) = crate::typst_pipeline::note_rewriter::note_call_span(content) {
        return content[span.end..].trim_start();
    }
    // No `#note(...)`: skip leading imports, comments and blank lines.
    let mut rest = content;
    loop {
        let trimmed = rest.trim_start();
        if trimmed.starts_with("#import") || trimmed.starts_with("//") {
            match trimmed.find('\n') {
                Some(nl) => rest = &trimmed[nl + 1..],
                None => return "",
            }
        } else {
            return trimmed;
        }
    }
}

/// Write `bytes` to `path` only if nothing is there, so user-editable templates
/// aren't recreated after the user edits or deletes them.
fn write_if_absent(path: &Path, bytes: &[u8]) {
    if path.exists() {
        return;
    }
    if let Err(err) = std::fs::write(path, bytes) {
        log::warn!(
            "notebox library: failed to seed default scaffold {}: {err}",
            path.display()
        );
    }
}

/// Write `.inkycap/format.json`, describing the format for external tools.
/// Rewritten on each open so the versions match the running build. Its shape is
/// part of the format (see
/// `documentation/developer/extending/notebox-format.md`).
fn write_format_marker(notebox_root: &Path) {
    let marker = serde_json::json!({
        "notebox_format_version": FORMAT_VERSION,
        "library_version": VERSION,
        "import_line": import_line(),
        "query_labels": QUERY_LABELS,
        "docs": "documentation/developer/extending/notebox-format.md",
    });
    match serde_json::to_vec_pretty(&marker) {
        Ok(mut bytes) => {
            bytes.push(b'\n');
            write_if_changed(&notebox_root.join(format_marker_relpath()), &bytes);
        }
        Err(err) => log::warn!("notebox format marker: failed to serialize: {err}"),
    }
}

fn write_if_changed(path: &Path, expected: &[u8]) {
    let needs_write = match std::fs::read(path) {
        Ok(existing) => existing != expected,
        Err(_) => true,
    };
    if needs_write {
        if let Err(err) = std::fs::write(path, expected) {
            log::warn!("notebox library: failed to write {}: {err}", path.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn strip_note_preamble_drops_import_and_note() {
        let src = "#import \"/.inkycap/notebox.typ\": *\n\n\
                   #note(title: \"X\")\n= Body\n\nProse.";
        assert_eq!(strip_note_preamble(src), "= Body\n\nProse.");
    }

    #[test]
    fn strip_note_preamble_tolerates_comments_and_set_rules_before_note() {
        // Comments and the locale `#set text(...)` between the import and
        // `#note(...)` don't stop the call being found.
        let src = "#import \"/.inkycap/notebox.typ\": *\n\n\
                   // a note about this note\n\
                   /* block */\n\
                   #set text(lang: \"fr\", region: \"CA\")\n\
                   #note(\n  title: \"X\",\n  tags: (\"y\",),\n)\n\
                   = Body\n\nProse.";
        assert_eq!(strip_note_preamble(src), "= Body\n\nProse.");
    }

    #[test]
    fn strip_note_preamble_without_note_skips_imports_and_comments() {
        let src = "#import \"/.inkycap/notebox.typ\": *\n// orphan comment\n\n\
                   = Heading\nText.";
        assert_eq!(strip_note_preamble(src), "= Heading\nText.");
    }

    #[test]
    fn locale_directive_derives_lang_and_region() {
        assert_eq!(
            locale_typesetting_directive("fr-CA").as_deref(),
            Some("#set text(lang: \"fr\", region: \"CA\")"),
        );
    }

    #[test]
    fn locale_directive_handles_lang_only_and_script_subtag() {
        assert_eq!(
            locale_typesetting_directive("de").as_deref(),
            Some("#set text(lang: \"de\")"),
        );
        // A script subtag (`Hant`) is skipped; the trailing alpha-2 is the region.
        assert_eq!(
            locale_typesetting_directive("zh-Hant-TW").as_deref(),
            Some("#set text(lang: \"zh\", region: \"TW\")"),
        );
        // A non-alpha-2 trailing subtag (UN M.49 region code) yields lang only.
        assert_eq!(
            locale_typesetting_directive("es-419").as_deref(),
            Some("#set text(lang: \"es\")"),
        );
    }

    #[test]
    fn locale_directive_is_none_for_english_or_empty() {
        // English is Typst's default — no directive needed.
        assert_eq!(locale_typesetting_directive("en"), None);
        assert_eq!(locale_typesetting_directive("en-US"), None);
        assert_eq!(locale_typesetting_directive(""), None);
        assert_eq!(locale_typesetting_directive("   "), None);
    }

    #[test]
    fn scaffold_writes_canonical_file() {
        let dir = tempdir().expect("tempdir");
        scaffold(dir.path());
        let lib = dir.path().join(".inkycap/notebox.typ");
        assert!(lib.exists());
        assert_eq!(std::fs::read(&lib).unwrap(), LIB_TYP);
    }

    #[test]
    fn scaffold_writes_format_marker() {
        let dir = tempdir().expect("tempdir");
        scaffold(dir.path());
        let marker = dir.path().join(".inkycap/format.json");
        assert!(marker.exists());
        let parsed: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
        assert_eq!(parsed["notebox_format_version"], FORMAT_VERSION);
        assert_eq!(parsed["library_version"], VERSION);
        // The queryable label set is part of the documented contract.
        let labels = parsed["query_labels"].as_array().unwrap();
        assert!(labels.iter().any(|l| l == "inkycap-note"));
        assert_eq!(labels.len(), QUERY_LABELS.len());
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
        assert_eq!(std::fs::read_to_string(&user_path).unwrap(), user_content);
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
        assert!(line.contains("/.inkycap/notebox.typ"));
    }

    #[test]
    fn detects_canonical_import() {
        assert!(is_notebox_import_line(
            "#import \"/.inkycap/notebox.typ\": *"
        ));
        assert!(is_notebox_import_line(
            "  #import \"/.inkycap/notebox.typ\": tag"
        ));
        assert!(!is_notebox_import_line("#import \"other.typ\": *"));
        assert!(!is_notebox_import_line("= heading"));
        assert!(is_notebox_import_line(
            "\u{feff}#import \"/.inkycap/notebox.typ\": *"
        ));
    }

    #[test]
    fn ensure_import_prepends_once() {
        let fixed = ensure_import("= Café — résumé\n");
        assert_eq!(fixed, format!("{}\n= Café — résumé\n", import_line()));
        assert_eq!(ensure_import(&fixed), fixed);
    }

    #[test]
    fn ensure_import_keeps_byte_order_mark_first() {
        let fixed = ensure_import("\u{feff}= Hello\n");
        assert_eq!(fixed, format!("\u{feff}{}\n= Hello\n", import_line()));
        assert_eq!(ensure_import(&fixed), fixed);
    }
}
