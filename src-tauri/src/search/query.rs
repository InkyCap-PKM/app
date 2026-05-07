// Search query parser: text → AST.
// Supports: terms, "phrases", AND/OR/NOT, path:/tag:/file: filters,
// wildcards (*), proximity (W/N, N/N), and regex (/pattern/).

use std::fmt;

/// A parsed search query AST node.
#[derive(Debug, Clone)]
pub enum QueryNode {
    /// A single word term (case-insensitive).
    Term(String),
    /// An exact phrase match ("multiple words").
    Phrase(Vec<String>),
    /// Wildcard term — `*` matches any sequence of characters.
    Wildcard(String),
    /// Regex pattern: /pattern/
    Regex(String),
    /// Logical AND of two nodes (default between bare terms).
    And(Box<QueryNode>, Box<QueryNode>),
    /// Logical OR of two nodes.
    Or(Box<QueryNode>, Box<QueryNode>),
    /// Logical NOT (exclude matches).
    Not(Box<QueryNode>),
    /// A filter restricting to a field: path:, tag:, file:
    Filter {
        kind: FilterKind,
        value: String,
    },
    /// Proximity search: two terms within N words of each other.
    Proximity {
        left: String,
        right: String,
        distance: usize,
        /// true = ordered (left before right), false = unordered
        ordered: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum FilterKind {
    Path,
    Tag,
    File,
    /// `property:name` — notes whose `#note(...)` call contains the named key.
    Property,
}

impl fmt::Display for FilterKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FilterKind::Path => write!(f, "path"),
            FilterKind::Tag => write!(f, "tag"),
            FilterKind::File => write!(f, "file"),
            FilterKind::Property => write!(f, "property"),
        }
    }
}

/// Parse a search query string into a QueryNode AST.
///
/// Grammar (informal):
///   query     = or_expr
///   or_expr   = and_expr ("OR" and_expr)*
///   and_expr  = not_expr ("AND"? not_expr)*
///   not_expr  = "NOT" atom | "-" atom | atom
///   atom      = "(" query ")" | filter | phrase | proximity | regex | wildcard | term
pub fn parse_query(input: &str) -> Option<QueryNode> {
    let tokens = tokenize(input);
    if tokens.is_empty() {
        return None;
    }
    let mut pos = 0;
    let result = parse_or(&tokens, &mut pos);
    result
}

// ── Tokenizer ──

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Word(String),
    Phrase(String),
    Regex(String),
    LParen,
    RParen,
    And,
    Or,
    Not,
    Minus,
    /// filter:value
    Filter(String, String),
}

fn tokenize(input: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        // Skip whitespace
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }

        // Parentheses
        if chars[i] == '(' {
            tokens.push(Token::LParen);
            i += 1;
            continue;
        }
        if chars[i] == ')' {
            tokens.push(Token::RParen);
            i += 1;
            continue;
        }

        // Quoted phrase
        if chars[i] == '"' {
            i += 1;
            let start = i;
            while i < len && chars[i] != '"' {
                i += 1;
            }
            let phrase: String = chars[start..i].iter().collect();
            tokens.push(Token::Phrase(phrase));
            if i < len {
                i += 1; // skip closing quote
            }
            continue;
        }

        // Regex: /pattern/
        if chars[i] == '/' {
            i += 1;
            let start = i;
            while i < len && chars[i] != '/' {
                i += 1;
            }
            let pattern: String = chars[start..i].iter().collect();
            if !pattern.is_empty() {
                tokens.push(Token::Regex(pattern));
            }
            if i < len {
                i += 1; // skip closing /
            }
            continue;
        }

        // Minus (NOT shorthand) — only if followed by a word
        if chars[i] == '-' && i + 1 < len && !chars[i + 1].is_whitespace() {
            tokens.push(Token::Minus);
            i += 1;
            continue;
        }

        // `property:` is special: its value may contain `=` and may
        // span multiple words. Three accepted forms:
        //
        //   `property:key`                       — existence only
        //   `property:key="multi word value"`    — quoted value, composes
        //                                          with other filters
        //   `property:key=unquoted rest of line` — greedy to EOF, must
        //                                          be the last thing
        //                                          in the query
        //
        // The quoted form is the safe way to combine `property:` with
        // `tag:`, other `property:` filters, etc. The sidebar click
        // only produces `property:name` without `=`, so hand-typed
        // queries are the only place the distinction matters.
        if i + 9 <= len {
            let head: String = chars[i..i + 9].iter().collect();
            if head.eq_ignore_ascii_case("property:") {
                i += 9;
                // Read key: up to `=`, whitespace, or EOF.
                let key_start = i;
                while i < len && chars[i] != '=' && !chars[i].is_whitespace() {
                    i += 1;
                }
                let key: String = chars[key_start..i].iter().collect();

                let value: Option<String> = if i < len && chars[i] == '=' {
                    i += 1; // past '='
                    if i < len && chars[i] == '"' {
                        // Quoted value — stops at matching '"', so
                        // the rest of the query is left for normal
                        // tokenization.
                        i += 1;
                        let val_start = i;
                        while i < len && chars[i] != '"' {
                            i += 1;
                        }
                        let v: String = chars[val_start..i].iter().collect();
                        if i < len {
                            i += 1; // past closing '"'
                        }
                        Some(v)
                    } else {
                        // Unquoted: greedy consume to EOF so spaces
                        // and `=` work without quoting. The trailing
                        // `trim` protects against `key=value   ` with
                        // accidental whitespace at the end.
                        let v: String = chars[i..]
                            .iter()
                            .collect::<String>()
                            .trim()
                            .to_string();
                        i = len;
                        Some(v)
                    }
                } else {
                    None
                };

                if !key.is_empty() {
                    let full = match value {
                        Some(v) => format!("{}={}", key, v),
                        None => key,
                    };
                    tokens.push(Token::Filter("property".to_string(), full));
                }
                continue;
            }
        }

        // Read a word
        let start = i;
        while i < len && !chars[i].is_whitespace() && chars[i] != '(' && chars[i] != ')' {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();

        // Check for keywords
        match word.as_str() {
            "AND" => tokens.push(Token::And),
            "OR" => tokens.push(Token::Or),
            "NOT" => tokens.push(Token::Not),
            _ => {
                // Check for filter syntax: key:value
                if let Some(colon_pos) = word.find(':') {
                    let key = &word[..colon_pos];
                    let value = &word[colon_pos + 1..];
                    match key.to_lowercase().as_str() {
                        "path" | "tag" | "file" | "property" => {
                            if !value.is_empty() {
                                tokens.push(Token::Filter(
                                    key.to_lowercase(),
                                    value.to_string(),
                                ));
                            } else {
                                tokens.push(Token::Word(word));
                            }
                        }
                        _ => tokens.push(Token::Word(word)),
                    }
                }
                // Check for proximity: wordW/Nword or wordN/Nword
                // Pattern: leftW/Nright or leftN/Nright (rare, skip for now — handle as plain words)
                else {
                    tokens.push(Token::Word(word));
                }
            }
        }
    }

    tokens
}

// ── Recursive descent parser ──

fn parse_or(tokens: &[Token], pos: &mut usize) -> Option<QueryNode> {
    let mut left = parse_and(tokens, pos)?;

    while *pos < tokens.len() {
        if tokens[*pos] == Token::Or {
            *pos += 1;
            let right = parse_and(tokens, pos)?;
            left = QueryNode::Or(Box::new(left), Box::new(right));
        } else {
            break;
        }
    }

    Some(left)
}

fn parse_and(tokens: &[Token], pos: &mut usize) -> Option<QueryNode> {
    let mut left = parse_not(tokens, pos)?;

    while *pos < tokens.len() {
        // Explicit AND
        if tokens[*pos] == Token::And {
            *pos += 1;
            let right = parse_not(tokens, pos)?;
            left = QueryNode::And(Box::new(left), Box::new(right));
        }
        // Implicit AND: next token is an atom-starting token (not OR, not RParen)
        else if matches!(
            tokens[*pos],
            Token::Word(_)
                | Token::Phrase(_)
                | Token::Regex(_)
                | Token::Filter(_, _)
                | Token::LParen
                | Token::Not
                | Token::Minus
        ) {
            let right = parse_not(tokens, pos)?;
            left = QueryNode::And(Box::new(left), Box::new(right));
        } else {
            break;
        }
    }

    Some(left)
}

fn parse_not(tokens: &[Token], pos: &mut usize) -> Option<QueryNode> {
    if *pos < tokens.len() {
        if tokens[*pos] == Token::Not || tokens[*pos] == Token::Minus {
            *pos += 1;
            let inner = parse_atom(tokens, pos)?;
            return Some(QueryNode::Not(Box::new(inner)));
        }
    }
    parse_atom(tokens, pos)
}

fn parse_atom(tokens: &[Token], pos: &mut usize) -> Option<QueryNode> {
    if *pos >= tokens.len() {
        return None;
    }

    match &tokens[*pos] {
        Token::LParen => {
            *pos += 1;
            let inner = parse_or(tokens, pos)?;
            // Consume RParen if present
            if *pos < tokens.len() && tokens[*pos] == Token::RParen {
                *pos += 1;
            }
            Some(inner)
        }
        Token::Phrase(p) => {
            let words: Vec<String> = p
                .split_whitespace()
                .map(|w| w.to_lowercase())
                .collect();
            *pos += 1;
            if words.is_empty() {
                None
            } else if words.len() == 1 {
                Some(QueryNode::Term(words.into_iter().next().unwrap()))
            } else {
                Some(QueryNode::Phrase(words))
            }
        }
        Token::Regex(pattern) => {
            let node = QueryNode::Regex(pattern.clone());
            *pos += 1;
            Some(node)
        }
        Token::Filter(kind, value) => {
            let filter_kind = match kind.as_str() {
                "path" => FilterKind::Path,
                "tag" => FilterKind::Tag,
                "file" => FilterKind::File,
                "property" => FilterKind::Property,
                _ => return None,
            };
            let node = QueryNode::Filter {
                kind: filter_kind,
                value: value.clone(),
            };
            *pos += 1;
            Some(node)
        }
        Token::Word(w) => {
            let word = w.clone();
            *pos += 1;

            // Check for proximity operator: word W/N word or word N/N word
            if *pos + 1 < tokens.len() {
                if let Token::Word(op) = &tokens[*pos] {
                    let op_upper = op.to_uppercase();
                    // W/N (ordered within N) or N/N (near N, unordered)
                    if let Some((ordered, dist)) = parse_proximity_op(&op_upper) {
                        if let Token::Word(right_word) = &tokens[*pos + 1] {
                            let node = QueryNode::Proximity {
                                left: word.to_lowercase(),
                                right: right_word.to_lowercase(),
                                distance: dist,
                                ordered,
                            };
                            *pos += 2;
                            return Some(node);
                        }
                    }
                }
            }

            // Plain term — check for wildcard
            if word.contains('*') {
                Some(QueryNode::Wildcard(word.to_lowercase()))
            } else {
                Some(QueryNode::Term(word.to_lowercase()))
            }
        }
        _ => {
            // Skip unexpected tokens
            *pos += 1;
            None
        }
    }
}

/// Parse proximity operator like "W/3" (ordered) or "N/5" (unordered).
fn parse_proximity_op(op: &str) -> Option<(bool, usize)> {
    if op.len() >= 3 {
        let first = op.chars().next()?;
        if (first == 'W' || first == 'N') && op.chars().nth(1) == Some('/') {
            let dist_str = &op[2..];
            if let Ok(dist) = dist_str.parse::<usize>() {
                return Some((first == 'W', dist));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_term() {
        let q = parse_query("hello").unwrap();
        assert!(matches!(q, QueryNode::Term(ref s) if s == "hello"));
    }

    #[test]
    fn test_phrase() {
        let q = parse_query("\"hello world\"").unwrap();
        assert!(matches!(q, QueryNode::Phrase(ref words) if words.len() == 2));
    }

    #[test]
    fn test_implicit_and() {
        let q = parse_query("hello world").unwrap();
        assert!(matches!(q, QueryNode::And(_, _)));
    }

    #[test]
    fn test_or() {
        let q = parse_query("hello OR world").unwrap();
        assert!(matches!(q, QueryNode::Or(_, _)));
    }

    #[test]
    fn test_not() {
        let q = parse_query("NOT hello").unwrap();
        assert!(matches!(q, QueryNode::Not(_)));
    }

    #[test]
    fn test_minus_not() {
        let q = parse_query("-hello").unwrap();
        assert!(matches!(q, QueryNode::Not(_)));
    }

    #[test]
    fn test_filter() {
        let q = parse_query("tag:rust").unwrap();
        assert!(matches!(q, QueryNode::Filter { kind: FilterKind::Tag, .. }));
    }

    #[test]
    fn test_wildcard() {
        let q = parse_query("hel*").unwrap();
        assert!(matches!(q, QueryNode::Wildcard(_)));
    }

    #[test]
    fn test_complex_query() {
        // (hello OR world) AND tag:rust
        let q = parse_query("(hello OR world) tag:rust").unwrap();
        assert!(matches!(q, QueryNode::And(_, _)));
    }

    #[test]
    fn test_empty_query() {
        assert!(parse_query("").is_none());
        assert!(parse_query("   ").is_none());
    }

    #[test]
    fn test_regex() {
        let q = parse_query("/hel+o/").unwrap();
        assert!(matches!(q, QueryNode::Regex(ref s) if s == "hel+o"));
    }
}
