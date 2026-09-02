//! Notebox-wide note exclusion rules for the Mycelial View.
//!
//! A notebox often mixes research content with notes that should never steer
//! the Mycelial statistics — workday reminders, meeting logs, templates. The
//! rules here let the user drop whole notes from every Mycelial calculation
//! (graph, latent links, emergent concepts, kindred notes, Growth signals).
//!
//! Each rule is a collection-filter expression (`file.tags.contains("x")`,
//! `status == "draft"`, …) evaluated by the same engine that resolves
//! collection membership. A note matching *any* rule is excluded. Rules live
//! in `.inkycap/mycelial-exclusions.yaml`, next to the stopword and
//! hub-exclusion lists, so they travel with the notebox and can be
//! hand-edited.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::collection_parser::filter::evaluate_filter_group;
use crate::collection_parser::model::FilterGroup;
use crate::errors::InkyCapError;
use crate::scanner::property_index::PropertyIndex;
use crate::state::{AppState, NoteboxSession};

/// On-disk shape of `.inkycap/mycelial-exclusions.yaml`. `any` holds
/// collection-filter members: expression strings written by the Filtering
/// pane, plus any nested `and`/`or`/`not` group a user hand-authors (the
/// evaluator accepts either).
#[derive(Debug, Default, Serialize, Deserialize)]
struct ExclusionsFile {
    #[serde(default)]
    any: Vec<serde_yaml::Value>,
}

/// Exclusion state for the Filtering pane: the editable rules and how many
/// notes they currently rule out.
#[derive(Debug, Clone, Serialize)]
pub struct MycelialExclusionInfo {
    /// Flat expression strings, in file order. Hand-authored nested groups
    /// are honoured during evaluation and preserved on save, but are not
    /// editable through the pane so they are not listed here.
    pub rules: Vec<String>,
    /// Notes the current rules exclude, out of `note_count` indexed notes.
    pub excluded_count: usize,
    pub note_count: usize,
}

fn exclusions_path(root: &Path) -> PathBuf {
    root.join(".inkycap").join("mycelial-exclusions.yaml")
}

/// Parse exclusions-file content into an evaluable filter group, or `None`
/// when it holds no rules or fails to parse — a broken rules file must never
/// silently exclude notes.
fn parse_exclusions(contents: &str) -> Option<FilterGroup> {
    let parsed: ExclusionsFile = serde_yaml::from_str(contents).ok()?;
    if parsed.any.is_empty() {
        return None;
    }
    Some(FilterGroup {
        and: None,
        or: Some(parsed.any),
        not: None,
    })
}

/// Read the notebox's exclusion rules as an evaluable filter group, or `None`
/// when no file exists or it holds no rules.
pub(crate) async fn load_exclusion_group(root: &Path) -> Option<FilterGroup> {
    let contents = tokio::fs::read_to_string(exclusions_path(root))
        .await
        .ok()?;
    parse_exclusions(&contents)
}

/// The set of note paths the exclusion rules match. `self_path` for the
/// evaluator's `this.file.*` references is the exclusions file itself; those
/// references have no real meaning outside a collection, but pointing them at
/// a stable file keeps their behaviour deterministic.
pub(crate) fn excluded_note_paths(
    index: &PropertyIndex,
    group: &FilterGroup,
    root: &Path,
) -> HashSet<PathBuf> {
    let self_path = exclusions_path(root);
    index
        .notes
        .iter()
        .filter(|(_, note)| evaluate_filter_group(group, note, &self_path))
        .map(|(id, _)| id.clone())
        .collect()
}

/// Build the pane-facing summary: current rules plus the count of notes they
/// exclude right now.
async fn build_info(
    session: &NoteboxSession,
    root: &Path,
) -> Result<MycelialExclusionInfo, InkyCapError> {
    let contents = tokio::fs::read_to_string(exclusions_path(root))
        .await
        .unwrap_or_default();
    let parsed: ExclusionsFile = serde_yaml::from_str(&contents).unwrap_or_default();
    let rules: Vec<String> = parsed
        .any
        .iter()
        .filter_map(|m| m.as_str().map(String::from))
        .collect();

    let index = session.property_index.read().await;
    let note_count = index.notes.len();
    let excluded_count = match load_exclusion_group(root).await {
        Some(group) => excluded_note_paths(&index, &group, root).len(),
        None => 0,
    };

    Ok(MycelialExclusionInfo {
        rules,
        excluded_count,
        note_count,
    })
}

/// Current exclusion rules and how many notes they exclude.
#[tauri::command]
pub async fn get_mycelial_exclusions(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<MycelialExclusionInfo, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let root = storage.root().to_path_buf();
    build_info(&session, &root).await
}

/// Replace the rule list with `rules` (empty strings are dropped) and return
/// the refreshed summary. Nested groups hand-authored into the file are kept
/// as-is; only the flat expression strings are replaced.
#[tauri::command]
pub async fn set_mycelial_exclusions(
    rules: Vec<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<MycelialExclusionInfo, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let root = storage.root().to_path_buf();
    let path = exclusions_path(&root);

    let existing = tokio::fs::read_to_string(&path).await.unwrap_or_default();
    let parsed: ExclusionsFile = serde_yaml::from_str(&existing).unwrap_or_default();

    let mut members: Vec<serde_yaml::Value> =
        parsed.any.into_iter().filter(|m| !m.is_string()).collect();
    members.extend(
        rules
            .into_iter()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .map(serde_yaml::Value::String),
    );

    let body = serde_yaml::to_string(&ExclusionsFile { any: members })
        .map_err(|e| InkyCapError::from(std::io::Error::other(e.to_string())))?;
    let header = "# Mycelial View — excluded notes\n\
                  #\n\
                  # A note matching ANY rule below is left out of all Mycelial\n\
                  # View calculations for this notebox. Rules use the same\n\
                  # filter expressions as collections, e.g.\n\
                  #   file.tags.contains(\"worklog\")\n\
                  #   status == \"archived\"\n\
                  #\n\
                  # Edited from the Mycelial View's Filtering pane.\n";
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&path, format!("{header}{body}")).await?;

    build_info(&session, &root).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::note::NoteMetadata;
    use std::collections::HashMap;

    fn note(path: &str, tags: Vec<&str>) -> NoteMetadata {
        NoteMetadata {
            path: PathBuf::from(path),
            properties: HashMap::new(),
            links: vec![],
            tags: tags.into_iter().map(String::from).collect(),
            agenda_markers: vec![],
            unresolved_suggestions: 0,
            recurrence: None,
        }
    }

    #[test]
    fn any_rule_match_excludes_a_note() {
        let group = parse_exclusions(
            "any:\n  - file.tags.contains(\"worklog\")\n  - file.tags.contains(\"reminder\")\n",
        )
        .expect("rules should parse");
        let index = PropertyIndex::build(vec![
            note("/nb/research.typ", vec!["chemistry"]),
            note("/nb/standup.typ", vec!["worklog"]),
            note("/nb/dentist.typ", vec!["reminder", "health"]),
        ]);
        let excluded = excluded_note_paths(&index, &group, Path::new("/nb"));
        assert_eq!(excluded.len(), 2);
        assert!(excluded.contains(&PathBuf::from("/nb/standup.typ")));
        assert!(excluded.contains(&PathBuf::from("/nb/dentist.typ")));
        assert!(!excluded.contains(&PathBuf::from("/nb/research.typ")));
    }

    #[test]
    fn empty_or_broken_files_exclude_nothing() {
        assert!(parse_exclusions("").is_none());
        assert!(parse_exclusions("any: []\n").is_none());
        assert!(parse_exclusions("any: [unclosed\n").is_none());
    }
}
