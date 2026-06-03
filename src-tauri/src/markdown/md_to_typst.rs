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

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use super::frontmatter::{parse_frontmatter_fields, sanitize_ident, system_alias, ParsedYamlValue};
use crate::property_types::{builtin_property_type, PropertyType};

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
    /// User-confirmed YAML→property mapping from the import dialog, keyed by
    /// lowercased source key. When `Some`, frontmatter is emitted strictly
    /// per this table — keys absent from it (or mapped to `None`) are
    /// dropped, and each value is formatted for its target property type.
    /// When `None`, the importer falls back to the built-in alias defaults
    /// (used by paths with no mapping UI: directory import, paste).
    pub frontmatter_mapping: Option<FrontmatterMapping>,
    /// How to render LaTeX-flavoured math (`$…$` / `$$…$$`) from the source.
    /// Markdown math is LaTeX, which Typst can't typeset natively — see
    /// [`MathImportMode`].
    pub math: MathImportMode,
}

impl Default for MarkdownToTypstOptions {
    fn default() -> Self {
        Self {
            convert_frontmatter: true,
            // Mirrors `FileSettings::default().attachment_folder` so a
            // bare-options conversion still emits a sensible path.
            attachment_folder: "Assets".to_string(),
            dialect: MarkdownDialect::default(),
            frontmatter_mapping: None,
            math: MathImportMode::default(),
        }
    }
}

/// Strategy for importing LaTeX math, chosen per-import by probing the target
/// notebox for a user-installed `mitex` package.
#[derive(Debug, Clone)]
pub enum MathImportMode {
    /// `mitex` is installed — render LaTeX via `#mi(`…`)` (inline) and
    /// `#mitex(`…`)` (block), adding the package import to notes that use it.
    /// The string is the installed version, for the import line.
    Mitex { version: String },
    /// `mitex` is absent — preserve the LaTeX verbatim as inline raw (inline
    /// math) or a fenced ```` ```latex ```` block (display math). Nothing is
    /// lost and the note still compiles; the user can install mitex or
    /// rewrite the math as Typst math later.
    Preserve,
}

impl Default for MathImportMode {
    fn default() -> Self {
        MathImportMode::Preserve
    }
}

/// Counts/flags from one conversion, so the importer can report how many
/// LaTeX equations fell back to code blocks (and tell the user how to render
/// them).
#[derive(Debug, Clone, Default)]
pub struct ConversionStats {
    /// LaTeX equations preserved as code (mitex absent).
    pub latex_math_as_code: u32,
    /// Whether any `#mi`/`#mitex` call was emitted (mitex present).
    pub used_mitex: bool,
}

/// How a single source frontmatter key should be imported.
#[derive(Debug, Clone)]
pub struct FieldMapping {
    /// Target `#note(...)` argument name, or `None` to drop the property.
    pub target_key: Option<String>,
    /// Property type the value is formatted as (list → tuple, number → bare
    /// numeral, checkbox → `true`/`false`, everything else → quoted string).
    pub target_type: PropertyType,
}

/// Lowercased-source-key → mapping. Built from the user's dialog choices.
pub type FrontmatterMapping = HashMap<String, FieldMapping>;

/// `![[name.png|alt]]` — Obsidian-style image embed. Must run BEFORE
/// the wikilink regex so the `[[name]]` portion isn't matched as a
/// plain wikilink and the leading `!` left orphaned. The alt-text
/// group (after `|`) is captured but currently dropped on emit:
/// `#image` in Typst doesn't take an alt argument; if we later want
/// to preserve it for search/accessibility, the place to do so is in
/// the replacement closure.
static IMAGE_EMBED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap());

/// Standard CommonMark image: `![alt](url "title")`. Captures the URL up to
/// the first whitespace or closing paren (so an optional title is ignored).
static STD_IMAGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\(\s*([^)\s]+)").unwrap());

static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap());

static OBSIDIAN_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)").unwrap());

static OBSIDIAN_HIGHLIGHT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"==([^=\n>][^=\n]*)==").unwrap());

// CriticMarkup → InkyCap primitives (interop with Obsidian/iA Writer/etc.).
// Suggestions map to `#suggestion(...)`; CriticMarkup's comment + highlight map
// to `#annotation` / `#highlight`. These run before the bare `==highlight==` pass
// because `{==x==}` embeds `==x==`. `(?s)`-style `[\s\S]*?` allows multi-word
// (single-line) content.
static CRITIC_SUBSTITUTE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{~~([\s\S]*?)~>([\s\S]*?)~~\}").unwrap());
static CRITIC_INSERT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\+\+([\s\S]*?)\+\+\}").unwrap());
static CRITIC_DELETE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{--([\s\S]*?)--\}").unwrap());
static CRITIC_COMMENT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{>>([\s\S]*?)<<\}").unwrap());
static CRITIC_HIGHLIGHT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{==([\s\S]*?)==\}").unwrap());

/// Obsidian inline-comment syntax: `%%comment%%`. Renders to nothing in
/// Obsidian; we strip it pre-parse for the Obsidian dialect only.
/// `(?s)` makes `.` match newlines so multi-line comments are caught.
static OBSIDIAN_COMMENT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)%%.*?%%").unwrap());

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

/// Extract the basenames of files referenced by standard markdown images
/// (`![alt](path)`), skipping external (`http(s)://`, `data:`) and already-
/// absolute (`/…`) URLs. Like [`extract_embed_filenames`], the importer routes
/// these files into the user's `attachment_folder` so every imported image
/// lands in one place (matching drag/drop/paste behaviour — see CLAUDE.md).
pub fn extract_image_filenames(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    for caps in STD_IMAGE_RE.captures_iter(input) {
        let url = caps[1].trim();
        if is_external_or_absolute(url) {
            continue;
        }
        let basename = image_basename(url);
        if !basename.is_empty() {
            out.push(basename.to_string());
        }
    }
    out
}

/// Whether an image URL points outside the notebox (so it's left untouched):
/// a scheme-qualified URL (`http://`, `data:`) or an already notebox-absolute
/// path (`/…`).
fn is_external_or_absolute(url: &str) -> bool {
    url.starts_with('/') || url.starts_with("data:") || url.contains("://")
}

/// The final path component of an image URL (its filename).
fn image_basename(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or(url)
}

/// Rewrite a standard-markdown image URL to the notebox-absolute attachment
/// path the importer routes the file into. External/absolute URLs pass
/// through unchanged.
fn route_image_url(url: &str, attachment_folder: &str) -> String {
    if is_external_or_absolute(url) {
        return url.to_string();
    }
    let basename = image_basename(url);
    let folder = attachment_folder.trim_matches('/');
    if folder.is_empty() {
        format!("/{}", basename)
    } else {
        format!("/{}/{}", folder, basename)
    }
}

/// Convert a markdown string to InkyCap-flavored Typst source.
pub fn markdown_to_typst(input: &str, options: &MarkdownToTypstOptions) -> String {
    markdown_to_typst_with_stats(input, options).0
}

/// Like [`markdown_to_typst`] but also returns [`ConversionStats`] so callers
/// can report e.g. how many LaTeX equations were preserved as code blocks.
pub fn markdown_to_typst_with_stats(
    input: &str,
    options: &MarkdownToTypstOptions,
) -> (String, ConversionStats) {
    let (frontmatter, body) = extract_frontmatter(input);

    let mut out = String::with_capacity(input.len());

    // Emit import preamble.
    out.push_str(&crate::notebox_package::import_line());
    out.push('\n');

    // Emit #note(...) from frontmatter.
    if options.convert_frontmatter {
        if let Some(fm) = frontmatter {
            let note_call = match &options.frontmatter_mapping {
                Some(mapping) => frontmatter_to_note_mapped(&fm, mapping),
                None => frontmatter_to_note(&fm),
            };
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
    let preprocessed = preprocess_markdown(body, &options.attachment_folder, options.dialect);

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
    // Convert the body inside a scope so the converter's mutable borrow of
    // `out` ends before we (possibly) splice in the mitex import line.
    let stats = {
        let mut converter = Converter::new(&mut out);
        converter.math_mode = options.math.clone();
        converter.attachment_folder = options.attachment_folder.clone();
        converter.convert(parser);
        ConversionStats {
            latex_math_as_code: converter.math_as_code,
            used_mitex: converter.used_mitex,
        }
    };

    // If any note actually used mitex, add its package import right after the
    // notebox import line. Only notes with math carry the dependency.
    if stats.used_mitex {
        if let MathImportMode::Mitex { version } = &options.math {
            let import = format!("#import \"@preview/mitex:{}\": mi, mitex\n", version);
            if let Some(pos) = out.find('\n') {
                out.insert_str(pos + 1, &import);
            }
        }
    }

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

    (out, stats)
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
    // mitex math calls (only emitted when the package is installed); math is
    // Obsidian-dialect-only today, but list them so the Standard-dialect
    // hash-escape never mangles a `#mi`/`#mitex` should that change.
    "mi",
    "mitex",
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
                let is_word = b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
                if !is_word {
                    break;
                }
                j += 1;
            }
            let ident = &text[after_hash..j];
            if !ident.is_empty() && EMITTED_TYPST_CALLS.iter().any(|n| *n == ident) {
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
            out.push(bytes[i] as char); // utf8-safe: guarded by is_ascii() — byte is 0..=127, maps identically to char
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
fn preprocess_markdown(input: &str, attachment_folder: &str, dialect: MarkdownDialect) -> String {
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
    result = WIKILINK_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let target = &caps[1];
            match caps.get(2) {
                Some(display) => {
                    format!(
                        "#wikilink(\"{}\", display: \"{}\")",
                        target,
                        display.as_str()
                    )
                }
                None => format!("#wikilink(\"{}\")", target),
            }
        })
        .into_owned();

    // CriticMarkup → InkyCap primitives. Run before the bare `==highlight==`
    // pass: `{==x==}` embeds `==x==`, so converting the braced form first stops
    // the highlight pass from clipping it. Substitution before insert/delete is
    // for clarity (distinct delimiters, so order isn't load-bearing).
    result = CRITIC_SUBSTITUTE_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!(
                "#suggestion(kind: \"replace\", old: [{}])[{}]",
                &caps[1], &caps[2]
            )
        })
        .into_owned();
    result = CRITIC_INSERT_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("#suggestion(kind: \"insert\")[{}]", &caps[1])
        })
        .into_owned();
    result = CRITIC_DELETE_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("#suggestion(kind: \"delete\")[{}]", &caps[1])
        })
        .into_owned();
    result = CRITIC_COMMENT_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("#annotation[{}]", &caps[1])
        })
        .into_owned();
    result = CRITIC_HIGHLIGHT_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("#highlight[{}]", &caps[1])
        })
        .into_owned();

    // Replace Obsidian ==highlight== syntax.
    result = OBSIDIAN_HIGHLIGHT_RE
        .replace_all(&result, |caps: &regex::Captures| {
            format!("#highlight[{}]", &caps[1])
        })
        .into_owned();

    result
}

/// Splits YAML frontmatter (delimited by `---`) from the body.
pub fn extract_frontmatter(input: &str) -> (Option<String>, &str) {
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

/// Convert YAML frontmatter into a `#note(...)` call using the built-in
/// alias defaults. Used by import paths with no mapping UI (directory
/// import, clipboard paste). Common keys resolve to their system property
/// (`created`→`date`, `summary`→`description`, …); every other valid key
/// passes through under its own (sanitized) name. The value-typing for each
/// field follows the same rules as the dialog-driven path.
fn frontmatter_to_note(yaml: &str) -> String {
    let fields = parse_frontmatter_fields(yaml);
    let mut emitted: Vec<(String, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for field in &fields {
        let (target, ty) = match system_alias(&field.key) {
            Some(sys) => (sys.to_string(), builtin_property_type(sys)),
            None => (sanitize_ident(&field.key), field.value.inferred_type()),
        };
        if !seen.insert(target.clone()) {
            continue;
        }
        if let Some(formatted) = format_value_for_type(&field.value, ty) {
            emitted.push((target, formatted));
        }
    }

    emit_note(&emitted)
}

/// Convert YAML frontmatter into a `#note(...)` call following the user's
/// confirmed mapping (from the import dialog). Keys absent from the mapping,
/// or mapped to `None`, are dropped. Distinct source keys that resolve to
/// the same target collapse to the first occurrence (a `#note` call can't
/// carry the same named argument twice).
fn frontmatter_to_note_mapped(yaml: &str, mapping: &FrontmatterMapping) -> String {
    let fields = parse_frontmatter_fields(yaml);
    let mut emitted: Vec<(String, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for field in &fields {
        let Some(field_map) = mapping.get(&field.key.to_lowercase()) else {
            continue;
        };
        let Some(target) = &field_map.target_key else {
            continue; // explicitly excluded by the user
        };
        if !seen.insert(target.clone()) {
            continue;
        }
        if let Some(formatted) = format_value_for_type(&field.value, field_map.target_type) {
            emitted.push((target.clone(), formatted));
        }
    }

    emit_note(&emitted)
}

/// Assemble a `#note(...)` call from already-formatted (key, value) pairs.
/// Returns an empty string when there is nothing to emit.
fn emit_note(fields: &[(String, String)]) -> String {
    if fields.is_empty() {
        return String::new();
    }
    let args: Vec<String> = fields
        .iter()
        .map(|(k, v)| format!("  {}: {}", k, v))
        .collect();
    format!("#note(\n{},\n)", args.join(",\n"))
}

/// Format a parsed frontmatter value as a Typst expression for the given
/// target property type. Returns `None` when the value is effectively empty
/// (so the property is simply omitted rather than emitted as `""`).
fn format_value_for_type(value: &ParsedYamlValue, ty: PropertyType) -> Option<String> {
    match ty {
        PropertyType::List | PropertyType::CommaList => {
            let items: Vec<String> = match value {
                ParsedYamlValue::List(items) => items.clone(),
                ParsedYamlValue::Scalar { raw, .. } => split_scalar_list(raw),
            };
            if items.is_empty() {
                return None;
            }
            let formatted: Vec<String> = items.iter().map(|s| format_string_value(s)).collect();
            Some(format!("({})", formatted.join(", ")))
        }
        PropertyType::Number => match value {
            ParsedYamlValue::Scalar { raw, .. } if raw.trim().parse::<f64>().is_ok() => {
                Some(raw.trim().to_string())
            }
            // Non-numeric value forced to a Number target — fall back to a
            // quoted string so the #note call stays well-formed.
            ParsedYamlValue::Scalar { raw, .. } => Some(format_string_value(raw)),
            ParsedYamlValue::List(items) => items.first().map(|s| format_string_value(s)),
        },
        PropertyType::Checkbox => {
            let truthy = match value {
                ParsedYamlValue::Scalar { raw, .. } => {
                    matches!(
                        raw.trim().to_lowercase().as_str(),
                        "true" | "yes" | "1" | "on" | "checked"
                    )
                }
                ParsedYamlValue::List(items) => !items.is_empty(),
            };
            Some(if truthy {
                "true".into()
            } else {
                "false".into()
            })
        }
        // Text, Date, DateTime, Auto — quoted string (date/datetime are
        // stored as strings; the editor picks the right widget by type).
        _ => {
            let s = match value {
                ParsedYamlValue::Scalar { raw, .. } => raw.clone(),
                ParsedYamlValue::List(items) => items.join(", "),
            };
            if s.trim().is_empty() {
                None
            } else {
                Some(format_string_value(&s))
            }
        }
    }
}

/// Split a scalar that's being coerced into a list. A bracketed inline list
/// or a comma-separated string becomes multiple items; anything else is a
/// single-element list.
fn split_scalar_list(value: &str) -> Vec<String> {
    let value = value.trim();
    let inner = value
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(value);
    if inner.contains(',') {
        inner
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else if inner.trim().is_empty() {
        Vec::new()
    } else {
        vec![inner.trim().to_string()]
    }
}

fn format_string_value(s: &str) -> String {
    let s = s.trim_matches('"').trim_matches('\'');
    if let Some(target) = s.strip_prefix("[[").and_then(|s| s.strip_suffix("]]")) {
        return format!(
            "link-ref(\"{}\")",
            target.replace('\\', "\\\\").replace('"', "\\\"")
        );
    }
    format!("\"{}\"", escape_str(s))
}

/// Escape a string for use inside a Typst `"..."` string literal — only `\`
/// and `"` are special there (`$`, backtick, etc. are literal inside a
/// string), so this is intentionally narrower than `escape_text_for_typst`.
fn escape_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Heuristic: does this `$…$` content use LaTeX-only syntax Typst can't
/// typeset natively? Markdown math is LaTeX, but the simple common cases
/// (`E = mc^2`, `1 + 2 = 3`, `x^2 + y^2`) are also valid Typst math and
/// render fine left as-is. Backslash commands (`\sum`, `\frac`, `\leq`) and
/// `{}` grouping are LaTeX-specific — Typst uses `(...)` grouping and named
/// functions — so those need mitex (or a code-block fallback). This keeps
/// simple math rendering natively and only diverts genuine LaTeX.
fn is_latex_specific(math: &str) -> bool {
    math.contains('\\') || math.contains('{') || math.contains('}')
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
    // Task-list conversion: an Obsidian/GFM `- [ ]` item becomes an InkyCap
    // `#task(...)`. `task_line_reset` records the output offset right after a
    // list item's bullet was emitted, so a TaskListMarker (which always
    // follows the item start) can rewrite that bullet into a task. `in_task`
    // routes the item's text into `task_buf` instead of the output.
    task_line_reset: Option<usize>,
    task_indent: String,
    in_task: bool,
    task_done: bool,
    task_buf: String,
    // Math handling — see `MathImportMode`. `math_as_code` counts LaTeX
    // equations preserved as code (mitex absent); `used_mitex` records that a
    // `#mi`/`#mitex` call was emitted (so the note imports the package).
    math_mode: MathImportMode,
    math_as_code: u32,
    used_mitex: bool,
    // Notebox attachment folder; standard `![](path)` images are rewritten to
    // `/<attachment_folder>/<basename>` so every imported image lands there.
    attachment_folder: String,
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
            task_line_reset: None,
            task_indent: String::new(),
            in_task: false,
            task_done: false,
            task_buf: String::new(),
            math_mode: MathImportMode::default(),
            math_as_code: 0,
            used_mitex: false,
            attachment_folder: String::new(),
        }
    }

    fn convert<'b>(&mut self, parser: impl Iterator<Item = Event<'b>>) {
        for event in parser {
            self.process_event(event);
        }
    }

    fn emit(&mut self, s: &str) {
        if self.in_task {
            // The task body is a plain string argument; capture everything
            // (including any inline markup chars) so it isn't written to the
            // document body mid-task.
            self.task_buf.push_str(s);
        } else if self.in_table_cell {
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
                // A task marker always immediately follows its list-item
                // start. Rewrite the just-emitted bullet into an InkyCap
                // `#task(...)`: drop the bullet and capture the item text.
                if let Some(reset) = self.task_line_reset.take() {
                    self.out.truncate(reset);
                    self.in_task = true;
                    self.task_done = checked;
                    self.task_buf.clear();
                } else {
                    // Fallback (e.g. inside a blockquote, where output is
                    // buffered elsewhere): keep a literal checkbox marker.
                    self.emit(if checked { "[x] " } else { "[ ] " });
                }
            }
            Event::DisplayMath(math) => {
                self.ensure_blank_line();
                if is_latex_specific(&math) {
                    // LaTeX-only syntax Typst can't typeset natively.
                    match &self.math_mode {
                        MathImportMode::Mitex { .. } => {
                            self.used_mitex = true;
                            self.emit(&format!("#mitex(`{}`)", math.trim()));
                        }
                        MathImportMode::Preserve => {
                            self.math_as_code += 1;
                            self.emit(&format!("```latex\n{}\n```", math.trim()));
                        }
                    }
                } else {
                    // Brace/command-free math is valid Typst — render natively.
                    self.emit(&format!("$ {} $", math.trim()));
                }
                self.ensure_blank_line();
            }
            Event::InlineMath(math) => {
                if is_latex_specific(&math) {
                    match &self.math_mode {
                        MathImportMode::Mitex { .. } => {
                            self.used_mitex = true;
                            self.emit(&format!("#mi(`{}`)", math));
                        }
                        MathImportMode::Preserve => {
                            self.math_as_code += 1;
                            self.emit(&format!("`{}`", math));
                        }
                    }
                } else {
                    self.emit(&format!("${}$", math));
                }
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
                    let bullet = if ctx.ordered {
                        format!("{}+ ", indent)
                    } else {
                        format!("{}- ", indent)
                    };
                    // On the direct output path, flush pending newlines and
                    // record the line-start offset so a following
                    // TaskListMarker can rewrite this bullet into #task.
                    // Inside a blockquote/table cell the output is buffered
                    // elsewhere, so skip task rewriting there.
                    if self.blockquote_depth == 0 && !self.in_table_cell {
                        self.flush_newlines();
                        self.task_line_reset = Some(self.out.len());
                        self.task_indent = indent;
                        self.out.push_str(&bullet);
                    } else {
                        self.task_line_reset = None;
                        self.emit(&bullet);
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
            Tag::Link {
                dest_url, title, ..
            } => {
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
                if self.in_task {
                    let body = std::mem::take(&mut self.task_buf);
                    let body = body.trim();
                    let indent = std::mem::take(&mut self.task_indent);
                    let done_arg = if self.task_done { ", done: true" } else { "" };
                    // Each task on its own line; the next item's `ensure_newline`
                    // keeps them on separate lines without an explicit break.
                    self.out.push_str(&format!(
                        "{}#task(\"{}\"{})",
                        indent,
                        escape_str(body),
                        done_arg
                    ));
                    self.in_task = false;
                }
                self.task_line_reset = None;
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
                // Route notebox-local images into the attachment folder; leave
                // external/absolute URLs untouched.
                let routed = route_image_url(&url, &self.attachment_folder);
                self.emit(&format!("#image(\"{}\")", routed));
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
        if self.in_task {
            // Task body is a plain-string argument: capture raw text (no
            // Typst-markup escaping); `escape_str` handles the string literal
            // at emit time.
            self.task_buf.push_str(text);
            return;
        }

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
        let target = url.trim_end_matches(".md").trim_start_matches("./");
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

    fn map(source: &str, target: Option<&str>, ty: PropertyType) -> (String, FieldMapping) {
        (
            source.to_string(),
            FieldMapping {
                target_key: target.map(|s| s.to_string()),
                target_type: ty,
            },
        )
    }

    #[test]
    fn default_frontmatter_emits_via_serde_yaml() {
        // Block-style list (unsupported by the old line parser) now works.
        let md =
            "---\ntitle: My Note\ntags:\n  - alpha\n  - beta\ncreated: 2024-03-01\n---\n\nBody";
        let out = convert(md);
        assert!(out.contains("title: \"My Note\""), "got:\n{out}");
        assert!(out.contains("tags: (\"alpha\", \"beta\")"), "got:\n{out}");
        // `created` aliases to the system `date` property.
        assert!(out.contains("date: \"2024-03-01\""), "got:\n{out}");
    }

    #[test]
    fn mapped_frontmatter_respects_targets_types_and_exclusions() {
        let md = "---\nstatus: draft\npriority: 3\nignore_me: secret\n---\n\nBody";
        let mapping: FrontmatterMapping = [
            // Remap to a custom existing property name.
            map("status", Some("workflow-state"), PropertyType::Text),
            // Force a numeric property.
            map("priority", Some("priority"), PropertyType::Number),
            // Exclude entirely.
            map("ignore_me", None, PropertyType::Auto),
        ]
        .into_iter()
        .collect();
        let opts = MarkdownToTypstOptions {
            dialect: MarkdownDialect::Standard,
            frontmatter_mapping: Some(mapping),
            ..MarkdownToTypstOptions::default()
        };
        let out = markdown_to_typst(md, &opts);
        assert!(out.contains("workflow-state: \"draft\""), "got:\n{out}");
        assert!(out.contains("priority: 3"), "got:\n{out}");
        assert!(!out.contains("ignore_me"), "excluded key leaked:\n{out}");
        assert!(!out.contains("secret"), "excluded value leaked:\n{out}");
    }

    #[test]
    fn simple_math_stays_native_typst() {
        // Brace/backslash-free math is valid Typst and must render natively
        // (not be diverted to code/mitex) regardless of mode.
        let md = "Inline $E = mc^2$ and $$x^2 + y^2 = z^2$$";
        let (out, stats) = markdown_to_typst_with_stats(
            md,
            &MarkdownToTypstOptions {
                dialect: MarkdownDialect::Obsidian,
                ..Default::default()
            },
        );
        assert!(
            out.contains("$E = mc^2$"),
            "inline simple math changed:\n{out}"
        );
        assert!(
            out.contains("$ x^2 + y^2 = z^2 $"),
            "display simple math changed:\n{out}"
        );
        assert_eq!(stats.latex_math_as_code, 0);
        assert!(!stats.used_mitex);
    }

    #[test]
    fn latex_math_preserved_as_code_without_mitex() {
        // Default math mode is Preserve. LaTeX-specific inline math → inline
        // raw; display math → a ```latex block. The LaTeX is kept verbatim.
        let md = "Inline $\\alpha_i$ here.\n\n$$\\sum_{i=1}^n x_i$$";
        let (out, stats) = markdown_to_typst_with_stats(
            md,
            &MarkdownToTypstOptions {
                dialect: MarkdownDialect::Obsidian,
                ..Default::default()
            },
        );
        assert!(out.contains("`\\alpha_i`"), "inline LaTeX not raw:\n{out}");
        assert!(
            out.contains("```latex\n\\sum_{i=1}^n x_i\n```"),
            "display LaTeX not code:\n{out}"
        );
        assert_eq!(stats.latex_math_as_code, 2);
        assert!(!stats.used_mitex);
        // No bare Typst math delimiters wrapping raw LaTeX (which wouldn't render).
        assert!(
            !out.contains("$ \\sum"),
            "raw LaTeX left in Typst math:\n{out}"
        );
    }

    #[test]
    fn latex_math_uses_mitex_when_installed() {
        let md = "Inline $\\alpha_i$ here.\n\n$$\\sum_{i=1}^n x_i$$";
        let (out, stats) = markdown_to_typst_with_stats(
            md,
            &MarkdownToTypstOptions {
                dialect: MarkdownDialect::Obsidian,
                math: MathImportMode::Mitex {
                    version: "0.2.7".into(),
                },
                ..Default::default()
            },
        );
        assert!(
            out.contains("#mi(`\\alpha_i`)"),
            "inline mitex missing:\n{out}"
        );
        assert!(
            out.contains("#mitex(`\\sum_{i=1}^n x_i`)"),
            "display mitex missing:\n{out}"
        );
        assert!(
            out.contains("#import \"@preview/mitex:0.2.7\": mi, mitex"),
            "mitex import not added:\n{out}"
        );
        assert!(stats.used_mitex);
        assert_eq!(stats.latex_math_as_code, 0);
    }

    #[test]
    fn no_mitex_import_when_note_has_no_math() {
        let (out, _) = markdown_to_typst_with_stats(
            "# Just text\n\nNo math here.",
            &MarkdownToTypstOptions {
                dialect: MarkdownDialect::Obsidian,
                math: MathImportMode::Mitex {
                    version: "0.2.7".into(),
                },
                ..Default::default()
            },
        );
        assert!(
            !out.contains("mitex"),
            "mitex import added to a math-free note:\n{out}"
        );
    }

    #[test]
    fn obsidian_task_list_becomes_tasks() {
        let md = "- [ ] wake up\n- [x] have breakfast\n- [ ] go to work";
        let out = convert(md);
        assert!(out.contains("#task(\"wake up\")"), "got:\n{out}");
        assert!(
            out.contains("#task(\"have breakfast\", done: true)"),
            "got:\n{out}"
        );
        assert!(out.contains("#task(\"go to work\")"), "got:\n{out}");
        // No literal checkbox markers or bullets should survive.
        assert!(
            !out.contains("[ ]") && !out.contains("[x]"),
            "literal marker left:\n{out}"
        );
        assert!(!out.contains("- #task"), "task kept a list bullet:\n{out}");
        // Each task on its own line, with no stray Typst line-break (`\`).
        assert!(
            out.contains("#task(\"wake up\")\n"),
            "tasks not on separate lines:\n{out}"
        );
        assert!(
            !out.contains(" \\"),
            "unnecessary line-break inserted:\n{out}"
        );
    }

    #[test]
    fn plain_list_after_task_handling_unaffected() {
        // A normal bullet list must still render as a list, not tasks.
        let out = convert("- dog\n- bird\n- whale");
        assert!(out.contains("- dog"));
        assert!(out.contains("- bird"));
        assert!(!out.contains("#task"));
    }

    #[test]
    fn mapped_scalar_coerced_to_list_target() {
        let md = "---\ncategory: research\n---\n\nBody";
        let mapping: FrontmatterMapping = [map("category", Some("tags"), PropertyType::List)]
            .into_iter()
            .collect();
        let opts = MarkdownToTypstOptions {
            frontmatter_mapping: Some(mapping),
            ..MarkdownToTypstOptions::default()
        };
        let out = markdown_to_typst(md, &opts);
        assert!(out.contains("tags: (\"research\")"), "got:\n{out}");
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
            attachment_folder: "Assets".to_string(),
            ..MarkdownToTypstOptions::default()
        };
        let result = markdown_to_typst("Here: ![[Pasted image 20240412113956.png]]", &opts);
        assert!(
            result.contains("#image(\"/Assets/Pasted image 20240412113956.png\")"),
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
            attachment_folder: "Assets".to_string(),
            ..MarkdownToTypstOptions::default()
        };
        let result = markdown_to_typst("![[photo.png|My caption]]", &opts);
        assert!(
            result.contains("#image(\"/Assets/photo.png\")"),
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
        assert!(!result.contains(" $6000"), "unescaped $ remained: {result}");
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
            result.contains("#image(\"/Assets/pic.png\")"),
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
        // Standard images funnel into the attachment folder (default "Assets").
        let result = convert("![alt](image.png)");
        assert!(
            result.contains("#image(\"/Assets/image.png\")"),
            "got:\n{result}"
        );
    }

    #[test]
    fn images_route_subfolder_paths_to_attachment_by_basename() {
        let result = convert("![alt](sub/dir/pic.png)");
        assert!(
            result.contains("#image(\"/Assets/pic.png\")"),
            "got:\n{result}"
        );
    }

    #[test]
    fn external_image_urls_unchanged() {
        let result = convert("![alt](https://example.com/x.png)");
        assert!(
            result.contains("#image(\"https://example.com/x.png\")"),
            "got:\n{result}"
        );
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
    fn criticmarkup_to_suggestions() {
        assert!(convert("a {++new++} b").contains(r#"#suggestion(kind: "insert")[new]"#));
        assert!(convert("a {--old--} b").contains(r#"#suggestion(kind: "delete")[old]"#));
        assert!(convert("a {~~o~>n~~} b").contains(r#"#suggestion(kind: "replace", old: [o])[n]"#));
    }

    #[test]
    fn criticmarkup_comment_and_highlight() {
        assert!(convert("see {>>fix this<<} here").contains("#annotation[fix this]"));
        // Braced CriticMarkup highlight resolves to #highlight (not clipped by
        // the bare ==…== pass).
        let out = convert("a {==important==} b");
        assert!(out.contains("#highlight[important]"), "got: {out}");
        assert!(!out.contains("=="), "no leftover == delimiters: {out}");
    }

    #[test]
    fn standard_criticmarkup_works_across_dialects() {
        // CriticMarkup is dialect-agnostic — also converts in Standard md.
        assert!(convert_standard("x {++y++} z").contains(r#"#suggestion(kind: "insert")[y]"#));
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
        assert!(
            result.contains("[*Name*]"),
            "header should use [*...*] not table.cell: {result}"
        );
        assert!(
            !result.contains("table.cell"),
            "should not use table.cell: {result}"
        );
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
        assert!(
            !result.contains("#highlight["),
            "Arrow ==> should not open a highlight"
        );
    }

    #[test]
    fn obsidian_highlight_no_cross_line() {
        let result = convert("==start\nend==");
        assert!(
            !result.contains("#highlight["),
            "Highlight should not span lines"
        );
    }
}
