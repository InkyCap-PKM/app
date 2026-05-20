// Creation rules: configurable note creation presets.
// Each rule defines a scaffold, target folder, filename pattern, and optional hotkey.
// Rules are persisted at $CONFIG_DIR/inkycap/creation_rules.json.
// Two built-in rules are always present: "New Note" (Zettelkasten) and "Daily Note".

use std::path::PathBuf;

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
    /// Typst template package to import and apply via show rule.
    /// E.g. "@preview/charged-ieee:0.1.0" or a local path.
    /// Empty string means no Typst template.
    #[serde(default)]
    pub typst_template: String,
    /// Soft-disable flag. Disabled rules are hidden from the toolbar,
    /// command palette, and global hotkey registration, but stay in the
    /// settings list so the user can re-enable them. Built-in rules can't
    /// be deleted; disabling is the equivalent escape hatch.
    #[serde(default)]
    pub disabled: bool,
}

/// Default built-in rules.
///
/// `target_folder` for "New Note" is intentionally empty — the executor
/// falls back to the user's Files & Links "New note location" setting at
/// trigger time, so this rule respects whichever folder the user picks
/// without InkyCap baking a path into the rule definition.
pub fn default_rules() -> Vec<CreationRule> {
    vec![
        CreationRule {
            id: "new-note".to_string(),
            name: "New Note".to_string(),
            icon_emoji: "lucide:file".to_string(),
            scaffold_path: crate::notebox_package::NEW_NOTE_SCAFFOLD_FILE.to_string(),
            target_folder: String::new(),
            filename_pattern: "{{date:YYYYMMDDHHmmss}}".to_string(),
            creation_mode: "create_and_open".to_string(),
            hotkey: Some("Ctrl+Shift+N".to_string()),
            show_in_toolbar: true,
            description: "Create a new Zettelkasten note with a timestamp ID".to_string(),
            builtin: true,
            typst_template: String::new(),
            disabled: false,
        },
        CreationRule {
            id: "daily-note".to_string(),
            name: "Daily Note".to_string(),
            icon_emoji: "lucide:file-heart".to_string(),
            scaffold_path: crate::notebox_package::DAILY_NOTE_SCAFFOLD_FILE.to_string(),
            target_folder: "daily/{{date:YYYY}}".to_string(),
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

/// Icons that *were* the default for a given built-in rule at some prior
/// release. When `load_rules` finds a built-in rule whose stored
/// `icon_emoji` still matches one of these, it's a strong signal the user
/// never customized the icon, so the migration rolls them forward to the
/// current default. A user who picked their own icon is left alone — their
/// value won't appear in this list.
fn legacy_default_icons(rule_id: &str) -> &'static [&'static str] {
    match rule_id {
        // Daily Note shipped with `calendar-plus`; renamed to `file-heart`
        // 2026-05-19 to free up calendar iconography for the Agenda pane.
        "daily-note" => &["lucide:calendar-plus"],
        _ => &[],
    }
}

// ── Persistence ──

fn rules_path() -> PathBuf {
    crate::app_paths::config_dir().join("creation_rules.json")
}

/// Load creation rules from disk, merging with built-in defaults.
///
/// Two safety nets run on every load:
///
/// 1. **Missing built-ins are re-inserted** — if a user deleted the rules
///    file or it predates a new built-in, the default is restored.
/// 2. **Empty `scaffold_path` on a built-in is backfilled** from the
///    current default. This is a one-shot migration for users upgrading
///    from a version that shipped before the seeded scaffolds existed —
///    their old `creation_rules.json` has `scaffold_path: ""` for the
///    built-in rules, and without this backfill the rule editor shows
///    "Scaffold file: None" indefinitely. Any non-empty value the user
///    chose is left alone.
///
/// If anything changes, the migrated rules are persisted back to disk so
/// the migration runs at most once per upgrade.
pub fn load_rules() -> Vec<CreationRule> {
    let path = rules_path();
    let mut user_rules: Vec<CreationRule> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let defaults = default_rules();
    let mut mutated = false;

    for default in &defaults {
        if !user_rules.iter().any(|r| r.id == default.id) {
            user_rules.insert(0, default.clone());
            mutated = true;
        }
    }

    for rule in user_rules.iter_mut() {
        if !rule.builtin {
            continue;
        }
        let Some(default) = defaults.iter().find(|d| d.id == rule.id) else {
            continue;
        };
        if rule.scaffold_path.is_empty() && !default.scaffold_path.is_empty() {
            rule.scaffold_path = default.scaffold_path.clone();
            mutated = true;
        }
        // Roll the icon forward when it still matches a known previous
        // default. A user-picked icon won't be in `legacy_default_icons`
        // so this is a no-op for customized rules.
        if rule.icon_emoji != default.icon_emoji
            && legacy_default_icons(&rule.id).contains(&rule.icon_emoji.as_str())
        {
            rule.icon_emoji = default.icon_emoji.clone();
            mutated = true;
        }
    }

    if mutated {
        if let Err(err) = save_rules(&user_rules) {
            log::warn!("creation_rules: failed to persist migrated rules: {err}");
        }
    }

    user_rules
}

/// Save creation rules to disk.
pub fn save_rules(rules: &[CreationRule]) -> Result<()> {
    let path = rules_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(rules)?;
    std::fs::write(&path, json)?;
    Ok(())
}

/// Resolve the on-disk target directory for a rule, applying the
/// notebox-level fallback when the rule's `target_folder` is empty.
///
/// `fallback_folder` is the user's "New note location" preference
/// expressed as a path relative to the notebox root (empty string = notebox
/// root). Variables are expanded in both the rule's folder and the
/// fallback so e.g. a fallback of `daily/{{date:YYYY}}` still works.
pub fn resolve_target_dir(
    rule: &CreationRule,
    notebox_root: &std::path::Path,
    fallback_folder: &str,
) -> PathBuf {
    let raw = if rule.target_folder.is_empty() {
        fallback_folder
    } else {
        rule.target_folder.as_str()
    };
    if raw.is_empty() {
        return notebox_root.to_path_buf();
    }
    let expanded = scaffolds::expand_variables(raw, "");
    notebox_root.join(&expanded.content)
}

/// Sanitize a user-supplied filename for use as a `.typ` basename.
/// Strips path separators and dotted prefixes so the rule trigger can't
/// be coerced into writing outside the target directory or into a hidden
/// file. Returns None if nothing is left after sanitization.
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

/// Execute a creation rule: expand filename and target folder, returning
/// the target path (no content/cursor yet — that's the scaffold's job in
/// the command layer).
///
/// `title_override` is the user-supplied filename when the rule's pattern
/// is empty (the UI prompts for one in that case). When the pattern is
/// empty AND no override is provided, returns
/// [`InkyCapError::BadRequest`] — the caller is expected to prompt the
/// user and retry.
///
/// `fallback_folder` is consulted only when the rule's own
/// `target_folder` is empty. See [`resolve_target_dir`].
pub fn execute_rule(
    rule: &CreationRule,
    notebox_root: &std::path::Path,
    title_override: Option<&str>,
    fallback_folder: &str,
    zid_pattern: &str,
) -> Result<(PathBuf, String, Option<usize>)> {
    let pattern_empty = rule.filename_pattern.trim().is_empty();
    let expanded_name = if pattern_empty {
        match title_override.and_then(sanitize_filename) {
            Some(name) => name,
            None => {
                return Err(InkyCapError::BadRequest(
                    "filename-required".to_string(),
                ));
            }
        }
    } else {
        let expanded =
            scaffolds::expand_variables_with_zid(&rule.filename_pattern, "", zid_pattern);
        let candidate = expanded.content.trim().to_string();
        if candidate.is_empty() {
            // Pattern reduced to nothing (e.g. only {{zid}} with zid off).
            // Treat the same as an empty pattern — let the UI prompt.
            match title_override.and_then(sanitize_filename) {
                Some(name) => name,
                None => {
                    return Err(InkyCapError::BadRequest(
                        "filename-required".to_string(),
                    ));
                }
            }
        } else {
            candidate
        }
    };

    let target_dir = resolve_target_dir(rule, notebox_root, fallback_folder);
    let filename = format!("{}.typ", expanded_name);
    let file_path = target_dir.join(&filename);

    Ok((file_path, String::new(), None))
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
    fn test_execute_new_note_rule() {
        let rules = default_rules();
        let (path, content, cursor) =
            execute_rule(&rules[0], Path::new("/notebox"), None, "", "YYYYMMDDHHmmss")
                .expect("new-note default executes");
        let filename = path.file_name().unwrap().to_string_lossy();
        assert!(filename.ends_with(".typ"));
        let stem = filename.trim_end_matches(".typ");
        assert_eq!(stem.len(), 14);
        assert!(stem.chars().all(|c| c.is_ascii_digit()));
        assert!(content.is_empty());
        assert!(cursor.is_none());
    }

    #[test]
    fn test_execute_daily_note_rule() {
        let rules = default_rules();
        let (path, _content, _cursor) =
            execute_rule(&rules[1], Path::new("/notebox"), None, "", "YYYYMMDDHHmmss")
                .expect("daily-note default executes");
        assert!(path.to_string_lossy().contains("daily"));
        let filename = path.file_name().unwrap().to_string_lossy();
        assert_eq!(filename.len(), 14); // YYYY-MM-DD.typ
    }

    #[test]
    fn test_daily_note_target_uses_year_subfolder() {
        let rules = default_rules();
        let (path, _, _) =
            execute_rule(&rules[1], Path::new("/notebox"), None, "", "YYYYMMDDHHmmss")
                .expect("daily-note default executes");
        let year = chrono::Local::now().format("%Y").to_string();
        let path_str = path.to_string_lossy();
        assert!(
            path_str.contains(&format!("daily/{}/", year)),
            "Expected daily/{}/ in path, got: {}",
            year,
            path_str
        );
    }

    #[test]
    fn test_execute_empty_pattern_requires_title_override() {
        let mut rule = default_rules()[0].clone();
        rule.filename_pattern = String::new();
        let err = execute_rule(&rule, Path::new("/notebox"), None, "", "YYYYMMDDHHmmss")
            .expect_err("empty pattern with no override must signal");
        match err {
            InkyCapError::BadRequest(msg) => assert_eq!(msg, "filename-required"),
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    #[test]
    fn test_execute_empty_pattern_with_override() {
        let mut rule = default_rules()[0].clone();
        rule.filename_pattern = String::new();
        let (path, _, _) = execute_rule(
            &rule,
            Path::new("/notebox"),
            Some("My Note"),
            "",
            "YYYYMMDDHHmmss",
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
        let (path, _, _) = execute_rule(
            &rule,
            Path::new("/notebox"),
            None,
            "Inbox",
            "YYYYMMDDHHmmss",
        )
        .expect("executes");
        assert!(path.to_string_lossy().contains("/notebox/Inbox/"));
    }

    #[test]
    fn test_sanitize_filename_strips_traversal() {
        // Path separators are removed; the remainder is kept.
        assert_eq!(sanitize_filename("../etc/passwd").as_deref(), Some("etcpasswd"));
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
        let rules = load_rules();
        assert!(rules.len() >= 2);
        assert!(rules.iter().any(|r| r.id == "new-note"));
        assert!(rules.iter().any(|r| r.id == "daily-note"));
    }

    #[test]
    fn test_default_rule_for_id_lookup() {
        assert!(default_rule_for_id("new-note").is_some());
        assert!(default_rule_for_id("daily-note").is_some());
        assert!(default_rule_for_id("nonsense").is_none());
    }

    #[test]
    fn test_backfill_empty_scaffold_path_on_builtins() {
        // Direct unit-level test of the migration shape: take a rule list
        // that mimics the legacy on-disk format (empty scaffold_path on
        // built-ins), run the same backfill the loader does, and verify
        // the scaffold_path was filled from the current defaults.
        let defaults = default_rules();
        let mut rules = vec![
            CreationRule {
                scaffold_path: String::new(),
                ..defaults[0].clone()
            },
            CreationRule {
                scaffold_path: String::new(),
                ..defaults[1].clone()
            },
            // A user rule with an intentionally-empty scaffold_path must
            // be left alone — only built-ins are backfilled.
            CreationRule {
                id: "user-rule".to_string(),
                builtin: false,
                scaffold_path: String::new(),
                ..defaults[0].clone()
            },
        ];

        for rule in rules.iter_mut() {
            if !rule.builtin {
                continue;
            }
            if let Some(default) = defaults.iter().find(|d| d.id == rule.id) {
                if rule.scaffold_path.is_empty() && !default.scaffold_path.is_empty() {
                    rule.scaffold_path = default.scaffold_path.clone();
                }
            }
        }

        assert_eq!(rules[0].scaffold_path, defaults[0].scaffold_path);
        assert_eq!(rules[1].scaffold_path, defaults[1].scaffold_path);
        assert_eq!(rules[2].scaffold_path, ""); // user rule untouched
    }

    #[test]
    fn test_backfill_preserves_user_chosen_scaffold() {
        // If the user has explicitly chosen a custom scaffold for a
        // built-in rule, the backfill must not clobber it.
        let defaults = default_rules();
        let mut rule = defaults[0].clone();
        rule.scaffold_path = "my-custom.typ".to_string();

        if rule.builtin {
            if let Some(default) = defaults.iter().find(|d| d.id == rule.id) {
                if rule.scaffold_path.is_empty() && !default.scaffold_path.is_empty() {
                    rule.scaffold_path = default.scaffold_path.clone();
                }
            }
        }

        assert_eq!(rule.scaffold_path, "my-custom.typ");
    }
}
