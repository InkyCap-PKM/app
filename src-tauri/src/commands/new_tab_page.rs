// ---------------------------------------------------------------------------
// Lists shown on the new tab page: recently modified notes and notes that are
// linked to but not written yet. (The page's "Today" list comes from
// `agenda::get_today_agenda_items`.) The Journal Scroll's Connections pane
// also uses the unwritten notes list, limited to the entries on screen.
//
// Both lists read only the in-memory property index; nothing touches the disk,
// so they stay cheap enough to refetch after every save while the page is
// visible.
// ---------------------------------------------------------------------------

use tauri::State;

use crate::errors::InkyCapError;
use crate::link_index::unresolved_links;
use crate::models::note::{NoteMetadata, PropertyValue};
use crate::state::AppState;
use crate::storage::to_frontend_string;

/// The longest list either command returns, whatever the caller asks for.
const MAX_LIST_LENGTH: usize = 50;

/// One note in the "Recent notes" list.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecentNote {
    pub path: String,
    pub title: String,
    /// Last modification, in seconds since the Unix epoch.
    pub modified_time: u64,
}

/// One entry in the "Unwritten notes" list: a wikilink in a note body whose
/// target names no existing note. Links in `#note(...)` properties are left
/// out, since those describe the note rather than point to writing to be done.
#[derive(Debug, Clone, serde::Serialize)]
pub struct UnwrittenNote {
    /// The note name as written in the most recently modified linking note.
    pub target: String,
    /// The most recently modified note that links to the target.
    pub source_path: String,
    pub source_title: String,
    /// When that linking note was last modified, in seconds since the Unix
    /// epoch. Unwritten notes have no file, so this stands in for their date.
    pub modified_time: u64,
    /// How many notes link to the target.
    pub source_count: usize,
}

/// The `limit` most recently modified notes, newest first.
#[tauri::command]
pub async fn get_recent_notes(
    limit: usize,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<RecentNote>, InkyCapError> {
    let session = state.session(window.label()).await;
    let index = session.property_index.read().await;
    let notes: Vec<&NoteMetadata> = index.notes.values().collect();
    Ok(recent_notes(&notes, limit.min(MAX_LIST_LENGTH)))
}

/// Unwritten notes, newest linking note first.
///
/// With `from_paths`, only links written in those notes count, and the whole
/// list comes back (it is already bounded by how many notes were given);
/// `limit` is ignored. Without it, links from every note count and the list
/// holds at most `limit` entries.
#[tauri::command]
pub async fn get_unwritten_notes(
    limit: usize,
    from_paths: Option<Vec<String>>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<Vec<UnwrittenNote>, InkyCapError> {
    let session = state.session(window.label()).await;
    let index = session.property_index.read().await;
    let notes: Vec<&NoteMetadata> = index.notes.values().collect();
    Ok(match from_paths {
        Some(from) => {
            let from: std::collections::HashSet<String> = from.into_iter().collect();
            let linkers: Vec<&NoteMetadata> = notes
                .iter()
                .copied()
                .filter(|n| from.contains(&to_frontend_string(&n.path)))
                .collect();
            unwritten_notes(&linkers, &notes, usize::MAX)
        }
        None => unwritten_notes(&notes, &notes, limit.min(MAX_LIST_LENGTH)),
    })
}

/// A note's `file.mtime` property in seconds since the Unix epoch, or 0 when
/// it is missing or unreadable (such notes sort last).
fn modified_secs(note: &NoteMetadata) -> u64 {
    match note.properties.get("file.mtime") {
        Some(PropertyValue::String(s)) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.timestamp().max(0) as u64)
            .unwrap_or(0),
        _ => 0,
    }
}

fn recent_notes(notes: &[&NoteMetadata], limit: usize) -> Vec<RecentNote> {
    let mut dated: Vec<(u64, &NoteMetadata)> =
        notes.iter().map(|n| (modified_secs(n), *n)).collect();
    // Newest first; the path breaks ties so the order is stable between calls.
    dated.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.path.cmp(&b.1.path)));
    dated
        .into_iter()
        .take(limit)
        .map(|(modified_time, note)| RecentNote {
            path: to_frontend_string(&note.path),
            title: note.display_title(),
            modified_time,
        })
        .collect()
}

/// Body links in `linkers` whose target names none of `all_notes`, grouped
/// by name, newest linking note first, at most `limit` of them.
fn unwritten_notes(
    linkers: &[&NoteMetadata],
    all_notes: &[&NoteMetadata],
    limit: usize,
) -> Vec<UnwrittenNote> {
    use std::collections::HashMap;

    let paths: Vec<std::path::PathBuf> = all_notes.iter().map(|n| n.path.clone()).collect();
    let by_path: HashMap<&std::path::PathBuf, &NoteMetadata> =
        linkers.iter().map(|n| (&n.path, *n)).collect();
    let links = unresolved_links(
        linkers.iter().map(|n| (&n.path, n.body_links.as_slice())),
        &paths,
    );

    // Group by case-insensitive name, the same way wikilinks match notes.
    // Each group remembers its newest linking note and every distinct linker.
    struct Group<'a> {
        target: &'a str,
        newest: &'a NoteMetadata,
        newest_time: u64,
        sources: Vec<&'a std::path::PathBuf>,
    }
    let mut groups: HashMap<String, Group> = HashMap::new();
    for (source_path, target) in links {
        let Some(source) = by_path.get(source_path).copied() else {
            continue;
        };
        let time = modified_secs(source);
        let group = groups.entry(target.to_lowercase()).or_insert(Group {
            target,
            newest: source,
            newest_time: time,
            sources: Vec::new(),
        });
        if !group.sources.contains(&source_path) {
            group.sources.push(source_path);
        }
        if time > group.newest_time {
            group.target = target;
            group.newest = source;
            group.newest_time = time;
        }
    }

    let mut out: Vec<UnwrittenNote> = groups
        .into_values()
        .map(|g| UnwrittenNote {
            target: g.target.to_string(),
            source_path: to_frontend_string(&g.newest.path),
            source_title: g.newest.display_title(),
            modified_time: g.newest_time,
            source_count: g.sources.len(),
        })
        .collect();
    out.sort_by(|a, b| {
        b.modified_time
            .cmp(&a.modified_time)
            .then_with(|| a.target.to_lowercase().cmp(&b.target.to_lowercase()))
    });
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    /// A note whose `links` are all written in its body.
    fn note(path: &str, mtime: &str, links: &[&str]) -> NoteMetadata {
        let mut properties = HashMap::new();
        properties.insert(
            "file.mtime".to_string(),
            PropertyValue::String(mtime.to_string()),
        );
        NoteMetadata {
            path: PathBuf::from(path),
            properties,
            links: links.iter().map(|l| (*l).to_string()).collect(),
            body_links: links.iter().map(|l| (*l).to_string()).collect(),
            tags: Vec::new(),
            agenda_markers: Vec::new(),
            unresolved_suggestions: 0,
            recurrence: None,
        }
    }

    #[test]
    fn recent_notes_are_newest_first_and_limited() {
        let old = note("/nb/Old.typ", "2026-01-01T00:00:00+00:00", &[]);
        let new = note("/nb/New.typ", "2026-03-01T00:00:00.123456789+00:00", &[]);
        let mid = note("/nb/Mid.typ", "2026-02-01T00:00:00+00:00", &[]);
        let recent = recent_notes(&[&old, &new, &mid], 2);
        let titles: Vec<&str> = recent.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["New", "Mid"]);
    }

    #[test]
    fn unwritten_notes_group_by_name_and_date_from_newest_linker() {
        let a = note("/nb/A.typ", "2026-01-01T00:00:00+00:00", &["Idea", "B"]);
        let b = note(
            "/nb/B.typ",
            "2026-02-01T00:00:00+00:00",
            &["idea::part", "Other"],
        );
        let found = unwritten_notes(&[&a, &b], &[&a, &b], 10);

        assert_eq!(found.len(), 2);
        let idea = found
            .iter()
            .find(|u| u.target.eq_ignore_ascii_case("idea"))
            .unwrap();
        assert_eq!(idea.target, "idea");
        assert_eq!(idea.source_title, "B");
        assert_eq!(idea.source_count, 2);
        // "B" exists, so it is never listed.
        assert!(found.iter().all(|u| u.target != "B"));
    }

    #[test]
    fn unwritten_notes_from_some_linkers_still_check_every_note() {
        let a = note("/nb/A.typ", "2026-01-01T00:00:00+00:00", &["B", "Idea"]);
        let b = note("/nb/B.typ", "2026-02-01T00:00:00+00:00", &["Other"]);
        // Only A's links count, but B still exists, so only "Idea" is listed.
        let found = unwritten_notes(&[&a], &[&a, &b], 10);
        let targets: Vec<&str> = found.iter().map(|u| u.target.as_str()).collect();
        assert_eq!(targets, vec!["Idea"]);
    }

    #[test]
    fn unwritten_notes_ignore_property_links() {
        let mut a = note("/nb/A.typ", "2026-01-01T00:00:00+00:00", &["In Body"]);
        a.links.push("In Property".to_string());
        let found = unwritten_notes(&[&a], &[&a], 10);
        let targets: Vec<&str> = found.iter().map(|u| u.target.as_str()).collect();
        assert_eq!(targets, vec!["In Body"]);
    }
}
