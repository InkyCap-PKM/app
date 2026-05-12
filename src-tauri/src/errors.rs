use thiserror::Error;

#[derive(Debug, Error)]
pub enum InkyCapError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("YAML parse error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Vault not open")]
    VaultNotOpen,

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("Filter parse error: {0}")]
    FilterParse(String),

    #[error("Metadata cache error: {0}")]
    Cache(String),

    #[error("Typst compile error: {0}")]
    Typst(String),

    #[error("Export failed: {0}")]
    ExportFailed(String),

    #[error("{0}")]
    BadRequest(String),
}

impl From<rusqlite::Error> for InkyCapError {
    fn from(err: rusqlite::Error) -> Self {
        InkyCapError::Cache(err.to_string())
    }
}

impl serde::Serialize for InkyCapError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, InkyCapError>;
