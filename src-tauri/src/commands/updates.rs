//! "Is there a newer release?" check.
//!
//! InkyCap does not self-update — installers are downloaded by hand from the
//! releases page. This command asks Codeberg's releases API for the latest
//! published release so the UI can show a "version X is available" notice with
//! a link to the releases page.
//!
//! The check runs in Rust rather than the webview because the Codeberg API
//! sends no CORS headers (a webview `fetch` would be blocked), which also keeps
//! the one outbound call on the backend's narrow surface and lets it carry a
//! `User-Agent`. Per CLAUDE.md security: this sends no note content or
//! filesystem paths — only a GET to a fixed host — and is the module's sole
//! network access. It is invoked only on explicit user action, or on startup if
//! the user opted in (never silently — local-first, no telemetry).

use serde::{Deserialize, Serialize};

use crate::errors::InkyCapError;

/// Latest stable release: the API's `/releases/latest` excludes drafts and
/// pre-releases for us, so this is exactly the stable channel.
const LATEST_STABLE_URL: &str = "https://codeberg.org/api/v1/repos/InkyCap/app/releases/latest";
/// Newest published release of any kind (pre-releases included). Returns an
/// array newest-first; `[0]` is the one we want.
const LATEST_ANY_URL: &str =
    "https://codeberg.org/api/v1/repos/InkyCap/app/releases?limit=1&draft=false";

/// The subset of Codeberg's release JSON we consume.
#[derive(Deserialize)]
struct ApiRelease {
    /// Release tag, e.g. `v26.6.10` (historically also bare `26.6.6`).
    tag_name: String,
    /// Release page URL to open in the browser.
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    prerelease: bool,
}

/// What the frontend needs to show the "update available" notice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRelease {
    /// Version with any leading `v` stripped (e.g. `26.6.10`), for comparison
    /// against the running `app_version`.
    pub version: String,
    /// Release page URL to open in the browser.
    pub url: String,
    /// Release notes (may be empty).
    pub notes: String,
    /// Whether this is a pre-release (beta) build.
    pub is_prerelease: bool,
}

/// Fetch the latest release from Codeberg. With `include_beta`, the newest
/// release of any kind is returned; otherwise only the latest stable one.
///
/// Errors as `InkyCapError::Network` on any transport/HTTP failure so the UI
/// can degrade to "couldn't check" rather than crashing.
#[tauri::command]
pub async fn check_latest_release(include_beta: bool) -> Result<LatestRelease, InkyCapError> {
    let url = if include_beta {
        LATEST_ANY_URL
    } else {
        LATEST_STABLE_URL
    };

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| InkyCapError::Network(e.to_string()))?;
    let res = client
        .get(url)
        // Forgejo/Codeberg rejects requests without a User-Agent.
        .header(reqwest::header::USER_AGENT, "InkyCap")
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| InkyCapError::Network(e.to_string()))?;
    if !res.status().is_success() {
        return Err(InkyCapError::Network(format!(
            "HTTP {}",
            res.status().as_u16()
        )));
    }
    // Parse from text via serde_json (the reqwest `json` feature isn't enabled,
    // and serde_json is already a dependency).
    let text = res
        .text()
        .await
        .map_err(|e| InkyCapError::Network(e.to_string()))?;

    // The stable endpoint returns a single object; the "any" endpoint returns
    // an array (newest first). Accept whichever this call asked for.
    let release: ApiRelease = if include_beta {
        let list: Vec<ApiRelease> = serde_json::from_str(&text)?;
        list.into_iter()
            .next()
            .ok_or_else(|| InkyCapError::Network("no releases found".to_string()))?
    } else {
        serde_json::from_str(&text)?
    };

    Ok(LatestRelease {
        version: release.tag_name.trim_start_matches('v').to_string(),
        url: release.html_url,
        notes: release.body,
        is_prerelease: release.prerelease,
    })
}
