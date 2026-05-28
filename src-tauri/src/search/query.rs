// Search query parser: text → AST.
//
// Supports terms, "phrases", AND/OR/NOT, wildcards (`*`), regex (`/pattern/`),
// proximity operators (W/N, N/N), and a unified family of bare-prefix
// filters that mirror Obsidian: `path:`, `file:`, `tag:`, `section:`,
// `property:`. Filter values are single non-whitespace tokens; quote
// (`property:author="Jane Doe"`) when the value contains spaces. Property
// filters take a `key=value` form — `property:status=draft` matches notes
// whose `status` property contains `draft`. The bare `property:key` form
// matches any note that defines `key` regardless of value.

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
    /// A field-scoped filter: path:, file:, tag:, section:, property:.
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
    /// `section:keyword` — matches notes that have a heading whose text
    /// contains `keyword`.
    Section,
    /// `property:name` — notes whose `#note(...)` call contains the named key.
    /// `property:name=value` — notes whose `name` property contains `value`.
    Property,
    /// `annotation:keyword` — notes that carry an `#annotation[…]` or
    /// `#suggestion[…]` whose body text contains `keyword`. A bare
    /// `annotation:` (empty value) matches any note with an annotation.
    Annotation,
}

impl FilterKind {
    fn from_prefix(prefix: &str) -> Option<Self> {
        match prefix {
            "path" => Some(Self::Path),
            "file" => Some(Self::File),
            "tag" => Some(Self::Tag),
            "section" => Some(Self::Section),
            "property" => Some(Self::Property),
            "annotation" => Some(Self::Annotation),
            _ => None,
        }
    }
}

impl fmt::Display for FilterKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            FilterKind::Path => "path",
            FilterKind::Tag => "tag",
            FilterKind::File => "file",
            FilterKind::Section => "section",
            FilterKind::Property => "property",
            FilterKind::Annotation => "annotation",
        };
        write!(f, "{}", s)
    }
}

/// Parse a search query string into a QueryNode AST.
pub fn parse_query(input: &str) -> Option<QueryNode> {
    let tokens = tokenize(input);
    if tokens.is_empty() {
        return None;
    }
    let mut pos = 0;
    parse_or(&tokens, &mut pos)
}

// ── Tokenizer ──

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Word(String),
    Phrase(String),
    LParen,
    RParen,
    And,
    Or,
    Not,
    Minus,
    /// (kind, value) — value is already unquoted.
    Filter(String, String),
}

fn tokenize(input: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
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
                i += 1; // closing quote
            }
            continue;
        }

        // NOTE: `/pattern/` is intentionally NOT auto-detected as a regex.
        // Regex search is opt-in via the toolbar toggle (which routes through
        // `QueryNode::Regex` directly in commands/search.rs); treating a bare
        // `/` as a regex delimiter would mangle ordinary queries that contain
        // slashes (paths, "and/or", dates). A leading `/` now just falls into
        // the word reader below and is searched literally.

        // Minus (NOT shorthand) — only if followed by a non-space character
        if chars[i] == '-' && i + 1 < len && !chars[i + 1].is_whitespace() {
            tokens.push(Token::Minus);
            i += 1;
            continue;
        }

        // Try filter prefix: identifier ':' value. Filter prefixes match
        // path:, file:, tag:, section:, property: (case-insensitive). The
        // value is either a quoted string (consumed verbatim, allowing
        // spaces) or runs to the next whitespace / paren — single-token
        // values match Obsidian's behavior and avoid accidental capture
        // of subsequent filters.
        if let Some((kind_len, kind)) = match_filter_prefix(&chars, i) {
            i += kind_len + 1; // past "<kind>:"
            // Read the value as a sequence of segments. A segment is either
            // a quoted run (`"..."` — spaces allowed inside) or an unquoted
            // run terminated by whitespace or a paren. Adjacent segments
            // concatenate, which makes `property:status="in progress"`
            // produce the value `status=in progress`.
            let mut value = String::new();
            let mut have_segment = false;
            loop {
                if i >= len || chars[i].is_whitespace() || chars[i] == '(' || chars[i] == ')' {
                    break;
                }
                if chars[i] == '"' {
                    i += 1;
                    while i < len && chars[i] != '"' {
                        value.push(chars[i]);
                        i += 1;
                    }
                    if i < len {
                        i += 1; // closing quote
                    }
                    have_segment = true;
                } else {
                    while i < len
                        && !chars[i].is_whitespace()
                        && chars[i] != '('
                        && chars[i] != ')'
                        && chars[i] != '"'
                    {
                        value.push(chars[i]);
                        i += 1;
                    }
                    have_segment = true;
                }
            }
            if have_segment && !value.is_empty() {
                tokens.push(Token::Filter(kind, value));
            }
            continue;
        }

        // Read a word (term, AND/OR/NOT keyword, or proximity operator)
        let start = i;
        while i < len && !chars[i].is_whitespace() && chars[i] != '(' && chars[i] != ')' {
            i += 1;
        }
        let word: String = chars[start..i].iter().collect();
        match word.as_str() {
            "AND" => tokens.push(Token::And),
            "OR" => tokens.push(Token::Or),
            "NOT" => tokens.push(Token::Not),
            _ => tokens.push(Token::Word(word)),
        }
    }

    tokens
}

/// If `chars[i..]` starts with `<prefix>:` for one of the known filter
/// prefixes (case-insensitive), return `(prefix_len, lowercased_prefix)`.
fn match_filter_prefix(chars: &[char], i: usize) -> Option<(usize, String)> {
    const PREFIXES: &[&str] = &["path", "file", "tag", "section", "property", "annotation"];
    for prefix in PREFIXES {
        let pl = prefix.len();
        if i + pl + 1 > chars.len() {
            continue;
        }
        if chars[i + pl] != ':' {
            continue;
        }
        let head: String = chars[i..i + pl].iter().collect();
        if head.eq_ignore_ascii_case(prefix) {
            return Some((pl, prefix.to_string()));
        }
    }
    None
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
        if tokens[*pos] == Token::And {
            *pos += 1;
            let right = parse_not(tokens, pos)?;
            left = QueryNode::And(Box::new(left), Box::new(right));
        } else if matches!(
            tokens[*pos],
            Token::Word(_)
                | Token::Phrase(_)
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
    if *pos < tokens.len() && (tokens[*pos] == Token::Not || tokens[*pos] == Token::Minus) {
        *pos += 1;
        let inner = parse_atom(tokens, pos)?;
        return Some(QueryNode::Not(Box::new(inner)));
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
        Token::Filter(kind, value) => {
            let filter_kind = FilterKind::from_prefix(kind)?;
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

            // Proximity: word W/N word | word N/N word
            if *pos + 1 < tokens.len() {
                if let Token::Word(op) = &tokens[*pos] {
                    let op_upper = op.to_uppercase();
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

            if word.contains('*') {
                Some(QueryNode::Wildcard(word.to_lowercase()))
            } else {
                Some(QueryNode::Term(word.to_lowercase()))
            }
        }
        _ => {
            *pos += 1;
            None
        }
    }
}

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
    fn parses_bare_filters() {
        for (q, expected) in [
            ("tag:rust", FilterKind::Tag),
            ("path:journal/", FilterKind::Path),
            ("file:meeting", FilterKind::File),
            ("section:methods", FilterKind::Section),
            ("property:author=alice", FilterKind::Property),
        ] {
            let parsed = parse_query(q).unwrap();
            match parsed {
                QueryNode::Filter { kind, .. } => assert_eq!(kind, expected),
                other => panic!("expected Filter for {q}, got {other:?}"),
            }
        }
    }

    #[test]
    fn case_insensitive_prefix() {
        let q = parse_query("Tag:rust").unwrap();
        assert!(matches!(q, QueryNode::Filter { kind: FilterKind::Tag, .. }));
    }

    #[test]
    fn property_with_quoted_value() {
        let q = parse_query("property:author=\"Jane Doe\"").unwrap();
        match q {
            QueryNode::Filter { kind: FilterKind::Property, value } => {
                assert_eq!(value, "author=Jane Doe");
            }
            other => panic!("expected Property filter, got {other:?}"),
        }
    }

    #[test]
    fn property_then_keyword_compose() {
        // `property:status=draft hello` → AND(Filter, Term)
        let q = parse_query("property:status=draft hello").unwrap();
        assert!(matches!(q, QueryNode::And(_, _)));
    }

    #[test]
    fn keyword_then_property_compose() {
        let q = parse_query("hello property:status=draft").unwrap();
        assert!(matches!(q, QueryNode::And(_, _)));
    }

    #[test]
    fn simple_term() {
        let q = parse_query("hello").unwrap();
        assert!(matches!(q, QueryNode::Term(ref s) if s == "hello"));
    }

    #[test]
    fn implicit_and() {
        let q = parse_query("hello world").unwrap();
        assert!(matches!(q, QueryNode::And(_, _)));
    }

    #[test]
    fn or_query() {
        let q = parse_query("hello OR world").unwrap();
        assert!(matches!(q, QueryNode::Or(_, _)));
    }

    #[test]
    fn not_query() {
        let q = parse_query("NOT hello").unwrap();
        assert!(matches!(q, QueryNode::Not(_)));
    }

    #[test]
    fn minus_not() {
        let q = parse_query("-hello").unwrap();
        assert!(matches!(q, QueryNode::Not(_)));
    }

    #[test]
    fn wildcard() {
        let q = parse_query("hel*").unwrap();
        assert!(matches!(q, QueryNode::Wildcard(_)));
    }

    #[test]
    fn empty_query_is_none() {
        assert!(parse_query("").is_none());
        assert!(parse_query("   ").is_none());
    }

    #[test]
    fn slash_query_is_literal_not_regex() {
        // Regex is opt-in via the toolbar toggle; a slash-delimited query
        // typed into the normal box must be searched literally, not parsed
        // as a regex pattern.
        let q = parse_query("/hel+o/").unwrap();
        assert!(
            matches!(q, QueryNode::Term(ref s) if s == "/hel+o/"),
            "expected a literal term, got {q:?}"
        );
        // A path-shaped query stays one literal term too.
        let q = parse_query("notes/journal").unwrap();
        assert!(matches!(q, QueryNode::Term(ref s) if s == "notes/journal"));
    }
}
