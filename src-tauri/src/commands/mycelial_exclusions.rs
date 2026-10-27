//! Notebox-wide rules that leave notes out of the Mycelial View.
//!
//! A notebox often mixes research with notes that shouldn't affect the
//! statistics (reminders, meeting logs, templates). These rules drop whole
//! notes from every Mycelial calculation (graph, latent links, concepts,
//! kindred notes, Growth).
//!
//! Each rule is a collection filter expression (`file.tags.contains("x")`,
//! `status == "draft"`, …) evaluated by the collection engine; a note matching
//! any rule is excluded. Rules are in `.inkycap/mycelial-exclusions.yaml`,
//! beside the stopword and hub-exclusion lists, so they travel with the notebox
//! and can be edited by hand.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::collection_parser::filter::{evaluate_filter_group, FilterContext};
use crate::collection_parser::model::FilterGroup;
use crate::errors::InkyCapError;
use crate::link_index::LinkIndex;
use crate::scanner::property_index::PropertyIndex;
use crate::state::{AppState, NoteboxSession};

/// Format of `.inkycap/mycelial-exclusions.yaml`. `any` holds collection filter
/// members: expressions written by the Filtering pane, plus any
/// `and`/`or`/`not` groups written by hand.
#[derive(Debug, Default, Serialize, Deserialize)]
struct ExclusionsFile {
    #[serde(default)]
    any: Vec<serde_yaml::Value>,
}

/// Exclusion state for the Filtering pane: the editable rules and how many
/// notes they currently rule out.
#[derive(Debug, Clone, Serialize)]
pub struct MycelialExclusionInfo {
    /// The plain expression rules, in file order. Hand-written groups are
    /// applied and kept on save, but can't be edited in the pane, so they
    /// aren't listed.
    pub rules: Vec<String>,
    /// Notes the current rules exclude, out of `note_count` indexed notes.
    pub excluded_count: usize,
    pub note_count: usize,
}

fn exclusions_path(root: &Path) -> PathBuf {
    root.join(".inkycap").join("mycelial-exclusions.yaml")
}

/// Parse the exclusions file into a filter group, or `None` if it has no rules
/// or doesn't parse; a broken file must never exclude notes.
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

/// The note paths the rules match. `this.file.*` references point at the
/// exclusions file itself; they mean nothing outside a collection, but a fixed
/// file keeps them predictable. `links` supplies `file.links` and
/// `file.backlinks`, as in collections.
pub(crate) fn excluded_note_paths(
    index: &PropertyIndex,
    links: &LinkIndex,
    group: &FilterGroup,
    root: &Path,
) -> HashSet<PathBuf> {
    let self_path = exclusions_path(root);
    let ctx = FilterContext::new(&self_path).with_links(links);
    index
        .notes
        .iter()
        .filter(|(_, note)| evaluate_filter_group(group, note, &ctx))
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

    let group = load_exclusion_group(root).await;
    // Link index before property index: the documented lock order.
    let links = session.link_index.read().await;
    let index = session.property_index.read().await;
    let note_count = index.notes.len();
    let excluded_count = match group {
        Some(group) => excluded_note_paths(&index, &links, &group, root).len(),
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

/// Replace the rules with `rules` (empty strings dropped) and return the
/// updated summary. Hand-written groups in the file are kept; only the plain
/// expressions are replaced.
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
            body_links: Vec::new(),
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
        let excluded = excluded_note_paths(&index, &LinkIndex::new(), &group, Path::new("/nb"));
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
