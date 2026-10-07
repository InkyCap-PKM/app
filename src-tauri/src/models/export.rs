//! Export options that are both sent by the export dialogs and stored in a
//! collection's `export:` settings.

use serde::{Deserialize, Serialize};

/// What an export does with links to notebox files (a PDF, a spreadsheet).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileLinkMode {
    /// Keep the link exactly as the note has it (`/Assets/paper.pdf`).
    #[default]
    AsWritten,
    /// Replace the link with its text, or the file's name.
    FileName,
    /// Copy the file into the folder beside the export and link to the copy.
    Copies,
}

/// How an export treats the files a note uses. Sent by the export dialogs;
/// absent means "as written, copy nothing", the behaviour before the option.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LinkedFilesOptions {
    pub links: FileLinkMode,
    /// Copy the images a note places (its figures) into the folder too.
    pub copy_images: bool,
}

/// The separator between columns when a collection's table is exported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableDelimiter {
    /// Comma-separated values (`.csv`).
    #[default]
    Comma,
    /// Tab-separated values (`.tsv`).
    Tab,
}
