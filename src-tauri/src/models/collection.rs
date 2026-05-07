use super::note::PropertyValue;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionInfo {
    pub name: String,
    pub path: String,
    pub view_count: usize,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionData {
    pub columns: Vec<String>,
    pub rows: Vec<CollectionRow>,
    pub views: Vec<ViewInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionRow {
    pub file_path: String,
    pub file_name: String,
    pub cells: HashMap<String, PropertyValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewInfo {
    pub name: String,
    pub view_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultIndex {
    pub tags: Vec<(String, usize)>,
    pub property_keys: Vec<(String, usize)>,
}
