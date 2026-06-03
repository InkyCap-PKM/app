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
//   {{cursor}}       — removed from output; its position is returned as cursor_offset

use std::path::Path;

use chrono::Local;
use regex::Regex;

use crate::errors::Result;
use crate::storage::traits::NoteboxStorage;
use crate::typst_pipeline::note_rewriter;

/// Result of expanding a scaffold: the final content and an optional cursor offset.
#[derive(Debug, Clone)]
pub struct ExpandedScaffold {
    pub content: String,
    pub cursor_offset: Option<usize>,
}

/// Read a scaffold file from the notebox's scaffold folder and expand variables.
pub async fn expand_scaffold(
    storage: &dyn NoteboxStorage,
    scaffold_path: &Path,
    title: &str,
) -> Result<ExpandedScaffold> {
    let raw = storage.read_file(scaffold_path).await?;
    Ok(expand_variables(&raw, title))
}

/// Read a scaffold file and expand variables including `{{zid}}`.
pub async fn expand_scaffold_with_zid(
    storage: &dyn NoteboxStorage,
    scaffold_path: &Path,
    title: &str,
    zid_pattern: &str,
) -> Result<ExpandedScaffold> {
    let raw = storage.read_file(scaffold_path).await?;
    Ok(expand_variables_with_zid(&raw, title, zid_pattern))
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
pub fn expand_variables(input: &str, title: &str) -> ExpandedScaffold {
    expand_variables_with_zid(input, title, "")
}

/// Expand scaffold variables in a string, including optional `{{zid}}`.
///
/// Title resolution: `{{title}}` and `{{slug}}` expand to the note's
/// resolved title. If the scaffold contains a `#note(title: "...")` after
/// pass-1 expansion, that string literal wins; otherwise we fall back to
/// the caller-supplied `title` (typically the filename without extension).
/// This lets a Daily Note scaffold author `title: "{{date:D MMMM YYYY}}"`
/// once and reuse `{{title}}` in the H1 to match.
pub fn expand_variables_with_zid(input: &str, title: &str, zid_pattern: &str) -> ExpandedScaffold {
    let now = Local::now();

    // Pass 1: expand everything except {{title}} / {{slug}} (those depend on
    // a title that may be set by a #note(title: ...) property).
    let mut result = input.to_string();
    // {{filename}} is the explicit "use the filename" escape hatch — must
    // be expanded in pass 1 so a scaffold can write `title: "{{filename}}"`
    // without setting up a {{title}} cycle.
    result = result.replace("{{filename}}", title);
    result = result.replace("{{date}}", &now.format("%Y-%m-%d").to_string());
    result = result.replace("{{time}}", &now.format("%H:%M").to_string());

    if !zid_pattern.is_empty() {
        let zid = generate_zid(zid_pattern);
        result = result.replace("{{zid}}", &zid);
    }

    let date_re = Regex::new(r"\{\{date:([^}]+)\}\}").unwrap();
    result = date_re
        .replace_all(&result, |caps: &regex::Captures| {
            let fmt = &caps[1];
            let chrono_fmt = moment_to_chrono_format(fmt);
            now.format(&chrono_fmt).to_string()
        })
        .to_string();

    let time_re = Regex::new(r"\{\{time:([^}]+)\}\}").unwrap();
    result = time_re
        .replace_all(&result, |caps: &regex::Captures| {
            let fmt = &caps[1];
            let chrono_fmt = moment_to_chrono_format(fmt);
            now.format(&chrono_fmt).to_string()
        })
        .to_string();

    // Pass 2: resolve the title to use for {{title}} / {{slug}}. Prefer the
    // expanded #note(title: ...) property when present. A property whose
    // value is exactly "{{title}}" is treated as no title property at all
    // (self-reference); use {{filename}} in the scaffold to break that
    // cycle deliberately.
    let resolved_title = note_title_from_source(&result)
        .filter(|t| t.trim() != "{{title}}")
        .unwrap_or_else(|| title.to_string());
    result = result.replace("{{title}}", &resolved_title);
    result = result.replace("{{slug}}", &slugify(&resolved_title));

    // {{cursor}} — find position, then remove the placeholder
    let cursor_offset = result.find("{{cursor}}");
    if cursor_offset.is_some() {
        result = result.replacen("{{cursor}}", "", 1);
    }

    ExpandedScaffold {
        content: result,
        cursor_offset,
    }
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
        let expanded = expand_variables("= {{title}}\nCreated: {{date}}", "My Note");
        assert!(expanded.content.starts_with("= My Note\nCreated: "));
        let date_part = expanded.content.split("Created: ").nth(1).unwrap();
        assert_eq!(date_part.len(), 10);
        assert!(date_part.contains('-'));
    }

    #[test]
    fn test_expand_formatted_date() {
        let expanded = expand_variables("{{date:YYYYMMDDHHmmss}}", "test");
        assert_eq!(expanded.content.len(), 14);
        assert!(expanded.content.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn test_expand_formatted_date_iso() {
        let expanded = expand_variables("{{date:YYYY-MM-DD}}", "test");
        assert_eq!(expanded.content.len(), 10);
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
        let expanded = expand_variables("{{date:D MMMM YYYY}}", "x");
        let first = expanded.content.split_whitespace().next().unwrap();
        let parsed: u32 = first.parse().expect("day parses as integer");
        assert!(parsed >= 1 && parsed <= 31);
        if parsed < 10 {
            assert_eq!(first.len(), 1, "single-digit day must not be zero-padded");
        }
    }

    #[test]
    fn test_title_resolves_from_note_property() {
        // When the scaffold sets a title property, {{title}} uses it.
        let input = "#note(title: \"Hello World\")\n\n= {{title}}";
        let expanded = expand_variables(input, "fallback-filename");
        assert!(expanded.content.contains("= Hello World"));
        assert!(!expanded.content.contains("fallback-filename"));
    }

    #[test]
    fn test_title_resolves_from_property_after_date_expansion() {
        // The title property itself contains a {{date:...}} token; that
        // gets expanded in pass 1, and {{title}} in the body picks up the
        // already-expanded value.
        let input = "#note(title: \"Day {{date:YYYY}}\")\n\n= {{title}}";
        let expanded = expand_variables(input, "filename");
        let year = chrono::Local::now().format("%Y").to_string();
        assert!(expanded.content.contains(&format!("= Day {}", year)));
    }

    #[test]
    fn test_title_falls_back_to_filename_without_property() {
        // No #note() title → {{title}} resolves to the filename parameter.
        let expanded = expand_variables("= {{title}}", "MyNote");
        assert!(expanded.content.contains("= MyNote"));
    }

    #[test]
    fn test_slug_follows_resolved_title() {
        let input = "#note(title: \"My Research Note\")\n\nslug: {{slug}}";
        let expanded = expand_variables(input, "fallback");
        assert!(expanded.content.contains("slug: my-research-note"));
    }

    #[test]
    fn test_filename_token_uses_filename() {
        // {{filename}} ignores the title property — it is always the on-disk
        // filename, used by the New Note scaffold to break a {{title}} cycle.
        let input = "#note(title: \"{{filename}}\")\n\nfile: {{filename}}";
        let expanded = expand_variables(input, "abc123");
        assert!(expanded.content.contains("file: abc123"));
        assert!(expanded.content.contains("title: \"abc123\""));
    }

    #[test]
    fn test_title_falls_back_on_self_reference() {
        // A scaffold that writes `title: "{{title}}"` is a self-reference;
        // resolution should fall back to the filename rather than leaving
        // `{{title}}` unexpanded in the output.
        let input = "#note(title: \"{{title}}\")\n\n= {{title}}";
        let expanded = expand_variables(input, "MyFile");
        assert!(expanded.content.contains("= MyFile"));
        assert!(!expanded.content.contains("{{title}}"));
    }

    #[test]
    fn test_no_variables() {
        let expanded = expand_variables("Just plain text.", "title");
        assert_eq!(expanded.content, "Just plain text.");
        assert!(expanded.cursor_offset.is_none());
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
        let expanded = expand_variables("file: {{slug}}.typ", "My Research Note");
        assert_eq!(expanded.content, "file: my-research-note.typ");
    }

    #[test]
    fn test_cursor_position() {
        let expanded = expand_variables("= Title\n\n{{cursor}}\n", "test");
        assert_eq!(expanded.content, "= Title\n\n\n");
        assert_eq!(expanded.cursor_offset, Some(9));
    }

    #[test]
    fn test_cursor_with_other_variables() {
        let expanded = expand_variables("= {{title}}\n\n{{cursor}}", "Hello");
        assert_eq!(expanded.content, "= Hello\n\n");
        assert_eq!(expanded.cursor_offset, Some(9));
    }
}
