// Global property type registry.
//
// Users can assign each property key a type (Text, Number, Date,
// Checkbox, etc.) that controls how the editor renders and writes
// values for that key. Types are global — one entry per key, shared
// across every note in the vault. Storage lives at
// `<vault>/.inkycap/property-types.json` so the registry round-trips
// across restarts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::models::note::PropertyValue;

/// One of the user-facing property types shown in the context menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PropertyType {
    /// Leave the value alone — no coercion, renderer picks an editor
    /// from the actual value type (current behavior for untyped keys).
    Auto,
    Checkbox,
    Date,
    #[serde(rename = "datetime")]
    DateTime,
    List,
    Number,
    Text,
}

impl Default for PropertyType {
    fn default() -> Self {
        PropertyType::Auto
    }
}

/// Built-in standard property types that are always available.
/// These cannot be deleted by users and provide correct defaults
/// even in a fresh vault.
fn builtin_property_type(key: &str) -> PropertyType {
    match key {
        "title" => PropertyType::Text,
        "date" => PropertyType::Date,
        "tags" => PropertyType::List,
        "status" => PropertyType::List,
        "source" => PropertyType::Text,
        "collection" => PropertyType::List,
        "description" => PropertyType::Text,
        "task" => PropertyType::Checkbox,
        "aliases" => PropertyType::List,
        "zid" => PropertyType::Number,
        _ => PropertyType::Auto,
    }
}

fn builtin_property_types() -> HashMap<String, PropertyType> {
    [
        ("title", PropertyType::Text),
        ("aliases", PropertyType::List),
        ("description", PropertyType::Text),
        ("tags", PropertyType::List),
        ("task", PropertyType::Checkbox),
        ("status", PropertyType::List),
        ("source", PropertyType::Text),
        ("zid", PropertyType::Number),
        ("date", PropertyType::Date),
        ("collection", PropertyType::List),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

/// Persistent on-disk shape of the registry.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RegistryFile {
    #[serde(default)]
    types: HashMap<String, PropertyType>,
}

/// Global property type registry, backed by
/// `<vault>/.inkycap/property-types.json`.
#[derive(Debug, Clone, Default)]
pub struct PropertyTypeRegistry {
    types: HashMap<String, PropertyType>,
    vault_root: Option<PathBuf>,
}

impl PropertyTypeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Resolve the storage path for a given vault.
    fn path_for(vault_root: &Path) -> PathBuf {
        vault_root.join(".inkycap").join("property-types.json")
    }

    /// Load the registry from disk for the given vault. A missing file
    /// yields an empty registry — this is the expected state for a fresh
    /// vault, not an error.
    pub fn load(vault_root: &Path) -> Self {
        let path = Self::path_for(vault_root);
        let types = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str::<RegistryFile>(&s)
                .map(|r| r.types)
                .unwrap_or_default(),
            Err(_) => HashMap::new(),
        };
        Self {
            types,
            vault_root: Some(vault_root.to_path_buf()),
        }
    }

    /// Persist the registry to disk. Best-effort: errors are logged but
    /// not returned — a missing type file just means the next session
    /// falls back to Auto, which is acceptable degradation.
    pub fn save(&self) {
        let Some(root) = &self.vault_root else {
            return;
        };
        let path = Self::path_for(root);
        if let Some(parent) = path.parent() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                eprintln!(
                    "property_types: failed to create {}: {err}",
                    parent.display()
                );
                return;
            }
        }
        let file = RegistryFile {
            types: self.types.clone(),
        };
        match serde_json::to_string_pretty(&file) {
            Ok(json) => {
                if let Err(err) = std::fs::write(&path, json) {
                    eprintln!(
                        "property_types: failed to write {}: {err}",
                        path.display()
                    );
                }
            }
            Err(err) => {
                eprintln!("property_types: failed to serialize: {err}");
            }
        }
    }

    pub fn get(&self, key: &str) -> PropertyType {
        self.types
            .get(key)
            .copied()
            .unwrap_or_else(|| builtin_property_type(key))
    }

    pub fn all(&self) -> HashMap<String, PropertyType> {
        let mut merged = builtin_property_types();
        // User-defined types override built-ins
        merged.extend(self.types.clone());
        merged
    }

    /// Set the type for a key. Auto is stored explicitly so the user's
    /// choice is remembered even when it matches the default — callers
    /// can still remove an entry with [`clear`] if they want it gone.
    pub fn set(&mut self, key: String, ty: PropertyType) {
        self.types.insert(key, ty);
    }

    /// Delete the entry for a key. Used when the property itself is
    /// deleted or renamed.
    pub fn clear(&mut self, key: &str) {
        self.types.remove(key);
    }

    pub fn rename(&mut self, old: &str, new: &str) {
        if let Some(ty) = self.types.remove(old) {
            self.types.insert(new.to_string(), ty);
        }
    }

    pub fn set_vault_root(&mut self, root: PathBuf) {
        self.vault_root = Some(root);
    }
}

/// Coerce a property value into the shape demanded by the given type.
/// Best-effort: unparseable values fall back to type-appropriate empty
/// defaults so the #note(...) call stays well-formed after a type change.
pub fn coerce_value(value: &PropertyValue, ty: PropertyType) -> PropertyValue {
    match ty {
        PropertyType::Auto => value.clone(),
        PropertyType::Text | PropertyType::Date | PropertyType::DateTime => {
            // Date and DateTime are stored as strings — we don't parse
            // them into a richer type. The UI
            // picks a specialized editor based on the declared type.
            match value {
                PropertyValue::String(s) => PropertyValue::String(s.clone()),
                PropertyValue::Number(n) => PropertyValue::String(format_number(*n)),
                PropertyValue::Bool(b) => PropertyValue::String(b.to_string()),
                PropertyValue::List(items) => {
                    let joined = items
                        .iter()
                        .map(stringify_value)
                        .collect::<Vec<_>>()
                        .join(", ");
                    PropertyValue::String(joined)
                }
                PropertyValue::Null => PropertyValue::Null,
            }
        }
        PropertyType::Number => match value {
            PropertyValue::Number(n) => PropertyValue::Number(*n),
            PropertyValue::String(s) => s
                .trim()
                .parse::<f64>()
                .map(PropertyValue::Number)
                .unwrap_or(PropertyValue::Null),
            PropertyValue::Bool(b) => PropertyValue::Number(if *b { 1.0 } else { 0.0 }),
            _ => PropertyValue::Null,
        },
        PropertyType::Checkbox => match value {
            PropertyValue::Bool(b) => PropertyValue::Bool(*b),
            PropertyValue::String(s) => {
                let lower = s.trim().to_lowercase();
                PropertyValue::Bool(matches!(
                    lower.as_str(),
                    "true" | "yes" | "1" | "on" | "checked"
                ))
            }
            PropertyValue::Number(n) => PropertyValue::Bool(*n != 0.0),
            PropertyValue::Null => PropertyValue::Bool(false),
            PropertyValue::List(items) => PropertyValue::Bool(!items.is_empty()),
        },
        PropertyType::List => match value {
            PropertyValue::List(items) => PropertyValue::List(items.clone()),
            PropertyValue::String(s) => {
                if s.trim().is_empty() {
                    PropertyValue::List(Vec::new())
                } else {
                    // Split on commas so "a, b, c" becomes a proper list
                    // — the most common human input for a
                    // comma-separated tag-style field.
                    let items = s
                        .split(',')
                        .map(|item| PropertyValue::String(item.trim().to_string()))
                        .filter(|pv| match pv {
                            PropertyValue::String(x) => !x.is_empty(),
                            _ => true,
                        })
                        .collect();
                    PropertyValue::List(items)
                }
            }
            PropertyValue::Null => PropertyValue::List(Vec::new()),
            other => PropertyValue::List(vec![other.clone()]),
        },
    }
}

fn stringify_value(v: &PropertyValue) -> String {
    match v {
        PropertyValue::String(s) => s.clone(),
        PropertyValue::Number(n) => format_number(*n),
        PropertyValue::Bool(b) => b.to_string(),
        PropertyValue::Null => String::new(),
        PropertyValue::List(items) => items
            .iter()
            .map(stringify_value)
            .collect::<Vec<_>>()
            .join(", "),
    }
}

fn format_number(n: f64) -> String {
    if n == (n as i64) as f64 {
        format!("{}", n as i64)
    } else {
        n.to_string()
    }
}
