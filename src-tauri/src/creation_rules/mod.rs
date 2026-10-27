// Creation rules: note creation presets, each with a scaffold, folder, file name
// pattern and optional hotkey. Stored in `<notebox>/.inkycap/creation_rules.json`,
// since they refer to the notebox's scaffolds and folders. "New Note" and "Daily
// Note" are always present.

use std::path::{Path, PathBuf};

use chrono::Locale;
use serde::{Deserialize, Serialize};

use crate::errors::{InkyCapError, Result};
use crate::scaffolds;

/// A single creation rule definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreationRule {
    /// Unique identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Emoji icon for the toolbar/palette.
    pub icon_emoji: String,
    /// Path to scaffold file (relative to notebox's scaffold folder).
    /// Empty string means no scaffold.
    #[serde(default)]
    pub scaffold_path: String,
    /// Target folder for new notes (relative to notebox root).
    /// Empty string means notebox root.
    pub target_folder: String,
    /// Filename pattern with variables (e.g. "{{date:YYYYMMDDHHmmss}}").
    #[serde(default)]
    pub filename_pattern: String,
    /// What happens after creation: "create" or "create_and_open".
    pub creation_mode: String,
    /// Optional keyboard shortcut (e.g. "Ctrl+N").
    pub hotkey: Option<String>,
    /// Show this rule as a button in the toolbar.
    pub show_in_toolbar: bool,
    /// Human-readable description.
    pub description: String,
    /// Whether this is a built-in rule (cannot be deleted).
    #[serde(default)]
    pub builtin: bool,
    /// Typst template package to import and apply with a show rule, e.g.
    /// "@preview/charged-ieee:0.1.0" or a local path. Empty for none.
    #[serde(default)]
    pub typst_template: String,
    /// Disabled rules are hidden from the toolbar, palette and hotkeys but stay
    /// in Settings. Built-in rules can't be deleted, only disabled.
    #[serde(default)]
    pub disabled: bool,
}

/// The built-in rules. "New Note" has no `target_folder`, so it uses the "New
/// note location" setting when run.
pub fn default_rules() -> Vec<CreationRule> {
    vec![
        CreationRule {
            id: "new-note".to_string(),
            name: "New Note".to_string(),
            icon_emoji: "lucide:file-plus-2".to_string(),
            scaffold_path: crate::notebox_package::NEW_NOTE_SCAFFOLD_FILE.to_string(),
            target_folder: String::new(),
            filename_pattern: String::new(),
            creation_mode: "create_and_open".to_string(),
            hotkey: Some("Ctrl+N".to_string()),
            show_in_toolbar: false,
            description: "Create a new note. This rule is used by the file tree's New Note button and Ctrl+N.".to_string(),
            builtin: true,
            typst_template: String::new(),
            disabled: false,
        },
        CreationRule {
            id: "daily-note".to_string(),
            name: "Daily Note".to_string(),
            icon_emoji: "lucide:file-heart".to_string(),
            scaffold_path: crate::notebox_package::DAILY_NOTE_SCAFFOLD_FILE.to_string(),
            target_folder: "Daily/{{date:YYYY}}".to_string(),
            filename_pattern: "{{date:YYYY-MM-DD}}".to_string(),
            creation_mode: "create_and_open".to_string(),
            hotkey: Some("Ctrl+D".to_string()),
            show_in_toolbar: true,
            description: "Create or open today's daily note".to_string(),
            builtin: true,
            typst_template: String::new(),
            disabled: false,
        },
    ]
}

/// Look up a built-in rule by id. Used by the "Restore defaults" button
/// in the rule editor to reset a built-in rule to its seeded state.
pub fn default_rule_for_id(id: &str) -> Option<CreationRule> {
    default_rules().into_iter().find(|r| r.id == id)
}

// ── Persistence ──

/// Storage path for a notebox's creation rules.
fn rules_path(notebox_root: &Path) -> PathBuf {
    notebox_root.join(".inkycap").join("creation_rules.json")
}

/// Load the notebox's rules, adding any missing built-in rule (e.g. after the
/// file was deleted) and rewriting the file, so this happens once.
pub fn load_rules(notebox_root: &Path) -> Vec<CreationRule> {
    let path = rules_path(notebox_root);
    let mut user_rules: Vec<CreationRule> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let defaults = default_rules();
    let missing: Vec<CreationRule> = defaults
        .iter()
        .filter(|d| !user_rules.iter().any(|r| r.id == d.id))
        .cloned()
        .collect();

    let mutated = !missing.is_empty();
    if mutated {
        // Put the missing built-ins first as a block, in `default_rules()`
        // order (inserting one at a time at 0 would reverse them).
        let mut combined = missing;
        combined.extend(user_rules);
        user_rules = combined;
    }

    if mutated {
        if let Err(err) = save_rules(notebox_root, &user_rules) {
            log::warn!("creation_rules: failed to persist seeded rules: {err}");
        }
    }

    user_rules
}

/// Put the rules named in `ordered_ids` first, in that order; others keep their
/// relative order after them; unknown ids are ignored. The frontend sends every
/// id, so the order is fully set; the rest guards against a stale list.
pub fn reorder_rules(rules: &mut Vec<CreationRule>, ordered_ids: &[String]) {
    let mut rest: Vec<CreationRule> = std::mem::take(rules);
    let mut ordered: Vec<CreationRule> = Vec::with_capacity(rest.len());
    for id in ordered_ids {
        if let Some(pos) = rest.iter().position(|r| r.id == *id) {
            ordered.push(rest.remove(pos));
        }
    }
    ordered.append(&mut rest);
    *rules = ordered;
}

/// Save creation rules to the notebox.
pub fn save_rules(notebox_root: &Path, rules: &[CreationRule]) -> Result<()> {
    let path = rules_path(notebox_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(rules)?;
    std::fs::write(&path, json)?;
    Ok(())
}

/// The folder a rule creates notes in, falling back to `fallback_folder` (the
/// "New note location" setting, notebox-relative, "" for the root) when the
/// rule has none. Variables are expanded in both, so `daily/{{date:YYYY}}`
/// works.
pub fn resolve_target_dir(
    rule: &CreationRule,
    notebox_root: &std::path::Path,
    fallback_folder: &str,
    locale: Locale,
) -> PathBuf {
    let raw = if rule.target_folder.is_empty() {
        fallback_folder
    } else {
        rule.target_folder.as_str()
    };
    notebox_root.join(expand_folder(raw, locale))
}

/// Expand template variables (such as `{{date:YYYY}}`) in a notebox-relative
/// folder path. An empty path stays empty, meaning the notebox root.
pub fn expand_folder(raw: &str, locale: Locale) -> String {
    if raw.is_empty() {
        return String::new();
    }
    scaffolds::expand_variables(raw, "", locale).content
}

/// Clean a file name for a `.typ` file: remove path separators and leading
/// dots, so a rule can't write outside its folder or create a hidden file. None
/// if nothing is left.
pub fn sanitize_filename(name: &str) -> Option<String> {
    let stem = name.trim().trim_end_matches(".typ");
    let cleaned: String = stem
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | '\0'))
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Run a creation rule: expand the file name and folder and return the path
/// (the command layer adds the scaffold content).
///
/// `title_override` is the file name the user entered for a rule whose pattern
/// is empty. If the pattern is empty or expands to nothing and there is no
/// override, returns [`InkyCapError::FilenameRequired`] so the caller can ask.
/// `fallback_folder` is used only when the rule has no folder (see
/// [`resolve_target_dir`]).
pub fn execute_rule(
    rule: &CreationRule,
    notebox_root: &std::path::Path,
    title_override: Option<&str>,
    fallback_folder: &str,
    zid_pattern: &str,
    locale: Locale,
) -> Result<PathBuf> {
    let pattern_empty = rule.filename_pattern.trim().is_empty();
    let expanded_name = if pattern_empty {
        match title_override.and_then(sanitize_filename) {
            Some(name) => name,
            None => {
                return Err(InkyCapError::FilenameRequired);
            }
        }
    } else {
        let expanded =
            scaffolds::expand_variables_with_zid(&rule.filename_pattern, "", zid_pattern, locale);
        let candidate = expanded.content.trim().to_string();
        if candidate.is_empty() {
            // Pattern reduced to nothing (e.g. only {{zid}} with zid off).
            // Treat the same as an empty pattern — let the UI prompt.
            match title_override.and_then(sanitize_filename) {
                Some(name) => name,
                None => {
                    return Err(InkyCapError::FilenameRequired);
                }
            }
        } else {
            candidate
        }
    };

    let target_dir = resolve_target_dir(rule, notebox_root, fallback_folder, locale);
    let filename = format!("{}.typ", expanded_name);
    let file_path = target_dir.join(&filename);

    Ok(file_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_default_rules() {
        let rules = default_rules();
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].id, "new-note");
        assert_eq!(rules[1].id, "daily-note");
    }

    #[test]
    fn test_execute_new_note_rule_requires_title() {
        // The new-note rule ships with an empty filename_pattern so the UI
        // prompts the user (or supplies a ZID) — no auto-generated stem.
        let rules = default_rules();
        let err = execute_rule(
            &rules[0],
            Path::new("/notebox"),
            None,
            "",
            "YYYYMMDDHHmmss",
            Locale::en_US,
        )
        .expect_err("empty pattern with no override must signal");
        match err {
            InkyCapError::FilenameRequired => {}
            other => panic!("expected FilenameRequired, got {other:?}"),
        }

        let path = execute_rule(
            &rules[0],
            Path::new("/notebox"),
            Some("Hello"),
            "",
            "YYYYMMDDHHmmss",
            Locale::en_US,
        )
        .expect("new-note executes with override");
        let filename = path.file_name().unwrap().to_string_lossy();
        assert_eq!(filename, "Hello.typ");
    }

    #[test]
    fn test_execute_daily_note_rule() {
        let rules = default_rules();
        let path = execute_rule(
            &rules[1],
            Path::new("/notebox"),
            None,
            "",
            "YYYYMMDDHHmmss",
            Locale::en_US,
        )
        .expect("daily-note default executes");
        // The default daily-note rule targets `Daily/{{date:YYYY}}` (capital
        // D) — match the rule, not a lowercased guess.
        assert!(path.to_string_lossy().contains("Daily"));
        let filename = path.file_name().unwrap().to_string_lossy();
        assert_eq!(filename.len(), 14); // YYYY-MM-DD.typ
    }

    #[test]
    fn test_daily_note_target_uses_year_subfolder() {
        let rules = default_rules();
        let path = execute_rule(
            &rules[1],
            Path::new("/notebox"),
            None,
            "",
            "YYYYMMDDHHmmss",
            Locale::en_US,
        )
        .expect("daily-note default executes");
        let year = chrono::Local::now().format("%Y").to_string();
        // `Path::starts_with` compares components, so it works with Windows'
        // `\` separators where a string match wouldn't.
        let expected_prefix = Path::new("/notebox/Daily").join(&year);
        assert!(
            path.starts_with(&expected_prefix),
            "Expected path to start with {}, got: {}",
            expected_prefix.display(),
            path.display(),
        );
    }

    #[test]
    fn test_execute_empty_pattern_requires_title_override() {
        let mut rule = default_rules()[0].clone();
        rule.filename_pattern = String::new();
        let err = execute_rule(
            &rule,
            Path::new("/notebox"),
            None,
            "",
            "YYYYMMDDHHmmss",
            Locale::en_US,
        )
        .expect_err("empty pattern with no override must signal");
        match err {
            InkyCapError::FilenameRequired => {}
            other => panic!("expected FilenameRequired, got {other:?}"),
        }
    }

    #[test]
    fn test_execute_empty_pattern_with_override() {
        let mut rule = default_rules()[0].clone();
        rule.filename_pattern = String::new();
        let path = execute_rule(
            &rule,
            Path::new("/notebox"),
            Some("My Note"),
            "",
            "YYYYMMDDHHmmss",
            Locale::en_US,
        )
        .expect("override satisfies empty pattern");
        let filename = path.file_name().unwrap().to_string_lossy();
        assert_eq!(filename, "My Note.typ");
    }

    #[test]
    fn test_execute_falls_back_to_user_new_note_folder() {
        // Rule has no target_folder of its own → uses the fallback.
        let mut rule = default_rules()[0].clone();
        rule.target_folder = String::new();
        let path = execute_rule(
            &rule,
            Path::new("/notebox"),
            Some("note"),
            "Inbox",
            "YYYYMMDDHHmmss",
            Locale::en_US,
        )
        .expect("executes");
        // Component-wise containment, not string substring — see the
        // year-subfolder test above for why this matters on Windows.
        assert!(
            path.starts_with("/notebox/Inbox"),
            "Expected path under /notebox/Inbox, got: {}",
            path.display(),
        );
    }

    #[test]
    fn test_sanitize_filename_strips_traversal() {
        // Path separators are removed; the remainder is kept.
        assert_eq!(
            sanitize_filename("../etc/passwd").as_deref(),
            Some("etcpasswd")
        );
        // Trailing `.typ` is dropped so we don't end up with `name.typ.typ`.
        assert_eq!(sanitize_filename("My Note.typ").as_deref(), Some("My Note"));
        // Leading/trailing dots are trimmed — defends against `.hidden`
        // accidentally creating an OS-hidden file.
        assert_eq!(sanitize_filename(".hidden").as_deref(), Some("hidden"));
        // Pure separators and empty inputs are rejected entirely.
        assert_eq!(sanitize_filename(""), None);
        assert_eq!(sanitize_filename("/"), None);
        assert_eq!(sanitize_filename("..."), None);
    }

    #[test]
    fn test_load_rules_returns_defaults() {
        // Use a temp dir as the notebox root so the test doesn't read or
        // mutate the developer's real config.
        let tmp = tempfile::tempdir().expect("tempdir");
        let rules = load_rules(tmp.path());
        assert!(rules.len() >= 2);
        assert!(rules.iter().any(|r| r.id == "new-note"));
        assert!(rules.iter().any(|r| r.id == "daily-note"));
    }

    #[test]
    fn test_reorder_rules_full_list() {
        let mut rules = default_rules();
        let ids: Vec<String> = vec!["daily-note".into(), "new-note".into()];
        reorder_rules(&mut rules, &ids);
        assert_eq!(rules[0].id, "daily-note");
        assert_eq!(rules[1].id, "new-note");
    }

    #[test]
    fn test_reorder_rules_keeps_unmentioned_at_end() {
        let mut rules = default_rules();
        rules.push(CreationRule {
            id: "custom".into(),
            ..default_rules()[0].clone()
        });
        let ids: Vec<String> = vec!["custom".into()];
        reorder_rules(&mut rules, &ids);
        assert_eq!(rules[0].id, "custom");
        // The two built-ins keep their canonical relative order after it.
        assert_eq!(rules[1].id, "new-note");
        assert_eq!(rules[2].id, "daily-note");
    }

    #[test]
    fn test_reorder_rules_ignores_unknown_ids() {
        let mut rules = default_rules();
        let ids: Vec<String> = vec!["nonsense".into(), "daily-note".into()];
        reorder_rules(&mut rules, &ids);
        assert_eq!(rules[0].id, "daily-note");
        assert_eq!(rules[1].id, "new-note");
    }

    #[test]
    fn test_default_rule_for_id_lookup() {
        assert!(default_rule_for_id("new-note").is_some());
        assert!(default_rule_for_id("daily-note").is_some());
        assert!(default_rule_for_id("nonsense").is_none());
    }
}
