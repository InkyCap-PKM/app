// ---------------------------------------------------------------------------
// Agenda: the things to do across a notebox, from two sources:
//   1. A note's own `#note(...)` properties `task` and `due`: the note is one item.
//   2. Inline `#task(...)` / `#due(...)` calls, as `AgendaMarker`s through the
//      `<inkycap-agenda>` label.
//
// `get_agenda_items` covers the notebox (the Agenda pane);
// `get_collection_agenda` one collection view's notes. Both use
// `agenda_items_for_notes`, so the results match. Sorting, grouping and
// filtering are done in the frontend.
// ---------------------------------------------------------------------------

use chrono::{Duration, Local, NaiveDate};
use tauri::State;

use crate::collection_parser::filter::FilterContext;
use crate::collection_parser::model::parse_collection_file;
use crate::commands::collections::resolve_collection_members;
use crate::errors::InkyCapError;
use crate::models::note::{NoteMetadata, PropertyValue};
use crate::models::recurrence::Recurrence;
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
    /// Whether the item is a task (with a checkbox) rather than a dated
    /// reminder: always `false` for `source == "date"`, always `true` for
    /// `"task"`, and for `"note"` when the note has a `task` property.
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
    /// True when this row is one occurrence of a recurring reminder. The Agenda
    /// de-emphasizes later occurrences and shows a repeat affordance.
    pub recurring: bool,
    /// For a recurring series: `0` for the current or next occurrence (full
    /// emphasis), `1, 2, …` for later ones (muted). `None` otherwise.
    pub occurrence_index: Option<u32>,
    /// The repeat rule, attached to every occurrence row so the frontend can
    /// render a human summary ("Every 2 weeks"). `None` for non-recurring items.
    pub recurrence: Option<Recurrence>,
}

fn prop_str(note: &NoteMetadata, key: &str) -> Option<String> {
    note.properties
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// The note's `task` property:
///   * `None`: no `task` property; not a task.
///   * `Some(false)`: to do (unchecked).
///   * `Some(true)`: done (checked).
/// Accepts the quoted strings (`"true"` / `"false"`) older Markdown imports
/// wrote.
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

/// How far ahead recurring occurrences are listed; an Agenda isn't a full
/// calendar, so about a year.
const RECUR_HORIZON_DAYS: i64 = 366;

/// Limit on occurrences per series, against a daily unbounded rule; the real
/// bound is `until` / `count` or [`RECUR_HORIZON_DAYS`]. The full series is
/// sent and the frontend collapses it to one row unless expanded.
const MAX_OCCURRENCES_PER_SERIES: usize = 366;

fn parse_iso_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()
}

/// One agenda row's fields before recurrence is applied. Threaded into
/// [`push_dated_item`] so the recurring and non-recurring paths share a shape.
struct DatedRow<'a> {
    base_id: String,
    source: &'a str,
    is_task: bool,
    note_path: &'a str,
    note_title: &'a str,
    text: String,
    /// The anchor due date (ISO `YYYY-MM-DD`), or `None`.
    date: Option<String>,
    created: Option<String>,
    done: bool,
    tags: Vec<String>,
    zid: Option<String>,
}

/// Add a dated row, expanding a recurrence into upcoming occurrences computed
/// from `today` (the source is never changed). If the rule has no upcoming
/// occurrence (ended, or beyond the horizon), add one plain item at its date,
/// so an item never disappears.
fn push_dated_item(
    items: &mut Vec<AgendaItem>,
    row: DatedRow<'_>,
    recurrence: Option<&Recurrence>,
    today: NaiveDate,
) {
    if let (Some(rule), Some(anchor)) = (recurrence, row.date.as_deref().and_then(parse_iso_date)) {
        let horizon = today + Duration::days(RECUR_HORIZON_DAYS);
        let occ = rule.occurrences(anchor, today, horizon, MAX_OCCURRENCES_PER_SERIES);
        if !occ.is_empty() {
            for (i, date) in occ.iter().enumerate() {
                items.push(AgendaItem {
                    id: format!("{}#r{i}", row.base_id),
                    source: row.source.to_string(),
                    is_task: row.is_task,
                    note_path: row.note_path.to_string(),
                    note_title: row.note_title.to_string(),
                    text: row.text.clone(),
                    date: Some(date.format("%Y-%m-%d").to_string()),
                    created: row.created.clone(),
                    done: row.done,
                    tags: row.tags.clone(),
                    zid: row.zid.clone(),
                    recurring: true,
                    occurrence_index: Some(i as u32),
                    recurrence: Some(rule.clone()),
                });
            }
            return;
        }
    }

    items.push(AgendaItem {
        id: row.base_id,
        source: row.source.to_string(),
        is_task: row.is_task,
        note_path: row.note_path.to_string(),
        note_title: row.note_title.to_string(),
        text: row.text,
        date: row.date,
        created: row.created,
        done: row.done,
        tags: row.tags,
        zid: row.zid,
        recurring: false,
        occurrence_index: None,
        recurrence: None,
    });
}

/// Turn notes into a flat list of agenda items, expanding recurrences from
/// `today`. No locking or I/O, so both commands share it and tests can fix
/// `today`.
fn agenda_items_for_notes(notes: &[&NoteMetadata], today: NaiveDate) -> Vec<AgendaItem> {
    let mut items = Vec::new();

    for note in notes {
        let path = to_frontend_string(&note.path);
        let title = note.display_title();
        let zid = note.zid();

        // File creation date — surfaced as `file.ctime` (RFC3339) by the
        // walker. Sliced to `YYYY-MM-DD` for the Agenda's date-only axis.
        let created = note
            .properties
            .get("file.ctime")
            .and_then(|v| v.as_str())
            .filter(|s| s.len() >= 10)
            .map(|s| s[..10].to_string());

        // 1. The note itself is an item if it is a task or has a `due` date.
        //    `date` alone doesn't count, since many notes use it for when they
        //    were written. `task`'s value is the done state (true = done).
        let task_state = note_task_state(note);
        let is_task = task_state.is_some();
        let note_date = prop_str(note, "due");
        if is_task || note_date.is_some() {
            // Recurrence is reminder-only — a note that is a task ignores any
            // document-level rule.
            let recurrence = if is_task {
                None
            } else {
                note.recurrence.as_ref()
            };
            push_dated_item(
                &mut items,
                DatedRow {
                    base_id: format!("{path}#note"),
                    source: "note",
                    is_task,
                    note_path: &path,
                    note_title: &title,
                    text: title.clone(),
                    date: note_date,
                    created: created.clone(),
                    done: task_state.unwrap_or(false),
                    tags: note.tags.clone(),
                    zid: zid.clone(),
                },
                recurrence,
                today,
            );
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
            let recurrence = if marker_is_task {
                None
            } else {
                marker.recurrence.as_ref()
            };
            push_dated_item(
                &mut items,
                DatedRow {
                    base_id: format!("{path}#m{idx}"),
                    source: &marker.kind,
                    is_task: marker_is_task,
                    note_path: &path,
                    note_title: &title,
                    text,
                    date: marker.due.clone(),
                    created: created.clone(),
                    done: marker.done,
                    tags,
                    zid: zid.clone(),
                },
                recurrence,
                today,
            );
        }
    }

    items
}

/// Today in the user's local time zone — the reference point recurring
/// reminders expand against.
fn local_today() -> NaiveDate {
    Local::now().date_naive()
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
    Ok(agenda_items_for_notes(&notes, local_today()))
}

/// Agenda items dated today (local time), done or not, for the new tab page's
/// "Today". Filtered here, since recurring reminders expand a year ahead.
#[tauri::command]
pub async fn get_today_agenda_items(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<AgendaItem>, InkyCapError> {
    let session = state.session(window.label()).await;
    let index = session.property_index.read().await;
    let notes: Vec<&NoteMetadata> = index.notes.values().collect();
    let today = local_today();
    Ok(items_dated(agenda_items_for_notes(&notes, today), today))
}

/// Keep only the items whose date is `day`.
fn items_dated(items: Vec<AgendaItem>, day: NaiveDate) -> Vec<AgendaItem> {
    let iso = day.format("%Y-%m-%d").to_string();
    items
        .into_iter()
        .filter(|item| item.date.as_deref() == Some(iso.as_str()))
        .collect()
}

/// Agenda for a collection view. Membership is resolved as in the table (the
/// collection's filter plus the view's), so a note appears by matching, without
/// a `#note(collection:)` property.
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

    // Link index before property index: the documented lock order.
    let links = session.link_index.read().await;
    let index = session.property_index.read().await;
    let ctx = FilterContext::new(&collection_path_buf).with_links(&links);
    let members = resolve_collection_members(&base, view, &index, &ctx);
    Ok(agenda_items_for_notes(&members, local_today()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::note::AgendaMarker;
    use std::collections::HashMap;
    use std::path::PathBuf;

    /// Fixed "today" so recurrence expansion is deterministic in tests.
    fn today() -> NaiveDate {
        parse_iso_date("2026-06-15").unwrap()
    }

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
            body_links: Vec::new(),
            tags: tags.iter().map(|t| (*t).to_string()).collect(),
            agenda_markers: markers,
            unresolved_suggestions: 0,
            recurrence: None,
        }
    }

    #[test]
    fn document_level_task_true_is_done() {
        // `task: true` means done (the checkbox is filled).
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
        let items = agenda_items_for_notes(&[&n], today());
        assert_eq!(items.len(), 1);
        assert!(items[0].is_task);
        assert!(items[0].done);
        assert_eq!(items[0].date.as_deref(), Some("2026-06-23"));
        assert_eq!(items[0].text, "Submit paper");
        assert_eq!(items[0].tags, vec!["work".to_string()]);
    }

    #[test]
    fn items_dated_keeps_only_that_day() {
        let due_today = note(
            "/notebox/a.typ",
            &[("due", PropertyValue::String("2026-06-15".into()))],
            &[],
            Vec::new(),
        );
        let due_later = note(
            "/notebox/b.typ",
            &[("due", PropertyValue::String("2026-06-16".into()))],
            &[],
            Vec::new(),
        );
        let items = agenda_items_for_notes(&[&due_today, &due_later], today());
        let dated = items_dated(items, today());
        assert_eq!(dated.len(), 1);
        assert_eq!(dated[0].date.as_deref(), Some("2026-06-15"));
    }

    #[test]
    fn document_level_task_false_is_todo() {
        let n = note(
            "/notebox/b.typ",
            &[("task", PropertyValue::Bool(false))],
            &[],
            Vec::new(),
        );
        let items = agenda_items_for_notes(&[&n], today());
        assert_eq!(items.len(), 1);
        assert!(items[0].is_task);
        assert!(!items[0].done);
    }

    #[test]
    fn quoted_task_strings_are_treated_as_task() {
        // Older Markdown imports wrote `task: "true"` / `"false"`; those still
        // count.
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
        let items = agenda_items_for_notes(&[&done_n, &todo_n], today());
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
        // A `date` alone doesn't make an agenda item; only `due` or `task`.
        let n = note(
            "/notebox/dated.typ",
            &[("date", PropertyValue::String("2026-04-01".into()))],
            &[],
            Vec::new(),
        );
        assert!(agenda_items_for_notes(&[&n], today()).is_empty());
    }

    #[test]
    fn note_without_task_or_date_is_skipped() {
        let n = note(
            "/notebox/plain.typ",
            &[("title", PropertyValue::String("Just a note".into()))],
            &[],
            Vec::new(),
        );
        assert!(agenda_items_for_notes(&[&n], today()).is_empty());
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
                    recurrence: None,
                },
                AgendaMarker {
                    kind: "date".into(),
                    body: Some("Keynote".into()),
                    due: Some("2026-07-01".into()),
                    done: false,
                    tags: Vec::new(),
                    recurrence: None,
                },
            ],
        );
        let items = agenda_items_for_notes(&[&n], today());
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
        let items = agenda_items_for_notes(&[&n], today());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "Submit grant proposal");
        assert_eq!(items[0].note_title, "Submit grant proposal");
    }

    #[test]
    fn document_level_recurrence_expands_into_muted_occurrences() {
        // A note-level dated reminder that repeats weekly expands into the
        // current occurrence plus muted upcoming ones (capped per series).
        let mut n = note(
            "/notebox/standup.typ",
            &[
                ("title", PropertyValue::String("Team standup".into())),
                ("due", PropertyValue::String("2026-06-15".into())),
            ],
            &["work"],
            Vec::new(),
        );
        n.recurrence = Some(Recurrence {
            freq: "week".into(),
            interval: 1,
            by_day: Vec::new(),
            // Bound the series so the whole thing is emitted deterministically
            // (the cap is only a pathological-case guard now).
            until: Some("2026-07-06".into()),
            count: None,
        });
        let items = agenda_items_for_notes(&[&n], today());
        assert_eq!(items.len(), 4);
        assert!(items.iter().all(|i| i.recurring));
        assert_eq!(items[0].occurrence_index, Some(0));
        assert_eq!(items[0].date.as_deref(), Some("2026-06-15"));
        assert_eq!(items[3].occurrence_index, Some(3));
        assert_eq!(items[3].date.as_deref(), Some("2026-07-06"));
        // Ids stay unique and stable per occurrence.
        assert!(items[0].id.ends_with("#note#r0"));
    }

    #[test]
    fn recurrence_ignored_on_a_task_note() {
        // Reminder-only: a recurrence rule on a note that is also a task does
        // not expand — the task remains a single row.
        let mut n = note(
            "/notebox/chore.typ",
            &[
                ("task", PropertyValue::Bool(false)),
                ("due", PropertyValue::String("2026-06-15".into())),
            ],
            &[],
            Vec::new(),
        );
        n.recurrence = Some(Recurrence {
            freq: "week".into(),
            interval: 1,
            by_day: Vec::new(),
            until: None,
            count: None,
        });
        let items = agenda_items_for_notes(&[&n], today());
        assert_eq!(items.len(), 1);
        assert!(!items[0].recurring);
    }

    #[test]
    fn inline_due_recurrence_expands() {
        let n = note(
            "/notebox/expenses.typ",
            &[("title", PropertyValue::String("Expenses".into()))],
            &[],
            vec![AgendaMarker {
                kind: "date".into(),
                body: Some("Submit expense report".into()),
                due: Some("2026-06-01".into()),
                done: false,
                tags: Vec::new(),
                recurrence: Some(Recurrence {
                    freq: "month".into(),
                    interval: 2,
                    by_day: Vec::new(),
                    until: None,
                    count: None,
                }),
            }],
        );
        let items = agenda_items_for_notes(&[&n], today());
        // Anchor 2026-06-01 is before today (2026-06-15); first upcoming is the
        // next every-other-month occurrence.
        assert!(items.iter().all(|i| i.recurring && !i.is_task));
        assert_eq!(items[0].date.as_deref(), Some("2026-08-01"));
        assert_eq!(items[0].text, "Submit expense report");
    }
}
