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
        let quote = self.advance().ok_or_else(|| {
            InkyCapError::FilterParse("Expected string literal".to_string())
        })?;
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
        _ => false,
    }
}

/// Evaluate a filter expression against a note.
pub fn evaluate(expr: &FilterExpr, note: &NoteMetadata, self_path: &Path) -> bool {
    match expr {
        FilterExpr::Not(inner) => !evaluate(inner, note, self_path),

        FilterExpr::Comparison { left, op, right } => {
            let left_val = resolve_property(left, note, self_path);
            let right_val = value_to_property(right, note, self_path);
            match op {
                CompOp::Eq => property_eq(&left_val, &right_val),
                CompOp::Ne => !property_eq(&left_val, &right_val),
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
                "containsAny" => {
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

/// Evaluate a filter group (and/or combinator) against a note.
pub fn evaluate_filter_group(
    group: &crate::collection_parser::model::FilterGroup,
    note: &NoteMetadata,
    self_path: &Path,
) -> bool {
    if let Some(and_filters) = &group.and {
        for filter_val in and_filters {
            if let serde_yaml::Value::String(expr_str) = filter_val {
                match parse_filter_expr(expr_str) {
                    Ok(expr) => {
                        if !evaluate(&expr, note, self_path) {
                            return false;
                        }
                    }
                    Err(_) => return false,
                }
            }
        }
        true
    } else if let Some(or_filters) = &group.or {
        for filter_val in or_filters {
            if let serde_yaml::Value::String(expr_str) = filter_val {
                match parse_filter_expr(expr_str) {
                    Ok(expr) => {
                        if evaluate(&expr, note, self_path) {
                            return true;
                        }
                    }
                    Err(_) => continue,
                }
            }
        }
        false
    } else {
        true
    }
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
        let note = make_note(vec![(
            "file.ext",
            PropertyValue::String("typ".to_string()),
        )]);
        assert!(evaluate(&expr, &note, Path::new("/notebox/test.collection")));
    }

    #[test]
    fn test_parse_contains_method() {
        let expr = parse_filter_expr(r#"file.folder.contains("notes")"#).unwrap();
        let note = make_note(vec![(
            "file.folder",
            PropertyValue::String("my/notes/folder".to_string()),
        )]);
        assert!(evaluate(&expr, &note, Path::new("/notebox/test.collection")));
    }

    #[test]
    fn test_parse_boolean_comparison() {
        let expr = parse_filter_expr("task == false").unwrap();
        let note = make_note(vec![("task", PropertyValue::Bool(false))]);
        assert!(evaluate(&expr, &note, Path::new("/notebox/test.collection")));
    }

    #[test]
    fn test_parse_negation() {
        let expr = parse_filter_expr(r#"!tags.isEmpty()"#).unwrap();
        let note = make_note(vec![(
            "tags",
            PropertyValue::List(vec![PropertyValue::String("rust".to_string())]),
        )]);
        assert!(evaluate(&expr, &note, Path::new("/notebox/test.collection")));
    }

    #[test]
    fn test_parse_bracket_access() {
        let expr = parse_filter_expr(r#"note["publisher-type"] == "journal""#).unwrap();
        let note = make_note(vec![(
            "publisher-type",
            PropertyValue::String("journal".to_string()),
        )]);
        assert!(evaluate(&expr, &note, Path::new("/notebox/test.collection")));
    }

    #[test]
    fn test_parse_bracket_access_is_empty() {
        let expr = parse_filter_expr(r#"note["publisher-type"].isEmpty()"#).unwrap();
        let note = make_note(vec![("publisher-type", PropertyValue::Null)]);
        assert!(evaluate(&expr, &note, Path::new("/notebox/test.collection")));
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
        assert!(evaluate(&expr, &note, Path::new("/notebox/test.collection")));
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
        let note = make_note(vec![(
            "file.ext",
            PropertyValue::String("pdf".to_string()),
        )]);
        assert!(!evaluate(&expr, &note, Path::new("/notebox/test.collection")));
    }

    #[test]
    fn test_inequality_both_directions() {
        let expr = parse_filter_expr(r#"file.ext != "typ""#).unwrap();

        let typ_note = make_note(vec![(
            "file.ext",
            PropertyValue::String("typ".to_string()),
        )]);
        assert!(!evaluate(&expr, &typ_note, Path::new("/notebox/test.collection")));

        let pdf_note = make_note(vec![(
            "file.ext",
            PropertyValue::String("pdf".to_string()),
        )]);
        assert!(evaluate(&expr, &pdf_note, Path::new("/notebox/test.collection")));
    }

    #[test]
    fn test_negation_flips_result() {
        let expr = parse_filter_expr(r#"!file.tags.contains("rust")"#).unwrap();

        let has_rust = make_note(vec![(
            "file.tags",
            PropertyValue::List(vec![PropertyValue::String("rust".into())]),
        )]);
        assert!(!evaluate(&expr, &has_rust, Path::new("/notebox/x.collection")));

        let no_rust = make_note(vec![(
            "file.tags",
            PropertyValue::List(vec![PropertyValue::String("go".into())]),
        )]);
        assert!(evaluate(&expr, &no_rust, Path::new("/notebox/x.collection")));
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
    fn test_contains_is_case_sensitive() {
        // `contains` on a string property is a literal substring
        // check — `Rust` must not match `rust`. If this behavior ever
        // needs to change, update the test to match.
        let expr = parse_filter_expr(r#"file.folder.contains("Notes")"#).unwrap();
        let note = make_note(vec![(
            "file.folder",
            PropertyValue::String("my/notes".to_string()),
        )]);
        assert!(!evaluate(&expr, &note, Path::new("/notebox/x.collection")));
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
        assert!(!evaluate(&expr, &non_member, Path::new("/notebox/x.collection")));

        let no_collection = make_note(vec![]);
        assert!(!evaluate(&expr, &no_collection, Path::new("/notebox/x.collection")));
    }
}
