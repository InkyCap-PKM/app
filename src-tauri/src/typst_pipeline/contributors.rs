//! Contributors: the multi-author byline + CRediT roster that supersedes
//! the single `author` field in a collection's Book Metadata.
//!
//! This module owns two things:
//!   1. the canonical role vocabularies — the 14 NISO CRediT roles and the
//!      CSL/Hayagriva bibliographic roles — exposed to the frontend via a
//!      command so the editor's dropdowns and the export renderer share one
//!      source of truth (no duplicated lists drifting apart);
//!   2. the Rust→Typst glue that turns a `Vec<Contributor>` into calls to
//!      the `inkycap-notebox` package's `contributors-byline` /
//!      `credit-statement` helpers.
//!
//! Per CLAUDE.md's Typst-first principle the *formatting* (grouping a byline
//! by role, laying out a contributions statement) lives in `lib.typ`; Rust
//! only resolves CRediT IDs to labels and emits a single function call with
//! the data as a Typst array literal.

use serde::Serialize;

use crate::collection_parser::model::Contributor;
use crate::typst_pipeline::book_wrapper::typst_escape;

/// One selectable role for a frontend dropdown / multi-select: a stored
/// value (the canonical CRediT URL, or the CSL role token) and a
/// human-readable label.
#[derive(Debug, Clone, Serialize)]
pub struct CatalogEntry {
    pub value: String,
    pub label: String,
}

/// The role vocabularies the contributors editor needs. Sent to the
/// frontend so its dropdowns mirror exactly what the renderer understands.
#[derive(Debug, Clone, Serialize)]
pub struct ContributorCatalogs {
    pub credit_roles: Vec<CatalogEntry>,
    pub biblio_roles: Vec<CatalogEntry>,
}

/// The 14 NISO CRediT roles: `(canonical-id-url, label)`. The id is stored
/// in `Contributor.credit_roles` so the data round-trips and interoperates;
/// the label is what renders in the statement and the editor.
/// Reference: <https://credit.niso.org/>.
const CREDIT_ROLES: &[(&str, &str)] = &[
    ("https://credit.niso.org/contributor-roles/conceptualization/", "Conceptualization"),
    ("https://credit.niso.org/contributor-roles/data-curation/", "Data curation"),
    ("https://credit.niso.org/contributor-roles/formal-analysis/", "Formal analysis"),
    ("https://credit.niso.org/contributor-roles/funding-acquisition/", "Funding acquisition"),
    ("https://credit.niso.org/contributor-roles/investigation/", "Investigation"),
    ("https://credit.niso.org/contributor-roles/methodology/", "Methodology"),
    ("https://credit.niso.org/contributor-roles/project-administration/", "Project administration"),
    ("https://credit.niso.org/contributor-roles/resources/", "Resources"),
    ("https://credit.niso.org/contributor-roles/software/", "Software"),
    ("https://credit.niso.org/contributor-roles/supervision/", "Supervision"),
    ("https://credit.niso.org/contributor-roles/validation/", "Validation"),
    ("https://credit.niso.org/contributor-roles/visualization/", "Visualization"),
    ("https://credit.niso.org/contributor-roles/writing-original-draft/", "Writing \u{2013} original draft"),
    ("https://credit.niso.org/contributor-roles/writing-review-editing/", "Writing \u{2013} review & editing"),
];

/// CSL/Hayagriva bibliographic roles: `(token, label)`. The token is stored
/// in `Contributor.biblio_role` and drives the byline grouping (the matching
/// "Edited by"/"Translated by" phrasing lives in `lib.typ`). `author` is the
/// implicit default when unset.
const BIBLIO_ROLES: &[(&str, &str)] = &[
    ("author", "Author"),
    ("editor", "Editor"),
    ("translator", "Translator"),
    ("editor-translator", "Editor & translator"),
    ("compiler", "Compiler"),
    ("series-editor", "Series editor"),
    ("illustrator", "Illustrator"),
    ("narrator", "Narrator"),
    ("annotator", "Annotator"),
    ("foreword", "Foreword"),
    ("afterword", "Afterword"),
    ("holder", "Rights holder"),
];

/// Build the catalogs for the frontend editor.
pub fn catalogs() -> ContributorCatalogs {
    let to_entries = |pairs: &[(&str, &str)]| {
        pairs
            .iter()
            .map(|(v, l)| CatalogEntry { value: v.to_string(), label: l.to_string() })
            .collect()
    };
    ContributorCatalogs {
        credit_roles: to_entries(CREDIT_ROLES),
        biblio_roles: to_entries(BIBLIO_ROLES),
    }
}

/// Human label for a CRediT id, or the id itself when unrecognized (so a
/// future role still renders something sensible rather than vanishing).
fn credit_label(id: &str) -> &str {
    CREDIT_ROLES
        .iter()
        .find(|(v, _)| *v == id)
        .map(|(_, l)| *l)
        .unwrap_or(id)
}

/// The names that should populate the document's `author` metadata
/// (PDF/HTML catalog, and any downstream docx/odt export). Derived from the
/// contributor roster — the bibliographic authors — so the metadata "author"
/// flows from the same source the byline does. Falls back to the bare
/// authors of *all* roles if no row is explicitly an author, then to the
/// legacy single `author` string when there are no contributors at all.
pub fn document_author_names(contributors: &[Contributor], legacy_author: Option<&str>) -> Vec<String> {
    let is_author = |c: &Contributor| {
        matches!(c.biblio_role.as_deref(), None | Some("") | Some("author"))
    };
    let named = |c: &&Contributor| !c.name.trim().is_empty();

    if !contributors.is_empty() {
        let authors: Vec<String> = contributors
            .iter()
            .filter(|c| is_author(c))
            .filter(named)
            .map(|c| c.name.trim().to_string())
            .collect();
        if !authors.is_empty() {
            return authors;
        }
        // No explicit author row — fall back to every named contributor so
        // the metadata isn't empty (e.g. an editor-only volume).
        return contributors
            .iter()
            .filter(named)
            .map(|c| c.name.trim().to_string())
            .collect();
    }
    legacy_author
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| vec![s.to_string()])
        .unwrap_or_default()
}

/// Wrap pre-serialized items as a Typst array literal. A single element
/// needs a trailing comma — `("x")` is parenthesized grouping (a string),
/// not a one-element array — the same gotcha as `note_rewriter`'s
/// `serialize_to_typst`.
fn typst_array(items: &[String]) -> String {
    match items.len() {
        0 => "()".to_string(),
        1 => format!("({},)", items[0]),
        _ => format!("({})", items.join(", ")),
    }
}

/// Serialize one contributor to a Typst dict literal:
/// `(name: "...", role: "...", credit: ("Label", ...))`.
fn contributor_dict(c: &Contributor) -> String {
    let role = c.biblio_role.as_deref().filter(|r| !r.is_empty()).unwrap_or("author");
    let credit: Vec<String> = c
        .credit_roles
        .iter()
        .map(|id| format!("\"{}\"", typst_escape(credit_label(id))))
        .collect();
    format!(
        "(name: \"{}\", role: \"{}\", credit: {})",
        typst_escape(c.name.trim()),
        typst_escape(role),
        typst_array(&credit)
    )
}

/// Serialize the roster to a Typst array literal of contributor dicts.
fn contributors_array(contributors: &[Contributor]) -> String {
    let items: Vec<String> = contributors
        .iter()
        .filter(|c| !c.name.trim().is_empty())
        .map(contributor_dict)
        .collect();
    typst_array(&items)
}

/// `#contributors-byline((...))` for the title page, or `None` when there
/// are no named contributors (the caller falls back to the legacy author
/// line).
pub fn byline_call(contributors: &[Contributor]) -> Option<String> {
    if contributors.iter().all(|c| c.name.trim().is_empty()) {
        return None;
    }
    Some(format!("#contributors-byline({})\n", contributors_array(contributors)))
}

/// `#credit-statement((...))` when at least one contributor carries a CRediT
/// role, else `None` (nothing to state).
pub fn credit_statement_call(contributors: &[Contributor]) -> Option<String> {
    let has_credit = contributors
        .iter()
        .any(|c| !c.name.trim().is_empty() && !c.credit_roles.is_empty());
    if !has_credit {
        return None;
    }
    Some(format!("#credit-statement({})\n", contributors_array(contributors)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contrib(name: &str, role: Option<&str>, credit: &[&str]) -> Contributor {
        Contributor {
            name: name.into(),
            biblio_role: role.map(|r| r.into()),
            credit_roles: credit.iter().map(|c| c.to_string()).collect(),
            is_collaborator: false,
            handle: None,
        }
    }

    const CONCEPT: &str = "https://credit.niso.org/contributor-roles/conceptualization/";

    #[test]
    fn catalogs_have_fourteen_credit_and_the_biblio_roles() {
        let c = catalogs();
        assert_eq!(c.credit_roles.len(), 14);
        assert!(c.biblio_roles.iter().any(|e| e.value == "editor"));
    }

    #[test]
    fn credit_label_resolves_known_and_passes_through_unknown() {
        assert_eq!(credit_label(CONCEPT), "Conceptualization");
        assert_eq!(credit_label("urn:made-up"), "urn:made-up");
    }

    #[test]
    fn document_author_prefers_explicit_authors() {
        let roster = vec![
            contrib("Alice", Some("author"), &[]),
            contrib("Sam", Some("editor"), &[]),
            contrib("Bob", None, &[]),
        ];
        assert_eq!(document_author_names(&roster, None), vec!["Alice", "Bob"]);
    }

    #[test]
    fn document_author_falls_back_to_all_then_legacy() {
        // No explicit author → every named contributor.
        let editors = vec![contrib("Sam", Some("editor"), &[])];
        assert_eq!(document_author_names(&editors, None), vec!["Sam"]);
        // No contributors → legacy author string.
        assert_eq!(document_author_names(&[], Some("Old Author")), vec!["Old Author"]);
        assert!(document_author_names(&[], None).is_empty());
        assert!(document_author_names(&[], Some("  ")).is_empty());
    }

    #[test]
    fn byline_call_omits_when_empty_and_includes_role() {
        assert!(byline_call(&[]).is_none());
        assert!(byline_call(&[contrib("  ", None, &[])]).is_none());
        let call = byline_call(&[contrib("Sam", Some("editor"), &[])]).unwrap();
        assert!(call.starts_with("#contributors-byline("));
        assert!(call.contains("name: \"Sam\""));
        assert!(call.contains("role: \"editor\""));
    }

    #[test]
    fn credit_statement_only_when_roles_present() {
        assert!(credit_statement_call(&[contrib("Alice", None, &[])]).is_none());
        let call = credit_statement_call(&[contrib("Alice", None, &[CONCEPT])]).unwrap();
        assert!(call.contains("#credit-statement("));
        // Single-element arrays carry a trailing comma (else Typst reads
        // `("x")` as a string).
        assert!(call.contains("credit: (\"Conceptualization\",)"), "got: {call}");
    }

    #[test]
    fn typst_array_trailing_comma_on_single_element() {
        // `("x")` is a parenthesized string in Typst, not a one-element
        // array — the single-element case must carry a trailing comma.
        assert_eq!(typst_array(&[]), "()");
        assert_eq!(typst_array(&["a".to_string()]), "(a,)");
        assert_eq!(typst_array(&["a".to_string(), "b".to_string()]), "(a, b)");
    }

    #[test]
    fn dict_escapes_quotes_in_names() {
        let call = byline_call(&[contrib("A \"B\" C", None, &[])]).unwrap();
        assert!(call.contains("name: \"A \\\"B\\\" C\""));
    }
}
