//! External tools: lets users connect other programs to InkyCap (grammar checkers,
//! rewriters, linters, custom exporters) without InkyCap including any of them.
//!
//! The user registers an executable in settings ([`ExternalTool`]); InkyCap sends
//! text to its stdin and reads its stdout. What keeps this safe:
//!
//! * **Run from Rust**, not through the webview's shell allowlist (which allows only
//!   `binaries/inkycap-tinymist`).
//! * **Chosen by id, never by path.** The frontend names a tool by `id`; the
//!   executable path comes only from saved settings, so the webview can't run an
//!   arbitrary program.
//! * **Set up by the user**, who entered the path, as with the Pandoc and Zotero
//!   paths.
//! * **No shell.** Arguments are passed as a list; user text never becomes a shell
//!   command.
//! * **Limited** output size and a timeout stop a runaway process.
//!
//! See `documentation/developer/extending/external-tools.md`.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::errors::{InkyCapError, Result};
use crate::settings::ExternalTool;
use crate::state::AppState;

/// Most bytes read from a tool's stdout. More is an error, never silently cut
/// off.
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// Hard wall-clock limit for a single tool run.
const RUN_TIMEOUT: Duration = Duration::from_secs(60);

/// Result of running an external tool, returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ExternalToolResult {
    /// The tool's stdout (lossy UTF-8 — tools are expected to emit text).
    pub stdout: String,
    /// The tool's output mode (`"insert"` | `"replace"` | `"notify"`), returned
    /// so the frontend needn't read the settings again (which could have
    /// changed).
    pub output: String,
}

/// Substitute the supported placeholders in a single argument. ASCII-delimited
/// literal replacement only — never interpreted by a shell.
fn substitute(arg: &str, notebox_root: &str, file: &str, selection: &str) -> String {
    arg.replace("$INKYCAP_NOTEBOX_ROOT", notebox_root)
        .replace("$INKYCAP_FILE", file)
        .replace("$INKYCAP_SELECTION", selection)
}

/// Run a registered external tool: send `input_text` to its stdin and return
/// its stdout. `selection` and `file_path` fill argument placeholders. The
/// frontend chose `input_text` by the tool's `input` mode (the editor's text,
/// which may be unsaved).
#[tauri::command]
pub async fn run_external_tool(
    tool_id: String,
    input_text: String,
    selection: String,
    file_path: Option<String>,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<ExternalToolResult> {
    let session = state.session(window.label()).await;
    // Resolve the tool from persisted settings by id. The executable path comes
    // only from here, never from the caller.
    let tool: ExternalTool = {
        let settings = state.settings.read().await;
        settings
            .external_tools
            .tools
            .iter()
            .find(|t| t.id == tool_id)
            .cloned()
            .ok_or_else(|| InkyCapError::BadRequest(format!("unknown external tool: {tool_id}")))?
    };

    // Validate the configured executable before spawning.
    if tool.command.trim().is_empty() {
        return Err(InkyCapError::BadRequest(
            "external tool has no command configured".into(),
        ));
    }
    let command_path = PathBuf::from(&tool.command);
    if !command_path.is_file() {
        return Err(InkyCapError::BadRequest(format!(
            "external tool executable not found: {}",
            tool.command
        )));
    }

    // OS-native paths, since these are command-line arguments for a program,
    // not IPC.
    let notebox_root = session
        .notebox_root
        .read()
        .await
        .as_ref()
        .map(|p| p.display().to_string()) // path-stringification-ok: subprocess argv for an external tool, not an IPC payload
        .unwrap_or_default();
    let file = file_path.unwrap_or_default();

    let args: Vec<String> = tool
        .args
        .iter()
        .map(|a| substitute(a, &notebox_root, &file, &selection))
        .collect();

    let mut child = Command::new(&command_path)
        .args(&args)
        // stderr is discarded so an unread, chatty stderr pipe can never block
        // the child; failures surface via the exit status below.
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| InkyCapError::BadRequest(format!("failed to launch external tool: {e}")))?;

    // Write stdin on a separate task, concurrently with reading stdout; a tool
    // that writes output while still reading input would otherwise deadlock.
    let writer = if tool.input == "none" {
        drop(child.stdin.take());
        None
    } else {
        let stdin = child.stdin.take();
        // If the tool asks for it, reduce the text to plain prose first
        // (checkers want the writing, not imports, `#note(...)`, markup, math
        // or code). Done here since the Typst parser is in Rust; see
        // `crate::typst_pipeline::plaintext`.
        let data = if tool.strip_markup {
            crate::typst_pipeline::plaintext::extract_plain_text(&input_text).into_bytes()
        } else {
            input_text.into_bytes()
        };
        Some(tokio::spawn(async move {
            if let Some(mut s) = stdin {
                let _ = s.write_all(&data).await;
                // dropping `s` closes the pipe, signalling EOF to the child
            }
        }))
    };

    let run = async {
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| InkyCapError::BadRequest("external tool stdout unavailable".into()))?;
        let mut buf: Vec<u8> = Vec::with_capacity(8192);
        let mut chunk = [0u8; 8192];
        loop {
            let n = stdout.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            if buf.len() + n > MAX_OUTPUT_BYTES {
                return Err(InkyCapError::BadRequest(
                    "external tool produced too much output".into(),
                ));
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let status = child.wait().await?;
        Ok::<(Vec<u8>, std::process::ExitStatus), InkyCapError>((buf, status))
    };

    let (buf, status) = match tokio::time::timeout(RUN_TIMEOUT, run).await {
        Ok(res) => res?,
        Err(_) => {
            let _ = child.start_kill();
            return Err(InkyCapError::BadRequest("external tool timed out".into()));
        }
    };

    if let Some(handle) = writer {
        let _ = handle.await;
    }

    if !status.success() {
        return Err(InkyCapError::BadRequest(format!(
            "external tool exited unsuccessfully ({})",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "terminated by signal".into())
        )));
    }

    Ok(ExternalToolResult {
        stdout: String::from_utf8_lossy(&buf).into_owned(),
        output: tool.output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitute_replaces_all_placeholders() {
        let out = substitute(
            "$INKYCAP_FILE:$INKYCAP_SELECTION@$INKYCAP_NOTEBOX_ROOT",
            "/root",
            "/root/note.typ",
            "hello",
        );
        assert_eq!(out, "/root/note.typ:hello@/root");
    }

    #[test]
    fn substitute_leaves_unknown_text_untouched() {
        assert_eq!(substitute("--flag=value", "/r", "/f", "s"), "--flag=value");
    }
}
