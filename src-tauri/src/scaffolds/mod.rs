// Scaffold engine: reads scaffold files and expands variables.
// Supported variables:
//   {{title}}        — the note title (filename without extension)
//   {{slug}}         — URL-safe slug derived from title (lowercase, hyphens)
//   {{date}}         — today's date as YYYY-MM-DD
//   {{date:FORMAT}}  — today's date in a custom chrono format
//   {{time}}         — current time as HH:MM
//   {{time:FORMAT}}  — current time in a custom format
//   {{zid}}          — Zettelkasten ID from the user's configured pattern
//   {{cursor}}       — removed from output; its position is returned as cursor_offset

use std::path::Path;

use chrono::Local;
use regex::Regex;

use crate::errors::Result;
use crate::storage::traits::VaultStorage;

/// Result of expanding a scaffold: the final content and an optional cursor offset.
#[derive(Debug, Clone)]
pub struct ExpandedScaffold {
    pub content: String,
    pub cursor_offset: Option<usize>,
}

/// Read a scaffold file from the vault's scaffold folder and expand variables.
pub async fn expand_scaffold(
    storage: &dyn VaultStorage,
    scaffold_path: &Path,
    title: &str,
) -> Result<ExpandedScaffold> {
    let raw = storage.read_file(scaffold_path).await?;
    Ok(expand_variables(&raw, title))
}

/// Read a scaffold file and expand variables including `{{zid}}`.
pub async fn expand_scaffold_with_zid(
    storage: &dyn VaultStorage,
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
pub fn expand_variables_with_zid(input: &str, title: &str, zid_pattern: &str) -> ExpandedScaffold {
    let now = Local::now();
    let mut result = input.to_string();

    // Simple replacements
    result = result.replace("{{title}}", title);
    result = result.replace("{{slug}}", &slugify(title));
    result = result.replace("{{date}}", &now.format("%Y-%m-%d").to_string());
    result = result.replace("{{time}}", &now.format("%H:%M").to_string());

    // {{zid}} — Zettelkasten ID from the user's configured pattern
    if !zid_pattern.is_empty() {
        let zid = generate_zid(zid_pattern);
        result = result.replace("{{zid}}", &zid);
    }

    // Formatted date: {{date:FORMAT}}
    let date_re = Regex::new(r"\{\{date:([^}]+)\}\}").unwrap();
    result = date_re
        .replace_all(&result, |caps: &regex::Captures| {
            let fmt = &caps[1];
            let chrono_fmt = moment_to_chrono_format(fmt);
            now.format(&chrono_fmt).to_string()
        })
        .to_string();

    // Formatted time: {{time:FORMAT}}
    let time_re = Regex::new(r"\{\{time:([^}]+)\}\}").unwrap();
    result = time_re
        .replace_all(&result, |caps: &regex::Captures| {
            let fmt = &caps[1];
            let chrono_fmt = moment_to_chrono_format(fmt);
            now.format(&chrono_fmt).to_string()
        })
        .to_string();

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

/// Convert a title into a URL-safe slug: lowercase, non-alphanumeric runs
/// replaced with single hyphens, leading/trailing hyphens stripped.
fn slugify(title: &str) -> String {
    let slug: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
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
        } else if let Some(r) = remaining.strip_prefix("dddd") {
            (Some("%A"), r)
        } else if let Some(r) = remaining.strip_prefix("ddd") {
            (Some("%a"), r)
        } else if let Some(r) = remaining.strip_prefix("DD") {
            (Some("%d"), r)
        } else if let Some(r) = remaining.strip_prefix("HH") {
            (Some("%H"), r)
        } else if let Some(r) = remaining.strip_prefix("mm") {
            (Some("%M"), r)
        } else if let Some(r) = remaining.strip_prefix("ss") {
            (Some("%S"), r)
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
