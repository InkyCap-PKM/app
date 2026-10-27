//! Plain-text projection of a note for full-text search.
//!
//! Search should match prose, not raw source: `_italicize_` must be found by
//! "italicize". Per CLAUDE.md's Typst-first principle, the source is parsed
//! with `typst::syntax::parse` and walked to collect `Text` leaves, plus the
//! text arguments of a few functions (tag, wikilink, link, image and embed
//! names). Markup (`Emph`, `Strong`, content-bracket calls, headings, list
//! items) drops out because it wraps the text rather than containing it.
//!
//! Each token keeps its source byte range, so matches are highlighted in the
//! real source.

use std::collections::HashMap;

use crate::typst_pipeline::syntax::{ast, parse, LinkedNode, SyntaxKind};

/// One word and where it appears. `line` is 0-based; `char_start` / `char_end`
/// are byte offsets in the line, as in the engine's `WordPosition`.
#[derive(Debug, Clone)]
pub struct TextToken {
    pub word: String,
    pub line: usize,
    pub char_start: usize,
    pub char_end: usize,
    /// True when punctuation (comma, bracket, sentence end, dash, …) separates
    /// this token from the previous one. N-gram extraction breaks phrases here,
    /// so "(CIADI, Milieux, NextGen Cities)" doesn't produce cross-item
    /// phrases.
    pub phrase_break_before: bool,
}

/// Output of [`project`]: searchable tokens plus a few structural
/// indexes the engine consumes directly.
#[derive(Debug, Clone, Default)]
pub struct TextProjection {
    /// All searchable tokens in source order.
    pub tokens: Vec<TextToken>,
    /// Tag name → line indices of its `#tag("…")` calls, so `tag:` results open
    /// on the tag.
    pub tag_locations: HashMap<String, Vec<usize>>,
    /// Heading text (lowercased) collected from every `Heading` node,
    /// for the `section:` filter.
    pub headings: Vec<String>,
    /// Lowercased first level-1 heading, used for the title bonus when there's
    /// no `#note(title: …)`.
    pub first_h1: Option<String>,
    /// Sorted line indices inside `#annotation[…]` or `#suggestion[…]`, for the
    /// Annotations scope and `annotation:` navigation.
    pub annotation_lines: Vec<usize>,
    /// Lowercased body text of every annotation and suggestion, for the
    /// `annotation:` filter.
    pub annotation_text: String,
    /// Build state: set after a separating character so the next token,
    /// possibly from another node, starts a new phrase.
    pending_break: bool,
}

/// Walk the parsed AST and produce a [`TextProjection`].
pub fn project(source: &str) -> TextProjection {
    let line_map = LineMap::new(source);
    let root = parse(source);
    let link = LinkedNode::new(&root);

    let mut out = TextProjection::default();
    walk(&link, source, &line_map, &mut out);
    out.annotation_lines.sort_unstable();
    out.annotation_lines.dedup();
    out
}

/// Occurrences of `phrase` in `tokens`, as (first, last) token indices. The
/// words must match consecutive tokens on one line, ignoring case.
pub fn phrase_matches(tokens: &[TextToken], phrase: &str) -> Vec<(usize, usize)> {
    let words: Vec<String> = phrase.split_whitespace().map(str::to_lowercase).collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for i in 0..tokens.len() {
        let matched = words.iter().enumerate().all(|(k, w)| {
            tokens
                .get(i + k)
                .is_some_and(|t| t.word.to_lowercase() == *w && t.line == tokens[i].line)
        });
        if matched {
            out.push((i, i + words.len() - 1));
        }
    }
    out
}

/// Byte ranges of `phrase` in `source`'s prose, matched as [`phrase_matches`]
/// does, so properties, code and comments never match.
pub fn phrase_ranges(source: &str, phrase: &str) -> Vec<std::ops::Range<usize>> {
    let line_map = LineMap::new(source);
    let tokens = project(source).tokens;
    phrase_matches(&tokens, phrase)
        .into_iter()
        .map(|(first, last)| {
            let (first, last) = (&tokens[first], &tokens[last]);
            line_map.line_start(first.line) + first.char_start
                ..line_map.line_start(last.line) + last.char_end
        })
        .collect()
}

/// Walk the tree. Descends into every child except nodes to skip (code, labels,
/// math, comments, notebox metadata) and calls whose text comes from their
/// arguments.
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

        // Code isn't prose. Prose arguments are in `ContentBlock`s, reached
        // through `handle_func_call`.
        SyntaxKind::CodeBlock | SyntaxKind::Code => return,

        SyntaxKind::Heading => {
            // Heading text for the `section:` filter, from all its text (`=
            // Hello *world*` → "hello world").
            let heading_text = collect_text_within(node);
            let trimmed = heading_text.trim();
            if !trimmed.is_empty() {
                let lowered = trimmed.to_lowercase();
                // The first level-1 heading is the title fallback. `depth` is
                // the number of `=`.
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
            // Index code so identifiers can be found. There's no byte range for
            // the body alone, so tokenize the node's range; backticks aren't
            // word characters.
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

/// Function calls. A few InkyCap functions keep their searchable text in a
/// string argument; every other call contributes only its `ContentBlock`s, so
/// `#strong[…]`, `#highlight[…]`, `#callout(…)[…]` and user functions all work.
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
        Some("note") => (),

        // Runtime hooks emitted by lib.typ — never user-visible prose.
        Some("metadata") => (),

        // Auto-emitted by `#bibliography(…)` and friends. Skip the path
        // arg too; users don't search by .bib filename.
        Some("bibliography") => (),

        Some("tag") => {
            // `#tag("name")`: index the name and record the call for `tag:`
            // navigation.
            if let Some((name, anchor)) = first_positional_string_at(node) {
                let line = line_map.line_of(anchor);
                out.tag_locations
                    .entry(name.to_lowercase())
                    .or_default()
                    .push(line);
                emit_string_tokens(&name, anchor, line_map, out);
            }
        }

        Some("wikilink") => {
            // `#wikilink("Page Name", …)`: index the target name, anchored at
            // the string so a match highlights the name.
            if let Some((name, anchor)) = first_positional_string_at(node) {
                emit_string_tokens(&name, anchor, line_map, out);
            }
        }

        Some("annotation") | Some("suggestion") => {
            // `#annotation[…]` / `#suggestion(…)[…]`: record the lines and body
            // text, then descend so the body is still searchable.
            let range = node.range();
            let start_line = line_map.line_of(range.start);
            let end_line = line_map.line_of(range.end.saturating_sub(1).max(range.start));
            for l in start_line..=end_line {
                out.annotation_lines.push(l);
            }
            let body = collect_text_within(node);
            let body = body.trim();
            if !body.is_empty() {
                if !out.annotation_text.is_empty() {
                    out.annotation_text.push(' ');
                }
                out.annotation_text.push_str(&body.to_lowercase());
            }
            // A suggestion's `note:` is its reviewer comment; include it for
            // `annotation:`.
            if let Some(note) = named_string_arg(node, "note") {
                let note = note.trim();
                if !note.is_empty() {
                    if !out.annotation_text.is_empty() {
                        out.annotation_text.push(' ');
                    }
                    out.annotation_text.push_str(&note.to_lowercase());
                }
            }
            descend_into_content_blocks(node, source, line_map, out);
        }

        Some("link") | Some("link-ref") => {
            // `#link("…")[text]`: index the text, not the URL.
            descend_into_content_blocks(node, source, line_map, out);
        }

        Some("image") => {
            // `#image("/dir/photo.png")` — make the filename stem
            // searchable so "photo" finds the image.
            if let Some((path, anchor)) = first_positional_string_at(node) {
                let stem = path_stem(&path);
                if !stem.is_empty() {
                    // Anchor at the stem's offset within the path string so the
                    // highlight lands on the filename, not the `#image(` markup.
                    let stem_offset = stem.as_ptr() as usize - path.as_ptr() as usize;
                    emit_string_tokens(stem, anchor + stem_offset, line_map, out);
                }
            }
        }

        _ => {
            // Other functions: only their `ContentBlock` arguments are prose.
            descend_into_content_blocks(node, source, line_map, out);
        }
    }
}

/// Walk the `ContentBlock` arguments of this call, skipping code arguments.
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

/// The string value of a named argument `name: "…"` on a call, if present
/// (e.g. a `#suggestion`'s `note:` reviewer comment).
fn named_string_arg(call_node: &LinkedNode<'_>, name: &str) -> Option<String> {
    let args_node = call_node
        .children()
        .find(|c| c.kind() == SyntaxKind::Args)?;
    for child in args_node.children() {
        if child.kind() != SyntaxKind::Named {
            continue;
        }
        let Some(named) = child.cast::<ast::Named>() else {
            continue;
        };
        if named.name().as_str() != name {
            continue;
        }
        if let ast::Expr::Str(s) = named.expr() {
            return Some(s.get().to_string());
        }
    }
    None
}

/// The first positional string argument and the byte offset of its content
/// (after the opening quote), so a match highlights the argument rather than
/// `#func(`. Escapes in the string can shift the highlight slightly.
fn first_positional_string_at(call_node: &LinkedNode<'_>) -> Option<(String, usize)> {
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
                // The Str node's range spans the surrounding quotes; its
                // content begins one byte past the opening `"`.
                let content_start = child.range().start + 1;
                return Some((str_ast.get().to_string(), content_start));
            }

            // Named, Spread, Array, Code, etc. in the first slot — no
            // positional string here.
            _ => return None,
        }
    }
    None
}

/// Emit tokens from a decoded string, placed at `anchor_byte` in the source.
fn emit_string_tokens(
    text: &str,
    anchor_byte: usize,
    line_map: &LineMap,
    out: &mut TextProjection,
) {
    let line = line_map.line_of(anchor_byte);
    let line_start = line_map.line_start(line);
    let col = anchor_byte.saturating_sub(line_start);

    let mut prev_word_end = 0usize;
    let mut first = true;
    for (offset, word) in word_boundaries(text) {
        let char_start = col + offset;
        let break_before =
            (first && out.pending_break) || gap_breaks_phrase(&text[prev_word_end..offset]);
        out.tokens.push(TextToken {
            word: word.to_lowercase(),
            line,
            char_start,
            char_end: char_start + word.len(),
            phrase_break_before: break_before,
        });
        if first {
            out.pending_break = false;
            first = false;
        }
        prev_word_end = offset + word.len();
    }
    // A separator after the last word carries to the next emitted token.
    if gap_breaks_phrase(&text[prev_word_end..]) {
        out.pending_break = true;
    }
}

/// Emit tokens for `range` of `source`, line by line so positions stay right
/// across newlines.
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
    // End of the previous word in `segment`, so the characters between words
    // can be checked for punctuation.
    let mut prev_word_end_in_seg: usize = 0;

    let emit = |seg_start: usize,
                seg_end: usize,
                line: usize,
                line_byte_start: usize,
                prev_end: usize,
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
            phrase_break_before: gap_breaks_phrase(&segment[prev_end..seg_start]),
        });
    };

    // OR a carried-over phrase break (a separator at the tail of an earlier
    // node) into the first token this call emits, then clear it.
    let mut first = true;
    let mut consume_pending = |out: &mut TextProjection| {
        if first {
            if out.pending_break {
                if let Some(tok) = out.tokens.last_mut() {
                    tok.phrase_break_before = true;
                }
                out.pending_break = false;
            }
            first = false;
        }
    };

    for (i, ch) in segment.char_indices() {
        let is_word_char = is_word_char(ch);

        if is_word_char {
            if word_start_in_seg.is_none() {
                word_start_in_seg = Some(i);
            }
        } else {
            if let Some(s) = word_start_in_seg.take() {
                emit(s, i, line, line_byte_start, prev_word_end_in_seg, out);
                consume_pending(out);
                prev_word_end_in_seg = i;
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
        emit(
            s,
            segment.len(),
            line,
            line_byte_start,
            prev_word_end_in_seg,
            out,
        );
        consume_pending(out);
        prev_word_end_in_seg = segment.len();
    }

    // A separator in the segment tail (after the last word — or the whole
    // segment, if it held no words) carries to the next token emitted.
    if gap_breaks_phrase(&segment[prev_word_end_in_seg..]) {
        out.pending_break = true;
    }
}

/// All text under `node`, space-separated, so markup inside a heading doesn't
/// split it.
fn collect_text_within(node: &LinkedNode<'_>) -> String {
    let mut out = String::new();
    fn recurse(node: &LinkedNode<'_>, out: &mut String) {
        if node.kind() == SyntaxKind::Text {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
            out.push_str(node.leaf_text());
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

/// Split a string into (byte offset, word) pairs using the engine's word rules.
/// Also used for file names, so they match like body text.
pub(crate) fn word_boundaries(text: &str) -> Vec<(usize, &str)> {
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

/// A character that separates phrases: commas, brackets, sentence ends, dashes,
/// quotes. Punctuation inside words (`'` in "don't", `-` in "gasoline-powered")
/// isn't included.
fn is_phrase_separator(ch: char) -> bool {
    matches!(
        ch,
        ',' | ';'
            | ':'
            | '.'
            | '!'
            | '?'
            | '('
            | ')'
            | '['
            | ']'
            | '{'
            | '}'
            | '/'
            | '\\'
            | '|'
            | '"'
            | '«'
            | '»'
            | '\u{201C}'
            | '\u{201D}'
            | '\u{2026}'
            | '\u{2014}'
            | '\u{2013}'
    )
}

/// True when the run of characters between two adjacent words contains a
/// phrase boundary — separating punctuation or a line break.
fn gap_breaks_phrase(gap: &str) -> bool {
    gap.chars().any(|c| c == '\n' || is_phrase_separator(c))
}

/// File stem of a `/`-separated path, so `#image` contributes its file name.
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
        Self {
            line_starts: starts,
        }
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

/// A question sentence located in a document's prose, for the Mycelial
/// View's open-questions gap signal.
#[derive(Debug, Clone)]
pub struct QuestionSpan {
    /// 0-based line index.
    pub line: usize,
    /// Byte offset within the line of the sentence's first prose token.
    pub char_start: usize,
    /// Byte offset within the line just past the `?`.
    pub char_end: usize,
    /// The sentence text (line slice, trimmed).
    pub text: String,
}

/// Questions in `content`: a `?` directly after prose (not inside markup, code
/// or a URL), with at least `min_words` words since the last sentence end on
/// the line. At most `max`, in document order.
///
/// Uses the same projection as the corpus engine, so questions in `#note(...)`
/// or imports never appear. Sentences end at line breaks.
pub fn extract_questions(
    content: &str,
    projection: &TextProjection,
    min_words: usize,
    max: usize,
) -> Vec<QuestionSpan> {
    let mut out: Vec<QuestionSpan> = Vec::new();
    if max == 0 {
        return out;
    }
    for (li, line) in content.lines().enumerate() {
        if out.len() >= max {
            break;
        }
        if !line.contains('?') {
            continue;
        }
        // The projector's tokens on this line, in source order.
        let toks: Vec<&TextToken> = projection.tokens.iter().filter(|t| t.line == li).collect();
        if toks.is_empty() {
            continue;
        }
        for (qpos, _) in line.match_indices('?') {
            if out.len() >= max {
                break;
            }
            // The `?` must directly follow a token (a closing bracket or quote
            // may come between).
            let before = line[..qpos]
                .trim_end()
                .trim_end_matches([')', ']', '}', '"', '\'', '\u{201d}', '\u{2019}', '\u{00bb}']);
            let prose_end = before.len();
            if prose_end == 0 {
                continue;
            }
            let Some(last_idx) = toks.iter().rposition(|t| t.char_end == prose_end) else {
                continue;
            };
            // Sentence start: just past the previous sentence terminator on
            // this line, else the line start.
            let sent_start = line[..qpos]
                .rfind(['.', '!', '?', ';'])
                .map(|i| i + 1)
                .unwrap_or(0);
            let Some(first_idx) = toks.iter().position(|t| t.char_start >= sent_start) else {
                continue;
            };
            if first_idx > last_idx {
                continue;
            }
            // Fragments below `min_words` are rhetorical shrugs, not open
            // questions worth surfacing.
            if last_idx - first_idx + 1 < min_words {
                continue;
            }
            let char_start = toks[first_idx].char_start;
            // `?` is one ASCII byte, so `qpos + 1` lands on a char boundary.
            let char_end = qpos + 1;
            out.push(QuestionSpan {
                line: li,
                char_start,
                char_end,
                text: line[char_start..char_end].trim().to_string(),
            });
        }
    }
    out
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
        // "can i italicize" must match across the `_italicize_` markup.
        let p = project("can i _italicize_ yes");
        let line0: Vec<&str> = p
            .tokens
            .iter()
            .filter(|t| t.line == 0)
            .map(|t| t.word.as_str())
            .collect();
        let idx = line0
            .windows(3)
            .position(|w| w == ["can", "i", "italicize"]);
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
        // The `#note(...)` block is properties, not body text; the tag panel
        // must never land on it.
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
    fn wikilink_token_anchors_to_argument_not_markup() {
        // A match in `#wikilink("…")` highlights the argument, not the markup.
        let src = "see #wikilink(\"journalism\") ok";
        let p = project(src);
        let t = p
            .tokens
            .iter()
            .find(|t| t.word == "journalism")
            .expect("journalism token");
        assert_eq!(
            &src[t.char_start..t.char_end],
            "journalism",
            "token anchored at wrong source span"
        );
    }

    #[test]
    fn tag_token_anchors_to_argument_not_markup() {
        let src = "body #tag(\"doc-howto\") more";
        let p = project(src);
        let t = p
            .tokens
            .iter()
            .find(|t| t.word == "doc-howto")
            .expect("tag token");
        assert_eq!(&src[t.char_start..t.char_end], "doc-howto");
    }

    #[test]
    fn image_filename_stem_is_searchable() {
        let p = project("#image(\"/assets/sunset-2024.png\")");
        let w = words(&p);
        assert!(w.iter().any(|(_, t)| *t == "sunset-2024"), "tokens: {w:?}");
    }

    #[test]
    fn highlights_match_user_screenshot_case() {
        // Both `italicize` and the highlight body `can` are searchable.
        let p = project("can i _italicize_ yes I #highlight()[can]");
        let w = words(&p);
        let on_line0: Vec<&str> = w.iter().filter(|(l, _)| *l == 0).map(|(_, t)| *t).collect();
        assert!(on_line0.contains(&"italicize"));
        // "can" appears twice on this line (leading + inside highlight);
        // we just want at least one occurrence.
        assert!(on_line0.iter().filter(|t| **t == "can").count() >= 1);
    }

    /// Find the first token with a given word.
    fn tok<'a>(p: &'a TextProjection, word: &str) -> &'a TextToken {
        p.tokens
            .iter()
            .find(|t| t.word == word)
            .unwrap_or_else(|| panic!("token `{word}` not found"))
    }

    #[test]
    fn comma_marks_a_phrase_break() {
        let p = project("alpha beta, gamma delta");
        assert!(!tok(&p, "alpha").phrase_break_before);
        assert!(!tok(&p, "beta").phrase_break_before);
        // The comma sits between `beta` and `gamma`.
        assert!(tok(&p, "gamma").phrase_break_before);
        assert!(!tok(&p, "delta").phrase_break_before);
    }

    #[test]
    fn parenthetical_list_items_each_break() {
        // Each list item after a paren or comma starts a new phrase.
        let p = project("4 institutes (ciadi, milieux, nextgen, appliedai)");
        for w in ["ciadi", "milieux", "nextgen", "appliedai"] {
            assert!(
                tok(&p, w).phrase_break_before,
                "`{w}` should start a fresh phrase run"
            );
        }
    }

    #[test]
    fn plain_prose_has_no_phrase_breaks() {
        // Words separated only by spaces (and formatting markup) are one run.
        let p = project("the *quick* brown fox");
        for w in ["quick", "brown", "fox"] {
            assert!(!tok(&p, w).phrase_break_before, "`{w}` unexpectedly broke");
        }
    }

    #[test]
    fn annotation_and_suggestion_lines_and_body_recorded() {
        let src = "body line\n\n#annotation[needs a citation]\n\n#suggestion(kind: \"insert\", note: \"tighten wording\")[new bit]\n";
        let p = project(src);
        // Lines 2 and 4 (0-based) carry the annotation/suggestion calls.
        assert!(
            p.annotation_lines.contains(&2),
            "lines: {:?}",
            p.annotation_lines
        );
        assert!(
            p.annotation_lines.contains(&4),
            "lines: {:?}",
            p.annotation_lines
        );
        // Body prose is captured for the `annotation:` filter…
        assert!(
            p.annotation_text.contains("needs a citation"),
            "text: {:?}",
            p.annotation_text
        );
        assert!(
            p.annotation_text.contains("new bit"),
            "text: {:?}",
            p.annotation_text
        );
        // …including a suggestion's `note:` reviewer comment…
        assert!(
            p.annotation_text.contains("tighten wording"),
            "text: {:?}",
            p.annotation_text
        );
        // …but the `kind:` markup keyword is not.
        assert!(
            !p.annotation_text.contains("kind"),
            "text: {:?}",
            p.annotation_text
        );
        // The body still indexes as ordinary searchable prose.
        let w = words(&p);
        assert!(w.iter().any(|(_, t)| *t == "citation"));
        assert!(w.iter().any(|(_, t)| *t == "bit"));
    }

    #[test]
    fn questions_require_min_words_and_prose_adjacency() {
        let src = "How does mycelium route nutrients under stress? Why?\nSee https://example.com/a?b=c for details.";
        let p = project(src);
        let qs = extract_questions(src, &p, 4, 10);
        assert_eq!(qs.len(), 1, "got: {qs:?}");
        assert!(qs[0].text.starts_with("How does mycelium"));
        assert!(qs[0].text.ends_with('?'));
        assert_eq!(qs[0].line, 0);
        // The span slices cleanly out of the source line.
        let line = src.lines().next().unwrap();
        assert_eq!(&line[qs[0].char_start..qs[0].char_end], qs[0].text);
    }

    #[test]
    fn questions_handle_multibyte_text() {
        let src = "Qu'est-ce que ça implique pour la mémoire collective?";
        let p = project(src);
        let qs = extract_questions(src, &p, 4, 10);
        assert_eq!(qs.len(), 1, "got: {qs:?}");
        assert!(qs[0].text.ends_with('?'));
        // Byte offsets land on char boundaries even with multi-byte chars.
        assert_eq!(&src[qs[0].char_start..qs[0].char_end], qs[0].text);
    }

    #[test]
    fn questions_ignore_note_metadata_lines() {
        let src = "#note(\n  title: \"A question here or not?\",\n)\nDoes the projation exclusion keep metadata questions out?";
        let p = project(src);
        let qs = extract_questions(src, &p, 4, 10);
        assert_eq!(qs.len(), 1, "got: {qs:?}");
        assert_eq!(qs[0].line, 3);
    }

    #[test]
    fn questions_respect_caps_and_sentence_splits() {
        let src =
            "First real question sits right here? Second real question follows directly after?";
        let p = project(src);
        let all = extract_questions(src, &p, 4, 10);
        assert_eq!(all.len(), 2, "got: {all:?}");
        assert!(all[1].text.starts_with("Second"));
        let capped = extract_questions(src, &p, 4, 1);
        assert_eq!(capped.len(), 1);
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
        // An em dash before a word keeps positions in sync.
        let p = project("café — résumé");
        for tok in &p.tokens {
            assert_eq!(tok.char_end - tok.char_start, tok.word.len());
        }
        assert!(p.tokens.iter().any(|t| t.word == "café"));
        assert!(p.tokens.iter().any(|t| t.word == "résumé"));
    }
}
