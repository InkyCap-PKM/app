//! Convert HTML — typically what a web browser puts on the clipboard when the
//! user copies part of a page — into Typst markup for pasting into a note.
//!
//! The converter walks the parsed DOM and writes the Typst equivalent of each
//! element it recognizes: headings, paragraphs, lists, term lists, block
//! quotes, code, tables, links, and inline formatting (including the
//! `style="font-weight: …"` spans that word processors such as Google Docs
//! produce). Layout wrappers, spans, and unknown tags contribute only their
//! content. Text is escaped so characters with markup meaning in Typst appear
//! literally.
//!
//! Remote images become links rather than `#image(...)` calls: Typst only
//! loads images from files in the notebox, and fetching them would make a
//! network request on the user's behalf.

use dom_query::{Document, NodeRef};
use typst::syntax::link_prefix;

/// Nesting depth past which an element's content is written as plain text,
/// so deeply nested markup can't exhaust the stack.
const MAX_DEPTH: usize = 200;

/// Elements whose content is never user-visible prose.
const SKIPPED: &[&str] = &[
    "head", "script", "style", "noscript", "template", "title", "meta", "link", "base", "svg",
    "canvas", "iframe", "object", "embed", "video", "audio", "source", "track", "button",
    "input", "select", "textarea", "option", "datalist", "map", "area",
];

/// Convert an HTML document or fragment into Typst markup, without the
/// package import preamble. Never fails: markup the converter doesn't
/// recognize is reduced to its text.
pub fn html_to_typst(html: &str) -> String {
    let doc = Document::from(html);
    let mut w = Writer::root();
    match doc.body() {
        Some(body) => walk_children(&body, &mut w, Ctx::default()),
        None => walk_children(&doc.root(), &mut w, Ctx::default()),
    }
    w.finish()
}

/// Convert plain text into Typst markup that renders the same text: markup
/// characters are escaped, blank lines separate paragraphs, and single line
/// breaks are kept as Typst line breaks.
pub fn plain_text_to_typst(text: &str) -> String {
    let mut w = Writer::root();
    let mut after_blank = true;
    for line in text.lines() {
        if line.trim().is_empty() {
            w.brk(Pending::Paragraph);
            after_blank = true;
            continue;
        }
        if !after_blank {
            w.brk(Pending::LineBreak);
        }
        w.text(line);
        after_blank = false;
    }
    w.finish()
}

// ---------------------------------------------------------------------------
// Output writer
// ---------------------------------------------------------------------------

/// Separator owed before the next piece of output, ordered from weakest to
/// strongest so competing requests resolve with `max`.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Pending {
    None,
    Space,
    /// A Typst forced line break (`\` at the end of a line).
    LineBreak,
    Newline,
    Paragraph,
}

/// What the output currently ends with, when that affects how the next
/// character is read by Typst.
#[derive(Clone, Copy)]
enum Tail {
    Plain,
    /// A function call such as `#link("…")[…]`. A following `(` or `.` would
    /// be parsed as more arguments or a field access.
    Call,
    /// Strong or emphasis written with `*…*` / `_…_`, starting at byte
    /// `start`. A following letter would stop the closing delimiter from
    /// counting, so the span is rewritten into `#strong[…]` / `#emph[…]`.
    Delim { start: usize, name: &'static str },
}

struct Writer {
    out: String,
    pending: Pending,
    /// Nothing has been written since the writer started or since the last
    /// list marker, so block breaks are dropped instead of opening an empty
    /// line.
    fresh: bool,
    /// The next text begins a line (or a content block), where `=`, `-`,
    /// `+`, `/`, and `1.` would start a heading or list.
    line_start: bool,
    tail: Tail,
    /// Written after every line break, so continuation lines stay inside the
    /// enclosing list item.
    indent: String,
    /// Content that must stay on one line (headings, terms): breaks become
    /// spaces.
    single_line: bool,
    /// Whitespace was dropped at the very start of this writer's output.
    lead_space: bool,
}

impl Writer {
    fn root() -> Self {
        Writer {
            out: String::new(),
            pending: Pending::None,
            fresh: true,
            line_start: true,
            tail: Tail::Plain,
            indent: String::new(),
            single_line: false,
            lead_space: false,
        }
    }

    /// A writer for content that will be wrapped (in delimiters, a function
    /// call, or a content block) before being added to this one.
    fn child(&self) -> Self {
        Writer {
            indent: self.indent.clone(),
            single_line: self.single_line,
            ..Writer::root()
        }
    }

    fn finish(self) -> String {
        self.out.trim_end().to_string()
    }

    /// The written content plus whether it had leading and trailing
    /// whitespace, which the caller moves outside its delimiters.
    fn finish_inline(self) -> (String, bool, bool) {
        let trail = self.pending != Pending::None;
        (self.out.trim_end().to_string(), self.lead_space, trail)
    }

    fn space(&mut self) {
        if self.fresh {
            if self.out.is_empty() {
                self.lead_space = true;
            }
            return;
        }
        if self.pending == Pending::None {
            self.pending = Pending::Space;
        }
    }

    fn brk(&mut self, p: Pending) {
        if self.single_line {
            self.space();
            return;
        }
        if self.fresh {
            return;
        }
        // Two consecutive <br>s are the web's usual paragraph break.
        if p == Pending::LineBreak && self.pending == Pending::LineBreak {
            self.pending = Pending::Paragraph;
        } else {
            self.pending = self.pending.max(p);
        }
    }

    fn flush(&mut self) {
        let sep = match std::mem::replace(&mut self.pending, Pending::None) {
            Pending::None => return,
            Pending::Space => {
                self.out.push(' ');
                self.tail = Tail::Plain;
                return;
            }
            Pending::LineBreak => " \\\n",
            Pending::Newline => "\n",
            Pending::Paragraph => "\n\n",
        };
        self.out.push_str(sep);
        self.out.push_str(&self.indent);
        self.line_start = true;
        self.tail = Tail::Plain;
    }

    /// Append already-valid Typst, first adjusting what came before it if
    /// the new first character would change how that is parsed.
    fn push(&mut self, s: &str) {
        let Some(first) = s.chars().next() else { return };
        match self.tail {
            Tail::Call if matches!(first, '(' | '.') => self.out.push('\\'),
            Tail::Delim { start, name } if is_wordy(first) => {
                let inner = self.out[start + 1..self.out.len() - 1].to_string();
                self.out.truncate(start);
                self.out.push_str(&format!("#{name}[{inner}]"));
            }
            _ => {}
        }
        self.out.push_str(s);
        self.tail = Tail::Plain;
        self.fresh = false;
        self.line_start = false;
    }

    /// Append HTML text: whitespace collapses as a browser would, and markup
    /// characters are escaped.
    fn text(&mut self, raw: &str) {
        let is_ws = |c: char| matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0C');
        let body = raw.split(is_ws).filter(|s| !s.is_empty()).collect::<Vec<_>>();
        if raw.starts_with(is_ws) {
            self.space();
        }
        if body.is_empty() {
            return;
        }
        self.flush();
        let escaped = escape_markup(&body.join(" "), self.line_start);
        self.push(&escaped);
        if raw.ends_with(is_ws) {
            self.space();
        }
    }

    fn markup(&mut self, s: &str, tail: Tail) {
        self.flush();
        self.push(s);
        self.tail = tail;
    }

    /// Write a list or term marker; the item's content follows on the same
    /// line and counts as a line start.
    fn marker(&mut self, s: &str) {
        self.flush();
        self.push(s);
        self.fresh = true;
        self.line_start = true;
    }

    /// Write `inner` between `*` or `_` delimiters, or as `#strong[…]` /
    /// `#emph[…]` when a letter directly before it would stop the opening
    /// delimiter from counting.
    fn delimited(&mut self, delim: char, name: &'static str, inner: &str) {
        self.flush();
        let prev_wordy = self.out.chars().next_back().is_some_and(is_wordy);
        if prev_wordy && inner.chars().next().is_some_and(is_wordy) {
            self.markup(&format!("#{name}[{inner}]"), Tail::Call);
            return;
        }
        self.push(&format!("{delim}{inner}{delim}"));
        let start = self.out.len() - inner.len() - 2 * delim.len_utf8();
        self.tail = if inner.chars().next_back().is_some_and(is_wordy) {
            Tail::Delim { start, name }
        } else {
            Tail::Plain
        };
    }
}

/// Letters and digits, which Typst treats as word characters when deciding
/// whether `*` or `_` is a delimiter.
fn is_wordy(c: char) -> bool {
    c.is_alphanumeric()
}

// ---------------------------------------------------------------------------
// DOM walk
// ---------------------------------------------------------------------------

/// State inherited from ancestors.
#[derive(Clone, Copy, Default)]
struct Ctx {
    depth: usize,
    in_strong: bool,
    in_emph: bool,
    in_link: bool,
    in_list: bool,
}

fn walk_children(node: &NodeRef, w: &mut Writer, cx: Ctx) {
    for child in node.children_it(false) {
        walk(&child, w, cx);
    }
}

fn walk(node: &NodeRef, w: &mut Writer, cx: Ctx) {
    if node.is_text() {
        w.text(&node.text());
        return;
    }
    let Some(name) = node.node_name() else { return };
    let name: &str = &name;
    if SKIPPED.contains(&name) || is_hidden(node) {
        return;
    }
    let cx = Ctx {
        depth: cx.depth + 1,
        ..cx
    };
    if cx.depth > MAX_DEPTH {
        w.text(&node.text());
        return;
    }
    match name {
        "br" => w.brk(Pending::LineBreak),
        "hr" => {
            w.brk(Pending::Paragraph);
            if !w.single_line {
                w.markup("#line(length: 100%)", Tail::Call);
            }
            w.brk(Pending::Paragraph);
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level = usize::from(name.as_bytes()[1] - b'0');
            heading(node, w, cx, level);
        }
        "ul" | "menu" => list(node, w, cx, false),
        "ol" => list(node, w, cx, true),
        "dl" => term_list(node, w, cx),
        "blockquote" => quote(node, w, cx),
        "pre" => pre(node, w),
        "table" => table(node, w, cx),
        "img" => image(node, w, cx),
        "a" => link(node, w, cx),
        "code" | "kbd" | "samp" | "tt" => inline_code(node, w),
        "math" => math(node, w),
        "q" => {
            let mut sub = w.child();
            walk_children(node, &mut sub, cx);
            let (inner, lead, trail) = sub.finish_inline();
            if lead {
                w.space();
            }
            // Straight quotes in Typst markup render as smart quotes.
            if !inner.is_empty() {
                w.markup(&format!("\"{inner}\""), Tail::Plain);
            }
            if trail {
                w.space();
            }
        }
        _ if is_block(name) => {
            w.brk(Pending::Paragraph);
            walk_children(node, w, cx);
            w.brk(Pending::Paragraph);
        }
        _ => formatted(node, w, cx, name),
    }
}

fn is_block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "section"
            | "article"
            | "main"
            | "header"
            | "footer"
            | "aside"
            | "nav"
            | "address"
            | "figure"
            | "figcaption"
            | "fieldset"
            | "form"
            | "details"
            | "summary"
            | "hgroup"
            | "center"
            | "legend"
            | "caption"
            | "body"
            | "html"
            | "li"
            | "dt"
            | "dd"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "ul"
            | "ol"
            | "menu"
            | "dl"
            | "blockquote"
            | "pre"
            | "table"
            | "tr"
            | "td"
            | "th"
            | "hr"
    )
}

fn has_block_descendant(node: &NodeRef) -> bool {
    node.descendants_it()
        .any(|d| d.node_name().is_some_and(|n| is_block(&n)))
}

fn is_hidden(node: &NodeRef) -> bool {
    node.has_attr("hidden")
        || node
            .attr("aria-hidden")
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("true"))
        || style_value(node, "display").as_deref() == Some("none")
        || style_value(node, "visibility").as_deref() == Some("hidden")
}

/// The lowercased value of one property in an element's inline `style`.
fn style_value(node: &NodeRef, property: &str) -> Option<String> {
    let style = node.attr("style")?;
    style.split(';').find_map(|decl| {
        let (key, value) = decl.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(property)
            .then(|| value.trim().to_ascii_lowercase())
    })
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

/// One layer of inline formatting around a run of content.
#[derive(Clone, Copy, PartialEq)]
enum Layer {
    /// A content function such as `#strike[…]`.
    Func(&'static str),
    Strong,
    Emph,
}

/// Inline elements: apply whatever formatting the tag and its inline style
/// imply, or pass the content through unchanged.
fn formatted(node: &NodeRef, w: &mut Writer, cx: Ctx, name: &str) {
    let mut strong = matches!(name, "b" | "strong");
    let mut emph = matches!(name, "i" | "em");
    let mut funcs: Vec<&'static str> = Vec::new();
    match name {
        "u" | "ins" => funcs.push("underline"),
        "s" | "strike" | "del" => funcs.push("strike"),
        "mark" => funcs.push("highlight"),
        "sub" => funcs.push("sub"),
        "sup" => funcs.push("super"),
        _ => {}
    }

    // Word processors (Google Docs in particular) express formatting through
    // inline styles, and wrap whole documents in `<b style="font-weight:normal">`.
    if let Some(weight) = style_value(node, "font-weight") {
        strong = match weight.as_str() {
            "bold" | "bolder" => true,
            "normal" | "lighter" => false,
            n => n.parse::<u32>().map_or(strong, |n| n >= 600),
        };
    }
    if let Some(style) = style_value(node, "font-style") {
        emph = style.starts_with("italic") || style.starts_with("oblique");
    }
    let decoration = [
        style_value(node, "text-decoration"),
        style_value(node, "text-decoration-line"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    if decoration.contains("line-through") && !funcs.contains(&"strike") {
        funcs.push("strike");
    }
    if decoration.contains("underline") && !funcs.contains(&"underline") {
        funcs.push("underline");
    }
    match style_value(node, "vertical-align").as_deref() {
        Some("super") if !funcs.contains(&"super") => funcs.push("super"),
        Some("sub") if !funcs.contains(&"sub") => funcs.push("sub"),
        _ => {}
    }

    // Nested strong/emph would close the outer delimiter instead.
    strong &= !cx.in_strong;
    emph &= !cx.in_emph;

    let mut layers: Vec<Layer> = funcs.into_iter().map(Layer::Func).collect();
    if strong {
        layers.push(Layer::Strong);
    }
    if emph {
        layers.push(Layer::Emph);
    }
    // Inline formatting can't span paragraphs, so formatting around block
    // content is dropped rather than left unbalanced.
    if layers.is_empty() || has_block_descendant(node) {
        walk_children(node, w, cx);
        return;
    }

    let inner_cx = Ctx {
        in_strong: cx.in_strong || strong,
        in_emph: cx.in_emph || emph,
        ..cx
    };
    let mut sub = w.child();
    walk_children(node, &mut sub, inner_cx);
    let (inner, lead, trail) = sub.finish_inline();
    if lead {
        w.space();
    }
    // `layers` runs outermost first; wrap from the inside out, leaving the
    // outermost layer to the writer, which knows what precedes it.
    if let (false, Some((outer, rest))) = (inner.is_empty(), layers.split_first()) {
        let wrapped = rest.iter().rev().fold(inner, |s, layer| match layer {
            Layer::Func(f) => format!("#{f}[{s}]"),
            Layer::Strong => format!("*{s}*"),
            Layer::Emph => format!("_{s}_"),
        });
        match outer {
            Layer::Func(f) => w.markup(&format!("#{f}[{wrapped}]"), Tail::Call),
            Layer::Strong => w.delimited('*', "strong", &wrapped),
            Layer::Emph => w.delimited('_', "emph", &wrapped),
        }
    }
    if trail {
        w.space();
    }
}

fn link(node: &NodeRef, w: &mut Writer, cx: Ctx) {
    let href = node.attr("href").map(|h| h.trim().to_string());
    let Some(href) = href.filter(|h| !cx.in_link && is_remote_url(h, true)) else {
        walk_children(node, w, cx);
        return;
    };
    if has_block_descendant(node) {
        walk_children(node, w, cx);
        return;
    }
    let mut sub = w.child();
    walk_children(
        node,
        &mut sub,
        Ctx {
            in_link: true,
            ..cx
        },
    );
    let (inner, lead, trail) = sub.finish_inline();
    // A link with no visible text (an icon, say) has nothing to click.
    if inner.is_empty() {
        return;
    }
    if lead {
        w.space();
    }
    let text = collapse_whitespace(&node.text());
    let shows_url = text == href || href.strip_prefix("mailto:") == Some(text.as_str());
    let call = if shows_url {
        format!("#link({})", string_literal(&href))
    } else {
        format!("#link({})[{inner}]", string_literal(&href))
    };
    w.markup(&call, Tail::Call);
    if trail {
        w.space();
    }
}

/// Whether `url` is an absolute web address (or a `mailto:` address when
/// `allow_mailto`). Relative links and in-page anchors point back into the
/// page the content was copied from, so they aren't kept.
fn is_remote_url(url: &str, allow_mailto: bool) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://")
        || lower.starts_with("http://")
        || (allow_mailto && lower.starts_with("mailto:"))
}

fn image(node: &NodeRef, w: &mut Writer, cx: Ctx) {
    let alt = node
        .attr("alt")
        .map(|a| collapse_whitespace(&a))
        .unwrap_or_default();
    let src = node.attr("src").map(|s| s.trim().to_string());
    match src.filter(|s| !cx.in_link && is_remote_url(s, false)) {
        Some(src) => {
            let label = if alt.is_empty() {
                url_file_name(&src).to_string()
            } else {
                alt
            };
            w.markup(
                &format!(
                    "#link({})[{}]",
                    string_literal(&src),
                    escape_markup(&label, true)
                ),
                Tail::Call,
            );
        }
        None if !alt.is_empty() => w.text(&alt),
        None => {}
    }
}

/// The last path segment of a URL, without its query or fragment.
fn url_file_name(url: &str) -> &str {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    match path.trim_end_matches('/').rsplit('/').next() {
        Some(name) if !name.is_empty() => name,
        _ => url,
    }
}

fn inline_code(node: &NodeRef, w: &mut Writer) {
    let raw = node.text();
    if raw.starts_with(char::is_whitespace) {
        w.space();
    }
    inline_raw(w, &collapse_whitespace(&raw));
    if raw.ends_with(char::is_whitespace) {
        w.space();
    }
}

/// Write `code` as inline raw text: `` `code` ``, or `#raw("…")` when the
/// code itself contains a backtick.
fn inline_raw(w: &mut Writer, code: &str) {
    if code.is_empty() {
        return;
    }
    if code.contains('`') {
        w.markup(&format!("#raw({})", string_literal(code)), Tail::Call);
    } else {
        w.markup(&format!("`{code}`"), Tail::Plain);
    }
}

/// MathML. Pages that render LaTeX (Wikipedia, MathJax, KaTeX) keep the
/// source in a TeX annotation or `alttext`; it is kept as raw LaTeX, as the
/// Markdown importer does without mitex. Otherwise the math's text is used.
fn math(node: &NodeRef, w: &mut Writer) {
    let tex = node
        .descendants_it()
        .find(|d| {
            d.node_name().as_deref() == Some("annotation")
                && d.attr("encoding")
                    .is_some_and(|e| e.eq_ignore_ascii_case("application/x-tex"))
        })
        .map(|a| a.text().to_string())
        .or_else(|| node.attr("alttext").map(|t| t.to_string()))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let Some(tex) = tex else {
        w.text(&node.text());
        return;
    };
    let display = node.attr("display").is_some_and(|d| &*d == "block");
    if display && !w.single_line {
        w.brk(Pending::Paragraph);
        w.markup(&fenced("latex", &tex), Tail::Plain);
        w.brk(Pending::Paragraph);
    } else {
        inline_raw(w, &collapse_whitespace(&tex));
    }
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

fn heading(node: &NodeRef, w: &mut Writer, cx: Ctx, level: usize) {
    if w.single_line {
        walk_children(node, w, cx);
        return;
    }
    w.brk(Pending::Paragraph);
    let mut sub = w.child();
    sub.single_line = true;
    walk_children(node, &mut sub, cx);
    let (inner, _, _) = sub.finish_inline();
    if !inner.is_empty() {
        w.markup(&format!("{} {inner}", "=".repeat(level)), Tail::Plain);
    }
    w.brk(Pending::Paragraph);
}

fn list(node: &NodeRef, w: &mut Writer, cx: Ctx, ordered: bool) {
    // A nested list sits directly under its parent item's text; a top-level
    // list is set off from the surrounding paragraphs.
    let edge = if cx.in_list {
        Pending::Newline
    } else {
        Pending::Paragraph
    };
    w.brk(edge);
    let start = if ordered {
        node.attr("start")
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(1)
    } else {
        1
    };
    let item_cx = Ctx {
        in_list: true,
        ..cx
    };
    let mut first = true;
    for child in node.children_it(false) {
        if child.node_name().as_deref() != Some("li") {
            walk(&child, w, item_cx);
            continue;
        }
        // Typst numbers `+` items from 1, or on from an explicit `N.`.
        let marker = match (ordered, first && start != 1) {
            (false, _) => "- ".to_string(),
            (true, true) => format!("{start}. "),
            (true, false) => "+ ".to_string(),
        };
        list_item(&child, w, item_cx, &marker);
        first = false;
    }
    w.brk(edge);
}

fn list_item(node: &NodeRef, w: &mut Writer, cx: Ctx, marker: &str) {
    if w.single_line {
        walk_children(node, w, cx);
        return;
    }
    w.brk(Pending::Newline);
    if let Some(done) = task_state(node) {
        let mut body = String::new();
        item_text(node, &mut body);
        let done_arg = if done { ", done: true" } else { "" };
        w.markup(
            &format!(
                "#task({}{done_arg})",
                string_literal(&collapse_whitespace(&body))
            ),
            Tail::Call,
        );
        return;
    }
    w.marker(marker);
    let saved = w.indent.clone();
    w.indent.push_str(&" ".repeat(marker.chars().count()));
    walk_children(node, w, cx);
    w.indent = saved;
    // An empty item must still end before the next marker.
    w.fresh = false;
}

/// For a checklist item (a checkbox before any text), whether it is ticked.
fn task_state(item: &NodeRef) -> Option<bool> {
    for d in item.descendants_it() {
        if d.is_text() {
            if d.text().trim().is_empty() {
                continue;
            }
            return None;
        }
        if d.node_name().as_deref() == Some("input") {
            let checkbox = d
                .attr("type")
                .is_some_and(|t| t.eq_ignore_ascii_case("checkbox"));
            return checkbox.then(|| d.has_attr("checked"));
        }
    }
    None
}

/// A list item's own text, leaving out any nested lists.
fn item_text(node: &NodeRef, out: &mut String) {
    for child in node.children_it(false) {
        if child.is_text() {
            out.push_str(&child.text());
        } else if !matches!(child.node_name().as_deref(), Some("ul" | "ol" | "menu")) {
            item_text(&child, out);
        }
    }
}

/// `<dl>` becomes a Typst term list: `/ Term: description`.
fn term_list(node: &NodeRef, w: &mut Writer, cx: Ctx) {
    if w.single_line {
        walk_children(node, w, cx);
        return;
    }
    w.brk(Pending::Paragraph);
    let mut after_term = false;
    let mut first_description = true;
    for child in node.children_it(false) {
        match child.node_name().as_deref() {
            Some("dt") => {
                w.brk(Pending::Newline);
                let mut sub = w.child();
                sub.single_line = true;
                walk_children(&child, &mut sub, cx);
                let (term, _, _) = sub.finish_inline();
                w.marker(&format!("/ {term}: "));
                after_term = true;
                first_description = true;
            }
            Some("dd") if after_term => {
                if !first_description {
                    w.brk(Pending::Paragraph);
                }
                let saved = w.indent.clone();
                w.indent.push_str("  ");
                walk_children(&child, w, cx);
                w.indent = saved;
                w.fresh = false;
                first_description = false;
            }
            _ => walk(&child, w, cx),
        }
    }
    w.brk(Pending::Paragraph);
}

fn quote(node: &NodeRef, w: &mut Writer, cx: Ctx) {
    if w.single_line {
        walk_children(node, w, cx);
        return;
    }
    w.brk(Pending::Paragraph);
    let mut sub = w.child();
    walk_children(node, &mut sub, cx);
    let inner = sub.finish();
    if !inner.is_empty() {
        w.markup(&format!("#quote(block: true)[{inner}]"), Tail::Call);
    }
    w.brk(Pending::Paragraph);
}

fn pre(node: &NodeRef, w: &mut Writer) {
    let mut code = String::new();
    pre_text(node, &mut code);
    let code = code.replace("\r\n", "\n");
    let code = code.trim_start_matches('\n').trim_end();
    if code.trim().is_empty() {
        return;
    }
    if w.single_line {
        inline_raw(w, &collapse_whitespace(code));
        return;
    }
    w.brk(Pending::Paragraph);
    w.markup(&fenced(&code_language(node), code), Tail::Plain);
    w.brk(Pending::Paragraph);
}

/// Preformatted text with `<br>` as a newline.
fn pre_text(node: &NodeRef, out: &mut String) {
    for child in node.children_it(false) {
        if child.is_text() {
            out.push_str(&child.text());
        } else if child.node_name().as_deref() == Some("br") {
            out.push('\n');
        } else {
            pre_text(&child, out);
        }
    }
}

/// A Typst raw block, fenced with more backticks than the code contains in
/// a row.
fn fenced(lang: &str, code: &str) -> String {
    let longest_run = code
        .split(|c| c != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "`".repeat((longest_run + 1).max(3));
    format!("{fence}{lang}\n{code}\n{fence}")
}

/// The code language from the class names highlighters put on the `<pre>`,
/// its `<code>` child, or its wrapper (`language-rust`, `lang-rust`,
/// GitHub's `highlight-source-rust`).
fn code_language(pre: &NodeRef) -> String {
    let candidates = [
        Some(*pre),
        pre.first_element_child(),
        pre.parent(),
    ];
    for node in candidates.into_iter().flatten() {
        let Some(class) = node.class() else { continue };
        for name in class.split_whitespace() {
            let lang = ["language-", "lang-", "highlight-source-"]
                .iter()
                .find_map(|prefix| name.strip_prefix(prefix));
            if let Some(lang) = lang {
                let lang: String = lang
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+'))
                    .collect();
                if lang.starts_with(|c: char| c.is_ascii_alphabetic()) {
                    return lang;
                }
            }
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

struct Row<'a> {
    cells: Vec<NodeRef<'a>>,
    header: bool,
}

fn table(node: &NodeRef, w: &mut Writer, cx: Ctx) {
    let mut rows: Vec<Row> = Vec::new();
    let mut caption = None;
    for child in node.children_it(false) {
        match child.node_name().as_deref() {
            Some("caption") => caption = Some(child),
            Some("thead") => rows.extend(table_rows(&child, true)),
            Some("tbody" | "tfoot") => rows.extend(table_rows(&child, false)),
            Some("tr") => rows.push(table_row(&child, false)),
            _ => {}
        }
    }
    rows.retain(|r| !r.cells.is_empty());

    let columns = rows
        .iter()
        .map(|r| r.cells.iter().map(|c| span(c, "colspan")).sum::<usize>())
        .max()
        .unwrap_or(0);
    // Tables used to lay out a page (a single column, nested tables, or
    // marked as presentational) read better as plain paragraphs.
    let layout = w.single_line
        || columns < 2
        || node
            .attr("role")
            .is_some_and(|r| matches!(&*r, "presentation" | "none"))
        || node
            .descendants_it()
            .any(|d| d.node_name().as_deref() == Some("table"));
    if layout {
        w.brk(Pending::Paragraph);
        for row in &rows {
            for cell in &row.cells {
                w.brk(Pending::Paragraph);
                walk_children(cell, w, cx);
            }
        }
        if let Some(caption) = caption {
            w.brk(Pending::Paragraph);
            walk_children(&caption, w, cx);
        }
        w.brk(Pending::Paragraph);
        return;
    }

    // Without a <thead>, a first row made entirely of <th> is the header.
    if !rows.iter().any(|r| r.header)
        && rows[0]
            .cells
            .iter()
            .all(|c| c.node_name().as_deref() == Some("th"))
    {
        rows[0].header = true;
    }
    let spans = rows.iter().flat_map(|r| &r.cells).any(|c| {
        span(c, "colspan") > 1 || span(c, "rowspan") > 1
    });

    let caption = caption.map(|c| {
        let mut sub = w.child();
        sub.single_line = true;
        walk_children(&c, &mut sub, cx);
        sub.finish()
    })
    .filter(|c| !c.is_empty());
    let indent = match caption {
        Some(_) => format!("{}  ", w.indent),
        None => w.indent.clone(),
    };

    let mut header_cells = Vec::new();
    let mut body_lines = Vec::new();
    for row in &rows {
        let mut cells: Vec<String> = row
            .cells
            .iter()
            .map(|c| table_cell(c, row.header, w, &indent, cx))
            .collect();
        // The visual table editor needs every row to fill the grid.
        if !spans {
            cells.resize(columns, "[]".to_string());
        }
        if row.header {
            header_cells.extend(cells);
        } else {
            body_lines.push(format!("{indent}  {},", cells.join(", ")));
        }
    }

    let mut src = format!(
        "table(\n{indent}  columns: ({}),\n",
        vec!["auto"; columns].join(", ")
    );
    if !header_cells.is_empty() {
        src.push_str(&format!(
            "{indent}  table.header({}),\n",
            header_cells.join(", ")
        ));
    }
    for line in body_lines {
        src.push_str(&line);
        src.push('\n');
    }
    src.push_str(&indent);
    src.push(')');
    let src = match caption {
        Some(caption) => format!(
            "#figure(\n{indent}{src},\n{indent}caption: [{caption}],\n{})",
            w.indent
        ),
        None => format!("#{src}"),
    };

    w.brk(Pending::Paragraph);
    w.markup(&src, Tail::Call);
    w.brk(Pending::Paragraph);
}

fn table_rows<'a>(section: &NodeRef<'a>, header: bool) -> Vec<Row<'a>> {
    section
        .children_it(false)
        .filter(|c| c.node_name().as_deref() == Some("tr"))
        .map(|tr| table_row(&tr, header))
        .collect()
}

fn table_row<'a>(tr: &NodeRef<'a>, header: bool) -> Row<'a> {
    let cells = tr
        .children_it(false)
        .filter(|c| matches!(c.node_name().as_deref(), Some("td" | "th")))
        .collect();
    Row { cells, header }
}

/// A cell's `colspan` or `rowspan`, clamped to a sane range.
fn span(cell: &NodeRef, attr: &str) -> usize {
    cell.attr(attr)
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(1)
        .clamp(1, 1000)
}

fn table_cell(cell: &NodeRef, header: bool, w: &Writer, indent: &str, cx: Ctx) -> String {
    let mut sub = w.child();
    sub.indent = format!("{indent}    ");
    let is_th = cell.node_name().as_deref() == Some("th");
    walk_children(
        cell,
        &mut sub,
        Ctx {
            in_strong: cx.in_strong || is_th,
            ..cx
        },
    );
    let mut inner = sub.finish();
    // Match the Markdown importer: header cells are bold.
    if (header || is_th) && !inner.is_empty() && !inner.contains('\n') {
        inner = format!("*{inner}*");
    }
    let colspan = span(cell, "colspan");
    let rowspan = span(cell, "rowspan");
    let mut args = Vec::new();
    if colspan > 1 {
        args.push(format!("colspan: {colspan}"));
    }
    if rowspan > 1 {
        args.push(format!("rowspan: {rowspan}"));
    }
    if args.is_empty() {
        format!("[{inner}]")
    } else {
        format!("table.cell({})[{inner}]", args.join(", "))
    }
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/// Escape text so Typst renders it literally. `line_start` means the text
/// begins a line or content block, where a leading `=`, `-`, `+`, `/`, or
/// `1.` would start a heading or list.
///
/// Bare `http://` / `https://` URLs are copied verbatim, using Typst's own
/// rule for where an automatic link ends, since Typst links them and an
/// escape inside one would break it.
fn escape_markup(text: &str, line_start: bool) -> String {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let first = chars.first().map(|&(_, c)| c);
    let followed_by_space = |i: usize| chars.get(i).is_none_or(|&(_, c)| c.is_whitespace());

    let mut escape_first = false;
    let mut escape_at = None;
    if line_start {
        match first {
            Some('=') => {
                let run = chars.iter().take_while(|&&(_, c)| c == '=').count();
                escape_first = followed_by_space(run);
            }
            Some('-' | '+' | '/') => escape_first = followed_by_space(1),
            Some(c) if c.is_ascii_digit() => {
                let run = chars.iter().take_while(|&&(_, c)| c.is_ascii_digit()).count();
                if chars.get(run).is_some_and(|&(_, c)| c == '.') && followed_by_space(run + 1) {
                    escape_at = Some(run);
                }
            }
            _ => {}
        }
    }

    let mut out = String::with_capacity(text.len() + 8);
    let mut i = 0;
    while i < chars.len() {
        let (pos, c) = chars[i];
        let prev = i.checked_sub(1).map(|p| chars[p].1);
        let next = chars.get(i + 1).map(|&(_, c)| c);

        if c == 'h' {
            let rest = &text[pos..];
            let scheme = ["https://", "http://"]
                .iter()
                .find(|s| rest.starts_with(**s))
                .map_or(0, |s| s.len());
            if scheme > 0 {
                let (link, balanced) = link_prefix(&rest[scheme..]);
                if balanced && !link.is_empty() {
                    let end = pos + scheme + link.len();
                    out.push_str(&text[pos..end]);
                    while i < chars.len() && chars[i].0 < end {
                        i += 1;
                    }
                    continue;
                }
                // Not a link Typst would accept: keep it as plain text.
                out.push('\\');
            }
        }

        let alnum = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric());
        let escape = (i == 0 && escape_first)
            || escape_at == Some(i)
            || match c {
                '\\' | '`' | '$' | '#' | '[' | ']' | '<' | '@' | '~' => true,
                // Inside a word Typst reads these as plain characters.
                '*' | '_' => !(alnum(prev) && alnum(next)),
                // `//` and `/*` open comments.
                '/' => matches!(next, Some('/' | '*')),
                // `--`, `---`, `-?`, and a leading `-5` are shorthands.
                '-' => {
                    matches!(next, Some('-' | '?'))
                        || (next.is_some_and(|n| n.is_ascii_digit())
                            && !prev.is_some_and(char::is_alphanumeric))
                }
                _ => false,
            };
        if escape {
            out.push('\\');
        }
        out.push(c);
        i += 1;
    }
    out
}

/// A Typst string literal holding `s`.
fn string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv(html: &str) -> String {
        html_to_typst(html)
    }

    #[test]
    fn paragraphs_and_headings() {
        assert_eq!(
            conv("<h1>Title</h1><p>One</p><p>Two</p><h3>Sub</h3>"),
            "= Title\n\nOne\n\nTwo\n\n=== Sub"
        );
    }

    #[test]
    fn whitespace_collapses_like_a_browser() {
        assert_eq!(conv("<p>  a \n  b\t c  </p>"), "a b c");
    }

    #[test]
    fn inline_formatting_uses_markup_delimiters() {
        assert_eq!(
            conv("<p>a <b>bold</b> and <em>it</em>.</p>"),
            "a *bold* and _it_."
        );
    }

    #[test]
    fn whitespace_inside_formatting_moves_outside() {
        assert_eq!(conv("<p>a<b> bold </b>b</p>"), "a *bold* b");
    }

    #[test]
    fn formatting_inside_a_word_uses_function_form() {
        assert_eq!(conv("<p>un<b>believ</b>able</p>"), "un#strong[believ]able");
        assert_eq!(conv("<p><i>foo</i>bar</p>"), "#emph[foo]bar");
    }

    #[test]
    fn nested_bold_is_not_doubled() {
        assert_eq!(conv("<b>a <strong>b</strong> c</b>"), "*a b c*");
    }

    #[test]
    fn bold_and_italic_nest() {
        assert_eq!(conv("<b><i>x</i></b>"), "*_x_*");
    }

    #[test]
    fn other_inline_functions() {
        assert_eq!(
            conv("<p><s>a</s> <u>b</u> <mark>c</mark> H<sub>2</sub>O x<sup>2</sup></p>"),
            "#strike[a] #underline[b] #highlight[c] H#sub[2]O x#super[2]"
        );
    }

    #[test]
    fn google_docs_style_spans() {
        let html = r#"<b style="font-weight:normal;" id="docs-internal-guid-1"><p><span style="font-weight:700">Bold</span> <span style="font-style:italic">it</span> <span style="text-decoration:line-through">gone</span></p></b>"#;
        assert_eq!(conv(html), "*Bold* _it_ #strike[gone]");
    }

    #[test]
    fn formatting_around_blocks_is_dropped() {
        assert_eq!(conv("<b><p>one</p><p>two</p></b>"), "one\n\ntwo");
    }

    #[test]
    fn markup_characters_are_escaped() {
        assert_eq!(
            conv("<p>#tag $5 *x* a_b [c] @ref &lt;l&gt; ~ `t` \\</p>"),
            "\\#tag \\$5 \\*x\\* a_b \\[c\\] \\@ref \\<l> \\~ \\`t\\` \\\\"
        );
    }

    #[test]
    fn line_start_markers_are_escaped() {
        assert_eq!(conv("<p>= not a heading</p>"), "\\= not a heading");
        assert_eq!(conv("<p>- not a list</p>"), "\\- not a list");
        assert_eq!(conv("<p>+ plus</p>"), "\\+ plus");
        assert_eq!(conv("<p>1. first</p>"), "1\\. first");
        assert_eq!(conv("<p>x - y</p>"), "x - y");
    }

    #[test]
    fn shorthands_and_comments_are_escaped() {
        assert_eq!(conv("<p>a -- b and/or // c</p>"), "a \\-- b and/or \\// c");
        assert_eq!(conv("<p>2024-05-01 is -5</p>"), "2024-05-01 is \\-5");
    }

    #[test]
    fn bare_urls_stay_verbatim() {
        assert_eq!(
            conv("<p>See https://example.com/a_b*c.</p>"),
            "See https://example.com/a_b*c."
        );
    }

    #[test]
    fn links() {
        assert_eq!(
            conv(r#"<p><a href="https://typst.app">Typst <b>docs</b></a></p>"#),
            "#link(\"https://typst.app\")[Typst *docs*]"
        );
        assert_eq!(
            conv(r#"<a href="https://typst.app">https://typst.app</a>"#),
            "#link(\"https://typst.app\")"
        );
        assert_eq!(
            conv(r#"<a href="mailto:a@b.org">a@b.org</a>"#),
            "#link(\"mailto:a@b.org\")"
        );
    }

    #[test]
    fn relative_links_keep_only_their_text() {
        assert_eq!(conv(r##"<a href="#section">Jump</a>"##), "Jump");
        assert_eq!(conv(r#"<a href="/wiki/Foo">Foo</a>"#), "Foo");
    }

    #[test]
    fn text_after_a_call_cannot_extend_it() {
        assert_eq!(
            conv(r#"<a href="https://x.org">x</a>(y) <s>a</s>.b"#),
            "#link(\"https://x.org\")[x]\\(y) #strike[a]\\.b"
        );
    }

    #[test]
    fn remote_images_become_links() {
        assert_eq!(
            conv(r#"<img src="https://x.org/cat.png?s=2" alt="A cat">"#),
            "#link(\"https://x.org/cat.png?s=2\")[A cat]"
        );
        assert_eq!(
            conv(r#"<img src="https://x.org/cat.png">"#),
            "#link(\"https://x.org/cat.png\")[cat.png]"
        );
        assert_eq!(conv(r#"<img src="data:image/png;base64,AA" alt="dot">"#), "dot");
    }

    #[test]
    fn unordered_and_nested_lists() {
        assert_eq!(
            conv("<p>Intro</p><ul><li>one</li><li>two<ul><li>deep</li></ul></li></ul><p>After</p>"),
            "Intro\n\n- one\n- two\n  - deep\n\nAfter"
        );
    }

    #[test]
    fn ordered_lists_and_start() {
        assert_eq!(conv("<ol><li>a</li><li>b</li></ol>"), "+ a\n+ b");
        assert_eq!(conv(r#"<ol start="4"><li>a</li><li>b</li></ol>"#), "4. a\n+ b");
    }

    #[test]
    fn list_items_with_paragraphs_stay_in_the_item() {
        assert_eq!(
            conv("<ul><li><p>first</p><p>more</p></li><li>next</li></ul>"),
            "- first\n\n  more\n\n- next"
        );
    }

    #[test]
    fn line_breaks() {
        assert_eq!(conv("<p>a<br>b</p>"), "a \\\nb");
        assert_eq!(conv("<p>a<br><br>b</p>"), "a\n\nb");
        assert_eq!(conv("<p>a<br></p><p>b</p>"), "a\n\nb");
    }

    #[test]
    fn checklists_become_tasks() {
        assert_eq!(
            conv(r#"<ul><li><input type="checkbox" checked> Done "it"</li><li><input type="checkbox"> Todo</li></ul>"#),
            "#task(\"Done \\\"it\\\"\", done: true)\n#task(\"Todo\")"
        );
    }

    #[test]
    fn definition_lists_become_term_lists() {
        assert_eq!(
            conv("<dl><dt>Term</dt><dd>Meaning</dd><dt>Other</dt><dd>One</dd><dd>Two</dd></dl>"),
            "/ Term: Meaning\n/ Other: One\n\n  Two"
        );
    }

    #[test]
    fn blockquotes() {
        assert_eq!(
            conv("<blockquote><p>One</p><p>Two</p></blockquote>"),
            "#quote(block: true)[One\n\nTwo]"
        );
    }

    #[test]
    fn code_blocks_keep_content_verbatim() {
        assert_eq!(
            conv("<pre><code class=\"language-rust\">fn main() {\n    let x = a_b * $c;\n}\n</code></pre>"),
            "```rust\nfn main() {\n    let x = a_b * $c;\n}\n```"
        );
        assert_eq!(
            conv("<pre>has ``` inside</pre>"),
            "````\nhas ``` inside\n````"
        );
    }

    #[test]
    fn inline_code() {
        assert_eq!(conv("<p>Run <code>a*b</code> now</p>"), "Run `a*b` now");
        assert_eq!(conv("<p><code>x`y</code></p>"), "#raw(\"x`y\")");
    }

    #[test]
    fn tables_use_the_visual_editor_form() {
        let html = "<table><thead><tr><th>A</th><th>B</th></tr></thead>\
                    <tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></tbody></table>";
        assert_eq!(
            conv(html),
            "#table(\n  columns: (auto, auto),\n  table.header([*A*], [*B*]),\n  [1], [2],\n  [3], [],\n)"
        );
    }

    #[test]
    fn table_spans_use_table_cell() {
        let html = r#"<table><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>b</td></tr></table>"#;
        assert_eq!(
            conv(html),
            "#table(\n  columns: (auto, auto),\n  table.cell(colspan: 2)[wide],\n  [a], [b],\n)"
        );
    }

    #[test]
    fn table_caption_becomes_a_figure() {
        let html = "<table><caption>Results</caption><tr><td>a</td><td>b</td></tr></table>";
        assert_eq!(
            conv(html),
            "#figure(\n  table(\n    columns: (auto, auto),\n    [a], [b],\n  ),\n  caption: [Results],\n)"
        );
    }

    #[test]
    fn layout_tables_become_paragraphs() {
        assert_eq!(
            conv("<table><tr><td>one</td></tr><tr><td>two</td></tr></table>"),
            "one\n\ntwo"
        );
    }

    #[test]
    fn hidden_and_non_content_elements_are_skipped() {
        assert_eq!(
            conv(r#"<style>p{}</style><script>x()</script><p>keep<span hidden>no</span><span style="display: none">no</span></p>"#),
            "keep"
        );
    }

    #[test]
    fn browser_clipboard_wrappers() {
        let firefox = "<html><body>\n<!--StartFragment--><p>Hi <b>there</b></p><!--EndFragment-->\n</body>\n</html>";
        assert_eq!(conv(firefox), "Hi *there*");
        let chrome = "<meta charset='utf-8'><span style=\"color: rgb(0,0,0);\">Plain text</span>";
        assert_eq!(conv(chrome), "Plain text");
    }

    #[test]
    fn math_keeps_latex_source() {
        let html = r#"<p>So <math alttext="x^{2}"><mi>x</mi></math> holds</p>"#;
        assert_eq!(conv(html), "So `x^{2}` holds");
    }

    #[test]
    fn non_ascii_text_survives() {
        assert_eq!(
            conv("<p>Café — «naïve» 日本語 <b>ünï</b></p>"),
            "Café — «naïve» 日本語 *ünï*"
        );
    }

    #[test]
    fn plain_text_fallback() {
        assert_eq!(
            plain_text_to_typst("Line *one*\nline two\n\n# Next"),
            "Line \\*one\\* \\\nline two\n\n\\# Next"
        );
    }
}
