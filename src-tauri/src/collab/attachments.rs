//! Resolving a note's raw path references into notebox-relative
//! attachment paths for packaging.
//!
//! Pairs with [`crate::typst_pipeline::path_rebase::extract_referenced_paths`],
//! which pulls the raw string arguments out of a note's `image` / `read`
//! / `embed` / `bibliography` calls. This module turns each raw value
//! into a notebox-relative path (forward slashes) when it names a file
//! inside the notebox, or `None` when it shouldn't be packaged (a URL, an
//! empty string, or a path that escapes the notebox).

/// Resolve a raw path argument from a note into a notebox-relative path.
///
/// - **Absolute** (`/Assets/x.png`) — the InkyCap convention; the
///   notebox-relative path is the value minus its leading slash.
/// - **Relative** (`fig.png`, `../img/a.png`) — resolved against the
///   note's own directory and normalized; rejected if it escapes the
///   notebox.
/// - URLs, empty strings, and escaping paths return `None`.
///
/// `note_relpath` is the note's own notebox-relative path (forward
/// slashes), used as the anchor for relative references.
pub fn resolve_attachment_relpath(note_relpath: &str, raw: &str) -> Option<String> {
    if raw.is_empty() || raw.contains("://") {
        return None;
    }
    if let Some(stripped) = raw.strip_prefix('/') {
        return normalize_relpath(stripped);
    }
    let note_dir = match note_relpath.rsplit_once('/') {
        Some((dir, _)) => dir,
        None => "",
    };
    let joined = if note_dir.is_empty() {
        raw.to_string()
    } else {
        format!("{note_dir}/{raw}")
    };
    normalize_relpath(&joined)
}

/// Lexically normalize a forward-slash relative path, resolving `.` and
/// `..`. Returns `None` if it escapes above the root or is empty after
/// normalization.
fn normalize_relpath(path: &str) -> Option<String> {
    let mut stack: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                stack.pop()?;
            }
            s => stack.push(s),
        }
    }
    if stack.is_empty() {
        None
    } else {
        Some(stack.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_strips_leading_slash() {
        assert_eq!(
            resolve_attachment_relpath("notes/x.typ", "/Assets/a.png"),
            Some("Assets/a.png".to_string())
        );
    }

    #[test]
    fn relative_anchors_to_note_dir() {
        assert_eq!(
            resolve_attachment_relpath("notes/x.typ", "fig.png"),
            Some("notes/fig.png".to_string())
        );
        assert_eq!(
            resolve_attachment_relpath("notes/sub/x.typ", "../img/a.png"),
            Some("notes/img/a.png".to_string())
        );
    }

    #[test]
    fn root_level_note_relative() {
        assert_eq!(
            resolve_attachment_relpath("x.typ", "a.png"),
            Some("a.png".to_string())
        );
    }

    #[test]
    fn url_empty_and_escape_rejected() {
        assert_eq!(resolve_attachment_relpath("x.typ", "https://e.com/a.png"), None);
        assert_eq!(resolve_attachment_relpath("x.typ", ""), None);
        assert_eq!(resolve_attachment_relpath("x.typ", "../../outside.png"), None);
        // Absolute that escapes via .. is also rejected.
        assert_eq!(resolve_attachment_relpath("x.typ", "/../oops.png"), None);
    }
}
