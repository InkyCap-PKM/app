// `{{ref}}` and `{{ref.FIELD}}` scaffold variables: one bibliography
// reference's details, copied into a new note (a literature note) when the
// scaffold is used. The details come from the same hayagriva entry Typst cites
// from, so both citation sources (a bibliography file and Zotero, which is
// exported as BibTeX) give the same fields, under Typst's own field names.
//
// Each variable is written to suit where it sits in the scaffold, read from
// Typst's syntax tree:
//   * as a whole string (`author: "{{ref.author}}"`), the form that keeps the
//     scaffold valid Typst: the field's Typst value, replacing the quotes. Names
//     become an array, `"{{ref}}"` the reference's label (`<otlet1934>`), and
//     other fields a string. Written unquoted in code, a variable is read the
//     same way;
//   * inside a longer string (`"By {{ref.author}}"`): the text, escaped for
//     the string;
//   * in markup: the text, escaped as markup, and `{{ref}}` a citation.
// A named argument whose whole value is a field the reference doesn't have is
// left out, so a book's literature note gets no empty `journal:`.

use std::ops::Range;
use std::sync::OnceLock;

use regex::Regex;
use typst::syntax::{
    ast::{self, AstNode},
    is_valid_label_literal_id, parse, LinkedNode, Side, SyntaxKind,
};

use crate::typst_pipeline::book_wrapper::escape_typst_markup;
use crate::typst_pipeline::note_rewriter::label_value;

/// The `{{ref.FIELD}}` field names, in the order the documentation lists them.
/// Typst's (hayagriva's) names, plus `year` and `type`.
pub const FIELD_NAMES: &[&str] = &[
    "key",
    "type",
    "title",
    "author",
    "editor",
    "date",
    "year",
    "parent",
    "publisher",
    "location",
    "organization",
    "volume",
    "issue",
    "edition",
    "page-range",
    "url",
    "doi",
    "isbn",
    "issn",
    "language",
    "genre",
    "abstract",
    "note",
];

/// A field's value: text, or a list of names (`author`, `editor`).
#[derive(Debug, Clone, PartialEq)]
enum FieldValue {
    Text(String),
    Names(Vec<String>),
}

/// One reference's details, for expanding `{{ref…}}` variables.
#[derive(Debug, Clone)]
pub struct ReferenceFields {
    key: String,
    fields: Vec<(&'static str, FieldValue)>,
}

impl ReferenceFields {
    /// Read the details from a hayagriva entry. Fields the entry doesn't have,
    /// or has empty, are left out. A field that belongs to the work the entry
    /// appears in (an article's volume and issue are the journal's) is read
    /// from that work when the entry has none of its own.
    pub fn from_entry(entry: &hayagriva::Entry) -> Self {
        let parent = entry.parents().first();
        let fields = FIELD_NAMES
            .iter()
            .filter_map(|&name| {
                let value = read_field(entry, name).or_else(|| {
                    INHERITED_FIELDS
                        .contains(&name)
                        .then(|| parent.and_then(|p| read_field(p, name)))
                        .flatten()
                });
                value.map(|v| (name, v))
            })
            .collect();
        Self {
            key: entry.key().to_string(),
            fields,
        }
    }

    fn field(&self, name: &str) -> Option<&FieldValue> {
        self.fields.iter().find(|(n, _)| *n == name).map(|(_, v)| v)
    }
}

/// Fields read from the work an entry appears in when the entry has none.
const INHERITED_FIELDS: &[&str] = &[
    "editor",
    "date",
    "year",
    "publisher",
    "location",
    "organization",
    "volume",
    "issue",
    "edition",
    "isbn",
    "issn",
];

/// One field of `entry`, by its `{{ref.FIELD}}` name.
fn read_field(entry: &hayagriva::Entry, name: &str) -> Option<FieldValue> {
    fn text(value: impl ToString) -> Option<FieldValue> {
        let s = value.to_string();
        let s = s.trim();
        (!s.is_empty()).then(|| FieldValue::Text(s.to_string()))
    }
    fn names(persons: Option<&[hayagriva::types::Person]>) -> Option<FieldValue> {
        let list: Vec<String> = persons?
            .iter()
            .map(|p| p.name_first(false, false))
            .filter(|n| !n.trim().is_empty())
            .collect();
        (!list.is_empty()).then_some(FieldValue::Names(list))
    }
    match name {
        "key" => text(entry.key()),
        "type" => text(format!("{:?}", entry.entry_type()).to_lowercase()),
        "title" => entry.title().and_then(text),
        "author" => names(entry.authors()),
        "editor" => names(entry.editors()),
        "date" => entry.date_any().and_then(text),
        "year" => entry.date_any().and_then(|d| text(d.year)),
        "parent" => entry
            .parents()
            .first()
            .and_then(|p| p.title())
            .and_then(text),
        "publisher" => entry.publisher().and_then(|p| p.name()).and_then(text),
        "location" => entry
            .location()
            .or_else(|| entry.publisher().and_then(|p| p.location()))
            .and_then(text),
        "organization" => entry.organization().and_then(text),
        "volume" => entry.volume().and_then(text),
        "issue" => entry.issue().and_then(text),
        "edition" => entry.edition().and_then(text),
        "page-range" => entry.page_range().and_then(text),
        "url" => entry.url_any().and_then(|u| text(&u.value)),
        "doi" => entry.doi().and_then(text),
        "isbn" => entry.isbn().and_then(text),
        "issn" => entry.issn().and_then(text),
        "language" => entry.language().and_then(text),
        "genre" => entry.genre().and_then(text),
        "abstract" => entry.abstract_().and_then(text),
        "note" => entry.note().and_then(text),
        _ => None,
    }
}

/// `{{ref}}` or `{{ref.FIELD}}`; group 1 is the field name.
fn variable_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{\{ref(?:\.([a-z-]+))?\}\}").unwrap())
}

/// Where a variable sits in the scaffold's Typst source.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Context {
    /// Inside a `"…"` string.
    Str,
    /// A value in code: `{{ref}}` parses as a code block there.
    Code,
    Markup,
    /// Comments are help text and are left as written.
    Comment,
}

/// Whether `source` uses a `{{ref}}` or `{{ref.FIELD}}` variable outside a
/// comment, so the scaffold needs a reference to be expanded.
pub fn uses_reference(source: &str) -> bool {
    let root = parse(source);
    let root = LinkedNode::new(&root);
    variable_re()
        .find_iter(source)
        .any(|m| context_at(&root, m.start()) != Context::Comment)
}

/// Expand every `{{ref}}` and `{{ref.FIELD}}` in `source` (see the module
/// comment). Unknown field names expand like missing fields.
pub fn expand_reference_variables(source: &str, reference: &ReferenceFields) -> String {
    let root = parse(source);
    let root = LinkedNode::new(&root);
    let mut edits: Vec<(Range<usize>, String)> = Vec::new();

    for caps in variable_re().captures_iter(source) {
        let whole = caps.get(0).unwrap();
        let mut context = context_at(&root, whole.start());
        if context == Context::Comment {
            continue;
        }
        // A string holding only the variable is the value itself: replace the
        // string, quotes and all, as if the variable were written unquoted.
        let mut range = whole.range();
        if context == Context::Str {
            if let Some(string) = root.leaf_at(whole.start() + 1, Side::Before) {
                if string.range().len() == range.len() + 2 {
                    range = string.range();
                    context = Context::Code;
                }
            }
        }
        let field = caps.get(1).map(|m| m.as_str());
        let value = match field {
            None => Some(Lookup::Reference),
            Some(name) => reference.field(name).map(Lookup::Field),
        };
        let edit = match value {
            Some(value) => (range, render(&value, &reference.key, context)),
            None => match named_arg_holding_only(&root, range.clone(), context) {
                Some(arg) => (removal_range(source, arg), String::new()),
                None => (range, missing(context)),
            },
        };
        // A removed argument can contain only this variable, so edits never
        // overlap.
        edits.push(edit);
    }

    let mut out = source.to_string();
    for (range, replacement) in edits.into_iter().rev() {
        out.replace_range(range, &replacement);
    }
    out
}

enum Lookup<'a> {
    /// `{{ref}}`: the reference itself.
    Reference,
    Field(&'a FieldValue),
}

fn context_at(root: &LinkedNode<'_>, offset: usize) -> Context {
    let Some(leaf) = root.leaf_at(offset + 1, Side::Before) else {
        return Context::Markup;
    };
    match leaf.kind() {
        SyntaxKind::Str => Context::Str,
        SyntaxKind::LineComment | SyntaxKind::BlockComment => Context::Comment,
        SyntaxKind::LeftBrace => Context::Code,
        _ => Context::Markup,
    }
}

fn render(value: &Lookup<'_>, key: &str, context: Context) -> String {
    match (value, context) {
        (Lookup::Reference, Context::Code) => label_value(key),
        (Lookup::Reference, Context::Str) => escape_string(key),
        (Lookup::Reference, _) => citation_markup(key),
        (Lookup::Field(FieldValue::Text(s)), Context::Code) => quote(s),
        (Lookup::Field(FieldValue::Names(list)), Context::Code) => {
            let items: Vec<String> = list.iter().map(|n| quote(n)).collect();
            if items.len() == 1 {
                format!("({},)", items[0])
            } else {
                format!("({})", items.join(", "))
            }
        }
        (Lookup::Field(field), Context::Str) => escape_string(&joined(field)),
        (Lookup::Field(field), _) => escape_typst_markup(&joined(field)),
    }
}

/// What a missing field becomes when it can't simply be left out.
fn missing(context: Context) -> String {
    match context {
        Context::Code => "none".to_string(),
        _ => String::new(),
    }
}

fn joined(field: &FieldValue) -> String {
    match field {
        FieldValue::Text(s) => s.clone(),
        FieldValue::Names(list) => list.join("; "),
    }
}

/// A citation of the reference in markup: `@key`, or `#cite(…)` for a key
/// the `@` shorthand can't hold (a trailing `.` or `:` reads as punctuation).
fn citation_markup(key: &str) -> String {
    if is_valid_label_literal_id(key) && !key.ends_with(['.', ':']) {
        format!("@{key}")
    } else {
        format!("#cite({})", label_value(key))
    }
}

fn quote(s: &str) -> String {
    format!("\"{}\"", escape_string(s))
}

fn escape_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out
}

/// The named argument whose whole value is the variable at `range` (`key:
/// "{{ref.x}}"`, or `key: {{ref.x}}` unquoted). Returns the argument's byte
/// range.
fn named_arg_holding_only(
    root: &LinkedNode<'_>,
    range: Range<usize>,
    context: Context,
) -> Option<Range<usize>> {
    if context != Context::Code {
        return None;
    }
    let mut node = root.leaf_at(range.start + 1, Side::Before)?;
    while let Some(parent) = node.parent().cloned() {
        if let Some(named) = parent.cast::<ast::Named>() {
            let value = named.expr().to_untyped();
            let value_range = parent.children().find(|c| c.get() == value)?.range();
            return (value_range == range).then(|| parent.range());
        }
        // Stop at the first expression that isn't the variable's own string or
        // code blocks.
        if !matches!(
            parent.kind(),
            SyntaxKind::CodeBlock | SyntaxKind::Code | SyntaxKind::FieldAccess
        ) {
            return None;
        }
        node = parent;
    }
    None
}

/// What to delete to leave out the argument at `arg`: its whole line when it
/// stands alone on one (with its trailing comma), otherwise the argument and
/// the comma and spaces after it.
fn removal_range(source: &str, arg: Range<usize>) -> Range<usize> {
    let line_start = source[..arg.start].rfind('\n').map_or(0, |i| i + 1);
    let mut end = arg.end;
    let rest = &source[end..];
    let after_comma = rest.trim_start_matches([' ', '\t']);
    if let Some(stripped) = after_comma.strip_prefix(',') {
        end += rest.len() - stripped.len();
    }
    let alone_before = source[line_start..arg.start].trim().is_empty();
    let tail = &source[end..];
    let line_end = tail.find('\n').map(|i| end + i);
    if alone_before {
        if let Some(line_end) = line_end {
            if source[end..line_end].trim().is_empty() {
                return line_start..line_end + 1;
            }
        }
    }
    let spaces = tail.len() - tail.trim_start_matches([' ', '\t']).len();
    arg.start..end + spaces
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference(bib: &str) -> ReferenceFields {
        let library = hayagriva::io::from_biblatex_str(bib).unwrap();
        let entry = library.iter().next().unwrap();
        ReferenceFields::from_entry(entry)
    }

    const ARTICLE: &str = r#"@article{otlet1934,
  author = {Otlet, Paul and Goedel, Kurt},
  title = {Traité de "documentation"},
  journal = {Library Quarterly},
  year = {1934},
  volume = {4},
  pages = {10--20},
  doi = {10.1000/xyz},
}"#;

    #[test]
    fn values_follow_their_syntax_context() {
        let scaffold = "#note(\n  title: \"{{ref.title}}\",\n  source: {{ref}},\n  author: {{ref.author}},\n  journal: {{ref.parent}},\n)\n\nNotes on {{ref.title}} ({{ref}}).\n";
        let out = expand_reference_variables(scaffold, &reference(ARTICLE));
        assert_eq!(
            out,
            "#note(\n  title: \"Traité de \\\"documentation\\\"\",\n  source: <otlet1934>,\n  author: (\"Otlet, Paul\", \"Goedel, Kurt\"),\n  journal: \"Library Quarterly\",\n)\n\nNotes on Traité de \"documentation\" (@otlet1934).\n"
        );
    }

    #[test]
    fn a_whole_string_becomes_the_value_itself() {
        let scaffold = "#note(source: \"{{ref}}\", author: \"{{ref.author}}\", year: \"{{ref.year}}\", note: \"By {{ref.author}}\")";
        assert_eq!(
            expand_reference_variables(scaffold, &reference(ARTICLE)),
            "#note(source: <otlet1934>, author: (\"Otlet, Paul\", \"Goedel, Kurt\"), year: \"1934\", note: \"By Otlet, Paul; Goedel, Kurt\")"
        );
    }

    #[test]
    fn a_named_argument_for_a_missing_field_is_left_out() {
        let book = "@book{b, title = {A Book}, publisher = {Press}, year = {2001}}";
        let scaffold = "#note(\n  title: \"{{ref.title}}\",\n  journal: {{ref.parent}},\n  issue: \"{{ref.issue}}\",\n  publisher: {{ref.publisher}},\n)\nIn {{ref.parent}}.\n";
        let out = expand_reference_variables(scaffold, &reference(book));
        assert_eq!(
            out,
            "#note(\n  title: \"A Book\",\n  publisher: \"Press\",\n)\nIn .\n"
        );
        let one_line = "#note(title: {{ref.title}}, journal: {{ref.parent}}, year: {{ref.year}})";
        assert_eq!(
            expand_reference_variables(one_line, &reference(book)),
            "#note(title: \"A Book\", year: \"2001\")"
        );
    }

    #[test]
    fn markup_values_are_escaped() {
        let r = reference("@misc{k, title = {C* algebras #1 [draft]}}");
        assert_eq!(
            expand_reference_variables("= {{ref.title}}", &r),
            "= C\\* algebras \\#1 \\[draft\\]"
        );
    }

    #[test]
    fn keys_a_label_literal_cannot_hold_use_label() {
        let r = reference("@misc{odd/key, title = {T}}");
        assert_eq!(
            expand_reference_variables("#note(source: {{ref}})\n{{ref}}", &r),
            "#note(source: label(\"odd/key\"))\n#cite(label(\"odd/key\"))"
        );
    }

    #[test]
    fn comments_are_left_as_written() {
        let scaffold = "// Variables: {{ref}} {{ref.title}}\n#note(title: \"{{ref.title}}\")";
        assert!(uses_reference(scaffold));
        assert!(!uses_reference("// {{ref.title}}\n#note(title: \"x\")"));
        let out = expand_reference_variables(scaffold, &reference(ARTICLE));
        assert!(out.starts_with("// Variables: {{ref}} {{ref.title}}\n"));
    }

    #[test]
    fn the_sample_literature_scaffold_expands_to_a_valid_note() {
        let sample = crate::notebox_package::LITERATURE_NOTE_SAMPLE_SCAFFOLD;
        assert!(uses_reference(sample));
        // Valid Typst as written, so it can be opened and edited.
        assert!(parse(sample).errors_and_warnings().0.is_empty());
        let out = expand_reference_variables(sample, &reference(ARTICLE));
        assert!(out.contains("  source: <otlet1934>,\n"), "got:\n{out}");
        assert!(
            out.contains("  author: (\"Otlet, Paul\", \"Goedel, Kurt\"),\n"),
            "got:\n{out}"
        );
        assert!(
            out.contains("  published-in: \"Library Quarterly\",\n"),
            "got:\n{out}"
        );
        // The article has no publisher, so that line is left out.
        assert!(!out.contains("publisher:"), "got:\n{out}");
        assert!(out.contains("\n@otlet1934\n"), "got:\n{out}");
        // The help text in the comment is kept.
        assert!(
            out.contains("// {{ref}} is the reference itself"),
            "got:\n{out}"
        );
        assert!(
            parse(&out).errors_and_warnings().0.is_empty(),
            "got:\n{out}"
        );
    }

    #[test]
    fn every_documented_field_is_read() {
        let r = reference(ARTICLE);
        for name in [
            "key",
            "type",
            "title",
            "author",
            "date",
            "year",
            "parent",
            "volume",
            "page-range",
            "doi",
        ] {
            assert!(r.field(name).is_some(), "{name} should be read");
        }
        for (name, _) in &r.fields {
            assert!(FIELD_NAMES.contains(name), "{name} should be documented");
        }
    }
}
