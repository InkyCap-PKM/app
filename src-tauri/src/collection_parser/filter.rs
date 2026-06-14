use crate::errors::InkyCapError;
use crate::models::note::{NoteMetadata, PropertyValue};
use std::path::Path;

/// A parsed filter expression.
#[derive(Debug, Clone)]
pub enum FilterExpr {
    Comparison {
        left: PropertyRef,
        op: CompOp,
        right: Value,
    },
    MethodCall {
        target: PropertyRef,
        method: String,
        args: Vec<Value>,
    },
    Not(Box<FilterExpr>),
}

/// A reference to a property on a note.
#[derive(Debug, Clone)]
pub enum PropertyRef {
    /// file.name, file.folder, etc.
    File(String),
    /// Bare property name or note["key"]
    Note(String),
    /// this.file.name — self-reference to the .collection file
    ThisFile(String),
}

/// Comparison operators.
#[derive(Debug, Clone, PartialEq)]
pub enum CompOp {
    Eq,
    Ne,
    /// `<` — ordered comparison (numeric, or lexical for ISO dates).
    Lt,
    /// `<=`
    Le,
    /// `>`
    Gt,
    /// `>=`
    Ge,
}

/// A literal value in a filter expression.
#[derive(Debug, Clone)]
pub enum Value {
    String(String),
    Bool(bool),
    Number(f64),
    PropertyRef(PropertyRef),
}

// ── Parser ──────────────────────────────────────────────────────────

struct Parser {
    input: Vec<char>,
    pos: usize,
}

impl Parser {
    fn new(input: &str) -> Self {
        Self {
            input: input.chars().collect(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<char> {
        self.input.get(self.pos).copied()
    }

    fn advance(&mut self) -> Option<char> {
        let ch = self.input.get(self.pos).copied();
        if ch.is_some() {
            self.pos += 1;
        }
        ch
    }

    fn skip_whitespace(&mut self) {
        while let Some(ch) = self.peek() {
            if ch.is_whitespace() {
                self.advance();
            } else {
                break;
            }
        }
    }

    fn remaining(&self) -> String {
        self.input[self.pos..].iter().collect()
    }

    fn starts_with(&self, s: &str) -> bool {
        self.remaining().starts_with(s)
    }

    fn consume(&mut self, s: &str) -> bool {
        if self.starts_with(s) {
            self.pos += s.len();
            true
        } else {
            false
        }
    }

    fn parse_string_literal(&mut self) -> Result<String, InkyCapError> {
        let quote = self
            .advance()
            .ok_or_else(|| InkyCapError::FilterParse("Expected string literal".to_string()))?;
        if quote != '"' && quote != '\'' {
            return Err(InkyCapError::FilterParse(format!(
                "Expected quote, got '{}'",
                quote
            )));
        }

        let mut s = String::new();
        while let Some(ch) = self.advance() {
            if ch == quote {
                return Ok(s);
            }
            if ch == '\\' {
                if let Some(escaped) = self.advance() {
                    s.push(escaped);
                }
            } else {
                s.push(ch);
            }
        }
        Err(InkyCapError::FilterParse("Unterminated string".to_string()))
    }

    fn parse_identifier(&mut self) -> String {
        let mut ident = String::new();
        while let Some(ch) = self.peek() {
            if ch.is_alphanumeric() || ch == '_' || ch == '-' {
                ident.push(ch);
                self.advance();
            } else {
                break;
            }
        }
        ident
    }

    fn parse_property_ref(&mut self) -> Result<PropertyRef, InkyCapError> {
        // Check for this.file.xxx
        if self.starts_with("this.file.") {
            self.consume("this.file.");
            let field = self.parse_identifier();
            return Ok(PropertyRef::ThisFile(field));
        }

        // Check for file.xxx
        if self.starts_with("file.") {
            self.consume("file.");
            let field = self.parse_identifier();
            return Ok(PropertyRef::File(field));
        }

        // Check for note["key"]
        if self.starts_with("note[\"") || self.starts_with("note['") {
            self.consume("note[");
            let key = self.parse_string_literal()?;
            if !self.consume("]") {
                return Err(InkyCapError::FilterParse(
                    "Expected ']' after note[\"key\"".to_string(),
                ));
            }
            return Ok(PropertyRef::Note(key));
        }

        // Bare property name
        let name = self.parse_identifier();
        if name.is_empty() {
            return Err(InkyCapError::FilterParse(format!(
                "Expected property name at: {}",
                self.remaining()
            )));
        }
        Ok(PropertyRef::Note(name))
    }

    fn parse_value(&mut self) -> Result<Value, InkyCapError> {
        self.skip_whitespace();

        // String literal
        if matches!(self.peek(), Some('"') | Some('\'')) {
            return Ok(Value::String(self.parse_string_literal()?));
        }

        // Boolean or number or property ref
        if self.starts_with("true") {
            self.consume("true");
            return Ok(Value::Bool(true));
        }
        if self.starts_with("false") {
            self.consume("false");
            return Ok(Value::Bool(false));
        }

        // Could be a property reference (e.g., this.file.name on the right side)
        if self.starts_with("this.") || self.starts_with("file.") || self.starts_with("note[") {
            let prop = self.parse_property_ref()?;
            return Ok(Value::PropertyRef(prop));
        }

        // Try number
        let remaining = self.remaining();
        let num_str: String = remaining
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
            .collect();
        if !num_str.is_empty() {
            if let Ok(n) = num_str.parse::<f64>() {
                self.pos += num_str.len();
                return Ok(Value::Number(n));
            }
        }

        Err(InkyCapError::FilterParse(format!(
            "Expected value at: {}",
            self.remaining()
        )))
    }

    fn parse_method_args(&mut self) -> Result<Vec<Value>, InkyCapError> {
        let mut args = Vec::new();
        if !self.consume("(") {
            return Err(InkyCapError::FilterParse("Expected '('".to_string()));
        }
        self.skip_whitespace();
        if self.consume(")") {
            return Ok(args);
        }
        loop {
            self.skip_whitespace();
            args.push(self.parse_value()?);
            self.skip_whitespace();
            if self.consume(")") {
                return Ok(args);
            }
            if !self.consume(",") {
                return Err(InkyCapError::FilterParse("Expected ',' or ')'".to_string()));
            }
        }
    }

    fn parse_expr(&mut self) -> Result<FilterExpr, InkyCapError> {
        self.skip_whitespace();

        // Negation prefix
        if self.consume("!") {
            let inner = self.parse_expr()?;
            return Ok(FilterExpr::Not(Box::new(inner)));
        }

        let prop = self.parse_property_ref()?;
        self.skip_whitespace();

        // Method call: .method(args)
        if self.consume(".") {
            let method = self.parse_identifier();
            if method.is_empty() {
                return Err(InkyCapError::FilterParse(
                    "Expected method name after '.'".to_string(),
                ));
            }
            let args = self.parse_method_args()?;
            return Ok(FilterExpr::MethodCall {
                target: prop,
                method,
                args,
            });
        }

        // Comparison: == or !=
        if self.consume("==") {
            self.skip_whitespace();
            let right = self.parse_value()?;
            return Ok(FilterExpr::Comparison {
                left: prop,
                op: CompOp::Eq,
                right,
            });
        }
        if self.consume("!=") {
            self.skip_whitespace();
            let right = self.parse_value()?;
            return Ok(FilterExpr::Comparison {
                left: prop,
                op: CompOp::Ne,
                right,
            });
        }

        // Relational operators. Two-character forms are checked before the
        // one-character forms so `<=`/`>=` aren't mis-read as a bare `<`/`>`.
        for (token, op) in [
            ("<=", CompOp::Le),
            (">=", CompOp::Ge),
            ("<", CompOp::Lt),
            (">", CompOp::Gt),
        ] {
            if self.consume(token) {
                self.skip_whitespace();
                let right = self.parse_value()?;
                return Ok(FilterExpr::Comparison {
                    left: prop,
                    op,
                    right,
                });
            }
        }

        Err(InkyCapError::FilterParse(format!(
            "Expected operator at: {}",
            self.remaining()
        )))
    }
}

/// Parse a filter expression string into a FilterExpr.
pub fn parse_filter_expr(input: &str) -> Result<FilterExpr, InkyCapError> {
    let mut parser = Parser::new(input.trim());
    let expr = parser.parse_expr()?;
    Ok(expr)
}

// ── Evaluator ───────────────────────────────────────────────────────

/// Resolve a property reference to a value from a note's metadata.
fn resolve_property(prop: &PropertyRef, note: &NoteMetadata, self_path: &Path) -> PropertyValue {
    match prop {
        PropertyRef::File(field) => {
            let key = format!("file.{}", field);
            note.properties
                .get(&key)
                .cloned()
                .unwrap_or(PropertyValue::Null)
        }
        PropertyRef::Note(key) => note
            .properties
            .get(key)
            .cloned()
            .unwrap_or(PropertyValue::Null),
        PropertyRef::ThisFile(field) => {
            // Return a property of the .collection file itself
            match field.as_str() {
                "name" => {
                    let name = self_path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    PropertyValue::String(name)
                }
                "folder" => {
                    let folder = self_path
                        .parent()
                        .map(crate::storage::to_frontend_string)
                        .unwrap_or_default();
                    PropertyValue::String(folder)
                }
                "path" => PropertyValue::String(crate::storage::to_frontend_string(self_path)),
                _ => PropertyValue::Null,
            }
        }
    }
}

fn value_to_property(val: &Value, note: &NoteMetadata, self_path: &Path) -> PropertyValue {
    match val {
        Value::String(s) => PropertyValue::String(s.clone()),
        Value::Bool(b) => PropertyValue::Bool(*b),
        Value::Number(n) => PropertyValue::Number(*n),
        Value::PropertyRef(prop) => resolve_property(prop, note, self_path),
    }
}

fn property_eq(a: &PropertyValue, b: &PropertyValue) -> bool {
    match (a, b) {
        (PropertyValue::String(a), PropertyValue::String(b)) => a == b,
        (PropertyValue::Number(a), PropertyValue::Number(b)) => (a - b).abs() < f64::EPSILON,
        (PropertyValue::Bool(a), PropertyValue::Bool(b)) => a == b,
        (PropertyValue::Null, PropertyValue::Null) => true,
        // A multi-valued property (a list, e.g. `collection`) compared against
        // a scalar tests membership: `collection == "X"` is true when "X" is
        // one of the note's collections. Without this, `==` was always false
        // and `!=` always true for list properties, so a "not equals" filter
        // on `collection` silently matched every note — the reported bug.
        (PropertyValue::List(items), scalar) if !matches!(scalar, PropertyValue::List(_)) => {
            items.iter().any(|item| property_eq(item, scalar))
        }
        (scalar, PropertyValue::List(items)) if !matches!(scalar, PropertyValue::List(_)) => {
            items.iter().any(|item| property_eq(scalar, item))
        }
        _ => false,
    }
}

/// Ordered comparison for the relational operators (`< <= > >=`).
///
/// Compares **numerically** when both operands are numbers (or numeric
/// strings), otherwise **lexically** — which is chronologically correct for
/// the ISO-8601 dates the date picker emits (`YYYY-MM-DD` and `…THH:MM` both
/// sort by calendar order as strings). A `Null` operand, or a list, has no
/// defined ordering and yields `None`, so the comparison fails closed (matching
/// the convention that a row that can't be evaluated does not match).
///
/// Per CLAUDE.md's Typst-first principle: collection membership is resolved in
/// Rust over `typst query`-extracted metadata, so ordered comparison belongs in
/// this filter layer rather than in a Typst query.
fn property_cmp(a: &PropertyValue, b: &PropertyValue) -> Option<std::cmp::Ordering> {
    fn as_f64(v: &PropertyValue) -> Option<f64> {
        match v {
            PropertyValue::Number(n) => Some(*n),
            PropertyValue::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        }
    }
    fn as_str(v: &PropertyValue) -> Option<String> {
        match v {
            PropertyValue::String(s) => Some(s.clone()),
            PropertyValue::Number(n) => Some(n.to_string()),
            PropertyValue::Bool(b) => Some(b.to_string()),
            PropertyValue::Null | PropertyValue::List(_) => None,
        }
    }
    if let (Some(x), Some(y)) = (as_f64(a), as_f64(b)) {
        return x.partial_cmp(&y);
    }
    match (as_str(a), as_str(b)) {
        (Some(x), Some(y)) => Some(x.cmp(&y)),
        _ => None,
    }
}

/// Evaluate a filter expression against a note.
pub fn evaluate(expr: &FilterExpr, note: &NoteMetadata, self_path: &Path) -> bool {
    use std::cmp::Ordering;
    match expr {
        FilterExpr::Not(inner) => !evaluate(inner, note, self_path),

        FilterExpr::Comparison { left, op, right } => {
            let left_val = resolve_property(left, note, self_path);
            let right_val = value_to_property(right, note, self_path);
            match op {
                CompOp::Eq => property_eq(&left_val, &right_val),
                CompOp::Ne => !property_eq(&left_val, &right_val),
                CompOp::Lt => {
                    matches!(property_cmp(&left_val, &right_val), Some(Ordering::Less))
                }
                CompOp::Le => matches!(
                    property_cmp(&left_val, &right_val),
                    Some(Ordering::Less | Ordering::Equal)
                ),
                CompOp::Gt => {
                    matches!(property_cmp(&left_val, &right_val), Some(Ordering::Greater))
                }
                CompOp::Ge => matches!(
                    property_cmp(&left_val, &right_val),
                    Some(Ordering::Greater | Ordering::Equal)
                ),
            }
        }

        FilterExpr::MethodCall {
            target,
            method,
            args,
        } => {
            let target_val = resolve_property(target, note, self_path);
            match method.as_str() {
                "contains" => {
                    if let Some(Value::String(needle)) = args.first() {
                        target_val.contains(needle)
                    } else {
                        false
                    }
                }
                "isEmpty" => target_val.is_empty(),
                _ => false,
            }
        }
    }
}

/// Evaluate a single member of a filter list against a note. A member is
/// either a leaf expression string (`collection.contains("x")`) or a nested
/// filter group (a YAML mapping with its own `and`/`or`/`not`). Anything that
/// fails to parse — a malformed expression or an unrecognised shape — counts
/// as "does not match" so a broken row fails closed in an AND list and is
/// simply skipped in an OR list, never matching a note by accident.
fn evaluate_filter_member(
    member: &serde_yaml::Value,
    note: &NoteMetadata,
    self_path: &Path,
) -> bool {
    match member {
        serde_yaml::Value::String(expr_str) => match parse_filter_expr(expr_str) {
            Ok(expr) => evaluate(&expr, note, self_path),
            Err(_) => false,
        },
        serde_yaml::Value::Mapping(_) => {
            match serde_yaml::from_value::<crate::collection_parser::model::FilterGroup>(
                member.clone(),
            ) {
                Ok(group) => evaluate_filter_group(&group, note, self_path),
                Err(_) => false,
            }
        }
        _ => false,
    }
}

/// Evaluate a filter group against a note. Combinators are recursive — any
/// member of an `and`/`or`/`not` list may itself be a nested group — which is
/// what lets a collection express arbitrary boolean queries like
/// `(A or B) and C`.
///
/// When more than one combinator is present they are AND-ed together: the
/// group passes when all `and` members pass, *and* at least one `or` member
/// passes, *and* no `not` member passes. An absent or empty list is a
/// pass-through, so a single-combinator group behaves as a plain AND / OR /
/// NONE.
pub fn evaluate_filter_group(
    group: &crate::collection_parser::model::FilterGroup,
    note: &NoteMetadata,
    self_path: &Path,
) -> bool {
    if let Some(members) = &group.and {
        if !members
            .iter()
            .all(|m| evaluate_filter_member(m, note, self_path))
        {
            return false;
        }
    }

    if let Some(members) = &group.or {
        if !members.is_empty()
            && !members
                .iter()
                .any(|m| evaluate_filter_member(m, note, self_path))
        {
            return false;
        }
    }

    if let Some(members) = &group.not {
        if members
            .iter()
            .any(|m| evaluate_filter_member(m, note, self_path))
        {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn make_note(props: Vec<(&str, PropertyValue)>) -> NoteMetadata {
        let mut properties = HashMap::new();
        for (k, v) in props {
            properties.insert(k.to_string(), v);
        }
        NoteMetadata {
            path: std::path::PathBuf::from("/notebox/notes/TestNote.md"),
            properties,
            links: vec![],
            tags: vec![],
            agenda_markers: vec![],
            unresolved_suggestions: 0,
            recurrence: None,
        }
    }

    #[test]
    fn test_parse_file_name_ne_this() {
        let expr = parse_filter_expr("file.name != this.file.name").unwrap();
        let note = make_note(vec![(
            "file.name",
            PropertyValue::String("TestNote.md".to_string()),
        )]);
        let self_path = Path::new("/notebox/notes/TestNote.collection");
        // file.name is "TestNote.md", this.file.name (stem) is "TestNote" — not equal
        assert!(evaluate(&expr, &note, self_path));
    }

    #[test]
    fn test_parse_equality_string() {
        let expr = parse_filter_expr(r#"file.ext == "typ""#).unwrap();
        let note = make_note(vec![("file.ext", PropertyValue::String("typ".to_string()))]);
        assert!(evaluate(
            &expr,
            &note,
            Path::new("/notebox/test.collection")
        ));
    }

    #[test]
    fn test_parse_contains_method() {
        let expr = parse_filter_expr(r#"file.folder.contains("notes")"#).unwrap();
        let note = make_note(vec![(
            "file.folder",
            PropertyValue::String("my/notes/folder".to_string()),
        )]);
        assert!(evaluate(
            &expr,
            &note,
            Path::new("/notebox/test.collection")
        ));
    }

    #[test]
    fn test_parse_boolean_comparison() {
        let expr = parse_filter_expr("task == false").unwrap();
        let note = make_note(vec![("task", PropertyValue::Bool(false))]);
        assert!(evaluate(
            &expr,
            &note,
            Path::new("/notebox/test.collection")
        ));
    }

    #[test]
    fn test_parse_negation() {
        let expr = parse_filter_expr(r#"!tags.isEmpty()"#).unwrap();
        let note = make_note(vec![(
            "tags",
            PropertyValue::List(vec![PropertyValue::String("rust".to_string())]),
        )]);
        assert!(evaluate(
            &expr,
            &note,
            Path::new("/notebox/test.collection")
        ));
    }

    #[test]
    fn test_parse_bracket_access() {
        let expr = parse_filter_expr(r#"note["publisher-type"] == "journal""#).unwrap();
        let note = make_note(vec![(
            "publisher-type",
            PropertyValue::String("journal".to_string()),
        )]);
        assert!(evaluate(
            &expr,
            &note,
            Path::new("/notebox/test.collection")
        ));
    }

    #[test]
    fn test_parse_bracket_access_is_empty() {
        let expr = parse_filter_expr(r#"note["publisher-type"].isEmpty()"#).unwrap();
        let note = make_note(vec![("publisher-type", PropertyValue::Null)]);
        assert!(evaluate(
            &expr,
            &note,
            Path::new("/notebox/test.collection")
        ));
    }

    #[test]
    fn test_tags_contains() {
        let expr = parse_filter_expr(r#"file.tags.contains("rust")"#).unwrap();
        let note = make_note(vec![(
            "file.tags",
            PropertyValue::List(vec![
                PropertyValue::String("rust".to_string()),
                PropertyValue::String("tauri".to_string()),
            ]),
        )]);
        assert!(evaluate(
            &expr,
            &note,
            Path::new("/notebox/test.collection")
        ));
    }

    // -- Extended coverage: negative cases, error handling,
    //    this.file.* context, edge cases. CLAUDE.md flags this as the
    //    most logic-dense backend component; keep the matrix wide. --

    #[test]
    fn test_parse_empty_expression_errors() {
        // An empty / whitespace-only filter string must return a
        // structured parse error, not panic or succeed with garbage.
        assert!(parse_filter_expr("").is_err());
        assert!(parse_filter_expr("   ").is_err());
    }

    #[test]
    fn test_parse_unterminated_string_errors() {
        // Missing closing quote — must fail cleanly.
        assert!(parse_filter_expr(r#"file.name == "missing"#).is_err());
    }

    #[test]
    fn test_parse_unknown_method_errors() {
        // `foo` is not a known method on a list/string value. The
        // parser accepts any identifier after `.`, so this may parse
        // OK; evaluation must simply return false rather than panic.
        let parsed = parse_filter_expr(r#"file.tags.foo()"#);
        if let Ok(expr) = parsed {
            let note = make_note(vec![(
                "file.tags",
                PropertyValue::List(vec![PropertyValue::String("rust".into())]),
            )]);
            // Unknown method should evaluate to false, not panic.
            assert!(!evaluate(&expr, &note, Path::new("/notebox/x.collection")));
        }
    }

    #[test]
    fn test_equality_negative_case() {
        let expr = parse_filter_expr(r#"file.ext == "typ""#).unwrap();
        let note = make_note(vec![("file.ext", PropertyValue::String("pdf".to_string()))]);
        assert!(!evaluate(
            &expr,
            &note,
            Path::new("/notebox/test.collection")
        ));
    }

    #[test]
    fn test_inequality_both_directions() {
        let expr = parse_filter_expr(r#"file.ext != "typ""#).unwrap();

        let typ_note = make_note(vec![("file.ext", PropertyValue::String("typ".to_string()))]);
        assert!(!evaluate(
            &expr,
            &typ_note,
            Path::new("/notebox/test.collection")
        ));

        let pdf_note = make_note(vec![("file.ext", PropertyValue::String("pdf".to_string()))]);
        assert!(evaluate(
            &expr,
            &pdf_note,
            Path::new("/notebox/test.collection")
        ));
    }

    #[test]
    fn test_negation_flips_result() {
        let expr = parse_filter_expr(r#"!file.tags.contains("rust")"#).unwrap();

        let has_rust = make_note(vec![(
            "file.tags",
            PropertyValue::List(vec![PropertyValue::String("rust".into())]),
        )]);
        assert!(!evaluate(
            &expr,
            &has_rust,
            Path::new("/notebox/x.collection")
        ));

        let no_rust = make_note(vec![(
            "file.tags",
            PropertyValue::List(vec![PropertyValue::String("go".into())]),
        )]);
        assert!(evaluate(
            &expr,
            &no_rust,
            Path::new("/notebox/x.collection")
        ));
    }

    #[test]
    fn test_is_empty_matches_missing_property() {
        // A property that is not present at all should be treated as
        // empty — otherwise `tags.isEmpty()` would miss notes that have
        // never had a `tags` key, which is surprising for users.
        let expr = parse_filter_expr("tags.isEmpty()").unwrap();
        let note = make_note(vec![]);
        assert!(evaluate(&expr, &note, Path::new("/notebox/x.collection")));
    }

    #[test]
    fn test_is_empty_on_empty_list() {
        let expr = parse_filter_expr("tags.isEmpty()").unwrap();
        let note = make_note(vec![("tags", PropertyValue::List(vec![]))]);
        assert!(evaluate(&expr, &note, Path::new("/notebox/x.collection")));
    }

    #[test]
    fn test_is_empty_on_non_empty_list() {
        let expr = parse_filter_expr("tags.isEmpty()").unwrap();
        let note = make_note(vec![(
            "tags",
            PropertyValue::List(vec![PropertyValue::String("rust".into())]),
        )]);
        assert!(!evaluate(&expr, &note, Path::new("/notebox/x.collection")));
    }

    #[test]
    fn test_contains_is_case_insensitive() {
        // `contains` on a string property is a case-insensitive substring
        // check, consistent with InkyCap's other text filters — `Notes` must
        // match `notes`.
        let expr = parse_filter_expr(r#"file.folder.contains("Notes")"#).unwrap();
        let note = make_note(vec![(
            "file.folder",
            PropertyValue::String("my/notes".to_string()),
        )]);
        assert!(evaluate(&expr, &note, Path::new("/notebox/x.collection")));
    }

    #[test]
    fn test_this_file_name_self_reference() {
        // `this.file.name` evaluates against the .collection file itself,
        // not the candidate note. A filter `file.name != this.file.name`
        // excludes the collection file from its own collection view.
        let expr = parse_filter_expr("file.name != this.file.name").unwrap();
        let note_same = make_note(vec![(
            "file.name",
            PropertyValue::String("TestNote".to_string()),
        )]);
        assert!(!evaluate(
            &expr,
            &note_same,
            Path::new("/notebox/notes/TestNote.collection")
        ));

        let note_other = make_note(vec![(
            "file.name",
            PropertyValue::String("Other".to_string()),
        )]);
        assert!(evaluate(
            &expr,
            &note_other,
            Path::new("/notebox/notes/TestNote.collection")
        ));
    }

    #[test]
    fn test_bracket_access_preserves_dashed_key() {
        // Dashed property names can't be parsed as bare identifiers,
        // so the bracket-access syntax is the only way to reach them.
        let expr = parse_filter_expr(r#"note["publisher-type"] != "journal""#).unwrap();
        let note = make_note(vec![(
            "publisher-type",
            PropertyValue::String("blog".to_string()),
        )]);
        assert!(evaluate(&expr, &note, Path::new("/notebox/x.collection")));
    }

    #[test]
    fn test_evaluate_does_not_panic_on_missing_property() {
        // A filter comparing a missing property against a literal
        // should evaluate cleanly (to `false` for equality) rather
        // than panic.
        let expr = parse_filter_expr(r#"nonexistent == "something""#).unwrap();
        let note = make_note(vec![]);
        assert!(!evaluate(&expr, &note, Path::new("/notebox/x.collection")));
    }

    // ── Relational operators (< <= > >=) ────────────────────────────
    //
    // Power the numeric header filter (= ≠ < ≤ > ≥ between) and every date
    // operator, which the frontend lowers to day-boundary range expressions.

    fn eval1(expr: &str, key: &str, val: PropertyValue) -> bool {
        let parsed = parse_filter_expr(expr).expect("valid filter expression");
        let note = make_note(vec![(key, val)]);
        evaluate(&parsed, &note, Path::new("/notebox/x.collection"))
    }

    #[test]
    fn test_numeric_relational_operators() {
        // Number property compared against a numeric literal.
        assert!(eval1(
            "priority > 2",
            "priority",
            PropertyValue::Number(3.0)
        ));
        assert!(!eval1(
            "priority > 2",
            "priority",
            PropertyValue::Number(2.0)
        ));
        assert!(eval1(
            "priority >= 2",
            "priority",
            PropertyValue::Number(2.0)
        ));
        assert!(eval1(
            "priority < 5",
            "priority",
            PropertyValue::Number(4.0)
        ));
        assert!(eval1(
            "priority <= 5",
            "priority",
            PropertyValue::Number(5.0)
        ));
        assert!(!eval1(
            "priority <= 5",
            "priority",
            PropertyValue::Number(6.0)
        ));
    }

    #[test]
    fn test_numeric_relational_on_numeric_string() {
        // A number stored as a string (frontmatter quirk) still compares
        // numerically, not lexically — "10" must be > "9".
        assert!(eval1(
            "count > 9",
            "count",
            PropertyValue::String("10".into())
        ));
        // Lexically "10" < "9"; the numeric path guards against that.
        assert!(!eval1(
            "count < 9",
            "count",
            PropertyValue::String("10".into())
        ));
    }

    #[test]
    fn test_date_relational_lexical_iso() {
        // ISO-8601 dates sort chronologically as strings.
        assert!(eval1(
            r#"due >= "2025-09-01""#,
            "due",
            PropertyValue::String("2025-09-30".into())
        ));
        assert!(eval1(
            r#"due < "2025-10-01""#,
            "due",
            PropertyValue::String("2025-09-30".into())
        ));
        assert!(!eval1(
            r#"due < "2025-09-01""#,
            "due",
            PropertyValue::String("2025-09-30".into())
        ));
    }

    #[test]
    fn test_date_within_range_as_two_comparisons() {
        // "is within" lowers to {and: [due >= start, due < nextDay(end)]}.
        let group = yaml_group(
            r#"
and:
  - due >= "2025-09-01"
  - due < "2025-10-01"
"#,
        );
        let p = Path::new("/notebox/x.collection");
        let inside = make_note(vec![("due", PropertyValue::String("2025-09-15".into()))]);
        assert!(evaluate_filter_group(&group, &inside, p));
        let after = make_note(vec![("due", PropertyValue::String("2025-10-02".into()))]);
        assert!(!evaluate_filter_group(&group, &after, p));
    }

    #[test]
    fn test_relational_on_null_fails_closed() {
        // A missing/null operand has no ordering, so every relational
        // comparison is false (never accidentally matches).
        assert!(!eval1(
            "due >= \"2025-01-01\"",
            "other",
            PropertyValue::Null
        ));
        assert!(!eval1("due < \"2025-01-01\"", "other", PropertyValue::Null));
    }

    #[test]
    fn test_list_multiselect_membership_via_or() {
        // The list/commalist header multi-select emits {or: [col == a, col == b]};
        // `==` against a list is membership, so a note in either bucket matches.
        let group = yaml_group(
            r#"
or:
  - status == "draft"
  - status == "review"
"#,
        );
        let p = Path::new("/notebox/x.collection");
        let in_review = make_note(vec![(
            "status",
            PropertyValue::List(vec![PropertyValue::String("review".into())]),
        )]);
        assert!(evaluate_filter_group(&group, &in_review, p));
        let done = make_note(vec![(
            "status",
            PropertyValue::List(vec![PropertyValue::String("done".into())]),
        )]);
        assert!(!evaluate_filter_group(&group, &done, p));
    }

    // ── Nested filter group evaluation ──────────────────────────────
    //
    // The recursive group model is the load-bearing piece behind the
    // "(A or B) and C" collection filter, so exercise the combinators and
    // one real nesting case directly.

    use crate::collection_parser::model::FilterGroup;

    fn yaml_group(yaml: &str) -> FilterGroup {
        serde_yaml::from_str(yaml).expect("valid filter group YAML")
    }

    #[test]
    fn test_group_and_requires_all() {
        let group = yaml_group(
            r#"
and:
  - file.ext == "typ"
  - file.name != this.file.name
"#,
        );
        let p = Path::new("/notebox/Collection.collection");

        let typ_note = make_note(vec![
            ("file.ext", PropertyValue::String("typ".into())),
            ("file.name", PropertyValue::String("Note".into())),
        ]);
        assert!(evaluate_filter_group(&group, &typ_note, p));

        let pdf_note = make_note(vec![
            ("file.ext", PropertyValue::String("pdf".into())),
            ("file.name", PropertyValue::String("Note".into())),
        ]);
        assert!(!evaluate_filter_group(&group, &pdf_note, p));
    }

    #[test]
    fn test_group_or_requires_any() {
        let group = yaml_group(
            r#"
or:
  - file.ext == "typ"
  - file.ext == "md"
"#,
        );
        let p = Path::new("/notebox/Collection.collection");

        let md_note = make_note(vec![("file.ext", PropertyValue::String("md".into()))]);
        assert!(evaluate_filter_group(&group, &md_note, p));

        let pdf_note = make_note(vec![("file.ext", PropertyValue::String("pdf".into()))]);
        assert!(!evaluate_filter_group(&group, &pdf_note, p));
    }

    #[test]
    fn test_group_not_excludes() {
        let group = yaml_group(
            r#"
not:
  - file.ext == "pdf"
"#,
        );
        let p = Path::new("/notebox/Collection.collection");

        let typ_note = make_note(vec![("file.ext", PropertyValue::String("typ".into()))]);
        assert!(evaluate_filter_group(&group, &typ_note, p));

        let pdf_note = make_note(vec![("file.ext", PropertyValue::String("pdf".into()))]);
        assert!(!evaluate_filter_group(&group, &pdf_note, p));
    }

    #[test]
    fn test_group_empty_or_is_pass_through() {
        // An empty `or` list must not exclude everything — it is "no
        // constraint", matching how the builder leaves a fresh group.
        let group = yaml_group("or: []");
        let note = make_note(vec![("file.ext", PropertyValue::String("typ".into()))]);
        assert!(evaluate_filter_group(
            &group,
            &note,
            Path::new("/notebox/x.collection")
        ));
    }

    #[test]
    fn test_nested_group_a_or_b_and_c() {
        // The motivating query: a note belongs when it is tagged for the
        // collection OR sits in the Research folder, AND it is not the
        // collection file itself.
        let group = yaml_group(
            r#"
and:
  - file.name != this.file.name
  - or:
      - collection.contains("my-paper")
      - file.folder.contains("Research")
"#,
        );
        let p = Path::new("/notebox/my-paper.collection");

        // Tagged member.
        let tagged = make_note(vec![
            ("file.name", PropertyValue::String("Tagged".into())),
            (
                "collection",
                PropertyValue::List(vec![PropertyValue::String("my-paper".into())]),
            ),
            ("file.folder", PropertyValue::String("notebox/inbox".into())),
        ]);
        assert!(evaluate_filter_group(&group, &tagged, p));

        // Untagged but in the Research folder — the OR alternative.
        let in_folder = make_note(vec![
            ("file.name", PropertyValue::String("Folder".into())),
            (
                "file.folder",
                PropertyValue::String("notebox/Research".into()),
            ),
        ]);
        assert!(evaluate_filter_group(&group, &in_folder, p));

        // Neither tagged nor in the folder — excluded.
        let outsider = make_note(vec![
            ("file.name", PropertyValue::String("Outside".into())),
            ("file.folder", PropertyValue::String("notebox/inbox".into())),
        ]);
        assert!(!evaluate_filter_group(&group, &outsider, p));
    }

    #[test]
    fn test_collection_contains_on_list() {
        let expr = parse_filter_expr(r#"collection.contains("my-paper")"#).unwrap();

        let member = make_note(vec![(
            "collection",
            PropertyValue::List(vec![
                PropertyValue::String("my-paper".into()),
                PropertyValue::String("thesis-ch3".into()),
            ]),
        )]);
        assert!(evaluate(&expr, &member, Path::new("/notebox/x.collection")));

        let non_member = make_note(vec![(
            "collection",
            PropertyValue::List(vec![PropertyValue::String("other-project".into())]),
        )]);
        assert!(!evaluate(
            &expr,
            &non_member,
            Path::new("/notebox/x.collection")
        ));

        let no_collection = make_note(vec![]);
        assert!(!evaluate(
            &expr,
            &no_collection,
            Path::new("/notebox/x.collection")
        ));
    }

    #[test]
    fn test_list_property_equality_is_membership() {
        // `collection == "X"` on a list property tests membership, and
        // `collection != "X"` excludes notes that have "X" in the list. This
        // is the fix for the reported "not equals is not respected" bug, where
        // a list-vs-scalar comparison always fell through to `false`.
        let eq = parse_filter_expr(r#"collection == "CollectionConflict""#).unwrap();
        let ne = parse_filter_expr(r#"collection != "CollectionConflict""#).unwrap();
        let p = Path::new("/notebox/x.collection");

        let member = make_note(vec![(
            "collection",
            PropertyValue::List(vec![
                PropertyValue::String("CollectionConflict".into()),
                PropertyValue::String("Drafts".into()),
            ]),
        )]);
        assert!(evaluate(&eq, &member, p));
        assert!(!evaluate(&ne, &member, p)); // excluded by "not equals"

        let non_member = make_note(vec![(
            "collection",
            PropertyValue::List(vec![PropertyValue::String("Drafts".into())]),
        )]);
        assert!(!evaluate(&eq, &non_member, p));
        assert!(evaluate(&ne, &non_member, p)); // kept by "not equals"
    }
}
