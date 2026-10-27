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

    #[error("Network error: {0}")]
    Network(String),

    #[error("{0}")]
    BadRequest(String),

    /// A creation rule has no file name: its pattern is blank or expands to
    /// nothing (e.g. `{{zid}}` with Zettelkasten off). The frontend matches
    /// this code, asks for a name and retries with `title_override`. Its own
    /// code, so it isn't matched by message text.
    #[error("A filename is required")]
    FilenameRequired,

    /// The notebox is open in another window, whose label is in `detail`. The
    /// frontend focuses that window, with no error shown.
    #[error("Notebox is already open in another window")]
    NoteboxAlreadyOpen(String),

    /// A note with this name exists elsewhere in the notebox (names are unique,
    /// since wikilinks resolve by stem). Its path is in `detail`; the frontend
    /// offers to open it or choose another name.
    #[error("A note with that name already exists elsewhere in the notebox")]
    NoteNameConflict(String),

    /// The user cancelled a long-running operation. Separate from `BadRequest`
    /// so no error is shown.
    #[error("Cancelled")]
    Cancelled,

    /// A structural change (create, rename, move, delete, attach) in the
    /// bundled documentation notebox, which is read-only. Content edits don't
    /// error (they are kept for the session, not saved), but structural changes
    /// are refused so the manual stays intact.
    #[error("The documentation notebox is read-only; changes are not saved")]
    DocumentationReadOnly,

    /// A read needing the indexes while they are still being built, with
    /// nothing cached to answer it. The frontend leaves the view empty and
    /// retries on `notebox:index-ready`.
    #[error("The notebox is still being indexed")]
    IndexNotReady,

    /// The in-app upgrade can't be used: this install type can't update itself
    /// (Flatpak, NixOS, self-built), or the release has no installer for this
    /// system. The frontend points to Download instead.
    #[error("Automatic upgrade isn't available: {0}")]
    UpgradeUnavailable(String),

    /// A downloaded update failed its signature check and wasn't installed.
    /// Separate, so the message can say nothing was changed and why.
    #[error("The update couldn't be verified, so it wasn't installed: {0}")]
    UpgradeNotVerified(String),

    /// Installing a verified update failed (the system installer refused, a
    /// file couldn't be replaced, …). The running version is unchanged.
    #[error("The update couldn't be installed: {0}")]
    UpgradeFailed(String),

    /// The system clipboard couldn't be read.
    #[error("Couldn't read the clipboard: {0}")]
    Clipboard(String),

    /// A file to open in its default application would run as a program. Path
    /// in `detail`; the frontend asks and retries with confirmation.
    #[error("This file is a program: {0}")]
    OpenProgramFile(String),

    /// A file to open in its default application is outside the notebox. Path
    /// in `detail`; the frontend asks and retries with confirmation.
    #[error("This file is outside the notebox: {0}")]
    OpenOutsideNotebox(String),

    /// A file too large for the webview, which keeps several copies in memory
    /// while loading. Its size is in `detail`.
    #[error("This file is too large to show inside InkyCap ({0})")]
    FileTooLargeToShow(String),
}

impl InkyCapError {
    /// Fixed, untranslated code for the variant. The frontend shows
    /// `errors.<code>` from the locale and branches on the code (e.g.
    /// `"cancelled"` isn't an error). Codes are part of the IPC contract: rename
    /// them only together with `src/lib/errors.ts` and the `errors.*` locale
    /// keys.
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
            InkyCapError::Network(_) => "network",
            InkyCapError::BadRequest(_) => "bad-request",
            InkyCapError::FilenameRequired => "filename-required",
            InkyCapError::NoteNameConflict(_) => "note-name-conflict",
            InkyCapError::NoteboxAlreadyOpen(_) => "notebox-already-open",
            InkyCapError::Cancelled => "cancelled",
            InkyCapError::DocumentationReadOnly => "documentation-read-only",
            InkyCapError::IndexNotReady => "index-not-ready",
            InkyCapError::UpgradeUnavailable(_) => "upgrade-unavailable",
            InkyCapError::UpgradeNotVerified(_) => "upgrade-not-verified",
            InkyCapError::UpgradeFailed(_) => "upgrade-failed",
            InkyCapError::Clipboard(_) => "clipboard",
            InkyCapError::OpenProgramFile(_) => "open-program-file",
            InkyCapError::OpenOutsideNotebox(_) => "open-outside-notebox",
            InkyCapError::FileTooLargeToShow(_) => "file-too-large-to-show",
        }
    }

    /// The variable part of the error (a path, an external tool's message, a
    /// sentence), filling the `{detail}` placeholder. `None` for fixed messages
    /// (`NoteboxNotOpen`, `Cancelled`).
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
            | InkyCapError::Network(s)
            | InkyCapError::BadRequest(s)
            | InkyCapError::NoteNameConflict(s)
            | InkyCapError::NoteboxAlreadyOpen(s)
            | InkyCapError::UpgradeUnavailable(s)
            | InkyCapError::UpgradeNotVerified(s)
            | InkyCapError::UpgradeFailed(s)
            | InkyCapError::Clipboard(s)
            | InkyCapError::OpenProgramFile(s)
            | InkyCapError::OpenOutsideNotebox(s)
            | InkyCapError::FileTooLargeToShow(s) => Some(s.clone()),
            InkyCapError::NoteboxNotOpen
            | InkyCapError::FilenameRequired
            | InkyCapError::Cancelled
            | InkyCapError::DocumentationReadOnly
            | InkyCapError::IndexNotReady => None,
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

/// Errors are sent as `{ code, message, detail }` so the frontend can translate
/// them: `code` picks `errors.<code>`, `detail` fills `{detail}`, and `message`
/// is the English fallback when there is no key. See `src/lib/errors.ts`.
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

    /// Every error is sent as `{ code, message, detail }`, as `src/lib/errors.ts`
    /// expects.
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

    /// `message` and the `errors.<code>` template must read the same, so they
    /// don't drift when an `#[error("…")]` changes.
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
