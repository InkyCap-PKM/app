//! OS-accent-color query.
//!
//! Returns the operating system's accent color as `#rrggbb` if a reliable
//! source is available on the current platform, or `None` otherwise. The
//! frontend ("Match OS" accent source) calls this and silently falls back
//! to InkyCap's default when `None` comes back, so callers should treat
//! the result as advisory rather than mandatory.
//!
//! Per-platform sources:
//! - **Windows** — `DwmGetColorizationColor` (the same color the OS uses
//!   for window chrome and "Show accent color on Start, taskbar, and
//!   action center"). Available since Vista.
//! - **macOS** — `NSColor.controlAccentColor` (added in 10.14 Mojave),
//!   converted into the device-RGB space.
//! - **Linux** — best-effort: GNOME 47+ exposes a named accent via
//!   `org.gnome.desktop.interface accent-color`; KDE writes the hex into
//!   `~/.config/kdeglobals`. Other DEs return `None`.

/// Return the OS accent color as `#rrggbb`, or `None` if unavailable on this platform.
#[tauri::command]
pub fn get_os_accent_color() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        windows_accent()
    }
    #[cfg(target_os = "macos")]
    {
        macos_accent()
    }
    #[cfg(target_os = "linux")]
    {
        linux_accent()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

#[cfg(target_os = "windows")]
fn windows_accent() -> Option<String> {
    use windows_sys::Win32::Graphics::Dwm::DwmGetColorizationColor;
    let mut argb: u32 = 0;
    let mut opaque: i32 = 0;
    // SAFETY: both out-pointers are valid stack locals held for the call's
    // duration; the function only writes to them. No threading concerns.
    let hr = unsafe { DwmGetColorizationColor(&mut argb, &mut opaque) };
    if hr < 0 {
        return None;
    }
    // ARGB → RGB. Drop the alpha; user-facing accent is the chroma only.
    let r = (argb >> 16) & 0xFF;
    let g = (argb >> 8) & 0xFF;
    let b = argb & 0xFF;
    Some(format!("#{:02X}{:02X}{:02X}", r, g, b))
}

#[cfg(target_os = "macos")]
fn macos_accent() -> Option<String> {
    use cocoa::appkit::NSColor;
    use cocoa::base::nil;
    use objc::runtime::Class;
    use objc::{msg_send, sel, sel_impl};

    // `NSColor.controlAccentColor` was added in 10.14. Probe at runtime so
    // older macOS doesn't crash; respond `None` if it isn't there.
    let cls = Class::get("NSColor")?;
    let has_method: bool = unsafe {
        let sel = sel!(controlAccentColor);
        msg_send![cls, respondsToSelector: sel]
    };
    if !has_method {
        return None;
    }
    unsafe {
        let accent: cocoa::base::id = NSColor::controlAccentColor(nil);
        // Convert into a device-RGB space so the channel getters return
        // sRGB-ish values; the system color may be in a named space that
        // raises if we read components directly.
        let rgb_space = {
            let cls = Class::get("NSColorSpace")?;
            let space: cocoa::base::id = msg_send![cls, deviceRGBColorSpace];
            space
        };
        let color: cocoa::base::id = msg_send![accent, colorUsingColorSpace: rgb_space];
        if color == nil {
            return None;
        }
        let r: f64 = msg_send![color, redComponent];
        let g: f64 = msg_send![color, greenComponent];
        let b: f64 = msg_send![color, blueComponent];
        let to_byte = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u32;
        Some(format!(
            "#{:02X}{:02X}{:02X}",
            to_byte(r),
            to_byte(g),
            to_byte(b)
        ))
    }
}

#[cfg(target_os = "linux")]
fn linux_accent() -> Option<String> {
    gnome_accent().or_else(kde_accent)
}

#[cfg(target_os = "linux")]
fn gnome_accent() -> Option<String> {
    use std::process::Command;
    // GNOME 47+ exposes the accent as a named color string. Older GNOME
    // versions don't have this key and `gsettings` exits non-zero — we
    // map both to `None`.
    let output = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "accent-color"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8(output.stdout).ok()?;
    let name = raw
        .trim()
        .trim_matches('\'')
        .trim_matches('"')
        .to_lowercase();
    // Hex map of GNOME's named accents (from libadwaita's accent palette).
    // Kept inline rather than as a constant table because the list is small
    // and the only caller is right here.
    let hex = match name.as_str() {
        "blue" => "#3584E4",
        "teal" => "#2190A4",
        "green" => "#3A944A",
        "yellow" => "#C88800",
        "orange" => "#ED5B00",
        "red" => "#E62D42",
        "pink" => "#D56199",
        "purple" => "#9141AC",
        "slate" => "#6F8396",
        _ => return None,
    };
    Some(hex.to_string())
}

#[cfg(target_os = "linux")]
fn kde_accent() -> Option<String> {
    // KDE Plasma stores the accent under `[General]` → `AccentColor` as
    // either a hex string ("#rrggbb") or three comma-separated decimals
    // ("r,g,b"). Both forms appear in the wild; handle both.
    let path = dirs::config_dir()?.join("kdeglobals");
    let contents = std::fs::read_to_string(path).ok()?;
    let mut in_general = false;
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_general = line.eq_ignore_ascii_case("[General]");
            continue;
        }
        if !in_general {
            continue;
        }
        if let Some(rest) = line.strip_prefix("AccentColor=") {
            let v = rest.trim();
            if v.starts_with('#') && (v.len() == 7 || v.len() == 4) {
                return Some(v.to_string());
            }
            // "r,g,b" form
            let parts: Vec<&str> = v.split(',').map(str::trim).collect();
            if parts.len() == 3 {
                let r = parts[0].parse::<u32>().ok()?;
                let g = parts[1].parse::<u32>().ok()?;
                let b = parts[2].parse::<u32>().ok()?;
                if r <= 255 && g <= 255 && b <= 255 {
                    return Some(format!("#{:02X}{:02X}{:02X}", r, g, b));
                }
            }
            return None;
        }
    }
    None
}
