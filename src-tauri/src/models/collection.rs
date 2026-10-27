use super::note::PropertyValue;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionInfo {
    pub name: String,
    pub path: String,
    pub view_count: usize,
    pub icon: Option<String>,
    /// Unix seconds for the `.collection` file, as in
    /// [`crate::storage::traits::FileTreeNode`]. Zero when the platform doesn't
    /// provide it; the frontend sorts zero as unknown.
    pub modified_time: u64,
    pub created_time: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionData {
    pub columns: Vec<String>,
    pub rows: Vec<CollectionRow>,
    pub views: Vec<ViewInfo>,
    /// Distinct values per column across the view's members (before its column
    /// filters), for the checklist in a list/commalist column's header filter.
    /// Sorted; columns with too many distinct values, or none, are left out.
    #[serde(rename = "columnValues")]
    pub column_values: HashMap<String, Vec<String>>,
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
pub struct NoteboxIndex {
    pub tags: Vec<(String, usize)>,
    pub property_keys: Vec<(String, usize)>,
}
