//! A package's reference documentation (its functions, their parameters and
//! descriptions), read from the Markdown that Tinymist's `query packageDocs`
//! writes.
//!
//! Tinymist reads the package with the same analysis that drives its editor
//! help, and puts the structured result in the Markdown as base64 JSON inside
//! `<!-- begin:symbol … -->` comments. Only the package's top-level module is
//! read: those are the names `#import "<spec>": *` gives a note, including any
//! the package passes on from its dependencies.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// The top-level names of a package, with what Tinymist knows about each.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PackageDocs {
    pub symbols: Vec<DocSymbol>,
    /// The package is a template (its manifest declares `[template]`). Set by
    /// the caller, which has the manifest.
    pub is_template: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DocSymbol {
    pub name: String,
    /// `"function"`, `"variable"` or `"module"`.
    pub kind: String,
    /// The author's description, in Markdown, when it could be read.
    pub docs: Option<String>,
    pub params: Vec<DocParam>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DocParam {
    pub name: String,
    /// `"positional"`, `"named"` or `"rest"` (`..name`).
    pub kind: &'static str,
    /// The accepted types as Tinymist infers them; `None` when it can only say
    /// "any".
    pub ty: Option<String>,
    /// The default value, as written in the package.
    pub default: Option<String>,
    pub docs: Option<String>,
}

#[derive(Deserialize)]
struct RawSymbol {
    name: String,
    kind: String,
    #[serde(default)]
    docs: Option<String>,
    #[serde(default)]
    oneliner: Option<String>,
    #[serde(default)]
    parsed_docs: Option<RawParsedDocs>,
}

#[derive(Deserialize)]
struct RawParsedDocs {
    #[serde(default)]
    docs: Option<String>,
    #[serde(default)]
    pos: Vec<RawParam>,
    #[serde(default)]
    named: BTreeMap<String, RawParam>,
    #[serde(default)]
    rest: Option<RawParam>,
}

#[derive(Deserialize)]
struct RawParam {
    name: String,
    #[serde(default)]
    docs: Option<String>,
    #[serde(default)]
    cano_type: Option<Vec<String>>,
    #[serde(default)]
    default: Option<String>,
}

/// Longest type description kept. Inferred types can run to hundreds of
/// characters, which says nothing useful in a sidebar.
const MAX_TYPE_CHARS: usize = 100;

/// Parse Tinymist's package documentation Markdown.
pub fn parse_package_docs(markdown: &str) -> PackageDocs {
    // Symbols of the first module are the package's top level; later modules
    // are the files it is built from.
    let root = match markdown.find("<!-- end:module") {
        Some(end) => &markdown[..end],
        None => markdown,
    };
    let mut seen = HashSet::new();
    let mut symbols = Vec::new();
    for payload in symbol_payloads(root) {
        let Some(raw) = decode_symbol(payload) else {
            continue;
        };
        if raw.name.is_empty() || raw.name.starts_with('_') || !seen.insert(raw.name.clone()) {
            continue;
        }
        symbols.push(to_symbol(raw));
    }
    symbols.sort_by(|a, b| a.name.cmp(&b.name));
    PackageDocs {
        symbols,
        is_template: false,
    }
}

/// The base64 payload of each `<!-- begin:symbol <id> <payload> -->` comment.
fn symbol_payloads(markdown: &str) -> impl Iterator<Item = &str> {
    const OPEN: &str = "<!-- begin:symbol ";
    markdown.match_indices(OPEN).filter_map(|(at, _)| {
        let rest = &markdown[at + OPEN.len()..];
        let comment = &rest[..rest.find("-->")?];
        comment.split_whitespace().nth(1)
    })
}

fn decode_symbol(payload: &str) -> Option<RawSymbol> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn to_symbol(raw: RawSymbol) -> DocSymbol {
    let mut params = Vec::new();
    let mut docs = raw.docs.or(raw.oneliner);
    if let Some(parsed) = raw.parsed_docs {
        docs = parsed.docs.or(docs);
        params.extend(parsed.pos.into_iter().map(|p| to_param(p, "positional")));
        params.extend(parsed.named.into_values().map(|p| to_param(p, "named")));
        params.extend(parsed.rest.map(|p| to_param(p, "rest")));
    }
    DocSymbol {
        name: raw.name,
        kind: raw.kind,
        docs: readable_docs(docs),
        params,
    }
}

fn to_param(raw: RawParam, kind: &'static str) -> DocParam {
    let ty = raw
        .cano_type
        .and_then(|t| t.into_iter().next())
        .filter(|t| !t.is_empty() && t != "any")
        .map(|t| shorten(&t));
    DocParam {
        name: raw.name,
        kind,
        ty,
        default: raw.default.filter(|d| !d.is_empty()),
        docs: readable_docs(raw.docs),
    }
}

/// `docs` unless empty, or the error Tinymist writes in place of docs it
/// couldn't read.
fn readable_docs(docs: Option<String>) -> Option<String> {
    let docs = docs?;
    let trimmed = docs.trim();
    if trimmed.is_empty() || trimmed.contains("failed to parse docs") {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn shorten(s: &str) -> String {
    if s.chars().count() <= MAX_TYPE_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX_TYPE_CHARS).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn symbol(json: &str) -> String {
        let b64 = base64::engine::general_purpose::STANDARD.encode(json);
        format!("<!-- begin:symbol symbol-x {b64} -->\n### x\n<!-- end:symbol -->\n")
    }

    #[test]
    fn reads_top_level_functions_and_parameters() {
        let md = format!(
            "# @preview/demo:1.0.0\n<!-- begin:module root e30= -->\n{}{}{}{}<!-- end:module -->\n\
             <!-- begin:module inner e30= -->\n{}<!-- end:module -->\n",
            symbol(
                r#"{"name":"tree","kind":"function","parsed_docs":{"kind":"func","docs":"Lays out a tree.",
                "pos":[{"name":"rule","docs":"","cano_type":["any","Any",""],"default":null}],
                "named":{"dir":{"name":"dir","docs":"Growth direction.","cano_type":["direction","",""],"default":"btt"}},
                "rest":{"name":"extra","docs":"","cano_type":["content","",""],"default":null}}}"#
            ),
            symbol(r#"{"name":"_private","kind":"function","parsed_docs":null}"#),
            symbol(
                r#"{"name":"broken","kind":"function","parsed_docs":{"docs":"``` failed to parse docs: error: x ```","pos":[],"named":{}}}"#
            ),
            symbol(
                r#"{"name":"palette","kind":"variable","oneliner":"Default colours","parsed_docs":null}"#
            ),
            symbol(r#"{"name":"helper","kind":"function","parsed_docs":null}"#),
        );
        let docs = parse_package_docs(&md);
        let names: Vec<&str> = docs.symbols.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["broken", "palette", "tree"]);

        let tree = &docs.symbols[2];
        assert_eq!(tree.docs.as_deref(), Some("Lays out a tree."));
        assert_eq!(
            tree.params,
            vec![
                DocParam {
                    name: "rule".into(),
                    kind: "positional",
                    ty: None,
                    default: None,
                    docs: None,
                },
                DocParam {
                    name: "dir".into(),
                    kind: "named",
                    ty: Some("direction".into()),
                    default: Some("btt".into()),
                    docs: Some("Growth direction.".into()),
                },
                DocParam {
                    name: "extra".into(),
                    kind: "rest",
                    ty: Some("content".into()),
                    default: None,
                    docs: None,
                },
            ]
        );
        assert_eq!(docs.symbols[0].docs, None, "unreadable docs are dropped");
        assert_eq!(docs.symbols[1].docs.as_deref(), Some("Default colours"));
    }

    #[test]
    fn long_types_are_shortened() {
        let long = "a | ".repeat(60);
        assert!(shorten(&long).ends_with('…'));
        assert_eq!(shorten(&long).chars().count(), MAX_TYPE_CHARS + 1);
    }
}
