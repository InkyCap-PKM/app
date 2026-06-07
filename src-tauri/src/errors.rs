use thiserror::Error;

#[derive(Debug, Error)]
pub enum InkyCapError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("YAML parse error: {0}")]
    Yaml(#[from] serde_yaml::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Notebox not open")]
    NoteboxNotOpen,

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

    #[error("Git error: {0}")]
    Git(String),

    #[error("{0}")]
    BadRequest(String),

    /// The requested notebox is already open in another window. Carries that
    /// window's label (in `detail`) so the frontend can focus it instead of
    /// opening a duplicate — a notebox is exclusive to one window. Not a
    /// user-facing failure: the frontend matches the code and focuses the
    /// window without a toast.
    #[error("Notebox is already open in another window")]
    NoteboxAlreadyOpen(String),

    /// A long-running operation was cancelled cooperatively. Distinct
    /// from `BadRequest` so the UI can suppress an "error" toast on
    /// the success path (the user asked for the cancel, it isn't a
    /// failure to report).
    #[error("Cancelled")]
    Cancelled,

    /// A structural mutation (create / rename / move / delete / attach) was
    /// attempted in the bundled documentation notebox, which is read-only on
    /// disk. Content edits don't error — they're silently kept for the session
    /// but never persisted — but file-structure changes are refused outright so
    /// the shipped manual stays intact.
    #[error("The documentation notebox is read-only; changes are not saved")]
    DocumentationReadOnly,
}

impl InkyCapError {
    /// Stable, never-localized machine code for this error variant. The frontend
    /// looks up `errors.<code>` in the active locale to render a translated
    /// message, and matches on the code for control flow (e.g. treating
    /// `"cancelled"` as a non-error). Codes are part of the IPC contract — rename
    /// them only in lockstep with `src/lib/errors.ts` and the `errors.*` keys in
    /// the locale files.
    pub fn code(&self) -> &'static str {
        match self {
            InkyCapError::Io(_) => "io",
            InkyCapError::Yaml(_) => "yaml",
            InkyCapError::Json(_) => "json",
            InkyCapError::NoteboxNotOpen => "notebox-not-open",
            InkyCapError::FileNotFound(_) => "file-not-found",
            InkyCapError::InvalidPath(_) => "invalid-path",
            InkyCapError::FilterParse(_) => "filter-parse",
            InkyCapError::Cache(_) => "cache",
            InkyCapError::Typst(_) => "typst",
            InkyCapError::ExportFailed(_) => "export-failed",
            InkyCapError::Git(_) => "git",
            InkyCapError::BadRequest(_) => "bad-request",
            InkyCapError::NoteboxAlreadyOpen(_) => "notebox-already-open",
            InkyCapError::Cancelled => "cancelled",
            InkyCapError::DocumentationReadOnly => "documentation-read-only",
        }
    }

    /// The single interpolated value carried by this error — a path, an external
    /// tool's (untranslatable) message, or a free-form sentence — surfaced to the
    /// frontend as the `{detail}` placeholder of the translated template. `None`
    /// for variants whose message is fully static (`NoteboxNotOpen`, `Cancelled`).
    pub fn detail(&self) -> Option<String> {
        match self {
            InkyCapError::Io(e) => Some(e.to_string()),
            InkyCapError::Yaml(e) => Some(e.to_string()),
            InkyCapError::Json(e) => Some(e.to_string()),
            InkyCapError::FileNotFound(s)
            | InkyCapError::InvalidPath(s)
            | InkyCapError::FilterParse(s)
            | InkyCapError::Cache(s)
            | InkyCapError::Typst(s)
            | InkyCapError::ExportFailed(s)
            | InkyCapError::Git(s)
            | InkyCapError::BadRequest(s)
            | InkyCapError::NoteboxAlreadyOpen(s) => Some(s.clone()),
            InkyCapError::NoteboxNotOpen
            | InkyCapError::Cancelled
            | InkyCapError::DocumentationReadOnly => None,
        }
    }
}

impl From<rusqlite::Error> for InkyCapError {
    fn from(err: rusqlite::Error) -> Self {
        InkyCapError::Cache(err.to_string())
    }
}

impl From<git2::Error> for InkyCapError {
    fn from(err: git2::Error) -> Self {
        InkyCapError::Git(err.to_string())
    }
}

/// Errors cross the IPC boundary as a structured envelope rather than a bare
/// string so the frontend can localize them: `code` selects the `errors.<code>`
/// translation, `detail` fills its `{detail}` placeholder, and `message` is the
/// composed English fallback used when no translation key exists (new variants,
/// or free-form `BadRequest` text). See `src/lib/errors.ts` for the consumer.
impl serde::Serialize for InkyCapError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut st = serializer.serialize_struct("InkyCapError", 3)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.serialize_field("detail", &self.detail())?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, InkyCapError>;

#[cfg(test)]
mod tests {
    use super::*;

    /// The IPC envelope is a contract with `src/lib/errors.ts`: every error
    /// crosses the boundary as `{ code, message, detail }`. The frontend keys
    /// `errors.<code>` off `code`, fills `{detail}`, and falls back to `message`.
    #[test]
    fn serializes_as_code_message_detail_envelope() {
        let err = InkyCapError::FileNotFound("/notes/missing.typ".into());
        let value = serde_json::to_value(&err).unwrap();
        assert_eq!(value["code"], "file-not-found");
        assert_eq!(value["message"], "File not found: /notes/missing.typ");
        assert_eq!(value["detail"], "/notes/missing.typ");
    }

    /// Static-message variants carry a null detail (no `{detail}` placeholder in
    /// their template), and the user-cancel path stays matchable by code.
    #[test]
    fn static_variants_have_null_detail() {
        let value = serde_json::to_value(InkyCapError::Cancelled).unwrap();
        assert_eq!(value["code"], "cancelled");
        assert!(value["detail"].is_null());

        let value = serde_json::to_value(InkyCapError::NoteboxNotOpen).unwrap();
        assert_eq!(value["code"], "notebox-not-open");
        assert!(value["detail"].is_null());
    }

    /// `message` (Display) and the `errors.<code>` template must stay in lockstep
    /// so the English fallback reads identically to the translated string — guard
    /// against the two drifting when a variant's `#[error("…")]` text changes.
    #[test]
    fn message_matches_code_and_detail() {
        let err = InkyCapError::Git("merge conflict".into());
        let value = serde_json::to_value(&err).unwrap();
        assert_eq!(value["code"], "git");
        assert_eq!(value["detail"], "merge conflict");
        // errors.git == "Git error: {detail}"
        assert_eq!(value["message"], "Git error: merge conflict");
    }
}
