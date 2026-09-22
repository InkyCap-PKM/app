// Scaffold engine: reads scaffold files and expands variables.
// Supported variables:
//   {{filename}}     — the on-disk filename without the `.typ` extension.
//                      Always resolves to that exact string, never derived
//                      from a property. Use this inside `#note(title: ...)`
//                      when you want the title property to mirror the file
//                      name without creating a `{{title}}` self-reference.
//   {{title}}        — the note's title. Resolves to the `title:` property
//                      of the note's #note() call (after pass-1 token
//                      expansion). Falls back to the filename when the
//                      property is absent or the property value is just
//                      `{{title}}` itself (a self-reference).
//   {{slug}}         — URL-safe slug derived from the resolved title
//                      (lowercase, hyphens)
//   {{date}}         — today's date as YYYY-MM-DD
//   {{date:FORMAT}}  — today's date in a Moment.js-style format
//   {{time}}         — current time as HH:MM
//   {{time:FORMAT}}  — current time in a Moment.js-style format
//   {{zid}}          — Zettelkasten ID from the user's configured pattern
//
// Inside a scaffold file, text in a Typst comment is left exactly as written.
// Scaffolds ship with help text listing the variables, and substituting into
// it would make that help destroy itself the first time the scaffold is used.
// Short patterns (a rule's folder or filename) are not Typst source, so they
// are expanded in full.

use std::ops::Range;
use std::path::Path;

use chrono::{DateTime, Local, Locale};
use regex::Regex;
use typst::syntax::{parse, LinkedNode, SyntaxKind};

use crate::errors::Result;

/// Map an InkyCap UI-locale code (BCP-47, e.g. "fr-CA") to the `chrono::Locale`
/// used for localized month/weekday names in `{{date:...}}` / `{{time:...}}`
/// expansion. Mirrors the frontend's `Intl`-based date formatting in
/// `src/lib/dates.ts` so a date generated into a file matches the date shown
/// in the UI. Unknown codes fall back to English. Extend this as locales are
/// added.
pub fn chrono_locale(ui_locale: &str) -> Locale {
    match ui_locale {
        "fr-CA" | "fr_CA" => Locale::fr_CA,
        s if s.starts_with("fr") => Locale::fr_FR,
        _ => Locale::en_US,
    }
}
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::note_rewriter;

/// Result of expanding a scaffold: the final content.
#[derive(Debug, Clone)]
pub struct ExpandedScaffold {
    pub content: String,
}

/// Read a scaffold file from the notebox's scaffold folder and expand variables.
pub async fn expand_scaffold(
    storage: &dyn NoteboxStorage,
    scaffold_path: &Path,
    title: &str,
    locale: Locale,
) -> Result<ExpandedScaffold> {
    let raw = storage.read_file(scaffold_path).await?;
    Ok(expand_scaffold_content(&raw, title, "", locale))
}

/// Read a scaffold file and expand variables including `{{zid}}`.
pub async fn expand_scaffold_with_zid(
    storage: &dyn NoteboxStorage,
    scaffold_path: &Path,
    title: &str,
    zid_pattern: &str,
    locale: Locale,
) -> Result<ExpandedScaffold> {
    let raw = storage.read_file(scaffold_path).await?;
    Ok(expand_scaffold_content(&raw, title, zid_pattern, locale))
}

/// Generate a Zettelkasten ID from a moment-style format pattern.
/// E.g. pattern "YYYYMMDDHHmmss" → "20260511143025".
pub fn generate_zid(pattern: &str) -> String {
    let now = Local::now();
    let chrono_fmt = moment_to_chrono_format(pattern);
    now.format(&chrono_fmt).to_string()
}

/// Expand scaffold variables in a string.
/// If `zid_pattern` is non-empty, the `{{zid}}` variable is also expanded.
/// `locale` controls localized month/weekday names in `{{date:...}}`.
pub fn expand_variables(input: &str, title: &str, locale: Locale) -> ExpandedScaffold {
    expand_variables_with_zid(input, title, "", locale)
}

/// Expand variables in a short pattern string (a creation rule's folder or
/// filename), including optional `{{zid}}`.
///
/// Every `{{var}}` is expanded, with no notion of comments: a pattern like
/// `daily/{{date:YYYY}}` is a path fragment, not Typst source. Use
/// [`expand_scaffold_content`] for the contents of a scaffold file.
///
/// Title resolution: `{{title}}` and `{{slug}}` expand to the note's
/// resolved title. If the input contains a `#note(title: "...")` after
/// pass-1 expansion, that string literal wins; otherwise we fall back to
/// the caller-supplied `title` (typically the filename without extension).
/// This lets a Daily Note scaffold author `title: "{{date:D MMMM YYYY}}"`
/// once and reuse `{{title}}` in the H1 to match.
pub fn expand_variables_with_zid(
    input: &str,
    title: &str,
    zid_pattern: &str,
    locale: Locale,
) -> ExpandedScaffold {
    let pass1 = Pass1::new(title, zid_pattern, locale);
    let result = pass1.apply(input);
    let resolved_title = resolve_title(&result, title);
    ExpandedScaffold {
        content: expand_title_and_slug(&result, &resolved_title),
    }
}

/// Expand variables in the contents of a scaffold file, leaving anything
/// inside a Typst comment exactly as the author wrote it.
///
/// Same variables and same title resolution as [`expand_variables_with_zid`];
/// the only difference is that comments are copied through untouched. A
/// scaffold can therefore carry `// Variables: {{title}} {{date}}` help text
/// that survives being used, and an author can describe a variable in a
/// comment without it being substituted away.
pub fn expand_scaffold_content(
    input: &str,
    title: &str,
    zid_pattern: &str,
    locale: Locale,
) -> ExpandedScaffold {
    let pass1 = Pass1::new(title, zid_pattern, locale);
    let result = outside_comments(input, |text| pass1.apply(text));
    // The title comes from the note's real `#note(...)` call. That lookup is
    // already AST-based, so a commented-out `#note(...)` can't supply it.
    let resolved_title = resolve_title(&result, title);
    let content = outside_comments(&result, |text| expand_title_and_slug(text, &resolved_title));
    ExpandedScaffold { content }
}

/// Byte ranges of every Typst comment in `source`, in document order.
///
/// Asks Typst's parser rather than scanning for `//`, so a `//` inside a
/// string literal (`url: "https://example.org"`) is correctly not a comment.
fn comment_ranges(source: &str) -> Vec<Range<usize>> {
    fn walk(node: &LinkedNode<'_>, out: &mut Vec<Range<usize>>) {
        if matches!(
            node.kind(),
            SyntaxKind::LineComment | SyntaxKind::BlockComment
        ) {
            out.push(node.range());
            return;
        }
        for child in node.children() {
            walk(&child, out);
        }
    }
    let root = parse(source);
    let mut out = Vec::new();
    walk(&LinkedNode::new(&root), &mut out);
    out
}

/// Run `substitute` over every stretch of `source` that sits outside a Typst
/// comment, copying the comments through byte for byte.
fn outside_comments(source: &str, substitute: impl Fn(&str) -> String) -> String {
    let ranges = comment_ranges(source);
    if ranges.is_empty() {
        return substitute(source);
    }
    let mut out = String::with_capacity(source.len());
    let mut pos = 0;
    for range in ranges {
        // Comments are leaves walked in document order, so ranges arrive
        // sorted and disjoint. Skip anything that isn't rather than slicing
        // backwards and panicking on unexpected input.
        if range.start < pos {
            continue;
        }
        out.push_str(&substitute(&source[pos..range.start]));
        out.push_str(&source[range.start..range.end]);
        pos = range.end;
    }
    out.push_str(&substitute(&source[pos..]));
    out
}

/// Pass-1 substitutions: every variable that doesn't depend on the resolved
/// title. Built once per expansion so that a scaffold split across several
/// comments still sees a single `now` and a single generated `{{zid}}`.
struct Pass1 {
    filename: String,
    zid: Option<String>,
    now: DateTime<Local>,
    locale: Locale,
    date_re: Regex,
    time_re: Regex,
}

impl Pass1 {
    fn new(filename: &str, zid_pattern: &str, locale: Locale) -> Self {
        Self {
            filename: filename.to_string(),
            zid: (!zid_pattern.is_empty()).then(|| generate_zid(zid_pattern)),
            now: Local::now(),
            locale,
            date_re: Regex::new(r"\{\{date:([^}]+)\}\}").unwrap(),
            time_re: Regex::new(r"\{\{time:([^}]+)\}\}").unwrap(),
        }
    }

    fn apply(&self, text: &str) -> String {
        // {{filename}} is the explicit "use the filename" escape hatch — must
        // be expanded in pass 1 so a scaffold can write `title: "{{filename}}"`
        // without setting up a {{title}} cycle.
        let mut result = text.replace("{{filename}}", &self.filename);
        result = result.replace("{{date}}", &self.now.format("%Y-%m-%d").to_string());
        result = result.replace("{{time}}", &self.now.format("%H:%M").to_string());
        if let Some(zid) = &self.zid {
            result = result.replace("{{zid}}", zid);
        }
        result = self.format_all(&self.date_re, &result);
        result = self.format_all(&self.time_re, &result);
        result
    }

    /// Replace every `{{date:FMT}}` / `{{time:FMT}}` match with `now` rendered
    /// in that format. `format_localized` renders `%B`/`%A` (month and weekday
    /// names) in `locale`; purely numeric formats are unaffected.
    fn format_all(&self, re: &Regex, text: &str) -> String {
        re.replace_all(text, |caps: &regex::Captures| {
            let chrono_fmt = moment_to_chrono_format(&caps[1]);
            self.now
                .format_localized(&chrono_fmt, self.locale)
                .to_string()
        })
        .to_string()
    }
}

/// Pass 2: the variables that depend on the resolved title.
fn expand_title_and_slug(text: &str, resolved_title: &str) -> String {
    text.replace("{{title}}", resolved_title)
        .replace("{{slug}}", &slugify(resolved_title))
}

/// The title to use for `{{title}}` / `{{slug}}`. Prefers the expanded
/// `#note(title: ...)` property when present. A property whose value is
/// exactly `{{title}}` is treated as no title property at all (a
/// self-reference); use `{{filename}}` in the scaffold to break that cycle
/// deliberately.
fn resolve_title(expanded: &str, fallback: &str) -> String {
    note_title_from_source(expanded)
        .filter(|t| t.trim() != "{{title}}")
        .unwrap_or_else(|| fallback.to_string())
}

/// If `content` contains a `#note(title: "<string literal>")` call, return
/// the string contents (unquoted, with Typst escapes resolved). Returns
/// None if there is no `#note(...)` call, the `title` property is missing,
/// or its value isn't a plain string literal (e.g. an expression). Falling
/// back lets callers use the supplied default.
fn note_title_from_source(content: &str) -> Option<String> {
    let props = note_rewriter::extract_note_properties(content);
    let (_, raw) = props.into_iter().find(|(k, _)| k == "title")?;
    parse_typst_string_literal(&raw)
}

/// Parse a Typst double-quoted string literal into its contents, decoding
/// `\\`, `\"`, `\n`, `\t`. Returns None if `raw` isn't a `"..."` literal.
fn parse_typst_string_literal(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let inner = trimmed.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    Some(out)
}

/// Convert a title into a URL-safe slug: lowercase, non-alphanumeric runs
/// replaced with single hyphens, leading/trailing hyphens stripped.
fn slugify(title: &str) -> String {
    let slug: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let collapsed: String = slug
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    collapsed
}

/// Convert Moment.js-style format tokens to chrono format specifiers.
fn moment_to_chrono_format(fmt: &str) -> String {
    let mut result = String::with_capacity(fmt.len() * 2);
    // Walk the input as a `&str`, consuming either a known multi-byte
    // moment token (all of which are ASCII) or a single Unicode codepoint
    // for the literal-passthrough fallback. Mixing a `Vec<char>` index with
    // byte slicing of the source would panic the moment any non-ASCII
    // character appeared earlier in the format string.
    let mut remaining = fmt;
    while !remaining.is_empty() {
        // Order matters: every multi-character token is matched before any
        // single-character one so e.g. `MMMM` doesn't get partially consumed
        // as `MMM` + `M`.
        let (token, rest) = if let Some(r) = remaining.strip_prefix("YYYY") {
            (Some("%Y"), r)
        } else if let Some(r) = remaining.strip_prefix("YY") {
            (Some("%y"), r)
        } else if let Some(r) = remaining.strip_prefix("MMMM") {
            (Some("%B"), r)
        } else if let Some(r) = remaining.strip_prefix("MMM") {
            (Some("%b"), r)
        } else if let Some(r) = remaining.strip_prefix("MM") {
            (Some("%m"), r)
        } else if let Some(r) = remaining.strip_prefix("M") {
            (Some("%-m"), r)
        } else if let Some(r) = remaining.strip_prefix("dddd") {
            (Some("%A"), r)
        } else if let Some(r) = remaining.strip_prefix("ddd") {
            (Some("%a"), r)
        } else if let Some(r) = remaining.strip_prefix("DD") {
            (Some("%d"), r)
        } else if let Some(r) = remaining.strip_prefix("D") {
            (Some("%-d"), r)
        } else if let Some(r) = remaining.strip_prefix("HH") {
            (Some("%H"), r)
        } else if let Some(r) = remaining.strip_prefix("H") {
            (Some("%-H"), r)
        } else if let Some(r) = remaining.strip_prefix("hh") {
            (Some("%I"), r)
        } else if let Some(r) = remaining.strip_prefix("h") {
            (Some("%-I"), r)
        } else if let Some(r) = remaining.strip_prefix("mm") {
            (Some("%M"), r)
        } else if let Some(r) = remaining.strip_prefix("m") {
            (Some("%-M"), r)
        } else if let Some(r) = remaining.strip_prefix("ss") {
            (Some("%S"), r)
        } else if let Some(r) = remaining.strip_prefix("s") {
            (Some("%-S"), r)
        } else {
            (None, remaining)
        };

        if let Some(t) = token {
            result.push_str(t);
            remaining = rest;
        } else {
            let mut chars = remaining.chars();
            // Safe: loop guard guarantees `remaining` is non-empty.
            let ch = chars.next().expect("non-empty remaining");
            result.push(ch);
            remaining = chars.as_str();
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expand_simple() {
        let expanded = expand_variables("= {{title}}\nCreated: {{date}}", "My Note", Locale::en_US);
        assert!(expanded.content.starts_with("= My Note\nCreated: "));
        let date_part = expanded.content.split("Created: ").nth(1).unwrap();
        assert_eq!(date_part.len(), 10);
        assert!(date_part.contains('-'));
    }

    #[test]
    fn test_expand_formatted_date() {
        let expanded = expand_variables("{{date:YYYYMMDDHHmmss}}", "test", Locale::en_US);
        assert_eq!(expanded.content.len(), 14);
        assert!(expanded.content.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn test_expand_formatted_date_iso() {
        let expanded = expand_variables("{{date:YYYY-MM-DD}}", "test", Locale::en_US);
        assert_eq!(expanded.content.len(), 10);
    }

    #[test]
    fn comments_in_a_scaffold_are_left_alone() {
        // The help text InkyCap prefills into a new scaffold. It has to
        // survive being used, otherwise the scaffold destroys its own
        // documentation the first time someone makes a note from it.
        let scaffold = "// Variables: {{title}} {{slug}} {{date}} {{zid}}\n= {{title}}\n";
        let expanded = expand_scaffold_content(scaffold, "My Note", "YYYYMMDD", Locale::en_US);
        assert_eq!(
            expanded.content,
            "// Variables: {{title}} {{slug}} {{date}} {{zid}}\n= My Note\n"
        );
    }

    #[test]
    fn block_comments_are_left_alone_too() {
        let scaffold = "/* keep {{date}} as written */\n= {{title}}\n";
        let expanded = expand_scaffold_content(scaffold, "Note", "", Locale::en_US);
        assert!(expanded
            .content
            .starts_with("/* keep {{date}} as written */"));
        assert!(expanded.content.ends_with("= Note\n"));
    }

    #[test]
    fn a_double_slash_inside_a_string_is_not_a_comment() {
        // Typst's parser knows `//` inside a string literal is ordinary text,
        // which a hand-rolled `//` scan would get wrong and skip.
        let scaffold = "#note(\n  url: \"https://example.org/{{slug}}\",\n)\n= {{title}}\n";
        let expanded = expand_scaffold_content(scaffold, "My Note", "", Locale::en_US);
        assert!(expanded.content.contains("https://example.org/my-note"));
        assert!(!expanded.content.contains("{{slug}}"));
    }

    #[test]
    fn a_commented_note_call_does_not_supply_the_title() {
        // Title resolution reads the real `#note(...)`, not one in a comment.
        let scaffold = "// #note(title: \"Commented Out\")\n#note(title: \"Real\")\n= {{title}}\n";
        let expanded = expand_scaffold_content(scaffold, "Filename", "", Locale::en_US);
        assert!(expanded.content.contains("= Real"));
        assert!(expanded
            .content
            .contains("// #note(title: \"Commented Out\")"));
    }

    #[test]
    fn patterns_expand_everywhere_including_after_a_double_slash() {
        // A rule's folder pattern is a path fragment, not Typst source, so it
        // has no comments to respect even when it contains `//`.
        let expanded = expand_variables("notes//{{date:YYYY}}", "test", Locale::en_US);
        assert!(!expanded.content.contains("{{date"));
        assert!(expanded.content.starts_with("notes//"));
    }

    #[test]
    fn test_moment_to_chrono() {
        assert_eq!(moment_to_chrono_format("YYYYMMDDHHmmss"), "%Y%m%d%H%M%S");
        assert_eq!(moment_to_chrono_format("YYYY-MM-DD"), "%Y-%m-%d");
        assert_eq!(moment_to_chrono_format("HH:mm:ss"), "%H:%M:%S");
    }

    #[test]
    fn test_moment_to_chrono_single_digit() {
        // `D` and `M` are non-padded variants of `DD` and `MM`.
        assert_eq!(moment_to_chrono_format("D MMMM YYYY"), "%-d %B %Y");
        assert_eq!(moment_to_chrono_format("M/D/YY"), "%-m/%-d/%y");
        assert_eq!(moment_to_chrono_format("h:mm a"), "%-I:%M a");
    }

    #[test]
    fn test_expand_date_single_digit_day() {
        // Sanity: the produced format string yields a day with no leading
        // zero. We can't assert the actual day (test runs on any date), but
        // we can assert there's no zero-padded leading digit.
        let expanded = expand_variables("{{date:D MMMM YYYY}}", "x", Locale::en_US);
        let first = expanded.content.split_whitespace().next().unwrap();
        let parsed: u32 = first.parse().expect("day parses as integer");
        assert!((1..=31).contains(&parsed));
        if parsed < 10 {
            assert_eq!(first.len(), 1, "single-digit day must not be zero-padded");
        }
    }

    #[test]
    fn test_title_resolves_from_note_property() {
        // When the scaffold sets a title property, {{title}} uses it.
        let input = "#note(title: \"Hello World\")\n\n= {{title}}";
        let expanded = expand_variables(input, "fallback-filename", Locale::en_US);
        assert!(expanded.content.contains("= Hello World"));
        assert!(!expanded.content.contains("fallback-filename"));
    }

    #[test]
    fn test_title_resolves_from_property_after_date_expansion() {
        // The title property itself contains a {{date:...}} token; that
        // gets expanded in pass 1, and {{title}} in the body picks up the
        // already-expanded value.
        let input = "#note(title: \"Day {{date:YYYY}}\")\n\n= {{title}}";
        let expanded = expand_variables(input, "filename", Locale::en_US);
        let year = chrono::Local::now().format("%Y").to_string();
        assert!(expanded.content.contains(&format!("= Day {}", year)));
    }

    #[test]
    fn test_title_falls_back_to_filename_without_property() {
        // No #note() title → {{title}} resolves to the filename parameter.
        let expanded = expand_variables("= {{title}}", "MyNote", Locale::en_US);
        assert!(expanded.content.contains("= MyNote"));
    }

    #[test]
    fn test_slug_follows_resolved_title() {
        let input = "#note(title: \"My Research Note\")\n\nslug: {{slug}}";
        let expanded = expand_variables(input, "fallback", Locale::en_US);
        assert!(expanded.content.contains("slug: my-research-note"));
    }

    #[test]
    fn test_filename_token_uses_filename() {
        // {{filename}} ignores the title property — it is always the on-disk
        // filename, used by the New Note scaffold to break a {{title}} cycle.
        let input = "#note(title: \"{{filename}}\")\n\nfile: {{filename}}";
        let expanded = expand_variables(input, "abc123", Locale::en_US);
        assert!(expanded.content.contains("file: abc123"));
        assert!(expanded.content.contains("title: \"abc123\""));
    }

    #[test]
    fn test_title_falls_back_on_self_reference() {
        // A scaffold that writes `title: "{{title}}"` is a self-reference;
        // resolution should fall back to the filename rather than leaving
        // `{{title}}` unexpanded in the output.
        let input = "#note(title: \"{{title}}\")\n\n= {{title}}";
        let expanded = expand_variables(input, "MyFile", Locale::en_US);
        assert!(expanded.content.contains("= MyFile"));
        assert!(!expanded.content.contains("{{title}}"));
    }

    #[test]
    fn test_no_variables() {
        let expanded = expand_variables("Just plain text.", "title", Locale::en_US);
        assert_eq!(expanded.content, "Just plain text.");
    }

    #[test]
    fn test_slug() {
        assert_eq!(slugify("My Research Note"), "my-research-note");
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("  Spaces  Everywhere  "), "spaces-everywhere");
        assert_eq!(slugify("already-slug"), "already-slug");
        assert_eq!(slugify("CamelCase"), "camelcase");
    }

    #[test]
    fn test_slug_variable() {
        let expanded = expand_variables("file: {{slug}}.typ", "My Research Note", Locale::en_US);
        assert_eq!(expanded.content, "file: my-research-note.typ");
    }

    #[test]
    fn test_localized_month_and_weekday_names() {
        // Month/weekday name tokens render in the supplied locale. We can't
        // hardcode the expected name (the test runs on any date), so we
        // compare against chrono's own localized formatting of "now" and
        // assert the French and English renderings differ for the weekday.
        let now = chrono::Local::now();
        let fr = expand_variables("{{date:dddd MMMM}}", "x", Locale::fr_CA);
        let en = expand_variables("{{date:dddd MMMM}}", "x", Locale::en_US);
        let want_fr = now.format_localized("%A %B", Locale::fr_CA).to_string();
        assert_eq!(fr.content, want_fr);
        // A French weekday name is never identical to its English counterpart
        // (e.g. "vendredi" vs "Friday"), so the two locales must diverge.
        assert_ne!(fr.content, en.content);
    }

    #[test]
    fn test_numeric_format_is_locale_independent() {
        // Purely numeric formats (e.g. ISO dates, zid patterns) must produce
        // identical output regardless of locale.
        let fr = expand_variables("{{date:YYYY-MM-DD}}", "x", Locale::fr_CA);
        let en = expand_variables("{{date:YYYY-MM-DD}}", "x", Locale::en_US);
        assert_eq!(fr.content, en.content);
    }

    #[test]
    fn test_chrono_locale_mapping() {
        assert_eq!(chrono_locale("fr-CA"), Locale::fr_CA);
        assert_eq!(chrono_locale("fr"), Locale::fr_FR);
        assert_eq!(chrono_locale("en"), Locale::en_US);
        assert_eq!(chrono_locale("xx-YY"), Locale::en_US);
    }
}
