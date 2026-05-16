// ---------------------------------------------------------------------------
// Why this is a Rust-side converter and not a Typst package
// ---------------------------------------------------------------------------
//
// The Typst-native option here would be the `cmarker` package, which
// renders CommonMark inside Typst. We deliberately don't use it because:
//
// 1. `cmarker` is consume-only (md → rendered output). It can't produce a
//    `.typ` source file we can store as a note, which is what every InkyCap
//    import path needs.
// 2. InkyCap markdown carries first-class extensions — wikilinks, Obsidian
//    tags, `==highlight==`, YAML frontmatter mapped to `#note(...)`. None of
//    these survive a generic CommonMark parser; they have to be transformed
//    pre-parse into their Typst-package equivalents (`#wikilink`, `#tag`,
//    `#highlight`, `#note`).
//
// So the converter stays in Rust — it's not duplicating Typst, it's bridging
// markdown semantics into our package's vocabulary. Per CLAUDE.md's
// Typst-first principle: this is the "last resort, necessary to accomplish
// something important" case. Don't replace this with a Typst-side renderer
// without a plan for the four extensions above.
// ---------------------------------------------------------------------------

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd, CodeBlockKind, HeadingLevel};
use regex::Regex;
use std::sync::LazyLock;

/// Source-markdown dialect the converter should assume. The two flavors
/// diverge in three meaningful places:
///
/// - **`#word` semantics.** In Obsidian, `#word` after whitespace is a
///   tag and the user has already `\#`-escaped any literal hashes.
///   In standard markdown, `#` is purely literal (CommonMark only
///   reserves it at line-start for headings, which pulldown-cmark
///   consumes) so we must escape every `#` in pass-through text so
///   things like prices, version numbers, and issue refs survive.
/// - **`$…$` math.** Obsidian honors `$inline$` and `$$display$$`
///   math; CommonMark does not. We enable pulldown-cmark's math
///   extension only for Obsidian — otherwise `$6000 + travel $3000`
///   parses as one math span.
/// - **`%%comment%%`.** Obsidian's inline-comment syntax; stripped
///   pre-parse in Obsidian, left as-is for standard.
///
/// Wikilink syntax (`[[…]]`), image embeds (`![[…]]`), and
/// `==highlight==` are converted in both dialects — they're widely
/// used outside Obsidian (Logseq, Foam, Pandoc) and not at risk of
/// colliding with anything in standard markdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkdownDialect {
    /// CommonMark / GitHub-Flavored Markdown. `#` is always literal
    /// outside heading positions; no math; no `%%` comments.
    Standard,
    /// Obsidian-flavored markdown. Tag syntax, `$…$` math,
    /// `%%comment%%`, callout blockquotes.
    Obsidian,
}

impl Default for MarkdownDialect {
    fn default() -> Self {
        Self::Standard
    }
}

/// Options controlling the markdown-to-typst conversion.
#[derive(Debug, Clone)]
pub struct MarkdownToTypstOptions {
    /// Whether to convert YAML frontmatter into a `#note(...)` call.
    /// When false, frontmatter is silently dropped.
    pub convert_frontmatter: bool,
    /// Notebox attachment folder (relative to notebox root, without leading
    /// slash) used to construct paths for Obsidian-style image embeds
    /// `![[name.png]]`. The importer routes referenced files into this
    /// folder so the emitted call `#image("/<attachment_folder>/name.png")`
    /// resolves to the file's post-import location.
    pub attachment_folder: String,
    /// Source-markdown dialect — see [`MarkdownDialect`].
    pub dialect: MarkdownDialect,
}

impl Default for MarkdownToTypstOptions {
    fn default() -> Self {
        Self {
            convert_frontmatter: true,
            // Mirrors `FileSettings::default().attachment_folder` so a
            // bare-options conversion still emits a sensible path.
            attachment_folder: "assets".to_string(),
            dialect: MarkdownDialect::default(),
        }
    }
}

/// `![[name.png|alt]]` — Obsidian-style image embed. Must run BEFORE
/// the wikilink regex so the `[[name]]` portion isn't matched as a
/// plain wikilink and the leading `!` left orphaned. The alt-text
/// group (after `|`) is captured but currently dropped on emit:
/// `#image` in Typst doesn't take an alt argument; if we later want
/// to preserve it for search/accessibility, the place to do so is in
/// the replacement closure.
static IMAGE_EMBED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap());

static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap());

static OBSIDIAN_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)").unwrap());

static OBSIDIAN_HIGHLIGHT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"==([^=\n>][^=\n]*)==").unwrap());

/// Obsidian inline-comment syntax: `%%comment%%`. Renders to nothing in
/// Obsidian; we strip it pre-parse for the Obsidian dialect only.
/// `(?s)` makes `.` match newlines so multi-line comments are caught.
static OBSIDIAN_COMMENT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)%%.*?%%").unwrap());



/// Extract the set of filenames referenced by Obsidian-style image
/// embeds (`![[name.png]]`) in a markdown source. The importer uses
/// this to decide which files in the source notebox should be routed
/// into the user's `attachment_folder` instead of preserving their
/// original relative paths.
pub fn extract_embed_filenames(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    for caps in IMAGE_EMBED_RE.captures_iter(input) {
        out.push(caps[1].trim().to_string());
    }
    out
}

/// Convert a markdown string to InkyCap-flavored Typst source.
pub fn markdown_to_typst(input: &str, options: &MarkdownToTypstOptions) -> String {
    let (frontmatter, body) = extract_frontmatter(input);

    let mut out = String::with_capacity(input.len());

    // Emit import preamble.
    let _ = options; // reserved for future conversion knobs
    out.push_str(&crate::notebox_package::import_line());
    out.push('\n');

    // Emit #note(...) from frontmatter.
    if options.convert_frontmatter {
        if let Some(fm) = frontmatter {
            let note_call = frontmatter_to_note(&fm);
            if !note_call.is_empty() {
                out.push('\n');
                out.push_str(&note_call);
                out.push('\n');
            }
        }
    }

    out.push('\n');

    // Pre-process: replace wikilinks, image embeds, and (Obsidian
    // dialect only) tags + `%%comments%%` before parsing.
    // pulldown-cmark splits text around `[` characters, so wikilink
    // patterns never arrive as a single text event.
    let preprocessed = preprocess_markdown(
        body,
        &options.attachment_folder,
        options.dialect,
    );

    // `$…$` math is an Obsidian/Pandoc extension, not CommonMark.
    // Enabling it in the Standard dialect would consume things like
    // `salary + $6000 ... $3000 ...` as a math span.
    let mut md_options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS;
    if matches!(options.dialect, MarkdownDialect::Obsidian) {
        md_options |= Options::ENABLE_MATH;
    }

    let parser = Parser::new_ext(&preprocessed, md_options);
    let mut converter = Converter::new(&mut out);
    converter.convert(parser);

    // Standard-dialect post-pass: escape any `#` that isn't part of a
    // recognized Typst function call we emit. This runs on the full
    // assembled output (not per-`Event::Text`) because pulldown-cmark
    // can split a call like `#highlight[yellow]` across text events —
    // `#highlight` arrives alone, `[yellow]` separately — and we need
    // both visible together to decide whether the leading `#` should
    // survive.
    if matches!(options.dialect, MarkdownDialect::Standard) {
        out = escape_unrecognized_hashes(&out);
    }

    out
}

/// Names of Typst function calls the converter emits with a leading
/// `#`. Used by the Standard-dialect post-pass to preserve their `#`
/// while escaping every other occurrence in user prose.
///
/// `import` and `note` appear in the file preamble; the rest are
/// emitted from various converter paths and from preprocessor
/// rewrites (`#tag`, `#wikilink`, `#image`, `#highlight`).
const EMITTED_TYPST_CALLS: &[&str] = &[
    "import",
    "note",
    "wikilink",
    "image",
    "highlight",
    "tag",
    "link",
    "callout",
    "quote",
    "strike",
    "table",
    "line",
    "footnote",
];

fn escape_unrecognized_hashes(text: &str) -> String {
    // Hand-rolled scan because the `regex` crate doesn't do lookahead
    // (and depending on `fancy-regex` for this one decision isn't
    // worth it). Walk the source byte-by-byte; at every `#`, check
    // whether the next identifier is in [`EMITTED_TYPST_CALLS`] and
    // is terminated by a non-word char or end-of-input. If so, leave
    // the `#` alone; otherwise emit `\#`.
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            let after_hash = i + 1;
            // Scan an ASCII-identifier-like word: [a-zA-Z][a-zA-Z0-9_-]*
            // Names are all ASCII-lowercase, so we don't need to worry
            // about UTF-8 byte boundaries here.
            let mut j = after_hash;
            while j < bytes.len() {
                let b = bytes[j];
                let is_word =
                    b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
                if !is_word {
                    break;
                }
                j += 1;
            }
            let ident = &text[after_hash..j];
            if !ident.is_empty()
                && EMITTED_TYPST_CALLS.iter().any(|n| *n == ident)
            {
                // Recognized call — keep `#name` intact, copy through.
                out.push_str(&text[i..j]);
                i = j;
                continue;
            }
            // Unrecognized — escape the `#`.
            out.push_str("\\#");
            i += 1;
            continue;
        }
        // Copy this UTF-8 codepoint as-is. We can't index byte-by-byte
        // into the output string for multi-byte chars without care, so
        // walk by char_indices when the byte is non-ASCII.
        if bytes[i].is_ascii() {
            out.push(bytes[i] as char);
            i += 1;
        } else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Pre-process markdown source to replace wikilinks and (in Obsidian
/// mode) tag/comment syntax with their Typst equivalents before the
/// markdown parser sees them.
///
/// `attachment_folder` is the notebox-relative folder (no leading slash)
/// the importer routes `![[name.png]]` embeds into; the emitted
/// `#image("/<attachment_folder>/name")` path matches where the file
/// will actually land post-import.
fn preprocess_markdown(
    input: &str,
    attachment_folder: &str,
    dialect: MarkdownDialect,
) -> String {
    // Order matters: replace Obsidian tags FIRST (so `#wikilink` produced by
    // the wikilink pass isn't falsely matched as a tag), and image embeds
    // before plain wikilinks (since `![[…]]` overlaps `[[…]]` and the
    // generic wikilink replacement would leave the `!` orphaned otherwise).
    let mut result = input.to_string();

    // `%%comment%%` — Obsidian inline comments. Strip pre-parse so they
    // never appear in the converted note. Multi-line comments are
    // supported via the `(?s)` flag on the regex.
    if matches!(dialect, MarkdownDialect::Obsidian) {
        result = OBSIDIAN_COMMENT_RE.replace_all(&result, "").into_owned();
    }

    // Replace Obsidian-style tags, but not inside code fences. Only in
    // the Obsidian dialect: in Standard markdown a leading `#` after
    // whitespace is just a literal character (`issue #42`, `version #2`,
    // `model #abc-xyz`), and we must leave it alone so the later
    // text-escape pass can `\#` it.
    if matches!(dialect, MarkdownDialect::Obsidian) {
        let mut in_code_fence = false;
        let lines: Vec<String> = result
            .lines()
            .map(|line| {
                if line.trim_start().starts_with("```") {
                    in_code_fence = !in_code_fence;
                    return line.to_string();
                }
                if in_code_fence {
                    return line.to_string();
                }
                OBSIDIAN_TAG_RE
                    .replace_all(line, |caps: &regex::Captures| {
                        let tag_name = &caps[1];
                        let flat_name = tag_name.replace('/', "-");
                        let full = &caps[0];
                        let prefix = if full.starts_with(char::is_whitespace) {
                            &full[..full.len() - full.trim_start().len()]
                        } else {
                            ""
                        };
                        format!("{}#tag(\"{}\")", prefix, flat_name)
                    })
                    .into_owned()
            })
            .collect();
        result = lines.join("\n");
    }

    // Replace `![[name.png]]` image embeds BEFORE wikilinks so the
    // generic wikilink pass doesn't strip the `[[…]]` and leave the
    // `!` dangling as `!#wikilink(...)`. The filename's spaces and
    // other URL-unsafe characters are left as-is — Typst paths accept
    // them inside quoted strings. Path is rooted at notebox root (Per
    // CLAUDE.md's portable-paths principle) and joins the configured
    // attachment folder so the importer's file-move target matches.
    result = IMAGE_EMBED_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let name = caps[1].trim();
            let folder = attachment_folder.trim_matches('/');
            if folder.is_empty() {
                format!("#image(\"/{}\")", name)
            } else {
                format!("#image(\"/{}/{}\")", folder, name)
            }
        })
        .into_owned();

    // Replace wikilinks after tag processing.
    result = WIKILINK_RE.replace_all(&result, |caps: &regex::Captures| {
        let target = &caps[1];
        match caps.get(2) {
            Some(display) => {
                format!("#wikilink(\"{}\", display: \"{}\")", target, display.as_str())
            }
            None => format!("#wikilink(\"{}\")", target),
        }
    }).into_owned();

    // Replace Obsidian ==highlight== syntax.
    result = OBSIDIAN_HIGHLIGHT_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("#highlight[{}]", &caps[1])
        })
        .into_owned();

    result
}

/// Splits YAML frontmatter (delimited by `---`) from the body.
fn extract_frontmatter(input: &str) -> (Option<String>, &str) {
    let trimmed = input.trim_start();
    if !trimmed.starts_with("---") {
        return (None, input);
    }

    let after_first = &trimmed[3..];
    let after_first = after_first.strip_prefix('\n').unwrap_or(after_first);

    if let Some(end_pos) = after_first.find("\n---") {
        let fm = &after_first[..end_pos];
        let body_start = end_pos + 4; // "\n---"
        let body = after_first[body_start..]
            .strip_prefix('\n')
            .unwrap_or(&after_first[body_start..]);
        (Some(fm.to_string()), body)
    } else {
        (None, input)
    }
}

/// Convert YAML frontmatter into a `#note(...)` call.
/// Handles common Obsidian fields: title, tags, aliases, date, description, etc.
fn frontmatter_to_note(yaml: &str) -> String {
    let mut fields: Vec<(String, String)> = Vec::new();

    for line in yaml.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // Handle "key: value" lines (simple YAML subset).
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim().to_lowercase();
            let value = value.trim();

            // Skip empty values.
            if value.is_empty() {
                continue;
            }

            match key.as_str() {
                "title" => {
                    fields.push(("title".into(), format_string_value(value)));
                }
                "tags" => {
                    let tags = parse_yaml_list_inline(value);
                    if !tags.is_empty() {
                        let formatted: Vec<String> =
                            tags.iter().map(|t| format_string_value(t)).collect();
                        fields.push(("tags".into(), format!("({})", formatted.join(", "))));
                    }
                }
                "aliases" => {
                    let aliases = parse_yaml_list_inline(value);
                    if !aliases.is_empty() {
                        let formatted: Vec<String> =
                            aliases.iter().map(|a| format_string_value(a)).collect();
                        fields.push(("aliases".into(), format!("({})", formatted.join(", "))));
                    }
                }
                "date" | "created" => {
                    fields.push(("date".into(), format_string_value(value)));
                }
                "description" | "summary" => {
                    fields.push(("description".into(), format_string_value(value)));
                }
                "status" => {
                    let statuses = parse_yaml_list_inline(value);
                    if !statuses.is_empty() {
                        let formatted: Vec<String> =
                            statuses.iter().map(|s| format_string_value(s)).collect();
                        fields.push(("status".into(), format!("({})", formatted.join(", "))));
                    }
                }
                "collection" | "collections" => {
                    let collections = parse_yaml_list_inline(value);
                    if !collections.is_empty() {
                        let formatted: Vec<String> =
                            collections.iter().map(|c| format_string_value(c)).collect();
                        fields
                            .push(("collection".into(), format!("({})", formatted.join(", "))));
                    }
                }
                "source" | "url" => {
                    fields.push(("source".into(), format_string_value(value)));
                }
                _ => {
                    // Pass through unknown fields as string properties.
                    if is_valid_typst_ident(&key) {
                        fields.push((key, format_string_value(value)));
                    }
                }
            }
        }
    }

    if fields.is_empty() {
        return String::new();
    }

    let args: Vec<String> = fields
        .iter()
        .map(|(k, v)| format!("  {}: {}", k, v))
        .collect();

    format!("#note(\n{},\n)", args.join(",\n"))
}

fn format_string_value(s: &str) -> String {
    let s = s.trim_matches('"').trim_matches('\'');
    if let Some(target) = s.strip_prefix("[[").and_then(|s| s.strip_suffix("]]")) {
        return format!("link-ref(\"{}\")", target.replace('\\', "\\\\").replace('"', "\\\""));
    }
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Parse a YAML inline list: `[a, b, c]` or a bare scalar value.
fn parse_yaml_list_inline(value: &str) -> Vec<String> {
    let value = value.trim();
    if value.starts_with('[') && value.ends_with(']') {
        let inner = &value[1..value.len() - 1];
        inner
            .split(',')
            .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        // Single value — might be comma-separated without brackets in some noteboxes.
        if value.contains(',') {
            value
                .split(',')
                .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                .filter(|s| !s.is_empty())
                .collect()
        } else {
            vec![value.trim_matches('"').trim_matches('\'').to_string()]
        }
    }
}

fn is_valid_typst_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars().next().unwrap().is_alphabetic()
        && s.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

// ---------------------------------------------------------------------------
// Event-driven converter
// ---------------------------------------------------------------------------

struct Converter<'a> {
    out: &'a mut String,
    list_stack: Vec<ListContext>,
    in_heading: bool,
    heading_level: u8,
    in_link: bool,
    link_url: String,
    link_text: String,
    in_image: bool,
    image_url: String,
    blockquote_depth: u32,
    blockquote_buf: String,
    pending_newlines: u8,
    in_table: bool,
    table_row: Vec<String>,
    table_alignments: Vec<pulldown_cmark::Alignment>,
    table_header_done: bool,
    in_table_cell: bool,
    cell_buf: String,
    in_code_block: bool,
    in_footnote: bool,
    footnote_label: String,
}

#[derive(Clone)]
struct ListContext {
    ordered: bool,
    index: u64,
    indent: usize,
}

impl<'a> Converter<'a> {
    fn new(out: &'a mut String) -> Self {
        Self {
            out,
            list_stack: Vec::new(),
            in_heading: false,
            heading_level: 0,
            in_link: false,
            link_url: String::new(),
            link_text: String::new(),
            in_image: false,
            image_url: String::new(),
            blockquote_depth: 0,
            blockquote_buf: String::new(),
            pending_newlines: 0,
            in_table: false,
            table_row: Vec::new(),
            table_alignments: Vec::new(),
            table_header_done: false,
            in_table_cell: false,
            cell_buf: String::new(),
            in_code_block: false,
            in_footnote: false,
            footnote_label: String::new(),
        }
    }

    fn convert<'b>(&mut self, parser: impl Iterator<Item = Event<'b>>) {
        for event in parser {
            self.process_event(event);
        }
    }

    fn emit(&mut self, s: &str) {
        if self.in_table_cell {
            self.cell_buf.push_str(s);
        } else if self.blockquote_depth > 0 {
            self.blockquote_buf.push_str(s);
        } else {
            self.flush_newlines();
            self.out.push_str(s);
        }
    }

    fn flush_newlines(&mut self) {
        for _ in 0..self.pending_newlines {
            self.out.push('\n');
        }
        self.pending_newlines = 0;
    }

    fn ensure_blank_line(&mut self) {
        self.pending_newlines = self.pending_newlines.max(2);
    }

    fn ensure_newline(&mut self) {
        self.pending_newlines = self.pending_newlines.max(1);
    }

    fn process_event<'b>(&mut self, event: Event<'b>) {
        match event {
            Event::Start(tag) => self.start_tag(tag),
            Event::End(tag) => self.end_tag(tag),
            Event::Text(text) => self.text(&text),
            Event::Code(code) => {
                self.emit(&format!("`{}`", code));
            }
            Event::SoftBreak => {
                if self.in_code_block {
                    self.emit("\n");
                } else {
                    self.emit("\n");
                }
            }
            Event::HardBreak => {
                self.emit(" \\\n");
            }
            Event::Rule => {
                self.ensure_blank_line();
                self.emit("#line(length: 100%)");
                self.ensure_blank_line();
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                let trimmed = html.trim();
                if trimmed.eq_ignore_ascii_case("<mark>") {
                    self.emit("#highlight[");
                } else if trimmed.eq_ignore_ascii_case("</mark>") {
                    self.emit("]");
                } else if !trimmed.is_empty() {
                    self.emit(&format!("// HTML: {}", trimmed.replace('\n', " ")));
                    self.ensure_newline();
                }
            }
            Event::FootnoteReference(label) => {
                self.emit(&format!("#footnote[see {}]", label));
            }
            Event::TaskListMarker(checked) => {
                if checked {
                    self.emit("[x] ");
                } else {
                    self.emit("[ ] ");
                }
            }
            Event::DisplayMath(math) => {
                self.ensure_blank_line();
                self.emit(&format!("$ {} $", math));
                self.ensure_blank_line();
            }
            Event::InlineMath(math) => {
                self.emit(&format!("${}$", math));
            }
        }
    }

    fn start_tag<'b>(&mut self, tag: Tag<'b>) {
        match tag {
            Tag::Paragraph => {
                self.ensure_blank_line();
            }
            Tag::Heading { level, .. } => {
                self.ensure_blank_line();
                self.in_heading = true;
                self.heading_level = heading_level_to_u8(level);
                let prefix = "=".repeat(self.heading_level as usize);
                self.emit(&format!("{} ", prefix));
            }
            Tag::BlockQuote(_) => {
                if self.blockquote_depth == 0 {
                    self.blockquote_buf.clear();
                    self.pending_newlines = 0;
                }
                self.blockquote_depth += 1;
            }
            Tag::CodeBlock(kind) => {
                self.in_code_block = true;
                self.ensure_blank_line();
                match kind {
                    CodeBlockKind::Fenced(lang) => {
                        let lang = lang.to_string();
                        if lang.is_empty() {
                            self.emit("```\n");
                        } else {
                            self.emit(&format!("```{}\n", lang));
                        }
                    }
                    CodeBlockKind::Indented => {
                        self.emit("```\n");
                    }
                }
            }
            Tag::List(start) => {
                if self.list_stack.is_empty() {
                    self.ensure_blank_line();
                }
                let ctx = ListContext {
                    ordered: start.is_some(),
                    index: start.unwrap_or(1),
                    indent: self.list_stack.len(),
                };
                self.list_stack.push(ctx);
            }
            Tag::Item => {
                self.ensure_newline();
                let ctx = self.list_stack.last().cloned();
                if let Some(ctx) = &ctx {
                    let indent = "  ".repeat(ctx.indent);
                    if ctx.ordered {
                        self.emit(&format!("{}+ ", indent));
                    } else {
                        self.emit(&format!("{}- ", indent));
                    }
                }
            }
            Tag::Emphasis => {
                self.emit("_");
            }
            Tag::Strong => {
                self.emit("*");
            }
            Tag::Strikethrough => {
                self.emit("#strike[");
            }
            Tag::Link { dest_url, title, .. } => {
                self.in_link = true;
                self.link_url = dest_url.to_string();
                self.link_text.clear();
                let _ = title;
            }
            Tag::Image { dest_url, .. } => {
                self.in_image = true;
                self.image_url = dest_url.to_string();
            }
            Tag::Table(alignments) => {
                self.in_table = true;
                self.table_alignments = alignments;
                self.table_header_done = false;
                self.ensure_blank_line();
                self.emit("#table(\n");
                let ncols = self.table_alignments.len();
                let col_list = vec!["auto"; ncols].join(", ");
                self.emit(&format!("  columns: ({}),\n", col_list));
            }
            Tag::TableHead => {
                self.table_row.clear();
            }
            Tag::TableRow => {
                self.table_row.clear();
            }
            Tag::TableCell => {
                self.in_table_cell = true;
                self.cell_buf.clear();
            }
            Tag::FootnoteDefinition(label) => {
                self.in_footnote = true;
                self.footnote_label = label.to_string();
            }
            _ => {}
        }
    }

    fn end_tag(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => {
                self.ensure_blank_line();
            }
            TagEnd::Heading(_) => {
                self.in_heading = false;
                self.ensure_blank_line();
            }
            TagEnd::BlockQuote(_) => {
                self.blockquote_depth -= 1;
                if self.blockquote_depth == 0 {
                    let buf = std::mem::take(&mut self.blockquote_buf);
                    let content = buf.trim();
                    self.ensure_blank_line();
                    if let Some((kind, title, body)) = parse_callout_block(content) {
                        if let Some(t) = title {
                            self.emit(&format!(
                                "#callout(\"{}\", title: \"{}\")[{}]",
                                kind,
                                t.replace('"', "\\\""),
                                body.trim()
                            ));
                        } else {
                            self.emit(&format!("#callout(\"{}\")[{}]", kind, body.trim()));
                        }
                    } else {
                        self.emit(&format!("#quote(block: true)[{}]", content));
                    }
                    self.ensure_blank_line();
                }
            }
            TagEnd::CodeBlock => {
                self.in_code_block = false;
                self.emit("```");
                self.ensure_blank_line();
            }
            TagEnd::List(_) => {
                self.list_stack.pop();
                if self.list_stack.is_empty() {
                    self.ensure_blank_line();
                }
            }
            TagEnd::Item => {
                if let Some(ctx) = self.list_stack.last_mut() {
                    ctx.index += 1;
                }
            }
            TagEnd::Emphasis => {
                self.emit("_");
            }
            TagEnd::Strong => {
                self.emit("*");
            }
            TagEnd::Strikethrough => {
                self.emit("]");
            }
            TagEnd::Link => {
                self.in_link = false;
                let url = std::mem::take(&mut self.link_url);
                let text = std::mem::take(&mut self.link_text);
                self.emit(&format_link(&url, &text));
            }
            TagEnd::Image => {
                self.in_image = false;
                let url = std::mem::take(&mut self.image_url);
                self.emit(&format!("#image(\"{}\")", url));
            }
            TagEnd::Table => {
                self.in_table = false;
                self.emit(")\n");
                self.ensure_blank_line();
            }
            TagEnd::TableHead => {
                // Emit header cells as table.header.
                let cells: Vec<String> = self
                    .table_row
                    .drain(..)
                    .map(|c| format!("    [*{}*]", c.trim()))
                    .collect();
                self.emit("  table.header(\n");
                for cell in cells {
                    self.emit(&cell);
                    self.emit(",\n");
                }
                self.emit("  ),\n");
                self.table_header_done = true;
            }
            TagEnd::TableRow => {
                if self.table_header_done {
                    let cells: Vec<String> = self
                        .table_row
                        .drain(..)
                        .map(|c| format!("  [{}]", c.trim()))
                        .collect();
                    for cell in cells {
                        self.emit(&cell);
                        self.emit(",\n");
                    }
                }
            }
            TagEnd::TableCell => {
                self.in_table_cell = false;
                let content = std::mem::take(&mut self.cell_buf);
                self.table_row.push(content);
            }
            TagEnd::FootnoteDefinition => {
                self.in_footnote = false;
            }
            _ => {}
        }
    }

    fn text(&mut self, text: &str) {
        if self.in_link {
            self.link_text.push_str(text);
            return;
        }

        if self.in_image {
            return;
        }

        // Inside a Typst raw block (which we emit for fenced code) the
        // content is verbatim — escaping would corrupt source listings.
        if self.in_code_block {
            self.emit(text);
            return;
        }

        self.emit(&escape_text_for_typst(text));
    }
}

/// Escape Typst-syntactic characters in pass-through markdown text so
/// a stray character in the source doesn't acquire markup meaning
/// post-import. This runs per-`Event::Text` and handles characters
/// whose escape decision needs no surrounding context:
///
/// - `` ` ``: a single bare backtick opens an inline raw region that
///   swallows everything up to the next backtick.
/// - `$`: opens math mode, which runs until the next `$`. Unbalanced
///   dollar signs (e.g. plain-text prices like `$3000` / `$6000`)
///   put everything in between into math mode.
/// - `\`: Typst's own escape character. Pulldown-cmark may surface
///   backslashes from source text (file paths, regex examples) that
///   would otherwise consume the next character.
///
/// `#` is handled separately by [`escape_unrecognized_hashes`] in a
/// final post-pass over the full converted output — pulldown-cmark
/// can split a call like `#highlight[yellow]` across multiple text
/// events (the `[…]` portion arrives separately), so deciding at
/// per-event granularity whether a `#` is a function call or user
/// prose isn't reliable. The post-pass sees full context.
///
/// Other Typst sigils (`[`, `]`) are intentionally NOT escaped
/// because the preprocessor injects bracketed Typst calls like
/// `#highlight[content]` through this text path. Standard-markdown
/// inline syntax (`_`, `*`, headings, code spans) is consumed by
/// pulldown-cmark and arrives as its own event kinds, so we don't
/// see those characters as plain text. `@cite-key` and `<label>`
/// produce only localized rendering errors, not document-wide
/// breakage, so they're left to compile-time diagnostics.
fn escape_text_for_typst(text: &str) -> String {
    if !text.chars().any(needs_basic_escape) {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + 4);
    for ch in text.chars() {
        if needs_basic_escape(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn needs_basic_escape(ch: char) -> bool {
    matches!(ch, '`' | '$' | '\\')
}


/// Format a link. External URLs become Typst `#link(...)`, internal .md links
/// become `#wikilink(...)`.
fn format_link(url: &str, text: &str) -> String {
    // Internal links (no protocol, or relative .md paths) → wikilink.
    let is_internal = !url.contains("://") && !url.starts_with("mailto:");

    if is_internal {
        let target = url
            .trim_end_matches(".md")
            .trim_start_matches("./");
        // Strip anchor fragments for wikilink target.
        let target = target.split('#').next().unwrap_or(target);
        if text.is_empty() || text == target {
            format!("#wikilink(\"{}\")", target)
        } else {
            format!("#wikilink(\"{}\", display: \"{}\")", target, text)
        }
    } else {
        if text.is_empty() || text == url {
            format!("#link(\"{}\")", url)
        } else {
            format!("#link(\"{}\")[{}]", url, text)
        }
    }
}

/// Parse a blockquote buffer as an Obsidian-style callout.
/// Returns (kind, optional title, body) if the buffer starts with `[!type]`.
fn parse_callout_block(content: &str) -> Option<(String, Option<String>, String)> {
    let first_line_end = content.find('\n').unwrap_or(content.len());
    let first_line = content[..first_line_end].trim();

    if !first_line.starts_with("[!") {
        return None;
    }

    let end_bracket = first_line.find(']')?;
    let kind = first_line[2..end_bracket].to_lowercase();
    let rest_of_line = first_line[end_bracket + 1..].trim();
    let title = if rest_of_line.is_empty() {
        None
    } else {
        Some(rest_of_line.to_string())
    };

    let body = if first_line_end < content.len() {
        content[first_line_end + 1..].trim().to_string()
    } else {
        String::new()
    };

    Some((kind, title, body))
}

fn heading_level_to_u8(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Existing tests were written before the dialect split; almost
    /// all of them assume Obsidian behavior (tag preprocessing, math,
    /// `[[wikilink]]`). New tests targeting the Standard dialect use
    /// [`convert_standard`].
    fn convert(md: &str) -> String {
        let opts = MarkdownToTypstOptions {
            dialect: MarkdownDialect::Obsidian,
            ..MarkdownToTypstOptions::default()
        };
        markdown_to_typst(md, &opts)
    }

    fn convert_standard(md: &str) -> String {
        let opts = MarkdownToTypstOptions {
            dialect: MarkdownDialect::Standard,
            ..MarkdownToTypstOptions::default()
        };
        markdown_to_typst(md, &opts)
    }

    #[test]
    fn basic_headings() {
        let result = convert("# Hello\n\n## World");
        assert!(result.contains("= Hello"));
        assert!(result.contains("== World"));
    }

    #[test]
    fn emphasis_and_bold() {
        let result = convert("This is **bold** and *italic* text.");
        assert!(result.contains("*bold*"));
        assert!(result.contains("_italic_"));
    }

    #[test]
    fn wikilinks() {
        let result = convert("See [[My Note]] and [[Other|display text]].");
        assert!(result.contains("#wikilink(\"My Note\")"));
        assert!(result.contains("#wikilink(\"Other\", display: \"display text\")"));
    }

    #[test]
    fn image_embed_emits_image_call_under_attachment_folder() {
        // Obsidian-style image embed should NOT become `!#wikilink(...)`
        // — the leading `!` was being orphaned because the wikilink
        // regex stripped the `[[…]]` portion. The fix is a dedicated
        // image-embed regex running first; the emitted path joins the
        // configured attachment folder so it matches where the
        // importer routes the file.
        let opts = MarkdownToTypstOptions {
            attachment_folder: "assets".to_string(),
            ..MarkdownToTypstOptions::default()
        };
        let result = markdown_to_typst(
            "Here: ![[Pasted image 20240412113956.png]]",
            &opts,
        );
        assert!(
            result.contains("#image(\"/assets/Pasted image 20240412113956.png\")"),
            "expected #image() call, got:\n{result}"
        );
        assert!(
            !result.contains("!#wikilink"),
            "leading `!` should not be left orphaned: {result}"
        );
        assert!(
            !result.contains("#wikilink(\"Pasted"),
            "image embed should not fall through to wikilink: {result}"
        );
    }

    #[test]
    fn image_embed_with_alt_text_drops_alt() {
        // `![[name.png|alt text]]` — Typst's #image takes no alt arg,
        // so the alt portion is dropped (captured for possible future
        // use). Without this special-case the wikilink regex would
        // turn it into `!#wikilink(\"name.png\", display: \"alt\")`.
        let opts = MarkdownToTypstOptions {
            attachment_folder: "assets".to_string(),
            ..MarkdownToTypstOptions::default()
        };
        let result = markdown_to_typst("![[photo.png|My caption]]", &opts);
        assert!(
            result.contains("#image(\"/assets/photo.png\")"),
            "expected #image() ignoring alt, got:\n{result}"
        );
    }

    #[test]
    fn plain_wikilink_still_works_after_image_embed_pass() {
        // Regression: the image-embed regex runs before the wikilink
        // regex; make sure a plain `[[link]]` isn't accidentally
        // consumed by the new pass.
        let opts = MarkdownToTypstOptions::default();
        let result = markdown_to_typst("see [[My Note]]", &opts);
        assert!(result.contains("#wikilink(\"My Note\")"));
        assert!(!result.contains("#image"));
    }

    #[test]
    fn escapes_stray_backtick() {
        // Regression: a single stray backtick in markdown source
        // (e.g. a typo after a wikilink) would otherwise open a Typst
        // raw block and swallow the rest of the document. Importer
        // must emit it as an escaped backtick so the file stays well-
        // formed and the rest of the source renders normally.
        let result = convert("see [[Concordia]]`\n\n## Next section\n");
        // The escape — `\``  — leaves the rest of the document free.
        assert!(
            result.contains("\\`"),
            "expected escaped backtick, got:\n{result}"
        );
        // And the section heading after the typo should still appear
        // as a heading (would be consumed by the unclosed raw block
        // otherwise).
        assert!(
            result.contains("== Next section"),
            "section heading after stray backtick missing:\n{result}"
        );
    }

    #[test]
    fn escapes_dollar_signs() {
        // Regression from a real import: a list with prices like
        // `$6000 ... $3000 ... $3000` paired unbalanced dollar signs
        // and dropped the entire rest of the document into math mode.
        // Each `$` in pass-through text must be escaped to `\$` so
        // they render as literal currency symbols.
        let md = "- salary $6000 + travel\n- bonus $3000\n- extra $3000 more\n";
        let result = convert(md);
        assert!(
            result.contains("\\$6000"),
            "expected \\$6000 in output, got:\n{result}"
        );
        assert_eq!(
            result.matches("\\$").count(),
            3,
            "all three dollar signs should be escaped, got:\n{result}"
        );
        // Sanity: no bare $ left to open math mode.
        assert!(
            !result.contains(" $6000"),
            "unescaped $ remained: {result}"
        );
    }

    #[test]
    fn escapes_backslash() {
        // Typst uses `\` as the escape character. Pass-through text
        // containing backslashes (file paths, etc.) needs them
        // doubled so they appear as literal characters in the import
        // rather than escaping whatever follows.
        let result = convert("path C:\\Users\\jc\\file.txt");
        assert!(
            result.contains("C:\\\\Users\\\\jc\\\\file.txt"),
            "expected doubled backslashes, got:\n{result}"
        );
    }

    #[test]
    fn fenced_code_block_content_not_escaped() {
        // Inside a Typst raw block the content is verbatim — backticks
        // there would still be problematic in principle, but escaping
        // them would corrupt code listings. Keep the existing behavior.
        let result = convert("```\nfn foo() { let s = `hi`; }\n```");
        assert!(
            result.contains("let s = `hi`;"),
            "code block content should pass through unescaped, got:\n{result}"
        );
    }

    #[test]
    fn inline_code_span_preserved() {
        // `Event::Code` is a different event from `Event::Text` — we
        // emit it with surrounding backticks to make a Typst raw
        // inline. The text-escape path does NOT see it, so the
        // backticks emitted here are intentional and must survive.
        let result = convert("call `format!()` here");
        assert!(
            result.contains("`format!()`"),
            "inline code span should produce a Typst raw inline:\n{result}"
        );
    }

    #[test]
    fn standard_dialect_escapes_literal_hash() {
        // `issue #42`, `version #2`, `model #abc` are common standard-
        // markdown patterns that must survive as literals. Without
        // escaping, Typst would parse `#42` as the integer 42 (so the
        // `#` disappears) and `#abc` as an undefined function call.
        let result = convert_standard("see issue #42 and version #2 and model #abc");
        assert!(
            result.contains("issue \\#42"),
            "expected \\#42, got:\n{result}"
        );
        assert!(
            result.contains("version \\#2"),
            "expected \\#2, got:\n{result}"
        );
        assert!(
            result.contains("model \\#abc"),
            "expected \\#abc, got:\n{result}"
        );
    }

    #[test]
    fn standard_dialect_preserves_injected_calls() {
        // Even in Standard, `[[wikilink]]` / `![[embed]]` / `==hi==`
        // are still converted to Typst function calls — those flow
        // through the same text-emit path as escaped `#`, so the
        // escape pass must NOT touch their leading `#`.
        let result = convert_standard("see [[My Note]] and ![[pic.png]] and ==yellow== text");
        assert!(
            result.contains("#wikilink(\"My Note\")"),
            "wikilink preserved: {result}"
        );
        assert!(
            result.contains("#image(\"/assets/pic.png\")"),
            "image preserved: {result}"
        );
        assert!(
            result.contains("#highlight[yellow]"),
            "highlight preserved: {result}"
        );
        assert!(
            !result.contains("\\#wikilink"),
            "wikilink got over-escaped: {result}"
        );
        assert!(
            !result.contains("\\#image"),
            "image got over-escaped: {result}"
        );
        assert!(
            !result.contains("\\#highlight"),
            "highlight got over-escaped: {result}"
        );
    }

    #[test]
    fn standard_dialect_does_not_convert_obsidian_tags() {
        // `#kim` is NOT a tag in Standard — it's a literal hash that
        // happens to be followed by letters. Must be escaped.
        let result = convert_standard("apply for the year #kim see email");
        assert!(
            result.contains("\\#kim"),
            "expected escaped \\#kim, got:\n{result}"
        );
        assert!(
            !result.contains("#tag(\"kim\")"),
            "Standard dialect must not preprocess tags: {result}"
        );
    }

    #[test]
    fn obsidian_dialect_still_converts_tags() {
        // Sanity check the opposite direction — Obsidian mode keeps
        // tag preprocessing on.
        let result = convert("apply for the year #kim see email");
        assert!(
            result.contains("#tag(\"kim\")"),
            "Obsidian dialect should preprocess #kim: {result}"
        );
        assert!(
            !result.contains("\\#"),
            "Obsidian dialect should not escape #: {result}"
        );
    }

    #[test]
    fn obsidian_dialect_strips_inline_comments() {
        let result = convert("visible %% hidden comment %% more visible");
        assert!(result.contains("visible"), "got: {result}");
        assert!(result.contains("more visible"), "got: {result}");
        assert!(
            !result.contains("hidden comment"),
            "comment should be stripped: {result}"
        );
    }

    #[test]
    fn standard_dialect_keeps_percent_text() {
        // `%%` has no meaning in Standard markdown — pass through as
        // literal characters.
        let result = convert_standard("price went up 5%% per year");
        assert!(
            result.contains("5%% per year"),
            "%% should pass through in Standard: {result}"
        );
    }

    #[test]
    fn standard_dialect_disables_dollar_math() {
        // In Obsidian, `$E=mc^2$` is math (consumed by pulldown-cmark
        // and emitted via Event::InlineMath). In Standard, the same
        // text is plain prose — the `$` signs get escaped to `\$`.
        let result = convert_standard("formula: $E=mc^2$ here");
        assert!(
            result.contains("\\$E=mc^2\\$"),
            "Standard should escape $..$: {result}"
        );
        assert!(
            !result.contains("$E=mc^2$"),
            "Standard should NOT emit math: {result}"
        );
    }

    #[test]
    fn extract_embed_filenames_lists_referenced_names() {
        let names = extract_embed_filenames(
            "intro\n![[a.png]]\nmid ![[b with spaces.jpg|alt]] tail\n![[c.png]]",
        );
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["a.png", "b with spaces.jpg", "c.png"]);
    }

    #[test]
    fn external_links() {
        let result = convert("[Google](https://google.com)");
        assert!(result.contains("#link(\"https://google.com\")[Google]"));
    }

    #[test]
    fn internal_links() {
        let result = convert("[my note](./some-note.md)");
        assert!(result.contains("#wikilink(\"some-note\", display: \"my note\")"));
    }

    #[test]
    fn obsidian_tags() {
        let result = convert("Some text #mytag and #nested/tag here.");
        assert!(result.contains("#tag(\"mytag\")"));
        assert!(result.contains("#tag(\"nested-tag\")"));
    }

    #[test]
    fn frontmatter_to_note_call() {
        let md = "---\ntitle: My Note\ntags: [foo, bar]\ndate: 2024-01-15\n---\n\nBody text.";
        let result = convert(md);
        assert!(result.contains("#note("));
        assert!(result.contains("title: \"My Note\""));
        assert!(result.contains("tags: (\"foo\", \"bar\")"));
        assert!(result.contains("date: \"2024-01-15\""));
        assert!(result.contains("Body text."));
    }

    #[test]
    fn code_blocks() {
        let result = convert("```rust\nfn main() {}\n```");
        assert!(result.contains("```rust\nfn main() {}\n```"));
    }

    #[test]
    fn unordered_list() {
        let result = convert("- item one\n- item two\n- item three");
        assert!(result.contains("- item one"));
        assert!(result.contains("- item two"));
    }

    #[test]
    fn ordered_list() {
        let result = convert("1. first\n2. second\n3. third");
        assert!(result.contains("+ first"));
        assert!(result.contains("+ second"));
    }

    #[test]
    fn callout() {
        let result = convert("> [!warning] Be careful\n> This is important.");
        assert!(result.contains("#callout(\"warning\""));
        assert!(result.contains("title: \"Be careful\""));
    }

    #[test]
    fn blockquote() {
        let result = convert("> This is a quote.");
        assert!(result.contains("#quote(block: true)"));
    }

    #[test]
    fn math_inline() {
        let result = convert("The formula $E = mc^2$ is famous.");
        assert!(result.contains("$E = mc^2$"));
    }

    #[test]
    fn images() {
        let result = convert("![alt](image.png)");
        assert!(result.contains("#image(\"image.png\")"));
    }

    #[test]
    fn no_preamble_duplication() {
        let result = convert("Hello");
        let count = result.matches("#import").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn wikilink_inside_bold() {
        let result = convert("This is **[[My Note]]** text.");
        assert!(result.contains("#wikilink(\"My Note\")"));
        assert!(result.contains("*"));
    }

    #[test]
    fn table_conversion() {
        let result = convert("| Name | Age |\n|------|-----|\n| Alice | 30 |\n| Bob | 25 |");
        assert!(result.contains("#table("));
        assert!(result.contains("Alice"));
        assert!(result.contains("Bob"));
    }

    #[test]
    fn table_in_document_context() {
        let md = "---\ntitle: Test\n---\n\n# My Document\n\nSome text before the table.\n\n| Item | Price | Qty |\n| --- | --- | --- |\n| Apples | $1.50 | 3 |\n| Bananas | $0.75 | 6 |\n\nSome text after.";
        let result = convert(md);
        assert!(result.contains("#table("));
        assert!(result.contains("columns: (auto, auto, auto)"));
        assert!(result.contains("Apples"));
    }

    #[test]
    fn table_minimal_separator() {
        // Minimal separator format some editors produce.
        let md = "|A|B|\n|-|-|\n|1|2|";
        let result = convert(md);
        assert!(result.contains("#table("), "Table not detected: {}", result);
    }

    #[test]
    fn table_with_wikilinks() {
        let result = convert("| Note | Status |\n|------|--------|\n| [[My Note]] | Done |");
        assert!(result.contains("#table("));
        assert!(result.contains("#wikilink(\"My Note\")"));
    }

    #[test]
    fn table_header_uses_bracket_cells() {
        let result = convert("| Name | Age |\n|------|-----|\n| Alice | 30 |");
        assert!(result.contains("table.header("), "missing header: {result}");
        assert!(result.contains("[*Name*]"), "header should use [*...*] not table.cell: {result}");
        assert!(!result.contains("table.cell"), "should not use table.cell: {result}");
    }

    #[test]
    fn obsidian_highlight() {
        let result = convert("This is ==highlighted text== here.");
        assert!(result.contains("#highlight[highlighted text]"));
    }

    #[test]
    fn html_mark_highlight() {
        let result = convert("This is <mark>highlighted</mark> here.");
        assert!(result.contains("#highlight[highlighted]"));
    }

    #[test]
    fn obsidian_highlight_basic() {
        let result = convert("This is ==highlighted text== here.");
        assert!(result.contains("#highlight[highlighted text]"));
    }

    #[test]
    fn obsidian_highlight_arrow_not_matched() {
        let result = convert("==> This should not be highlighted ==");
        assert!(!result.contains("#highlight["), "Arrow ==> should not open a highlight");
    }

    #[test]
    fn obsidian_highlight_no_cross_line() {
        let result = convert("==start\nend==");
        assert!(!result.contains("#highlight["), "Highlight should not span lines");
    }
}
