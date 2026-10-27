// Saves and restores window geometry, in place of tauri-plugin-window-state,
// which goes wrong on Linux/GTK:
//
// 1. It saves on every Resized event, gated by `is_maximized()`. Maximizing
//    fires Resized at monitor size before `is_maximized()` changes, so the
//    maximized size is saved as the normal size.
// 2. `inner_size()` is the GDK window size, which on GNOME includes the
//    client-side shadow margin (~52×99 logical px), but `set_inner_size()` sets
//    the content size. Saving one and restoring with the other grows the window
//    by the shadow each time, until GNOME maximizes it.
//
// So the shadow delta is measured once per session (the first reported size
// against the requested one), and `reported - delta` is saved and restored with
// `set_inner_size`.

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

/// The main window's default size in tauri.conf.json, in logical pixels, used
/// to learn the shadow delta from the first configure event. Keep in sync with
/// the config.
const TAURI_CONF_DEFAULT_LOGICAL: (f64, f64) = (1280.0, 800.0);

pub struct WindowStateStore {
    pub state: Mutex<WindowState>,
    /// Shadow delta in physical pixels (`reported -
    /// expected_initial_physical`), learned from the first Resized event after
    /// mapping. None until measured.
    pub delta: Mutex<Option<(u32, u32)>>,
    /// The tauri.conf.json default size × scale factor, in physical pixels. The
    /// first configure event comes at this size plus the shadow, which gives
    /// `delta`.
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

/// Apply saved geometry (or a default on a fresh install). Call after
/// `window.show()`; on GTK `set_inner_size` is only reliable on a mapped
/// window. Records the requested size in `WindowStateStore.awaiting_set` so the
/// event handler can measure the shadow delta.
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

    // The saved size if sensible, otherwise the default (no resize, since the
    // window was just mapped at that size).
    let (target_w, target_h) = match saved {
        Some(s) if s.width > 0 && s.height > 0 => (s.width, s.height),
        _ => conf_default_physical(scale),
    };

    let _ = window.set_size(PhysicalSize {
        width: target_w,
        height: target_h,
    });

    // Maximize if the window was maximized last time, and on a fresh install
    // (`unwrap_or(true)`) so the first launch fills the screen.
    if saved.map(|s| s.maximized).unwrap_or(true) {
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

                // Learn the shadow delta from the first configure event (at the
                // default size plus shadow), before apply()'s set_inner_size
                // fires its own resize; a smaller saved size would otherwise
                // give a wrong delta.
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
