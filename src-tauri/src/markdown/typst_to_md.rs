// ---------------------------------------------------------------------------
// Why this is a Rust-side converter and not a Typst feature
// ---------------------------------------------------------------------------
//
// Typst doesn't have a native typ → markdown emitter. The HTML backend
// (`typst::compile::<HtmlDocument>`) gets close but loses our package-level
// semantics: a `#wikilink("Foo")` becomes `<a href="Foo.typ">`, which is the
// wrong shape for round-tripping with markdown ecosystems (Obsidian etc.)
// that expect `[[Foo]]`. Likewise `#tag("x")` becomes prose, and `#note(...)`
// vanishes into PDF metadata instead of YAML frontmatter.
//
// The exporter here is the `inkycap-notebox` package's reverse map, kept in
// Rust because it's the only place the package's vocabulary and markdown's
// vocabulary both make sense. Per CLAUDE.md's Typst-first principle: the
// rule says "before developing something outside" — we did look, the native
// path doesn't reach.
// ---------------------------------------------------------------------------

use regex::Regex;
use std::sync::LazyLock;

/// Options controlling the typst-to-markdown conversion.
#[derive(Debug, Clone)]
pub struct TypstToMarkdownOptions {
    /// How to handle Typst markup that has no markdown equivalent.
    pub unconvertible: UnconvertibleMode,
}

/// What to do with Typst constructs that can't be represented in markdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnconvertibleMode {
    /// Wrap in a ```typst fenced code block (no data loss).
    Preserve,
    /// Omit entirely (clean markdown output).
    Omit,
}

impl Default for TypstToMarkdownOptions {
    fn default() -> Self {
        Self {
            unconvertible: UnconvertibleMode::Preserve,
        }
    }
}

// Regex patterns for InkyCap Typst constructs.
static IMPORT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^#import\s+"[^"]*"\s*:\s*\*\s*$"#).unwrap());

static HEADING_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(=+)\s+(.*)$").unwrap());

static WIKILINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"#wikilink\("([^"]*)"(?:,\s*(?:display:\s*"([^"]*)"|label:\s*"[^"]*"))*\)"#)
        .unwrap()
});

static TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"#tag\("([^"]*)"\)"#).unwrap());

static LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#link\("([^"]*)"\)\[([^\]]*)\]"#).unwrap());

static LINK_BARE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#link\("([^"]*)"\)"#).unwrap());

// Matches `#image("path")` and `#image("path", width: 25%, …)` — the trailing
// named args (width/height/fit/alt) have no CommonMark equivalent and are
// dropped; only the path is carried into `![](path)`.
static IMAGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#image\("([^"]*)"(?:,[^)]*)?\)"#).unwrap());

static CALLOUT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"#callout\("([^"]*)"(?:,\s*title:\s*"([^"]*)")?\)\[(.*?)\]"#).unwrap()
});

static QUOTE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#quote\(block:\s*true\)\[(.*?)\]"#).unwrap());

static STRIKE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"#strike\[([^\]]*)\]"#).unwrap());

static HIGHLIGHT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#highlight\[([^\]]*)\]"#).unwrap());

static FOOTNOTE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#footnote\[([^\]]*)\]"#).unwrap());

// CriticMarkup interop: #suggestion(...) / #annotation map to the standard
// CriticMarkup delimiters so a note exported to markdown carries its tracked
// changes + comments to other CriticMarkup-aware tools (Obsidian, iA Writer).
// `[^)]*` after the kind absorbs any `by:`/`on:` attribution; bodies use the
// same single-bracket limitation as the other inline regexes (no nested `]`).
static SUGGESTION_REPLACE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"#suggestion\(kind:\s*"replace",\s*old:\s*\[([^\]]*)\][^)]*\)\[([^\]]*)\]"#)
        .unwrap()
});
static SUGGESTION_INSERT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#suggestion\(kind:\s*"insert"[^)]*\)\[([^\]]*)\]"#).unwrap());
static SUGGESTION_DELETE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#suggestion\(kind:\s*"delete"[^)]*\)\[([^\]]*)\]"#).unwrap());
static ANNOTATION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#annotation\[([^\]]*)\]"#).unwrap());

static LINE_RULE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"#line\(length:\s*100%\)"#).unwrap());

// Detect Typst code constructs that aren't part of our known set.
// Matches function calls (#func()), set/show rules (#set, #show), and let bindings (#let).
static UNKNOWN_FUNC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#(?:[a-zA-Z][a-zA-Z0-9-]*\(|set |show |let )").unwrap());

/// Convert InkyCap Typst source to markdown.
pub fn typst_to_markdown(input: &str, options: &TypstToMarkdownOptions) -> String {
    let mut out = String::with_capacity(input.len());
    let lines = input.lines().peekable();
    let mut frontmatter_fields: Vec<(String, String)> = Vec::new();
    let mut in_note_call = false;
    let mut note_buf = String::new();
    let mut in_table = false;
    let mut table_buf = String::new();
    let mut in_code_block = false;
    let mut code_block_lang = String::new();

    for line in lines {
        // Skip import lines.
        if IMPORT_RE.is_match(line) {
            continue;
        }

        // Detect #note(...) call (may span multiple lines).
        if line.trim_start().starts_with("#note(") {
            in_note_call = true;
            note_buf.clear();
            note_buf.push_str(line);
            note_buf.push('\n');
            // Check if it's all on one line.
            if balanced_parens(line) {
                in_note_call = false;
                frontmatter_fields = parse_note_to_frontmatter(&note_buf);
            }
            continue;
        }

        if in_note_call {
            note_buf.push_str(line);
            note_buf.push('\n');
            if balanced_parens(&note_buf) {
                in_note_call = false;
                frontmatter_fields = parse_note_to_frontmatter(&note_buf);
            }
            continue;
        }

        // Detect #table(...) call (may span multiple lines).
        // The table may appear mid-line (e.g. after #line(length: 100%)).
        if !in_table {
            if let Some(table_pos) = line.find("#table(") {
                let before_table = &line[..table_pos];
                let table_part = &line[table_pos..];
                // Convert any content before the table as a normal line.
                if !before_table.trim().is_empty() {
                    let converted = convert_line(before_table.trim_end(), options);
                    out.push_str(&converted);
                    out.push('\n');
                }
                in_table = true;
                table_buf.clear();
                table_buf.push_str(table_part);
                table_buf.push('\n');
                if balanced_parens(table_part) {
                    in_table = false;
                    let md = convert_table_to_md(&table_buf, options);
                    out.push_str(&md);
                    out.push('\n');
                }
                continue;
            }
        }

        if in_table {
            table_buf.push_str(line);
            table_buf.push('\n');
            if balanced_parens(&table_buf) {
                in_table = false;
                let md = convert_table_to_md(&table_buf, options);
                out.push_str(&md);
                out.push('\n');
            }
            continue;
        }

        // Code blocks pass through as-is.
        if line.trim_start().starts_with("```") {
            if !in_code_block {
                in_code_block = true;
                code_block_lang = line.trim_start().trim_start_matches('`').to_string();
                out.push_str(line);
                out.push('\n');
            } else {
                in_code_block = false;
                code_block_lang.clear();
                out.push_str(line);
                out.push('\n');
            }
            continue;
        }

        if in_code_block {
            out.push_str(line);
            out.push('\n');
            continue;
        }

        // Convert the line.
        let converted = convert_line(line, options);
        out.push_str(&converted);
        out.push('\n');
    }

    // Build final output with frontmatter if we extracted properties.
    let mut result = String::new();
    if !frontmatter_fields.is_empty() {
        result.push_str("---\n");
        for (key, value) in &frontmatter_fields {
            result.push_str(&format!("{}: {}\n", key, value));
        }
        result.push_str("---\n\n");
    }

    // Trim leading blank lines from body.
    let body = out.trim_start_matches('\n');
    result.push_str(body);

    // Ensure single trailing newline.
    let result = result.trim_end().to_string() + "\n";
    result
}

fn convert_line(line: &str, options: &TypstToMarkdownOptions) -> String {
    // Headings: = Title → # Title
    if let Some(caps) = HEADING_RE.captures(line) {
        let level = caps[1].len();
        let text = &caps[2];
        let prefix = "#".repeat(level);
        let converted_text = convert_inline(text, options);
        return format!("{} {}", prefix, converted_text);
    }

    // Horizontal rule.
    if LINE_RULE_RE.is_match(line) {
        return "---".to_string();
    }

    // List items: preserve structure, convert inline content.
    let trimmed = line.trim_start();
    if trimmed.starts_with("- ") || trimmed.starts_with("+ ") {
        let indent = &line[..line.len() - trimmed.len()];
        let marker = if trimmed.starts_with("+ ") { "1." } else { "-" };
        let content = &trimmed[2..];
        let converted = convert_inline(content, options);
        return format!("{}{} {}", indent, marker, converted);
    }

    // Callout blocks (single-line form).
    if let Some(caps) = CALLOUT_RE.captures(line) {
        let kind = &caps[1];
        let title = caps.get(2).map(|m| m.as_str());
        let body = &caps[3];
        let converted_body = convert_inline(body, options);
        return if let Some(t) = title {
            format!("> [!{}] {}\n> {}", kind, t, converted_body)
        } else {
            format!("> [!{}]\n> {}", kind, converted_body)
        };
    }

    // Block quote (single-line form).
    if let Some(caps) = QUOTE_RE.captures(line) {
        let body = &caps[1];
        let converted = convert_inline(body, options);
        return format!("> {}", converted);
    }

    // Math: display math $ ... $ on its own line.
    let trimmed_line = line.trim();
    if trimmed_line.starts_with("$ ") && trimmed_line.ends_with(" $") && trimmed_line.len() > 4 {
        let math = &trimmed_line[2..trimmed_line.len() - 2];
        return format!("$$\n{}\n$$", math);
    }

    // General line: convert inline constructs.
    convert_inline(line, options)
}

fn convert_inline(text: &str, options: &TypstToMarkdownOptions) -> String {
    let mut result = text.to_string();

    // Wikilinks → standard markdown links: [Name](Name.md)
    result = WIKILINK_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let target = &caps[1];
            let display = caps.get(2).map(|m| m.as_str()).unwrap_or(target);
            format!("[{}]({}.md)", display, target)
        })
        .into_owned();

    // Tags → #tagname (Obsidian format).
    result = TAG_RE
        .replace_all(&result, |caps: &regex::Captures| format!("#{}", &caps[1]))
        .into_owned();

    // Links with display text.
    result = LINK_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("[{}]({})", &caps[2], &caps[1])
        })
        .into_owned();

    // Bare links.
    result = LINK_BARE_RE
        .replace_all(&result, |caps: &regex::Captures| format!("<{}>", &caps[1]))
        .into_owned();

    // Images.
    result = IMAGE_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("![]({})", &caps[1])
        })
        .into_owned();

    // Strikethrough.
    result = STRIKE_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("~~{}~~", &caps[1])
        })
        .into_owned();

    // Highlight.
    result = HIGHLIGHT_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("<mark>{}</mark>", &caps[1])
        })
        .into_owned();

    // Footnotes.
    result = FOOTNOTE_RE
        .replace_all(&result, |caps: &regex::Captures| format!("[^{}]", &caps[1]))
        .into_owned();

    // CriticMarkup: tracked-change suggestions + reviewer comments. Replace
    // must run before insert/delete (they key on distinct `kind` literals, so
    // order is for clarity, not correctness).
    result = SUGGESTION_REPLACE_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("{{~~{}~>{}~~}}", &caps[1], &caps[2])
        })
        .into_owned();
    result = SUGGESTION_INSERT_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("{{++{}++}}", &caps[1])
        })
        .into_owned();
    result = SUGGESTION_DELETE_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("{{--{}--}}", &caps[1])
        })
        .into_owned();
    result = ANNOTATION_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("{{>>{}<<}}", &caps[1])
        })
        .into_owned();

    // Typst emphasis: _text_ → *text* (markdown italic)
    // Typst bold: *text* → **text** (markdown bold)
    // These are context-sensitive — only convert when they look like inline markup.
    result = convert_typst_emphasis(&result);

    // Inline math: $...$ stays as $...$
    // (Markdown math and Typst inline math use the same delimiter.)

    // Handle remaining unknown function calls.
    if UNKNOWN_FUNC_RE.is_match(&result) {
        match options.unconvertible {
            UnconvertibleMode::Preserve => {
                // Only wrap if the line is predominantly a function call.
                if result.trim_start().starts_with('#') {
                    return format!("```typst\n{}\n```", result);
                }
            }
            UnconvertibleMode::Omit => {
                // Remove unknown function calls inline.
                result = UNKNOWN_FUNC_RE.replace_all(&result, "").into_owned();
            }
        }
    }

    result
}

/// Convert a `#table(...)` block to a markdown pipe table.
/// Falls back to a fenced typst code block if parsing fails.
fn convert_table_to_md(table_src: &str, options: &TypstToMarkdownOptions) -> String {
    let trimmed = table_src.trim();

    // Extract inner content of #table(...)
    let inner = match trimmed
        .strip_prefix("#table(")
        .and_then(|s| s.strip_suffix(')'))
    {
        Some(s) => s,
        None => return table_fallback(table_src, options),
    };

    // Parse columns count.
    let col_count = match parse_table_columns(inner) {
        Some(n) => n,
        None => return table_fallback(table_src, options),
    };

    // Extract header and body cells.
    let (header_cells, body_cells) = extract_table_cells(inner);

    if header_cells.is_empty() && body_cells.is_empty() {
        return table_fallback(table_src, options);
    }

    let mut md = String::new();

    // Header row.
    if !header_cells.is_empty() {
        md.push('|');
        for cell in &header_cells {
            let converted = convert_inline(cell.trim(), options);
            md.push_str(&format!(" {} |", converted));
        }
        md.push('\n');
    } else {
        // No header — use first body row as header (markdown requires a header).
        if body_cells.len() >= col_count {
            md.push('|');
            for cell in &body_cells[..col_count] {
                let converted = convert_inline(cell.trim(), options);
                let converted = convert_typst_emphasis(&converted);
                md.push_str(&format!(" {} |", converted));
            }
            md.push('\n');
        }
    }

    // Separator row.
    md.push('|');
    for _ in 0..col_count {
        md.push_str(" --- |");
    }
    md.push('\n');

    // Body rows.
    let body_start = if header_cells.is_empty() {
        col_count
    } else {
        0
    };
    for row in body_cells[body_start..].chunks(col_count) {
        md.push('|');
        for cell in row {
            let converted = convert_inline(cell.trim(), options);
            md.push_str(&format!(" {} |", converted));
        }
        // Pad if the last row is short.
        for _ in row.len()..col_count {
            md.push_str("  |");
        }
        md.push('\n');
    }

    md
}

fn table_fallback(table_src: &str, options: &TypstToMarkdownOptions) -> String {
    match options.unconvertible {
        UnconvertibleMode::Preserve => format!("```typst\n{}\n```\n", table_src.trim()),
        UnconvertibleMode::Omit => String::new(),
    }
}

/// Parse the `columns:` argument to get the column count.
fn parse_table_columns(inner: &str) -> Option<usize> {
    // Look for `columns: N` (integer) or `columns: (...)` (array).
    let col_start = inner.find("columns:")?;
    let after = inner[col_start + 8..].trim_start();

    if after.starts_with('(') {
        // Count items in the parenthesized list.
        let close = find_matching_paren_str(after, 0)?;
        let items = after[1..close]
            .split(',')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .count();
        Some(items)
    } else {
        // Integer column count.
        let num_str: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        num_str.parse().ok()
    }
}

fn find_matching_paren_str(text: &str, open_idx: usize) -> Option<usize> {
    let mut depth = 1;
    let mut i = open_idx + 1;
    let bytes = text.as_bytes();
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            b'"' => {
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Extract cell content strings from the table inner text.
/// Returns (header_cells, body_cells).
fn extract_table_cells(inner: &str) -> (Vec<String>, Vec<String>) {
    let mut header_cells = Vec::new();
    let mut body_cells = Vec::new();

    // Find table.header(...) if present.
    if let Some(hdr_start) = inner.find("table.header(") {
        let paren_start = hdr_start + "table.header".len();
        if let Some(paren_close) = find_matching_paren_str(inner, paren_start) {
            let hdr_inner = &inner[paren_start + 1..paren_close];
            header_cells = extract_bracket_cells(hdr_inner);

            // Body cells come after the header.
            let after_header = &inner[paren_close + 1..];
            body_cells = extract_bracket_cells(after_header);
        }
    } else {
        // No header — all cells are body cells.
        // Skip past the columns: argument.
        body_cells = extract_bracket_cells(inner);

        // Filter out anything that looks like a named argument value
        // (the columns array items). The bracket extractor only picks up
        // [content] blocks, so named arg values like `(1fr, 2fr)` are skipped.
    }

    (header_cells, body_cells)
}

/// Pull out all `[content]` bracket blocks from text, handling nesting.
/// Also accepts `table.cell[content]` by stripping the prefix.
fn extract_bracket_cells(text: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        // Skip to next `[`.
        if bytes[i] == b'[' {
            // Check if preceded by table.cell (skip named-arg values in parens).
            let mut depth = 1;
            let start = i + 1;
            i += 1;
            while i < bytes.len() && depth > 0 {
                match bytes[i] {
                    b'[' => depth += 1,
                    b']' => depth -= 1,
                    b'"' => {
                        i += 1;
                        while i < bytes.len() && bytes[i] != b'"' {
                            if bytes[i] == b'\\' {
                                i += 1;
                            }
                            i += 1;
                        }
                    }
                    _ => {}
                }
                if depth > 0 {
                    i += 1;
                }
            }
            let content = &text[start..i];
            // Skip brackets that are part of named args like `columns: (...)`.
            // Named args values won't start with `[`.
            cells.push(content.to_string());
            i += 1; // past closing ]
        } else {
            i += 1;
        }
    }

    cells
}

/// Convert Typst emphasis markers to markdown:
/// Typst `*bold*` → markdown `**bold**`
/// Typst `_italic_` → markdown `*italic*`
fn convert_typst_emphasis(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '*' && i + 1 < len && chars[i + 1] != ' ' {
            // Look for closing *
            if let Some(end) = find_closing_marker(&chars, i + 1, '*') {
                result.push_str("**");
                for c in &chars[i + 1..end] {
                    result.push(*c);
                }
                result.push_str("**");
                i = end + 1;
                continue;
            }
        }

        if chars[i] == '_' && i + 1 < len && chars[i + 1] != ' ' {
            // Look for closing _
            if let Some(end) = find_closing_marker(&chars, i + 1, '_') {
                result.push('*');
                for c in &chars[i + 1..end] {
                    result.push(*c);
                }
                result.push('*');
                i = end + 1;
                continue;
            }
        }

        result.push(chars[i]);
        i += 1;
    }

    result
}

fn find_closing_marker(chars: &[char], start: usize, marker: char) -> Option<usize> {
    (start..chars.len()).find(|&i| chars[i] == marker && (i == 0 || chars[i - 1] != ' '))
}

/// Parse `#note(...)` content into (key, value) pairs for YAML frontmatter.
fn parse_note_to_frontmatter(note_str: &str) -> Vec<(String, String)> {
    let mut fields = Vec::new();

    // Extract the content between #note( and the final )
    let inner = note_str
        .trim()
        .strip_prefix("#note(")
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or("");

    for line in inner.lines() {
        let line = line.trim().trim_end_matches(',');
        if line.is_empty() {
            continue;
        }

        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            let value = value.trim();

            let yaml_value = typst_value_to_yaml(value);
            if !yaml_value.is_empty() {
                fields.push((key.to_string(), yaml_value));
            }
        }
    }

    fields
}

/// Convert a Typst value literal to YAML representation.
fn typst_value_to_yaml(value: &str) -> String {
    let value = value.trim().trim_end_matches(',');

    // link-ref("Target") → "[[Target]]"
    if let Some(rest) = value.strip_prefix("link-ref(") {
        if let Some(inner) = rest.strip_suffix(')') {
            let target = inner.trim().trim_matches('"');
            return format!("\"[[{}]]\"", target);
        }
    }

    // String: "value" → value
    if value.starts_with('"') && value.ends_with('"') {
        return value[1..value.len() - 1].to_string();
    }

    // Array: ("a", "b") → [a, b]
    if value.starts_with('(') && value.ends_with(')') {
        let inner = &value[1..value.len() - 1];
        let items: Vec<&str> = inner.split(',').map(|s| s.trim()).collect();
        let yaml_items: Vec<String> = items
            .iter()
            .filter(|s| !s.is_empty())
            .map(|s| {
                let s = s.trim_matches('"');
                s.to_string()
            })
            .collect();
        return format!("[{}]", yaml_items.join(", "));
    }

    value.to_string()
}

/// Check if parentheses are balanced in the string.
fn balanced_parens(s: &str) -> bool {
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut prev_char = '\0';

    for c in s.chars() {
        if c == '"' && prev_char != '\\' {
            in_string = !in_string;
        } else if !in_string {
            if c == '(' {
                depth += 1;
            } else if c == ')' {
                depth -= 1;
            }
        }
        prev_char = c;
    }

    depth <= 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convert(typst: &str) -> String {
        typst_to_markdown(typst, &TypstToMarkdownOptions::default())
    }

    fn convert_clean(typst: &str) -> String {
        typst_to_markdown(
            typst,
            &TypstToMarkdownOptions {
                unconvertible: UnconvertibleMode::Omit,
            },
        )
    }

    #[test]
    fn headings() {
        let input = "#import \"/.inkycap/notebox.typ\": *\n\n= Title\n\n== Subtitle";
        let result = convert(input);
        assert!(result.contains("# Title"));
        assert!(result.contains("## Subtitle"));
        assert!(!result.contains("#import"));
    }

    #[test]
    fn note_to_frontmatter() {
        let input = r#"#import "/.inkycap/notebox.typ": *

#note(
  title: "My Note",
  tags: ("foo", "bar"),
  date: "2024-01-15",
)

= Hello"#;
        let result = convert(input);
        assert!(result.contains("---"));
        assert!(result.contains("title: My Note"));
        assert!(result.contains("tags: [foo, bar]"));
        assert!(result.contains("date: 2024-01-15"));
        assert!(result.contains("# Hello"));
    }

    #[test]
    fn wikilinks_to_md_links() {
        let input = "See #wikilink(\"My Note\") and #wikilink(\"Other\", display: \"shown\").";
        let result = convert(input);
        assert!(result.contains("[My Note](My Note.md)"));
        assert!(result.contains("[shown](Other.md)"));
    }

    #[test]
    fn wikilinks_with_label_stripped() {
        let input = r#"See #wikilink("Page", label: "section-one")."#;
        let result = convert(input);
        assert!(result.contains("[Page](Page.md)"), "label-only: {result}");

        let input2 = r#"See #wikilink("Page", display: "click here", label: "sec")."#;
        let result2 = convert(input2);
        assert!(
            result2.contains("[click here](Page.md)"),
            "display+label: {result2}"
        );

        let input3 = r#"See #wikilink("Page", label: "sec", display: "click here")."#;
        let result3 = convert(input3);
        assert!(
            result3.contains("[click here](Page.md)"),
            "label+display: {result3}"
        );
    }

    #[test]
    fn tags_to_obsidian() {
        let input = "Hello #tag(\"mytag\") world.";
        let result = convert(input);
        assert!(result.contains("#mytag"));
    }

    #[test]
    fn links() {
        let input = "#link(\"https://example.com\")[Example]";
        let result = convert(input);
        assert!(result.contains("[Example](https://example.com)"));
    }

    #[test]
    fn images() {
        let input = "#image(\"photo.png\")";
        let result = convert(input);
        assert!(result.contains("![](photo.png)"));
    }

    #[test]
    fn image_with_width_arg_becomes_markdown_image_not_code() {
        // Regression: `#image("p", width: 25%)` used to miss the arg-less regex
        // and get wrapped in a ```typst block instead of converting.
        let input = "#image(\"/Assets/daisy.png\", width: 25%)";
        let result = convert(input);
        assert!(result.contains("![](/Assets/daisy.png)"), "got: {result}");
        assert!(
            !result.contains("```typst"),
            "must not be a code block: {result}"
        );
    }

    #[test]
    fn emphasis() {
        let input = "This is *bold* and _italic_ text.";
        let result = convert(input);
        assert!(result.contains("**bold**"));
        assert!(result.contains("*italic*"));
    }

    #[test]
    fn lists() {
        let input = "- item one\n- item two\n+ ordered item";
        let result = convert(input);
        assert!(result.contains("- item one"));
        assert!(result.contains("- item two"));
        assert!(result.contains("1. ordered item"));
    }

    #[test]
    fn callout() {
        let input = "#callout(\"warning\", title: \"Careful\")[Something important]";
        let result = convert(input);
        assert!(result.contains("> [!warning] Careful"));
        assert!(result.contains("> Something important"));
    }

    #[test]
    fn code_blocks_preserved() {
        let input = "```rust\nfn main() {}\n```";
        let result = convert(input);
        assert!(result.contains("```rust\nfn main() {}\n```"));
    }

    #[test]
    fn unknown_typst_preserved() {
        let input = "#set text(size: 14pt)";
        let result = convert(input);
        assert!(result.contains("```typst"));
        assert!(result.contains("#set text(size: 14pt)"));
    }

    #[test]
    fn unknown_typst_omitted() {
        let input = "#set text(size: 14pt)";
        let result = convert_clean(input);
        assert!(!result.contains("#set"));
        assert!(!result.contains("```typst"));
    }

    #[test]
    fn suggestions_to_criticmarkup() {
        assert!(convert(r#"a #suggestion(kind: "insert")[new] b"#).contains("a {++new++} b"));
        assert!(convert(r#"a #suggestion(kind: "delete")[old] b"#).contains("a {--old--} b"));
        assert!(
            convert(r#"a #suggestion(kind: "replace", old: [o])[n] b"#).contains("a {~~o~>n~~} b")
        );
    }

    #[test]
    fn suggestion_attribution_dropped_in_criticmarkup() {
        // by:/on: don't survive the round-trip to plain CriticMarkup — the
        // mark itself does.
        let out = convert(r#"#suggestion(kind: "insert", by: "alice", on: "2026-05-23")[x]"#);
        assert!(out.contains("{++x++}"), "got: {out}");
    }

    #[test]
    fn review_to_criticmarkup_comment() {
        assert!(
            convert("see #annotation[needs a citation] here").contains("{>>needs a citation<<}")
        );
    }

    #[test]
    fn horizontal_rule() {
        let input = "#line(length: 100%)";
        let result = convert(input);
        assert!(result.contains("---"));
    }

    #[test]
    fn display_math() {
        let input = "$ E = mc^2 $";
        let result = convert(input);
        assert!(result.contains("$$\nE = mc^2\n$$"));
    }

    #[test]
    fn highlight_to_mark() {
        let input = "This is #highlight[important] text.";
        let result = convert(input);
        assert!(result.contains("<mark>important</mark>"));
    }

    #[test]
    fn table_to_markdown() {
        let input = r#"#table(
  columns: (1fr, 1fr),
  table.header(
    [*Name*],
    [*Age*],
  ),
  [Alice],
  [30],
  [Bob],
  [25],
)"#;
        let result = convert(input);
        assert!(
            result.contains("| **Name** | **Age** |"),
            "header missing: {result}"
        );
        assert!(
            result.contains("| --- | --- |"),
            "separator missing: {result}"
        );
        assert!(
            result.contains("| Alice | 30 |"),
            "body row missing: {result}"
        );
        assert!(
            result.contains("| Bob | 25 |"),
            "second body row missing: {result}"
        );
    }

    #[test]
    fn table_with_table_cell_header() {
        let input = r#"#table(
  columns: 2,
  table.header(
    table.cell[*dog*],
    table.cell[*cat*],
  ),
  [bird],
  [mouse],
)"#;
        let result = convert(input);
        assert!(
            result.contains("| **dog** | **cat** |"),
            "header missing: {result}"
        );
        assert!(
            result.contains("| bird | mouse |"),
            "body row missing: {result}"
        );
    }

    #[test]
    fn table_after_other_content_on_same_line() {
        let input = r#"#line(length: 100%)#table(
  columns: (auto, auto, auto),
  align: (left, left, left),
  table.header([Plants], [Animals], [Fungi]),
  [jasmine], [penguin], [bolete],
  [maple tree], [dog], [inky cap],
)"#;
        let result = convert(input);
        assert!(result.contains("---"), "horizontal rule missing: {result}");
        assert!(
            result.contains("| Plants | Animals | Fungi |"),
            "header missing: {result}"
        );
        assert!(
            result.contains("| --- | --- | --- |"),
            "separator missing: {result}"
        );
        assert!(
            result.contains("| jasmine | penguin | bolete |"),
            "body row missing: {result}"
        );
    }

    #[test]
    fn table_with_align_argument() {
        let input = r#"#table(
  columns: (auto, auto),
  align: (left, center),
  table.header([*Name*], [*Score*]),
  [Alice], [100],
)"#;
        let result = convert(input);
        assert!(
            result.contains("| **Name** | **Score** |"),
            "header missing: {result}"
        );
        assert!(
            result.contains("| Alice | 100 |"),
            "body row missing: {result}"
        );
    }
}
