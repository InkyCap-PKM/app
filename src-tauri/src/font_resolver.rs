//! Resolve a `FontChoice` to a concrete font family name.
//!
//! Roles:
//! - Interface / Editor — used on the frontend (CSS). Editor's "follow"
//!   mode resolves to Interface's resolved value.
//! - Monospace / Text / Verse — used in compiled Typst output. Verse's
//!   "follow" mode resolves to Text's resolved value. Text's
//!   "typst-default" mode resolves to None, signalling the caller to
//!   omit `#set text(font: ...)` and let Typst pick.
//!
//! The OS-defaults lookup runs once per process via `OnceLock`. The
//! values it returns are concrete family names (e.g. "Cantarell",
//! "Segoe UI", ".AppleSystemUIFont"). They reflect what fontconfig /
//! the OS reports at the time of the first call; rarely changes during
//! a session.

use std::sync::OnceLock;

use serde::Serialize;

use crate::settings::{FontChoice, FontSettings};

/// Family name shipped as InkyCap's "bundled" option per role.
/// Bumping this requires updating both this constant and the
/// `src-tauri/assets/fonts/` bundle.
pub const BUNDLED_INTERFACE: &str = "Inter";
pub const BUNDLED_TEXT: &str = "Junicode";
pub const BUNDLED_MONO: &str = "JuliaMono";
pub const BUNDLED_VERSE: &str = "iA Writer Duo S";

/// Cached OS defaults. Resolved lazily on first call.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SystemFontDefaults {
    pub sans: String,
    pub serif: String,
    pub mono: String,
}

static SYSTEM_DEFAULTS: OnceLock<SystemFontDefaults> = OnceLock::new();

pub fn system_defaults() -> &'static SystemFontDefaults {
    SYSTEM_DEFAULTS.get_or_init(resolve_system_defaults)
}

#[cfg(target_os = "linux")]
fn resolve_system_defaults() -> SystemFontDefaults {
    // GNOME (and many GNOME-derived DEs) stores the user's UI/mono
    // font preference in dconf and doesn't propagate it into
    // fontconfig — so `fc-match sans-serif` on a system where the
    // user picked Inter in Tweaks still returns the distro's generic
    // "Noto Sans". Prefer gsettings when available, then fall through
    // to fontconfig.
    let sans = gsettings_font("org.gnome.desktop.interface", "font-name")
        .or_else(|| fc_match("sans-serif"))
        .unwrap_or_else(|| "DejaVu Sans".into());
    let mono = gsettings_font("org.gnome.desktop.interface", "monospace-font-name")
        .or_else(|| fc_match("monospace"))
        .unwrap_or_else(|| "DejaVu Sans Mono".into());
    // GNOME has no dedicated serif preference; fontconfig's alias
    // resolution is the right answer here.
    let serif = fc_match("serif").unwrap_or_else(|| "DejaVu Serif".into());
    SystemFontDefaults { sans, serif, mono }
}

#[cfg(target_os = "linux")]
fn fc_match(alias: &str) -> Option<String> {
    let output = std::process::Command::new("fc-match")
        .args(["-f", "%{family[0]}", alias])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Read a font family from a gsettings key. The value comes back as a
/// quoted GVariant string like `'Inter Variable 11'` — strip the outer
/// quotes and the trailing point-size token to get the bare family
/// name. Returns `None` if gsettings isn't on the PATH, the schema
/// isn't installed (non-GNOME systems), or the value is empty.
#[cfg(target_os = "linux")]
fn gsettings_font(schema: &str, key: &str) -> Option<String> {
    let output = std::process::Command::new("gsettings")
        .args(["get", schema, key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let trimmed = raw.trim();
    // Strip GVariant string quotes (single or double).
    let unquoted = trimmed
        .trim_start_matches('\'')
        .trim_end_matches('\'')
        .trim_start_matches('"')
        .trim_end_matches('"')
        .trim();
    if unquoted.is_empty() {
        return None;
    }
    // GNOME font preferences are `<family> <size>`; the size token is
    // a trailing positive integer. Drop it if present.
    let family = match unquoted.rsplit_once(' ') {
        Some((head, tail)) if tail.chars().all(|c| c.is_ascii_digit()) => head.trim(),
        _ => unquoted,
    };
    if family.is_empty() {
        None
    } else {
        Some(family.to_string())
    }
}

#[cfg(target_os = "macos")]
fn resolve_system_defaults() -> SystemFontDefaults {
    SystemFontDefaults {
        sans: "SF Pro Text".into(),
        serif: "New York".into(),
        mono: "SF Mono".into(),
    }
}

#[cfg(target_os = "windows")]
fn resolve_system_defaults() -> SystemFontDefaults {
    SystemFontDefaults {
        sans: "Segoe UI".into(),
        serif: "Cambria".into(),
        mono: "Consolas".into(),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn resolve_system_defaults() -> SystemFontDefaults {
    SystemFontDefaults {
        sans: "sans-serif".into(),
        serif: "serif".into(),
        mono: "monospace".into(),
    }
}

#[derive(Debug, Clone, Copy)]
pub enum FontRole {
    Interface,
    Editor,
    Monospace,
    Text,
    Verse,
}

/// Bundled family name for a role, if InkyCap ships one.
fn role_bundled(role: FontRole) -> Option<&'static str> {
    match role {
        FontRole::Interface | FontRole::Editor => Some(BUNDLED_INTERFACE),
        FontRole::Monospace => Some(BUNDLED_MONO),
        FontRole::Text => Some(BUNDLED_TEXT),
        FontRole::Verse => Some(BUNDLED_VERSE),
    }
}

fn role_system(role: FontRole, sys: &SystemFontDefaults) -> &str {
    match role {
        FontRole::Interface | FontRole::Editor => &sys.sans,
        FontRole::Monospace => &sys.mono,
        FontRole::Text | FontRole::Verse => &sys.serif,
    }
}

/// Resolve a single role to a concrete family name.
///
/// Returns `None` only for the text role when set to "typst-default",
/// signalling that the caller should omit the `#set text(font: ...)`
/// injection entirely.
pub fn resolve_role(role: FontRole, fonts: &FontSettings) -> Option<String> {
    let choice = match role {
        FontRole::Interface => &fonts.interface,
        FontRole::Editor => &fonts.editor,
        FontRole::Monospace => &fonts.monospace,
        FontRole::Text => &fonts.text,
        FontRole::Verse => &fonts.verse,
    };

    match choice.mode.as_str() {
        FontChoice::SYSTEM => Some(role_system(role, system_defaults()).to_string()),
        FontChoice::BUNDLED => Some(
            role_bundled(role)
                .map(str::to_string)
                .unwrap_or_else(|| role_system(role, system_defaults()).to_string()),
        ),
        FontChoice::TYPST_DEFAULT => None,
        FontChoice::FOLLOW => match role {
            FontRole::Editor => resolve_role(FontRole::Interface, fonts),
            FontRole::Verse => resolve_role(FontRole::Text, fonts),
            // Other roles don't support "follow"; fall back to system.
            _ => Some(role_system(role, system_defaults()).to_string()),
        },
        FontChoice::CUSTOM => {
            let trimmed = choice.custom.trim();
            if trimmed.is_empty() {
                Some(role_system(role, system_defaults()).to_string())
            } else {
                Some(trimmed.to_string())
            }
        }
        // Unknown mode falls back to system.
        _ => Some(role_system(role, system_defaults()).to_string()),
    }
}

/// Pre-resolved values for every role, convenient for shipping to the
/// frontend and for the compile path.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedFonts {
    pub interface: String,
    pub editor: String,
    pub monospace: String,
    pub text: Option<String>,
    pub verse: Option<String>,
}

pub fn resolve_all(fonts: &FontSettings) -> ResolvedFonts {
    let sys = system_defaults();
    ResolvedFonts {
        interface: resolve_role(FontRole::Interface, fonts).unwrap_or_else(|| sys.sans.clone()),
        editor: resolve_role(FontRole::Editor, fonts).unwrap_or_else(|| sys.sans.clone()),
        monospace: resolve_role(FontRole::Monospace, fonts).unwrap_or_else(|| sys.mono.clone()),
        text: resolve_role(FontRole::Text, fonts),
        verse: resolve_role(FontRole::Verse, fonts),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_resolves_to_bundled_family() {
        let fonts = FontSettings {
            text: FontChoice::bundled(),
            ..Default::default()
        };
        assert_eq!(
            resolve_role(FontRole::Text, &fonts).as_deref(),
            Some(BUNDLED_TEXT)
        );
    }

    #[test]
    fn typst_default_returns_none_for_text() {
        let fonts = FontSettings {
            text: FontChoice {
                mode: FontChoice::TYPST_DEFAULT.into(),
                custom: String::new(),
            },
            ..Default::default()
        };
        assert_eq!(resolve_role(FontRole::Text, &fonts), None);
    }

    #[test]
    fn default_compile_roles_are_all_embedded() {
        // The out-of-box config must keep every role that's injected into the
        // Typst compile (text, verse, monospace) on a bundled/embedded family,
        // so a fresh install renders identically on every OS and never needs the
        // system font collection just to draw a default note. interface/editor
        // are frontend CSS and intentionally still system; they're not asserted
        // here (and resolving them would invoke the OS-dependent defaults).
        let fonts = FontSettings::default();
        assert_eq!(
            resolve_role(FontRole::Text, &fonts).as_deref(),
            Some(BUNDLED_TEXT)
        );
        assert_eq!(
            resolve_role(FontRole::Monospace, &fonts).as_deref(),
            Some(BUNDLED_MONO),
            "default monospace must be bundled, not a system font"
        );
        // Verse follows text, so it lands on the bundled text family too.
        assert_eq!(
            resolve_role(FontRole::Verse, &fonts).as_deref(),
            Some(BUNDLED_TEXT)
        );
    }

    #[test]
    fn verse_follow_inherits_text() {
        let fonts = FontSettings {
            text: FontChoice::custom("CustomSerif"),
            verse: FontChoice::follow(),
            ..Default::default()
        };
        assert_eq!(
            resolve_role(FontRole::Verse, &fonts).as_deref(),
            Some("CustomSerif"),
        );
    }

    #[test]
    fn custom_empty_falls_back_to_system() {
        let fonts = FontSettings {
            text: FontChoice::custom(""),
            ..Default::default()
        };
        // Doesn't panic; returns system serif (whatever it is).
        assert!(resolve_role(FontRole::Text, &fonts).is_some());
    }
}
