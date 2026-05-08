//! Build the synthetic Typst document used by the "Export as book" action.
//!
//! Given an ordered list of notes from a collection, this module produces a
//! single Typst source string that compiles to the merged book PDF — title
//! page, optional abstract, outline, sequential chapters, and a single
//! bibliography. The wrapper is never written to disk: it is passed straight
//! to the Typst compiler the same way every other compile path works.
//!
//! Notes are inlined (not `#include`d) because the Typst world enforces a
//! vault-root sandbox that would reject temporary paths outside the vault.
//! Each note is preprocessed to strip its `#import` preamble, leading
//! `#note(...)` call, and any `#bibliography(...)` call so the merged output
//! has exactly one preamble and one bibliography.
//!
//! Interactive cross-chapter wikilinks rely on a `state` set in the
//! `inkycap-vault` package; see [`build_book_source`] for the
//! `set-merged-context(...)` invocation.

use std::path::PathBuf;

use crate::collection_parser::model::{
    BookExportConfig, BookPageNumbering, BookWikilinkMode, InjectChapterHeading,
};
use crate::vault_package::strip_note_preamble;

// ── Public types ────────────────────────────────────────────────────────────

/// One note participating in the merged book. `stem` is the file stem
/// (basename without `.typ`) used as the wikilink target name.
#[derive(Debug, Clone)]
pub struct BookNote {
    pub stem: String,
    pub abs_path: PathBuf,
    pub content: String,
    /// Title resolved from the note's `#note(title: ...)` argument, if any.
    /// Used to inject a chapter heading when the note doesn't begin with one
    /// and the inject mode requires it.
    pub title: Option<String>,
}

/// Effective options for one book-export invocation. Built from the
/// collection's `BookExportConfig` plus any per-export dialog overrides; all
/// fields are required at this layer — defaults must already be resolved.
#[derive(Debug, Clone)]
pub struct BookExportOptions {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub author: Option<String>,
    pub date: Option<String>,
    pub abstract_text: Option<String>,
    pub toc_depth: u8,
    pub number_chapters: bool,
    pub inject_chapter_heading: InjectChapterHeading,
    pub wikilink_mode: BookWikilinkMode,
    pub include_title_page: bool,
    pub include_outline: bool,
    pub page_numbering: BookPageNumbering,
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
            date: cfg.date,
            abstract_text: cfg.abstract_text,
            toc_depth: cfg.toc_depth.unwrap_or(2),
            number_chapters: cfg.number_chapters.unwrap_or(true),
            inject_chapter_heading: cfg.inject_chapter_heading.unwrap_or_default(),
            wikilink_mode: cfg.wikilink_mode.unwrap_or_default(),
            include_title_page: cfg.include_title_page.unwrap_or(true),
            include_outline: cfg.include_outline.unwrap_or(true),
            page_numbering: cfg.page_numbering.unwrap_or_default(),
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

/// Strip a top-level `#bibliography(...)` call from a note body. The merged
/// book renders one bibliography at the wrapper level, so per-note
/// declarations would either duplicate or shadow it.
///
/// Conservative scan: matches `#bibliography(` at the start of a line
/// (optionally indented), then walks balanced parentheses to the closing
/// paren. Strings and escapes are tracked so a `)` inside a quoted argument
/// does not end the call early.
pub fn strip_bibliography_call(content: &str) -> String {
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    // Cursor into `content`. Always sits on a char boundary because every
    // place that advances it does so either by a newline (1 byte ASCII), by
    // a previously-emitted slice end, or by the byte offset returned from
    // `find_balanced_paren_end` (which only points at ASCII parentheses).
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
            if content[j..].starts_with("#bibliography(") {
                let call_start = j + "#bibliography".len(); // points at '('
                if let Some(end) = find_balanced_paren_end(content, call_start) {
                    // Drop the call (and the line's leading whitespace), plus
                    // a single trailing newline so we don't leave a blank
                    // line behind.
                    let mut after = end + 1;
                    if after < len && bytes[after] == b'\n' {
                        after += 1;
                    }
                    i = after;
                    continue;
                }
            }
        }

        // Copy the rest of this line as a UTF-8 slice. Splitting at '\n' is
        // safe because '\n' is single-byte and aligned with char
        // boundaries — emitting individual bytes would shred multi-byte
        // codepoints, which is what was previously corrupting Unicode
        // content (Greek/CJK/em-dash/smart quotes) and producing spurious
        // unbalanced delimiters when the corrupted output was parsed.
        let nl = content[i..]
            .find('\n')
            .map(|p| i + p + 1)
            .unwrap_or(len);
        out.push_str(&content[i..nl]);
        i = nl;
    }
    out
}

/// Returns the byte offset of the `)` that closes the `(` at `paren_open`.
/// Tracks string literals (`"..."` with `\` escapes). Returns `None` if the
/// parens never balance.
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

/// Prepare a note's content for inlining into the merged book: strip the
/// vault-package import, the leading `#note(...)` metadata call, and any
/// `#bibliography(...)` declarations in the body.
pub fn prepare_note_for_include(content: &str) -> String {
    let after_preamble = strip_note_preamble(content);
    strip_bibliography_call(after_preamble)
}

// ── Label collision detection ───────────────────────────────────────────────

/// Find Typst label declarations of the form `<name>` in a note. Skips
/// occurrences inside string literals and line comments. The match is
/// deliberately permissive — Typst itself is the source of truth at compile
/// time — but it catches the load-bearing cases that would otherwise fail
/// inside the merged document.
pub fn extract_label_decls(content: &str, note_stem: &str) -> Vec<LabelDecl> {
    let mut out = Vec::new();
    let bytes = content.as_bytes();
    let mut in_string = false;
    let mut escape = false;
    let mut in_line_comment = false;
    let mut i = 0;

    while i < bytes.len() {
        let c = bytes[i];
        if in_line_comment {
            if c == b'\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
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
        if c == b'"' {
            in_string = true;
            i += 1;
            continue;
        }
        if c == b'/' && bytes.get(i + 1) == Some(&b'/') {
            in_line_comment = true;
            i += 2;
            continue;
        }
        if c == b'<' {
            // Try to match <ident>
            let start = i + 1;
            let mut j = start;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric()
                    || bytes[j] == b'-'
                    || bytes[j] == b'_'
                    || bytes[j] == b':'
                    || bytes[j] == b'.')
            {
                j += 1;
            }
            if j > start && bytes.get(j) == Some(&b'>') {
                let name = &content[start..j];
                // Reject if `<` was likely part of `<=`, `<-`, `<<`, etc., by
                // requiring no immediate alphanumeric before `<` (a label
                // sits in markup context, not code expression).
                let prev = if i == 0 { None } else { Some(bytes[i - 1]) };
                let prev_is_ident = matches!(
                    prev,
                    Some(b) if b.is_ascii_alphanumeric() || b == b'_'
                );
                if !prev_is_ident {
                    out.push(LabelDecl {
                        name: name.to_string(),
                        note_stem: note_stem.to_string(),
                    });
                    i = j + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// Detect labels declared in two or more notes. The injected per-chapter
/// labels (`chap-<stem>`) are not in scope here — those live in the
/// generated wrapper, not in the source notes.
pub fn scan_label_collisions(notes: &[BookNote]) -> Vec<LabelCollision> {
    use std::collections::BTreeMap;
    let mut by_label: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for note in notes {
        for decl in extract_label_decls(&note.content, &note.stem) {
            // <inkycap-*> labels are emitted by the vault package itself
            // (one per note/tag/link) — collisions are expected and
            // harmless. Skip them.
            if decl.name.starts_with("inkycap-") {
                continue;
            }
            by_label
                .entry(decl.name)
                .or_default()
                .push(decl.note_stem);
        }
    }
    by_label
        .into_iter()
        .filter(|(_, notes)| {
            // Only collisions between *different* notes count; a single note
            // declaring the same label twice is its own problem and Typst
            // will report it at compile time.
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

/// Normalize heading levels in a note body so they nest under a level-1
/// chapter heading without gaps. PDF/UA-1 requires strictly consecutive
/// heading levels — you cannot jump from h1 to h3.
///
/// Strategy: find the minimum `=` level in the note, shift all headings so
/// that minimum becomes `target_min` (typically 2, the level directly under
/// the chapter heading), and compress any remaining gaps so no level is
/// skipped. A note with `=`, `===` headings targeted at min=2 becomes
/// `==`, `===` (shifted, gap-free).
pub fn normalize_heading_levels(body: &str, target_min: u8) -> String {
    let lines: Vec<&str> = body.lines().collect();

    // First pass: collect the heading levels present.
    let mut levels_present: Vec<u8> = Vec::new();
    for line in &lines {
        let trimmed = line.trim_start();
        if let Some(level) = heading_level(trimmed) {
            if !levels_present.contains(&level) {
                levels_present.push(level);
            }
        }
    }

    if levels_present.is_empty() {
        return body.to_string();
    }

    levels_present.sort();

    // Build a mapping from original level → normalized level.
    // The lowest heading becomes `target_min`, next distinct level becomes
    // `target_min + 1`, etc. This both shifts and compresses gaps.
    let mut level_map = std::collections::HashMap::new();
    for (i, &level) in levels_present.iter().enumerate() {
        level_map.insert(level, target_min + i as u8);
    }

    // Second pass: rewrite headings.
    let mut out = String::with_capacity(body.len());
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let trimmed = line.trim_start();
        if let Some(orig_level) = heading_level(trimmed) {
            if let Some(&new_level) = level_map.get(&orig_level) {
                let leading_ws = &line[..line.len() - trimmed.len()];
                let after_equals = &trimmed[orig_level as usize..];
                out.push_str(leading_ws);
                for _ in 0..new_level {
                    out.push('=');
                }
                out.push_str(after_equals);
                continue;
            }
        }
        out.push_str(line);
    }
    // Preserve trailing newline if the original had one.
    if body.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Count the heading level of a line (number of leading `=` characters).
/// Returns `None` if the line is not a Typst heading.
fn heading_level(trimmed_line: &str) -> Option<u8> {
    if !trimmed_line.starts_with('=') {
        return None;
    }
    let count = trimmed_line.bytes().take_while(|&b| b == b'=').count();
    // A heading must be followed by a space (or end of line). "==text" is
    // not a heading in Typst.
    let after = trimmed_line.as_bytes().get(count);
    if after.is_none() || after == Some(&b' ') || after == Some(&b'\t') {
        Some(count as u8)
    } else {
        None
    }
}

// ── Wrapper generation ──────────────────────────────────────────────────────


/// Build the merged book Typst source. The returned string is meant to be
/// passed directly to [`crate::typst_pipeline::compiler::TypstCompiler::compile_pdf`].
///
/// The caller owns the surrounding compile orchestration: applying
/// collection-level `#set` rules, resolving the bibliography path, picking
/// the synthetic main path, and writing the resulting PDF to disk. Keeping
/// those concerns outside this module lets the wrapper builder stay a pure
/// string transformation that is straightforward to unit-test.
pub fn build_book_source(
    notes: &[BookNote],
    options: &BookExportOptions,
    style_rules: Option<&str>,
    template_import: Option<&str>,
    bibliography_path: Option<&str>,
    bibliography_style: Option<&str>,
    // When true, normalize each note's heading levels so they nest under
    // the chapter h1 without gaps. Required for PDF/UA-1 compliance.
    normalize_headings: bool,
    // Page-numbering pattern from the collection's Style Overrides
    // (e.g. "1", "Page 1", "-- 1 --"). Used as the body-section
    // pattern; the front-matter pattern is derived from it by
    // swapping the format character to lowercase roman when the book
    // uses RomanThenArabic. Defaults to "1" if None.
    body_page_numbering_pattern: Option<&str>,
    // Heading-numbering pattern from the collection's Style Overrides
    // (e.g. "1.1", "I.A.1", "1.a."). Used when the book is configured
    // to number chapters; falls back to "1.1" when None. Only consulted
    // if `options.number_chapters` is true — otherwise the book wrapper
    // does not emit a #set heading rule at all and any style override
    // applies untouched.
    heading_numbering_pattern: Option<&str>,
) -> String {
    let mut s = String::with_capacity(8 * 1024);

    // Vault library import — same as every other compiled note.
    s.push_str(&crate::vault_package::import_line());
    s.push('\n');

    // Inform the vault package we're in a merged-book compile, so the
    // `wikilink` function can resolve internally / strip / fall through.
    let mode_str = match options.wikilink_mode {
        BookWikilinkMode::Internal => "internal",
        BookWikilinkMode::External => "external",
        BookWikilinkMode::Plain => "plain",
    };
    let chapters_array = notes
        .iter()
        .map(|n| format!("\"{}\"", typst_escape(&n.stem)))
        .collect::<Vec<_>>()
        .join(", ");
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
    if options.number_chapters {
        // Use the user's Style Overrides pattern when present so a
        // custom format like "I.A.1" survives; only fall back to the
        // wrapper default "1.1" when the user has expressed no
        // preference.
        let heading_pattern = heading_numbering_pattern.unwrap_or("1.1");
        s.push_str(&format!(
            "#set heading(numbering: \"{}\")\n",
            typst_escape(heading_pattern)
        ));
    }

    // Optional template — applied via `#show: tmpl.with(...)`.
    if let Some(import_line) = template_import {
        s.push_str(import_line);
        if !import_line.ends_with('\n') {
            s.push('\n');
        }
    }

    // The user's preferred numbering pattern (from Style Overrides) acts
    // as the body-section template — both for choosing the literal format
    // ("1" vs "Page 1" vs "-- 1 --") and for deriving the roman-variant
    // pattern used in front matter when the book is set to
    // `RomanThenArabic`. Default to plain arabic if no style override is
    // set.
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

    // Title page (skipped when a template is in use — templates own the
    // title page convention).
    if options.include_title_page && template_import.is_none() {
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

    // Outline.
    //
    // Typst's default outline.entry uses the active page-numbering
    // pattern when rendering each entry's page label, so a body pattern
    // like "Page 1 of N" or `"{1}"` would leak into the table of
    // contents — readers expect the TOC to show plain page numbers
    // (1, 2, 3) regardless of how the page footer is decorated.
    //
    // This `#show outline.entry` rule rebuilds each entry by hand:
    // - keep the prefix (chapter numbering) and the body (heading text),
    // - keep the dotted fill,
    // - replace the page label with the raw page counter at the
    //   heading's location, formatted as a bare integer.
    //
    // We scope the rule to a single `#outline(...)` block so it doesn't
    // leak into any later content the user might add.
    if options.include_outline {
        // `#{ … }` opens a code block whose `show` rules only apply
        // within the block, so the custom outline-entry rendering does
        // not leak into anything the user emits later.
        s.push_str("#{\n");
        s.push_str(
            "  show outline.entry: it => link(\n    \
               it.element.location(),\n    \
               it.indented(\n      \
                 it.prefix(),\n      \
                 it.body() + box(width: 1fr, repeat[.]) + h(0.5em) + str(counter(page).at(it.element.location()).first()),\n    \
               ),\n  \
             )\n",
        );
        s.push_str(&format!("  outline(depth: {})\n}}\n", options.toc_depth));
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
            // Arabic numerals turn on once the document reaches `start_page`.
            // The expression `if here().page() >= N { (N - start_page + 1) }`
            // produces a sequence that reads 1, 2, 3 … starting at the
            // requested page, leaving earlier pages unnumbered.
            let start = start_page.max(1);
            s.push_str(&format!(
                "#set page(numbering: (..n) => {{ \
let p = here().page(); \
if p >= {start} {{ str(p - {start} + 1) }} else {{ none }} \
}})\n",
                start = start
            ));
        }
    }

    // ── Chapters ───────────────────────────────────────────────────────────
    for (idx, note) in notes.iter().enumerate() {
        if idx > 0 {
            s.push_str("#pagebreak(weak: true)\n");
        }

        let raw_body = prepare_note_for_include(&note.content);
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

        let chapter_label = format!("chap-{}", note.stem);

        if inject {
            let title = note
                .title
                .clone()
                .unwrap_or_else(|| humanize_stem(&note.stem));
            s.push_str(&format!(
                "= {} <{}>\n",
                escape_typst_markup(&title),
                chapter_label
            ));
        } else {
            // Place the chapter label on its own line so wikilinks resolving
            // to `<chap-stem>` land at the start of the chapter regardless
            // of the note's own first heading.
            s.push_str(&format!("#metadata(()) <{}>\n", chapter_label));
        }

        s.push_str(&body);
        if !body.ends_with('\n') {
            s.push('\n');
        }
    }

    // ── Bibliography ───────────────────────────────────────────────────────
    if let Some(path) = bibliography_path {
        s.push_str("#pagebreak(weak: true)\n");
        match bibliography_style {
            Some(style) => s.push_str(&format!(
                "#bibliography(\"{}\", style: \"{}\")\n",
                typst_escape(path),
                typst_escape(style)
            )),
            None => s.push_str(&format!(
                "#bibliography(\"{}\")\n",
                typst_escape(path)
            )),
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
    if options.author.is_some() || options.date.is_some() {
        s.push_str("  #v(2em)\n");
    }
    if let Some(author) = &options.author {
        s.push_str(&format!(
            "  #text(size: 1.1em)[{}]\\ \n",
            escape_typst_markup(author)
        ));
    }
    if let Some(date) = &options.date {
        s.push_str(&format!("  {}\n", escape_typst_markup(date)));
    }
    s.push_str("]\n#pagebreak()\n");
    s
}

/// Escape a string for safe interpolation into a Typst quoted string literal.
fn typst_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Derive the roman-numeral variant of a Typst page-numbering pattern.
/// Typst treats `1` in a pattern as the arabic-numeral format placeholder
/// and the rest of the string as literal text. To turn a body pattern
/// like `"Page 1 of 1"` into its front-matter roman equivalent
/// (`"Page i of i"`), every `1` is swapped to lowercase `i`.
///
/// We deliberately do *not* touch `a` / `A` even though Typst recognises
/// them as alpha format placeholders: those letters collide with normal
/// English literal text far too often (a pattern like `"Page 1"` would
/// turn into `"Pige i"`). Users who want a non-arabic body pattern can
/// keep their override unchanged — without a `1`, this function is a
/// no-op.
fn to_roman_pattern(pattern: &str) -> String {
    if !pattern.contains('1') {
        return pattern.to_string();
    }
    pattern.replace('1', "i")
}

/// Escape user-provided text for Typst content/markup context. Backslashes
/// and the small set of markup-active characters are escaped so authored
/// titles like `# C* algebras` survive verbatim instead of being parsed as
/// markup.
fn escape_typst_markup(s: &str) -> String {
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
        .split(|c: char| c == '-' || c == '_' || c == ' ')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => {
                    first.to_uppercase().collect::<String>() + chars.as_str()
                }
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
    use super::*;

    fn note(stem: &str, content: &str) -> BookNote {
        BookNote {
            stem: stem.to_string(),
            abs_path: PathBuf::from(format!("/vault/{}.typ", stem)),
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
        // Multi-byte characters must survive verbatim. A previous
        // implementation byte-cast each input byte to char, which
        // shredded these into Latin-1 garbage and produced spurious
        // "unclosed delimiter" parse errors when the corrupted output
        // was fed back to the Typst compiler.
        let src = "Some text — with “smart quotes”, an é, and PMBOK®.\n#bibliography(\"refs.bib\")\nMore — text.\n";
        let out = strip_bibliography_call(src);
        assert_eq!(out, "Some text — with “smart quotes”, an é, and PMBOK®.\nMore — text.\n");
    }

    /// Sample of representative non-ASCII content — em/en dashes, smart
    /// quotes, accented Latin, RTL Arabic, Hebrew, CJK, Cyrillic, Devanagari,
    /// emoji (4-byte UTF-8), and combining marks. The book wrapper must
    /// pass any of these through verbatim. New string-transform helpers
    /// added to this module should be exercised against
    /// `UNICODE_BODY_FIXTURES` so they stay UTF-8-correct.
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
                "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n\
                 #note(title: \"Title\")\n\
                 = Heading\n\
                 {}\n\
                 #bibliography(\"refs.bib\")\n",
                fixture
            );
            let out = prepare_note_for_include(&src);
            assert!(out.contains(fixture), "fixture missing from output: {:?}", fixture);
            assert!(!out.contains("#import"));
            assert!(!out.contains("#note("));
            assert!(!out.contains("#bibliography"));
        }
    }

    #[test]
    fn extract_label_decls_handles_unicode() {
        // Labels themselves are ASCII-only by Typst rules, but the
        // surrounding content can be any Unicode. The scanner must not
        // get confused mid-codepoint.
        for fixture in UNICODE_BODY_FIXTURES {
            let src = format!("{}\n= Heading <intro>\n{}\n", fixture, fixture);
            let labels = extract_label_decls(&src, "note-a");
            assert_eq!(labels.len(), 1, "fixture: {:?}", fixture);
            assert_eq!(labels[0].name, "intro");
        }
    }

    #[test]
    fn prepare_note_strips_preamble_and_bibliography() {
        let src = r#"#import "/.inkycap/packages/inkycap-vault/0.1.0/lib.typ": *
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
        // The vault package emits <inkycap-note> on every #note(...) call.
        // Those are not user-authored labels so they should still be
        // extracted (the collision filter handles them).
        let labels = extract_label_decls("#metadata((x: 1)) <inkycap-note>\n", "a");
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].name, "inkycap-note");
    }

    #[test]
    fn extract_labels_skips_string_contents() {
        let labels = extract_label_decls("\"<not-a-label>\"\n", "a");
        assert!(labels.is_empty());
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
    fn build_book_emits_one_bibliography() {
        let notes = vec![
            note("alpha", "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n#note()\n= Alpha\nA"),
            note("beta",  "#import \"/.inkycap/packages/inkycap-vault/0.1.0/lib.typ\": *\n#note()\n= Beta\nB\n#bibliography(\"refs.bib\")"),
        ];
        let src = build_book_source(
            &notes,
            &options(),
            None,
            None,
            Some("refs.bib"),
            Some("ieee"),
            false,
            None,
            None,
        );
        let bib_count = src.matches("#bibliography(").count();
        assert_eq!(bib_count, 1, "expected exactly one bibliography call, got source:\n{}", src);
    }

    #[test]
    fn build_book_injects_heading_when_missing() {
        let mut opts = options();
        opts.inject_chapter_heading = InjectChapterHeading::Fallback;
        let mut n = note("methods", "Body without heading.\n");
        n.title = Some("Methods".to_string());
        let src = build_book_source(&[n], &opts, None, None, None, None, false, None, None);
        assert!(src.contains("= Methods <chap-methods>"));
    }

    #[test]
    fn build_book_skips_injection_when_note_has_heading() {
        let mut opts = options();
        opts.inject_chapter_heading = InjectChapterHeading::Fallback;
        let mut n = note("intro", "= Introduction\nBody.\n");
        n.title = Some("Introduction".to_string());
        let src = build_book_source(&[n], &opts, None, None, None, None, false, None, None);
        // The injected heading variant is the one that puts the title on the
        // same line as the chapter label. Fallback mode should NOT do that
        // because the note already has its own `=` heading.
        assert!(!src.contains("= Introduction <chap-intro>"));
        assert!(src.contains("<chap-intro>"));
    }

    #[test]
    fn build_book_always_injects_heading_when_set() {
        let mut opts = options();
        opts.inject_chapter_heading = InjectChapterHeading::Always;
        let mut n = note("intro", "= Author's Heading\nBody.\n");
        n.title = Some("Introduction".to_string());
        let src = build_book_source(&[n], &opts, None, None, None, None, false, None, None);
        assert!(src.contains("= Introduction <chap-intro>"));
    }

    #[test]
    fn build_book_emits_merged_context_set() {
        let n = note("a", "#note()\n= A\n");
        let src = build_book_source(&[n], &options(), None, None, None, None, false, None, None);
        assert!(src.contains("#set-merged-context(active: true,"));
        assert!(src.contains("\"a\""));
    }

    #[test]
    fn build_book_honours_page_numbering_roman_then_arabic() {
        let mut opts = options();
        opts.page_numbering = BookPageNumbering::RomanThenArabic;
        let n = note("a", "= A\n");
        let src = build_book_source(&[n], &opts, None, None, None, None, false, None, None);
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
        let src = build_book_source(&[n], &opts, None, None, None, None, false, None, None);
        assert!(src.contains("#set page(numbering: none)"));
        assert!(src.contains("#set page(numbering: \"1\")"));
        assert!(src.contains("#counter(page).update(1)"));
    }

    #[test]
    fn build_book_uses_style_override_pattern_for_body() {
        // When the user has set a custom page-numbering pattern in the
        // collection's Style Overrides, the book wrapper must use that
        // pattern in body sections rather than its default `"1"`.
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
        // With Arabic numbering, both front matter and body use the same
        // pattern — the user's override should appear once and replace
        // the wrapper's default.
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
        let src = build_book_source(&[n], &opts, None, None, None, None, false, None, None);
        assert!(src.contains("#set page(numbering: \"i\")"));
        assert!(src.contains("#set page(numbering: \"1\")"));
    }

    #[test]
    fn build_book_overrides_outline_entry_for_plain_toc_numbers() {
        // The TOC must show bare page integers regardless of the page
        // pattern set in Style Overrides. The implementation routes the
        // page label through `str(counter(page).at(...).first())` inside
        // a scoped `show outline.entry` rule, so the rendered TOC is
        // independent of the body pattern.
        let n = note("a", "= A\n");
        let src = build_book_source(
            &[n],
            &options(),
            None,
            None,
            None,
            None,
            false,
            Some("Page 1 of 1"),
            None,
        );
        assert!(
            src.contains("show outline.entry: it => link("),
            "expected outline.entry show rule in source:\n{}",
            src
        );
        assert!(
            src.contains("str(counter(page).at(it.element.location()).first())"),
            "expected outline page label to use the raw page counter:\n{}",
            src
        );
        // The show rule must be scoped to a `#{ … }` code block so it
        // doesn't bleed into anything emitted after the outline.
        assert!(
            src.contains("#{\n"),
            "expected a scoped code block around the outline override:\n{}",
            src
        );
    }

    #[test]
    fn build_book_skips_outline_override_when_outline_disabled() {
        // No outline → no need (and no place) for the entry show rule.
        let mut opts = options();
        opts.include_outline = false;
        let n = note("a", "= A\n");
        let src = build_book_source(&[n], &opts, None, None, None, None, false, None, None);
        assert!(
            !src.contains("show outline.entry"),
            "outline override leaked when outline was disabled:\n{}",
            src
        );
        assert!(!src.contains("outline(depth:"));
    }

    #[test]
    fn build_book_uses_style_override_heading_pattern() {
        // A user pattern from Style Overrides → Heading numbering must
        // replace the wrapper's default "1.1" when the book is set to
        // number chapters.
        let mut opts = options();
        opts.number_chapters = true;
        let n = note("a", "= A\n");
        let src = build_book_source(
            &[n],
            &opts,
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
    fn build_book_skips_heading_rule_when_chapter_numbering_off() {
        // When the book disables chapter numbering, the wrapper must not
        // emit any heading-numbering set rule — that lets the style
        // override (or Typst's default of `none`) take effect.
        let mut opts = options();
        opts.number_chapters = false;
        let n = note("a", "= A\n");
        let src = build_book_source(
            &[n],
            &opts,
            None,
            None,
            None,
            None,
            false,
            None,
            Some("I.A.1"),
        );
        assert!(
            !src.contains("#set heading(numbering:"),
            "wrapper should not override heading numbering when book \
             toggle is off:\n{}",
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
        // We deliberately do not swap `a` / `A` because they collide with
        // ordinary English literal text — a pattern like "Page" would be
        // mangled into "Pige". Users who want a non-arabic format can
        // already type whatever they want; this function only handles
        // the common case.
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
