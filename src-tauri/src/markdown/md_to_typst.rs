// ---------------------------------------------------------------------------
// Per CLAUDE.md's Typst-first principle, a Typst-side renderer such as the
// `cmarker` package was considered and rejected: it only renders Markdown,
// it can't produce `.typ` source to store as a note, and it doesn't handle
// InkyCap's extensions (wikilinks, Obsidian tags, `==highlight==`, YAML
// frontmatter as `#note(...)`), which must become `#wikilink`, `#tag`,
// `#highlight` and `#note` calls.
// ---------------------------------------------------------------------------

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use super::frontmatter::{parse_frontmatter_fields, sanitize_ident, system_alias, ParsedYamlValue};
use crate::property_types::{builtin_property_type, PropertyType};

/// The Markdown dialect of the source. The dialects differ in three places:
///
/// - **`#word`**: in Obsidian, `#word` after whitespace is a tag and literal
///   hashes are already escaped. In standard Markdown, `#` is literal, so every
///   `#` in text is escaped (prices, versions, issue numbers).
/// - **`$…$` math**: only Obsidian has math; otherwise `$6000 + travel $3000`
///   would parse as one math span.
/// - **`%%comment%%`**: Obsidian comments, stripped only for Obsidian.
///
/// Wikilinks, `![[…]]` embeds and `==highlight==` are converted in both
/// dialects, since other tools use them too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MarkdownDialect {
    /// CommonMark / GitHub-Flavored Markdown. `#` is always literal
    /// outside heading positions; no math; no `%%` comments.
    #[default]
    Standard,
    /// Obsidian-flavored markdown. Tag syntax, `$…$` math,
    /// `%%comment%%`, callout blockquotes.
    Obsidian,
}

/// Options controlling the markdown-to-typst conversion.
#[derive(Debug, Clone)]
pub struct MarkdownToTypstOptions {
    /// Whether to convert YAML frontmatter into a `#note(...)` call.
    /// When false, frontmatter is silently dropped.
    pub convert_frontmatter: bool,
    /// Notebox attachment folder (relative, no leading slash). The importer
    /// moves embedded files here, and `![[name.png]]` becomes
    /// `#image("/<attachment_folder>/name.png")`.
    pub attachment_folder: String,
    /// Source-markdown dialect — see [`MarkdownDialect`].
    pub dialect: MarkdownDialect,
    /// The YAML-to-property mapping confirmed in the import dialog, keyed by
    /// lowercased source key. When `Some`, only mapped keys are emitted, each
    /// formatted for its property type. When `None` (directory import, paste),
    /// built-in defaults apply.
    pub frontmatter_mapping: Option<FrontmatterMapping>,
    /// How to handle LaTeX math (`$…$` / `$$…$$`), which Typst can't typeset;
    /// see [`MathImportMode`].
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
#[derive(Debug, Clone, Default)]
pub enum MathImportMode {
    /// `mitex` is installed: render LaTeX with `#mi(`…`)` (inline) and
    /// `#mitex(`…`)` (block), importing the package in notes that use it. The
    /// string is the installed version.
    Mitex { version: String },
    /// `mitex` isn't installed: keep the LaTeX as inline raw or a ```` ```latex
    /// ```` block. The note still compiles, and the math can be converted
    /// later.
    #[default]
    Preserve,
}

/// Counts from one conversion, so the importer can report how many equations
/// were kept as code.
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

/// `![[name.png|alt]]` image embed. Runs before the wikilink pattern, which
/// would otherwise leave the `!` behind. The alt text after `|` becomes
/// `image(alt:)`.
static IMAGE_EMBED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap());

/// Standard CommonMark image: `![alt](url "title")`. Captures the URL up to
/// the first whitespace or closing paren (so an optional title is ignored).
// The address is either `<…>` (which may hold spaces) or a run without spaces.
static STD_IMAGE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))").unwrap());

static WIKILINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]").unwrap());

static OBSIDIAN_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)").unwrap());

static OBSIDIAN_HIGHLIGHT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"==([^=\n>][^=\n]*)==").unwrap());

// CriticMarkup (Obsidian, iA Writer, …): suggestions become `#suggestion(...)`,
// comments `#annotation`, highlights `#highlight`. These run before the
// `==highlight==` pass, since `{==x==}` contains `==x==`.
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

/// Obsidian `%%comment%%`, stripped for the Obsidian dialect. `(?s)` catches
/// multi-line comments.
static OBSIDIAN_COMMENT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)%%.*?%%").unwrap());

/// Split an Obsidian link target into the note and heading. Obsidian uses the
/// last heading (`Diary#Week 3#Monday` → *Monday*). A paragraph link
/// (`Diary#^a1b2c3`) keeps only the note. A target with no note part
/// (`#Monday`) is left whole.
fn split_link_target(target: &str) -> (&str, Option<&str>) {
    let Some((note, rest)) = target.split_once('#') else {
        return (target.trim(), None);
    };
    let note = note.trim();
    if note.is_empty() {
        return (target.trim(), None);
    }
    let heading = rest.rsplit('#').next().unwrap_or(rest).trim();
    if heading.is_empty() || heading.starts_with('^') {
        (note, None)
    } else {
        (note, Some(heading))
    }
}

/// What an Obsidian `![[name]]` embed points at, judged by the name's
/// extension the way Obsidian itself decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EmbedKind {
    /// A picture, or a PDF: Typst places a PDF's first page like an image,
    /// and the visual editor offers a button that opens the whole PDF.
    Image,
    Video,
    Audio,
    /// Another note, which Obsidian shows inline. Becomes a wikilink.
    Note,
    /// Any other file, which Obsidian shows as a link to open it. Becomes
    /// `#link("/path")`, which InkyCap opens with the default application.
    File,
}

const EMBED_IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp", "tif", "tiff", "ico", "pdf",
];
const EMBED_VIDEO_EXTS: &[&str] = &["mp4", "webm", "mov", "mkv", "ogv", "m4v"];
const EMBED_AUDIO_EXTS: &[&str] = &["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "opus"];

fn embed_kind(name: &str) -> EmbedKind {
    // `Note#Heading` and `Note^block` point into a note.
    let file = name.split(['#', '^']).next().unwrap_or(name).trim();
    let Some((_, ext)) = file.rsplit_once('.') else {
        return EmbedKind::Note;
    };
    let ext = ext.to_ascii_lowercase();
    if EMBED_IMAGE_EXTS.contains(&ext.as_str()) {
        EmbedKind::Image
    } else if EMBED_VIDEO_EXTS.contains(&ext.as_str()) {
        EmbedKind::Video
    } else if EMBED_AUDIO_EXTS.contains(&ext.as_str()) {
        EmbedKind::Audio
    } else if ext == "md"
        || ext.is_empty()
        || ext.len() > 5
        || !ext.chars().all(|c| c.is_ascii_alphanumeric())
    {
        // A dot inside a note's name (`v1.2 plan`) is not an extension.
        EmbedKind::Note
    } else {
        EmbedKind::File
    }
}

/// File names embedded with `![[name.png]]`, `![[clip.mp4]]` or
/// `![[paper.pdf]]` (note embeds excluded). The importer moves these into the
/// attachment folder.
pub fn extract_embed_filenames(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    for caps in IMAGE_EMBED_RE.captures_iter(input) {
        let name = caps[1].trim();
        if embed_kind(name) != EmbedKind::Note {
            out.push(name.to_string());
        }
    }
    out
}

/// Base names of files in standard images (`![alt](path)`), skipping external
/// (`http(s)://`, `data:`) and absolute (`/…`) URLs. The importer moves these
/// into the attachment folder too.
pub fn extract_image_filenames(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    for caps in STD_IMAGE_RE.captures_iter(input) {
        let Some(url) = caps.get(1).or_else(|| caps.get(2)) else {
            continue;
        };
        let url = url.as_str().trim();
        if is_external_or_absolute(url) {
            continue;
        }
        let url = decode_local_address(url);
        let basename = image_basename(&url);
        if !basename.is_empty() {
            out.push(basename.to_string());
        }
    }
    out
}

/// Whether an image URL is left untouched: a URL with a scheme or an absolute
/// path (`/…`).
fn is_external_or_absolute(url: &str) -> bool {
    url.starts_with('/') || url.starts_with("data:") || url.contains("://")
}

/// A local link or image address with percent-codes decoded: Markdown apps
/// write spaces as `%20`, but the files have real spaces. Kept as written if it
/// doesn't decode to valid text.
fn decode_local_address(url: &str) -> Cow<'_, str> {
    percent_encoding::percent_decode_str(url)
        .decode_utf8()
        .unwrap_or(Cow::Borrowed(url))
}

/// The final path component of an image URL (its filename).
fn image_basename(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or(url)
}

/// The notebox-absolute attachment path for a standard image URL. External and
/// absolute URLs are returned unchanged.
fn route_image_url(url: &str, attachment_folder: &str) -> String {
    if is_external_or_absolute(url) {
        return url.to_string();
    }
    let url = decode_local_address(url);
    let basename = image_basename(&url);
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

    // Replace wikilinks, embeds and (Obsidian only) tags and `%%comments%%`
    // before parsing; pulldown-cmark splits text at `[`, so a wikilink never
    // arrives as one text event.
    let preprocessed = preprocess_markdown(body, &options.attachment_folder, options.dialect);

    // Math only in the Obsidian dialect (see `MarkdownDialect`).
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

    // Standard dialect: escape every `#` that doesn't start a call we emit.
    // Done on the whole output because pulldown-cmark can split
    // `#highlight[yellow]` across text events.
    if matches!(options.dialect, MarkdownDialect::Standard) {
        out = escape_unrecognized_hashes(&out);
    }

    (out, stats)
}

/// Typst calls the converter emits with a `#`, which the Standard-dialect
/// escape pass leaves alone.
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
    // mitex calls. Math is Obsidian-only, but listing them keeps `#mi` /
    // `#mitex` safe if that changes.
    "mi",
    "mitex",
];

fn escape_unrecognized_hashes(text: &str) -> String {
    // A manual scan, since the `regex` crate has no lookahead: at each `#`,
    // keep it if the following word is in [`EMITTED_TYPST_CALLS`] and ends at a
    // non-word character or the end; otherwise write `\#`.
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            let after_hash = i + 1;
            // The names are ASCII, so scanning bytes is safe here.
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
            if !ident.is_empty() && EMITTED_TYPST_CALLS.contains(&ident) {
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
        // Copy non-ASCII characters whole.
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

/// Replace wikilinks and (in Obsidian mode) tags and comments with their Typst
/// equivalents before the Markdown parser runs. `attachment_folder` is where
/// the importer moves `![[name.png]]` files.
fn preprocess_markdown(input: &str, attachment_folder: &str, dialect: MarkdownDialect) -> String {
    // Order matters: tags first, so a `#wikilink` produced later isn't taken as
    // a tag; embeds before wikilinks, since `![[…]]` contains `[[…]]`.
    let mut result = input.to_string();

    // `%%comment%%` — Obsidian inline comments. Strip pre-parse so they
    // never appear in the converted note. Multi-line comments are
    // supported via the `(?s)` flag on the regex.
    if matches!(dialect, MarkdownDialect::Obsidian) {
        result = OBSIDIAN_COMMENT_RE.replace_all(&result, "").into_owned();
    }

    // Obsidian tags, outside code fences. In standard Markdown `#` after
    // whitespace is literal (`issue #42`) and is escaped later instead.
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

    // `![[name]]` embeds, before wikilinks. Each becomes what Obsidian shows
    // for that file type (see `EmbedKind`); a note embed is passed on as
    // `[[…]]`. Spaces in file names are kept (they are fine in quoted Typst
    // paths). Paths are notebox-root-absolute in the attachment folder, where
    // the importer moves the files.
    result = IMAGE_EMBED_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let name = caps[1].trim();
            let alt = caps
                .get(2)
                .map(|m| m.as_str().trim())
                .filter(|a| !a.is_empty());
            let kind = embed_kind(name);
            if kind == EmbedKind::Note {
                return match alt {
                    Some(alt) => format!("[[{name}|{alt}]]"),
                    None => format!("[[{name}]]"),
                };
            }
            let folder = attachment_folder.trim_matches('/');
            let path = if folder.is_empty() {
                format!("/{}", name)
            } else {
                format!("/{}/{}", folder, name)
            };
            let path = escape_str(&path);
            match (kind, alt) {
                (EmbedKind::Video, _) => format!("#video(\"{path}\")"),
                (EmbedKind::Audio, _) => format!("#audio(\"{path}\")"),
                // A bare link shows its path, which names the file.
                (EmbedKind::File, _) => format!("#link(\"{path}\")"),
                (_, Some(alt)) => format!("#image(\"{path}\", alt: \"{}\")", escape_str(alt)),
                (_, None) => format!("#image(\"{path}\")"),
            }
        })
        .into_owned();

    // A heading in the target (`[[Diary#Monday]]`) becomes the link's `label:`,
    // which InkyCap matches against heading text.
    result = WIKILINK_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let (note, heading) = split_link_target(&caps[1]);
            let mut call = format!("#wikilink(\"{}\"", escape_str(note));
            if let Some(heading) = heading {
                call.push_str(&format!(", label: \"{}\"", escape_str(heading)));
            }
            if let Some(display) = caps.get(2) {
                call.push_str(&format!(", display: \"{}\"", escape_str(display.as_str())));
            }
            call.push(')');
            call
        })
        .into_owned();

    // Before the `==highlight==` pass, since `{==x==}` contains `==x==`.
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

/// Convert YAML frontmatter to a `#note(...)` call using the built-in defaults,
/// for imports without the mapping dialog (directory import, paste). Common
/// keys map to system properties (`created` → `date`, `summary` →
/// `description`, …); others keep their sanitized name.
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

/// Convert YAML frontmatter to a `#note(...)` call using the mapping from the
/// import dialog. Unmapped keys are dropped; when several keys map to the same
/// target, the first wins.
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

/// A frontmatter value as a Typst expression for the target type, or `None`
/// when empty (the property is omitted).
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

/// Split a scalar being turned into a list: a bracketed list or comma-separated
/// string becomes several items, anything else one.
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

/// Escape for a Typst `"..."` literal: only `\` and `"`. Narrower than
/// `escape_text_for_typst`.
fn escape_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Whether `$…$` content needs LaTeX (backslash commands like `\frac`, or `{}`
/// grouping). Simple math such as `E = mc^2` is also valid Typst and is left as
/// is.
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
    image_alt: String,
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
    // Task lists: a `- [ ]` item becomes `#task(...)`. `task_line_reset` is the
    // output offset just after the item's bullet, so the TaskListMarker that
    // follows can rewrite it; `in_task` sends the item text to `task_buf`.
    task_line_reset: Option<usize>,
    task_indent: String,
    in_task: bool,
    task_done: bool,
    task_buf: String,
    // See `MathImportMode`. `math_as_code` counts equations kept as code;
    // `used_mitex` records that the note needs the mitex import.
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
            image_alt: String::new(),
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
            // The task body is a string argument; collect all of it here.
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
                self.emit("\n");
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
                // The marker follows its item start: turn the bullet just
                // written into `#task(...)` and collect the item text.
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
                    // Record the line start so a TaskListMarker can rewrite
                    // this bullet. Not inside blockquotes or table cells, whose
                    // output is buffered elsewhere.
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
                self.image_alt.clear();
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
                // The alt text becomes `image(alt:)`, flattened to plain text.
                let alt = std::mem::take(&mut self.image_alt);
                let alt = alt.trim();
                if alt.is_empty() {
                    self.emit(&format!("#image(\"{}\")", escape_str(&routed)));
                } else {
                    self.emit(&format!(
                        "#image(\"{}\", alt: \"{}\")",
                        escape_str(&routed),
                        escape_str(alt)
                    ));
                }
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
            // Raw text; `escape_str` escapes it when emitted.
            self.task_buf.push_str(text);
            return;
        }

        if self.in_link {
            self.link_text.push_str(text);
            return;
        }

        if self.in_image {
            // Raw alt text, flattened and escaped with `escape_str` when
            // emitted.
            self.image_alt.push_str(text);
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

/// Escape characters in pass-through text that would otherwise become Typst
/// markup:
///
/// - `` ` `` opens raw text up to the next backtick.
/// - `$` opens math up to the next `$` (prices like `$3000`).
/// - `\` is Typst's escape character.
///
/// `#` is handled by [`escape_unrecognized_hashes`] on the whole output, since
/// a call can be split across text events. `[` and `]` aren't escaped because
/// the preprocessor passes bracketed calls like `#highlight[content]` through
/// here. Markdown syntax (`_`, `*`, code spans) arrives as separate events.
/// `@cite` and `<label>` only cause local errors, so they are left to compile
/// diagnostics.
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
        // Strip the anchor fragment before decoding, so an encoded `%23` in a
        // name isn't mistaken for one.
        let path = url.split('#').next().unwrap_or(url);
        let path = decode_local_address(path);
        let target = path.trim_end_matches(".md").trim_start_matches("./");
        if text.is_empty() || text == target {
            format!("#wikilink(\"{}\")", escape_str(target))
        } else {
            format!(
                "#wikilink(\"{}\", display: \"{}\")",
                escape_str(target),
                escape_str(text)
            )
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

    /// Converts with the Obsidian dialect. Standard-dialect tests use
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
        // Block-style list.
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
        // An embed must not become `!#wikilink(...)`; its path joins the
        // configured attachment folder.
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

    fn assets() -> MarkdownToTypstOptions {
        MarkdownToTypstOptions {
            attachment_folder: "Assets".to_string(),
            ..MarkdownToTypstOptions::default()
        }
    }

    #[test]
    fn embeds_become_what_obsidian_shows_for_each_kind_of_file() {
        let result = markdown_to_typst(
            "![[clip.MP4]]\n\n![[talk.mp3]]\n\n![[paper.pdf]]\n\n![[budget.xlsx]]",
            &assets(),
        );
        assert!(result.contains("#video(\"/Assets/clip.MP4\")"), "{result}");
        assert!(result.contains("#audio(\"/Assets/talk.mp3\")"), "{result}");
        assert!(result.contains("#image(\"/Assets/paper.pdf\")"), "{result}");
        assert!(
            result.contains("#link(\"/Assets/budget.xlsx\")"),
            "{result}"
        );
    }

    #[test]
    fn note_embeds_become_wikilinks() {
        let result = markdown_to_typst(
            "![[Reading notes]]\n\n![[Plan v1.2 draft|the plan]]",
            &assets(),
        );
        assert!(result.contains("#wikilink(\"Reading notes\")"), "{result}");
        assert!(
            result.contains("#wikilink(\"Plan v1.2 draft\", display: \"the plan\")"),
            "{result}"
        );
        assert!(!result.contains("#image"), "{result}");
    }

    #[test]
    fn heading_links_point_at_the_note_with_the_heading_as_label() {
        for dialect in [MarkdownDialect::Obsidian, MarkdownDialect::Standard] {
            let opts = MarkdownToTypstOptions {
                dialect,
                ..assets()
            };
            let result = markdown_to_typst(
                "see [[Diary#Monday]], [[Diary#Week 3#Friday|end of week]], [[Diary#^a1b2c3]] and ![[Diary#Sunday]]",
                &opts,
            );
            assert!(
                result.contains("#wikilink(\"Diary\", label: \"Monday\")"),
                "{dialect:?}: {result}"
            );
            assert!(
                result
                    .contains("#wikilink(\"Diary\", label: \"Friday\", display: \"end of week\")"),
                "{dialect:?}: {result}"
            );
            assert!(
                result.contains("#wikilink(\"Diary\")"),
                "{dialect:?}: {result}"
            );
            assert!(
                result.contains("#wikilink(\"Diary\", label: \"Sunday\")"),
                "{dialect:?}: {result}"
            );
            assert!(
                !result.contains("\\#"),
                "no escaped hash left: {dialect:?}: {result}"
            );
        }
    }

    #[test]
    fn only_file_embeds_are_routed_into_the_attachment_folder() {
        let names =
            extract_embed_filenames("![[pic.png]] ![[Other note]] ![[clip.mp4]] ![[notes.md]]");
        assert_eq!(names, vec!["pic.png", "clip.mp4"]);
    }

    #[test]
    fn image_embed_with_alt_text_preserves_alt() {
        // The alt text after `|` becomes `image(alt:)`.
        let opts = MarkdownToTypstOptions {
            attachment_folder: "Assets".to_string(),
            ..MarkdownToTypstOptions::default()
        };
        let result = markdown_to_typst("![[photo.png|My caption]]", &opts);
        assert!(
            result.contains("#image(\"/Assets/photo.png\", alt: \"My caption\")"),
            "expected #image() with alt arg, got:\n{result}"
        );
    }

    #[test]
    fn plain_wikilink_still_works_after_image_embed_pass() {
        // The embed pass must not consume a plain `[[link]]`.
        let opts = MarkdownToTypstOptions::default();
        let result = markdown_to_typst("see [[My Note]]", &opts);
        assert!(result.contains("#wikilink(\"My Note\")"));
        assert!(!result.contains("#image"));
    }

    #[test]
    fn escapes_stray_backtick() {
        // A stray backtick must be escaped, or it opens a raw block that
        // swallows the rest of the document.
        let result = convert("see [[Concordia]]`\n\n## Next section\n");
        // The escape — `\``  — leaves the rest of the document free.
        assert!(
            result.contains("\\`"),
            "expected escaped backtick, got:\n{result}"
        );
        // The following heading still converts.
        assert!(
            result.contains("== Next section"),
            "section heading after stray backtick missing:\n{result}"
        );
    }

    #[test]
    fn escapes_dollar_signs() {
        // Unbalanced dollar signs in prices would put the rest of the document
        // in math mode; each `$` must become `\$`.
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
        // Backslashes in text are doubled so they stay literal.
        let result = convert("path C:\\Users\\jc\\file.txt");
        assert!(
            result.contains("C:\\\\Users\\\\jc\\\\file.txt"),
            "expected doubled backslashes, got:\n{result}"
        );
    }

    #[test]
    fn fenced_code_block_content_not_escaped() {
        // Code blocks are verbatim; escaping backticks would corrupt them.
        let result = convert("```\nfn foo() { let s = `hi`; }\n```");
        assert!(
            result.contains("let s = `hi`;"),
            "code block content should pass through unescaped, got:\n{result}"
        );
    }

    #[test]
    fn inline_code_span_preserved() {
        // Inline code is emitted with its own backticks, which must survive.
        let result = convert("call `format!()` here");
        assert!(
            result.contains("`format!()`"),
            "inline code span should produce a Typst raw inline:\n{result}"
        );
    }

    #[test]
    fn standard_dialect_escapes_literal_hash() {
        // `#42` would otherwise be the integer 42 and `#abc` a function call.
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
        // Calls produced from `[[…]]`, `![[…]]` and `==…==` keep their `#`.
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
        // In Standard, `$E=mc^2$` is prose and the `$` is escaped.
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
    fn internal_links_decode_percent_codes() {
        // Obsidian's default form, and the `<…>` form InkyCap's export writes.
        let encoded = convert("[birds](Birds%20of%20prey.md)");
        assert!(
            encoded.contains("#wikilink(\"Birds of prey\", display: \"birds\")"),
            "{encoded}"
        );
        let bracketed = convert("[birds](<Birds of prey.md>)");
        assert!(
            bracketed.contains("#wikilink(\"Birds of prey\", display: \"birds\")"),
            "{bracketed}"
        );
        let to_heading = convert("[Cats](My%20Cats.md#Food)");
        assert!(
            to_heading.contains("#wikilink(\"My Cats\", display: \"Cats\")"),
            "{to_heading}"
        );
    }

    #[test]
    fn decoded_link_characters_stay_inside_the_typst_string() {
        let result = convert("[the \"one\"](The%20%22One%22.md)");
        assert!(
            result.contains(r#"#wikilink("The \"One\"", display: "the \"one\"")"#),
            "{result}"
        );
    }

    #[test]
    fn image_addresses_decode_percent_codes() {
        let result = markdown_to_typst("![](my%20photo.png) ![](<other photo.png>)", &assets());
        assert!(
            result.contains("#image(\"/Assets/my photo.png\")"),
            "{result}"
        );
        assert!(
            result.contains("#image(\"/Assets/other photo.png\")"),
            "{result}"
        );
        assert_eq!(
            extract_image_filenames("![](my%20photo.png) ![a](<other photo.png>)"),
            ["my photo.png", "other photo.png"]
        );
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
        // Standard images funnel into the attachment folder (default "Assets");
        // the `![alt]` text is forwarded to Typst's `image(alt:)`.
        let result = convert("![alt](image.png)");
        assert!(
            result.contains("#image(\"/Assets/image.png\", alt: \"alt\")"),
            "got:\n{result}"
        );
    }

    #[test]
    fn image_without_alt_omits_alt_arg() {
        let result = convert("![](image.png)");
        assert!(
            result.contains("#image(\"/Assets/image.png\")"),
            "got:\n{result}"
        );
        assert!(!result.contains("alt:"), "got:\n{result}");
    }

    #[test]
    fn image_alt_inline_markup_flattened_to_plain_text() {
        // Markdown alt text may contain inline markup; Typst's `alt` is a
        // plain `str`, so it's flattened to plain text.
        let result = convert("![a *bold* caption](image.png)");
        assert!(
            result.contains("#image(\"/Assets/image.png\", alt: \"a bold caption\")"),
            "got:\n{result}"
        );
    }

    #[test]
    fn images_route_subfolder_paths_to_attachment_by_basename() {
        let result = convert("![alt](sub/dir/pic.png)");
        assert!(
            result.contains("#image(\"/Assets/pic.png\", alt: \"alt\")"),
            "got:\n{result}"
        );
    }

    #[test]
    fn external_image_urls_unchanged() {
        let result = convert("![alt](https://example.com/x.png)");
        assert!(
            result.contains("#image(\"https://example.com/x.png\", alt: \"alt\")"),
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
