use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteboxInfo {
    pub path: PathBuf,
    pub name: String,
    pub file_count: usize,
    pub collection_count: usize,
    pub property_keys: Vec<String>,
}
