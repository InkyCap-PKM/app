use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub type NoteId = PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PropertyValue {
    String(String),
    Number(f64),
    Bool(bool),
    List(Vec<PropertyValue>),
    Null,
}

// `f64` doesn't implement `Eq`, so this is `PartialEq` only. Tests rely
// on equality to verify round-trip invariants on the property map.
impl PartialEq for PropertyValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::String(a), Self::String(b)) => a == b,
            (Self::Number(a), Self::Number(b)) => a == b,
            (Self::Bool(a), Self::Bool(b)) => a == b,
            (Self::List(a), Self::List(b)) => a == b,
            (Self::Null, Self::Null) => true,
            _ => false,
        }
    }
}

impl PropertyValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            PropertyValue::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            PropertyValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn is_empty(&self) -> bool {
        match self {
            PropertyValue::Null => true,
            PropertyValue::String(s) => s.is_empty(),
            PropertyValue::List(l) => l.is_empty(),
            _ => false,
        }
    }

    pub fn contains(&self, needle: &str) -> bool {
        match self {
            PropertyValue::String(s) => s.contains(needle),
            PropertyValue::List(items) => items.iter().any(|item| {
                if let PropertyValue::String(s) = item {
                    s == needle
                } else {
                    false
                }
            }),
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMetadata {
    pub path: PathBuf,
    pub properties: HashMap<String, PropertyValue>,
    /// Wikilinks found in the note body
    pub links: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub name: String,
    pub folder: String,
    pub ext: String,
    pub path: String,
    pub ctime: Option<String>,
    pub mtime: Option<String>,
    pub size: u64,
}
