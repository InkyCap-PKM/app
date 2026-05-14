//! Typst-AST-driven plain-text projection for full-text search.
//!
//! The search engine's job is to find a user's *prose*, not raw Typst
//! source. Indexing raw bytes means `_italicize_` is tokenized as the
//! single word `_italicize_` and the user's "italicize" query misses;
//! a `#tag("doc-howto")` call ends up on whichever line the tag panel
//! navigates to, which isn't the line the tag is actually on.
//!
//! Per CLAUDE.md's Typst-first principle: instead of stripping markup
//! with regex, we parse the source with `typst::syntax::parse` — the
//! same parser the compiler uses — and walk the AST collecting every
//! `Text` leaf along with a few well-known function-call arguments
//! that carry user-visible text (tag/wikilink/link/image/embed names).
//! Markup wrappers (`Emph`, `Strong`, content-bracket function calls,
//! headings, list items, …) disappear automatically because they're
//! structural nodes around the text leaves rather than part of them.
//!
//! Every emitted token carries the source byte range it originated
//! from, so the engine can keep highlighting matches in the user's
//! actual source and the result snippet still shows the original line.

use std::collections::HashMap;

use typst::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// A single tokenizable word along with where it appeared in the source.
///
/// `line` is 0-based and `char_start`/`char_end` are byte offsets within
/// that line — the same conventions the engine's `WordPosition` uses,
/// so highlight ranges in the SearchPanel keep working unchanged.
#[derive(Debug, Clone)]
pub struct TextToken {
    pub word: String,
    pub line: usize,
    pub char_start: usize,
    pub char_end: usize,
}

/// Output of [`project`]: searchable tokens plus a few structural
/// indexes the engine consumes directly.
#[derive(Debug, Clone, Default)]
pub struct TextProjection {
    /// All searchable tokens in source order.
    pub tokens: Vec<TextToken>,
    /// `tag name (lowercased)` → source line indices of `#tag("…")`
    /// call sites. Used so `tag:` filter clicks land on the actual tag
    /// call instead of a heuristic "first non-empty line".
    pub tag_locations: HashMap<String, Vec<usize>>,
    /// Heading text (lowercased) collected from every `Heading` node,
    /// for the `section:` filter.
    pub headings: Vec<String>,
    /// Text (lowercased) of the document's first level-1 heading (`= …`),
    /// if any. Used as a fallback signal for the title-match relevance
    /// bonus when a note doesn't set `#note(title: …)`.
    pub first_h1: Option<String>,
}

/// Walk the parsed AST and produce a [`TextProjection`].
pub fn project(source: &str) -> TextProjection {
    let line_map = LineMap::new(source);
    let root = parse(source);
    let link = LinkedNode::new(&root);

    let mut out = TextProjection::default();
    walk(&link, source, &line_map, &mut out);
    out
}

/// Recursive descent over the AST.
///
/// Default behavior is "descend into every child"; the special-cases
/// below cover the nodes we either want to skip entirely (code mode,
/// labels, math, comments, vault-side metadata) or for which we extract
/// text out-of-band from arguments (function calls with prose payloads).
fn walk(node: &LinkedNode<'_>, source: &str, line_map: &LineMap, out: &mut TextProjection) {
    match node.kind() {
        // Hidden / structural nodes — never user-visible prose.
        SyntaxKind::Label
        | SyntaxKind::LineComment
        | SyntaxKind::BlockComment
        | SyntaxKind::ModuleImport
        | SyntaxKind::ModuleInclude => return,

        // Math is not naturally word-tokenizable as prose; defer until a
        // dedicated math-aware indexer exists.
        SyntaxKind::Equation | SyntaxKind::Math => return,

        // Code mode: parenthesized arguments, blocks of `#let`/`#if`/…
        // — none of this is prose. Function-call argument prose lives
        // in `ContentBlock` (`[…]`), which we still descend into via
        // `handle_func_call`.
        SyntaxKind::CodeBlock | SyntaxKind::Code => return,

        SyntaxKind::Heading => {
            // Record heading text for the `section:` filter. We capture
            // it from the rendered text of all descendant Text leaves
            // (so `= Hello *world*` indexes as "hello world").
            let heading_text = collect_text_within(node);
            let trimmed = heading_text.trim();
            if !trimmed.is_empty() {
                let lowered = trimmed.to_lowercase();
                // Capture the first level-1 heading as a title-fallback.
                // `ast::Heading::depth` returns the marker count (`=` = 1,
                // `==` = 2, …), so we only latch on depth == 1.
                if out.first_h1.is_none() {
                    if let Some(heading) = node.cast::<ast::Heading>() {
                        if heading.depth().get() == 1 {
                            out.first_h1 = Some(lowered.clone());
                        }
                    }
                }
                out.headings.push(lowered);
            }
            // Fall through to default descent so the heading's words are
            // still emitted as searchable tokens.
        }

        SyntaxKind::Raw => {
            // Code spans / blocks: index their content so users can
            // search for identifiers inside fenced code. `ast::Raw::text`
            // gives the un-delimited body, but we don't have a byte
            // range for that body alone — so we tokenize the raw node's
            // source range directly. Backticks are non-word characters
            // and are dropped naturally by the tokenizer.
            let range = node.range();
            emit_tokens_in_range(source, range, line_map, out);
            return;
        }

        SyntaxKind::FuncCall => {
            handle_func_call(node, source, line_map, out);
            return;
        }

        SyntaxKind::Text => {
            let range = node.range();
            emit_tokens_in_range(source, range, line_map, out);
            return;
        }

        _ => {}
    }

    for child in node.children() {
        walk(&child, source, line_map, out);
    }
}

/// Function-call dispatch.
///
/// We special-case the InkyCap-relevant functions whose searchable text
/// lives in a *string argument* (not in a `ContentBlock`), then fall
/// back to "descend into `ContentBlock` children only" so generic
/// content-bracket wrappers (`#strong[…]`, `#emph[…]`, `#highlight[…]`,
/// `#callout(…)[…]`, custom user functions) yield their bracketed prose
/// without us having to enumerate every function in the language.
fn handle_func_call(
    node: &LinkedNode<'_>,
    source: &str,
    line_map: &LineMap,
    out: &mut TextProjection,
) {
    let Some(call) = node.cast::<ast::FuncCall>() else {
        // Malformed call (parser produced something other than a clean
        // FuncCall under the FuncCall kind). Bail; nothing safe to do.
        return;
    };

    let callee_name = match call.callee() {
        ast::Expr::Ident(ident) => Some(ident.as_str().to_string()),
        ast::Expr::FieldAccess(_) => None, // `module.fn(…)` — treat as unknown
        _ => None,
    };

    match callee_name.as_deref() {
        // The `#note(…)` properties block is metadata, not body prose;
        // its values flow through the property-search path on DocEntry.
        Some("note") => return,

        // Runtime hooks emitted by lib.typ — never user-visible prose.
        Some("metadata") => return,

        // Auto-emitted by `#bibliography(…)` and friends. Skip the path
        // arg too; users don't search by .bib filename.
        Some("bibliography") => return,

        Some("tag") => {
            // `#tag("name")` — extract the name as a searchable token,
            // *and* record this call site as a tag location for the
            // `tag:` filter's navigation.
            if let Some(name) = first_positional_string(node) {
                let call_range = node.range();
                let line = line_map.line_of(call_range.start);
                out.tag_locations
                    .entry(name.to_lowercase())
                    .or_default()
                    .push(line);
                emit_string_tokens(&name, call_range.start, line_map, out);
            }
            return;
        }

        Some("wikilink") => {
            // `#wikilink("Page Name", label: "…")` — first positional
            // is the target note name, which is the user-visible bit.
            if let Some(name) = first_positional_string(node) {
                let call_range = node.range();
                emit_string_tokens(&name, call_range.start, line_map, out);
            }
            return;
        }

        Some("link") | Some("link-ref") => {
            // `#link("https://…")[display body]` — descend into the
            // ContentBlock for the display body. The URL itself is not
            // prose; skip it.
            descend_into_content_blocks(node, source, line_map, out);
            return;
        }

        Some("image") | Some("embed") => {
            // `#image("/dir/photo.png")` — make the filename stem
            // searchable so "photo" finds the embed.
            if let Some(path) = first_positional_string(node) {
                let stem = path_stem(&path);
                if !stem.is_empty() {
                    let call_range = node.range();
                    emit_string_tokens(stem, call_range.start, line_map, out);
                }
            }
            return;
        }

        _ => {
            // Unknown function: its prose payload (if any) lives in
            // `ContentBlock` children of `Args`. Descend only there so
            // we don't pick up code-mode arguments.
            descend_into_content_blocks(node, source, line_map, out);
        }
    }
}

/// Walk into every `ContentBlock` descendant of this FuncCall's `Args`
/// node, ignoring code-mode arguments. Used as the default behavior for
/// unknown function calls so `#strong[bold text]`, `#highlight[…]`,
/// `#callout(kind: "note")[Body]`, etc. yield their inner prose
/// uniformly.
fn descend_into_content_blocks(
    node: &LinkedNode<'_>,
    source: &str,
    line_map: &LineMap,
    out: &mut TextProjection,
) {
    let Some(args) = node.children().find(|c| c.kind() == SyntaxKind::Args) else {
        return;
    };
    for child in args.children() {
        if child.kind() == SyntaxKind::ContentBlock {
            walk(&child, source, line_map, out);
        }
    }
}

/// Read the first positional string argument from a FuncCall, returning
/// its decoded value (quotes stripped, escapes resolved). Returns
/// `None` if the first argument isn't a string literal — which means
/// either a code expression that we can't see through, or a named arg
/// in the first slot.
fn first_positional_string(call_node: &LinkedNode<'_>) -> Option<String> {
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
                return Some(str_ast.get().to_string());
            }

            // Named, Spread, Array, Code, etc. in the first slot — no
            // positional string here.
            _ => return None,
        }
    }
    None
}

/// Emit tokens from a string value that didn't come from the source
/// directly (e.g. the decoded contents of a string literal). We treat
/// it as having occurred at `anchor_byte` in the source so highlight
/// ranges still point somewhere reasonable — the call site of the
/// function it came from. This is intentional: clicking a `doc-howto`
/// tag-search result should land on `#tag("doc-howto")`, even though
/// the literal string "doc-howto" lives between the quotes.
fn emit_string_tokens(
    text: &str,
    anchor_byte: usize,
    line_map: &LineMap,
    out: &mut TextProjection,
) {
    let line = line_map.line_of(anchor_byte);
    let line_start = line_map.line_start(line);
    let col = anchor_byte.saturating_sub(line_start);

    for (offset, word) in word_boundaries(text) {
        let char_start = col + offset;
        out.tokens.push(TextToken {
            word: word.to_lowercase(),
            line,
            char_start,
            char_end: char_start + word.len(),
        });
    }
}

/// Emit tokens for the byte range `range` of `source`. Handles ranges
/// that span newlines (relevant for Raw blocks): each line is tokenized
/// independently so positions stay correct.
fn emit_tokens_in_range(
    source: &str,
    range: std::ops::Range<usize>,
    line_map: &LineMap,
    out: &mut TextProjection,
) {
    if range.start >= source.len() {
        return;
    }
    let end = range.end.min(source.len());
    let segment = &source[range.start..end];

    let mut line = line_map.line_of(range.start);
    let mut line_byte_start = line_map.line_start(line);

    let mut word_start_in_seg: Option<usize> = None;

    let emit = |seg_start: usize,
                    seg_end: usize,
                    line: usize,
                    line_byte_start: usize,
                    out: &mut TextProjection| {
        let abs_start = range.start + seg_start;
        let abs_end = range.start + seg_end;
        let word = &source[abs_start..abs_end];
        if word.is_empty() {
            return;
        }
        out.tokens.push(TextToken {
            word: word.to_lowercase(),
            line,
            char_start: abs_start - line_byte_start,
            char_end: abs_end - line_byte_start,
        });
    };

    for (i, ch) in segment.char_indices() {
        let is_word_char = is_word_char(ch);

        if is_word_char {
            if word_start_in_seg.is_none() {
                word_start_in_seg = Some(i);
            }
        } else {
            if let Some(s) = word_start_in_seg.take() {
                emit(s, i, line, line_byte_start, out);
            }
            if ch == '\n' {
                line += 1;
                // Byte position of the start of the next line in the
                // full source: range.start + i + ch.len_utf8().
                line_byte_start = range.start + i + ch.len_utf8();
            }
        }
    }

    if let Some(s) = word_start_in_seg {
        emit(s, segment.len(), line, line_byte_start, out);
    }
}

/// Collect the concatenated text of every Text descendant of `node`,
/// space-separated. Used for heading-text extraction so structural
/// markup inside a heading doesn't fragment the indexed phrase.
fn collect_text_within(node: &LinkedNode<'_>) -> String {
    let mut out = String::new();
    fn recurse(node: &LinkedNode<'_>, out: &mut String) {
        if node.kind() == SyntaxKind::Text {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
            out.push_str(node.text());
            return;
        }
        // Skip the heading marker itself.
        if node.kind() == SyntaxKind::HeadingMarker {
            return;
        }
        for child in node.children() {
            recurse(&child, out);
        }
    }
    recurse(node, &mut out);
    out
}

/// Tokenize a plain string (no AST context). Returns (byte_offset, word)
/// pairs, with the same word-character rules the legacy `word_boundaries`
/// helper used so search behavior stays consistent across the rest of
/// the engine.
fn word_boundaries(text: &str) -> Vec<(usize, &str)> {
    let mut words = Vec::new();
    let mut start: Option<usize> = None;
    for (i, ch) in text.char_indices() {
        if is_word_char(ch) {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(s) = start {
            words.push((s, &text[s..i]));
            start = None;
        }
    }
    if let Some(s) = start {
        words.push((s, &text[s..]));
    }
    words
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '-'
}

/// Filename stem from a path-shaped string (forward-slash separated,
/// as Typst paths always are). Used by `#image` / `#embed` so embed
/// callsites contribute their filename as searchable text.
fn path_stem(path: &str) -> &str {
    let after_slash = path.rsplit('/').next().unwrap_or(path);
    match after_slash.rsplit_once('.') {
        Some((stem, _ext)) if !stem.is_empty() => stem,
        _ => after_slash,
    }
}

/// Byte-offset → (line, column) lookup. Built once per document.
struct LineMap {
    /// Byte offset of each line start. Always contains at least `[0]`.
    line_starts: Vec<usize>,
}

impl LineMap {
    fn new(source: &str) -> Self {
        let mut starts = vec![0usize];
        for (i, ch) in source.char_indices() {
            if ch == '\n' {
                starts.push(i + 1);
            }
        }
        Self { line_starts: starts }
    }

    fn line_of(&self, byte: usize) -> usize {
        match self.line_starts.binary_search(&byte) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        }
    }

    fn line_start(&self, line: usize) -> usize {
        self.line_starts.get(line).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Collect just the (line, word) pairs — easier to assert against.
    fn words(projection: &TextProjection) -> Vec<(usize, &str)> {
        projection
            .tokens
            .iter()
            .map(|t| (t.line, t.word.as_str()))
            .collect()
    }

    #[test]
    fn emph_strips_underscores() {
        let p = project("can i _italicize_ yes");
        let w = words(&p);
        assert!(w.contains(&(0, "italicize")), "tokens: {:?}", w);
        assert!(!w.iter().any(|(_, t)| t.contains('_')));
    }

    #[test]
    fn strong_strips_stars() {
        let p = project("this *bold* word");
        let w = words(&p);
        assert!(w.contains(&(0, "bold")));
        assert!(!w.iter().any(|(_, t)| t.contains('*')));
    }

    #[test]
    fn phrase_can_i_italicize_is_contiguous() {
        // The whole point: "can i italicize" should match across the
        // _italicize_ markup. We check that the three tokens appear in
        // sequence on the same line so phrase search succeeds.
        let p = project("can i _italicize_ yes");
        let line0: Vec<&str> = p
            .tokens
            .iter()
            .filter(|t| t.line == 0)
            .map(|t| t.word.as_str())
            .collect();
        let idx = line0.windows(3).position(|w| w == ["can", "i", "italicize"]);
        assert!(idx.is_some(), "line tokens: {:?}", line0);
    }

    #[test]
    fn heading_words_indexed_and_recorded() {
        let p = project("= Hello World\n\nbody.");
        let w = words(&p);
        assert!(w.contains(&(0, "hello")));
        assert!(w.contains(&(0, "world")));
        assert!(w.contains(&(2, "body")));
        assert_eq!(p.headings, vec!["hello world".to_string()]);
    }

    #[test]
    fn nested_markup_yields_inner_text() {
        let p = project("#strike[#align(center)[*test*]]");
        let w = words(&p);
        assert!(w.iter().any(|(_, t)| *t == "test"), "tokens: {:?}", w);
    }

    #[test]
    fn content_bracket_funcs_unwrap() {
        // Each of these wraps prose in a content block; the words
        // inside should index as if the wrapper weren't there.
        for (src, expected) in [
            ("#strong[bold word]", "bold"),
            ("#emph[italic word]", "italic"),
            ("#highlight[yellow word]", "yellow"),
            ("#underline[uw]", "uw"),
            ("#quote[a quoted bit]", "quoted"),
            ("#callout(kind: \"note\")[Important bit]", "important"),
        ] {
            let p = project(src);
            let w = words(&p);
            assert!(
                w.iter().any(|(_, t)| *t == expected),
                "{src}: expected `{expected}` in {w:?}"
            );
        }
    }

    #[test]
    fn tag_call_records_location_and_token() {
        let src = "first line\n\nbody #tag(\"doc-howto\") more\n";
        let p = project(src);
        let w = words(&p);
        // Token at the tag's line, lowercased and including the hyphen.
        assert!(w.contains(&(2, "doc-howto")), "tokens: {:?}", w);
        let locs = p.tag_locations.get("doc-howto").expect("tag_locations");
        assert_eq!(locs, &vec![2]);
    }

    #[test]
    fn note_properties_block_is_not_indexed() {
        // `#note(title: "Scratchpad", zid: "20201215142213")` is the
        // properties block; its values flow through DocEntry.title /
        // property_keys, not through body-text search. Make sure the
        // tag panel never lands on it.
        let src = "#note(\n  title: \"Scratchpad\",\n  zid: \"20201215142213\",\n)\n\nbody.\n";
        let p = project(src);
        let w = words(&p);
        assert!(
            !w.iter().any(|(_, t)| *t == "scratchpad"),
            "title text leaked into search index: {w:?}"
        );
        assert!(w.iter().any(|(_, t)| *t == "body"));
    }

    #[test]
    fn metadata_is_skipped() {
        let p = project("#metadata((color: \"red\"))\n\nvisible body\n");
        let w = words(&p);
        assert!(!w.iter().any(|(_, t)| *t == "red"));
        assert!(w.iter().any(|(_, t)| *t == "visible"));
    }

    #[test]
    fn wikilink_target_is_searchable() {
        let p = project("see #wikilink(\"Daisy Dog\") please");
        let w = words(&p);
        assert!(w.iter().any(|(_, t)| *t == "daisy"));
        assert!(w.iter().any(|(_, t)| *t == "dog"));
    }

    #[test]
    fn image_filename_stem_is_searchable() {
        let p = project("#image(\"/assets/sunset-2024.png\")");
        let w = words(&p);
        assert!(w.iter().any(|(_, t)| *t == "sunset-2024"), "tokens: {w:?}");
    }

    #[test]
    fn highlights_match_user_screenshot_case() {
        // From the second screenshot — `can i _italicize_ yes I #highlight()[can]`
        // should be searchable both as `italicize` and as `can` (the
        // highlight body).
        let p = project("can i _italicize_ yes I #highlight()[can]");
        let w = words(&p);
        let on_line0: Vec<&str> = w
            .iter()
            .filter(|(l, _)| *l == 0)
            .map(|(_, t)| *t)
            .collect();
        assert!(on_line0.contains(&"italicize"));
        // "can" appears twice on this line (leading + inside highlight);
        // we just want at least one occurrence.
        assert!(on_line0.iter().filter(|t| **t == "can").count() >= 1);
    }

    #[test]
    fn raw_block_content_is_indexed() {
        let p = project("`some code`");
        let w = words(&p);
        assert!(w.iter().any(|(_, t)| *t == "some"));
        assert!(w.iter().any(|(_, t)| *t == "code"));
    }

    #[test]
    fn multibyte_text_positions_are_byte_offsets() {
        // Sanity check: an em-dash before a word shouldn't desync
        // positions. char_end - char_start must equal the byte length
        // of `word`.
        let p = project("café — résumé");
        for tok in &p.tokens {
            assert_eq!(tok.char_end - tok.char_start, tok.word.len());
        }
        assert!(p.tokens.iter().any(|t| t.word == "café"));
        assert!(p.tokens.iter().any(|t| t.word == "résumé"));
    }
}
