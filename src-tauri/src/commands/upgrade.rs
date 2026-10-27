//! In-app upgrade: download, verify and install a newer release.
//!
//! The Tauri updater plugin does the work: it reads a feed with one installer
//! per platform, picks the one for how this copy was installed, rejects
//! downloads not signed with the key in tauri.conf.json, and runs the installer
//! (`pkexec dpkg` / `rpm` on Linux, NSIS or MSI on Windows, replacing the
//! `.app` on macOS) or replaces the AppImage. This module decides whether this
//! copy may upgrade itself, points the plugin at the feed, reports progress and
//! restarts the app.
//!
//! ## Which copies may upgrade themselves
//!
//! Only copies from InkyCap's own installers (see [`detect_support`]). Others
//! get the Download button only, except:
//!
//! - **Managed by a software centre** (Flathub): the package sets
//!   [`UPDATES_MANAGED_ENV`] to `1` (for Flathub,
//!   `--env=INKYCAP_UPDATES_MANAGED=1` in `finish-args`), and no check,
//!   Download or Upgrade is offered. Flatpak can't tell from inside where it
//!   came from, so the package has to say; the bundle from
//!   `scripts/build-flatpak.sh` doesn't set it.
//! - **Flatpak:** a bundle-installed Flatpak can't update itself, and the
//!   plugin must never run inside one: it repackages the `.deb`, so the plugin
//!   would try `dpkg` in the sandbox.
//! - **Repackaged or self-built copies** (NixOS, other distributions, `cargo
//!   build`) may report `.deb` or no installer, and the plugin would then
//!   overwrite the program as if it were an AppImage. So `.deb` and `.rpm`
//!   copies upgrade only when the package manager confirms it owns the running
//!   program.
//! - **AppImages that can't be replaced:** the plugin swaps the file named by
//!   `APPIMAGE`, so only when it exists and its folder is writable. Only
//!   InkyCap's own AppImage build (`scripts/build-appimage.sh`) reports the
//!   AppImage type.
//!
//! ## Feed
//!
//! `updater/<channel>.json` beside the release feed `commands::updates` reads,
//! so `updates.feed_url` moves both (for testing an upgrade privately, or
//! forks). Downloads from another feed must still be signed with the built-in
//! key.
//!
//! ## Privacy
//!
//! Only GET requests to the feed and the download it names; no note content or
//! paths leave the device. Nothing runs without a click.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::utils::config::BundleType;
use tauri::{AppHandle, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::commands::updates::{validate_feed_override, DEFAULT_FEED_URL};
use crate::errors::InkyCapError;

/// Package names InkyCap's installers register with the system package
/// manager. The Tauri bundler derives them from `productName`.
const DEB_PACKAGE: &str = "inky-cap";
const RPM_PACKAGE: &str = "InkyCap";

/// Set to `1` by a package whose updates come from where it was installed.
pub const UPDATES_MANAGED_ENV: &str = "INKYCAP_UPDATES_MANAGED";

/// Whether this copy of InkyCap can upgrade itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpgradeSupport {
    /// Installed by InkyCap's own installer: the Upgrade button works.
    Available,
    /// Running as a Flatpak: updates are installed by hand.
    Flatpak,
    /// Updated by the software centre or package manager it came from, which
    /// is the only way this copy should be updated.
    Managed,
    /// Repackaged, self-built, or an install type with no automatic upgrade.
    Unsupported,
}

/// Whether this copy may upgrade itself. `managed`: the package set
/// [`UPDATES_MANAGED_ENV`]. `program`: what an upgrade replaces (the AppImage
/// file, otherwise the running program). `confirm_linux_install` checks a Linux
/// install with the system (see [`linux_install_confirmed`]).
fn detect_support(
    managed: bool,
    in_flatpak: bool,
    bundle: Option<BundleType>,
    program: &Path,
    confirm_linux_install: impl Fn(BundleType, &Path) -> bool,
) -> UpgradeSupport {
    if managed {
        return UpgradeSupport::Managed;
    }
    if in_flatpak {
        return UpgradeSupport::Flatpak;
    }
    let ok = match bundle {
        Some(kind @ (BundleType::Deb | BundleType::Rpm | BundleType::AppImage)) => {
            confirm_linux_install(kind, program)
        }
        Some(BundleType::Nsis | BundleType::Msi) => true,
        // Also reported for a bare macOS build, so require the program to be
        // inside an application bundle, which is what the updater replaces.
        Some(BundleType::App) => is_inside_app_bundle(program),
        _ => false,
    };
    if ok {
        UpgradeSupport::Available
    } else {
        UpgradeSupport::Unsupported
    }
}

/// `…/Something.app/Contents/MacOS/<program>`.
fn is_inside_app_bundle(exe: &Path) -> bool {
    let mut dirs = exe.ancestors().skip(1);
    let macos = dirs.next().and_then(|d| d.file_name());
    let contents = dirs.next().and_then(|d| d.file_name());
    let bundle = dirs.next().and_then(|d| d.extension());
    macos == Some("MacOS".as_ref())
        && contents == Some("Contents".as_ref())
        && bundle == Some("app".as_ref())
}

/// Ask dpkg or rpm whether one of InkyCap's packages installed `exe`.
fn package_manager_owns(kind: BundleType, exe: &Path) -> bool {
    let run = |program: &str, args: &[&str]| {
        std::process::Command::new(program)
            .args(args)
            .arg(exe)
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
    };
    match kind {
        // Prints "inky-cap: /usr/bin/inkycap" (several packages are comma-separated).
        BundleType::Deb => run("dpkg-query", &["-S"]).is_some_and(|out| {
            out.lines().any(|line| {
                line.split_once(": ")
                    .is_some_and(|(pkgs, _)| pkgs.split(", ").any(|p| p.trim() == DEB_PACKAGE))
            })
        }),
        BundleType::Rpm => run("rpm", &["-qf", "--queryformat", "%{NAME}\n"])
            .is_some_and(|out| out.lines().any(|name| name.trim() == RPM_PACKAGE)),
        _ => false,
    }
}

/// Check a Linux install with the system: dpkg or rpm must own a `.deb` or
/// `.rpm` program, and an AppImage must be a file InkyCap may replace.
fn linux_install_confirmed(kind: BundleType, program: &Path) -> bool {
    match kind {
        BundleType::Deb | BundleType::Rpm => package_manager_owns(kind, program),
        BundleType::AppImage => appimage_is_replaceable(program),
        _ => false,
    }
}

/// Whether the updater can replace `appimage`: it moves the old file aside and
/// writes the new one, so the folder must be writable.
#[cfg(target_os = "linux")]
fn appimage_is_replaceable(appimage: &Path) -> bool {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let Some(folder) = appimage.parent() else {
        return false;
    };
    let Ok(folder) = CString::new(folder.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `folder` is a NUL-terminated path that access() only reads.
    appimage.is_file() && unsafe { libc::access(folder.as_ptr(), libc::W_OK) } == 0
}

#[cfg(not(target_os = "linux"))]
fn appimage_is_replaceable(_appimage: &Path) -> bool {
    false
}

/// Whether this copy can upgrade itself. Upgrade is shown only for `available`;
/// `managed` shows no update controls; otherwise Download.
#[tauri::command]
pub fn upgrade_support() -> UpgradeSupport {
    let bundle = tauri::utils::platform::bundle_type();
    // An AppImage runs from a temporary mount. What an upgrade replaces is the
    // AppImage file itself, which the AppImage runtime names in `APPIMAGE`.
    let program = if matches!(bundle, Some(BundleType::AppImage)) {
        std::env::var_os("APPIMAGE").map(PathBuf::from)
    } else {
        std::env::current_exe().ok()
    };
    let Some(program) = program else {
        return UpgradeSupport::Unsupported;
    };
    detect_support(
        std::env::var_os(UPDATES_MANAGED_ENV).is_some_and(|v| v == "1"),
        std::env::var_os("FLATPAK_ID").is_some(),
        bundle,
        &program,
        linux_install_confirmed,
    )
}

/// The updater feed for a channel: `updater/<channel>.json` next to the
/// release feed.
fn updater_feed_url(release_feed: &str, include_beta: bool) -> Result<Url, InkyCapError> {
    let channel = if include_beta { "beta" } else { "stable" };
    Url::parse(release_feed)
        .and_then(|feed| feed.join(&format!("updater/{channel}.json")))
        .map_err(|e| InkyCapError::BadRequest(format!("invalid update feed URL: {e}")))
}

/// Sort plugin errors into the few cases the user needs to tell apart.
fn classify(err: tauri_plugin_updater::Error) -> InkyCapError {
    use tauri_plugin_updater::Error as E;
    let text = err.to_string();
    match err {
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => InkyCapError::UpgradeNotVerified(text),
        E::TargetNotFound(_) | E::TargetsNotFound(_) | E::UnsupportedArch | E::UnsupportedOs => {
            InkyCapError::UpgradeUnavailable(text)
        }
        E::AuthenticationFailed => InkyCapError::Cancelled,
        E::Reqwest(_) | E::Network(_) | E::ReleaseNotFound => InkyCapError::Network(text),
        _ => InkyCapError::UpgradeFailed(text),
    }
}

/// A downloaded and verified update, waiting for `upgrade_install`.
#[derive(Default)]
pub struct PendingUpgrade(Mutex<Option<(Update, Vec<u8>)>>);

/// Download progress, in bytes. `total` is missing when the server doesn't
/// say how large the file is.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Download the newest release and verify its signature, without installing
/// (the frontend saves open notes, then calls `upgrade_install`). Returns the
/// version.
///
/// `feed_url` is the `updates.feed_url` setting or null. Runs only when
/// [`upgrade_support`] says `available`, which keeps the updater out of Flatpak
/// and repackaged copies.
#[tauri::command]
pub async fn upgrade_download(
    app: AppHandle,
    pending: State<'_, PendingUpgrade>,
    include_beta: bool,
    feed_url: Option<String>,
    on_progress: Channel<DownloadProgress>,
) -> Result<String, InkyCapError> {
    if upgrade_support() != UpgradeSupport::Available {
        return Err(InkyCapError::UpgradeUnavailable(
            "this copy of InkyCap wasn't installed by one of its own installers".into(),
        ));
    }
    let release_feed = match feed_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(url) => validate_feed_override(url)?,
        None => DEFAULT_FEED_URL.to_string(),
    };
    let endpoint = updater_feed_url(&release_feed, include_beta)?;

    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.build())
        .map_err(classify)?
        .check()
        .await
        .map_err(classify)?
        .ok_or_else(|| {
            InkyCapError::UpgradeUnavailable(
                "no newer version is listed for automatic upgrade yet".into(),
            )
        })?;

    // Report roughly every 1% (or 256 KB when the size is unknown), not every
    // network chunk, so the webview isn't flooded with messages.
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let step = total.map_or(256 * 1024, |t| (t / 100).max(1));
                if downloaded - reported >= step || Some(downloaded) == total {
                    reported = downloaded;
                    let _ = on_progress.send(DownloadProgress { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(classify)?;

    let version = update.version.clone();
    *pending
        .0
        .lock()
        .map_err(|_| InkyCapError::UpgradeFailed("internal state unavailable".into()))? =
        Some((update, bytes));
    Ok(version)
}

/// Install what `upgrade_download` fetched. On Linux the system asks for the
/// administrator password; cancelling returns `cancelled`. On Linux and macOS
/// the old version keeps running until `upgrade_restart`; on Windows the
/// installer closes and reopens the app, so this doesn't return.
#[tauri::command]
pub async fn upgrade_install(pending: State<'_, PendingUpgrade>) -> Result<(), InkyCapError> {
    let (update, bytes) = pending
        .0
        .lock()
        .map_err(|_| InkyCapError::UpgradeFailed("internal state unavailable".into()))?
        .take()
        .ok_or_else(|| InkyCapError::UpgradeFailed("no downloaded update to install".into()))?;
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| InkyCapError::UpgradeFailed(e.to_string()))?
        .map_err(classify)
}

/// Restart InkyCap so the newly installed version runs.
#[tauri::command]
pub fn upgrade_restart(app: AppHandle) {
    // Release the single-instance claim first; otherwise the new copy would
    // hand itself to this one and exit, leaving InkyCap closed.
    tauri_plugin_single_instance::destroy(&app);
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn support(
        flatpak: bool,
        bundle: Option<BundleType>,
        exe: &str,
        owned: bool,
    ) -> UpgradeSupport {
        detect_support(false, flatpak, bundle, &PathBuf::from(exe), |_, _| owned)
    }

    #[test]
    fn a_managed_copy_offers_no_update_of_its_own() {
        let managed = |flatpak, bundle| {
            detect_support(
                true,
                flatpak,
                bundle,
                &PathBuf::from("/app/bin/inkycap"),
                |_, _| true,
            )
        };
        assert_eq!(
            managed(true, Some(BundleType::Deb)),
            UpgradeSupport::Managed
        );
        assert_eq!(
            managed(false, Some(BundleType::Deb)),
            UpgradeSupport::Managed
        );
    }

    #[test]
    fn flatpak_never_upgrades_itself_even_though_it_reports_deb() {
        assert_eq!(
            support(true, Some(BundleType::Deb), "/app/bin/inkycap", true),
            UpgradeSupport::Flatpak
        );
    }

    #[test]
    fn linux_packages_upgrade_only_when_the_package_manager_owns_the_program() {
        assert_eq!(
            support(false, Some(BundleType::Deb), "/usr/bin/inkycap", true),
            UpgradeSupport::Available
        );
        assert_eq!(
            support(false, Some(BundleType::Rpm), "/usr/bin/inkycap", true),
            UpgradeSupport::Available
        );
        // nixpkgs unpacks the .deb, so the program says "deb" but dpkg doesn't own it.
        assert_eq!(
            support(
                false,
                Some(BundleType::Deb),
                "/nix/store/abc-inkycap/bin/inkycap",
                false
            ),
            UpgradeSupport::Unsupported
        );
    }

    #[test]
    fn copies_with_no_recorded_installer_do_not_upgrade() {
        assert_eq!(
            support(false, None, "/home/me/InkyCap/target/release/inkycap", true),
            UpgradeSupport::Unsupported
        );
    }

    #[test]
    fn appimages_upgrade_only_when_the_file_can_be_replaced() {
        let appimage = "/home/me/Applications/InkyCap.AppImage";
        assert_eq!(
            support(false, Some(BundleType::AppImage), appimage, true),
            UpgradeSupport::Available
        );
        assert_eq!(
            support(false, Some(BundleType::AppImage), appimage, false),
            UpgradeSupport::Unsupported
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_appimage_is_replaceable_only_as_a_file_in_a_writable_folder() {
        let dir = tempfile::tempdir().unwrap();
        let appimage = dir.path().join("InkyCap.AppImage");
        assert!(!appimage_is_replaceable(&appimage), "missing file");
        std::fs::write(&appimage, b"").unwrap();
        assert!(appimage_is_replaceable(&appimage));
        assert!(!appimage_is_replaceable(dir.path()), "a folder, not a file");
    }

    #[test]
    fn windows_installers_upgrade() {
        assert_eq!(
            support(
                false,
                Some(BundleType::Nsis),
                r"C:\InkyCap\inkycap.exe",
                false
            ),
            UpgradeSupport::Available
        );
        assert_eq!(
            support(
                false,
                Some(BundleType::Msi),
                r"C:\InkyCap\inkycap.exe",
                false
            ),
            UpgradeSupport::Available
        );
    }

    #[test]
    fn macos_upgrades_only_from_inside_an_app_bundle() {
        assert_eq!(
            support(
                false,
                Some(BundleType::App),
                "/Applications/InkyCap.app/Contents/MacOS/inkycap",
                false
            ),
            UpgradeSupport::Available
        );
        assert_eq!(
            support(
                false,
                Some(BundleType::App),
                "/Users/me/InkyCap/target/release/inkycap",
                false
            ),
            UpgradeSupport::Unsupported
        );
    }

    #[test]
    fn updater_feed_sits_next_to_the_release_feed() {
        let url = |feed, beta| updater_feed_url(feed, beta).unwrap().to_string();
        assert_eq!(
            url("https://inkycap.org/releases/latest.json", false),
            "https://inkycap.org/releases/updater/stable.json"
        );
        assert_eq!(
            url("https://inkycap.org/releases/test/latest.json", true),
            "https://inkycap.org/releases/test/updater/beta.json"
        );
    }
}
