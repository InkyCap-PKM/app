// ---------------------------------------------------------------------------
// Agenda — aggregates "things to do" across a notebox.
//
// Two sources feed an agenda item:
//   1. Document-level — a note's own `#note(...)` properties: `task`,
//      `due`. The note itself becomes one item.
//   2. Inline — `#task(...)` / `#due(...)` calls in a note body, surfaced
//      as `AgendaMarker`s via the `<inkycap-agenda>` label.
//
// `get_agenda_items` runs over the whole notebox (the sidebar Agenda pane);
// `get_collection_agenda` runs over a single collection view's member notes
// (the Collection Agenda view). Both share `agenda_items_for_notes` so the
// two surfaces produce identically-shaped results.
//
// Sorting and grouping are deliberately left to the frontend — the default
// presentation is a flat list sorted by date, but the pane offers opt-in
// grouping and filtering that operate on the same flat payload.
// ---------------------------------------------------------------------------

use tauri::State;

use crate::collection_parser::model::parse_collection_file;
use crate::commands::collections::resolve_collection_members;
use crate::errors::InkyCapError;
use crate::models::note::{NoteMetadata, PropertyValue};
use crate::state::AppState;
use crate::storage::sanitize_notebox_arg;
use crate::storage::to_frontend_string;
use crate::storage::traits::NoteboxStorage;

/// One row in the Agenda pane.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AgendaItem {
    /// Stable per-item id (`<note-path>#note` or `<note-path>#m<idx>`).
    pub id: String,
    /// `"note"` (document-level), `"task"` or `"date"` (inline marker).
    pub source: String,
    /// Whether this item represents a task (has a checkbox / done state) or
    /// a pure dated reminder. `source == "date"` is always `false`;
    /// `source == "task"` is always `true`; `source == "note"` is `true`
    /// when the host note has `task: true`.
    pub is_task: bool,
    /// Notebox path of the note this item lives in.
    pub note_path: String,
    /// Display title of the host note.
    pub note_title: String,
    /// The text shown for this item — the marker body, or the note title
    /// for a document-level item.
    pub text: String,
    /// Due date as an ISO `YYYY-MM-DD` string, when known.
    pub date: Option<String>,
    /// File creation date (ISO `YYYY-MM-DD`), when the filesystem knows it.
    pub created: Option<String>,
    /// Completion state. `#task` markers carry their own; document-level
    /// items use the `task` property's boolean value.
    pub done: bool,
    /// Tags — the host note's tags, unioned with any `#task`-local tags.
    pub tags: Vec<String>,
    /// The host note's `zid`, when present.
    pub zid: Option<String>,
}

fn note_zid(note: &NoteMetadata) -> Option<String> {
    match note.properties.get("zid") {
        Some(PropertyValue::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(PropertyValue::Number(n)) => Some(format!("{:.0}", n)),
        _ => None,
    }
}

fn prop_str(note: &NoteMetadata, key: &str) -> Option<String> {
    note.properties
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// The note's `task` property as a tri-state:
///   * `None`         — no `task` property; the note is not a task.
///   * `Some(false)`  — task is open / to do (checkbox unchecked).
///   * `Some(true)`   — task is done (checkbox checked).
///
/// Tolerant of the quoted string form (`task: "true"` / `"false"`) that
/// legacy Markdown-imported notes carry.
fn note_task_state(note: &NoteMetadata) -> Option<bool> {
    match note.properties.get("task") {
        Some(PropertyValue::Bool(b)) => Some(*b),
        Some(PropertyValue::String(s)) => {
            if s.eq_ignore_ascii_case("true") {
                Some(true)
            } else if s.eq_ignore_ascii_case("false") {
                Some(false)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// The shared aggregation core: turn a set of notes into a flat list of
/// agenda items. Pure — no locking, no I/O — so both commands can reuse it.
fn agenda_items_for_notes(notes: &[&NoteMetadata]) -> Vec<AgendaItem> {
    let mut items = Vec::new();

    for note in notes {
        let path = to_frontend_string(&note.path);
        let title = note.display_title();
        let zid = note_zid(note);

        // File creation date — surfaced as `file.ctime` (RFC3339) by the
        // walker. Sliced to `YYYY-MM-DD` for the Agenda's date-only axis.
        let created = note
            .properties
            .get("file.ctime")
            .and_then(|v| v.as_str())
            .filter(|s| s.len() >= 10)
            .map(|s| s[..10].to_string());

        // 1. Document-level item: the note is itself a task or carries a
        //    `due` date. The generic `date` property is *not* a qualifier —
        //    many notes use it as a creation/authoring date and would
        //    otherwise flood the agenda. A `task` property's value is the
        //    canonical done-state (true = done, false = to do).
        let task_state = note_task_state(note);
        let is_task = task_state.is_some();
        let note_date = prop_str(note, "due");
        if is_task || note_date.is_some() {
            items.push(AgendaItem {
                id: format!("{path}#note"),
                source: "note".to_string(),
                is_task,
                note_path: path.clone(),
                note_title: title.clone(),
                text: title.clone(),
                date: note_date,
                created: created.clone(),
                done: task_state.unwrap_or(false),
                tags: note.tags.clone(),
                zid: zid.clone(),
            });
        }

        // 2. Inline markers — one item per #task / #due call.
        for (idx, marker) in note.agenda_markers.iter().enumerate() {
            let mut tags: Vec<String> = note.tags.clone();
            for t in &marker.tags {
                if !tags.contains(t) {
                    tags.push(t.clone());
                }
            }
            let text = marker
                .body
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| title.clone());
            let marker_is_task = marker.kind == "task";
            items.push(AgendaItem {
                id: format!("{path}#m{idx}"),
                source: marker.kind.clone(),
                is_task: marker_is_task,
                note_path: path.clone(),
                note_title: title.clone(),
                text,
                date: marker.due.clone(),
                created: created.clone(),
                done: marker.done,
                tags,
                zid: zid.clone(),
            });
        }
    }

    items
}

/// Notebox-wide agenda — feeds the left-sidebar Agenda pane.
#[tauri::command]
pub async fn get_agenda_items(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<AgendaItem>, InkyCapError> {
    let session = state.session(window.label()).await;
    let index = session.property_index.read().await;
    let notes: Vec<&NoteMetadata> = index.notes.values().collect();
    Ok(agenda_items_for_notes(&notes))
}

/// Collection-scoped agenda — feeds the Collection "Agenda" view. Membership
/// is resolved exactly the way the table view resolves it (the collection's
/// global filter plus the view's own filter), so a note appears here because
/// it matches the collection's filter — no explicit `#note(collection:)`
/// property is required.
#[tauri::command]
pub async fn get_collection_agenda(
    collection_path: String,
    view_name: String,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<AgendaItem>, InkyCapError> {
    let session = state.session(window.label()).await;
    let storage = session.get_storage().await?;
    let collection_path_buf = sanitize_notebox_arg(&collection_path)?;
    let content = storage.read_file(&collection_path_buf).await?;
    let base = parse_collection_file(&content)?;

    let view = if view_name.is_empty() {
        base.views.first()
    } else {
        base.views.iter().find(|v| v.name == view_name)
    }
    .ok_or_else(|| InkyCapError::InvalidPath(format!("View '{}' not found", view_name)))?;

    let index = session.property_index.read().await;
    let members = resolve_collection_members(&base, view, &index, &collection_path_buf);
    Ok(agenda_items_for_notes(&members))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::note::AgendaMarker;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn note(
        path: &str,
        props: &[(&str, PropertyValue)],
        tags: &[&str],
        markers: Vec<AgendaMarker>,
    ) -> NoteMetadata {
        let mut properties = HashMap::new();
        for (k, v) in props {
            properties.insert((*k).to_string(), v.clone());
        }
        NoteMetadata {
            path: PathBuf::from(path),
            properties,
            links: Vec::new(),
            tags: tags.iter().map(|t| (*t).to_string()).collect(),
            agenda_markers: markers,
            unresolved_suggestions: 0,
        }
    }

    #[test]
    fn document_level_task_true_is_done() {
        // `task: true` is the canonical "done" signal — the checkbox in
        // the property panel reads as filled, which the user expects to
        // mean "completed".
        let n = note(
            "/notebox/a.typ",
            &[
                ("title", PropertyValue::String("Submit paper".into())),
                ("task", PropertyValue::Bool(true)),
                ("due", PropertyValue::String("2026-06-23".into())),
            ],
            &["work"],
            Vec::new(),
        );
        let items = agenda_items_for_notes(&[&n]);
        assert_eq!(items.len(), 1);
        assert!(items[0].is_task);
        assert!(items[0].done);
        assert_eq!(items[0].date.as_deref(), Some("2026-06-23"));
        assert_eq!(items[0].text, "Submit paper");
        assert_eq!(items[0].tags, vec!["work".to_string()]);
    }

    #[test]
    fn document_level_task_false_is_todo() {
        let n = note(
            "/notebox/b.typ",
            &[("task", PropertyValue::Bool(false))],
            &[],
            Vec::new(),
        );
        let items = agenda_items_for_notes(&[&n]);
        assert_eq!(items.len(), 1);
        assert!(items[0].is_task);
        assert!(!items[0].done);
    }

    #[test]
    fn quoted_task_strings_are_treated_as_task() {
        // Legacy MD-import path wrote `task: "true"` / `"false"` instead of
        // real booleans; the aggregator must still surface those notes and
        // honour the quoted value as the done state.
        let done_n = note(
            "/notebox/quoted-done.typ",
            &[("task", PropertyValue::String("true".into()))],
            &[],
            Vec::new(),
        );
        let todo_n = note(
            "/notebox/quoted-todo.typ",
            &[("task", PropertyValue::String("false".into()))],
            &[],
            Vec::new(),
        );
        let items = agenda_items_for_notes(&[&done_n, &todo_n]);
        assert_eq!(items.len(), 2);
        let done_item = items
            .iter()
            .find(|i| i.note_path.ends_with("quoted-done.typ"))
            .unwrap();
        let todo_item = items
            .iter()
            .find(|i| i.note_path.ends_with("quoted-todo.typ"))
            .unwrap();
        assert!(done_item.done);
        assert!(!todo_item.done);
    }

    #[test]
    fn note_with_only_date_property_is_skipped() {
        // A `date` property alone — typically the note's authoring date —
        // does NOT make a note an agenda item. Only `due` or `task`
        // qualifies.
        let n = note(
            "/notebox/dated.typ",
            &[("date", PropertyValue::String("2026-04-01".into()))],
            &[],
            Vec::new(),
        );
        assert!(agenda_items_for_notes(&[&n]).is_empty());
    }

    #[test]
    fn note_without_task_or_date_is_skipped() {
        let n = note(
            "/notebox/plain.typ",
            &[("title", PropertyValue::String("Just a note".into()))],
            &[],
            Vec::new(),
        );
        assert!(agenda_items_for_notes(&[&n]).is_empty());
    }

    #[test]
    fn inline_markers_become_items_with_unioned_tags() {
        let n = note(
            "/notebox/b.typ",
            &[("title", PropertyValue::String("Conference".into()))],
            &["research"],
            vec![
                AgendaMarker {
                    kind: "task".into(),
                    body: Some("Draft abstract".into()),
                    due: Some("2026-05-01".into()),
                    done: false,
                    tags: vec!["urgent".into()],
                },
                AgendaMarker {
                    kind: "date".into(),
                    body: Some("Keynote".into()),
                    due: Some("2026-07-01".into()),
                    done: false,
                    tags: Vec::new(),
                },
            ],
        );
        let items = agenda_items_for_notes(&[&n]);
        assert_eq!(items.len(), 2);
        let task = items.iter().find(|i| i.source == "task").unwrap();
        assert_eq!(task.text, "Draft abstract");
        assert!(task.tags.contains(&"research".to_string()));
        assert!(task.tags.contains(&"urgent".to_string()));
        let date = items.iter().find(|i| i.source == "date").unwrap();
        assert_eq!(date.text, "Keynote");
        assert_eq!(date.date.as_deref(), Some("2026-07-01"));
    }

    #[test]
    fn note_title_falls_back_to_file_stem() {
        // The Agenda displays the host note's title; for a task or due
        // item that doesn't set `title`, the file stem stands in.
        let n = note(
            "/notebox/Submit grant proposal.typ",
            &[("task", PropertyValue::Bool(false))],
            &[],
            Vec::new(),
        );
        let items = agenda_items_for_notes(&[&n]);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Submit grant proposal");
        assert_eq!(items[0].note_title, "Submit grant proposal");
    }
}
