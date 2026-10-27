//! Checks whether a newer release exists, so the UI can offer it with download
//! links. Installing in place (Upgrade) is `commands::upgrade`, which reads its
//! own signed feed from the same folder.
//!
//! ## Source
//!
//! A **release feed**: a small static JSON file on InkyCap's host
//! (`DEFAULT_FEED_URL`). The feed says which forge hosts the releases and
//! supplies the release and download links, so moving forges means changing one
//! file, not releasing the app. If the feed can't be reached, the forge's
//! releases API (`FALLBACK_FORGE_API`) is asked directly.
//!
//! ## Privacy and safety
//!
//! Only a GET to a fixed host, with no note content or paths; this module's only
//! network access. Runs only when the user asks, or at startup if they opted in.
//! In Rust because neither host sends CORS headers, and so it can send a
//! `User-Agent`. Every URL returned is checked to be `http(s)` before reaching
//! the frontend, which passes it to the OS URL opener.

use serde::{Deserialize, Serialize};

use crate::errors::InkyCapError;

/// InkyCap's release feed, written at each release by
/// `scripts/release-feeds.mjs` (format in `scripts/release/feeds.mjs`).
pub(crate) const DEFAULT_FEED_URL: &str = "https://inkycap.org/releases/latest.json";

/// Forge releases API used when the feed is unreachable. This is the API root
/// for one repository; the channel endpoints hang off it.
const FALLBACK_FORGE_API: &str = "https://codefloe.com/api/v1/repos/InkyCap/app";

/// Links used when neither source supplies one.
const DEFAULT_RELEASES_URL: &str = "https://codefloe.com/InkyCap/app/releases";
const DEFAULT_DOWNLOAD_URL: &str = "https://inkycap.org/download";

/// The only feed schema this build reads. A breaking change must use a new URL
/// and leave schema 1 at `DEFAULT_FEED_URL`, or installed builds stop checking.
const SUPPORTED_SCHEMA: u32 = 1;

/// What the frontend needs to show the "update available" notice.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LatestRelease {
    /// Version with any leading `v` stripped (e.g. `26.6.10`), for comparison
    /// against the running `app_version`.
    pub version: String,
    /// This release's own page, to open in the browser.
    pub url: String,
    /// Release notes (may be empty).
    pub notes: String,
    /// Whether this is a pre-release (beta) build.
    pub is_prerelease: bool,
    /// Where all releases are listed ("View releases").
    pub releases_url: String,
    /// Where users download installers ("Download").
    pub download_url: String,
}

// ── The release feed (preferred source) ──────────────────────────────

/// InkyCap's static release manifest. Unknown fields are ignored so the file
/// can gain optional keys without breaking older builds.
#[derive(Deserialize)]
struct Feed {
    #[serde(default)]
    schema: u32,
    #[serde(default)]
    releases_url: Option<String>,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    channels: FeedChannels,
}

#[derive(Deserialize, Default)]
struct FeedChannels {
    #[serde(default)]
    stable: Option<FeedRelease>,
    #[serde(default)]
    beta: Option<FeedRelease>,
}

#[derive(Deserialize)]
struct FeedRelease {
    version: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    notes: String,
}

impl Feed {
    /// The release to offer: stable only by default; with `include_beta`,
    /// whichever channel is newer (a beta isn't always ahead: `26.6.9` beta
    /// predates `26.6.10` stable).
    fn choose(&self, include_beta: bool) -> Option<(&FeedRelease, bool)> {
        let stable = self.channels.stable.as_ref();
        if !include_beta {
            return stable.map(|r| (r, false));
        }
        match (stable, self.channels.beta.as_ref()) {
            (Some(s), Some(b)) => {
                if version_key(&b.version) > version_key(&s.version) {
                    Some((b, true))
                } else {
                    Some((s, false))
                }
            }
            (Some(s), None) => Some((s, false)),
            (None, Some(b)) => Some((b, true)),
            (None, None) => None,
        }
    }
}

/// Turn feed JSON into a `LatestRelease`, or explain why it can't be used.
fn parse_feed(text: &str, include_beta: bool) -> Result<LatestRelease, InkyCapError> {
    let feed: Feed = serde_json::from_str(text)?;
    if feed.schema != SUPPORTED_SCHEMA {
        return Err(InkyCapError::Network(format!(
            "unsupported release feed schema {} (this build understands {SUPPORTED_SCHEMA})",
            feed.schema
        )));
    }

    let releases_url = web_url(feed.releases_url.as_deref()).unwrap_or(DEFAULT_RELEASES_URL.into());
    let download_url = web_url(feed.download_url.as_deref()).unwrap_or(DEFAULT_DOWNLOAD_URL.into());

    let (release, is_prerelease) = feed
        .choose(include_beta)
        .ok_or_else(|| InkyCapError::Network("release feed lists no releases".to_string()))?;

    Ok(LatestRelease {
        version: normalize_version(&release.version),
        url: web_url(release.url.as_deref()).unwrap_or_else(|| releases_url.clone()),
        notes: release.notes.clone(),
        is_prerelease,
        releases_url,
        download_url,
    })
}

// ── The forge releases API (fallback source) ─────────────────────────

/// The subset of Forgejo's (CodeFloe's) release JSON we consume.
#[derive(Deserialize)]
struct ForgeRelease {
    /// Release tag, e.g. `v26.6.10` (historically also bare `26.6.6`).
    tag_name: String,
    /// Release page URL to open in the browser.
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    prerelease: bool,
}

/// The endpoint for a channel's newest release. `/releases/latest` excludes
/// drafts and pre-releases, so it is the stable channel; the list endpoint is
/// newest-first, so `[0]` is the newest of any kind.
fn forge_url(api_base: &str, include_beta: bool) -> String {
    let base = api_base.trim_end_matches('/');
    if include_beta {
        format!("{base}/releases?limit=1&draft=false")
    } else {
        format!("{base}/releases/latest")
    }
}

/// Turn forge JSON into a `LatestRelease`. The stable endpoint returns a single
/// object and the list endpoint an array, so the shape depends on the request.
fn parse_forge(text: &str, include_beta: bool) -> Result<LatestRelease, InkyCapError> {
    let release: ForgeRelease = if include_beta {
        let list: Vec<ForgeRelease> = serde_json::from_str(text)?;
        list.into_iter()
            .next()
            .ok_or_else(|| InkyCapError::Network("no releases found".to_string()))?
    } else {
        serde_json::from_str(text)?
    };

    Ok(LatestRelease {
        version: normalize_version(&release.tag_name),
        url: web_url(Some(&release.html_url)).unwrap_or(DEFAULT_RELEASES_URL.into()),
        notes: release.body,
        is_prerelease: release.prerelease,
        releases_url: DEFAULT_RELEASES_URL.to_string(),
        download_url: DEFAULT_DOWNLOAD_URL.to_string(),
    })
}

// ── Shared helpers ───────────────────────────────────────────────────

/// Drop a leading `v` so `v26.6.10` and `26.6.10` compare alike.
fn normalize_version(tag: &str) -> String {
    tag.trim().trim_start_matches('v').to_string()
}

/// Sort key for a `YY.MM.RELEASE` version. Missing or non-numeric parts count
/// as 0, so a malformed version sorts oldest rather than blowing up.
fn version_key(version: &str) -> (u32, u32, u32) {
    let version = normalize_version(version);
    let mut parts = version.split('.').map(|p| p.parse::<u32>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// Accept only `http(s)` URLs: the frontend passes them to the OS opener, and
/// the feed is remote data.
fn web_url(url: Option<&str>) -> Option<String> {
    let url = url?.trim();
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        Some(url.to_string())
    } else {
        None
    }
}

/// A user feed URL, rejected unless `https`: it points the check at a third
/// party, and cleartext would let a network attacker choose the download link
/// shown.
pub(crate) fn validate_feed_override(url: &str) -> Result<String, InkyCapError> {
    let url = url.trim();
    if url.to_ascii_lowercase().starts_with("https://") && url.len() > "https://".len() {
        Ok(url.to_string())
    } else {
        Err(InkyCapError::Network(format!(
            "update feed URL must start with https:// (got {url})"
        )))
    }
}

/// GET a URL as text. Both hosts reject requests without a `User-Agent`.
async fn get_text(url: &str) -> Result<String, InkyCapError> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| InkyCapError::Network(e.to_string()))?;
    let res = client
        .get(url)
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
    res.text()
        .await
        .map_err(|e| InkyCapError::Network(e.to_string()))
}

// ── The command ──────────────────────────────────────────────────────

/// Fetch the latest release; `include_beta` includes pre-releases. `feed_url`
/// replaces the default feed (`settings.updates.feed_url`), and then the forge
/// fallback is skipped, so a redirected check never reaches InkyCap's hosts.
/// Any failure is `InkyCapError::Network`, so the UI can say "couldn't check".
#[tauri::command]
pub async fn check_latest_release(
    include_beta: bool,
    feed_url: Option<String>,
) -> Result<LatestRelease, InkyCapError> {
    let override_url = feed_url.as_deref().map(str::trim).filter(|u| !u.is_empty());
    let feed = match override_url {
        Some(u) => validate_feed_override(u)?,
        None => DEFAULT_FEED_URL.to_string(),
    };

    let feed_err = match get_text(&feed).await {
        Ok(text) => match parse_feed(&text, include_beta) {
            Ok(release) => return Ok(release),
            Err(e) => e,
        },
        Err(e) => e,
    };

    if override_url.is_some() {
        return Err(feed_err);
    }

    // Feed unreachable or unusable: ask the forge directly.
    match get_text(&forge_url(FALLBACK_FORGE_API, include_beta)).await {
        Ok(text) => parse_forge(&text, include_beta),
        // Report the feed's failure — it is the source that was meant to work.
        Err(_) => Err(feed_err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = r#"{
        "schema": 1,
        "releases_url": "https://codeberg.org/InkyCap/app/releases",
        "download_url": "https://inkycap.org/download",
        "channels": {
            "stable": {
                "version": "26.6.10",
                "url": "https://codeberg.org/InkyCap/app/releases/tag/v26.6.10",
                "notes": "Stable notes"
            },
            "beta": {
                "version": "26.7.1",
                "url": "https://codeberg.org/InkyCap/app/releases/tag/v26.7.1",
                "notes": "Beta notes"
            }
        }
    }"#;

    #[test]
    fn feed_stable_channel_ignores_beta() {
        let r = parse_feed(FEED, false).unwrap();
        assert_eq!(r.version, "26.6.10");
        assert!(!r.is_prerelease);
        assert_eq!(r.notes, "Stable notes");
        assert_eq!(r.download_url, "https://inkycap.org/download");
    }

    #[test]
    fn feed_beta_channel_takes_the_newer_of_the_two() {
        let r = parse_feed(FEED, true).unwrap();
        assert_eq!(r.version, "26.7.1");
        assert!(r.is_prerelease);
    }

    #[test]
    fn feed_beta_channel_keeps_stable_when_stable_is_newer() {
        // A beta from earlier in the month must not look like an update.
        let feed = FEED.replace("26.7.1", "26.6.9");
        let r = parse_feed(&feed, true).unwrap();
        assert_eq!(r.version, "26.6.10");
        assert!(!r.is_prerelease);
    }

    #[test]
    fn feed_tolerates_a_missing_beta_channel() {
        let feed = r#"{"schema":1,"channels":{"stable":{"version":"v26.6.10"}}}"#;
        let r = parse_feed(feed, true).unwrap();
        assert_eq!(r.version, "26.6.10");
        // Links fall back to the built-in defaults when the feed omits them.
        assert_eq!(r.releases_url, DEFAULT_RELEASES_URL);
        assert_eq!(r.url, DEFAULT_RELEASES_URL);
    }

    #[test]
    fn feed_with_an_unknown_schema_is_refused() {
        let feed = FEED.replace("\"schema\": 1", "\"schema\": 2");
        assert!(parse_feed(&feed, false).is_err());
    }

    #[test]
    fn feed_urls_that_are_not_web_urls_are_dropped() {
        let feed = FEED.replace("https://inkycap.org/download", "javascript:alert(1)");
        let r = parse_feed(&feed, false).unwrap();
        assert_eq!(r.download_url, DEFAULT_DOWNLOAD_URL);
    }

    #[test]
    fn forge_stable_response_parses() {
        let json = r#"{"tag_name":"v26.6.10","html_url":"https://codeberg.org/x/y/releases/tag/v26.6.10","body":"notes","prerelease":false}"#;
        let r = parse_forge(json, false).unwrap();
        assert_eq!(r.version, "26.6.10");
        assert_eq!(r.notes, "notes");
        assert!(!r.is_prerelease);
    }

    #[test]
    fn forge_beta_response_is_a_list() {
        let json = r#"[{"tag_name":"26.7.1","html_url":"https://codeberg.org/x/y/releases/tag/26.7.1","prerelease":true}]"#;
        let r = parse_forge(json, true).unwrap();
        assert_eq!(r.version, "26.7.1");
        assert!(r.is_prerelease);
        assert_eq!(r.notes, "");
    }

    #[test]
    fn forge_urls_pick_the_right_endpoint() {
        assert_eq!(
            forge_url("https://host/api/v1/repos/o/r/", false),
            "https://host/api/v1/repos/o/r/releases/latest"
        );
        assert!(forge_url("https://host/api/v1/repos/o/r", true).contains("limit=1"));
    }

    #[test]
    fn feed_override_must_be_https() {
        assert!(validate_feed_override("https://example.org/latest.json").is_ok());
        assert!(validate_feed_override("http://example.org/latest.json").is_err());
        assert!(validate_feed_override("file:///tmp/latest.json").is_err());
        assert!(validate_feed_override("  ").is_err());
    }

    #[test]
    fn version_key_orders_by_component_not_string() {
        assert!(version_key("26.6.10") > version_key("26.6.9"));
        assert!(version_key("26.10.1") > version_key("26.6.1"));
        assert_eq!(version_key("v26.6.10"), version_key("26.6.10"));
        assert_eq!(version_key("nonsense"), (0, 0, 0));
    }
}
