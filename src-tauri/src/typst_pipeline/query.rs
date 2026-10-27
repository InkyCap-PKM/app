//! Metadata extraction through Typst's introspector: after compiling, query the
//! InkyCap labels (`<inkycap-note>`, `<inkycap-tag>`, `<inkycap-link>`,
//! `<inkycap-agenda>`) and convert their `metadata(...)` values for the scanner
//! and indexes.

use std::collections::HashMap;
use std::path::Path;

use typst::foundations::{Content, Dict, Label, Selector, Value};
use typst::introspection::{Introspector, MetadataElem};
use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};
use typst::utils::PicoStr;
use typst_layout::PagedDocument;

use crate::models::note::{AgendaMarker, PropertyValue};
use crate::models::recurrence::Recurrence;
use crate::typst_pipeline::compiler::TypstCompiler;

/// Extracted metadata from a single `.typ` file.
#[derive(Debug, Clone, Default)]
pub struct QueryResult {
    /// Properties from `#note(...)`. Does NOT include `file.*` properties.
    pub properties: HashMap<String, PropertyValue>,
    /// Tag names from both `#tag(...)` calls and `note(tags: ...)`.
    pub tags: Vec<String>,
    /// Raw wikilink target strings from `#wikilink(...)` and `link-ref(...)`.
    pub links: Vec<String>,
    /// The subset of `links` written in the note body with `#wikilink(...)`,
    /// leaving out `link-ref(...)` values inside `#note(...)` properties.
    pub body_links: Vec<String>,
    /// Heading labels referenced by wikilinks with `label:` parameter.
    pub heading_labels: Vec<String>,
    /// Inline `#task` / `#due` markers from `<inkycap-agenda>`.
    pub agenda: Vec<AgendaMarker>,
    /// The rule from `#note(recurrence: (…))`, kept out of `properties` so it
    /// never appears as a stringified dict.
    pub recurrence: Option<Recurrence>,
    /// Number of unresolved `#suggestion(...)` changes
    /// (`<inkycap-suggestion>`). Accepting or rejecting removes the call, so
    /// this counts only those awaiting a decision. Used for the "changes to
    /// resolve" indicator. `#annotation` comments aren't counted, since they
    /// need no decision.
    pub suggestions: usize,
}

/// An element's approximate reading-order position, `(page, top, left)`, for
/// comparing markers with the transclusion boundary.
type PosKey = (usize, f64, f64);

/// Query a compiled document for all InkyCap metadata.
pub fn query_document(document: &PagedDocument) -> QueryResult {
    // `introspector()` returns `&Arc<PagedIntrospector>`; `.as_ref()` gives the
    // `&dyn Introspector` the helpers take.
    let introspector = document.introspector().as_ref();
    let mut result = QueryResult::default();

    // Transclusion guard. An `#include`d note compiles inline, so its labels
    // appear in this document too. The host's `#note(...)` always comes first;
    // a second `<inkycap-note>` marks where included content starts. Only the
    // first note's properties are read, and body labels at or after that point
    // are dropped, so a host never takes on an included note's identity, tags
    // or links.
    //
    // Host content written after an `#include` can't be told apart from the
    // included note, so `#include` works best as a trailing block.
    let boundary = transclusion_boundary(introspector);

    extract_note_metadata(introspector, &mut result);
    extract_tags(introspector, &mut result, boundary);
    extract_links(introspector, &mut result, boundary);
    extract_agenda_markers(introspector, &mut result, boundary);
    extract_review_markup(introspector, &mut result, boundary);

    result
}

/// Reading-order position of a located element, or `None` if it has no
/// location (an unplaced/detached element).
fn pos_key(introspector: &dyn Introspector, elem: &Content) -> Option<PosKey> {
    let loc = elem.location()?;
    // `position` may be `None`; only paged documents are queried, so use the
    // paged position.
    let pos = introspector.position(loc)?.as_paged_or_default();
    Some((pos.page.get(), pos.point.y.to_raw(), pos.point.x.to_raw()))
}

/// Position of the second `<inkycap-note>`, where `#include`d content starts.
/// `None` with at most one note.
fn transclusion_boundary(introspector: &dyn Introspector) -> Option<PosKey> {
    let selector = label_selector("inkycap-note")?;
    let notes = introspector.query(&selector);
    if notes.len() < 2 {
        return None;
    }
    pos_key(introspector, &notes[1])
}

/// Whether a marker at `key` is in transcluded content (at or after
/// `boundary`). False if either is unknown.
fn is_transcluded(key: Option<PosKey>, boundary: Option<PosKey>) -> bool {
    matches!((key, boundary), (Some(k), Some(b)) if k >= b)
}

/// Logs the compile-and-query time on drop, so every return path is covered.
/// `debug` level, file name only.
struct QueryTimer {
    file: String,
    start: std::time::Instant,
}

impl QueryTimer {
    fn start(path: &Path) -> Self {
        Self {
            file: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("?")
                .to_string(),
            start: std::time::Instant::now(),
        }
    }
}

impl Drop for QueryTimer {
    fn drop(&mut self) {
        log::debug!(
            "typst compile_and_query [{}] took {:?}",
            self.file,
            self.start.elapsed()
        );
    }
}

/// Styles prepended for the metadata compile. Highlighting a code block makes
/// Typst load and keep that language's grammar (tens of MB each), and indexing
/// compiles every note. With no theme, Typst skips highlighting (`raw(theme:
/// none)`); the metadata is the same, and the index records no positions inside
/// the note, so the extra line shifts nothing.
const METADATA_COMPILE_STYLES: &str = "#set raw(theme: none)\n";

/// Compile a file and extract its metadata. Returns [`QueryResult::default()`]
/// if it can't compile; the scanner's [`MetadataCache`] keeps the last good
/// result by `(mtime, size)` for broken files.
///
/// [`MetadataCache`]: crate::cache::MetadataCache
pub fn compile_and_query(
    compiler: &mut TypstCompiler,
    abs_path: &Path,
    source: String,
) -> QueryResult {
    let _t = QueryTimer::start(abs_path);
    let styled_source = format!("{METADATA_COMPILE_STYLES}{source}");
    // Compile with recovery first: a localized error (a stray token, a broken
    // `#include`) is dropped and the rest recompiled, so inline `#task` /
    // `#due` markers, wikilinks and tags still come through. The preamble-only
    // fallback below would keep `#note(...)` properties but lose them.
    if let Some(document) = compiler.compile_document_recovering(abs_path, styled_source) {
        return query_document(&document);
    }
    // Recovery failed. Compile only the import and `#note(...)` so properties
    // still reach the panel, then take what body metadata we can from the
    // syntax tree.
    let mut result = QueryResult::default();
    let preamble = extract_note_preamble(&source);
    if preamble.len() < source.len() {
        if let Some(document) = compiler.compile_document(abs_path, preamble) {
            result = query_document(&document);
        }
    }
    // The preamble compile loses wikilinks and body tags, so a note with one
    // body error would show no links. Per CLAUDE.md's Typst-first principle,
    // read the `wikilink(...)` / `tag(...)` calls from the `typst::syntax`
    // tree, which needs no evaluation.
    let (ast_links, ast_tags, ast_agenda) = extract_body_metadata_via_syntax(&source);
    // Every link found this way is a `wikilink(...)` call, so a body link.
    for link in ast_links {
        if !result.links.contains(&link) {
            result.links.push(link.clone());
            result.body_links.push(link);
        }
    }
    for tag in ast_tags {
        if !result.tags.contains(&tag) {
            result.tags.push(tag);
        }
    }
    // Only `#task` bodies can be read from the tree; a `#due` date is usually a
    // `datetime(...)` call that needs evaluation. The cache holds the full
    // result from the last good compile.
    result.agenda = ast_agenda;
    result
}

/// Wikilink targets, tag names and tasks from the syntax tree, for files that
/// don't compile. Only the package's `wikilink(...)`, `tag(...)` and task call
/// shapes; anything else would need evaluation.
fn extract_body_metadata_via_syntax(source: &str) -> (Vec<String>, Vec<String>, Vec<AgendaMarker>) {
    let root = parse(source);
    let node = LinkedNode::new(&root);
    let mut links = Vec::new();
    let mut tags = Vec::new();
    let mut agenda = Vec::new();
    walk_for_body_calls(&node, &mut links, &mut tags, &mut agenda);
    (links, tags, agenda)
}

fn walk_for_body_calls(
    node: &LinkedNode<'_>,
    links: &mut Vec<String>,
    tags: &mut Vec<String>,
    agenda: &mut Vec<AgendaMarker>,
) {
    if node.kind() == SyntaxKind::FuncCall {
        if let Some(call) = node.cast::<ast::FuncCall>() {
            if let ast::Expr::Ident(ident) = call.callee() {
                match ident.as_str() {
                    "wikilink" => {
                        if let Some(s) = first_string_positional_arg(node) {
                            links.push(s);
                        }
                    }
                    "tag" => {
                        if let Some(s) = first_string_positional_arg(node) {
                            tags.push(s);
                        }
                    }
                    "task" => {
                        if let Some(s) = first_string_positional_arg(node) {
                            agenda.push(AgendaMarker {
                                kind: "task".to_string(),
                                body: Some(s),
                                due: None,
                                done: false,
                                tags: Vec::new(),
                                recurrence: None,
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    for child in node.children() {
        walk_for_body_calls(&child, links, tags, agenda);
    }
}

/// The first positional argument if it is a string literal, else `None`. Like
/// `path_rebase::rebase_first_string_arg`.
pub(crate) fn first_string_positional_arg(call_node: &LinkedNode<'_>) -> Option<String> {
    let args_node = call_node
        .children()
        .find(|c| c.kind() == SyntaxKind::Args)?;
    for child in args_node.children() {
        match child.kind() {
            SyntaxKind::LeftParen
            | SyntaxKind::RightParen
            | SyntaxKind::Comma
            | SyntaxKind::Space
            | SyntaxKind::Parbreak
            | SyntaxKind::LineComment
            | SyntaxKind::BlockComment => continue,

            SyntaxKind::Str => {
                let str_ast = child.cast::<ast::Str>()?;
                let value = str_ast.get();
                let s: &str = &value;
                if s.is_empty() {
                    return None;
                }
                return Some(s.to_string());
            }

            // Anything else in the first positional slot can't be read
            // statically.
            _ => return None,
        }
    }
    None
}

/// Just the import and `#note(...)` call, as a source of its own. The
/// counterpart of [`crate::notebox_package::strip_note_preamble`].
fn extract_note_preamble(content: &str) -> String {
    let body_start = content.len() - crate::notebox_package::strip_note_preamble(content).len();
    content[..body_start].to_string()
}

// ---------------------------------------------------------------------------
// Label selectors
// ---------------------------------------------------------------------------

fn label_selector(name: &str) -> Option<Selector> {
    let pico = PicoStr::intern(name);
    Label::new(pico).map(Selector::Label)
}

// ---------------------------------------------------------------------------
// <inkycap-note> — document-level metadata dict
// ---------------------------------------------------------------------------

fn extract_note_metadata(introspector: &dyn Introspector, result: &mut QueryResult) {
    let Some(selector) = label_selector("inkycap-note") else {
        return;
    };
    let elements = introspector.query(&selector);

    // Only the first `<inkycap-note>` is the host's own document metadata;
    // any later ones come from `#include`d notes (see `query_document`).
    for elem in elements.iter().take(1) {
        let Some(meta) = elem.to_packed::<MetadataElem>() else {
            continue;
        };
        let Value::Dict(dict) = &meta.value else {
            continue;
        };

        for (key, value) in dict.iter() {
            let key_str = key.as_str().to_string();

            if key_str == "recurrence" {
                // Parsed into its own field, not `properties`, so it doesn't
                // show as a raw dict in the panel or as a collection column.
                if let Value::Dict(rec) = value {
                    result.recurrence = Recurrence::from_typst_dict(rec);
                }
                continue;
            }

            if key_str == "tags" {
                if let Value::Array(arr) = value {
                    for item in arr.iter() {
                        if let Value::Str(s) = item {
                            let tag = s.as_str().to_string();
                            if !result.tags.contains(&tag) {
                                result.tags.push(tag);
                            }
                        }
                    }
                }
                // Also store in properties so the sidebar panel can display/edit them
                result
                    .properties
                    .insert(key_str, typst_value_to_property(value));
            } else {
                result
                    .properties
                    .insert(key_str, typst_value_to_property(value));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// <inkycap-tag> — inline tags
// ---------------------------------------------------------------------------

fn extract_tags(
    introspector: &dyn Introspector,
    result: &mut QueryResult,
    boundary: Option<PosKey>,
) {
    let Some(selector) = label_selector("inkycap-tag") else {
        return;
    };
    let elements = introspector.query(&selector);

    for elem in elements.iter() {
        if is_transcluded(pos_key(introspector, elem), boundary) {
            continue;
        }
        let Some(meta) = elem.to_packed::<MetadataElem>() else {
            continue;
        };
        let Value::Dict(dict) = &meta.value else {
            continue;
        };

        if let Some(Value::Str(name)) = dict_get(dict, "name") {
            let tag = name.as_str().to_string();
            if !result.tags.contains(&tag) {
                result.tags.push(tag);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// <inkycap-link> — wikilinks and link-refs
// ---------------------------------------------------------------------------

fn extract_links(
    introspector: &dyn Introspector,
    result: &mut QueryResult,
    boundary: Option<PosKey>,
) {
    let Some(selector) = label_selector("inkycap-link") else {
        return;
    };
    let elements = introspector.query(&selector);

    for elem in elements.iter() {
        if is_transcluded(pos_key(introspector, elem), boundary) {
            continue;
        }
        let Some(meta) = elem.to_packed::<MetadataElem>() else {
            continue;
        };
        let Value::Dict(dict) = &meta.value else {
            continue;
        };

        if let Some(Value::Str(target)) = dict_get(dict, "target") {
            let target = target.as_str().to_string();
            // The package tags each link with where it was written. A link
            // without the tag counts as a body link.
            let from_metadata = matches!(dict_get(dict, "from"), Some(Value::Str(from)) if from.as_str() == "metadata");
            if !from_metadata {
                result.body_links.push(target.clone());
            }
            result.links.push(target);
        }
        if let Some(Value::Str(label)) = dict_get(dict, "label") {
            result.heading_labels.push(label.as_str().to_string());
        }
    }
}

// ---------------------------------------------------------------------------
// <inkycap-agenda> — inline #task / #due markers
// ---------------------------------------------------------------------------

fn extract_agenda_markers(
    introspector: &dyn Introspector,
    result: &mut QueryResult,
    boundary: Option<PosKey>,
) {
    let Some(selector) = label_selector("inkycap-agenda") else {
        return;
    };
    let elements = introspector.query(&selector);

    for elem in elements.iter() {
        if is_transcluded(pos_key(introspector, elem), boundary) {
            continue;
        }
        let Some(meta) = elem.to_packed::<MetadataElem>() else {
            continue;
        };
        let Value::Dict(dict) = &meta.value else {
            continue;
        };

        let kind = match dict_get(dict, "kind") {
            Some(Value::Str(s)) => s.as_str().to_string(),
            _ => continue,
        };
        let body = match dict_get(dict, "body") {
            Some(Value::Str(s)) => Some(s.as_str().to_string()),
            _ => None,
        };
        let due = match dict_get(dict, "due") {
            Some(Value::Str(s)) => Some(s.as_str().to_string()),
            _ => None,
        };
        let done = matches!(dict_get(dict, "done"), Some(Value::Bool(true)));
        let tags = match dict_get(dict, "tags") {
            Some(Value::Array(arr)) => arr
                .iter()
                .filter_map(|v| match v {
                    Value::Str(s) => Some(s.as_str().to_string()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        // Recurrence is reminder-only — ignore any rule on a `#task` marker.
        let recurrence = if kind == "date" {
            match dict_get(dict, "recurrence") {
                Some(Value::Dict(rec)) => Recurrence::from_typst_dict(rec),
                _ => None,
            }
        } else {
            None
        };

        result.agenda.push(AgendaMarker {
            kind,
            body,
            due,
            done,
            tags,
            recurrence,
        });
    }
}

// ---------------------------------------------------------------------------
// <inkycap-suggestion> — unresolved tracked changes (count only)
// ---------------------------------------------------------------------------

/// Count the note's open `#suggestion(...)` changes, by label (the details are
/// read in the editor for the open note). The transclusion guard keeps an
/// included note's suggestions out of the count.
fn extract_review_markup(
    introspector: &dyn Introspector,
    result: &mut QueryResult,
    boundary: Option<PosKey>,
) {
    let Some(selector) = label_selector("inkycap-suggestion") else {
        return;
    };
    result.suggestions = introspector
        .query(&selector)
        .iter()
        .filter(|elem| !is_transcluded(pos_key(introspector, elem), boundary))
        .count();
}

// ---------------------------------------------------------------------------
// Value conversion helpers
// ---------------------------------------------------------------------------

fn dict_get<'a>(dict: &'a Dict, key: &str) -> Option<&'a Value> {
    dict.get(key).ok()
}

fn typst_value_to_property(value: &Value) -> PropertyValue {
    match value {
        Value::Bool(b) => PropertyValue::Bool(*b),
        Value::Int(n) => PropertyValue::Number(*n as f64),
        Value::Float(f) => PropertyValue::Number(*f),
        Value::Str(s) => PropertyValue::String(s.as_str().to_string()),
        Value::Array(arr) => {
            let items: Vec<PropertyValue> = arr.iter().map(typst_value_to_property).collect();
            PropertyValue::List(items)
        }
        Value::Dict(dict) => {
            // link-ref dicts → store as string "[[target]]"
            if let Some(Value::Str(kind)) = dict_get(dict, "kind") {
                if kind.as_str() == "link-ref" {
                    if let Some(Value::Str(target)) = dict_get(dict, "target") {
                        return PropertyValue::String(format!("[[{}]]", target.as_str()));
                    }
                }
            }
            PropertyValue::String(format!("{dict:?}"))
        }
        _ => PropertyValue::String(format!("{value:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::path::canonicalize_root;
    use std::fs;
    use tempfile::tempdir;

    fn setup_notebox_with_package(source: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize");

        // Scaffold the package into the notebox
        crate::notebox_package::scaffold(&root);

        let note_path = root.join("test.typ");
        let full_source = format!("{}\n\n{}", crate::notebox_package::import_line(), source);
        fs::write(&note_path, &full_source).expect("write note");

        (dir, root)
    }

    #[test]
    fn extracts_note_metadata() {
        let (_dir, root) =
            setup_notebox_with_package(r#"#note(title: "Test Note", tags: ("research", "typst"))"#);
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert_eq!(
            result.properties.get("title"),
            Some(&PropertyValue::String("Test Note".to_string()))
        );
        assert!(result.tags.contains(&"research".to_string()));
        assert!(result.tags.contains(&"typst".to_string()));
    }

    #[test]
    fn extracts_inline_due_recurrence() {
        // A `#due(..., recurrence: (…))` round-trips through the package's
        // `_fmt-recurrence`.
        let (_dir, root) = setup_notebox_with_package(
            r#"Reminder #due(datetime(year: 2026, month: 6, day: 15), label: "Standup", recurrence: (freq: "week", interval: 2, by-day: ("mo", "we"), until: datetime(year: 2026, month: 12, day: 7)))."#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert_eq!(result.agenda.len(), 1);
        let marker = &result.agenda[0];
        assert_eq!(marker.kind, "date");
        assert_eq!(marker.due.as_deref(), Some("2026-06-15"));
        let rec = marker.recurrence.as_ref().expect("recurrence parsed");
        assert_eq!(rec.freq, "week");
        assert_eq!(rec.interval, 2);
        assert_eq!(rec.by_day, vec!["mo".to_string(), "we".to_string()]);
        assert_eq!(rec.until.as_deref(), Some("2026-12-07"));
    }

    #[test]
    fn extracts_document_level_recurrence_out_of_properties() {
        // A `#note(recurrence: …)` rule is parsed into its own field and kept
        // out of the generic `properties` map.
        let (_dir, root) = setup_notebox_with_package(
            r#"#note(title: "Fall term", due: "2026-09-01", recurrence: (freq: "year"))"#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert!(!result.properties.contains_key("recurrence"));
        let rec = result.recurrence.as_ref().expect("recurrence parsed");
        assert_eq!(rec.freq, "year");
        assert_eq!(rec.interval, 1);
    }

    #[test]
    fn preamble_fallback_keeps_note_after_leading_comments() {
        // A comment (or the locale `#set text(...)`) between the import and
        // `#note(...)` must not make `extract_note_preamble` drop the call.
        let src = "#import \"/.inkycap/notebox.typ\": *\n\n// lead\n// more\n\
                   #set text(lang: \"fr\")\n#note(title: \"Commented\")\n= Body\n";
        let pre = extract_note_preamble(src);
        assert!(
            pre.contains("#note("),
            "preamble dropped the #note() call: {pre:?}"
        );
    }

    #[test]
    fn extracts_note_metadata_with_leading_comment_via_fallback() {
        // Through the preamble fallback: a comment before `#note(...)` and a
        // failing body still give the note's properties.
        let (_dir, root) = setup_notebox_with_package(
            "// a leading comment\n#note(title: \"Commented\", tags: (\"x\",))\n\
             = Body\n\nSee @missing-citation for details.\n",
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();
        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);
        assert_eq!(
            result.properties.get("title"),
            Some(&PropertyValue::String("Commented".to_string()))
        );
    }

    #[test]
    fn extracts_inline_tags() {
        let (_dir, root) = setup_notebox_with_package(
            "Some text with #tag(\"important\") and #tag(\"review\") inline.",
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert!(result.tags.contains(&"important".to_string()));
        assert!(result.tags.contains(&"review".to_string()));
    }

    #[test]
    fn extracts_wikilinks() {
        let (_dir, root) = setup_notebox_with_package(
            r#"Link to #wikilink("Other Note") and #wikilink("Another", display: "see this")."#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert!(result.links.contains(&"Other Note".to_string()));
        assert!(result.links.contains(&"Another".to_string()));
    }

    #[test]
    fn extracts_wikilinks_from_ast_when_body_compile_fails() {
        // The body calls an undefined function, so only the preamble compiles;
        // the syntax-tree walk must still find the wikilink.
        let (_dir, root) = setup_notebox_with_package(
            r#"#note(title: "Has Broken Body")

= Heading

Reference to #wikilink("Target Note") here.

#unresolved_function_that_breaks_compile()
"#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        // Title survives because the preamble compile works.
        assert_eq!(
            result.properties.get("title"),
            Some(&PropertyValue::String("Has Broken Body".to_string())),
        );
        // Wikilink survives via the AST fallback.
        assert!(
            result.links.contains(&"Target Note".to_string()),
            "expected wikilink in result.links, got {:?}",
            result.links,
        );
    }

    #[test]
    fn ast_fallback_extracts_body_tags_when_compile_fails() {
        let (_dir, root) = setup_notebox_with_package(
            r#"#note(title: "Tagged But Broken")

#tag("research") and #tag("draft").

#unresolved_function()
"#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert!(result.tags.contains(&"research".to_string()));
        assert!(result.tags.contains(&"draft".to_string()));
    }

    #[test]
    fn extracts_link_refs_from_note_metadata() {
        let (_dir, root) =
            setup_notebox_with_package(r#"#note(title: "Test", source: link-ref("Source Note"))"#);
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert!(result.links.contains(&"Source Note".to_string()));
    }

    #[test]
    fn body_links_leave_out_property_link_refs() {
        let (_dir, root) = setup_notebox_with_package(
            "#note(source: link-ref(\"Source Note\"))\n\nSee #wikilink(\"Body Note\").",
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert!(result.links.contains(&"Source Note".to_string()));
        assert!(result.links.contains(&"Body Note".to_string()));
        assert_eq!(result.body_links, vec!["Body Note".to_string()]);
    }

    #[test]
    fn deduplicates_tags_from_note_and_inline() {
        let (_dir, root) = setup_notebox_with_package(
            "#note(tags: (\"shared\",))\n\nSome #tag(\"shared\") and #tag(\"unique\").",
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        let shared_count = result
            .tags
            .iter()
            .filter(|t| t.as_str() == "shared")
            .count();
        assert_eq!(shared_count, 1, "tag 'shared' should appear exactly once");
        assert!(result.tags.contains(&"unique".to_string()));
    }

    #[test]
    fn broken_file_without_note_returns_empty() {
        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize");
        crate::notebox_package::scaffold(&root);

        let note_path = root.join("broken.typ");
        fs::write(&note_path, "#unknown_function(\n").expect("write");

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(
            &mut compiler,
            &note_path,
            fs::read_to_string(&note_path).unwrap(),
        );

        assert!(result.properties.is_empty());
        assert!(result.tags.is_empty());
        assert!(result.links.is_empty());
    }

    /// A file that fails to compile gives an empty result; the scanner's cache
    /// supplies properties for broken files.
    #[test]
    fn returns_empty_result_when_compilation_fails() {
        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize");
        crate::notebox_package::scaffold(&root);

        // File has `#note(...)` but no import, so compilation will fail.
        let note_path = root.join("no_import.typ");
        let source = r#"#note(
  collection: ("Second Collection", "JC Collection 1"),
  tag: ("dogtag"),
)

= Hello
"#;
        fs::write(&note_path, source).expect("write");

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source.to_string());

        assert!(
            result.properties.is_empty(),
            "expected no properties when compile fails, got {:?}",
            result.properties
        );
        assert!(result.tags.is_empty());
        assert!(result.links.is_empty());
    }

    #[test]
    fn extracts_collection_property_as_list() {
        let (_dir, root) = setup_notebox_with_package(
            r#"#note(title: "Paper Draft", collection: ("my-paper", "thesis-ch3"))"#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        let collection = result
            .properties
            .get("collection")
            .expect("collection property");
        assert!(collection.contains("my-paper"));
        assert!(collection.contains("thesis-ch3"));
        assert!(!collection.contains("other"));
    }

    #[test]
    fn extracts_agenda_markers() {
        let (_dir, root) = setup_notebox_with_package(
            r#"#task("Draft abstract", due: datetime(year: 2026, month: 6, day: 23))

#task("Email co-author", done: true, tags: ("work",))

Keynote confirmed #due(datetime(year: 2026, month: 7, day: 1), label: "Conference")
"#,
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        assert_eq!(result.agenda.len(), 3, "agenda: {:?}", result.agenda);

        let abstract_task = result
            .agenda
            .iter()
            .find(|m| m.body.as_deref() == Some("Draft abstract"))
            .expect("draft abstract task");
        assert_eq!(abstract_task.kind, "task");
        assert_eq!(abstract_task.due.as_deref(), Some("2026-06-23"));
        assert!(!abstract_task.done);

        let email_task = result
            .agenda
            .iter()
            .find(|m| m.body.as_deref() == Some("Email co-author"))
            .expect("email task");
        assert!(email_task.done);
        assert_eq!(email_task.tags, vec!["work".to_string()]);

        let date_marker = result
            .agenda
            .iter()
            .find(|m| m.kind == "date")
            .expect("date marker");
        assert_eq!(date_marker.due.as_deref(), Some("2026-07-01"));
        assert_eq!(date_marker.body.as_deref(), Some("Conference"));
    }

    #[test]
    fn inline_markers_survive_a_broken_body_via_recovery() {
        // Inline `#task` / `#due` markers still reach the Agenda when the body
        // has a localized error (an `#include` of a missing file).
        let (_dir, root) = setup_notebox_with_package(
            "#note(title: \"Daisy\")\n\n\
             Remember #due(\"2026-06-16\", label: \"get that eye exam\")\n\n\
             #task(\"make it so\", due: \"2026-06-16\")\n\n\
             #include \"/deleteme.typ\"\n",
        );
        let note_path = root.join("test.typ");
        let source = fs::read_to_string(&note_path).unwrap();

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &note_path, source);

        // Document-level metadata still present…
        assert_eq!(
            result.properties.get("title"),
            Some(&PropertyValue::String("Daisy".to_string()))
        );
        // …and, crucially, both inline markers (with their string-form dates).
        let date = result
            .agenda
            .iter()
            .find(|m| m.kind == "date")
            .expect("inline #due marker recovered");
        assert_eq!(date.due.as_deref(), Some("2026-06-16"));
        assert_eq!(date.body.as_deref(), Some("get that eye exam"));

        let task = result
            .agenda
            .iter()
            .find(|m| m.kind == "task")
            .expect("inline #task marker recovered");
        assert_eq!(task.body.as_deref(), Some("make it so"));
        assert_eq!(task.due.as_deref(), Some("2026-06-16"));
    }

    /// A note that `#include`s another doesn't take on its identity, tags or
    /// links: only the host's first `<inkycap-note>` is read and body labels
    /// after the second are dropped. See `query_document`.
    #[test]
    fn include_does_not_pollute_host_index() {
        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize");
        crate::notebox_package::scaffold(&root);
        let import = crate::notebox_package::import_line();

        // The included note carries its own prelude, property tag, body tag,
        // and outgoing wikilink.
        fs::write(
            root.join("included.typ"),
            format!(
                "{import}\n\n#note(title: \"Included\", tags: (\"included-tag\",))\n\n\
                 Body with #tag(\"included-body-tag\") and #wikilink(\"Included Target\").\n"
            ),
        )
        .expect("write included");

        // The host note has its own identity, tags, and link, and includes the
        // other note as a trailing block.
        let host_path = root.join("host.typ");
        let host_src = format!(
            "{import}\n\n#note(title: \"Host\", tags: (\"host-tag\",))\n\n\
             Host body with #tag(\"host-body-tag\") and #wikilink(\"Host Target\").\n\n\
             #include \"/included.typ\"\n"
        );
        fs::write(&host_path, &host_src).expect("write host");

        let mut compiler = TypstCompiler::new(root);
        let result = compile_and_query(&mut compiler, &host_path, host_src);

        // Identity: the host's title wins; the included title is not absorbed.
        assert_eq!(
            result.properties.get("title"),
            Some(&PropertyValue::String("Host".to_string())),
            "host title should not be overwritten by the included note",
        );

        // Tags: the host's own tags are present; the included note's are not.
        assert!(result.tags.contains(&"host-tag".to_string()));
        assert!(result.tags.contains(&"host-body-tag".to_string()));
        assert!(
            !result.tags.contains(&"included-tag".to_string()),
            "included note's property tag leaked into host: {:?}",
            result.tags,
        );
        assert!(
            !result.tags.contains(&"included-body-tag".to_string()),
            "included note's body tag leaked into host: {:?}",
            result.tags,
        );

        // Links: the host's own wikilink is present; the included one is not.
        assert!(result.links.contains(&"Host Target".to_string()));
        assert!(
            !result.links.contains(&"Included Target".to_string()),
            "included note's wikilink leaked into host: {:?}",
            result.links,
        );
    }

    /// Recursively collect rendered text from a laid-out frame.
    fn collect_frame_text(frame: &typst::layout::Frame, out: &mut String) {
        for (_, item) in frame.items() {
            match item {
                typst::layout::FrameItem::Text(t) => {
                    out.push_str(&t.text);
                    out.push(' ');
                }
                typst::layout::FrameItem::Group(g) => collect_frame_text(&g.frame, out),
                _ => {}
            }
        }
    }

    /// `#include "/other.typ"` from a note in a subfolder renders the included
    /// note's body (host in `test1/`, target at the root).
    #[test]
    fn include_renders_included_body() {
        let dir = tempdir().expect("tempdir");
        let root = canonicalize_root(dir.path()).expect("canonicalize");
        crate::notebox_package::scaffold(&root);
        let import = crate::notebox_package::import_line();

        fs::write(
            root.join("deleteme.typ"),
            format!("{import}\n\n#note(title: \"Del\")\n\nINCLUDEDBODYMARKER content here.\n"),
        )
        .expect("write included");

        fs::create_dir_all(root.join("test1")).expect("mkdir test1");
        let host_path = root.join("test1/host.typ");
        let host_src = format!(
            "{import}\n\n#note(title: \"Host\")\n\n= Daisy\n\nHOSTBODYMARKER\n\n#include \"/deleteme.typ\"\n"
        );
        fs::write(&host_path, &host_src).expect("write host");

        let mut compiler = TypstCompiler::new(root);
        let doc = compiler
            .compile_document(&host_path, host_src)
            .expect("host should compile");

        let mut text = String::new();
        for page in doc.pages() {
            collect_frame_text(&page.frame, &mut text);
        }

        assert!(
            text.contains("HOSTBODYMARKER"),
            "host body missing; rendered: {text}"
        );
        assert!(
            text.contains("INCLUDEDBODYMARKER"),
            "included note's body did not render; rendered: {text}"
        );
    }
}
