//! Hands local files and URLs to the operating system's default application,
//! and recognizes files that the system would run as programs.
//!
//! The target is always passed to the system as a single value, never through
//! a command shell, so characters like `&`, `|` or `%` in a file name or URL
//! can't be read as extra commands.

use std::ffi::OsStr;
use std::io;
use std::path::Path;

/// Open a local file or folder with its default application.
pub fn open_path(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        // Shell execution is unreliable with forward slashes, which paths
        // from the frontend use. path-stringification-ok: OS call argument,
        // not an IPC payload.
        let native = path.to_string_lossy().replace('/', "\\");
        windows_shell_open(OsStr::new(&native))
    }
    #[cfg(not(target_os = "windows"))]
    {
        unix_open(path.as_os_str())
    }
}

/// Open a URL (any scheme the system has a handler for) in its default
/// application. Callers are responsible for refusing dangerous schemes.
pub fn open_url(url: &str) -> io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        windows_shell_open(OsStr::new(url))
    }
    #[cfg(not(target_os = "windows"))]
    {
        unix_open(OsStr::new(url))
    }
}

/// File extensions that the system runs as programs, scripts or shortcuts to
/// programs when opened, rather than showing them in a viewer. Checked without
/// regard to case. macOS `.app` bundles are folders, so the check also applies
/// to folders.
const PROGRAM_EXTENSIONS: &[&str] = &[
    // Windows programs, installers and scripts
    "exe",
    "com",
    "bat",
    "cmd",
    "msi",
    "msp",
    "scr",
    "pif",
    "cpl",
    "hta",
    "lnk",
    "url",
    "reg",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "appref-ms",
    // macOS
    "app",
    "command",
    "pkg",
    "workflow",
    // Linux and other Unix
    "desktop",
    "sh",
    "bash",
    "zsh",
    "run",
    "appimage",
    // Cross-platform
    "jar",
];

/// Whether opening this path would run it as a program instead of viewing it.
pub fn is_program_file(path: &Path) -> bool {
    path.extension().and_then(OsStr::to_str).is_some_and(|ext| {
        PROGRAM_EXTENSIONS
            .iter()
            .any(|p| p.eq_ignore_ascii_case(ext))
    })
}

#[cfg(not(target_os = "windows"))]
fn unix_open(target: &OsStr) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    const OPENER: &str = "open";
    #[cfg(not(target_os = "macos"))]
    const OPENER: &str = "xdg-open";

    // A leading `-` would be read as an option by the opener. `--` doesn't
    // work for every `xdg-open` version, so refuse it instead.
    if target.to_string_lossy().starts_with('-') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "refusing to open a target that starts with '-'",
        ));
    }
    let mut child = std::process::Command::new(OPENER).arg(target).spawn()?;
    // Collect the opener's exit status in the background so it doesn't linger
    // as a finished-but-unreaped process.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_shell_open(target: &OsStr) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file: Vec<u16> = target.encode_wide().chain(std::iter::once(0)).collect();
    let verb: Vec<u16> = OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // Some file handlers rely on COM, which Microsoft requires the calling
    // thread to set up before `ShellExecuteW`. A short-lived thread keeps that
    // setup away from the async runtime's shared threads.
    let handle = std::thread::spawn(move || {
        // SAFETY: both buffers are NUL-terminated UTF-16 and outlive the call;
        // null pointers are allowed for the window, parameters and directory.
        unsafe {
            let hr = CoInitializeEx(
                std::ptr::null(),
                (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            );
            let result = ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
            if hr >= 0 {
                CoUninitialize();
            }
            result as isize
        }
    });
    let code = handle
        .join()
        .map_err(|_| io::Error::other("the system opener thread stopped unexpectedly"))?;
    // Values above 32 mean success; anything else is a Windows error code.
    if code > 32 {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "Windows could not open the item (code {code})"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_program_files_case_insensitively() {
        for name in [
            "setup.EXE",
            "run.bat",
            "Launch.desktop",
            "Tool.app",
            "x.ps1",
            "a.AppImage",
        ] {
            assert!(
                is_program_file(Path::new(name)),
                "{name} should count as a program"
            );
        }
    }

    #[test]
    fn ordinary_documents_are_not_programs() {
        for name in [
            "report.pdf",
            "photo.jpg",
            "notes.typ",
            "data.csv",
            "README",
            "archive.zip",
        ] {
            assert!(
                !is_program_file(Path::new(name)),
                "{name} should not count as a program"
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn refuses_targets_that_look_like_options() {
        let err = unix_open(OsStr::new("--help")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }
}
