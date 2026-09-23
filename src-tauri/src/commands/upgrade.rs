//! The in-app Upgrade: download, verify and install a newer release.
//!
//! The Tauri updater plugin does the work. It reads a feed listing one
//! installer per platform, picks the one matching how this copy was installed,
//! refuses any download not signed with the public key in tauri.conf.json, and
//! runs the system installer (`pkexec dpkg`/`rpm` on Linux, the NSIS or MSI
//! installer on Windows, replacing the `.app` on macOS). This module decides
//! whether this copy may upgrade itself at all, points the plugin at the right
//! feed, reports download progress, and restarts the app afterwards.
//!
//! ## Which copies may upgrade themselves
//!
//! Only copies installed by one of InkyCap's own installers (see
//! [`detect_support`]). Everything else keeps the Download button only:
//!
//! - **Flatpak:** a Flatpak installed from a bundle file cannot update itself,
//!   and the plugin must never run inside it: the Flatpak repackages the
//!   `.deb`, so the plugin would believe it is a `.deb` install and try `dpkg`
//!   inside the sandbox.
//! - **Repackaged or self-built copies** (NixOS, other distributions, `cargo
//!   build`): these may still report `.deb` (nixpkgs builds a `.deb` and
//!   unpacks it) or no installer at all, in which case the plugin would
//!   overwrite the running program as if it were an AppImage. So a Linux copy
//!   upgrades itself only when the system's package manager confirms it owns
//!   the running program.
//!
//! ## Where the feed comes from
//!
//! `updater/<channel>.json` in the same folder as the release feed that
//! `commands::updates` reads, so the advanced `updates.feed_url` setting
//! points both at another folder (used to test an upgrade privately, and by
//! forks). A redirected feed is still only trusted if its downloads are signed
//! with the key built into this copy.
//!
//! ## Privacy
//!
//! Per CLAUDE.md security: only GETs to the feed and the download it names;
//! no note content or paths leave the device. Nothing runs without a click.

use std::path::Path;
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

/// Whether this copy of InkyCap can upgrade itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpgradeSupport {
    /// Installed by InkyCap's own installer: the Upgrade button works.
    Available,
    /// Running as a Flatpak: updates are installed by hand.
    Flatpak,
    /// Repackaged, self-built, or an install type with no automatic upgrade.
    Unsupported,
}

/// Decide whether this copy may upgrade itself. `owned_by_package` asks the
/// Linux package manager whether it installed the running program.
fn detect_support(
    in_flatpak: bool,
    bundle: Option<BundleType>,
    exe: &Path,
    owned_by_package: impl Fn(BundleType, &Path) -> bool,
) -> UpgradeSupport {
    if in_flatpak {
        return UpgradeSupport::Flatpak;
    }
    let ok = match bundle {
        Some(kind @ (BundleType::Deb | BundleType::Rpm)) => owned_by_package(kind, exe),
        Some(BundleType::Nsis | BundleType::Msi) => true,
        // Also reported for a bare macOS build, so require the program to be
        // inside an application bundle, which is what the updater replaces.
        Some(BundleType::App) => is_inside_app_bundle(exe),
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

/// Whether this copy can upgrade itself. The frontend shows the Upgrade button
/// only for `available`; the Download button is shown in every case.
#[tauri::command]
pub fn upgrade_support() -> UpgradeSupport {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(_) => return UpgradeSupport::Unsupported,
    };
    detect_support(
        std::env::var_os("FLATPAK_ID").is_some(),
        tauri::utils::platform::bundle_type(),
        &exe,
        package_manager_owns,
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

/// Download the newest release for this system and verify its signature.
/// Nothing is installed yet: the frontend saves open notes, then calls
/// `upgrade_install`. Returns the version downloaded.
///
/// `feed_url` is the advanced `updates.feed_url` setting (or null). Refuses
/// to run unless [`upgrade_support`] says `available`, which is what keeps the
/// updater from ever running inside the Flatpak or on a repackaged copy.
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

/// Install the update `upgrade_download` fetched. On Linux this asks for the
/// administrator password (the system's own prompt); cancelling it returns
/// the `cancelled` error. On Linux and macOS the app keeps running the old
/// version until `upgrade_restart`; on Windows the installer closes the app
/// and reopens it when done, so this call does not return.
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
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn support(
        flatpak: bool,
        bundle: Option<BundleType>,
        exe: &str,
        owned: bool,
    ) -> UpgradeSupport {
        detect_support(flatpak, bundle, &PathBuf::from(exe), |_, _| owned)
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
        assert_eq!(
            support(
                false,
                Some(BundleType::AppImage),
                "/tmp/InkyCap.AppImage",
                true
            ),
            UpgradeSupport::Unsupported
        );
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
