//! Renaming or removing a note property everywhere a `.collection` file uses
//! it: filter expressions (at any nesting depth), per-column filters, and each
//! view's column order, sort rules, column widths and summaries, plus the
//! file-level filters and summaries.
//!
//! The file is edited as generic YAML, so fields this module doesn't know
//! about survive. Filter expressions are rewritten through the filter parser
//! (see [`rename_property_in_expr`]), so a property is only touched where it
//! is used as a property: never inside a quoted value, as part of a longer
//! name, or as a `file.*` field.

use serde_yaml::{Mapping, Value};

use super::filter::{expr_references_property, rename_property_in_expr};

/// What to do with the property.
enum Edit<'a> {
    Rename { old: &'a str, new: &'a str },
    Remove { key: &'a str },
}

impl Edit<'_> {
    fn target(&self) -> &str {
        match self {
            Edit::Rename { old, .. } => old,
            Edit::Remove { key } => key,
        }
    }
}

/// Rename property `old` to `new` throughout a `.collection` file. Returns
/// the new file text, or `None` when nothing changed or the YAML doesn't
/// parse (the file is then left as it is).
pub fn rename_property(yaml: &str, old: &str, new: &str) -> Option<String> {
    apply(yaml, &Edit::Rename { old, new })
}

/// Remove property `key` throughout a `.collection` file: filter conditions
/// on it are dropped, as are its column, sort rule, width and summaries.
/// Returns the new file text, or `None` when nothing changed or the YAML
/// doesn't parse.
pub fn remove_property(yaml: &str, key: &str) -> Option<String> {
    apply(yaml, &Edit::Remove { key })
}

fn apply(yaml: &str, edit: &Edit) -> Option<String> {
    let mut doc: Value = serde_yaml::from_str(yaml).ok()?;
    let root = doc.as_mapping_mut()?;
    let mut changed = false;
    if let Some(filters) = root.get_mut("filters") {
        changed |= edit_filter_group(filters, edit);
    }
    if let Some(summaries) = root.get_mut("summaries") {
        changed |= edit_keys(summaries, edit);
    }
    if let Some(Value::Sequence(views)) = root.get_mut("views") {
        for view in views.iter_mut().filter_map(Value::as_mapping_mut) {
            changed |= edit_view(view, edit);
        }
    }
    if !changed {
        return None;
    }
    serde_yaml::to_string(&doc).ok()
}

fn edit_view(view: &mut Mapping, edit: &Edit) -> bool {
    let mut changed = false;
    if let Some(filters) = view.get_mut("filters") {
        changed |= edit_filter_group(filters, edit);
    }
    if let Some(column_filters) = view.get_mut("columnFilters") {
        changed |= edit_keys(column_filters, edit);
        if let Some(groups) = column_filters.as_mapping_mut() {
            for (_, group) in groups.iter_mut() {
                changed |= edit_filter_group(group, edit);
            }
        }
    }
    if let Some(Value::Sequence(order)) = view.get_mut("order") {
        changed |= edit_list(order, edit, |item| item.as_str());
    }
    if let Some(Value::Sequence(sort)) = view.get_mut("sort") {
        changed |= edit_list(sort, edit, |rule| {
            rule.get("property").and_then(Value::as_str)
        });
        if let Edit::Rename { old, new } = edit {
            for rule in sort.iter_mut().filter_map(Value::as_mapping_mut) {
                if rule.get("property").and_then(Value::as_str) == Some(*old) {
                    rule.insert("property".into(), (*new).into());
                }
            }
        }
    }
    for key in ["columnSize", "summaries"] {
        if let Some(map) = view.get_mut(key) {
            changed |= edit_keys(map, edit);
        }
    }
    changed
}

/// Rename or drop the entry keyed by the property in a mapping, keeping the
/// other entries in their order.
fn edit_keys(map: &mut Value, edit: &Edit) -> bool {
    let Some(entries) = map.as_mapping_mut() else {
        return false;
    };
    if !entries.contains_key(edit.target()) {
        return false;
    }
    let old_entries = std::mem::take(entries);
    for (k, v) in old_entries {
        if k.as_str() != Some(edit.target()) {
            entries.insert(k, v);
        } else if let Edit::Rename { new, .. } = edit {
            entries.insert((*new).into(), v);
        }
    }
    true
}

/// Rename or drop list items naming the property. `name_of` reads the
/// property an item names; for renames, plain string items are replaced here
/// and structured items by the caller.
fn edit_list(list: &mut Vec<Value>, edit: &Edit, name_of: impl Fn(&Value) -> Option<&str>) -> bool {
    let before = list.len();
    let mut renamed = false;
    match edit {
        Edit::Remove { key } => list.retain(|item| name_of(item) != Some(key)),
        Edit::Rename { old, new } => {
            for item in list.iter_mut() {
                if name_of(item) == Some(old) {
                    renamed = true;
                    if item.is_string() {
                        *item = (*new).into();
                    }
                }
            }
        }
    }
    renamed || list.len() != before
}

/// Apply the edit to a filter group: `and` / `or` / `not` lists whose
/// members are expression strings or nested groups.
fn edit_filter_group(group: &mut Value, edit: &Edit) -> bool {
    let Some(group) = group.as_mapping_mut() else {
        return false;
    };
    let mut changed = false;
    for combinator in ["and", "or", "not"] {
        let Some(Value::Sequence(members)) = group.get_mut(combinator) else {
            continue;
        };
        if let Edit::Remove { key } = edit {
            let before = members.len();
            members.retain(|m| !m.as_str().is_some_and(|e| expr_references_property(e, key)));
            changed |= members.len() != before;
        }
        for member in members.iter_mut() {
            match member {
                Value::String(expr) => {
                    if let Edit::Rename { old, new } = edit {
                        if let Some(renamed) = rename_property_in_expr(expr, old, new) {
                            *expr = renamed;
                            changed = true;
                        }
                    }
                }
                Value::Mapping(_) => changed |= edit_filter_group(member, edit),
                _ => {}
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    const COLLECTION: &str = r#"
icon: book
filters:
  and:
  - file.name != this.file.name
  - or:
    - status == "status"
    - my-status == "x"
views:
- type: table
  name: Main
  filters:
    and:
    - note["status"].contains("draft")
  columnFilters:
    status:
      or:
      - status == "done"
  order:
  - file.name
  - status
  - my-status
  sort:
  - property: status
    direction: DESC
  columnSize:
    status: 120.0
custom_field: kept
"#;

    #[test]
    fn rename_touches_only_uses_of_the_property() {
        let out = rename_property(COLLECTION, "status", "state").unwrap();
        // Uses as a property are renamed …
        assert!(out.contains(r#"state == "status""#), "{out}");
        assert!(out.contains(r#"state.contains("draft")"#), "{out}");
        assert!(out.contains("- state\n"), "{out}");
        assert!(out.contains("property: state"), "{out}");
        assert!(out.contains("state: 120.0"), "{out}");
        assert!(out.contains("columnFilters:\n    state:"), "{out}");
        // … values, longer names, file fields and unknown fields are not.
        assert!(out.contains("my-status"), "{out}");
        assert!(out.contains("file.name"), "{out}");
        assert!(out.contains("custom_field: kept"), "{out}");
    }

    #[test]
    fn rename_to_a_name_with_spaces_uses_the_bracket_form() {
        let out = rename_property(
            "filters:\n  and:\n  - status == \"x\"\n",
            "status",
            "work state",
        )
        .unwrap();
        assert!(out.contains(r#"note["work state"] == "x""#), "{out}");
    }

    #[test]
    fn remove_drops_conditions_and_columns_for_the_property() {
        let out = remove_property(COLLECTION, "status").unwrap();
        assert!(!out.contains(" status =="), "{out}");
        assert!(!out.contains("note[\"status\"]"), "{out}");
        assert!(!out.contains("property: status"), "{out}");
        assert!(!out.contains("columnFilters:\n    status"), "{out}");
        assert!(out.contains("my-status"), "{out}");
        assert!(out.contains("file.name != this.file.name"), "{out}");
    }

    #[test]
    fn unrelated_or_unparseable_files_are_left_alone() {
        assert_eq!(rename_property(COLLECTION, "missing", "x"), None);
        assert_eq!(rename_property("views: [unclosed", "status", "x"), None);
    }
}
