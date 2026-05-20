use serde::{Deserialize, Serialize};

/// Public-facing notebox summary. `path` is in the frontend-canonical shape
/// (forward-slash, no Windows `\\?\` UNC prefix) — see
/// `crate::storage::to_frontend_string`. Treat as opaque on the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteboxInfo {
    pub path: String,
    pub name: String,
    pub file_count: usize,
    pub collection_count: usize,
    pub property_keys: Vec<String>,
}
