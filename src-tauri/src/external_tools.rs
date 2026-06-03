//! The generic **external-tool bridge** — the one programmatic seam that lets
//! outside developers connect arbitrary programs to InkyCap without InkyCap
//! shipping any concrete integration (grammar checkers, AI rewriters, dictation
//! post-processors, linters, custom exporters all become user-installable
//! tools).
//!
//! Model: the user registers an executable in settings ([`ExternalTool`]);
//! InkyCap pipes text to its stdin and takes its stdout back — the Unix-pipe
//! pattern. Security properties that make this safe despite running an external
//! program:
//!
//! * **Spawned from Rust**, not via the webview shell allowlist (which stays
//!   pinned to `binaries/tinymist`). The exec decision lives inside the trust
//!   boundary.
//! * **Resolved by id, never by path.** The frontend invokes a tool by its
//!   stable `id`; the executable path is read only from persisted settings, so
//!   the webview cannot ask InkyCap to run an arbitrary binary.
//! * **User-authorized by construction** — the user pasted the path themselves,
//!   the same model as the existing Pandoc and Zotero paths.
//! * **No shell.** Arguments are passed as a vector; user text never becomes a
//!   shell string.
//! * **Bounded** output and a wall-clock timeout guard against a runaway child.
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

/// Max bytes captured from a tool's stdout. Tools are user-authorized, but a
/// runaway process must not be able to exhaust memory — output past this is an
/// error, never a silent truncation.
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// Hard wall-clock limit for a single tool run.
const RUN_TIMEOUT: Duration = Duration::from_secs(60);

/// Result of running an external tool, returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ExternalToolResult {
    /// The tool's stdout (lossy UTF-8 — tools are expected to emit text).
    pub stdout: String,
    /// The configured output disposition (`"insert"` | `"replace"` |
    /// `"notify"`), echoed so the frontend applies the result without
    /// re-reading settings (and without a TOCTOU window on the tool list).
    pub output: String,
}

/// Substitute the supported placeholders in a single argument. ASCII-delimited
/// literal replacement only — never interpreted by a shell.
fn substitute(arg: &str, notebox_root: &str, file: &str, selection: &str) -> String {
    arg.replace("$INKYCAP_NOTEBOX_ROOT", notebox_root)
        .replace("$INKYCAP_FILE", file)
        .replace("$INKYCAP_SELECTION", selection)
}

/// Run a registered external tool: pipe `input_text` to its stdin, return its
/// stdout. `selection` and `file_path` feed the argument placeholders; the
/// frontend has already chosen `input_text` per the tool's `input` mode (the
/// live buffer, which may differ from what's on disk — piping what the user
/// sees is the intended behaviour).
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

    // Native-shape paths for argv: the tool operates on the real filesystem, so
    // it needs OS-native separators, not the frontend-canonical forward-slash
    // shape. This is subprocess argv, not an IPC payload.
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

    // Write stdin on a separate task so it runs concurrently with the stdout
    // read below — otherwise a tool that streams output while we're still
    // writing input would deadlock on the pipe buffers.
    let writer = if tool.input == "none" {
        drop(child.stdin.take());
        None
    } else {
        let stdin = child.stdin.take();
        // Reduce the piped text to plain prose first when the tool opts in —
        // grammar/style checkers want the writing, not the `#import` preamble,
        // `#note(...)` metadata, inline markup, math, or code. Done here (not
        // on the frontend) because the Typst parser is Rust-only; see CLAUDE.md
        // Typst-first principle and `crate::typst_pipeline::plaintext`.
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
