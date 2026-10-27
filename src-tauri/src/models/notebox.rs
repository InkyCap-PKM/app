use serde::{Deserialize, Serialize};

/// Notebox summary. `path` is in frontend-canonical form (forward slashes, no
/// Windows `\\?\` prefix; see `crate::storage::to_frontend_string`); the
/// frontend treats it as opaque.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteboxInfo {
    pub path: String,
    pub name: String,
    pub file_count: usize,
    pub collection_count: usize,
    pub property_keys: Vec<String>,
}
