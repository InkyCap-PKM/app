// Persists window geometry across launches.
//
// Why the custom implementation (replacing tauri-plugin-window-state):
//
// 1. The plugin saves geometry on every WindowEvent::Resized, gated by
//    is_maximized(). On Linux/GTK, maximize transitions fire Resized
//    with monitor-covering dimensions *before* is_maximized() flips,
//    so it writes maximized-sized values as the unmaximized geometry.
// 2. Tao/GTK exposes `inner_size()` as the GDK window size reported by
//    `configure-event`, which on GNOME *includes* the client-side
//    decoration shadow margin (~52×99 logical px). `set_inner_size()`
//    however calls `gtk_window.resize()` with the content size. Round-
//    tripping save(inner_size) -> load(set_inner_size) therefore
//    inflates the window by the shadow delta on every cycle — it
//    eventually exceeds the monitor and GNOME auto-maximizes it.
//
// Fix: measure the decoration delta once per session by comparing the
// first-known requested size to what `configure-event` reports, then
// save (reported - delta) and restore via `set_inner_size(saved)`.
// After one round-trip the window size is stable.

use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, WindowEvent,
};

const FILENAME: &str = "window-state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 800,
            x: 0,
            y: 0,
            maximized: false,
        }
    }
}

/// tauri.conf.json's main window default size, in logical pixels.
/// Kept in sync manually with the config so we can compute the
/// physical size of the initial configure-event and learn the CSD
/// shadow delta from it. If the value in tauri.conf.json changes,
/// update here too.
const TAURI_CONF_DEFAULT_LOGICAL: (f64, f64) = (1280.0, 800.0);

pub struct WindowStateStore {
    pub state: Mutex<WindowState>,
    /// Decoration shadow delta in physical pixels, learned on the
    /// first Resized event after the window maps.
    /// `(reported - expected_initial_physical)`. None until measured.
    pub delta: Mutex<Option<(u32, u32)>>,
    /// tauri.conf.json default × scale_factor at startup, in
    /// physical pixels. The first configure-event always fires at
    /// this size plus the CSD shadow — that's where `delta` comes
    /// from. Stored here so the handler has access without needing
    /// to re-read config or scale.
    pub initial_expected: (u32, u32),
}

impl WindowStateStore {
    pub fn new(state: WindowState, initial_expected: (u32, u32)) -> Self {
        Self {
            state: Mutex::new(state),
            delta: Mutex::new(None),
            initial_expected,
        }
    }
}

pub fn conf_default_physical(scale: f64) -> (u32, u32) {
    (
        (TAURI_CONF_DEFAULT_LOGICAL.0 * scale).round() as u32,
        (TAURI_CONF_DEFAULT_LOGICAL.1 * scale).round() as u32,
    )
}

fn state_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join(FILENAME))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Option<WindowState> {
    let path = state_path(app)?;
    let bytes = fs::read(&path).ok()?;
    let s: WindowState = serde_json::from_slice(&bytes).ok()?;
    // A zero-sized save means something went wrong last session.
    // Ignore it and fall back to defaults.
    if s.width < 200 || s.height < 200 {
        return None;
    }
    Some(s)
}

pub fn save<R: Runtime>(app: &AppHandle<R>, state: &WindowState) {
    let Some(path) = state_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(state) {
        let _ = fs::write(path, bytes);
    }
}

/// Apply saved geometry (or a sensible default for a fresh install)
/// to the window. Must be called AFTER `window.show()` — on Linux/GTK
/// `set_inner_size` is only reliable on a mapped window. Also records
/// the requested size into `WindowStateStore.awaiting_set` so the
/// event handler can measure the CSD shadow delta from the resulting
/// configure-event.
pub fn apply<R: Runtime>(window: &WebviewWindow<R>, saved: Option<&WindowState>) {
    let scale = window.scale_factor().unwrap_or(1.0);

    if let Some(s) = saved {
        if let Ok(monitors) = window.available_monitors() {
            let pos = PhysicalPosition { x: s.x, y: s.y };
            let in_bounds = monitors.iter().any(|m| {
                let mp = m.position();
                let ms = m.size();
                pos.x >= mp.x
                    && pos.x < mp.x + ms.width as i32
                    && pos.y >= mp.y
                    && pos.y < mp.y + ms.height as i32
            });
            if in_bounds {
                let _ = window.set_position(pos);
            }
        }
    }

    // Target: saved content size if sane, otherwise the tauri.conf
    // default — which means "don't resize" since the window was just
    // mapped at that size anyway.
    let (target_w, target_h) = match saved {
        Some(s) if s.width > 0 && s.height > 0 => (s.width, s.height),
        _ => conf_default_physical(scale),
    };

    let _ = window.set_size(PhysicalSize {
        width: target_w,
        height: target_h,
    });

    if saved.map(|s| s.maximized).unwrap_or(false) {
        let _ = window.maximize();
    }
}

pub fn attach<R: Runtime>(window: &WebviewWindow<R>) -> Arc<AtomicBool> {
    let ready = Arc::new(AtomicBool::new(false));
    let ready_for_cb = ready.clone();
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.clone().on_window_event(move |event| {
        let Some(win) = app.get_webview_window(&label) else {
            return;
        };
        let ready_now = ready_for_cb.load(Ordering::Acquire);
        match event {
            WindowEvent::Resized(size) => {
                let store = app.state::<WindowStateStore>();
                let reported = (size.width, size.height);

                // Learn the CSD shadow delta from the *first*
                // configure-event, which always fires at the
                // tauri.conf default size + shadow. Must be locked
                // in before apply()'s set_inner_size can fire its
                // own resize event — otherwise a smaller-than-
                // default saved size would produce nonsense.
                {
                    let mut delta_guard = store.delta.lock().unwrap();
                    if delta_guard.is_none() {
                        let (ew, eh) = store.initial_expected;
                        if reported.0 >= ew && reported.1 >= eh {
                            let dw = reported.0 - ew;
                            let dh = reported.1 - eh;
                            // CSD shadow is tens of logical pixels,
                            // never hundreds.
                            if dw < 500 && dh < 500 {
                                *delta_guard = Some((dw, dh));
                            }
                        }
                    }
                }

                if !ready_now {
                    return;
                }
                if !is_effectively_maximized(&win) {
                    let delta = store.delta.lock().unwrap().unwrap_or((0, 0));
                    if let Ok(pos) = win.outer_position() {
                        let mut s = store.state.lock().unwrap();
                        s.width = reported.0.saturating_sub(delta.0);
                        s.height = reported.1.saturating_sub(delta.1);
                        s.x = pos.x;
                        s.y = pos.y;
                    }
                }
            }
            WindowEvent::Moved(_) => {
                if !ready_now {
                    return;
                }
                if !is_effectively_maximized(&win) {
                    if let Ok(pos) = win.outer_position() {
                        let store = app.state::<WindowStateStore>();
                        let mut s = store.state.lock().unwrap();
                        s.x = pos.x;
                        s.y = pos.y;
                    }
                }
            }
            WindowEvent::CloseRequested { .. } => {
                let store = app.state::<WindowStateStore>();
                let maximized = win.is_maximized().unwrap_or(false);
                let delta = store.delta.lock().unwrap().unwrap_or((0, 0));
                let mut s = store.state.lock().unwrap();
                if !maximized {
                    if let (Ok(inner), Ok(pos)) = (win.inner_size(), win.outer_position()) {
                        s.width = inner.width.saturating_sub(delta.0);
                        s.height = inner.height.saturating_sub(delta.1);
                        s.x = pos.x;
                        s.y = pos.y;
                    }
                }
                s.maximized = maximized;
                save(&app, &s);
            }
            _ => {}
        }
    });
    ready
}

fn is_effectively_maximized<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    if window.is_maximized().unwrap_or(false) {
        return true;
    }
    let Ok(size) = window.inner_size() else {
        return false;
    };
    let Ok(Some(monitor)) = window.current_monitor() else {
        return false;
    };
    let ms = monitor.size();
    if ms.width == 0 || ms.height == 0 {
        return false;
    }
    let w_ratio = size.width as f64 / ms.width as f64;
    let h_ratio = size.height as f64 / ms.height as f64;
    w_ratio >= 0.92 && h_ratio >= 0.92
}
