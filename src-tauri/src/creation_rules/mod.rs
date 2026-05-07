// Creation rules: configurable note creation presets.
// Each rule defines a scaffold, target folder, filename pattern, and optional hotkey.
// Rules are persisted at $CONFIG_DIR/inkycap/creation_rules.json.
// Two built-in rules are always present: "New Note" (Zettelkasten) and "Daily Note".

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::errors::Result;
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
    /// Path to scaffold file (relative to vault's scaffold folder).
    /// Empty string means no scaffold.
    #[serde(default)]
    pub scaffold_path: String,
    /// Target folder for new notes (relative to vault root).
    /// Empty string means vault root.
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

    // Legacy field aliases for migration from pre-scaffold naming.
    // serde(alias) lets old JSON files load without data loss.
    #[serde(alias = "template_path", default, skip_serializing)]
    _legacy_template_path: Option<String>,
    #[serde(alias = "filename_template", default, skip_serializing)]
    _legacy_filename_template: Option<String>,
}

impl CreationRule {
    /// After deserialization, migrate legacy field names to current ones.
    pub fn migrate_legacy(&mut self) {
        if self.scaffold_path.is_empty() {
            if let Some(ref legacy) = self._legacy_template_path {
                if !legacy.is_empty() {
                    self.scaffold_path = legacy.clone();
                }
            }
        }
        if self.filename_pattern.is_empty() {
            if let Some(ref legacy) = self._legacy_filename_template {
                if !legacy.is_empty() {
                    self.filename_pattern = legacy.clone();
                }
            }
        }
        self._legacy_template_path = None;
        self._legacy_filename_template = None;
    }
}

/// Default built-in rules.
pub fn default_rules() -> Vec<CreationRule> {
    vec![
        CreationRule {
            id: "new-note".to_string(),
            name: "New Note".to_string(),
            icon_emoji: "lucide:file".to_string(),
            scaffold_path: String::new(),
            target_folder: String::new(),
            filename_pattern: "{{date:YYYYMMDDHHmmss}}".to_string(),
            creation_mode: "create_and_open".to_string(),
            hotkey: Some("Ctrl+N".to_string()),
            show_in_toolbar: true,
            description: "Create a new Zettelkasten note with a timestamp ID".to_string(),
            builtin: true,
            typst_template: String::new(),
            _legacy_template_path: None,
            _legacy_filename_template: None,
        },
        CreationRule {
            id: "daily-note".to_string(),
            name: "Daily Note".to_string(),
            icon_emoji: "lucide:calendar-plus".to_string(),
            scaffold_path: String::new(),
            target_folder: "daily".to_string(),
            filename_pattern: "{{date:YYYY-MM-DD}}".to_string(),
            creation_mode: "create_and_open".to_string(),
            hotkey: Some("Ctrl+D".to_string()),
            show_in_toolbar: true,
            description: "Create or open today's daily note".to_string(),
            builtin: true,
            typst_template: String::new(),
            _legacy_template_path: None,
            _legacy_filename_template: None,
        },
    ]
}

// ── Persistence ──

fn rules_path() -> PathBuf {
    let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config_dir.join("inkycap").join("creation_rules.json")
}

/// Load creation rules from disk, merging with built-in defaults.
pub fn load_rules() -> Vec<CreationRule> {
    let path = rules_path();
    let mut user_rules: Vec<CreationRule> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // Migrate legacy field names
    for rule in &mut user_rules {
        rule.migrate_legacy();
    }

    // Ensure built-in rules are always present
    let defaults = default_rules();
    for default in &defaults {
        if !user_rules.iter().any(|r| r.id == default.id) {
            user_rules.insert(0, default.clone());
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

/// Execute a creation rule: expand filename and scaffold, create the file.
/// Returns (file_path, content, cursor_offset).
pub fn execute_rule(
    rule: &CreationRule,
    vault_root: &std::path::Path,
    _title_override: Option<&str>,
) -> (PathBuf, String, Option<usize>) {
    let expanded = scaffolds::expand_variables(&rule.filename_pattern, "");
    let expanded_name = expanded.content;

    let target_dir = if rule.target_folder.is_empty() {
        vault_root.to_path_buf()
    } else {
        vault_root.join(&rule.target_folder)
    };
    let filename = format!("{}.typ", expanded_name);
    let file_path = target_dir.join(&filename);

    let content = if rule.id == "daily-note" {
        format!("= {}\n", expanded_name)
    } else {
        String::new()
    };

    (file_path, content, None)
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
        let (path, content, cursor) = execute_rule(&rules[0], Path::new("/vault"), None);
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
        let (path, content, _cursor) = execute_rule(&rules[1], Path::new("/vault"), None);
        assert!(path.to_string_lossy().contains("daily"));
        let filename = path.file_name().unwrap().to_string_lossy();
        assert_eq!(filename.len(), 14); // YYYY-MM-DD.typ
        assert!(content.starts_with("= "));
        assert!(content.contains(filename.trim_end_matches(".typ")));
    }

    #[test]
    fn test_load_rules_returns_defaults() {
        let rules = load_rules();
        assert!(rules.len() >= 2);
        assert!(rules.iter().any(|r| r.id == "new-note"));
        assert!(rules.iter().any(|r| r.id == "daily-note"));
    }

    #[test]
    fn test_legacy_migration() {
        let json = r#"{
            "id": "old-rule",
            "name": "Old Rule",
            "icon_emoji": "",
            "template_path": "my-scaffold.typ",
            "target_folder": "",
            "filename_template": "{{date:YYYY-MM-DD}}",
            "creation_mode": "create_and_open",
            "hotkey": null,
            "show_in_toolbar": false,
            "description": "",
            "builtin": false
        }"#;
        let mut rule: CreationRule = serde_json::from_str(json).unwrap();
        rule.migrate_legacy();
        assert_eq!(rule.scaffold_path, "my-scaffold.typ");
        assert_eq!(rule.filename_pattern, "{{date:YYYY-MM-DD}}");
    }
}
