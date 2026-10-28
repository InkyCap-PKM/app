//! Builds the Typst source for "Export as book": from an ordered list of a
//! collection's notes, one document with a title page, optional abstract,
//! outline, chapters and bibliography. It is compiled directly, never written
//! to disk.
//!
//! Notes are inlined rather than `#include`d, because the compiler only reads
//! files inside the notebox. Each note's import, `#note(...)` call and
//! `#bibliography(...)` calls are removed first. Links between chapters use the
//! package's `set-merged-context(...)` state (see [`build_book_source`]).

use std::path::PathBuf;

use crate::collection_parser::model::{
    BibliographyMode, BookExportConfig, BookPageNumbering, BookWikilinkMode, Contributor,
    InjectChapterHeading, TocPlacement,
};
use crate::notebox_package::strip_note_preamble;
use crate::typst_pipeline::contributors;
use crate::typst_pipeline::diagnostic::TypstDiagnostic;
use crate::typst_pipeline::source_structure;

// ── Public types ────────────────────────────────────────────────────────────

/// One note participating in the merged book. `stem` is the file stem
/// (basename without `.typ`) used as the wikilink target name.
#[derive(Debug, Clone)]
pub struct BookNote {
    pub stem: String,
    pub abs_path: PathBuf,
    pub content: String,
    /// Title from the note's `#note(title: ...)`, used to add a chapter heading
    /// when the note doesn't start with one.
    pub title: Option<String>,
}

/// Resolved options for one book export: the collection's `BookExportConfig`
/// plus the dialog's overrides, with defaults already applied.
#[derive(Debug, Clone)]
pub struct BookExportOptions {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    /// Single author string, used for the document metadata when there are no
    /// `contributors`.
    pub author: Option<String>,
    /// Multi-author + CRediT roster. Drives the title-page byline and, when
    /// non-empty, the document `author` metadata.
    pub contributors: Vec<Contributor>,
    pub date: Option<String>,
    pub abstract_text: Option<String>,
    pub toc_depth: u8,
    pub inject_chapter_heading: InjectChapterHeading,
    pub wikilink_mode: BookWikilinkMode,
    pub include_title_page: bool,
    pub include_outline: bool,
    /// Where the table of contents is placed relative to the chapters.
    pub toc_placement: TocPlacement,
    pub page_numbering: BookPageNumbering,
    /// How the bibliography is sourced — consolidated or per-note in place.
    pub bibliography_mode: BibliographyMode,
    /// Render the CRediT contributions statement (when contributors carry
    /// CRediT roles). The byline renders regardless.
    pub include_credit_statement: bool,
}

impl BookExportOptions {
    /// Resolve a `BookExportConfig` (possibly empty) into a fully-specified
    /// options struct, filling in defaults where the config is silent.
    pub fn from_config(config: Option<&BookExportConfig>) -> Self {
        let cfg = config.cloned().unwrap_or_default();
        Self {
            title: cfg.title,
            subtitle: cfg.subtitle,
            author: cfg.author,
            contributors: cfg.contributors,
            date: cfg.date,
            abstract_text: cfg.abstract_text,
            toc_depth: cfg.toc_depth.unwrap_or(2),
            inject_chapter_heading: cfg.inject_chapter_heading.unwrap_or_default(),
            wikilink_mode: cfg.wikilink_mode.unwrap_or_default(),
            include_title_page: cfg.include_title_page.unwrap_or(true),
            include_outline: cfg.include_outline.unwrap_or(true),
            toc_placement: cfg.toc_placement.unwrap_or_default(),
            page_numbering: cfg.page_numbering.unwrap_or_default(),
            bibliography_mode: cfg.bibliography_mode.unwrap_or_default(),
            include_credit_statement: cfg.include_credit_statement.unwrap_or(true),
        }
    }
}

/// A single label found in a note. `name` is the bare label identifier (the
/// text inside `<...>`); `note_stem` is the originating note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelDecl {
    pub name: String,
    pub note_stem: String,
}

/// One collision report: a label defined in 2+ notes.
#[derive(Debug, Clone)]
pub struct LabelCollision {
    pub label: String,
    pub notes: Vec<String>,
}

// ── Note preprocessing ──────────────────────────────────────────────────────

/// Remove top-level `#bibliography(...)` calls from a note body; the book has
/// its own. Finds `#bibliography(` at a line start and walks balanced
/// parentheses, skipping strings.
///
/// Per CLAUDE.md's Typst-first principle: as in
/// `bibliography::already_declares_bibliography`, an AST version would fail on
/// the half-typed or broken notes a book has to tolerate, while this scan works
/// even when the note doesn't parse.
pub fn strip_bibliography_call(content: &str) -> String {
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    // `i` always sits on a char boundary: it only advances past newlines,
    // earlier slice ends, or ASCII parentheses.
    let mut i = 0;

    while i < len {
        let line_start = i == 0 || bytes[i - 1] == b'\n';
        if line_start {
            // Skip leading spaces/tabs to detect a line-leading
            // `#bibliography(` even when indented.
            let mut j = i;
            while j < len && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            // Also remove the package's `#apply-bibliography(...)`, which may
            // already have been added to the note.
            let call_prefix = if content[j..].starts_with("#bibliography(") {
                Some("#bibliography")
            } else if content[j..].starts_with("#apply-bibliography(") {
                Some("#apply-bibliography")
            } else {
                None
            };
            if let Some(prefix) = call_prefix {
                let call_start = j + prefix.len(); // points at '('
                if let Some(end) = find_balanced_paren_end(content, call_start) {
                    // Remove the call, its indentation and one trailing
                    // newline.
                    let mut after = end + 1;
                    if after < len && bytes[after] == b'\n' {
                        after += 1;
                    }
                    i = after;
                    continue;
                }
            }
        }

        // Copy the rest of the line as a slice; '\n' is one byte, so this stays
        // on char boundaries.
        let nl = content[i..].find('\n').map(|p| i + p + 1).unwrap_or(len);
        out.push_str(&content[i..nl]);
        i = nl;
    }
    out
}

/// Byte offset of the `)` closing the `(` at `paren_open`, skipping `"..."`
/// strings with `\` escapes. `None` if unbalanced.
fn find_balanced_paren_end(s: &str, paren_open: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    debug_assert_eq!(bytes.get(paren_open), Some(&b'('));
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    let mut i = paren_open;
    while i < bytes.len() {
        let c = bytes[i];
        if escape {
            escape = false;
            i += 1;
            continue;
        }
        if in_string {
            match c {
                b'\\' => escape = true,
                b'"' => in_string = false,
                _ => {}
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => in_string = true,
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Prepare a note for inlining: remove the package import, the leading
/// `#note(...)` call and any `#bibliography(...)` calls.
pub fn prepare_note_for_include(content: &str) -> String {
    let after_preamble = strip_note_preamble(content);
    strip_bibliography_call(after_preamble)
}

// ── Label collision detection ───────────────────────────────────────────────

/// Label declarations (`<name>`) in a note, found with Typst's parser so labels
/// in strings, comments and code don't count. Only used to catch collisions
/// that would break the merged document.
pub fn extract_label_decls(content: &str, note_stem: &str) -> Vec<LabelDecl> {
    use typst::syntax::{ast, parse, SyntaxKind, SyntaxNode};

    fn walk(node: &SyntaxNode, note_stem: &str, out: &mut Vec<LabelDecl>) {
        if node.kind() == SyntaxKind::Label {
            if let Some(label) = node.cast::<ast::Label>() {
                out.push(LabelDecl {
                    name: label.get().to_string(),
                    note_stem: note_stem.to_string(),
                });
            }
            return;
        }
        for child in node.children() {
            walk(child, note_stem, out);
        }
    }

    let mut out = Vec::new();
    walk(&parse(content), note_stem, &mut out);
    out
}

/// Labels declared in two or more notes. The generated `chap-<stem>` labels
/// aren't in the notes and aren't checked.
pub fn scan_label_collisions(notes: &[BookNote]) -> Vec<LabelCollision> {
    use std::collections::BTreeMap;
    let mut by_label: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for note in notes {
        for decl in extract_label_decls(&note.content, &note.stem) {
            // `<inkycap-*>` labels come from the package and repeat by design.
            if decl.name.starts_with("inkycap-") {
                continue;
            }
            by_label.entry(decl.name).or_default().push(decl.note_stem);
        }
    }
    by_label
        .into_iter()
        .filter(|(_, notes)| {
            // Only collisions between different notes; Typst reports a repeat
            // within one note itself.
            let mut uniq = notes.clone();
            uniq.sort();
            uniq.dedup();
            uniq.len() > 1
        })
        .map(|(label, notes)| {
            let mut uniq = notes;
            uniq.sort();
            uniq.dedup();
            LabelCollision { label, notes: uniq }
        })
        .collect()
}

// ── Heading normalization (PDF/UA) ─────────────────────────────────────────

/// Shift a note's headings so they nest under the level-1 chapter heading
/// without gaps, which PDF/UA-1 requires. The lowest level present becomes
/// `target_min` (usually 2) and gaps are closed: `=`, `===` at min 2 becomes
/// `==`, `===`.
///
/// Per CLAUDE.md's Typst-first principle, `set heading(offset: N)` was
/// considered: it can shift but not close gaps, which needs to know which
/// levels appear. The veraPDF test in `tests/verapdf_pdf_ua.rs` covers this.
pub fn normalize_heading_levels(body: &str, target_min: u8) -> String {
    // Typst decides which lines are headings, so `= Example` in a code block
    // isn't changed.
    let headings = source_structure::headings(body);
    if headings.is_empty() {
        return body.to_string();
    }

    // Map each level present to consecutive levels from `target_min`, which
    // both shifts and closes gaps.
    let mut levels_present: Vec<u8> = headings.iter().map(|h| h.level).collect();
    levels_present.sort_unstable();
    levels_present.dedup();
    let level_map: std::collections::HashMap<u8, u8> = levels_present
        .iter()
        .enumerate()
        .map(|(i, &level)| (level, target_min + i as u8))
        .collect();

    // Copy the source, replacing only each heading's `=` run.
    let mut out = String::with_capacity(body.len());
    let mut copied = 0usize;
    for heading in &headings {
        let Some(&new_level) = level_map.get(&heading.level) else {
            continue;
        };
        // Count the markers in the source, since `level` saturates at
        // `u8::MAX`. `=` is ASCII, so the count lands on a char boundary.
        let markers = body[heading.range.clone()]
            .bytes()
            .take_while(|&b| b == b'=')
            .count();
        out.push_str(&body[copied..heading.range.start]);
        for _ in 0..new_level {
            out.push('=');
        }
        copied = heading.range.start + markers;
    }
    out.push_str(&body[copied..]);
    out
}

// ── Chapter imports ─────────────────────────────────────────────────────────

/// Every package import in the chapters, once each, as `(wildcard, named)`
/// lines in the order first seen. A note's imports are cut from its chapter
/// (with its header) or from its body, so the book imports them itself.
fn chapter_package_imports(notes: &[BookNote]) -> (Vec<String>, Vec<String>) {
    let mut wildcard: Vec<String> = Vec::new();
    let mut named: Vec<String> = Vec::new();
    for note in notes {
        for import in crate::typst_pipeline::package_imports::package_imports(&note.content) {
            let (list, line) = if import.wildcard {
                let spec = crate::typst_packages::PackageSpec::parse(&import.spec)
                    .map(|p| p.canonical())
                    .unwrap_or(import.spec.clone());
                (&mut wildcard, format!("#import \"{spec}\": *"))
            } else {
                (&mut named, note.content[import.range.clone()].to_string())
            };
            if !list.contains(&line) {
                list.push(line);
            }
        }
    }
    (wildcard, named)
}

// ── Wrapper generation ──────────────────────────────────────────────────────

/// Build the book's Typst source, to pass to
/// [`crate::typst_pipeline::compiler::TypstCompiler::compile_pdf`]. The caller handles
/// collection `#set` rules, the bibliography path, the main path and writing the PDF,
/// so this stays a testable string transformation.
pub fn build_book_source(
    notes: &[BookNote],
    options: &BookExportOptions,
    style_rules: Option<&str>,
    // The collection's custom Typst, emitted after the template so it overrides
    // both the generated styles and the template.
    custom_typst: Option<&str>,
    template_import: Option<&str>,
    bibliography_path: Option<&str>,
    bibliography_style: Option<&str>,
    // When true, normalize each note's heading levels so they nest under
    // the chapter h1 without gaps. Required for PDF/UA-1 compliance.
    normalize_headings: bool,
    // Page-numbering pattern from Style Overrides (e.g. "1", "Page 1", "-- 1
    // --") for the body. With RomanThenArabic, the front matter uses its roman
    // form. Defaults to "1".
    body_page_numbering_pattern: Option<&str>,
    // Heading-numbering pattern from Style Overrides (e.g. "1.1", "I.A.1").
    // "none" disables chapter numbering; unset defaults to "1.1".
    heading_numbering_pattern: Option<&str>,
) -> String {
    let mut s = String::with_capacity(8 * 1024);

    // Imports. The collection's template and the chapters' `*` package imports
    // go above the notebox import, so none of them can replace InkyCap's own
    // functions (a later import wins); chapters' named imports go below it.
    // Chapter bodies lose their imports (see the chapter loop), so each is
    // imported once for the whole book.
    if let Some(import_line) = template_import {
        s.push_str(import_line);
        if !import_line.ends_with('\n') {
            s.push('\n');
        }
    }
    let (wildcard_imports, named_imports) = chapter_package_imports(notes);
    for line in &wildcard_imports {
        s.push_str(line);
        s.push('\n');
    }
    s.push_str(&crate::notebox_package::import_line());
    s.push('\n');
    for line in &named_imports {
        s.push_str(line);
        s.push('\n');
    }

    // Document title and author, required for PDF/UA-1 (Typst refuses an export
    // without a title). The date is added by
    // `ensure_document_date_for_standard` in the export pipeline.
    let mut doc_args: Vec<String> = Vec::new();
    if let Some(title) = &options.title {
        doc_args.push(format!("title: \"{}\"", typst_escape(title)));
    }
    // Authors from the contributor roster, else the single `author` string: a
    // string for one, an array for several.
    let authors =
        contributors::document_author_names(&options.contributors, options.author.as_deref());
    match authors.len() {
        0 => {}
        1 => doc_args.push(format!("author: \"{}\"", typst_escape(&authors[0]))),
        _ => {
            let list = authors
                .iter()
                .map(|a| format!("\"{}\"", typst_escape(a)))
                .collect::<Vec<_>>()
                .join(", ");
            doc_args.push(format!("author: ({list})"));
        }
    }
    if !doc_args.is_empty() {
        s.push_str(&format!("#set document({})\n", doc_args.join(", ")));
    }

    // Inform the notebox package we're in a merged-book compile, so the
    // `wikilink` function can resolve internally / strip / fall through.
    let mode_str = match options.wikilink_mode {
        BookWikilinkMode::Internal => "internal",
        BookWikilinkMode::External => "external",
        BookWikilinkMode::Plain => "plain",
    };
    let stems: Vec<String> = notes
        .iter()
        .map(|n| format!("\"{}\"", typst_escape(&n.stem)))
        .collect();
    // A one-element array needs a trailing comma: `("x")` is just a string.
    let chapters_array = match stems.len() {
        1 => format!("{},", stems[0]),
        _ => stems.join(", "),
    };
    s.push_str(&format!(
        "#set-merged-context(active: true, mode: \"{}\", chapters: ({}))\n",
        mode_str, chapters_array
    ));

    // Style rules and chapter numbering. These come before any template show
    // rule so that `#show: template` can override anything it cares about.
    if let Some(rules) = style_rules {
        if !rules.trim().is_empty() {
            s.push_str(rules);
            if !rules.ends_with('\n') {
                s.push('\n');
            }
        }
    }
    // Chapter numbering comes only from the collection's heading numbering
    // style: unset (Inherit) means "1.1", "none" disables it, anything else is
    // the pattern.
    let heading_pattern = match heading_numbering_pattern.map(str::trim) {
        Some("none") => None,
        Some(p) if !p.is_empty() => Some(p),
        _ => Some("1.1"),
    };
    if let Some(pattern) = heading_pattern {
        s.push_str(&format!(
            "#set heading(numbering: \"{}\")\n",
            typst_escape(pattern)
        ));
    }

    // The collection's custom Typst, after the template so its rules win. The
    // last styling before page numbering and the chapters.
    if let Some(custom) = custom_typst {
        if !custom.trim().is_empty() {
            s.push_str(custom);
            if !custom.ends_with('\n') {
                s.push('\n');
            }
        }
    }

    // The Style Overrides page-numbering pattern is used for the body, and its
    // roman form for the front matter with `RomanThenArabic`. Defaults to
    // arabic.
    let body_pattern = body_page_numbering_pattern.unwrap_or("1");
    let roman_pattern = to_roman_pattern(body_pattern);

    // ── Front matter page numbering ────────────────────────────────────────
    match options.page_numbering {
        BookPageNumbering::Arabic => {
            s.push_str(&format!(
                "#set page(numbering: \"{}\")\n",
                typst_escape(body_pattern)
            ));
        }
        BookPageNumbering::ArabicFromChapters | BookPageNumbering::ArabicFromPage { .. } => {
            s.push_str("#set page(numbering: none)\n");
        }
        BookPageNumbering::RomanThenArabic => {
            s.push_str(&format!(
                "#set page(numbering: \"{}\")\n",
                typst_escape(&roman_pattern)
            ));
        }
    }

    // Title page, controlled only by the user's setting. A template applied
    // through Custom Typst can't be detected here, so if it draws its own title
    // block the user turns this off.
    if options.include_title_page {
        s.push_str(&render_title_page(options));
    }

    // Abstract.
    if let Some(abstract_text) = &options.abstract_text {
        if !abstract_text.trim().is_empty() {
            s.push_str("#heading(level: 1, numbering: none, outlined: false)[Abstract]\n");
            s.push_str(abstract_text);
            if !abstract_text.ends_with('\n') {
                s.push('\n');
            }
            s.push_str("#pagebreak()\n");
        }
    }

    // Where the table of contents goes; it always covers the whole document. An
    // `AfterChapter` anchor not in the export falls back to `Beginning`. Only a
    // `Beginning` table of contents takes front-matter page numbering.
    enum TocSpot<'a> {
        None,
        Beginning,
        AfterChapter(&'a str),
        End,
    }
    let toc_spot = if !options.include_outline {
        TocSpot::None
    } else {
        match &options.toc_placement {
            TocPlacement::Beginning => TocSpot::Beginning,
            TocPlacement::End => TocSpot::End,
            TocPlacement::AfterChapter { stem } => {
                if notes.iter().any(|n| &n.stem == stem) {
                    TocSpot::AfterChapter(stem.as_str())
                } else {
                    TocSpot::Beginning
                }
            }
        }
    };
    // `outline-with-bare-page-numbers` (in the package) keeps decorated page
    // patterns ("Page 1 of N") out of the table of contents.
    let outline_call = || {
        format!(
            "#outline-with-bare-page-numbers(depth: {})\n",
            options.toc_depth
        )
    };

    // Outline at the front (the default). The trailing hard pagebreak starts
    // the first chapter on a fresh page.
    if matches!(toc_spot, TocSpot::Beginning) {
        s.push_str(&outline_call());
        s.push_str("#pagebreak()\n");
    }

    // ── Body page numbering ────────────────────────────────────────────────
    match options.page_numbering {
        BookPageNumbering::Arabic => {
            // Already in body pattern from front-matter switch; nothing
            // to do.
        }
        BookPageNumbering::ArabicFromChapters | BookPageNumbering::RomanThenArabic => {
            s.push_str(&format!(
                "#set page(numbering: \"{}\")\n",
                typst_escape(body_pattern)
            ));
            s.push_str("#counter(page).update(1)\n");
        }
        BookPageNumbering::ArabicFromPage { start_page } => {
            // Arabic numbering starts at `start_page`, using the package's
            // `make-offset-numbering`.
            let start = start_page.max(1);
            s.push_str(&format!(
                "#set page(numbering: make-offset-numbering({start}))\n"
            ));
        }
    }

    // ── Chapters ───────────────────────────────────────────────────────────
    for (idx, note) in notes.iter().enumerate() {
        if idx > 0 {
            s.push_str("#pagebreak(weak: true)\n");
        }

        // `Unified` and `PerChapter` remove every per-note `#bibliography(...)`
        // and emit their own; `InPlace` keeps them (Typst 0.15 allows several).
        // The import and `#note(...)` call are always removed.
        let raw_body = match options.bibliography_mode {
            BibliographyMode::Unified | BibliographyMode::PerChapter => {
                prepare_note_for_include(&note.content)
            }
            BibliographyMode::InPlace => strip_note_preamble(&note.content).to_string(),
        };
        let raw_body =
            crate::typst_pipeline::note_package_edits::without_package_imports(&raw_body);
        let body = if normalize_headings {
            normalize_heading_levels(&raw_body, 2)
        } else {
            raw_body
        };
        let starts_with_heading = body
            .trim_start()
            .lines()
            .next()
            .map(|l| l.trim_start().starts_with('=') && !l.trim_start().starts_with("=="))
            .unwrap_or(false);

        let inject = match options.inject_chapter_heading {
            InjectChapterHeading::Always => true,
            InjectChapterHeading::Never => false,
            InjectChapterHeading::Fallback => !starts_with_heading,
        };

        // Chapter anchor for wikilinks, at the chapter top. The package's
        // `chapter-anchor` builds the label with `label()`, since note names
        // often contain spaces or parentheses that a literal `<...>` label
        // can't.
        s.push_str(&chapter_anchor_call(&note.stem));

        if inject {
            let title = note
                .title
                .clone()
                .unwrap_or_else(|| humanize_stem(&note.stem));
            s.push_str(&format!("= {}\n", escape_typst_markup(&title)));
        }

        s.push_str(&body);
        if !body.ends_with('\n') {
            s.push('\n');
        }

        // PerChapter: this chapter's bibliography, covering citations up to the
        // next chapter's anchor (`next-stem: none` for the last chapter).
        if options.bibliography_mode == BibliographyMode::PerChapter {
            if let Some(path) = bibliography_path {
                let next_stem = notes.get(idx + 1).map(|n| n.stem.as_str());
                s.push_str(&chapter_bibliography_call(
                    path,
                    &note.stem,
                    next_stem,
                    bibliography_style,
                ));
            }
        }

        // Table of contents after this chapter, on its own page; the next
        // chapter (or the bibliography) adds its own break.
        if matches!(toc_spot, TocSpot::AfterChapter(st) if st == note.stem.as_str()) {
            s.push_str("#pagebreak(weak: true)\n");
            s.push_str(&outline_call());
        }
    }

    // ToC at the very end — after the final chapter, before the bibliography.
    if matches!(toc_spot, TocSpot::End) {
        s.push_str("#pagebreak(weak: true)\n");
        s.push_str(&outline_call());
    }

    // ── Bibliography ───────────────────────────────────────────────────────
    // Only `Unified` emits a consolidated bibliography here.
    if options.bibliography_mode == BibliographyMode::Unified {
        if let Some(path) = bibliography_path {
            s.push_str("#pagebreak(weak: true)\n");
            // Through the package's `apply-bibliography`, as for single notes.
            match bibliography_style {
                Some(style) => s.push_str(&format!(
                    "#apply-bibliography(\"{}\", style: \"{}\")\n",
                    typst_escape(path),
                    typst_escape(style)
                )),
                None => s.push_str(&format!(
                    "#apply-bibliography(\"{}\")\n",
                    typst_escape(path)
                )),
            }
        }
    }

    s
}

/// Render the default title page used when no template is set.
fn render_title_page(options: &BookExportOptions) -> String {
    let mut s = String::new();
    s.push_str("#align(center + horizon)[\n");

    if let Some(title) = &options.title {
        s.push_str(&format!(
            "  #text(size: 2em, weight: \"bold\")[{}]\n",
            escape_typst_markup(title)
        ));
    }
    if let Some(subtitle) = &options.subtitle {
        s.push_str("  #v(0.5em)\n");
        s.push_str(&format!(
            "  #text(size: 1.4em)[{}]\n",
            escape_typst_markup(subtitle)
        ));
    }
    // Byline: the contributor roster (grouped by bibliographic role) when
    // present, else the legacy single-author line.
    let byline = contributors::byline_call(&options.contributors);
    let has_byline = byline.is_some() || options.author.is_some();
    if has_byline || options.date.is_some() {
        s.push_str("  #v(2em)\n");
    }
    if let Some(call) = &byline {
        s.push_str("  ");
        s.push_str(call); // already newline-terminated
    } else if let Some(author) = &options.author {
        s.push_str(&format!(
            "  #text(size: 1.1em)[{}]\\ \n",
            escape_typst_markup(author)
        ));
    }
    if let Some(date) = &options.date {
        s.push_str(&format!("  {}\n", escape_typst_markup(date)));
    }
    s.push_str("]\n#pagebreak()\n");

    // CRediT contributions statement on its own page (after the centred
    // title block), when enabled and any contributor carries CRediT roles.
    if options.include_credit_statement {
        if let Some(call) = contributors::credit_statement_call(&options.contributors) {
            s.push_str(&call); // newline-terminated
            s.push_str("#pagebreak()\n");
        }
    }
    s
}

/// Escape a string for safe interpolation into a Typst quoted string literal.
pub(crate) fn typst_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// The roman form of a page-numbering pattern: every `1` becomes `i` (`"Page 1
/// of 1"` → `"Page i of i"`). `a` / `A` are left alone because they appear in
/// ordinary text ("Page" would become "Pige"). Without a `1`, the pattern is
/// unchanged.
fn to_roman_pattern(pattern: &str) -> String {
    if !pattern.contains('1') {
        return pattern.to_string();
    }
    pattern.replace('1', "i")
}

/// The marker emitted at each chapter's start, also used to map an error's
/// offset back to its note ([`chapter_at_offset`]).
const CHAPTER_ANCHOR_PREFIX: &str = "#chapter-anchor(\"";

/// The `#chapter-anchor("<stem>")` call emitted at a chapter's start. The
/// stem is escaped for a Typst string literal.
fn chapter_anchor_call(stem: &str) -> String {
    format!("{}{}\")\n", CHAPTER_ANCHOR_PREFIX, typst_escape(stem))
}

/// The `#chapter-bibliography(...)` call at the end of a chapter in
/// `PerChapter` mode. The package builds the selector; this passes the path,
/// this chapter's stem, the next one's (omitted for the last chapter) and an
/// optional style.
fn chapter_bibliography_call(
    path: &str,
    stem: &str,
    next_stem: Option<&str>,
    style: Option<&str>,
) -> String {
    let mut call = format!(
        "#chapter-bibliography(\"{}\", \"{}\"",
        typst_escape(path),
        typst_escape(stem)
    );
    if let Some(next) = next_stem {
        call.push_str(&format!(", next-stem: \"{}\"", typst_escape(next)));
    }
    if let Some(style) = style {
        call.push_str(&format!(", style: \"{}\"", typst_escape(style)));
    }
    call.push_str(")\n");
    call
}

/// The string argument of the first `bibliography("…")` call (e.g. in a
/// template's `#show:` rule), the path a collection export should generate.
/// Skips commented lines and non-string arguments. `None` when absent.
pub fn extract_bibliography_path(source: &str) -> Option<String> {
    const NEEDLE: &str = "bibliography(";
    let mut search = 0usize;
    while let Some(rel) = source[search..].find(NEEDLE) {
        let at = search + rel;
        let line_start = source[..at].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let commented = source[line_start..at].trim_start().starts_with("//");
        let after = source[at + NEEDLE.len()..].trim_start();
        if !commented {
            if let Some(rest) = after.strip_prefix('"') {
                if let Some(path) = read_typst_string_body(rest) {
                    return Some(path);
                }
            }
        }
        search = at + NEEDLE.len();
    }
    None
}

/// Read a Typst string body up to its closing `"`, unescaping `\"` and `\\`.
/// `s` starts after the opening quote. `None` if unterminated.
fn read_typst_string_body(s: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.push(chars.next()?),
            '"' => return Some(out),
            _ => out.push(c),
        }
    }
    None
}

/// The stem of the chapter containing a byte offset in the book source, found
/// from the `#chapter-anchor("<stem>")` markers. `None` in the front matter.
pub fn chapter_at_offset(source: &str, offset: usize) -> Option<String> {
    let mut current = None;
    let mut search = 0usize;
    while let Some(rel) = source[search..].find(CHAPTER_ANCHOR_PREFIX) {
        let anchor_at = search + rel;
        if anchor_at > offset {
            break; // this chapter begins after the target offset
        }
        let stem_start = anchor_at + CHAPTER_ANCHOR_PREFIX.len();
        if let Some(stem) = read_typst_string_body(&source[stem_start..]) {
            current = Some(stem);
        }
        search = stem_start;
    }
    current
}

/// A message for a failed book export naming the note each error came from,
/// grouped by chapter (see [`chapter_at_offset`]) with duplicates merged.
/// Errors in imported files and front matter get their own groups.
pub fn describe_book_diagnostics(
    source: &str,
    diagnostics: &[TypstDiagnostic],
    bib_path: Option<&str>,
) -> String {
    // (label, ordered-unique messages), preserving first-seen label order.
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for d in diagnostics.iter().filter(|d| d.severity == "error") {
        let label = match &d.primary {
            Some(p) if p.is_main => chapter_at_offset(source, p.start)
                .map(|stem| format!("\"{stem}\""))
                .unwrap_or_else(|| "the book front matter".to_string()),
            Some(_) => "an imported file".to_string(),
            None => "the book".to_string(),
        };
        let entry = match groups.iter_mut().find(|(l, _)| *l == label) {
            Some(e) => &mut e.1,
            None => {
                groups.push((label, Vec::new()));
                &mut groups.last_mut().unwrap().1
            }
        };
        if !entry.contains(&d.message) {
            entry.push(d.message.clone());
        }
    }

    let base = if groups.is_empty() {
        "compilation failed".to_string()
    } else {
        let parts: Vec<String> = groups
            .iter()
            .map(|(label, msgs)| format!("In {label}: {}.", msgs.join("; ")))
            .collect();
        format!("compilation failed. {}", parts.join(" "))
    };

    // hayagriva's bibliography errors ("expected comma") name neither file nor
    // cause, so point at the bib file and the usual culprit.
    let has_bib_parse_error = diagnostics.iter().any(|d| {
        let m = d.message.to_lowercase();
        m.contains("biblatex") || m.contains("bibtex")
    });
    if has_bib_parse_error {
        let where_ = bib_path.map(|p| format!(" ({p})")).unwrap_or_default();
        return format!(
            "{base} The bibliography file{where_} couldn't be parsed — check it for a \
             malformed entry, for example an `@article{{` line missing its citation key \
             (it should read `@article{{key,`).",
        );
    }
    base
}

/// Stems of the chapters with compile errors, in order, without duplicates.
/// Only errors inside a chapter count; front-matter, package and span-less
/// errors can't be fixed by dropping a note. Used to offer "continue, excluding
/// these notes" (see [`describe_book_diagnostics`]).
pub fn book_diagnostic_note_stems(source: &str, diagnostics: &[TypstDiagnostic]) -> Vec<String> {
    let mut stems: Vec<String> = Vec::new();
    for d in diagnostics.iter().filter(|d| d.severity == "error") {
        if let Some(p) = &d.primary {
            if p.is_main {
                if let Some(stem) = chapter_at_offset(source, p.start) {
                    if !stems.contains(&stem) {
                        stems.push(stem);
                    }
                }
            }
        }
    }
    stems
}

/// Escape text for Typst markup (backslashes and markup characters), so a title
/// like `# C* algebras` stays literal.
pub(crate) fn escape_typst_markup(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' | '*' | '_' | '`' | '#' | '$' | '~' | '<' | '>' | '@' | '[' | ']' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// Convert a note file stem like `quantum-mechanics_intro` into a readable
/// chapter title fallback when the note has no `title` property.
fn humanize_stem(stem: &str) -> String {
    let words: Vec<String> = stem
        .split(['-', '_', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect();
    if words.is_empty() {
        stem.to_string()
    } else {
        words.join(" ")
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    // ── Heading normalization ──────────────────────────────────────────────

    #[test]
    fn normalize_heading_levels_shifts_and_compresses() {
        // `=` and `===` targeted at min 2 become `==` and `===`: shifted down
        // to sit under the chapter heading, with the skipped level closed up.
        assert_eq!(
            normalize_heading_levels("= Top\n\nbody\n\n=== Deep\n", 2),
            "== Top\n\nbody\n\n=== Deep\n"
        );
    }

    #[test]
    fn normalize_heading_levels_leaves_a_code_sample_alone() {
        // Issue #21: `= Not a headliner` inside a fence is raw text. Rewriting
        // its markers would corrupt the author's code sample in the book.
        let body = "= Chapter\n\n```typ\n= Example heading\n```\n\n=== Deep\n";
        assert_eq!(
            normalize_heading_levels(body, 2),
            "== Chapter\n\n```typ\n= Example heading\n```\n\n=== Deep\n"
        );
    }

    #[test]
    fn normalize_heading_levels_copies_everything_else_byte_for_byte() {
        // Indentation, CRLF endings and the trailing newline all survive,
        // because the rewrite splices markers rather than re-joining lines.
        let body = "= A\r\n\r\n- item\r\n\r\n  == Indented\r\n";
        assert_eq!(
            normalize_heading_levels(body, 2),
            "== A\r\n\r\n- item\r\n\r\n  === Indented\r\n"
        );
    }

    #[test]
    fn normalize_heading_levels_returns_a_body_without_headings_unchanged() {
        assert_eq!(normalize_heading_levels("just prose\n", 2), "just prose\n");
        assert_eq!(normalize_heading_levels("", 2), "");
    }

    use super::*;

    fn note(stem: &str, content: &str) -> BookNote {
        BookNote {
            stem: stem.to_string(),
            abs_path: PathBuf::from(format!("/notebox/{}.typ", stem)),
            content: content.to_string(),
            title: None,
        }
    }

    #[test]
    fn strip_bibliography_removes_simple_call() {
        let src = "Body text\n#bibliography(\"refs.bib\")\nMore text\n";
        let out = strip_bibliography_call(src);
        assert_eq!(out, "Body text\nMore text\n");
    }

    #[test]
    fn strip_bibliography_handles_multiline_args() {
        let src = "intro\n#bibliography(\n  \"refs.bib\",\n  style: \"ieee\",\n)\nafter\n";
        let out = strip_bibliography_call(src);
        assert_eq!(out, "intro\nafter\n");
    }

    #[test]
    fn strip_bibliography_ignores_inside_string() {
        // A literal #bibliography( inside a code string must not be stripped.
        let src = "Some text containing \"#bibliography(\" inside a string.\n";
        let out = strip_bibliography_call(src);
        assert_eq!(out, src);
    }

    #[test]
    fn strip_bibliography_keeps_other_content() {
        let src = "= Heading\n\nA paragraph.\n";
        assert_eq!(strip_bibliography_call(src), src);
    }

    #[test]
    fn strip_bibliography_preserves_utf8_content() {
        // Multi-byte characters must pass through unchanged.
        let src = "Some text — with “smart quotes”, an é, and PMBOK®.\n#bibliography(\"refs.bib\")\nMore — text.\n";
        let out = strip_bibliography_call(src);
        assert_eq!(
            out,
            "Some text — with “smart quotes”, an é, and PMBOK®.\nMore — text.\n"
        );
    }

    /// Representative non-ASCII content: dashes, smart quotes, accented Latin,
    /// Arabic, Hebrew, CJK, Cyrillic, Devanagari, emoji and combining marks.
    /// Test new string helpers in this module against these.
    const UNICODE_BODY_FIXTURES: &[&str] = &[
        "Em-dash — en-dash – ellipsis…",
        "“Smart quotes” and ‘apostrophes’",
        "Café résumé naïve coöperate Montréal",
        "هذه فقرة عربية قصيرة.",
        "שלום עולם",
        "你好世界 — 早安",
        "こんにちは、世界！",
        "Привет, мир — добро пожаловать!",
        "नमस्ते दुनिया",
        "Family emoji: 👨‍👩‍👧‍👦 and flags: 🇨🇦🇫🇷",
        "Combining marks: e\u{0301} (é) vs é (precomposed)",
    ];

    #[test]
    fn strip_bibliography_is_identity_on_unicode_without_call() {
        // No `#bibliography(...)` to strip — every fixture must round-trip
        // byte-identical.
        for fixture in UNICODE_BODY_FIXTURES {
            let body = format!("Before line.\n{}\nAfter line.\n", fixture);
            let out = strip_bibliography_call(&body);
            assert_eq!(out, body, "fixture changed: {:?}", fixture);
        }
    }

    #[test]
    fn strip_bibliography_preserves_unicode_around_call() {
        // Unicode content surrounding the stripped bibliography must
        // survive byte-identical.
        for fixture in UNICODE_BODY_FIXTURES {
            let body = format!(
                "Before — {}\n#bibliography(\"refs.bib\")\nAfter — {}\n",
                fixture, fixture
            );
            let expected = format!("Before — {}\nAfter — {}\n", fixture, fixture);
            let out = strip_bibliography_call(&body);
            assert_eq!(out, expected, "fixture changed: {:?}", fixture);
        }
    }

    #[test]
    fn prepare_note_for_include_preserves_unicode() {
        // Full preprocessor — preamble strip + bibliography strip — must
        // not corrupt any of the multi-byte content.
        for fixture in UNICODE_BODY_FIXTURES {
            let src = format!(
                "#import \"/.inkycap/notebox.typ\": *\n\
                 #note(title: \"Title\")\n\
                 = Heading\n\
                 {}\n\
                 #bibliography(\"refs.bib\")\n",
                fixture
            );
            let out = prepare_note_for_include(&src);
            assert!(
                out.contains(fixture),
                "fixture missing from output: {:?}",
                fixture
            );
            assert!(!out.contains("#import"));
            assert!(!out.contains("#note("));
            assert!(!out.contains("#bibliography"));
        }
    }

    #[test]
    fn extract_label_decls_handles_unicode() {
        // Labels are ASCII, but the text around them may not be.
        for fixture in UNICODE_BODY_FIXTURES {
            let src = format!("{}\n= Heading <intro>\n{}\n", fixture, fixture);
            let labels = extract_label_decls(&src, "note-a");
            assert_eq!(labels.len(), 1, "fixture: {:?}", fixture);
            assert_eq!(labels[0].name, "intro");
        }
    }

    #[test]
    fn prepare_note_strips_preamble_and_bibliography() {
        let src = r#"#import "/.inkycap/notebox.typ": *
#note(title: "Foo")

= Heading
Body
#bibliography("refs.bib")
After
"#;
        let out = prepare_note_for_include(src);
        assert!(!out.contains("#import"));
        assert!(!out.contains("#note("));
        assert!(!out.contains("#bibliography"));
        assert!(out.contains("= Heading"));
        assert!(out.contains("After"));
    }

    #[test]
    fn extract_labels_finds_basic_decls() {
        let labels = extract_label_decls("= Intro <intro>\nSee @intro.\n", "a");
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].name, "intro");
    }

    #[test]
    fn extract_labels_skips_inkycap_internal() {
        // `<inkycap-note>` is still extracted; the collision check skips it.
        let labels = extract_label_decls("#metadata((x: 1)) <inkycap-note>\n", "a");
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].name, "inkycap-note");
    }

    #[test]
    fn extract_labels_skips_string_contents() {
        let labels = extract_label_decls("#text(\"<not-a-label>\")\n", "a");
        assert!(labels.is_empty());
    }

    #[test]
    fn extract_labels_skips_code_samples_and_comments() {
        // Placeholders such as `<label>` in a manual's inline code or fenced
        // code blocks describe syntax; they must not count as declarations.
        let src = "Write `#link(<label>)[text]` to link.\n\
                   ```typ\n= Heading <label>\n```\n\
                   // a comment mentioning <label>\n\
                   = Real <real>\n";
        let labels = extract_label_decls(src, "a");
        let names: Vec<&str> = labels.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, vec!["real"]);
    }

    #[test]
    fn scan_label_collisions_detects_dupes() {
        let notes = vec![
            note("alpha", "= A <intro>"),
            note("beta", "= B <intro>"),
            note("gamma", "= C <other>"),
        ];
        let collisions = scan_label_collisions(&notes);
        assert_eq!(collisions.len(), 1);
        assert_eq!(collisions[0].label, "intro");
        assert_eq!(collisions[0].notes, vec!["alpha", "beta"]);
    }

    #[test]
    fn scan_label_collisions_ignores_inkycap_internal() {
        let notes = vec![
            note("alpha", "#metadata(()) <inkycap-note>"),
            note("beta", "#metadata(()) <inkycap-note>"),
        ];
        let collisions = scan_label_collisions(&notes);
        assert!(collisions.is_empty());
    }

    fn options() -> BookExportOptions {
        BookExportOptions::from_config(None)
    }

    #[test]
    fn package_imports_are_gathered_at_the_top_of_the_book() {
        let header = "#import \"/.inkycap/notebox.typ\": *";
        let notes = vec![
            note(
                "alpha",
                &format!(
                    "#import \"@preview/example-drawing:1.0.0\": *\n{header}\n#note()\n= Alpha\nA #drawing(r)\n"
                ),
            ),
            note(
                "beta",
                &format!(
                    "{header}\n#note()\n= Beta\n#import \"@preview/example-drawing:1.0.0\": *\n\
                     #import \"@preview/example-notes:1.0.0\": note as example-notes-note\nB\n"
                ),
            ),
        ];
        let src = build_book_source(
            &notes,
            &options(),
            None,
            None,
            Some("#import \"@preview/example-book:1.0.0\": *"),
            None,
            None,
            false,
            None,
            None,
        );
        let top = format!(
            "#import \"@preview/example-book:1.0.0\": *\n#import \"@preview/example-drawing:1.0.0\": *\n{header}\n\
             #import \"@preview/example-notes:1.0.0\": note as example-notes-note\n"
        );
        assert!(src.starts_with(&top), "{src}");
        assert_eq!(src.matches("@preview/example-drawing").count(), 1, "{src}");
        assert_eq!(src.matches("@preview/example-notes").count(), 1, "{src}");
        assert!(src.contains("A #drawing(r)"));
    }

    #[test]
    fn build_book_emits_one_bibliography() {
        let notes = vec![
            note("alpha", "#import \"/.inkycap/notebox.typ\": *\n#note()\n= Alpha\nA"),
            note("beta",  "#import \"/.inkycap/notebox.typ\": *\n#note()\n= Beta\nB\n#bibliography(\"refs.bib\")"),
        ];
        let src = build_book_source(
            &notes,
            &options(),
            None,
            None,
            None,
            Some("refs.bib"),
            Some("ieee"),
            false,
            None,
            None,
        );
        // One `#apply-bibliography(...)` from the wrapper; the chapters' own
        // are removed.
        assert_eq!(
            src.matches("#apply-bibliography(").count(),
            1,
            "expected exactly one wrapper bibliography call, got source:\n{}",
            src
        );
        assert_eq!(
            src.matches("#bibliography(").count(),
            0,
            "expected user-written #bibliography(...) to be stripped, got source:\n{}",
            src
        );
    }

    #[test]
    fn toc_placement_beginning_is_default_front_matter() {
        // Default placement is Beginning — the outline precedes the chapters.
        let opts = options();
        let notes = vec![note(
            "alpha",
            "#import \"/x\": *\n#note()\n= Alpha\nAlpha body",
        )];
        let src = build_book_source(
            &notes, &opts, None, None, None, None, None, false, None, None,
        );
        let toc = src.find("#outline-with-bare-page-numbers").unwrap();
        let body = src.find("Alpha body").unwrap();
        assert!(
            toc < body,
            "default ToC sits in front matter; source:\n{src}"
        );
    }

    #[test]
    fn toc_placement_end_puts_outline_after_chapters() {
        let mut opts = options();
        opts.toc_placement = TocPlacement::End;
        let notes = vec![
            note("alpha", "#import \"/x\": *\n#note()\n= Alpha\nAlpha body"),
            note("beta", "#import \"/x\": *\n#note()\n= Beta\nBeta body"),
        ];
        let src = build_book_source(
            &notes, &opts, None, None, None, None, None, false, None, None,
        );
        let toc = src
            .find("#outline-with-bare-page-numbers")
            .expect("outline present");
        let last_body = src.find("Beta body").expect("last chapter body present");
        assert!(
            toc > last_body,
            "End placement puts the ToC after the final chapter; source:\n{src}"
        );
    }

    #[test]
    fn toc_placement_after_chapter_sits_between_chapters() {
        let mut opts = options();
        opts.toc_placement = TocPlacement::AfterChapter {
            stem: "alpha".into(),
        };
        let notes = vec![
            note("alpha", "#import \"/x\": *\n#note()\n= Alpha\nAlpha body"),
            note("beta", "#import \"/x\": *\n#note()\n= Beta\nBeta body"),
        ];
        let src = build_book_source(
            &notes, &opts, None, None, None, None, None, false, None, None,
        );
        let a = src.find("Alpha body").unwrap();
        let toc = src.find("#outline-with-bare-page-numbers").unwrap();
        let b = src.find("Beta body").unwrap();
        assert!(
            a < toc && toc < b,
            "ToC anchored after 'alpha' sits between the two chapters; source:\n{src}"
        );
    }

    #[test]
    fn toc_placement_after_missing_chapter_falls_back_to_beginning() {
        let mut opts = options();
        opts.toc_placement = TocPlacement::AfterChapter {
            stem: "ghost".into(),
        };
        let notes = vec![note(
            "alpha",
            "#import \"/x\": *\n#note()\n= Alpha\nAlpha body",
        )];
        let src = build_book_source(
            &notes, &opts, None, None, None, None, None, false, None, None,
        );
        let toc = src.find("#outline-with-bare-page-numbers").unwrap();
        let body = src.find("Alpha body").unwrap();
        assert!(
            toc < body,
            "an anchor stem not in the book falls back to front matter; source:\n{src}"
        );
    }

    #[test]
    fn in_place_bibliography_mode_keeps_per_note_calls() {
        let mut opts = options();
        opts.bibliography_mode = BibliographyMode::InPlace;
        let notes = vec![note(
            "alpha",
            "#import \"/x\": *\n#note()\n= Alpha\nA\n#bibliography(\"refs.bib\")",
        )];
        // InPlace emits no consolidated bibliography and keeps the note's own.
        let src = build_book_source(
            &notes,
            &opts,
            None,
            None,
            None,
            Some("refs.bib"),
            Some("ieee"),
            false,
            None,
            None,
        );
        assert_eq!(
            src.matches("#apply-bibliography(").count(),
            0,
            "no consolidated bibliography in place mode; source:\n{src}"
        );
        assert_eq!(
            src.matches("#bibliography(").count(),
            1,
            "the note's own bibliography is preserved; source:\n{src}"
        );
    }

    #[test]
    fn per_chapter_mode_emits_scoped_bibliography_per_chapter() {
        let mut opts = options();
        opts.bibliography_mode = BibliographyMode::PerChapter;
        let notes = vec![
            note("alpha", "#import \"/x\": *\n#note()\n= Alpha\nSee @aaa.\n"),
            note("beta", "#import \"/x\": *\n#note()\n= Beta\nSee @bbb.\n"),
        ];
        let src = build_book_source(
            &notes,
            &opts,
            None,
            None,
            None,
            Some("/refs.bib"),
            Some("ieee"),
            false,
            None,
            None,
        );
        // One scoped call per chapter; no consolidated bibliography.
        assert_eq!(
            src.matches("#chapter-bibliography(").count(),
            2,
            "expected one scoped bibliography per chapter; source:\n{src}"
        );
        assert_eq!(
            src.matches("#apply-bibliography(").count(),
            0,
            "PerChapter must not emit a consolidated bibliography; source:\n{src}"
        );
        // First chapter bounds its scope with the next stem; last chapter omits
        // next-stem so its scope runs to the document end.
        assert!(
            src.contains("#chapter-bibliography(\"/refs.bib\", \"alpha\", next-stem: \"beta\", style: \"ieee\")"),
            "first chapter's scoped call missing/incorrect; source:\n{src}"
        );
        assert!(
            src.contains("#chapter-bibliography(\"/refs.bib\", \"beta\", style: \"ieee\")"),
            "last chapter's call should omit next-stem; source:\n{src}"
        );
    }

    #[test]
    fn build_book_injects_heading_when_missing() {
        let mut opts = options();
        opts.inject_chapter_heading = InjectChapterHeading::Fallback;
        let mut n = note("methods", "Body without heading.\n");
        n.title = Some("Methods".to_string());
        let src = build_book_source(&[n], &opts, None, None, None, None, None, false, None, None);
        // Anchor is emitted via the package function (label()-based, so
        // space/paren stems survive), and the heading is injected separately.
        assert!(src.contains("#chapter-anchor(\"methods\")"));
        assert!(src.contains("= Methods"));
    }

    #[test]
    fn build_book_skips_injection_when_note_has_heading() {
        let mut opts = options();
        opts.inject_chapter_heading = InjectChapterHeading::Fallback;
        let mut n = note("intro", "= Introduction\nBody.\n");
        n.title = Some("Introduction".to_string());
        let src = build_book_source(&[n], &opts, None, None, None, None, None, false, None, None);
        // No heading is added when the note has one, so `= Introduction`
        // appears once. The anchor is still emitted.
        assert!(src.contains("#chapter-anchor(\"intro\")"));
        assert_eq!(
            src.matches("= Introduction").count(),
            1,
            "no second (injected) heading; source:\n{src}"
        );
    }

    #[test]
    fn build_book_always_injects_heading_when_set() {
        let mut opts = options();
        opts.inject_chapter_heading = InjectChapterHeading::Always;
        let mut n = note("intro", "= Author's Heading\nBody.\n");
        n.title = Some("Introduction".to_string());
        let src = build_book_source(&[n], &opts, None, None, None, None, None, false, None, None);
        assert!(src.contains("#chapter-anchor(\"intro\")"));
        // Always-inject adds the title heading even though the note has its
        // own different heading.
        assert!(src.contains("= Introduction"));
    }

    #[test]
    fn chapter_at_offset_maps_to_containing_note() {
        let src = format!(
            "front matter\n{}body A\n{}body B\n",
            chapter_anchor_call("Note One"),
            chapter_anchor_call("Note (Two)"),
        );
        // Front matter (before the first anchor) → None.
        assert_eq!(chapter_at_offset(&src, 0), None);
        let a = src.find("body A").unwrap();
        assert_eq!(chapter_at_offset(&src, a), Some("Note One".to_string()));
        // A stem with spaces + parens round-trips through the escaped anchor.
        let b = src.find("body B").unwrap();
        assert_eq!(chapter_at_offset(&src, b), Some("Note (Two)".to_string()));
    }

    #[test]
    fn describe_groups_errors_by_note_and_dedupes() {
        use crate::typst_pipeline::diagnostic::{TypstDiagnostic, TypstSpan};
        let src = format!(
            "front\n{}body A\n{}body B\n",
            chapter_anchor_call("Alpha"),
            chapter_anchor_call("Beta"),
        );
        let off_a = src.find("body A").unwrap();
        let off_b = src.find("body B").unwrap();
        let span = |start: usize| {
            Some(TypstSpan {
                path: None,
                start,
                end: start,
                line: None,
                column: None,
                is_main: true,
                package: None,
            })
        };
        let diag = |msg: &str, start: usize| TypstDiagnostic {
            severity: "error",
            message: msg.to_string(),
            primary: span(start),
            trace: vec![],
            hints: vec![],
            code: None,
            params: Default::default(),
        };
        let diags = vec![
            diag("expected expression", off_a),
            diag("expected expression", off_a), // duplicate in same note → collapsed
            diag("unclosed delimiter", off_b),
            TypstDiagnostic {
                severity: "warning",
                message: "ignored".to_string(),
                primary: span(off_a),
                trace: vec![],
                hints: vec![],
                code: None,
                params: Default::default(),
            },
        ];
        let msg = describe_book_diagnostics(&src, &diags, None);
        assert!(msg.contains("In \"Alpha\": expected expression."), "{msg}");
        assert!(msg.contains("In \"Beta\": unclosed delimiter."), "{msg}");
        assert_eq!(
            msg.matches("expected expression").count(),
            1,
            "deduped: {msg}"
        );
        assert!(!msg.contains("ignored"), "warnings excluded: {msg}");
    }

    #[test]
    fn extract_bibliography_path_reads_template_arg() {
        let custom = "#show: ieee.with(\n  title: [T],\n  bibliography: bibliography(\"/.inkycap/collection-bibs/Foo.bib\"),\n)\n";
        assert_eq!(
            extract_bibliography_path(custom).as_deref(),
            Some("/.inkycap/collection-bibs/Foo.bib")
        );
        // No string-arg form, or absent → None.
        assert_eq!(extract_bibliography_path("#show: ieee\n= H\n"), None);
        assert_eq!(
            extract_bibliography_path("#show: foo.with(bibliography: none)"),
            None
        );
        // Commented occurrence is skipped.
        assert_eq!(
            extract_bibliography_path("// bibliography(\"x.bib\")\n= H\n"),
            None
        );
    }

    #[test]
    fn describe_appends_bibliography_hint_with_path() {
        use crate::typst_pipeline::diagnostic::TypstDiagnostic;
        let diags = vec![TypstDiagnostic {
            severity: "error",
            message: "failed to parse BibLaTeX (expected comma)".to_string(),
            primary: None,
            trace: vec![],
            hints: vec![],
            code: None,
            params: Default::default(),
        }];
        let msg = describe_book_diagnostics("front\n", &diags, Some("/refs.bib"));
        assert!(msg.contains("bibliography file (/refs.bib)"), "{msg}");
        assert!(msg.contains("citation key"), "{msg}");
        // Without a known path it still hints, just unqualified.
        let msg2 = describe_book_diagnostics("front\n", &diags, None);
        assert!(
            msg2.contains("bibliography file couldn't be parsed"),
            "{msg2}"
        );
    }

    #[test]
    fn diagnostic_note_stems_lists_failing_chapters_only() {
        use crate::typst_pipeline::diagnostic::{TypstDiagnostic, TypstSpan};
        let src = format!(
            "front\n{}body A\n{}body B\n",
            chapter_anchor_call("Alpha"),
            chapter_anchor_call("Beta"),
        );
        let off_a = src.find("body A").unwrap();
        let off_b = src.find("body B").unwrap();
        let diag = |start: usize, is_main: bool| TypstDiagnostic {
            severity: "error",
            message: "boom".to_string(),
            primary: Some(TypstSpan {
                path: None,
                start,
                end: start,
                line: None,
                column: None,
                is_main,
                package: None,
            }),
            trace: vec![],
            hints: vec![],
            code: None,
            params: Default::default(),
        };
        let diags = vec![
            diag(off_a, true),
            diag(off_a, true), // same note → de-duped
            diag(off_b, true),
            diag(0, true),      // front matter (before any chapter) → not a note
            diag(off_a, false), // an imported file → not attributable
            TypstDiagnostic {
                severity: "warning",
                message: "w".into(),
                primary: Some(TypstSpan {
                    path: None,
                    start: off_b,
                    end: off_b,
                    line: None,
                    column: None,
                    is_main: true,
                    package: None,
                }),
                trace: vec![],
                hints: vec![],
                code: None,
                params: Default::default(),
            },
        ];
        let stems = book_diagnostic_note_stems(&src, &diags);
        assert_eq!(stems, vec!["Alpha".to_string(), "Beta".to_string()]);
    }

    #[test]
    fn build_book_emits_merged_context_set() {
        let n = note("a", "#note()\n= A\n");
        let src = build_book_source(
            &[n],
            &options(),
            None,
            None,
            None,
            None,
            None,
            false,
            None,
            None,
        );
        assert!(src.contains("#set-merged-context(active: true,"));
        assert!(src.contains("\"a\""));
    }

    #[test]
    fn build_book_honours_page_numbering_roman_then_arabic() {
        let mut opts = options();
        opts.page_numbering = BookPageNumbering::RomanThenArabic;
        let n = note("a", "= A\n");
        let src = build_book_source(&[n], &opts, None, None, None, None, None, false, None, None);
        // Front matter in roman, body switches to arabic and resets.
        assert!(src.contains("#set page(numbering: \"i\")"));
        assert!(src.contains("#set page(numbering: \"1\")"));
        assert!(src.contains("#counter(page).update(1)"));
    }

    #[test]
    fn build_book_honours_page_numbering_arabic_from_chapters() {
        let mut opts = options();
        opts.page_numbering = BookPageNumbering::ArabicFromChapters;
        let n = note("a", "= A\n");
        let src = build_book_source(&[n], &opts, None, None, None, None, None, false, None, None);
        assert!(src.contains("#set page(numbering: none)"));
        assert!(src.contains("#set page(numbering: \"1\")"));
        assert!(src.contains("#counter(page).update(1)"));
    }

    #[test]
    fn build_book_uses_style_override_pattern_for_body() {
        // A custom page-numbering pattern is used for the body.
        let mut opts = options();
        opts.page_numbering = BookPageNumbering::RomanThenArabic;
        let n = note("a", "= A\n");
        let src = build_book_source(
            &[n],
            &opts,
            None,
            None,
            None,
            None,
            None,
            false,
            Some("Page 1 of 1"),
            None,
        );
        // Body section uses the user's literal pattern.
        assert!(
            src.contains("#set page(numbering: \"Page 1 of 1\")"),
            "expected body pattern in source:\n{}",
            src
        );
        // Front matter swaps the format char to lowercase roman.
        assert!(
            src.contains("#set page(numbering: \"Page i of i\")"),
            "expected roman front-matter pattern in source:\n{}",
            src
        );
        // Counter still resets at body start.
        assert!(src.contains("#counter(page).update(1)"));
    }

    #[test]
    fn build_book_uses_style_override_pattern_with_arabic_numbering() {
        // With Arabic numbering, front matter and body share the pattern.
        let mut opts = options();
        opts.page_numbering = BookPageNumbering::Arabic;
        let n = note("a", "= A\n");
        let src = build_book_source(
            &[n],
            &opts,
            None,
            None,
            None,
            None,
            None,
            false,
            Some("-- 1 --"),
            None,
        );
        assert!(
            src.contains("#set page(numbering: \"-- 1 --\")"),
            "expected user pattern in source:\n{}",
            src
        );
        // The hardcoded `"1"` default must not leak into the output when
        // the user has supplied a different pattern.
        assert!(
            !src.contains("#set page(numbering: \"1\")"),
            "wrapper default pattern leaked through:\n{}",
            src
        );
    }

    #[test]
    fn build_book_falls_back_to_default_pattern_when_unset() {
        // No style override → wrapper default "1" / "i".
        let mut opts = options();
        opts.page_numbering = BookPageNumbering::RomanThenArabic;
        let n = note("a", "= A\n");
        let src = build_book_source(&[n], &opts, None, None, None, None, None, false, None, None);
        assert!(src.contains("#set page(numbering: \"i\")"));
        assert!(src.contains("#set page(numbering: \"1\")"));
    }

    #[test]
    fn build_book_routes_outline_through_package_helper() {
        // The table of contents shows plain page numbers whatever the page
        // pattern.
        let n = note("a", "= A\n");
        let src = build_book_source(
            &[n],
            &options(),
            None,
            None,
            None,
            None,
            None,
            false,
            Some("Page 1 of 1"),
            None,
        );
        assert!(
            src.contains("#outline-with-bare-page-numbers(depth:"),
            "expected outline routed through the package helper:\n{}",
            src
        );
    }

    #[test]
    fn build_book_skips_outline_helper_when_outline_disabled() {
        let mut opts = options();
        opts.include_outline = false;
        let n = note("a", "= A\n");
        let src = build_book_source(&[n], &opts, None, None, None, None, None, false, None, None);
        assert!(
            !src.contains("outline-with-bare-page-numbers"),
            "outline helper leaked when outline was disabled:\n{}",
            src
        );
    }

    #[test]
    fn build_book_uses_style_override_heading_pattern() {
        // A user pattern from Style Overrides → Heading numbering is used
        // verbatim, replacing the wrapper's "1.1" default.
        let opts = options();
        let n = note("a", "= A\n");
        let src = build_book_source(
            &[n],
            &opts,
            None,
            None,
            None,
            None,
            None,
            false,
            None,
            Some("I.A.1"),
        );
        assert!(
            src.contains("#set heading(numbering: \"I.A.1\")"),
            "expected user heading pattern in source:\n{}",
            src
        );
        assert!(
            !src.contains("#set heading(numbering: \"1.1\")"),
            "wrapper default heading pattern leaked through:\n{}",
            src
        );
    }

    #[test]
    fn build_book_defaults_to_numbered_chapters() {
        // No heading numbering style set (Inherit) → books default to "1.1".
        let opts = options();
        let n = note("a", "= A\n");
        let src = build_book_source(&[n], &opts, None, None, None, None, None, false, None, None);
        assert!(
            src.contains("#set heading(numbering: \"1.1\")"),
            "expected default chapter numbering:\n{}",
            src
        );
    }

    #[test]
    fn build_book_skips_heading_rule_when_numbering_none() {
        // Heading numbering "none" must suppress the wrapper's #set heading rule.
        let opts = options();
        let n = note("a", "= A\n");
        let src = build_book_source(
            &[n],
            &opts,
            None,
            None,
            None,
            None,
            None,
            false,
            None,
            Some("none"),
        );
        assert!(
            !src.contains("#set heading(numbering:"),
            "wrapper should not number chapters when heading numbering is none:\n{}",
            src
        );
    }

    #[test]
    fn to_roman_pattern_swaps_arabic_placeholder() {
        assert_eq!(to_roman_pattern("1"), "i");
        assert_eq!(to_roman_pattern("Page 1"), "Page i");
        assert_eq!(to_roman_pattern("-- 1 --"), "-- i --");
        assert_eq!(to_roman_pattern("Page 1 of 1"), "Page i of i");
    }

    #[test]
    fn to_roman_pattern_leaves_letters_alone() {
        // `a` / `A` aren't swapped; they appear in ordinary text.
        assert_eq!(to_roman_pattern("Page A"), "Page A");
        assert_eq!(to_roman_pattern("Section a"), "Section a");
    }

    #[test]
    fn to_roman_pattern_is_identity_when_no_format_char() {
        // No arabic placeholder → keep the user's pattern as-is.
        assert_eq!(to_roman_pattern("i"), "i");
        assert_eq!(to_roman_pattern("Preface"), "Preface");
    }

    #[test]
    fn humanize_stem_capitalizes_words() {
        assert_eq!(humanize_stem("intro"), "Intro");
        assert_eq!(humanize_stem("quantum-mechanics"), "Quantum Mechanics");
        assert_eq!(humanize_stem("a_b_c"), "A B C");
    }
}
