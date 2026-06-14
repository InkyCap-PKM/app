use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub type NoteId = PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PropertyValue {
    String(String),
    Number(f64),
    Bool(bool),
    List(Vec<PropertyValue>),
    Null,
}

// `f64` doesn't implement `Eq`, so this is `PartialEq` only. Tests rely
// on equality to verify round-trip invariants on the property map.
impl PartialEq for PropertyValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::String(a), Self::String(b)) => a == b,
            (Self::Number(a), Self::Number(b)) => a == b,
            (Self::Bool(a), Self::Bool(b)) => a == b,
            (Self::List(a), Self::List(b)) => a == b,
            (Self::Null, Self::Null) => true,
            _ => false,
        }
    }
}

impl PropertyValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            PropertyValue::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            PropertyValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn is_empty(&self) -> bool {
        match self {
            PropertyValue::Null => true,
            PropertyValue::String(s) => s.is_empty(),
            PropertyValue::List(l) => l.is_empty(),
            _ => false,
        }
    }

    pub fn contains(&self, needle: &str) -> bool {
        match self {
            // Case-insensitive substring, matching every other text filter in
            // InkyCap (search, the property filters). List membership below
            // stays an exact element match — it's an identity test, not a text
            // search.
            PropertyValue::String(s) => s.to_lowercase().contains(&needle.to_lowercase()),
            PropertyValue::List(items) => items.iter().any(|item| {
                if let PropertyValue::String(s) = item {
                    s == needle
                } else {
                    false
                }
            }),
            _ => false,
        }
    }
}

/// One inline agenda construct found in a note body — a `#task(...)` or
/// `#due(...)` call, surfaced via the `<inkycap-agenda>` label. Aggregated
/// by the Agenda pane alongside document-level `#note(...)` properties.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgendaMarker {
    /// `"task"` (a `#task` checkbox) or `"date"` (a `#due` reminder).
    pub kind: String,
    /// The task body, or a `#due` label. `None` when a `#due` has no label.
    pub body: Option<String>,
    /// Due date as an ISO `YYYY-MM-DD` string, or `None`.
    pub due: Option<String>,
    /// Completion state. Always `false` for `kind == "date"`.
    pub done: bool,
    /// Tags attached directly to a `#task` call (note tags are unioned in
    /// later by the aggregator).
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMetadata {
    pub path: PathBuf,
    pub properties: HashMap<String, PropertyValue>,
    /// Wikilinks found in the note body
    pub links: Vec<String>,
    pub tags: Vec<String>,
    /// Inline `#task` / `#due` markers found in the note body.
    #[serde(default)]
    pub agenda_markers: Vec<AgendaMarker>,
    /// Count of unresolved `#suggestion(...)` tracked changes in the body — the
    /// notebox-wide "still awaiting accept/reject" signal. See
    /// [`crate::typst_pipeline::query::QueryResult::suggestions`].
    #[serde(default)]
    pub unresolved_suggestions: usize,
}

impl NoteMetadata {
    /// The note's display title — its `#note(title:)` property, falling back
    /// to the file stem. Tolerates the list-shaped `title: ("...",)` that
    /// Markdown-imported notes sometimes carry (picks the first non-empty
    /// string). Shared by every surface that lists notes (Agenda, Reviews).
    pub fn display_title(&self) -> String {
        let from_prop = self.properties.get("title").and_then(|v| match v {
            PropertyValue::String(s) if !s.is_empty() => Some(s.clone()),
            PropertyValue::List(items) => items
                .iter()
                .find_map(|i| i.as_str().filter(|s| !s.is_empty()).map(|s| s.to_string())),
            _ => None,
        });
        from_prop.unwrap_or_else(|| {
            self.path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
    }

    /// The note's Zettelkasten id (`#note(zid:)`), when present and non-empty.
    /// A `zid` is user-definable and therefore may be alphanumeric, not just
    /// digits — it's returned verbatim as a string so callers sort it
    /// lexically. A numeric `zid:` literal is formatted without a fractional
    /// part. Shared by every surface that lists or sorts notes by id (Agenda,
    /// Links pane, file tree).
    pub fn zid(&self) -> Option<String> {
        match self.properties.get("zid") {
            Some(PropertyValue::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(PropertyValue::Number(n)) => Some(format!("{:.0}", n)),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub name: String,
    pub folder: String,
    pub ext: String,
    pub path: String,
    pub ctime: Option<String>,
    pub mtime: Option<String>,
    pub size: u64,
}
