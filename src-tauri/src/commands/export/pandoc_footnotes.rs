//! Footnotes in files made with Pandoc.
//!
//! Per CLAUDE.md's Typst-first principle: Typst's HTML has only one form of
//! footnote, which Pandoc can't read, and HTML has no footnote element that a
//! show rule could produce instead, so Pandoc has to put them together.

/// Pandoc filter that turns Typst's footnotes into real footnotes.
pub(super) const LUA_FILTER: &str = include_str!("pandoc_footnotes.lua");

/// Rename the role of the footnote list in Typst's HTML. Pandoc's HTML reader
/// takes a `doc-endnotes` section out of the document and then can't match its
/// entries to Typst's markup, so the footnotes would be lost before
/// [`LUA_FILTER`] runs. The whole tag is matched, which the text of a note can't
/// contain, since its `<` is escaped.
pub(super) fn keep_footnote_list(html: &str) -> String {
    html.replace(
        r#"<section role="doc-endnotes">"#,
        r#"<section role="inkycap-endnotes">"#,
    )
}
